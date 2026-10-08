// New implementation of docs/extension.md §21 (owner, 2026-10-08); no legacy code is ported.
// The orchestration of the extension's self-update, the one object the panel and the options page talk to. Everything it
// touches is INJECTED (fetch, SubtleCrypto, the handle store, the state record, the folder picker, the reload), so the whole
// flow runs in a unit test with fakes and this module names no platform API and touches nothing at import time.
//
// What run() does, in order: [folder] the stored handle and its readwrite permission (asked FIRST, before any network, because
// a permission request needs the user's click and a click only counts for a few seconds), [check] latest.json says which
// version is out, [fetch] that version's signed manifest and signature, [verify] the signature, the version rule (strictly
// newer than the running version), then every file in memory with its signed size and sha256, [write] the folder is
// confirmed to be THE loaded folder, the pending marker is stored, the files are written (manifest.json last), the state says
// what was applied, and the extension reloads itself. Anything that fails stops the flow with one UPDATE_* code; nothing is
// written unless every check above held.
import { SELF_UPDATE_LIMITS, UPDATE_ERROR_CODES, applyUpdate, downloadUpdate, folderRelation, planUpdate, verifyUpdateManifest } from './self-update.js';
import { checkForUpdate, compareVersions, updateTreeUrls } from './update-check.js';
import { UPDATE_PUBLIC_KEYS } from './update-keys.js';

const MANIFEST_FILE = 'manifest.json';
const SIGNATURE_MAX_BYTES = 1024;               // base64 of 64 bytes is 88 characters; anything near this is wrong
// Codes that say "nothing was tried" or "not this time", not "an update attempt failed": lastError stays as it was.
const NOT_RECORDED = Object.freeze(['UPDATE_BUSY', 'UPDATE_DISABLED', 'UPDATE_NOT_NEWER', 'UPDATE_NO_FOLDER', 'UPDATE_NEEDS_PERMISSION']);

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}
const refusal = (code) => Object.freeze({ ok: false, code });
const isDirectory = (handle) => handle !== null && typeof handle === 'object' && handle.kind === 'directory'
  && typeof handle.getFileHandle === 'function' && typeof handle.getDirectoryHandle === 'function';
const latin1 = (bytes) => { let out = ''; for (const byte of bytes) out += String.fromCharCode(byte); return out; };

/**
 * The downloader the updater builds from the page's `fetch`: a GET that sends nothing about the person (no credentials, no
 * cache, no redirect), needs an OK answer, and refuses a body larger than `maxBytes` twice over: by Content-Length (when the
 * answer is not compressed, because then that number is not the number of bytes we get) and by the bytes actually read, which
 * stops reading at the limit. Resolves a Uint8Array; throws Error{code:'UPDATE_FETCH_FAILED' | 'UPDATE_TOO_LARGE'}.
 */
