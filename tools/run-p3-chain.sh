#!/bin/bash
# Chain: wait for P2-25 → Astra design round 4 (P3) → generate P3 task prompts → build P3.
# Astra only; both Codex profiles rotate; pauses on limits (owner rule).
cd "$HOME/work/interp-app" || exit 1
until [ -f docs/build/P2-25.done ]; do sleep 30; done
echo "P2-25 done · starting P3 design round"
run_round() {
  for home in "$HOME/.codex-astra2" "$HOME/.codex"; do
    CODEX_HOME="$home" env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT codex exec -m gpt-6-astra --skip-git-repo-check -C "$PWD" \
      --output-last-message docs/design-p3.md - < docs/build/tasks/ROUND4-P3-prompt.md > docs/build/round4-p3.log 2>&1
    if grep -qiE "^ERROR:.*(usage limit|rate limit|quota|429)" docs/build/round4-p3.log; then echo "round4 limited on $(basename $home)"; continue; fi
    return 0
  done
  return 3
}
until run_round; do
  at=$(grep -ih -o 'try again at [^.]*[AP]M' docs/build/round4-p3.log | sed 's/.*try again at //I' | tail -1)
  hm=$(echo "$at" | grep -oE '[0-9]{1,2}:[0-9]{2} [AP]M' | tail -1); wait=1800
  if [ -n "$hm" ]; then t=$(date -j -f "%I:%M %p" "$hm" +%s 2>/dev/null); n=$(date +%s); [ -n "$t" ] && { [ "$t" -le "$n" ] && t=$((t+86400)); wait=$((t-n+90)); }; fi
  echo "round4 PAUSED · resuming in $((wait/60)) min ($at)"; sleep "$wait"
done
n=$(grep -c '^## P3-' docs/design-p3.md); echo "ROUND4 done · $(wc -c < docs/design-p3.md) bytes · $n tasks"
[ "$n" -ge 3 ] || { echo "ROUND4 produced too few tasks · stopping for review"; exit 2; }
python3 - <<'PY'
import re
s=open('docs/design-p3.md',encoding='utf-8').read()
start=s.find('P3-01'); start=s.rfind('\n#', 0, start)
tasks=[b for b in re.split(r'\n(?=## P3-\d\d )', s[start:]) if b.startswith('## P3-')]
hdr=open('docs/build/tasks/P2-01.md',encoding='utf-8').read().split('# 과제')[0]
hdr=hdr.replace('`docs/design-p2.md`(P2 상세 설계·과제 목록, 우선)','`docs/design-p3.md`(P3 상세 설계·과제 목록, 우선)와 `docs/DESIGN.md`(디자인 스펙)와 `docs/design-p2.md`')
hdr=hdr.replace("design-p2.md의 해당 절(§7.3 화면, §8.4 상태 기계, §8.5 오디오 큐, §8.6 자막 조립, §9 세션 전환, §10 허브 수신, §17 측정)","design-p3.md의 해당 절과 DESIGN.md")
for t in tasks:
    tid=re.match(r'## (P3-\d\d)',t).group(1)
    i=t.find('\n# '); body=t if i<0 else t[:i]
    open(f'docs/build/tasks/{tid}.md','w',encoding='utf-8').write(hdr+"# 과제\n\n"+body.strip()+"\n")
print('P3 prompts:',len(tasks))
PY
git add -A && git -c user.name=gai -c user.email=gai@kaflixcloud.co.jp commit -qm "docs: P3 design by Astra + task prompts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuvfLUrfz3d8VPU49Ce22F" >/dev/null 2>&1
bash tools/run-until-done.sh P3; echo "P3-WRAPPER-EXIT $?"
