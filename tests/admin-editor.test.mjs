// P3-32: the administrator policy editor (design-p3 §1.7). The two boundaries
// under test are that an imported file gets the app's own validator, and that
// editing here never becomes the running app's policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ADMIN_SECTIONS, mountAdmin } from '../app/admin/main.js';
import { EDITOR_SECTIONS, FORBIDDEN_KEYS, createPolicyEditor, diffPolicy, emptyPolicy,
  findForbidden, reviewChange } from '../app/admin/policy-editor.js';
import { validatePolicy } from '../app/policy/schema.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, byClass, all } from './fixtures/scenarios.mjs';
import { examplePolicy, policyWith, serialized } from './fixtures/policy.mjs';

const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async (lang) =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));

test('an imported file is checked by the app\'s validator, not a looser admin one', () => {
  const editor = createPolicyEditor({ deployed: examplePolicy() });
  assert.equal(editor.load(serialized(examplePolicy())), true);
  assert.equal(editor.validate().ok, true);

  // A file the app would reject is rejected here with the same issues.
  const broken = policyWith((policy) => { policy.revision = -1; policy.minAppVersion = 'v9'; });
  editor.load(JSON.stringify(broken));
  const result = editor.validate();
  assert.equal(result.ok, false);
  const appIssues = validatePolicy(broken).issues.map((issue) => `${issue.path}:${issue.code}`).sort();
  assert.deepEqual(result.issues.map((issue) => `${issue.path}:${issue.code}`).sort(), appIssues,
    'the console reports exactly what the app would');
  // Every issue names a field path, so the console can point at it.
  for (const issue of result.issues) assert.equal(typeof issue.path, 'string');
});

test('unparseable input and a credential in the file are refused outright', () => {
  const editor = createPolicyEditor({ deployed: examplePolicy() });
  assert.equal(editor.load('{not json'), false);
  assert.equal(editor.loadError, 'POLICY_JSON');
  assert.equal(editor.load([1, 2]), false);
  assert.equal(editor.load(null), false);

  // A policy is a public document: a key-shaped field is not "just invalid",
  // it is refused before it can be shown, edited or exported.
  const withKey = policyWith((policy) => { policy.sharedEvents = [{ ...(policy.sharedEvents?.[0] ?? {}), key: 'SECRET' }]; });
  assert.equal(editor.load(JSON.stringify(withKey)), false);
  assert.equal(editor.loadError, 'POLICY_CREDENTIAL');
  assert.equal(JSON.stringify(editor.getDraft()).includes('SECRET'), false, 'the refused file never became the draft');
  assert.deepEqual(findForbidden({ a: { key: 1 }, b: [{ token: 2 }] }), ['a/key', 'b/0/token']);
  for (const name of FORBIDDEN_KEYS) assert.deepEqual(findForbidden({ [name]: 1 }), [name]);
});

test('the change preview names what the change would do to people using the app', () => {
  const deployed = policyWith((policy) => { policy.features.sequential = true; policy.emergency = { stopped: false, reason: null }; });
  const editor = createPolicyEditor({ deployed });
  editor.setField('emergency/stopped', true);
  editor.setField('features/sequential', false);
  editor.setField('settings/ui.tone/locked', true);
  const review = editor.review();
  assert.equal(review.stopped, true, 'an emergency stop is named as one');
  assert.deepEqual([...review.disabledFeatures], ['sequential']);
  assert.deepEqual([...review.lockedSettings], ['ui.tone']);
  assert.ok(review.changes.some((change) => change.path === 'emergency/stopped'));

  // Releasing a stop is reported too, and is not the same as never stopping.
  const releasing = createPolicyEditor({ deployed: policyWith((p) => { p.emergency = { stopped: true, reason: 'x' }; }) });
  releasing.setField('emergency/stopped', false);
  assert.equal(releasing.review().released, true);
  assert.equal(releasing.review().stopped, false);
  assert.deepEqual(diffPolicy({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffPolicy({ a: 1 }, { a: 2 }), [{ path: 'a', from: 1, to: 2 }]);
  assert.equal(reviewChange(null, emptyPolicy()).revisionFrom, null);
});

test('a changed draft gets a new revision rather than reusing the live one', () => {
  const deployed = policyWith((policy) => { policy.revision = 7; });
  const editor = createPolicyEditor({ deployed });
  assert.equal(editor.snapshot().draft.revision, 7);
  assert.equal(editor.bumpRevision(), 8);
  assert.equal(editor.snapshot().draft.revision, 8);
  assert.deepEqual([...EDITOR_SECTIONS].length, 8);
});

test('the console boots in all three languages and hard-codes no string', async () => {
  for (const language of ['ko', 'en', 'ja']) {
    const doc = { activeElement: null, createElement: (tag) => new FakeElement(doc, tag) };
    doc.documentElement = doc.createElement('html');
    const root = doc.createElement('body');
    const i18n = createI18n({ dictionaries, language });
    const editor = createPolicyEditor({ deployed: examplePolicy() });
    const view = mountAdmin({ root, i18n, editor, document: doc });
    // Every section title comes from the dictionary, in the §1.7 order.
    const titles = all(view.element, (node) => node.classes.has('admin-section-title')).map((n) => n.textContent);
    assert.deepEqual(titles, ADMIN_SECTIONS.map((name) => dictionaries[language][`admin.section.${name}`]), language);
    assert.equal(byClass(view.element, 'admin-title').textContent, dictionaries[language]['admin.title']);
    view.destroy();
  }
  // The HTML itself carries no visible text (check-i18n scans it too).
  const html = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(html, /<title><\/title>/, 'the title is set at runtime');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), false, 'no inline script');
  assert.match(html, /appearance-boot\.js/, 'the same first-paint boot as the app');
  assert.match(html, /styles\.css/, 'the same design tokens');
});

test('the console never applies a draft to the running app and never deploys', async () => {
  for (const file of ['policy-editor.js', 'main.js', 'export.js', 'shared-payload.js']) {
    const source = await readFile(new URL(`../app/admin/${file}`, import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const forbidden of ['localStorage', 'sessionStorage', 'createPolicyRuntime', 'setPolicy', 'XMLHttpRequest']) {
      assert.equal(code.includes(forbidden), false, `${file} must not use ${forbidden}`);
    }
    // Only the entry may fetch, and only to read what is deployed.
    if (file !== 'main.js') assert.equal(/\bfetch\s*\(/.test(code), false, `${file} makes no request`);
  }
  const main = await readFile(new URL('../app/admin/main.js', import.meta.url), 'utf8');
  assert.equal(/method:\s*['"]POST/.test(main), false, 'nothing is published from the browser');
  assert.equal(/method:\s*['"]PUT/.test(main), false);
});
