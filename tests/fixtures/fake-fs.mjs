// Fixtures of the extension's self-update tests (docs/extension.md §21): an in-memory folder shaped like a
// FileSystemDirectoryHandle, and a fake download site that serves a tree signed with a throw-away key. Nothing here touches a
// disk, a network or a browser.
//
// The folder models what the updater relies on and what can go wrong with it:
//  - createWritable() stages bytes and commits them only on close() (an abort or a failure leaves the old bytes);
//  - getFileHandle(name, { create: true }) creates an EMPTY file at once (as Chrome does), so a failed write can leave one;
//  - names are checked like the platform checks them (no "", ".", "..", "/" or "\"), and the disk can be case-insensitive;
//  - permission is 'granted' | 'prompt' | 'denied': every access except queryPermission/requestPermission needs 'granted'
//    (otherwise NotAllowedError), requestPermission answers `requestOutcome` (a state, or an Error to throw);
//  - failures: lock(path) (a file another process holds open: createWritable throws, as on Windows), inject(path, phase, error)
//    for 'open' | 'write' | 'close' | 'remove', and failAfterCommits(n) (the machine "dies" after n committed files).
// `log` records every effect in order; `mutations` is the part of it that changed the folder.
import { createHash } from 'node:crypto';
import { signUpdateManifest } from '../../scripts/update-signing.mjs';
import { UPDATE_MANIFEST_URL, updateTreeUrls } from '../../extension/lib/update-check.js';

