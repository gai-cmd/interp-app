import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT, LANGS, OSES } from '../extension-site/content.js';

// The wording of Chrome's share dialog in the three languages (docs/extension.md §20, "Wording review" of 2026-10-08):
// the panel dictionaries (extension/i18n/*.json) and the six manuals and the guide (extension-site/content.js). Pure data:
// nothing here renders, builds or opens anything. The panel and the page tests pin where each string is SHOWN; this file pins
// what the strings SAY.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const dictionaries = {};
for (const lang of LANGS) dictionaries[lang] = JSON.parse(await readFile(join(repoRoot, 'extension', 'i18n', `${lang}.json`), 'utf8'));

// Chrome's two generations of labels. Classic: toggle "Also share tab audio", button "Share". With the audio selection on
// (the owner's Mac): toggle "Share with tab audio" and, once it is on, button "Share with Audio".
const LABELS = Object.freeze({
  en: { toggleNew: 'Share with tab audio', toggleOld: 'Also share tab audio', buttonNew: 'Share with Audio', buttonOld: 'Share', icon: 'Live Interpreter icon', chooseTab: 'choose the tab' },
  ja: { toggleNew: 'タブの音声を含めて共有する', toggleOld: 'タブの音声も共有する', buttonNew: '音声付きで共有', buttonOld: '共有', icon: '「Live Interpreter」アイコン', chooseTab: 'タブを選んで' },
  ko: { toggleNew: '탭 오디오와 함께 공유', toggleOld: '탭 오디오도 공유', buttonNew: '오디오와 함께 공유', buttonOld: '공유', icon: '‘Live Interpreter’ 아이콘', chooseTab: '탭을 고르세요' },
});
const QUOTES = Object.freeze({ en: ['"', '"'], ja: ['「', '」'], ko: ['‘', '’'] });
const quoted = (lang, label) => `${QUOTES[lang][0]}${label}${QUOTES[lang][1]}`;

function* strings(value, path = '') {
  if (typeof value === 'string') { yield [path, value]; return; }
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) yield* strings(item, `${path}[${index}]`); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
}
// Every string a member can read, with a name for the failure message: dictionary values and the whole manual content.
function* everyString(lang) {
  for (const [key, text] of Object.entries(dictionaries[lang])) yield [`dictionary ${lang} ${key}`, text];
  for (const [path, text] of strings(CONTENT[lang])) yield [`manual ${lang}${path}`, text];
}

