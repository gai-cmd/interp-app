// P3-33: turning a validated draft into the artefact someone commits
// (design-p3 §1.7 step 7). There is no deployment call here and there never
// will be: publishing is a person putting the file in the repository, so this
// module's job ends at "you now have the file".
//
// Two traps this is written against:
//   - reporting a download as though the policy were published;
//   - exporting different content under the revision that is already live.
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/** Stable, diffable JSON: two spaces and a trailing newline, as the repo file. */
export function serializePolicy(policy) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
/** The file name a published policy must have at the deployment root. */
export const POLICY_FILENAME = 'policy.json';
/** What an export can end as. `published` is deliberately absent. */
export const EXPORT_RESULTS = Object.freeze(['downloaded', 'copied', 'manual', 'blocked', 'failed']);
/** Steps a person still has to do; the UI shows these after any export. */
export const PUBLISH_STEP_KEYS = Object.freeze(['admin.publish.step1', 'admin.publish.step2',
  'admin.publish.step3', 'admin.publish.step4']);

/**
 * createPolicyExport({ editor, document?, navigator?, URL? })
 *
 *   download() → { result, filename, revision } — refuses an invalid draft, or
 *                one whose revision still equals the deployed one.
 *   copy()     → { result, text } — clipboard, falling back to 'manual' so the
 *                UI can offer selectable read-only text instead.
 *   text()     → the serialized draft, for that fallback.
 *
 * Every object URL created here is revoked once the click has been dispatched.
 */
export function createPolicyExport({ editor, document: doc = null, navigator: nav = null,
  URL: urlApi = (typeof URL === 'function' ? URL : null), Blob: BlobApi = (typeof Blob === 'function' ? Blob : null) } = {}) {
  if (typeof editor?.snapshot !== 'function') throw new Error('INVALID_REQUEST');

  /** Why an export must not happen yet, or null when it may. */
  function blocker() {
    const state = editor.snapshot();
    if (!state.valid) return 'invalid';
    // The live revision must not describe different content (§1.7).
    const deployed = state.deployed;
    if (deployed && state.draft.revision === deployed.revision
      && JSON.stringify(state.draft) !== JSON.stringify(deployed)) return 'revision';
    return null;
  }

  return Object.freeze({
    blocker,
    text: () => serializePolicy(editor.snapshot().draft),
    filename: POLICY_FILENAME,
    async download() {
      const blocked = blocker();
      if (blocked) return Object.freeze({ result: 'blocked', reason: blocked });
      const state = editor.snapshot();
      const body = serializePolicy(state.draft);
      if (!doc || !urlApi?.createObjectURL || !BlobApi) return Object.freeze({ result: 'failed', reason: 'unsupported' });
      let url = null;
      try {
        url = urlApi.createObjectURL(new BlobApi([body], { type: 'application/json' }));
        const anchor = doc.createElement('a');
        anchor.setAttribute('href', url);
        anchor.setAttribute('download', POLICY_FILENAME);
        anchor.click();
      } catch { return Object.freeze({ result: 'failed', reason: 'unsupported' }); }
      finally {
        // Released as soon as the click was dispatched: an object URL held open
        // keeps the whole document alive.
        if (url) attempt(() => urlApi.revokeObjectURL(url));
      }
      // Downloaded, which is NOT published: the caller shows PUBLISH_STEP_KEYS.
      return Object.freeze({ result: 'downloaded', filename: POLICY_FILENAME, revision: state.draft.revision });
    },
    async copy() {
      const blocked = blocker();
      if (blocked) return Object.freeze({ result: 'blocked', reason: blocked });
      const body = serializePolicy(editor.snapshot().draft);
      const clipboard = nav?.clipboard;
      if (typeof clipboard?.writeText !== 'function') return Object.freeze({ result: 'manual', text: body });
      try { await clipboard.writeText(body); } catch { return Object.freeze({ result: 'manual', text: body }); }
      return Object.freeze({ result: 'copied', revision: editor.snapshot().draft.revision });
    },
  });
}
