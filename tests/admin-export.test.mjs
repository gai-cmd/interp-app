// P3-33: turning a validated draft into a file someone commits (§1.7 step 7).
// The two traps: reporting a download as a publication, and exporting different
// content under the revision that is already live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXPORT_RESULTS, POLICY_FILENAME, PUBLISH_STEP_KEYS, createPolicyExport,
  serializePolicy } from '../app/admin/export.js';
import { createPolicyEditor } from '../app/admin/policy-editor.js';
import { examplePolicy, policyWith } from './fixtures/policy.mjs';

function domDouble() {
  const clicks = [], created = [], revoked = [];
  const doc = { createElement: () => ({ attributes: {}, setAttribute(n, v) { this.attributes[n] = v; },
    click() { clicks.push({ ...this.attributes }); } }) };
  const urlApi = { createObjectURL: () => { const url = `blob:${created.length}`; created.push(url); return url; },
    revokeObjectURL: (url) => revoked.push(url) };
  class BlobDouble { constructor(parts, options) { this.parts = parts; this.options = options; } }
  return { doc, urlApi, BlobDouble, clicks, created, revoked };
}
const editorFor = (deployed = examplePolicy()) => createPolicyEditor({ deployed });

test('a download produces the repository file, and releases its object URL', async () => {
  const d = domDouble();
  const editor = editorFor();
  editor.bumpRevision();
  const exporter = createPolicyExport({ editor, document: d.doc, URL: d.urlApi, Blob: d.BlobDouble });

  const result = await exporter.download();
  assert.equal(result.result, 'downloaded');
  assert.equal(result.filename, POLICY_FILENAME);
  assert.equal(POLICY_FILENAME, 'policy.json', 'the name the deployment root expects');
  assert.equal(d.clicks.length, 1);
  assert.equal(d.clicks[0].download, POLICY_FILENAME);
  // An object URL held open keeps the document alive; it is revoked at once.
  assert.deepEqual(d.revoked, d.created);
  // The body is the stable, diffable form the repository file has.
  const body = exporter.text();
  assert.equal(body, serializePolicy(editor.snapshot().draft));
  assert.ok(body.endsWith('}\n'), 'trailing newline, as a committed file');
  assert.equal(JSON.parse(body).revision, editor.snapshot().draft.revision);
});

test('a download is never reported as a publication', async () => {
  const d = domDouble();
  const editor = editorFor();
  editor.bumpRevision();
  const exporter = createPolicyExport({ editor, document: d.doc, URL: d.urlApi, Blob: d.BlobDouble });
  const result = await exporter.download();
  assert.equal(EXPORT_RESULTS.includes('published'), false, 'there is no "published" outcome to report');
  assert.equal(result.result, 'downloaded');
  // The steps a person still has to do are named, ending with re-reading the
  // policy to confirm the revision actually changed.
  assert.equal(PUBLISH_STEP_KEYS.length, 4);
  const ko = JSON.parse(await readFile(new URL('../app/i18n/ko.json', import.meta.url), 'utf8'));
  for (const key of PUBLISH_STEP_KEYS) assert.ok(ko[key], key);
  assert.ok(ko['admin.publish.noConfirmation'].length > 0);
  assert.ok(ko['admin.export.notPublished'].length > 0);
});

test('an invalid draft cannot be exported at all', async () => {
  const d = domDouble();
  const editor = editorFor();
  editor.setField('revision', -3);
  const exporter = createPolicyExport({ editor, document: d.doc, URL: d.urlApi, Blob: d.BlobDouble });
  assert.equal(exporter.blocker(), 'invalid');
  assert.deepEqual(await exporter.download(), { result: 'blocked', reason: 'invalid' });
  assert.deepEqual(await exporter.copy(), { result: 'blocked', reason: 'invalid' });
  assert.equal(d.clicks.length, 0, 'nothing was written');
});

test('different content may not go out under the revision that is already live', async () => {
  const d = domDouble();
  const deployed = policyWith((policy) => { policy.revision = 5; });
  const editor = createPolicyEditor({ deployed });
  const exporter = createPolicyExport({ editor, document: d.doc, URL: d.urlApi, Blob: d.BlobDouble });
  // Unchanged: exporting the same content under the same revision is fine.
  assert.equal(exporter.blocker(), null);

  editor.setField('emergency/stopped', true);
  assert.equal(exporter.blocker(), 'revision', 'changed content under the live revision is refused');
  assert.deepEqual(await exporter.download(), { result: 'blocked', reason: 'revision' });

  editor.bumpRevision();
  assert.equal(exporter.blocker(), null);
  assert.equal((await exporter.download()).revision, 6);
});

test('the clipboard falls back to selectable text rather than failing silently', async () => {
  const editor = editorFor();
  editor.bumpRevision();
  // No clipboard at all.
  let exporter = createPolicyExport({ editor, navigator: {} });
  let result = await exporter.copy();
  assert.equal(result.result, 'manual');
  assert.equal(result.text, exporter.text());
  // A clipboard that refuses.
  exporter = createPolicyExport({ editor, navigator: { clipboard: { writeText: async () => { throw new Error('no'); } } } });
  result = await exporter.copy();
  assert.equal(result.result, 'manual');
  // A clipboard that works.
  const written = [];
  exporter = createPolicyExport({ editor, navigator: { clipboard: { writeText: async (t) => written.push(t) } } });
  assert.equal((await exporter.copy()).result, 'copied');
  assert.equal(written[0], exporter.text());
});

test('a browser without Blob or object URLs reports a failure, not a silent success', async () => {
  const editor = editorFor();
  editor.bumpRevision();
  const exporter = createPolicyExport({ editor, document: null, URL: null, Blob: null });
  assert.deepEqual(await exporter.download(), { result: 'failed', reason: 'unsupported' });
  assert.throws(() => createPolicyExport({}), { message: 'INVALID_REQUEST' });
});
