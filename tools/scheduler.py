#!/usr/bin/env python3
"""Parallel task scheduler for Fable lanes (owner: "병목이 있으면 병행작업").

Tasks come from docs/build/tasks/<PREFIX>-*.md (deps from '의존 과제', files from
'만들·고칠 파일'). A task is eligible when its deps are done; up to LANES tasks run
at once in separate git worktrees when their file sets do not overlap (i18n JSON and
tests are allowed to overlap: JSON is union-merged, tests rarely collide). Each lane
commits on its branch; the scheduler merges into main one at a time, runs the full
test suite, and on conflict/failure asks Fable to fix on main before continuing.
"""
import json, os, re, subprocess, sys, time, glob, shutil
APP = os.path.expanduser('~/work/interp-app'); os.chdir(APP)
PREFIX = sys.argv[1] if len(sys.argv) > 1 else 'P3'
LANES = int(sys.argv[2]) if len(sys.argv) > 2 else 2
LANE_ROOT = '/tmp/interp-lanes'; os.makedirs(LANE_ROOT, exist_ok=True)
GIT = ['git', '-c', 'user.name=gai', '-c', 'user.email=gai@kaflixcloud.co.jp']
TRAILER = "\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Ppr3e7daf3KvAXywVopd5b"
def sh(cmd, cwd=APP, check=False):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode: raise RuntimeError(f"{cmd}: {r.stderr[-400:]}")
    return r
def log(msg): print(msg, flush=True)
def norm(f): return f.strip().strip('`').strip('.').strip()
def parse_task(path):
    s = open(path, encoding='utf-8').read(); tid = os.path.basename(path)[:-3]
    m = re.search(r'\*\*의존 과제:\*\*\s*(.+)', s); deps = set(re.findall(r'P\d-\d\d[a-z]?', m.group(1))) if m else set()
    if '(오너' in s and not deps: deps = set()  # inserted tasks: only implicit ordering below
    m = re.search(r'\*\*만들·고칠 파일[^*]*\*\*\s*(.+)', s) or re.search(r'\*\*만들 파일[^*]*\*\*\s*(.+)', s)
    files = set()
    if m:
        for tok in re.findall(r'`([^`]+)`', m.group(1)):
            tok = tok.replace('{ko,en,ja}', 'ko')  # i18n handled specially anyway
            for part in tok.split(','):
                part = norm(part)
                if '/' in part or part.endswith(('.js', '.mjs', '.json', '.css', '.html', '.md')): files.add(part)
    return {'id': tid, 'deps': deps, 'files': files, 'path': path}
def is_shared_ok(f): return f.startswith('app/i18n/') or f.startswith('tests/') or f.startswith('docs/')
def overlap(a, b): return any(f for f in a['files'] & b['files'] if not is_shared_ok(f))
def done(tid): return os.path.exists(f'docs/build/{tid}.done')
def tests_pass(cwd):
    r = subprocess.run('node --test tests/*.test.mjs > docs/build/last-test.log 2>&1', shell=True, cwd=cwd)
    return r.returncode == 0
def union_merge_json(path):
    """Resolve a conflicted i18n JSON by taking the union of both sides (ours wins on same key)."""
    ours = json.loads(sh(['git', 'show', f':2:{path}']).stdout); theirs = json.loads(sh(['git', 'show', f':3:{path}']).stdout)
    merged = dict(theirs); merged.update(ours)
    with open(path, 'w', encoding='utf-8') as fh: json.dump(merged, fh, ensure_ascii=False, indent=2); fh.write('\n')
    sh(['git', 'add', path])
def fable_fix(reason, files):
    prompt = f"""당신은 Claude Fable 5.1이고 `~/work/interp-app/`의 구현자다. 병행 작업 브랜치를 main에 합치는 중 문제가 생겼다: {reason}
대상 파일: {', '.join(files) or '(전체)'}
할 일: 충돌 마커(<<<<<<< ======= >>>>>>>)가 있으면 양쪽 의도를 모두 살려 해소하고, `node --test tests/*.test.mjs`와 `node scripts/check-i18n.mjs`가 통과할 때까지 고쳐라. 설계 문서(docs/design-p3.md·docs/DESIGN.md)와 어긋나지 않게. git 커밋은 하지 마라. 마지막에 무엇을 어떻게 해소했는지 한국어로 3줄 요약."""
    open('docs/build/tasks/_merge-fix.md', 'w', encoding='utf-8').write(prompt)
    subprocess.run(['bash', 'tools/fable-task.sh', f'merge-fix-{int(time.time())}', 'docs/build/tasks/_merge-fix.md'], cwd=APP, capture_output=True)
    return tests_pass(APP)
