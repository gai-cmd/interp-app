import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createI18n, loadI18n, normalizeLanguage, selectLanguage, SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkI18n, checkSource, validateDictionaries } from '../scripts/check-i18n.mjs';
import { ERROR_CODES } from '../app/providers/contract.js';
import { SECURITY_CODES } from '../app/security/redact.js';

const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))],
)));

test('normalizes regional tags and selects supported navigator preferences in order', () => {
  for (const [input, expected] of [['ko-KR', 'ko'], ['ja-JP', 'ja'], ['en-US', 'en'],
    [' KO_kr ', 'ko'], ['JA-jp-u-ca-japanese', 'ja'], ['fr-FR', 'en'], ['', 'en'],
    ['ko-???', 'en'], [null, 'en'], [undefined, 'en'], [42, 'en'], [{}, 'en']]) {
    assert.equal(normalizeLanguage(input), expected);
  }
  assert.equal(selectLanguage(['fr-FR', 'ja-JP', 'ko-KR']), 'ja');
  assert.equal(selectLanguage(['en-US', 'ko-KR']), 'en');
  assert.equal(selectLanguage(['fr', 'de']), 'en');
  assert.equal(selectLanguage('ko-KR'), 'ko');
  assert.equal(selectLanguage(null), 'en');
  assert.equal(selectLanguage(), 'en');
});

test('UI language is isolated from interpretation state, persistence, and other instances', () => {
  const state = { sourceLanguage: 'ko', targetLanguage: 'ja' };
  const first = createI18n({ dictionaries, languages: ['ko-KR'] });
  const second = createI18n({ dictionaries, language: 'ja-JP' });
  assert.equal(first.language, 'ko');
  state.sourceLanguage = 'en';
  assert.equal(first.language, 'ko');
  first.setLanguage('en-US');
  assert.deepEqual(state, { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.equal(second.language, 'ja');
  first.setLanguage('unsupported');
  assert.equal(first.language, 'en');
  assert.equal(createI18n({ dictionaries, language: 'fr', languages: ['ko'] }).language, 'en');
});

test('missing translations use English; unknown keys and raw errors are never echoed', () => {
  const sparse = structuredClone(dictionaries);
  delete sparse.ko['seq.translate'];
  sparse.ko['common.start'] = ' ';
  const i18n = createI18n({ dictionaries: sparse, language: 'ko' });
  assert.equal(i18n.t('seq.translate'), dictionaries.en['seq.translate']);
  assert.equal(i18n.t('common.start'), dictionaries.en['common.start']);
  sparse.en['seq.translate'] = 'mutated';
  assert.equal(i18n.t('seq.translate'), dictionaries.en['seq.translate']);
  for (const unknown of ['SYNTHETIC_PRIVATE_VALUE', '__proto__', 'constructor', null, {}]) {
    assert.equal(i18n.t(unknown), dictionaries.ko['error.unknown']);
    assert.equal(i18n.error(unknown), dictionaries.ko['error.unknown']);
  }
  const raw = { get code() { throw new Error('SYNTHETIC_PRIVATE_VALUE'); } };
  assert.equal(i18n.error(raw), dictionaries.ko['error.unknown']);
  assert.equal(i18n.has('toString'), false);
  assert.throws(() => createI18n(), { message: 'I18N_INVALID_DICTIONARY' });
});

test('all dictionaries cover provider/security errors and P1 guidance', () => {
  assert.deepEqual(validateDictionaries(dictionaries), []);
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    for (const code of [...ERROR_CODES, ...SECURITY_CODES]) {
      assert.ok(i18n.has(`error.${code}`), code);
      assert.equal(i18n.error(code), dictionaries[language][`error.${code}`]);
    }
    for (const key of ['language.ui', 'language.source', 'language.target', 'seq.holdToTalk',
      'seq.startRecording', 'seq.stopRecording', 'settings.keyCreate', 'settings.keyStorageWarning',
      'settings.keyRevoke', 'settings.sharedTemporary', 'settings.modeExplicit', 'providers.geminiTerms',
      'notice.data', 'notice.eligibility', 'quota.project', 'quota.unknown', 'quota.resetUnknown',
      'records.clearConfirm', 'records.off', 'pwa.iosInstall', 'pwa.browserInstall', 'pwa.updateAvailable',
      'pwa.nameLanguage', 'capability.untested', 'capability.hubRequired', 'voice.partialFailure']) {
      assert.ok(i18n.has(key), key);
      assert.equal(i18n.t(key), dictionaries[language][key]);
    }
  }
});

test('formats public parameters without recursive substitution and uses Intl', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    const formatted = new Intl.NumberFormat(language).format(12345.6);
    assert.ok(i18n.t('quota.observedCalls', { count: 12345.6 }).includes(formatted));
    assert.ok(i18n.t('settings.event', { event: '<img src=x>{count}' }).includes('<img src=x>{count}'));
    assert.ok(i18n.t('quota.wait').includes('{seconds}'));
    assert.ok(i18n.t('quota.wait', Object.create({ seconds: 1 })).includes('{seconds}'));
    assert.ok(i18n.t('quota.wait', { seconds: { toString() { throw Error(); } } }).includes('{seconds}'));
    assert.equal(i18n.formatNumber(12345.6), formatted);
    const date = new Date('2026-09-05T12:00:00Z');
    const options = { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' };
    assert.equal(i18n.formatDate(date, options), new Intl.DateTimeFormat(language, options).format(date));
  }
});