const fault = (name, message = name) => new DOMException(message, name);
const bytesOf = (content) => (typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createFakeFolder({ files = {}, permission = 'granted', caseInsensitive = false, name = 'LiveInterpreter', requestOutcome = 'granted' } = {}) {
  const state = {
    permission, requestOutcome, caseInsensitive, log: [], injected: [], locked: new Set(), commitsLeft: null, commitError: null, commits: 0,
  };
  const fold = (text) => (state.caseInsensitive ? text.toLowerCase() : text);
  const newDirectory = () => ({ kind: 'directory', children: new Map() });
  const root = newDirectory();

  const checkName = (entryName) => {
    if (typeof entryName !== 'string' || entryName === '' || entryName === '.' || entryName === '..' || /[/\\]/.test(entryName)) throw new TypeError('Name is not allowed.');
  };
  const needAccess = () => { if (state.permission !== 'granted') throw fault('NotAllowedError', 'The request is not allowed by the user agent or the platform in the current context.'); };
  const effect = (op, path) => state.log.push({ op, path });
  const injectedFor = (path, phase) => {
    const hit = state.injected.find((item) => item.phase === phase && fold(item.path) === fold(path) && item.times > 0);
    if (hit === undefined) return null;
    hit.times -= 1;
    return hit.error;
  };

  function makeFileHandle(parent, entry, path) {
    return {
      kind: 'file',
      name: entry.name,
      async getFile() {
        needAccess();
        const bytes = new Uint8Array(entry.node.bytes);
        return { name: entry.name, size: bytes.length, lastModified: 0, async arrayBuffer() { return bytes.buffer.slice(0); }, async text() { return new TextDecoder().decode(bytes); } };
      },
      async createWritable({ keepExistingData = false } = {}) {
        needAccess();
        if (state.locked.has(fold(path))) throw fault('NoModificationAllowedError', 'The file is in use by another process.');
        const openError = injectedFor(path, 'open');
        if (openError !== null) throw openError;
        if (state.commitsLeft !== null && state.commitsLeft <= 0) throw state.commitError;
        let staged = keepExistingData ? new Uint8Array(entry.node.bytes) : new Uint8Array(0);
        let settled = false;
        return {
          async write(data) {
            if (settled) throw new TypeError('The stream is closed.');
            const writeError = injectedFor(path, 'write');
            if (writeError !== null) throw writeError;
            const chunk = bytesOf(data);
            const next = new Uint8Array(staged.length + chunk.length);
            next.set(staged, 0);
            next.set(chunk, staged.length);
            staged = next;
          },
          async close() {
            if (settled) throw new TypeError('The stream is closed.');
            const closeError = injectedFor(path, 'close');
            if (closeError !== null) { settled = true; effect('abort', path); throw closeError; }
            settled = true;
            entry.node.bytes = staged;
            state.commits += 1;
            if (state.commitsLeft !== null) state.commitsLeft -= 1;
            effect('commit', path);
          },
          async abort() {
            if (settled) return;
            settled = true;
            effect('abort', path);
          },
        };
      },
    };
  }

  function makeDirectoryHandle(node, directoryName, prefix) {
    const join = (child) => (prefix === '' ? child : `${prefix}/${child}`);
    const handle = {
      kind: 'directory',
      name: directoryName,
      async getDirectoryHandle(childName, { create = false } = {}) {
        checkName(childName);
        needAccess();
        const found = node.children.get(fold(childName));
        if (found !== undefined) {
          if (found.node.kind !== 'directory') throw fault('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.');
          return makeDirectoryHandle(found.node, found.name, join(found.name));
        }
        if (!create) throw fault('NotFoundError', 'A requested file or directory could not be found.');
        const entry = { name: childName, node: newDirectory() };
        node.children.set(fold(childName), entry);
        effect('mkdir', join(childName));
        return makeDirectoryHandle(entry.node, childName, join(childName));
      },
      async getFileHandle(childName, { create = false } = {}) {
        checkName(childName);
        needAccess();
        const found = node.children.get(fold(childName));
        if (found !== undefined) {
          if (found.node.kind !== 'file') throw fault('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.');
          return makeFileHandle(node, found, join(found.name));
        }
        if (!create) throw fault('NotFoundError', 'A requested file or directory could not be found.');
        const entry = { name: childName, node: { kind: 'file', bytes: new Uint8Array(0) } };
        node.children.set(fold(childName), entry);
        effect('create', join(childName));
        return makeFileHandle(node, entry, join(childName));
      },
      async removeEntry(childName, { recursive = false } = {}) {
        checkName(childName);
        needAccess();
        const found = node.children.get(fold(childName));
        if (found === undefined) throw fault('NotFoundError', 'A requested file or directory could not be found.');
        if (found.node.kind === 'directory' && found.node.children.size > 0 && !recursive) throw fault('InvalidModificationError', 'The object can not be modified in this way.');
        const removeError = injectedFor(join(found.name), 'remove');
        if (removeError !== null) throw removeError;
        if (state.locked.has(fold(join(found.name)))) throw fault('NoModificationAllowedError', 'The file is in use by another process.');
        node.children.delete(fold(childName));
        effect('remove', join(found.name));
      },
      async queryPermission() {
        state.log.push({ op: 'query', path: '' });
        return state.permission;
      },
      async requestPermission() {
        state.log.push({ op: 'request', path: '' });
        if (state.requestOutcome instanceof Error) throw state.requestOutcome;
        if (state.requestOutcome === 'granted' || state.requestOutcome === 'denied') state.permission = state.requestOutcome;
        return state.permission;
      },
    };
    return handle;
  }

  const rootHandle = makeDirectoryHandle(root, name, '');

  /** Creates the directories and the file of `path` directly (no log, no permission), for building a starting state. */
  function seed(path, content) {
    const parts = path.split('/');
    const leaf = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.children.has(fold(part))) node.children.set(fold(part), { name: part, node: newDirectory() });
      node = node.children.get(fold(part)).node;
    }
    node.children.set(fold(leaf), { name: leaf, node: { kind: 'file', bytes: bytesOf(content) } });
  }
  for (const [path, content] of Object.entries(files)) seed(path, content);

  function walk(node, prefix, out) {
    for (const { name: childName, node: child } of node.children.values()) {
      const path = prefix === '' ? childName : `${prefix}/${childName}`;
      if (child.kind === 'directory') { out.directories.push(path); walk(child, path, out); } else out.files.set(path, child.bytes);
    }
    return out;
  }
  const lookup = (path) => {
    let node = root;
    for (const part of path.split('/')) {
      const next = node.kind === 'directory' ? node.children.get(fold(part)) : undefined;
      if (next === undefined) return undefined;
      node = next.node;
    }
    return node;
  };

  return {
    handle: rootHandle,
    log: state.log,
    get mutations() { return state.log.filter((item) => ['mkdir', 'create', 'commit', 'remove'].includes(item.op)); },
    /** Paths of the committed files, in commit order (what "manifest.json LAST" is asserted on). */
    get commits() { return state.log.filter((item) => item.op === 'commit').map((item) => item.path); },
    get removed() { return state.log.filter((item) => item.op === 'remove').map((item) => item.path); },
    get requests() { return state.log.filter((item) => item.op === 'request').length; },
    get permission() { return state.permission; },
    set permission(value) { state.permission = value; },
    set requestOutcome(value) { state.requestOutcome = value; },
    get untouched() { return this.mutations.length === 0; },
    seed,
    exists: (path) => lookup(path) !== undefined,
    read: (path) => { const node = lookup(path); return node?.kind === 'file' ? new Uint8Array(node.bytes) : undefined; },
    text: (path) => { const node = lookup(path); return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : undefined; },
    /** Map path -> bytes of every file, sorted by path. */
    snapshot() {
      const found = walk(root, '', { files: new Map(), directories: [] });
      return new Map([...found.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => [path, new Uint8Array(bytes)]));
    },
    directories: () => walk(root, '', { files: new Map(), directories: [] }).directories.sort(),
    /** A file another process holds open: createWritable() and removeEntry() throw NoModificationAllowedError. */
    lock(path) { state.locked.add(fold(path)); },
    unlock(path) { state.locked.delete(fold(path)); },
    /** The next `times` uses of `phase` ('open' | 'write' | 'close' | 'remove') on `path` throw `error`. */
    inject(path, phase, error = fault('NoModificationAllowedError', `injected ${phase} failure`), times = Infinity) {
      state.injected.push({ path, phase, error, times });
    },
    clearFailures() { state.injected.length = 0; state.locked.clear(); state.commitsLeft = null; },
    /** After `count` more committed files every createWritable() throws `error`: the machine "died" half-way. */
    failAfterCommits(count, error = fault('NoModificationAllowedError', 'injected failure after a number of commits')) {
      state.commitsLeft = count;
      state.commitError = error;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The download site.

/** A tree of files (path -> text or bytes) as the release script would publish it: signed manifest, signature, file bytes. */
export function buildSignedTree({ version, released = '2026-10-08', files, privatePem }) {
  const entries = Object.entries(files).map(([path, content]) => ({ path, bytes: bytesOf(content) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    format: 1, version, released, files: entries.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = privatePem === undefined ? null : signUpdateManifest(manifestBytes, privatePem);
  return { version, manifest, manifestBytes, signature, files: new Map(entries.map(({ path, bytes }) => [path, bytes])) };
}

/**
 * A fake of the download site for the trees given: serves latest.json (version `latest`), then every tree's
 * manifest.json, manifest.sig and files/<path>, at the URLs updateTreeUrls() derives. `fetch` answers like a page's fetch
 * (Response objects), `fetchBytes` like the updater's own downloader. `override(url, bytes | null)` replaces or removes
 * (404) what a URL serves; `requests` lists the URLs asked for, in order.
 */
export function createFakeSite({ latest, trees }) {
  const served = new Map();
  const requests = [];
  const overrides = new Map();
  const state = { latest };
  for (const tree of trees) {
    const urls = updateTreeUrls(tree.version);
    served.set(urls.manifest, tree.manifestBytes);
    if (tree.signature !== null) served.set(urls.signature, new TextEncoder().encode(`${tree.signature}\n`));
    for (const [path, bytes] of tree.files) served.set(urls.file(path), bytes);
  }
  const bodyOf = (url) => {
    if (overrides.has(url)) return overrides.get(url);
    if (url === UPDATE_MANIFEST_URL) return new TextEncoder().encode(JSON.stringify({ version: state.latest, released: '2026-10-08', download: 'x', page: 'y' }));
    return served.get(url) ?? null;
  };
  return {
    requests,
    get latest() { return state.latest; },
    set latest(value) { state.latest = value; },
    override(url, bytes) { overrides.set(url, bytes); },
    clearOverrides() { overrides.clear(); },
    async fetch(url) {
      requests.push(url);
      const body = bodyOf(url);
      if (body === null || body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200 });
    },
    async fetchBytes(url, { maxBytes = Infinity } = {}) {
      requests.push(url);
      const body = bodyOf(url);
      if (body === null || body === undefined) throw Object.assign(new Error('UPDATE_FETCH_FAILED'), { code: 'UPDATE_FETCH_FAILED' });
      if (body.length > maxBytes) throw Object.assign(new Error('UPDATE_TOO_LARGE'), { code: 'UPDATE_TOO_LARGE' });
      return new Uint8Array(body);
    },
  };
}
