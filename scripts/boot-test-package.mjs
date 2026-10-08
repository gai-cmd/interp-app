// Real-Chrome BOOT TEST of a packaged extension folder: the release step that no Node fake can replace (docs/extension.md §23;
// the 0.3.0 timer bug and the 0.5.0 relay `ended` bug were visible only in a real Chrome). Headless, muted, own profile, mock
// keychain. Nothing is started: no API call, no capture, no audio, no key read or printed.
//
//   node scripts/boot-test-package.mjs <packaged folder> <NEW empty work dir> [--old <previous release folder>]
//                                      [--expect-tab-model <id>] [--chrome <Chrome for Testing binary>]
//
//   e.g. node scripts/boot-test-package.mjs dist/extension-package/LiveInterpreter /tmp/boot-0.5.1 \
//          --old /path/to/the/extracted/previous/LiveInterpreter --expect-tab-model gemini-3.8-live
//
// A) FRESH INSTALL of the folder: its service worker comes up, the panel, options page, permission page and offscreen host page
//    load with ZERO console errors / exceptions / failed requests, the manifest version is the folder's, and the first-run
//    defaults are stored.
// B) UPGRADE (with --old): the old folder is installed and run once, the new files are copied over the SAME path while Chrome
//    runs, and chrome.runtime.reload() is called from an extension page (what the Reload button and the self-updater do):
//    the extension must come back, load error-free, report the new version, and run the one-time onInstalled(update)
//    migration. A second variant (restart without Reload) is only REPORTED: Chrome does not deliver onInstalled(update) there.
// Exit code 0 = every check passed, 1 = a check failed, 2 = the harness itself failed. Needs Chrome for Testing (the branded
// Chrome refuses --load-extension): by default the newest cached in ~/Library/Caches/ms-playwright (macOS).
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const NEW = positional[0];
const WORK = positional[1];
const OLD = flag('--old');
const EXPECT_TAB_MODEL = flag('--expect-tab-model');
const CHROME = flag('--chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
if (!NEW || !WORK) { console.error('usage: node scripts/boot-test-package.mjs <packaged folder> <NEW empty work dir> [--old <old folder>] [--expect-tab-model <id>]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

let portCounter = 9500 + Math.floor((process.pid % 400));
async function launch(label, extDir, profile) {
  await mkdir(join(profile, 'Default'), { recursive: true });
  // Developer mode ON, like the profile of anyone who uses "Load unpacked": without it Chrome leaves a command-line
  // extension disabled after chrome.runtime.reload(). Written only for a brand-new profile (a relaunch keeps its own).
  try { await readFile(join(profile, 'Default', 'Preferences')); } catch { await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } })); }
  const port = portCounter++;
  const argv = ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`, 'about:blank'];
  const child = spawn(CHROME, argv, { stdio: 'ignore' });
  await writeFile(join(WORK, `pid-${label}.txt`), String(child.pid));
  let version = null;
  for (let i = 0; i < 80 && version === null; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
  if (version === null) { try { process.kill(child.pid); } catch {} throw new Error('chrome did not start'); }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); };
  const send = (method, params = {}, sessionId) => new Promise((res) => { id += 1; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const close = async () => { try { ws.close(); } catch {} try { process.kill(child.pid); } catch {} await sleep(1200); };
  return { send, targets, close, events, browser: version.Browser, port };
}

const SW_PATH = /^chrome-extension:\/\/([a-p]{32})\/extension\/background\/service-worker\.js/;
async function extensionId(h) {
  for (let i = 0; i < 80; i += 1) {
    const t = (await h.targets()).find((x) => x.type === 'service_worker' && SW_PATH.test(x.url));
    if (t) return SW_PATH.exec(t.url)[1];
    await sleep(250);
  }
  return null;
}

// Opens an extension page as a tab, watches it for errors for `settleMs`, returns { errors, evalIn, closePage }.
async function openPage(h, extId, path, settleMs = 1500) {
  const errors = [];
  const { result } = await h.send('Target.createTarget', { url: 'about:blank' });
  const att = await h.send('Target.attachToTarget', { targetId: result.targetId, flatten: true });
  const sessionId = att.result.sessionId;
  await h.send('Runtime.enable', {}, sessionId); await h.send('Log.enable', {}, sessionId); await h.send('Network.enable', {}, sessionId);
  const mark = h.events.length;
  await h.send('Page.enable', {}, sessionId);
  await h.send('Page.navigate', { url: `chrome-extension://${extId}/${path}` }, sessionId);
  await sleep(settleMs);
  for (const e of h.events.slice(mark)) {
    if (e.sessionId !== sessionId) continue;
    if (e.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text).split('\n')[0].slice(0, 200));
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push('console.error: ' + e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errors.push('log: ' + e.params.entry.text.slice(0, 200) + ' ' + (e.params.entry.url ?? '').slice(0, 120));
    if (e.method === 'Network.loadingFailed' && !e.params.canceled) errors.push('request failed: ' + e.params.errorText);
  }
  const evalIn = async (expression) => {
    const r = await h.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) return { error: (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).split('\n')[0] };
    return { value: r.result?.result?.value };
  };
  const closePage = () => h.send('Target.closeTarget', { targetId: result.targetId });
  return { errors, evalIn, closePage };
}