test('browser loader fetches fixed local assets with injected fetch and sanitizes failures', async () => {
  const calls = [];
  const i18n = await loadI18n({ languages: ['ja-JP'], fetch: async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => JSON.parse(await readFile(url, 'utf8')) };
  } });
  assert.equal(i18n.language, 'ja');
  assert.equal(i18n.t('common.start'), dictionaries.ja['common.start']);
  assert.equal(calls.length, 3);
  for (const [url, options] of calls) {
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(options.credentials, 'omit');
  }
  for (const fetch of [async () => { throw Error('SYNTHETIC_PRIVATE_VALUE'); },
    async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw Error('PRIVATE_BODY'); } })]) {
    await assert.rejects(loadI18n({ fetch }), (error) => {
      assert.equal(error.message, 'I18N_LOAD_FAILED');
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
      return true;
    });
  }
});

test('import works without DOM, storage, or network side effects', () => {
  const url = new URL('../app/i18n/index.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    for (const key of ['window', 'document', 'navigator', 'localStorage', 'fetch']) {
      Object.defineProperty(globalThis, key, { get() { throw new Error('UNEXPECTED_GLOBAL_ACCESS'); } });
    }
    await import(${JSON.stringify(url)});
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('dictionary checker rejects missing, extra, blank, nested and mismatched placeholder entries', () => {
  for (const [mutate, code] of [
    [(d) => { delete d.ja['seq.translate']; }, 'I18N_KEY_MISMATCH'],
    [(d) => { d.ko['extra.key'] = 'extra'; }, 'I18N_KEY_MISMATCH'],
    [(d) => { d.en['common.start'] = ' '; }, 'I18N_INVALID_ENTRY'],
    [(d) => { d.ko['common.start'] = {}; }, 'I18N_INVALID_ENTRY'],
    [(d) => { d.ja['quota.wait'] = '{minutes}'; }, 'I18N_PLACEHOLDER_MISMATCH'],
    [(d) => { for (const value of Object.values(d)) delete value['error.TIMEOUT']; }, 'I18N_MISSING_ERROR'],
  ]) {
    const altered = structuredClone(dictionaries);
    mutate(altered);
    assert.ok(validateDictionaries(altered).includes(code), code);
  }
  assert.deepEqual(validateDictionaries({ en: [] }), ['I18N_INVALID_DICTIONARY']);
});

test('source checker catches absent literal UI keys and common hardcoded DOM text', () => {
  for (const source of ["i18n.t('missing.key')", 't("missing.key")',
    '<button data-i18n="missing.key"></button>', "{ label: 'missing.key' }",
    "{ terms: { notice: 'missing.key' } }"]) {
    assert.ok(checkSource(source, dictionaries.en).includes('I18N_UNKNOWN_UI_KEY'));
  }
  for (const source of ["button.textContent = 'Start'", 'input.placeholder = "Enter text"',
    "document.createTextNode('Hello')", 'button.innerHTML = `<b>Start</b>`']) {
    assert.ok(checkSource(source, dictionaries.en).includes('I18N_LITERAL_UI_TEXT'));
  }
  assert.ok(checkSource('<button>Start</button>', dictionaries.en, { html: true }).includes('I18N_LITERAL_UI_TEXT'));
  assert.ok(checkSource('<input aria-label="Input">', dictionaries.en, { html: true }).includes('I18N_LITERAL_UI_TEXT'));
  assert.deepEqual(checkSource("button.textContent = i18n.t('common.start'); other.textContent = '';", dictionaries.en), []);
  assert.deepEqual(checkSource('<button data-i18n="common.start"></button>', dictionaries.en, { html: true }), []);
});

test('checker scans repository and fails on invalid fixture UI and malformed JSON', async (t) => {
  assert.equal((await checkI18n()).ok, true);
  const root = await mkdtemp(join(tmpdir(), 'interp-i18n-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app/i18n'), { recursive: true });
  await mkdir(join(root, 'app/ui'), { recursive: true });
  for (const language of SUPPORTED_LANGUAGES) {
    await writeFile(join(root, `app/i18n/${language}.json`), JSON.stringify(dictionaries[language]));
  }
  await writeFile(join(root, 'app/ui/view.js'), "element.textContent = t('missing.key');");
  assert.equal((await checkI18n({ root })).ok, false);
  await writeFile(join(root, 'app/ui/view.js'), "element.textContent = t('seq.translate');");
  assert.equal((await checkI18n({ root })).ok, true);
  await writeFile(join(root, 'index.html'), '<button>Start</button>');
  assert.equal((await checkI18n({ root })).ok, false);
  await writeFile(join(root, 'app/i18n/ja.json'), '{PRIVATE_BODY');
  assert.deepEqual(await checkI18n({ root }), { ok: false, issues: ['I18N_CHECK_FAILED'] });
});

test('checker CLI succeeds independently of working directory', () => {
  const script = fileURLToPath(new URL('../scripts/check-i18n.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^I18N_OK languages=3 keys=\d+ files=\d+\n$/);
});

// P2 contracts are checked against the actual engine vocabulary, not key counts.
const { LISTEN_STATUS, OUTPUT_STATUS, BROADCAST_STATUS } = await import('../app/engine/listen-state.js');
const { GAP_CAUSES } = await import('../app/engine/caption-store.js');
const { ProviderError } = await import('../app/providers/contract.js');
const { listenStatusKey, outputStatusKey, broadcastStatusKey, gapKey, hubReasonKey,
  listenErrorKey, errorCodeKey, errorKey, turnKey, resolveKey } = await import('../app/ui/errors.js');

test('P2 machine states, gaps and normalized hub reasons resolve in every language', () => {
  const reasons = ['broadcast-error', 'time-limit', 'stopped', 'room-closed', 'outside',
    'denied', 'language-removed', 'language-changed'];
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    for (const [values, map] of [[LISTEN_STATUS, listenStatusKey], [OUTPUT_STATUS, outputStatusKey],
      [BROADCAST_STATUS, broadcastStatusKey], [GAP_CAUSES, gapKey], [reasons, hubReasonKey]]) {
      for (const value of values) {
        const key = map(value);
        assert.notEqual(key, 'error.unknown', value);
        assert.ok(Object.hasOwn(dictionaries[language], key), `${language}: ${key}`);
        assert.equal(resolveKey(i18n, key), key);
        assert.equal(i18n.t(key), dictionaries[language][key]);
      }
      for (const invalid of ['__proto__', 'constructor', 'PRIVATE_PROVIDER_TEXT', null, 429, {}]) {
        assert.equal(map(invalid), 'error.unknown');
      }
    }
    assert.equal(i18n.t(listenStatusKey('running')), i18n.t('connection.connected'));
    assert.notEqual(i18n.t(listenStatusKey('running')), i18n.t('seq.completed'));
    assert.notEqual(i18n.t(broadcastStatusKey('unknown')), i18n.t(broadcastStatusKey('receiving')));
    assert.notEqual(i18n.t(gapKey('audio')), i18n.t(gapKey('reception')));
  }
});

test('P2 screen and measurement guidance exists without relying on English fallback', () => {
  const required = [
    'sim.listenMode', 'sim.direct', 'sim.hub', 'sim.restart', 'sim.sourceAuto', 'sim.headphones',
    'sim.seatAudio', 'sim.personalKey', 'sim.liveVoice', 'sim.enableSound', 'sim.mute',
    'sim.settingsChanged', 'sim.manualResume', 'sim.sequentialFallback', 'sim.busy', 'sim.audioCut',
    ...['partial', 'final', 'interrupted', 'recent', 'latest', 'empty', 'showSource'].map(k => `sim.captions.${k}`),
    ...['venue', 'roomCode', 'roomCodePlaceholder', 'join', 'leave', 'reconnect', 'noKeyOrMicrophone',
      'deviceSpeech', 'recentNotice', 'resumeSound', 'unregistered', 'languageUnavailable'].map(k => `hub.${k}`),
    'voice.devicePrivacy', 'voice.deviceUnavailable',
    ...['hub', 'liveScope', 'connectionOnly', 'metrics', 'notMeasured', 'unsupported', 'metricsPrivacy',
      'timingBoundary', 'policyBudget', 'setupMs', 'reconnects', 'recoveryMs', 'closeFailures',
      'inputSampleRate', 'sentFrames', 'inputQueueMax', 'droppedInputMs', 'firstPartialMs', 'firstFinalMs',
      'revisions', 'duplicates', 'interrupted', 'possibleGaps', 'firstAudioReceivedMs',
      'firstAudioScheduledMs', 'queueP50Ms', 'queueP95Ms', 'queueMaxMs', 'delayedMs', 'droppedAudioMs',
      'ttsFirstRequestMs', 'ttsFirstStartMs', 'ttsWaitMs', 'skippedSentences', 'speechFailures']
      .map(k => `diagnostics.${k}`),
  ];
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of required) assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
  }
});

test('actual app message literals, including audio and engine notices, have translations', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../app/', import.meta.url), { recursive: true });
  for (const file of files.filter(file => file.endsWith('.js'))) {
    const source = await readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
    // Includes messageKey/return values missed by the UI-only static checker.
    for (const [, key] of source.matchAll(/['"]((?:error|voice|sim|hub|diagnostics|connection|seq|settings|notice|mode)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)['"]/g)) {
      for (const language of SUPPORTED_LANGUAGES) {
        assert.ok(Object.hasOwn(dictionaries[language], key), `${file}: ${language}: ${key}`);
      }
    }
  }
});

test('numeric error codes survive P1 and P2 mapping while malformed and unknown codes stay safe', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    const expected = dictionaries[language]['error.UNKNOWN_429'];
    for (const key of [errorKey(new ProviderError('UNKNOWN_429')), errorCodeKey('UNKNOWN_429'),
      turnKey({ phase: 'error', errorCode: 'UNKNOWN_429' }),
      listenErrorKey({ mode: 'direct', errorCode: 'UNKNOWN_429' }),
      listenErrorKey({ mode: 'hub', errorCode: 'UNKNOWN_429' })]) {
      assert.equal(key, 'error.UNKNOWN_429');
      assert.equal(i18n.t(resolveKey(i18n, key)), expected);
    }
    assert.equal(i18n.error('UNKNOWN_429'), expected);
    for (const invalid of ['429_UNKNOWN', 'unknown_429', 'UNKNOWN 429', 'UNKNOWN_429\n',
      'UNKNOWN/429', 'A'.repeat(41), null, {}, 'UNREGISTERED_429']) {
      assert.equal(resolveKey(i18n, errorCodeKey(invalid)), 'error.unknown');
    }
  }
});

