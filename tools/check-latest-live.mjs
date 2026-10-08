// Is DEFAULT_LIVE_MODEL still the newest GENERAL Google Live model? (owner, 2026-10-08: "항상 최신이 될수 있도록")
//
//   node tools/check-latest-live.mjs [--key-file <path>]
//
// One free GET of the provider's model list (paged, pageSize=1000) with the first key of the key file (default
// ~/.config/interp-app/builtin-key; the key travels in a header and is never printed). Exit code: 0 = the default is the newest
// general Live model, 1 = a newer one exists (change DEFAULT_LIVE_MODEL, see docs/extension.md §23), 2 = it could not be checked.
//
// "General Live model" is a strict id rule on purpose: `gemini-<major>.<minor>-live` and nothing else. Previews, the extended-thinking
// variant, translation, transcription, native-audio and robotics models also report bidiGenerateContent, but none of them is a
// drop-in replacement for the default, so none of them may ever make this check say "newer". Versions compare as NUMBERS (3.10 > 3.8).
// The pure functions are exported for tests/latest-live-check.test.mjs; they touch no network, file or global.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIVE_MODEL } from '../app/providers/gemini/live-config.js';
import {
  GENERAL_LIVE_ID, LIVE_METHOD, compareGeneralLive, listLiveModelIds as listLive, newestGeneralLive, verdictOf as verdict,
  versionOfGeneralLive,
} from '../extension/lib/latest-live.js';

// The rules live in ONE place, extension/lib/latest-live.js, which the extension itself runs (0.5.2: the lane follows the latest
// general Live model by itself). This tool only adds what a command line needs: the global fetch, a timeout and the default.
export { GENERAL_LIVE_ID, LIVE_METHOD, compareGeneralLive, newestGeneralLive, versionOfGeneralLive };
export const verdictOf = ({ current = DEFAULT_LIVE_MODEL, liveIds = [] } = {}) => verdict({ current, liveIds });
export const listLiveModelIds = (options = {}) => listLive({ fetch: globalThis.fetch, signal: AbortSignal.timeout(60000), ...options });

async function main(argv) {
  const at = argv.indexOf('--key-file');
  const keyFile = at >= 0 ? argv[at + 1] : `${homedir()}/.config/interp-app/builtin-key`;
  let key;
  try {
    const lines = (await readFile(keyFile, 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
    key = lines[0];
  } catch { console.log('LATEST_LIVE_UNCHECKED KEY_FILE_UNREADABLE'); return 2; }
  let liveIds;
  try { liveIds = await listLiveModelIds({ key }); } catch (error) { console.log(`LATEST_LIVE_UNCHECKED ${error.code ?? 'ERROR'}`); return 2; }
  const verdict = verdictOf({ liveIds });
  const general = liveIds.filter((id) => versionOfGeneralLive(id) !== null);
  console.log(`LATEST_LIVE ${verdict.status} default=${verdict.current} newest=${verdict.newest ?? 'none'} liveModels=${liveIds.length} generalLiveModels=${general.join(',') || 'none'}`);
  if (verdict.status === 'newer') console.log(`NEXT: set DEFAULT_LIVE_MODEL to ${verdict.newest} in app/providers/gemini/live-config.js (LIVE_MODELS, docs, tests), run the suite, package, boot-test, deploy.`);
  if (verdict.status === 'default-not-listed') console.log('NEXT: the account no longer lists the default model: check the provider\'s deprecation notice and move the default now.');
  return verdict.status === 'up-to-date' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