// Developer mode on, the way a person has it with "Load unpacked": through chrome://extensions, as the profile setting that
// keeps a command-line extension enabled across chrome.runtime.reload() (a Preferences file written beforehand is not honoured).
async function enableDevMode(h) {
  const { result } = await h.send('Target.createTarget', { url: 'chrome://extensions' });
  const att = await h.send('Target.attachToTarget', { targetId: result.targetId, flatten: true });
  await sleep(1500);
  await h.send('Runtime.evaluate', { expression: "new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => res('ok')))", awaitPromise: true }, att.result.sessionId);
  await h.send('Target.closeTarget', { targetId: result.targetId });
}
const PAGES = ['extension/panel/panel.html', 'extension/options/options.html', 'extension/permission/mic-permission.html', 'extension/engine/host.html'];
const STORED = `(async () => { const all = await chrome.storage.local.get(null); const key = Object.keys(all).find((k) => /settings/i.test(k)); const s = key ? all[key] : null;
  return JSON.stringify({ key: key ?? null, tab: s?.lanes?.tab?.model ?? null, mic: s?.lanes?.mic?.model ?? null, speechMuted: s?.speechMuted ?? null, version: chrome.runtime.getManifest().version }); })()`;

async function bootAndRead(label, extDir, profile) {
  const h = await launch(label, extDir, profile);
  try {
    const extId = await extensionId(h);
    check(`${label}: the extension loaded (its service worker target exists)`, extId !== null, extId ? '' : 'no service worker of this extension within 20 s');
    if (!extId) return { h: null };
    await enableDevMode(h);
    let sw = null;
    for (let i = 0; i < 40 && !sw; i += 1) { sw = (await h.targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId)); if (!sw) await sleep(250); }
    check(`${label}: the service worker is running`, !!sw, sw ? '' : 'no service_worker target');
    let read = null;
    for (const path of PAGES) {
      const page = await openPage(h, extId, path);
      check(`${label}: ${path} loads with no console error, exception or failed request`, page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
      if (path.includes('options')) { await sleep(500); read = await page.evalIn(STORED); }
      await page.closePage();
    }
    return { h, extId, read: read?.value ? JSON.parse(read.value) : { error: read?.error } };
  } catch (error) {
    check(`${label}: harness`, false, String(error.message ?? error));
    return { h: null };
  }
}