test('P2 broadcast errors discard provider detail and never interpolate raw fields', () => {
  const secret = 'SYNTHETIC PRIVATE PROVIDER TEXT';
  const snapshot = { mode: 'hub', reason: 'broadcast-error', errorCode: 'UNAVAILABLE' };
  for (const field of ['detail', 'message', 'messageKey', 'cause', 'url']) {
    Object.defineProperty(snapshot, field, { get() { throw new Error(secret); } });
  }
  assert.equal(listenErrorKey(snapshot), 'hub.broadcastError');
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    assert.equal(i18n.t(listenErrorKey(snapshot)), dictionaries[language]['hub.broadcastError']);
    for (const [key, value] of Object.entries(dictionaries[language])) {
      if (/^(error|sim|hub|diagnostics)\./.test(key)) {
        assert.doesNotMatch(value, /\{(?:detail|message|reason|error|url|key|roomCode|text)\}/);
        assert.equal(i18n.t(key, { detail: secret, message: secret, reason: secret, error: secret }), value);
      }
    }
    assert.equal(i18n.error(snapshot), dictionaries[language]['error.unknown']);
    assert.equal(i18n.t(hubReasonKey(secret)), dictionaries[language]['error.unknown']);
  }
});

// P3-02 (design-p3 §1.2, §1.5–1.8, architecture.md "P3-01 P3 공통 인터페이스와 경계"):
// policy, lock, notice, admin console, event and hub-control strings. The
// enumerations below are the explicit list of dynamically composed keys that
// later tasks (policy runtime, resolve, admin editor, hub control) may build
// with template strings; P3-32 registers the same lists in check-i18n.