def start_lane(t):
    wt = f"{LANE_ROOT}/{t['id']}"; br = f"task/{t['id']}"
    if os.path.exists(wt): sh(['git', 'worktree', 'remove', '--force', wt])
    sh(['git', 'branch', '-D', br]); sh(['git', 'worktree', 'add', '-q', '-b', br, wt, 'main'], check=True)
    env = dict(os.environ, APP_DIR=wt, LOG_DIR=f'{APP}/docs/build')
    p = subprocess.Popen(['bash', f'{APP}/tools/fable-task.sh', t['id'], t['path']], cwd=APP, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {'task': t, 'proc': p, 'wt': wt, 'branch': br, 't0': time.time()}
def finish_lane(l):
    t = l['task']; wt = l['wt']; br = l['branch']; tid = t['id']
    logf = f'docs/build/{tid}.log'; txt = open(logf, errors='ignore').read() if os.path.exists(logf) else ''
    if re.search(r'usage limit|rate limit|429|too many requests|overloaded|not logged in|reached your .* limit|hit your session limit|Invalid API key', txt, re.I):
        log(f"{tid} FABLE-LIMITED"); sh(['git', 'worktree', 'remove', '--force', wt]); return 'limited'
    if not tests_pass(wt):
        log(f"{tid} tests failed in lane · retry once with output"); 
        retry = open(t['path'], encoding='utf-8').read() + "\n\n# 이전 시도 실패 · 아래 테스트 출력을 보고 고쳐라\n```\n" + open(f'{wt}/docs/build/last-test.log', errors='ignore').read()[-6000:] + "\n```\n"
        rp = f'docs/build/tasks/{tid}.retry.md'; open(rp, 'w', encoding='utf-8').write(retry)
        env = dict(os.environ, APP_DIR=wt, LOG_DIR=f'{APP}/docs/build')
        subprocess.run(['bash', f'{APP}/tools/fable-task.sh', f'{tid}-retry', rp], cwd=APP, env=env, capture_output=True)
        if not tests_pass(wt): log(f"{tid} FAILED-twice → stopping for review"); return 'failed'
    sh(['git', 'add', '-A'], cwd=wt)
    if not sh(['git', 'diff', '--cached', '--name-only'], cwd=wt).stdout.strip():
        log(f"{tid} NO-CHANGES (agent produced nothing) → not done"); sh(['git', 'worktree', 'remove', '--force', wt]); return 'failed'
    sh(GIT + ['commit', '-qm', f"{tid}: {title(t)}\n\nBuilt by Claude Fable 5.1 (parallel lane); verified with node --test.{TRAILER}"], cwd=wt)
    # merge into main
    r = sh(GIT + ['merge', '--no-ff', '-m', f"merge {br}{TRAILER}", br])
    if r.returncode:
        conflicted = [f for f in sh(['git', 'diff', '--name-only', '--diff-filter=U']).stdout.split() if f]
        for f in conflicted:
            if f.startswith('app/i18n/') and f.endswith('.json'):
                try: union_merge_json(f)
                except Exception as e: log(f"{tid} json union failed {f}: {e}")
        remaining = [f for f in sh(['git', 'diff', '--name-only', '--diff-filter=U']).stdout.split() if f]
        if remaining:
            log(f"{tid} merge conflict in {remaining} → Fable resolve")
            if not fable_fix(f"'{br}' 병합 충돌", remaining): log(f"{tid} MERGE-FIX-FAILED → stopping"); return 'failed'
        sh(['git', 'add', '-A']); sh(GIT + ['commit', '-qm', f"merge {br} (resolved){TRAILER}"])
    if not tests_pass(APP):
        log(f"{tid} tests fail after merge → Fable fix on main")
        if not fable_fix(f"'{br}' 병합 후 테스트 실패", []): log(f"{tid} POST-MERGE-FIX-FAILED → stopping"); return 'failed'
        sh(['git', 'add', '-A']); sh(GIT + ['commit', '-qm', f"fix after merging {br}{TRAILER}"])
    open(f'docs/build/{tid}.done', 'w').close()
    sh(['git', 'worktree', 'remove', '--force', wt]); sh(['git', 'branch', '-D', br])
    log(f"{tid} OK {int(time.time()-l['t0'])}s (merged)"); return 'ok'
def title(t):
    m = re.search(r'## \S+ — (.+)', open(t['path'], encoding='utf-8').read()); return (m.group(1).strip() if m else t['id'])[:60]
def main():
    tasks = {}
    for f in sorted(glob.glob(f'docs/build/tasks/{PREFIX}-*.md')):
        if '.retry' in f or '.fable' in f: continue
        t = parse_task(f); tasks[t['id']] = t
    # inserted owner tasks (P3-02b/c/d) run after P3-02 and before P3-03 in dependency terms
    order = sorted(tasks)
    for i, tid in enumerate(order):
        if re.search(r'[a-z]$', tid):  # e.g. P3-02b
            base = tid[:-1]
            if base in tasks: tasks[tid]['deps'].add(base)
            nxt = [x for x in order[i+1:] if not re.search(r'[a-z]$', x)]
            if nxt: tasks[nxt[0]]['deps'].add(tid)
    lanes = []; stopped = False
    while True:
        for l in list(lanes):
            if l['proc'].poll() is not None:
                lanes.remove(l); res = finish_lane(l)
                if res in ('failed', 'limited'): stopped = True
        if stopped and not lanes: log('SCHEDULER STOPPED'); return 2
        pending = [t for t in tasks.values() if not done(t['id']) and t['id'] not in [l['task']['id'] for l in lanes]]
        if not pending and not lanes: log(f'{PREFIX} ALL DONE'); return 0
        if not stopped:
            for t in sorted(pending, key=lambda x: x['id']):
                if len(lanes) >= LANES: break
                if any(not done(d) for d in t['deps'] if d in tasks): continue
                if any(overlap(t, l['task']) for l in lanes): continue
                lanes.append(start_lane(t)); log(f"{t['id']} START (lanes={len(lanes)})")
        time.sleep(10)
if __name__ == '__main__': sys.exit(main())