const perOs = (value, os) => (value && !Array.isArray(value) && typeof value === 'object' && ('win' in value || 'mac' in value) ? value[os] : value);
const itemsFor = (list, os) => (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' || !(('win' in item) || ('mac' in item)) || typeof item[os] === 'string');
const textOf = (item, os) => (typeof item === 'string' ? item : (item.text ?? item[os]) + (item.note ? ` ${item.note}` : ''));
const sectionOf = (lang, id) => CONTENT[lang].sections.find((section) => section.id === id);
const bulletsOf = (lang, os, id) => itemsFor(perOs(sectionOf(lang, id).bullets, os), os).map((item) => textOf(item, os));
const answersOf = (lang) => sectionOf(lang, 'trouble').faq.map((entry) => entry.a);
const indexes = (text, needles) => needles.map((needle) => text.indexOf(needle));

// --- the dictionaries -------------------------------------------------------------------------------------------------

test('dictionaries: ko, ja and en have the same key set, every key is an ext.* key, and the counts agree', () => {
  const keysOf = (lang) => Object.keys(dictionaries[lang]);
  assert.ok(keysOf('en').length > 100, 'the dictionary was read');
  for (const lang of LANGS) {
    const extKeys = keysOf(lang).filter((key) => key.startsWith('ext.'));
    assert.equal(extKeys.length, keysOf(lang).length, `${lang}: every key of the file is an ext.* key`);
    assert.equal(new Set(keysOf(lang)).size, keysOf(lang).length, `${lang}: no key twice`);
    assert.deepEqual([...keysOf(lang)].sort(), [...keysOf('en')].sort(), `${lang} has the key set of en`);
    for (const gone of ['ext.status.awaitingArm', 'ext.arm.waiting', 'ext.arm.pickButton']) {
      assert.equal(keysOf(lang).includes(gone), false, `${lang}: ${gone} belongs to the removed wait for the icon`);
    }
  }
});

test('ext.arm.picking and ext.error.TAB_SHARE_NO_AUDIO name BOTH generations of Chrome\'s labels, in ko, ja and en', () => {
  for (const lang of LANGS) {
    for (const key of ['ext.arm.picking', 'ext.error.TAB_SHARE_NO_AUDIO']) {
      const text = dictionaries[lang][key];
      for (const label of ['toggleNew', 'toggleOld', 'buttonNew', 'buttonOld']) {
        assert.ok(text.includes(quoted(lang, LABELS[lang][label])), `${lang} ${key} quotes ${label} ${quoted(lang, LABELS[lang][label])}`);
      }
    }
  }
});

test('ext.arm.picking gives the steps in order: choose the tab, leave the audio option on, then press the button', () => {
  for (const lang of LANGS) {
    const text = dictionaries[lang]['ext.arm.picking'];
    const [choose] = indexes(text, [LABELS[lang].chooseTab]);
    const toggles = indexes(text, [quoted(lang, LABELS[lang].toggleNew), quoted(lang, LABELS[lang].toggleOld)]);
    const buttons = indexes(text, [quoted(lang, LABELS[lang].buttonNew), quoted(lang, LABELS[lang].buttonOld)]);
    assert.ok(choose >= 0, `${lang}: says to choose the tab`);
    assert.ok(Math.min(...toggles) > choose, `${lang}: the audio option comes after choosing the tab`);
    // The appended pickSlow ("Or press the icon…") must follow the last step, not a "leave it on" sentence.
    assert.ok(Math.min(...buttons) > Math.max(...toggles), `${lang}: the button comes after the audio option, so the text ends on pressing it`);
  }
});

test('ext.arm.pickSlow, ext.error.TAB_SHARE_NO_AUDIO and ext.error.TAB_CAPTURE_FAILED name the icon; the capture failure keeps its first advice', () => {
  for (const lang of LANGS) {
    for (const key of ['ext.arm.pickSlow', 'ext.error.TAB_SHARE_NO_AUDIO', 'ext.error.TAB_CAPTURE_FAILED']) {
      assert.ok(dictionaries[lang][key].includes(LABELS[lang].icon), `${lang} ${key} names the icon (${LABELS[lang].icon})`);
    }
  }
  // A policy that blocks the dialog is not cured by reloading the tab, so the icon is added, not substituted.
  const reload = { en: 'Reload the tab', ja: '再読み込み', ko: '새로고침' };
  for (const lang of LANGS) {
    const text = dictionaries[lang]['ext.error.TAB_CAPTURE_FAILED'];
    assert.ok(text.includes(reload[lang]), `${lang}: still says to reload the tab`);
    assert.ok(text.indexOf(reload[lang]) < text.indexOf(LABELS[lang].icon), `${lang}: reload first, then the icon`);
  }
});

test('ext.arm.pickLost says where the window may be without a taskbar or Dock claim, and is not just "this window"', () => {
  const expected = {
    en: ['Cannot see the Chrome window?', 'behind the Chrome window you are working in', 'another screen'],
    ja: ['Chrome のウィンドウが見当たらない', '作業中の Chrome ウィンドウの後ろ', '別の画面'],
    ko: ['Chrome 창이 안 보이면', '지금 쓰는 Chrome 창 뒤', '다른 화면'],
  };
  const thisWindow = { en: /this window/i, ja: /このウィンドウ/, ko: /이 창/ };
  for (const lang of LANGS) {
    const text = dictionaries[lang]['ext.arm.pickLost'];
    assert.ok(text.length >= 30, `${lang}: not a stub`);
    for (const part of expected[lang]) assert.ok(text.includes(part), `${lang}: ${part}`);
    assert.doesNotMatch(text, thisWindow[lang], `${lang}: "this window" may mean the side panel`);
  }
});

test('nothing a member reads (dictionaries, manuals, guide) claims a taskbar or a Dock', () => {
  const claim = /taskbar|\bDock\b|タスクバー|ドック|작업 ?표시줄/i;
  for (const lang of LANGS) {
    for (const [name, text] of everyString(lang)) assert.doesNotMatch(text, claim, name);
  }
});

test('ko: ext.arm.pinHint uses the particle that fits "Interpreter" (를)', () => {
  const text = dictionaries.ko['ext.arm.pinHint'];
  assert.ok(text.includes('‘Live Interpreter’를'), text);
  assert.equal(text.includes('’을'), false, 'the wrong particle is gone');
});

test('ext.howto.step2 says what pressing Start instead of the icon does, not "without the icon"', () => {
  assert.ok(dictionaries.en['ext.howto.step2'].includes('If you press Start instead of the icon,'));
  assert.ok(dictionaries.ko['ext.howto.step2'].includes('아이콘을 누르지 않고 시작을 누르면'));
  assert.ok(dictionaries.ja['ext.howto.step2'].includes('アイコンを押さずに開始を押すと'));
  assert.equal(/Without the icon/i.test(dictionaries.en['ext.howto.step2']), false);
  assert.equal(dictionaries.ko['ext.howto.step2'].includes('아이콘 없이'), false);
});

test('the removed phrases and key names are gone from every dictionary string and every manual', () => {
  const removed = {
    en: [/other way/i, /waiting for the icon/i, /Or choose the tab in a Chrome window/i, /skips that question/i],
    ko: [/다른 방법/, /아이콘을 기다/, /또는 Chrome 창에서 탭을 고르/, /이 질문/],
    ja: [/別の方法/, /アイコンを待/, /または Chrome のウィンドウでタブを選/, /この確認/],
  };
  const keyNames = ['ext.status.awaitingArm', 'ext.arm.waiting', 'ext.arm.pickButton'];
  for (const lang of LANGS) {
    for (const [name, text] of everyString(lang)) {
      // Every phrase is checked against every language's strings: a phrase that crept into another language counts too.
      for (const patterns of Object.values(removed)) for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${name} still has ${pattern}`);
      for (const keyName of keyNames) assert.equal(text.includes(keyName), false, `${name} names the removed key ${keyName}`);
    }
  }
});

// --- the manuals and the guide ----------------------------------------------------------------------------------------

test('manuals: the Start bullet of every language and OS quotes both generations, in the right order, and says the icon skips "that window"', () => {
  const skips = { en: 'skips that window', ja: 'このウィンドウを省いて', ko: '이 창을 건너뛰고' };
  for (const lang of LANGS) {
    const L = LABELS[lang];
    for (const os of OSES) {
      const candidates = bulletsOf(lang, os, 'first-use').filter((text) => text.includes(`**${L.toggleOld}**`));
      assert.equal(candidates.length, 1, `${lang}/${os}: exactly one first-use bullet explains the dialog`);
      const [text] = candidates;
      assert.ok(text.includes(`**${L.toggleNew}**`), `${lang}/${os}: the new toggle label`);
      assert.ok(text.includes(`[btn:${L.buttonNew}]`), `${lang}/${os}: the new button label`);
      assert.ok(text.includes(`[btn:${L.buttonOld}]`), `${lang}/${os}: the classic button label`);
      const toggles = indexes(text, [`**${L.toggleNew}**`, `**${L.toggleOld}**`]);
      const buttons = indexes(text, [`[btn:${L.buttonNew}]`, `[btn:${L.buttonOld}]`]);
      assert.ok(Math.max(...toggles) < Math.min(...buttons), `${lang}/${os}: the audio option, then the button`);
      assert.ok(text.includes(skips[lang]), `${lang}/${os}: ${skips[lang]}`);
    }
  }
});

test('manuals: the answer to "I cannot see the Chrome window" quotes both toggle labels and says the window may be behind, with no taskbar or Dock', () => {
  const behind = {
    en: 'it may be behind the Chrome window you are working in or on another screen',
    ja: '作業中の Chrome ウィンドウの後ろや別の画面にあるかもしれません',
    ko: '지금 쓰는 Chrome 창 뒤나 다른 화면에 있을 수 있어요',
  };
  for (const lang of LANGS) {
    const L = LABELS[lang];
    const answers = answersOf(lang).filter((text) => text.includes(`**${L.toggleOld}**`));
    assert.equal(answers.length, 1, `${lang}: exactly one answer explains the audio option`);
    const [text] = answers;
    assert.ok(text.includes(`**${L.toggleNew}**`), `${lang}: the new toggle label`);
    assert.ok(text.includes(behind[lang]), `${lang}: ${behind[lang]}`);
  }
});

test('ko manuals and dictionary use Chrome\'s own "측면 패널", one spelling, never 사이드패널 or 사이드 패널', () => {
  for (const [name, text] of everyString('ko')) assert.doesNotMatch(text, /사이드\s*패널/, name);
  const manual = [...strings(CONTENT.ko)].map(([, text]) => text);
  const spelled = manual.filter((text) => text.includes('측면 패널'));
  assert.ok(spelled.length >= 3, `the about paragraph, the first step and the close-the-panel bullet say 측면 패널 (found ${spelled.length})`);
});