// PolicyError codes thrown by app/policy/runtime.js (P3-07); not ERROR_CODES.
const POLICY_ERROR_CODES = Object.freeze(['POLICY_LOADING', 'POLICY_UNAVAILABLE', 'POLICY_EXPIRED',
  'POLICY_STOPPED', 'POLICY_FEATURE_DISABLED', 'APP_VERSION_TOO_OLD', 'EVENT_ENDED',
  'HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST']);

// prefix -> values; `exact` means the dictionary has no other keys under that prefix.
const P3_DYNAMIC_KEYS = Object.freeze([
  { prefix: 'policy.status', values: ['loading', 'ready', 'stale', 'failed', 'expired'], exact: true },
  { prefix: 'policy.source', values: ['personal', 'policyDefault', 'forced', 'appDefault'], exact: true },
  { prefix: 'policy.notice.severity', values: ['info', 'warning', 'critical'], exact: true },
  { prefix: 'hubControl', values: ['supported', 'unsupported', 'stopped', 'lost'], exact: false },
  { prefix: 'event.status', values: ['upcoming', 'active', 'expired', 'disabled', 'removed'], exact: true },
  { prefix: 'admin.current.status', values: ['notLoaded', 'loading', 'loaded', 'failed'], exact: true },
  { prefix: 'admin.feature', values: ['sequential', 'simultaneousDirect', 'hubListen', 'diagnostics',
    'sharedKeys', 'rememberPersonalKey'], exact: true },
  { prefix: 'admin.setting', values: ['ui.mode', 'ui.tone', 'ui.text', 'captions.size',
    'interpretation.sourceLanguage', 'interpretation.targetLanguage', 'voice.output', 'billing.plan'], exact: true },
  { prefix: 'admin.issue', values: ['POLICY_SCHEMA', 'POLICY_FIELD', 'POLICY_RANGE', 'POLICY_TEXT',
    'POLICY_REFERENCE', 'POLICY_CONFLICT', 'POLICY_UNKNOWN_KEY', 'POLICY_TOO_LARGE', 'unknown'], exact: true },
]);

const P3_PREFIXES = /^(?:policy|admin|event|hubControl)\./;

test('P3 policy runtime codes resolve through the existing error path in every language', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    for (const code of POLICY_ERROR_CODES) {
      const key = `error.${code}`;
      assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
      assert.equal(errorCodeKey(code), key);
      assert.equal(resolveKey(i18n, errorCodeKey(code)), key);
      assert.equal(i18n.error(code), dictionaries[language][key]);
      assert.notEqual(i18n.error(code), dictionaries[language]['error.unknown'], code);
    }
    // Distinct situations must not collapse into one sentence.
    assert.equal(new Set(POLICY_ERROR_CODES.map(code => i18n.error(code))).size, POLICY_ERROR_CODES.length);
  }
});