try {
  await mkdir(WORK, { recursive: true });
  // A) fresh install of the NEW folder
  const freshDir = join(WORK, 'ext-fresh');
  await cp(NEW, freshDir, { recursive: true });
  const fresh = await bootAndRead('fresh', freshDir, join(WORK, 'profile-fresh'));
  if (fresh.h) {
    console.log('INFO  Chrome:', fresh.h.browser, '| fresh read:', JSON.stringify(fresh.read));
    check('fresh: the manifest version is the folder\'s', fresh.read?.version === JSON.parse(await readFile(join(NEW, 'manifest.json'), 'utf8')).version, String(fresh.read?.version));
    if (EXPECT_TAB_MODEL) check(`fresh: first-run defaults store tab=${EXPECT_TAB_MODEL} and mic=${EXPECT_TAB_MODEL}`, fresh.read?.tab === EXPECT_TAB_MODEL && fresh.read?.mic === EXPECT_TAB_MODEL, JSON.stringify(fresh.read));
    await fresh.h.close();
  }
  // B1) in-place reload (what the self-updater and the Reload button do): OLD runs, NEW's files are copied over the same path
  // while Chrome runs, then chrome.runtime.reload() from an extension page.
  if (OLD) {
    const rDir = join(WORK, 'ext-reload');
    await cp(OLD, rDir, { recursive: true });
    const before = await bootAndRead('reload-old', rDir, join(WORK, 'profile-reload'));
    if (before.h) {
      console.log('INFO  reload: the old install stored:', JSON.stringify(before.read));
      await cp(NEW, rDir, { recursive: true, force: true });
      const trigger = await openPage(before.h, before.extId, 'extension/options/options.html', 800);
      await trigger.evalIn('setTimeout(() => chrome.runtime.reload(), 50); 1');
      await sleep(5000);
      let swUp = false;
      for (let i = 0; i < 40 && !swUp; i += 1) { swUp = (await before.h.targets()).some((t) => t.type === 'service_worker' && SW_PATH.test(t.url)); if (!swUp) await sleep(250); }
      check('reload: the service worker is back after chrome.runtime.reload()', swUp, '');
      const page = await openPage(before.h, before.extId, 'extension/options/options.html', 1500);
      check('reload: the options page loads with no error after the reload', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
      await sleep(500);
      const read = await page.evalIn(STORED); const after = read.value ? JSON.parse(read.value) : { error: read.error };
      console.log('INFO  reload: after chrome.runtime.reload():', JSON.stringify(after));
      check('reload: the manifest version is now the new one', after.version === JSON.parse(await readFile(join(NEW, 'manifest.json'), 'utf8')).version, String(after.version));
      if (EXPECT_TAB_MODEL) check(`reload: the old tab default moved to ${EXPECT_TAB_MODEL} (once); the mic lane is unchanged`, after.tab === EXPECT_TAB_MODEL && after.mic === before.read?.mic, `before ${JSON.stringify([before.read?.tab, before.read?.mic])} after ${JSON.stringify([after.tab, after.mic])}`);
      check('reload: speechMuted is untouched', after.speechMuted === before.read?.speechMuted, `${before.read?.speechMuted} -> ${after.speechMuted}`);
      await before.h.close();
    }
  }
  // B2) upgrade across a browser restart: OLD installed and run, then NEW's files copied over the same path, then run again on the same profile
  if (OLD) {
    const upDir = join(WORK, 'ext-upgrade');
    const upProfile = join(WORK, 'profile-upgrade');
    await cp(OLD, upDir, { recursive: true });
    const first = await bootAndRead('old', upDir, upProfile);
    if (first.h) {
      console.log('INFO  old install stored:', JSON.stringify(first.read));
      await first.h.close();
      await cp(NEW, upDir, { recursive: true, force: true });   // the new files over the old ones, same path, same profile
      const second = await bootAndRead('upgraded', upDir, upProfile);
      if (second.h) {
        console.log('INFO  after the upgrade:', JSON.stringify(second.read));
        check('upgraded: the manifest version is now the new one', second.read?.version === JSON.parse(await readFile(join(NEW, 'manifest.json'), 'utf8')).version, String(second.read?.version));
        // An OBSERVATION, not a check: Chrome delivers onInstalled(update) when an extension is RELOADED (the Reload button, the
        // self-updater's chrome.runtime.reload(), B1 above), not when a browser restart merely finds new files on disk. Whether
        // a restart-only upgrade migrates therefore depends on Chrome, and the guide's steps always say Reload.
        console.log(`INFO  restart-only upgrade (no Reload): tab ${first.read?.tab} -> ${second.read?.tab}, mic ${first.read?.mic} -> ${second.read?.mic}, speechMuted ${first.read?.speechMuted} -> ${second.read?.speechMuted}${EXPECT_TAB_MODEL && second.read?.tab !== EXPECT_TAB_MODEL ? '  (no migration: onInstalled(update) was not delivered by the restart)' : ''}`);
        await second.h.close();
      }
    }
  }
} catch (error) {
  console.log('HARNESS ERROR', String(error.stack ?? error).split('\n').slice(0, 4).join(' | '));
  process.exit(2);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