export function createFetchBytes(fetcher) {
  return async function fetchBytes(url, { maxBytes = SELF_UPDATE_LIMITS.maxFileBytes } = {}) {
    if (typeof fetcher !== 'function') throw fail('UPDATE_FETCH_FAILED');
    let response;
    try { response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' }); } catch (error) { throw fail('UPDATE_FETCH_FAILED', error); }
    if (!response?.ok) throw fail('UPDATE_FETCH_FAILED');
    try {
      const encoding = response.headers?.get?.('content-encoding');
      const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
      if ((encoding === null || encoding === undefined || encoding === '' || encoding === 'identity') && Number.isFinite(declared) && declared > maxBytes) {
        try { await response.body?.cancel?.(); } catch { /* the answer is being dropped anyway */ }
        throw fail('UPDATE_TOO_LARGE');
      }
      const reader = response.body?.getReader?.();
      if (reader === undefined) {
        const whole = new Uint8Array(await response.arrayBuffer());
        if (whole.length > maxBytes) throw fail('UPDATE_TOO_LARGE');
        return whole;
      }
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw fail('UPDATE_TOO_LARGE');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
      return out;
    } catch (error) {
      throw error?.code === 'UPDATE_TOO_LARGE' ? error : fail('UPDATE_FETCH_FAILED', error);
    }
  };
}

/**
 * createSelfUpdater({ fetch, fetchBytes, subtle, store, stateApi, running, publicKeys, keyed, pickDirectory, reload, now })
 * -> Readonly<{ enabled, status(), check(), chooseFolder(), run({ onStep, allowPrompt }), forgetFolder(), setAutoApply(on) }>.
 *  - fetch: the page's fetch (latest.json, and the source of the default fetchBytes); fetchBytes(url, { maxBytes }) may be
 *    injected instead (tests).
 *  - subtle: a SubtleCrypto. store: createUpdateStore(...). stateApi: createUpdateStateApi(...).
 *  - running: { version, manifestBytes: () => Promise<Uint8Array> }, the loaded extension's version and manifest.json bytes.
 *  - publicKeys: SPKI DER base64 list (default: the keys built into update-keys.js). keyed: true in a build that carries
 *    the built-in keys; ONLY such a build may update itself, so a development folder is never overwritten.
 *  - pickDirectory: () => Promise<FileSystemDirectoryHandle> (showDirectoryPicker in readwrite mode; the caller binds it).
 *  - reload: () => void, reloads the extension. now: () => ms.
 * Every method resolves; failures are { ok: false, code } with a code of UPDATE_ERROR_CODES, never a thrown error.
 */
export function createSelfUpdater({
  fetch: fetcher, fetchBytes: injectedFetchBytes, subtle, store, stateApi, running, publicKeys = UPDATE_PUBLIC_KEYS, keyed,
  pickDirectory, reload, now = () => Date.now(),
} = {}) {
  const fetchBytes = typeof injectedFetchBytes === 'function' ? injectedFetchBytes : createFetchBytes(fetcher);
  const enabled = keyed === true && Array.isArray(publicKeys) && publicKeys.length > 0 && typeof pickDirectory === 'function';
  let busy = false;

  const runningBytes = async () => {
    try { return await running.manifestBytes(); } catch { return null; }
  };
  const loadHandle = async () => {
    try { return (await store.load()) ?? null; } catch { return null; }
  };
  /** An apply that was recorded as started, but whose version is now the running one, is finished: only the record is stale. */
  const staleMark = (state) => {
    if (state.pending === null) return false;
    const order = compareVersions(running?.version, state.pending.version);
    return order === 0 || order === 1;
  };

  async function folderState(state) {
    const handle = await loadHandle();
    if (handle === null) return state.folder ? 'gone' : 'none';
    try {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      return permission === 'granted' ? 'granted' : permission === 'prompt' ? 'needs-click' : 'gone';
    } catch { return 'gone'; }
  }

  async function status() {
    const state = await stateApi.read();
    return Object.freeze({
      enabled,
      folder: enabled ? await folderState(state) : 'none',
      autoApply: state.autoApply,
      appliedVersion: state.appliedVersion,
      pending: staleMark(state) ? null : state.pending,
      lastError: state.lastError,
    });
  }

  function check() {
    return checkForUpdate({ fetch: fetcher, currentVersion: running?.version });
  }

  /** queryPermission, and requestPermission only when the caller says a click is behind this call. */
  async function ensurePermission(handle, allowPrompt) {
    let permission;
    try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch (error) { throw fail('UPDATE_NO_FOLDER', error); }
    if (permission === 'granted') return;
    if (permission === 'denied') throw fail('UPDATE_PERMISSION_DENIED');
    if (allowPrompt !== true) throw fail('UPDATE_NEEDS_PERMISSION');
    try { permission = await handle.requestPermission({ mode: 'readwrite' }); } catch (error) { throw fail('UPDATE_NEEDS_PERMISSION', error); }
    if (permission === 'granted') return;
    throw fail(permission === 'denied' ? 'UPDATE_PERMISSION_DENIED' : 'UPDATE_NEEDS_PERMISSION');
  }

  async function fetchSmall(url, maxBytes) {
    let bytes;
    try { bytes = await fetchBytes(url, { maxBytes }); } catch (error) {
      throw fail(error?.code === 'UPDATE_TOO_LARGE' ? 'UPDATE_TOO_LARGE' : 'UPDATE_FETCH_FAILED', error);
    }
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) throw fail('UPDATE_FETCH_FAILED');
    return bytes;
  }

  async function chooseFolder() {
    if (!enabled) return refusal('UPDATE_DISABLED');
    if (busy) return refusal('UPDATE_BUSY');
    busy = true;
    try {
      let handle;
      // No await before this call: the picker needs the click that got us here (transient user activation).
      try { handle = await pickDirectory(); } catch (error) { return refusal(error?.name === 'AbortError' ? 'UPDATE_PICK_CANCELLED' : 'UPDATE_NO_FOLDER'); }
      if (!isDirectory(handle)) return refusal('UPDATE_NO_FOLDER');
      const relation = await folderRelation({ dir: handle, runningManifestBytes: await runningBytes() });
      if (relation !== 'running') return refusal('UPDATE_WRONG_FOLDER');
      if ((await store.save(handle)) !== true) return refusal('UPDATE_NO_FOLDER');
      try { await stateApi.patch({ folder: true, lastError: null }); } catch { /* the stored handle alone already makes status() say so */ }
      return Object.freeze({ ok: true });
    } catch {
      return refusal('UPDATE_NO_FOLDER');
    } finally {
      busy = false;
    }
  }

  async function runLocked({ onStep, allowPrompt }) {
    const step = (name) => { if (typeof onStep === 'function') { try { onStep(name); } catch { /* the UI's callback must not stop an update */ } } };
    let phase = 'folder';
    try {
      step('checking');
      const handle = await loadHandle();
      if (handle === null) throw fail('UPDATE_NO_FOLDER');
      await ensurePermission(handle, allowPrompt);
      phase = 'fetch';
      const state = await stateApi.read();
      if (staleMark(state)) { try { await stateApi.patch({ pending: null }); } catch { /* cosmetic */ } }
      const latest = await check();
      if (!latest.available) throw fail(latest.version === null ? 'UPDATE_FETCH_FAILED' : 'UPDATE_NOT_NEWER');

      step('downloading');
      const urls = updateTreeUrls(latest.version);
      const manifestBytes = await fetchSmall(urls.manifest, SELF_UPDATE_LIMITS.maxManifestBytes);
      const signatureBytes = await fetchSmall(urls.signature, SIGNATURE_MAX_BYTES);

      step('verifying');
      phase = 'verify';
      const manifest = await verifyUpdateManifest({ manifestBytes, signature: latin1(signatureBytes), publicKeys, subtle });
      if (manifest.version !== latest.version) throw fail('UPDATE_BAD_MANIFEST');
      const plan = planUpdate({ manifest, runningVersion: running?.version });
      if (!plan.ok) throw fail(plan.code);
      const files = await downloadUpdate({ manifest, fetchBytes, subtle });

      phase = 'write';
      await ensurePermission(handle, false);          // the downloads took time: the permission may be gone, and nothing here may ask for it
      const relation = await folderRelation({ dir: handle, runningManifestBytes: await runningBytes(), targetManifestBytes: files.get(MANIFEST_FILE) });
      if (relation === 'other') throw fail('UPDATE_WRONG_FOLDER');
      if (relation === 'running') {
        step('writing');
        try { await stateApi.patch({ pending: { version: manifest.version, at: now() } }); } catch (error) { throw fail('UPDATE_WRITE_FAILED', error); }
        await applyUpdate({ dir: handle, manifest, files, previousPaths: state.appliedPaths });
      }
      // relation 'target': an earlier apply wrote everything (manifest.json is written last) and only the reload is missing.
      try {
        await stateApi.patch({ pending: null, appliedVersion: manifest.version, appliedPaths: manifest.files.map(({ path }) => path), lastError: null });
      } catch { /* the files are in place; the marker is judged stale by the version once the new code runs */ }
      step('reloading');
      try { await reload?.(); } catch { /* the files are in place: the next start of the browser loads them */ }
      return Object.freeze({ ok: true, version: manifest.version });
    } catch (error) {
      const fallback = { folder: 'UPDATE_NO_FOLDER', fetch: 'UPDATE_FETCH_FAILED', verify: 'UPDATE_BAD_MANIFEST', write: 'UPDATE_WRITE_FAILED' }[phase];
      const code = UPDATE_ERROR_CODES.includes(error?.code) ? error.code : fallback;
      if (!NOT_RECORDED.includes(code)) { try { await stateApi.patch({ lastError: code }); } catch { /* nowhere to put it */ } }
      return refusal(code);
    }
  }

  async function run({ onStep, allowPrompt = false } = {}) {
    if (!enabled) return refusal('UPDATE_DISABLED');
    if (busy) return refusal('UPDATE_BUSY');
    busy = true;
    try { return await runLocked({ onStep, allowPrompt }); } finally { busy = false; }
  }

  async function forgetFolder() {
    try { await store.clear(); } catch { /* nothing more to do */ }
    try { await stateApi.patch({ folder: false, pending: null, lastError: null }); } catch { /* ditto */ }
  }

  async function setAutoApply(on) {
    try { await stateApi.patch({ autoApply: on === true }); } catch { /* the next status() shows what was kept */ }
  }

  return Object.freeze({ enabled, status, check, chooseFolder, run, forgetFolder, setAutoApply });
}