test('P3 dynamic enumeration keys exist in every language and exact prefixes have no strays', () => {
  for (const { prefix, values, exact } of P3_DYNAMIC_KEYS) {
    const expected = values.map(value => `${prefix}.${value}`);
    for (const language of SUPPORTED_LANGUAGES) {
      const i18n = createI18n({ dictionaries, language });
      for (const key of expected) {
        assert.ok(Object.hasOwn(dictionaries[language], key), `${language}: ${key}`);
        assert.equal(resolveKey(i18n, key), key);
        assert.equal(i18n.t(key), dictionaries[language][key]);
      }
      assert.equal(new Set(expected.map(key => i18n.t(key))).size, expected.length, `${language}: ${prefix}`);
      if (exact) {
        const present = Object.keys(dictionaries[language]).filter(key => key.startsWith(`${prefix}.`)).sort();
        assert.deepEqual(present, [...expected].sort(), `${language}: ${prefix}`);
      }
    }
    // Unknown or hostile values must not resolve to a real key.
    const i18n = createI18n({ dictionaries, language: 'en' });
    for (const invalid of ['__proto__', 'constructor', 'PRIVATE_VALUE', 'x y']) {
      assert.equal(resolveKey(i18n, `${prefix}.${invalid}`), 'error.unknown');
    }
  }
});

test('P3 policy, lock, notice, event, hub-control and admin console strings exist without English fallback', () => {
  const required = [
    ...['label', 'forced', 'restricted', 'singleOption', 'reason', 'restored', 'uiLanguage'].map(k => `policy.lock.${k}`),
    ...['title', 'revision', 'recheck', 'settingsAvailable', 'updateHint', 'persistent', 'reasonLabel', 'noAutoStart']
      .map(k => `policy.blocked.${k}`),
    ...['stopped', 'updated', 'reopened', 'display', 'pricing'].map(k => `policy.changed.${k}`),
    ...['title', 'hub', 'empty', 'dismiss', 'period'].map(k => `policy.notice.${k}`),
    ...['title', 'description', 'revision', 'publishedAt', 'validUntil', 'noExpiry', 'minAppVersion', 'appVersion',
      'fetchedAt', 'recheck', 'staleHint', 'notPersisted', 'none', 'propagation', 'emergencyReason', 'featureOff']
      .map(k => `policy.${k}`),
    ...['title', 'revision', 'controlOnly', 'releaseOnly', 'scope', 'unsupportedHint'].map(k => `hubControl.${k}`),
    ...['title', 'name', 'select', 'join', 'leave', 'joined', 'left', 'none', 'startsAt', 'expiresAt', 'capabilities',
      'enabledNote', 'noLive', 'payloadMismatch', 'idNotSignature', 'applies'].map(k => `event.${k}`),
    ...['title', 'scope', 'noSecrets', 'notApplied', 'notSecurityBoundary'].map(k => `admin.${k}`),
    // §1.7 screen order (eight sections) and §1.2 button names (seven actions).
    ...['current', 'control', 'settings', 'events', 'pricing', 'validation', 'export', 'payload'].map(k => `admin.section.${k}`),
    ...['load', 'import', 'validate', 'preview', 'download', 'copy', 'publishSteps', 'addNotice', 'addEvent', 'addRate',
      'remove', 'discard', 'generate', 'clear'].map(k => `admin.action.${k}`),
    ...['source', 'loadedRevision'].map(k => `admin.current.${k}`),
    ...['revision', 'publishedAt', 'validUntil', 'minAppVersion', 'emergencyStopped', 'emergencyReason', 'features',
      'notices', 'noticeId', 'severity', 'showFrom', 'showUntil', 'text', 'default', 'allowed', 'locked', 'min', 'max',
      'step', 'eventId', 'providerId', 'eventName', 'label', 'startsAt', 'expiresAt', 'enabled', 'allowedCapabilities',
      'hubEnabled', 'allowedHubIds', 'allowDirectSubscription', 'pricingRevision', 'updatedAt', 'currency',
      'allowLocalOverride', 'model', 'capability', 'unit', 'amount', 'basis', 'confidence', 'estimated']
      .map(k => `admin.field.${k}`),
    ...['title', 'none', 'count', 'path'].map(k => `admin.validation.${k}`),
    ...['placeholder', 'invalidJson', 'tooLarge', 'loaded', 'sameValidator'].map(k => `admin.import.${k}`),
    ...['title', 'noBase', 'noChanges', 'changed', 'locked', 'unlocked', 'disabled', 'enabled', 'added', 'removed',
      'before', 'after', 'nextRevision', 'revisionRequired', 'stopsWork'].map(k => `admin.preview.${k}`),
    ...['blocked', 'downloaded', 'copied', 'copyFailed', 'manual', 'notPublished'].map(k => `admin.export.${k}`),
    ...['title', 'step1', 'step2', 'step3', 'step4', 'noConfirmation', 'rollback', 'propagation', 'keyRevoke']
      .map(k => `admin.publish.${k}`),
    ...['event', 'noActiveEvent', 'key', 'keyPlaceholder', 'expiresAt', 'expiresAfterEvent', 'result', 'copy', 'copied',
      'copyFailed', 'tooLong', 'noAutoNavigate', 'noQr', 'memoryOnly', 'cleared', 'separate', 'version']
      .map(k => `admin.payload.${k}`),
    ...['estimateOnly', 'empty', 'basisActiveMinute'].map(k => `admin.pricing.${k}`),
    'admin.events.empty', 'admin.events.noSecrets', 'admin.notices.empty',
    'admin.control.emergencyHint', 'admin.control.featureHint', 'admin.settings.lockedHint',
  ];
  assert.equal(new Set(required).size, required.length);
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of required) assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
  }
  // Every P3-02 key is either enumerated above or in the dynamic lists: no silent additions.
  const dynamic = P3_DYNAMIC_KEYS.flatMap(({ prefix, values }) => values.map(value => `${prefix}.${value}`));
  const covered = new Set([...required, ...dynamic]);
  for (const key of Object.keys(dictionaries.en).filter(key => P3_PREFIXES.test(key))) {
    assert.ok(covered.has(key), `unlisted P3 key: ${key}`);
  }
});

