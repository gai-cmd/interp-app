#!/usr/bin/env node
// Owner's key console (2026-09-07): a local page with five slots for the
// site's free-tier Gemini keys. It checks each key against Google, keeps the
// working ones in order in ~/.config/interp-app/builtin-key (the file
// scripts/stage-release.mjs --builtin-key-file reads), and can run the
// documented Vercel deployment. Loopback only, no dependencies, nothing here
// is part of the app or of any release. Keys are never printed to the
// terminal; the page shows them masked once saved.
//   node tools/keys-console.mjs            (opens http://127.0.0.1:8799/)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8799;
const KEY_FILE = join(homedir(), '.config', 'interp-app', 'builtin-key');
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_ROOT = join(homedir(), 'deploy', 'interp-app');
const UPLOAD_DIR = join(homedir(), 'deploy', 'vercel', 'interp-app');
const SLOTS = 5;
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;
const mask = (key) => (key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`);

async function readKeys() {
  try {
    const text = await readFile(KEY_FILE, 'utf8');
    return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))];
  } catch { return []; }
}
async function writeKeys(keys) {
  await mkdir(dirname(KEY_FILE), { recursive: true });
  const body = ['# interp-app site keys — one per line, used in this order; a key that hits its free',
    '# quota (429) hands over to the next. Written by tools/keys-console.mjs.', ...keys, ''].join('\n');
  await writeFile(KEY_FILE, body, 'utf8');
  await chmod(KEY_FILE, 0o600);
}
/** Asks Google whether the key is accepted: { ok, status, reason }. Never throws. */
async function checkKey(key) {
  if (!KEY_SHAPE.test(key) || key.includes("'") || key.includes('\\')) return { ok: false, status: 0, reason: 'shape' };
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    if (response.ok) return { ok: true, status: response.status, reason: 'active' };
    let reason = `http ${response.status}`;
    try { const body = await response.json(); reason = body?.error?.message?.replaceAll(key, '<key>').slice(0, 140) ?? reason; } catch {}
    return { ok: false, status: response.status, reason };
  } catch (error) { return { ok: false, status: 0, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network' }; }
}
function run(command, args, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CLAUDECODE: undefined } });
    let out = '';
    const collect = (chunk) => { out += chunk.toString(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('close', (code) => done({ code, out }));
    child.on('error', (error) => done({ code: -1, out: `${out}\n${error.message}` }));
  });
}
async function deploy() {
  const keys = await readKeys();
  const log = [];
  const step = async (label, command, args, cwd = APP) => {
    const { code, out } = await run(command, args, cwd);
    const clean = keys.reduce((text, key) => text.replaceAll(key, '<key>'), out);
    log.push(`$ ${label}\n${clean.trim()}`);
    if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
    return clean;
  };
  const stamp = new Date();
  const id = `keys-${stamp.toISOString().slice(0, 10).replaceAll('-', '')}-${stamp.toISOString().slice(11, 16).replace(':', '')}`;
  try {
    if (!keys.length) throw new Error('no keys saved');
    await mkdir(DEPLOY_ROOT, { recursive: true });
    await step('stage-release', process.execPath, ['scripts/stage-release.mjs', '--id', id, '--out', DEPLOY_ROOT, '--builtin-key-file', KEY_FILE]);
    const checked = await step('check-release', process.execPath, ['scripts/check-release.mjs', DEPLOY_ROOT]);
    if (!/RELEASE_BUILTIN_KEY/.test(checked)) throw new Error('check-release did not announce the built-in key');
    await mkdir(dirname(UPLOAD_DIR), { recursive: true });
    await step('rsync', 'rsync', ['-a', '--delete', '--exclude', '.vercel', `${DEPLOY_ROOT}/`, `${UPLOAD_DIR}/`]);
    await step('vercel-json', process.execPath, ['scripts/vercel-json.mjs', UPLOAD_DIR]);
    await step('vercel deploy', 'vercel', ['deploy', '--prod', '--yes'], UPLOAD_DIR);
    const live = await run('curl', ['-s', `https://interp-app.vercel.app/?t=${Date.now()}`]);
    const served = live.out.match(/releases\/([^/"]+)\//)?.[1] ?? '?';
    log.push(`live entry release: ${served}${served === id ? ' ✓' : ' (propagating)'}`);
    return { ok: true, id, log: log.join('\n\n') };
  } catch (error) {
    return { ok: false, id, log: `${log.join('\n\n')}\n\n${error.message}` };
  }
}

const PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>사이트 키 콘솔</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1a1d21}
h1{font-size:1.25rem}label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input{width:100%;box-sizing:border-box;font:inherit;padding:.5rem .6rem;border:1px solid #c8ccd2;border-radius:.4rem;font-family:ui-monospace,monospace}
.row{display:flex;gap:.5rem;align-items:center}.row input{flex:1}.st{min-width:9rem;font-size:.9rem}
.ok{color:#137333}.bad{color:#b3261e}.muted{color:#5f6368}
button{font:inherit;padding:.55rem 1rem;border-radius:.4rem;border:1px solid #1f5f8b;background:#1f5f8b;color:#fff;cursor:pointer;margin-right:.5rem;margin-top:1rem}
button.sec{background:#fff;color:#1f5f8b}button[disabled]{opacity:.5;cursor:default}
pre{background:#f3f4f6;padding:.75rem;border-radius:.4rem;white-space:pre-wrap;font-size:.8rem;max-height:22rem;overflow:auto}
p.note{font-size:.9rem;color:#5f6368}
</style>
<h1>사이트 기본 키 (무료, 교대 사용)</h1>
<p class="note">위에서부터 순서대로 씁니다. 한 키가 무료 한도(429)에 걸리면 앱이 다음 키로 넘어갑니다. <b>검사</b>는 구글에 물어봐서 살아 있는 키만 남기고, <b>저장</b>은 <code>~/.config/interp-app/builtin-key</code>에만 씁니다(레포·GitHub에는 절대 안 올라감). <b>저장 후 배포</b>는 릴리스를 만들어 check-release를 통과시킨 뒤 Vercel(interp-app.vercel.app)에 올립니다.</p>
<form id="f" onsubmit="return false">
${Array.from({ length: SLOTS }, (_, i) => `<label for="k${i}">키 ${i + 1}</label><div class="row"><input id="k${i}" autocomplete="off" spellcheck="false" placeholder="비워두면 건너뜀"><span class="st muted" id="s${i}"></span></div>`).join('')}
<button id="check" class="sec" type="button">검사</button><button id="save" type="button">저장</button><button id="deploy" type="button">저장 후 배포</button>
</form>
<p id="msg" class="note"></p><pre id="log" hidden></pre>
<script>
const $=id=>document.getElementById(id);const N=${SLOTS};
const inputs=[...Array(N)].map((_,i)=>$('k'+i)),stats=[...Array(N)].map((_,i)=>$('s'+i));
let saved=[];
function show(list){saved=list;list.forEach((k,i)=>{if(i<N){inputs[i].value='';inputs[i].placeholder=k.masked+' (저장됨)';stats[i].textContent='저장됨';stats[i].className='st muted';}});}
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
function collect(){return inputs.map((el,i)=>({slot:i,key:el.value.trim()}));}
function setBusy(b){for(const id of['check','save','deploy'])$(id).disabled=b;}
async function check(){setBusy(true);$('msg').textContent='구글에 확인 중…';const res=await api('/check',{entries:collect()});
 res.results.forEach(r=>{const s=stats[r.slot];if(r.state==='empty'){s.textContent='';return;}s.textContent=r.ok?'활성':'무효 · '+r.reason;s.className='st '+(r.ok?'ok':'bad');});
 $('msg').textContent='활성 '+res.results.filter(r=>r.ok).length+'개';setBusy(false);return res;}
async function save(){const res=await api('/save',{entries:collect()});if(!res.ok){$('msg').textContent='저장 실패: '+res.error;return false;}
 show(res.keys);$('msg').textContent='저장됨: 활성 키 '+res.keys.length+'개 (무효 키는 제외). 배포해야 사이트에 반영됩니다.';return true;}
$('check').onclick=check;$('save').onclick=async()=>{setBusy(true);await save();setBusy(false);};
$('deploy').onclick=async()=>{setBusy(true);if(await save()){$('msg').textContent='배포 중… (1분 안팎)';$('log').hidden=false;$('log').textContent='';const res=await api('/deploy');$('log').textContent=res.log;$('msg').textContent=res.ok?'배포 완료: '+res.id+' → https://interp-app.vercel.app':'배포 실패 — 아래 로그 확인';}setBusy(false);};
fetch('/keys').then(r=>r.json()).then(show);
</script></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  const body = async () => { let text = ''; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : {}; };
  try {
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(PAGE); return; }
    if (request.method === 'GET' && url.pathname === '/keys') { json(200, (await readKeys()).map((key) => ({ masked: mask(key) }))); return; }
    if (request.method === 'POST' && url.pathname === '/check') {
      const { entries = [] } = await body();
      const results = await Promise.all(entries.map(async ({ slot, key }) => key ? { slot, state: 'typed', ...(await checkKey(key)) } : { slot, state: 'empty', ok: false }));
      json(200, { results }); return;
    }
    if (request.method === 'POST' && url.pathname === '/save') {
      // Typed keys replace the saved list slot by slot; an untouched slot keeps
      // its saved key. Only keys Google accepts right now are written.
      const { entries = [] } = await body();
      const current = await readKeys();
      const merged = entries.map(({ slot, key }) => key || current[slot] || '').filter(Boolean);
      const checks = await Promise.all(merged.map(checkKey));
      const keys = [...new Set(merged.filter((_, index) => checks[index].ok))];
      await writeKeys(keys);
      json(200, { ok: true, keys: keys.map((key) => ({ masked: mask(key) })), dropped: merged.length - keys.length }); return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy') { json(200, await deploy()); return; }
    json(404, { error: 'not found' });
  } catch (error) { json(500, { ok: false, error: String(error?.message ?? error).slice(0, 200) }); }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`keys console: http://127.0.0.1:${PORT}/`);
  spawn('open', [`http://127.0.0.1:${PORT}/`], { stdio: 'ignore', detached: true }).unref();
});
