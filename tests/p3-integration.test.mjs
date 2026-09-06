// P3-38: the P3 features in combination, over the P1-20 fake browser.
//
// What this suite does NOT claim: the mock DOM cannot lay anything out, so
// nothing here is evidence for the responsive, contrast or touch-target rows of
// p3-verification (V01-V09). Those stay manual, and the suite asserts that the
// verification document still says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootP3, tick, until } from './fixtures/p3-scenarios.mjs';
import { all, byClass, domText, leaks, secrets } from './fixtures/scenarios.mjs';

test('sheets stay mutually exclusive across the P3 surfaces, and none survives a teardown', async (t) => {
  const b = await bootP3();
  t.after(() => b.app.close());
  assert.equal(b.openSheetId(), null);
  assert.equal(b.inertCount(), false);

  b.openSheet('display');
  assert.equal(b.openSheetId(), 'display');
  assert.equal(b.inertCount(), true, 'the background is inert while a sheet is open');

  b.openSheet('settings');
  assert.equal(b.openSheetId(), 'settings', 'opening one closes the other');
  b.openSheet('share');
  assert.equal(b.openSheetId(), 'share');
  b.app.shell.closeShare();
  assert.equal(b.openSheetId(), null);
  assert.equal(b.inertCount(), false, 'no inert survives the close');

  b.openSheet('display');
  await b.app.close();
  assert.equal(b.inertCount(), false, 'no inert survives a teardown');
});

test('a language change carries every P3 surface with it and starts nothing', async (t) => {
  const b = await bootP3();
  t.after(() => b.app.close());
  const before = b.gemini.calls.length;
  const guide = () => byClass(b.root, 'key-guide-title').textContent;
  const first = guide();
  b.app.shell.setLanguage('ja');
  await tick();
  assert.notEqual(guide(), first, 'the key guide followed the language');
  assert.equal(byClass(b.root, 'display-title').textContent.length > 0, true);
  assert.equal(b.gemini.calls.length, before, 'changing language starts no provider work');
  assert.equal(b.microphone.streams.length, 0, 'and asks for no microphone');
});

test('a key change reaches the guide, the badge and the plan display at once', async (t) => {
  const b = await bootP3();
  t.after(() => b.app.close());
  const shown = () => all(b.root, (node) => node.classes.has('key-guide')
    && node.getAttribute('data-variant') !== 'settings' && !node.hidden
    && node.parentNode?.hidden !== true).length;
  assert.ok(shown() > 0, 'a run with no key offers the guidance');

  b.enterPersonalKey({ key: secrets.personal, remember: true });
  await until(() => shown() === 0);
  assert.equal(shown(), 0, 'a stored key silences the prompts');
  // The plan display asks to be re-checked rather than changing itself.
  assert.equal(byClass(b.root, 'billing-key-changed') !== undefined, true);
  assert.equal(leaks(domText(b.root)), false, 'no key value anywhere in the DOM');
});

test('nothing new flows into storage, the policy or a request', async (t) => {
  const b = await bootP3();
  t.after(() => b.app.close());
  b.enterPersonalKey({ key: secrets.personal, remember: true });
  b.openSheet('display');
  byClass(b.root, 'display-captions-larger')?.dispatch('click');
  const dark = all(b.root, (node) => node.getAttribute('id') === 'display-sheet-mode-dark')[0];
  if (dark) { dark.checked = true; dark.dispatch('change'); }
  await tick();

  // Every key written this run is a known preference, never a secret.
  for (const [key, value] of b.storage) {
    assert.equal(leaks(value), key.includes('personal-key'),
      `${key} carries a secret only where the key store deliberately stores one`);
    assert.match(key, /^interp-app\./, `${key} is namespaced`);
  }
  assert.equal(leaks(b.ops), false, 'no request carries a secret');
  assert.equal(leaks(b.app.engine.state.snapshot()), false, 'no secret in the state');
  assert.equal(leaks(b.app.usage.snapshot()), false, 'no secret in the usage observations');
});

test('the verification document still marks the layout rows as manual', async () => {
  const doc = await readFile(new URL('../docs/p3-verification.md', import.meta.url), 'utf8');
  // A mock DOM cannot decide a layout: this suite must not be read as evidence.
  assert.match(doc, /실제 브라우저|실기기/);
  assert.match(doc, /미검증/);
  assert.match(doc, /Node 테스트의 모의 DOM/, 'the document states what the mock cannot prove');
  // And the hub live control is fixture-only until a server implements it.
  assert.match(doc, /fixture 검증까지만/);
});