test('P3 admin and policy strings are translated per language, not hardcoded Korean', () => {
  const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;
  const kana = /[぀-ヿ]/;
  const cjk = /[一-鿿]/;
  const keys = Object.keys(dictionaries.en).filter(key => P3_PREFIXES.test(key)
    || POLICY_ERROR_CODES.some(code => key === `error.${code}`));
  assert.ok(keys.length >= 200, `P3 keys: ${keys.length}`);
  for (const key of keys) {
    assert.doesNotMatch(dictionaries.en[key], hangul, `en hardcoded Korean: ${key}`);
    assert.doesNotMatch(dictionaries.en[key], kana, `en hardcoded Japanese: ${key}`);
    assert.doesNotMatch(dictionaries.en[key], cjk, `en hardcoded CJK: ${key}`);
    assert.doesNotMatch(dictionaries.ja[key], hangul, `ja hardcoded Korean: ${key}`);
    assert.doesNotMatch(dictionaries.ko[key], kana, `ko hardcoded Japanese: ${key}`);
  }
  // Untranslated copies between languages are only acceptable for bare identifiers.
  const identifiers = new Set(['admin.field.revision']);
  for (const key of keys) {
    if (identifiers.has(key)) continue;
    assert.notEqual(dictionaries.ko[key], dictionaries.en[key], `ko copies en: ${key}`);
    assert.notEqual(dictionaries.ja[key], dictionaries.en[key], `ja copies en: ${key}`);
    assert.notEqual(dictionaries.ko[key], dictionaries.ja[key], `ko copies ja: ${key}`);
  }
});

test('P3 strings interpolate only public display values and never embed secrets or URLs', () => {
  const allowedPlaceholders = new Set(['revision', 'count', 'path']);
  const forbidden = /\{(?:detail|message|reason|error|url|key|roomCode|text|token|payload|secret|apiKey)\}/;
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    for (const [key, value] of Object.entries(dictionaries[language])) {
      if (!P3_PREFIXES.test(key) && !POLICY_ERROR_CODES.some(code => key === `error.${code}`)) continue;
      assert.doesNotMatch(value, forbidden, `${language}: ${key}`);
      assert.doesNotMatch(value, /https?:\/\//, `${language}: ${key}`);
      assert.doesNotMatch(value, /<[a-z!/]/i, `${language}: ${key}`);
      for (const [, name] of value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
        assert.ok(allowedPlaceholders.has(name), `${language}: ${key} {${name}}`);
      }
      const secret = 'SYNTHETIC PRIVATE VALUE';
      assert.equal(i18n.t(key, { key: secret, reason: secret, detail: secret, url: secret }), value);
    }
    assert.ok(i18n.t('policy.blocked.revision', { revision: 12 }).includes(i18n.formatNumber(12)));
    assert.ok(i18n.t('admin.validation.path', { path: 'settings.ui.tone.default' }).includes('settings.ui.tone.default'));
  }
});

// P3-03 (design-p3 §1.10, §1.12–1.14, DESIGN.md §10, architecture.md "i18n 키 접두사"):
// display, key guidance, microphone permission, audio devices, plan/usage and
// settings section strings. Enumerations mirror REGISTERED_SETTINGS values,
// the permission/usage snapshots and the ten settings sections.
const { REGISTERED_SETTINGS } = await import('../app/policy/schema.js');

const SETTINGS_SECTIONS = Object.freeze(['display', 'interpretation', 'provider', 'sharedKey', 'billing',
  'audio', 'diagnostics', 'records', 'app', 'terms']);

const P3_03_DYNAMIC_KEYS = Object.freeze([
  { prefix: 'display.mode', values: REGISTERED_SETTINGS['ui.mode'].values, exact: true },
  { prefix: 'display.tone', values: REGISTERED_SETTINGS['ui.tone'].values, exact: true },
  { prefix: 'display.text', values: REGISTERED_SETTINGS['ui.text'].values, exact: true },
  { prefix: 'keyGuide.saved', values: ['browser', 'session', 'none', 'failed'], exact: true },
  { prefix: 'permission', values: ['granted', 'denied', 'prompt', 'unsupported', 'noDevice', 'busy'], exact: false },
  { prefix: 'permission.help', values: ['ios', 'android', 'desktop'], exact: false },
  { prefix: 'billing.plan', values: REGISTERED_SETTINGS['billing.plan'].values, exact: true },
  { prefix: 'billing.estimate', values: ['unavailable', 'partial', 'complete'], exact: true },
  { prefix: 'billing.rateSource', values: ['policy', 'personal'], exact: true },
  { prefix: 'billing.basis', values: ['activeMinuteEstimate'], exact: true },
  { prefix: 'settings.section', values: SETTINGS_SECTIONS, exact: true },
  { prefix: 'settings.sectionHint', values: SETTINGS_SECTIONS, exact: true },
]);

const P3_03_PREFIXES = /^(?:display|keyGuide|permission|device|billing)\.|^settings\.section(?:Hint)?\./;

test('P3-03 display, key guidance, permission, device and billing enumerations resolve in every language', () => {
  assert.deepEqual(REGISTERED_SETTINGS['ui.mode'].values, ['system', 'light', 'dark']);
  assert.deepEqual(REGISTERED_SETTINGS['ui.tone'].values, ['navy', 'warm', 'forest', 'mono']);
  assert.deepEqual(REGISTERED_SETTINGS['ui.text'].values, ['s', 'm', 'l', 'xl']);
  assert.deepEqual(REGISTERED_SETTINGS['billing.plan'].values, ['free', 'paid']);
  for (const { prefix, values, exact } of P3_03_DYNAMIC_KEYS) {
    const expected = values.map(value => `${prefix}.${value}`);
    for (const language of SUPPORTED_LANGUAGES) {
      const i18n = createI18n({ dictionaries, language });
      for (const key of expected) {
        assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
        assert.equal(resolveKey(i18n, key), key);
        assert.equal(i18n.t(key), dictionaries[language][key]);
      }
      assert.equal(new Set(expected.map(key => i18n.t(key))).size, expected.length, `${language}: ${prefix}`);
      if (exact) {
        const present = Object.keys(dictionaries[language]).filter(key => key.startsWith(`${prefix}.`)).sort();
        assert.deepEqual(present, [...expected].sort(), `${language}: ${prefix}`);
      }
    }
    const i18n = createI18n({ dictionaries, language: 'en' });
    for (const invalid of ['__proto__', 'constructor', 'PRIVATE_VALUE', 'x y', 'default']) {
      assert.equal(resolveKey(i18n, `${prefix}.${invalid}`), 'error.unknown');
    }
  }
  // Permission states are distinct situations (§1.14): busy/noDevice are not denial.
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    assert.notEqual(i18n.t('permission.busy'), i18n.t('permission.denied'));
    assert.notEqual(i18n.t('permission.noDevice'), i18n.t('permission.denied'));
    assert.notEqual(i18n.t('permission.unsupported'), i18n.t('permission.prompt'));
  }
});

test('P3-03 display, key guidance, permission, device, billing and section strings exist without English fallback', () => {
  const required = [
    ...['open', 'title', 'mode', 'tone', 'text', 'preview', 'previewSample', 'systemHint', 'monoHint', 'textHint',
      'savedOnDevice'].map(k => `display.${k}`),
    ...['size', 'smaller', 'larger', 'value', 'hint', 'range'].map(k => `display.captions.${k}`),
    ...['title', 'step1', 'step2', 'step3', 'freeNote', 'notAllFree', 'createLink', 'usageLink', 'billingLink',
      'newTab', 'restriction', 'restrictionWhy', 'show', 'hide', 'showHint', 'noRefill', 'clearedAfterSave',
      'sharedNotShown', 'emptyDirect', 'firstRun', 'openSettings'].map(k => `keyGuide.${k}`),
    ...['title', 'checking', 'request', 'gestureOnly', 'noAutoRetry', 'notNeededHere', 'unsupportedHint', 'busyHint',
      'noDeviceHint', 'notEvidence', 'help.title', 'help.menuVaries'].map(k => `permission.${k}`),
    ...['input', 'output', 'systemDefault', 'unlabeled', 'labelsAfterPermission', 'refresh', 'refreshed', 'disappeared',
      'inputAppliesNextStart', 'outputPcmOnly', 'outputUnsupported', 'outputPermission', 'deviceSpeechSystemOutput',
      'localOnly', 'listIncomplete', 'none',
      // P3-28: what actually happened to an output choice, so the UI never
      // shows a success line before the browser confirmed the switch.
      'outputApplying', 'outputApplied'].map(k => `device.${k}`),
    ...['title', 'planLabel', 'displayOnly', 'mayDiffer', 'perProvider', 'keyChanged', 'freeShowsTime', 'paidShowsCost',
      'usageTime', 'usageMinutes', 'usageHint', 'byCapability', 'estimatedCost', 'estimateAlways', 'formula', 'scope',
      'rates', 'perMinute', 'rateSource', 'ratesRevision', 'verifiedAt', 'rateMissing', 'rateMissingHint', 'notZero',
      'hubExcluded', 'sharedExcluded', 'rateFixed', 'noDoubleCount', 'localRate', 'localRateHint', 'tokenNotIncluded']
      .map(k => `billing.${k}`),
  ];
  assert.equal(new Set(required).size, required.length);
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of required) assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
  }
  // Every P3-03 key is enumerated here or in the dynamic lists: no silent additions.
  const dynamic = P3_03_DYNAMIC_KEYS.flatMap(({ prefix, values }) => values.map(value => `${prefix}.${value}`));
  const covered = new Set([...required, ...dynamic]);
  for (const key of Object.keys(dictionaries.en).filter(key => P3_03_PREFIXES.test(key))) {
    assert.ok(covered.has(key), `unlisted P3-03 key: ${key}`);
  }
  // The P3-02 admin labels stay separate from the user-facing section titles.
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of Object.keys(dictionaries.en).filter(key => P3_PREFIXES.test(key))) {
      assert.equal(P3_03_PREFIXES.test(key), false, key);
    }
  }
});

test('P3-03 key guidance follows the fixed three steps and never promises free interpretation for every model', () => {
  // design-p3 §1.12 fixed wording (three steps and the free-key note).
  const steps = {
    ko: ['Google 계정으로 로그인', '“API 키 만들기” 선택', '키를 복사해 이곳에 붙여넣기'],
    en: ['Sign in with Google', 'Select “Create API key”', 'Copy the key and paste it here'],
    ja: ['Google アカウントでログイン', '「API キーを作成」を選択', 'キーをコピーしてここに貼り付け'],
  };
  const freeNote = {
    ko: '키 발급은 무료이며 결제 등록 없이 시작할 수 있어요. 모델별 무료 제공 여부와 한도는 다릅니다.',
    en: 'Creating a key is free, and you can get started without setting up billing. Free access and limits vary by model.',
    ja: 'キーは無料で作成でき、支払い情報を登録せずに始められます。無料で使えるモデルや利用上限は異なります。',
  };
  const model = { ko: /모델/, en: /model/i, ja: /モデル/ };
  const everyModelFree = { ko: /모든 (통역 )?모델[을이]? 무료로 (쓸|사용할) 수 있어요/, en: /all models are free/i, ja: /すべてのモデル(を|が)無料で使えます/ };
  for (const language of SUPPORTED_LANGUAGES) {
    const d = dictionaries[language];
    assert.deepEqual([d['keyGuide.step1'], d['keyGuide.step2'], d['keyGuide.step3']], steps[language]);
    assert.equal(d['keyGuide.freeNote'], freeNote[language]);
    for (const key of ['keyGuide.freeNote', 'keyGuide.notAllFree']) {
      assert.match(d[key], model[language], `${language}: ${key}`);
      assert.doesNotMatch(d[key], everyModelFree[language], `${language}: ${key}`);
    }
    // Restriction is a required check, and the new-tab hint is a separate accessibility string.
    assert.match(d['keyGuide.restriction'], /Gemini API/);
    assert.ok(d['keyGuide.newTab'].trim());
    // Saved-state wording is stated only for the actual outcome (§1.12).
    assert.notEqual(d['keyGuide.saved.browser'], d['keyGuide.saved.session']);
    assert.notEqual(d['keyGuide.saved.failed'], d['keyGuide.saved.browser']);
    // Plan display is a display setting only; Free and Paid stay distinct labels.
    assert.notEqual(d['billing.plan.free'], d['billing.plan.paid']);
    assert.notEqual(d['billing.estimate.unavailable'], d['billing.estimate.complete']);
    assert.notEqual(d['billing.estimate.partial'], d['billing.estimate.complete']);
  }
});

test('P3-03 strings are translated per language and interpolate only public display values', () => {
  const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;
  const kana = /[぀-ヿ]/;
  const cjk = /[一-鿿]/;
  const keys = Object.keys(dictionaries.en).filter(key => P3_03_PREFIXES.test(key));
  assert.ok(keys.length >= 140, `P3-03 keys: ${keys.length}`);
  // Untranslated copies are acceptable only for unit-like identifiers.
  const identifiers = new Set(['display.captions.value']);
  for (const key of keys) {
    assert.doesNotMatch(dictionaries.en[key], hangul, `en hardcoded Korean: ${key}`);
    assert.doesNotMatch(dictionaries.en[key], kana, `en hardcoded Japanese: ${key}`);
    assert.doesNotMatch(dictionaries.en[key], cjk, `en hardcoded CJK: ${key}`);
    assert.doesNotMatch(dictionaries.ja[key], hangul, `ja hardcoded Korean: ${key}`);
    assert.doesNotMatch(dictionaries.ko[key], kana, `ko hardcoded Japanese: ${key}`);
    if (identifiers.has(key)) continue;
    assert.notEqual(dictionaries.ko[key], dictionaries.en[key], `ko copies en: ${key}`);
    assert.notEqual(dictionaries.ja[key], dictionaries.en[key], `ja copies en: ${key}`);
    assert.notEqual(dictionaries.ko[key], dictionaries.ja[key], `ko copies ja: ${key}`);
  }
  const allowedPlaceholders = new Set(['minutes', 'amount', 'date', 'revision', 'size']);
  const forbidden = /\{(?:detail|message|reason|error|url|key|roomCode|text|token|payload|secret|apiKey|deviceId|label)\}/;
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n({ dictionaries, language });
    for (const key of keys) {
      const value = dictionaries[language][key];
      assert.doesNotMatch(value, forbidden, `${language}: ${key}`);
      assert.doesNotMatch(value, /https?:\/\//, `${language}: ${key}`);
      assert.doesNotMatch(value, /<[a-z!/]/i, `${language}: ${key}`);
      for (const [, name] of value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
        assert.ok(allowedPlaceholders.has(name), `${language}: ${key} {${name}}`);
      }
      const secret = 'SYNTHETIC PRIVATE VALUE';
      assert.equal(i18n.t(key, { key: secret, deviceId: secret, label: secret, url: secret }), value);
    }
    assert.ok(i18n.t('billing.usageMinutes', { minutes: 1234.5 }).includes(i18n.formatNumber(1234.5)));
    assert.ok(i18n.t('billing.perMinute', { amount: 'US$0.10' }).includes('US$0.10'));
    assert.ok(i18n.t('billing.verifiedAt', { date: '2026-09-06' }).includes('2026-09-06'));
    assert.ok(i18n.t('display.captions.value', { size: 1.5 }).includes(i18n.formatNumber(1.5)));
  }
});
