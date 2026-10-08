// New implementation of docs/extension.md §19 and §22 (2026-10-08); no legacy code is ported.
// Chrome's share dialog ("choose the tab to interpret"): what it is asked for, and whether the SIDE PANEL may ask for it.
// Both the offscreen document (engine/tab-lane.js, the §19 path) and the panel (§22) use the one definition here.
// Imports nothing and touches no global: the navigator and the realm's constructors arrive as arguments.
//
// §22, why the panel asks on a new enough Chrome: the offscreen document is never shown, so Chrome cannot attach the
// dialog to any window. It becomes an ownerless top-level window: on Windows it opens on the primary monitor, has its
// own taskbar button and drops behind the browser at the first click (crbug 326508296; read in the Chromium source
// 2026-10-08). From M153 a side panel page has a web-modal dialog manager, so the dialog it asks for is owned by the
// browser window and shown over it. On M135-M152 the panel's dialog is as ownerless as the offscreen one, and before
// M135 the web-modal path without a manager is a fatal check in the browser (inferred from the source): the panel must
// never ask there.

/**
 * A NotAllowedError this soon after the share picker was asked for is not a person closing the dialog (nobody reacts to
 * a window that fast): the browser or a policy refused to show it (a managed PC with screen capture switched off), and
 * silently going back to idle would make Start look dead. It is reported as TAB_CAPTURE_FAILED instead. A judgment, not
 * a measurement: the threshold was never timed against a real refusal (docs/extension.md §20, check 20.14).
 */
export const PICKER_REFUSED_AT_ONCE_MS = 400;

/**
 * What the share picker is asked for (§19). Video is mandatory for getDisplayMedia and is stopped as soon as it
 * arrives; `displaySurface: 'browser'` opens the dialog on its tab list. The audio is the tab's own signal, unprocessed,
 * and `suppressLocalAudioPlayback` silences the tab for the user exactly like the stream-id capture does, so the
 * passthrough graph and the "original volume" setting behave the same on both paths. The three `exclude` hints take
 * the whole-screen choice, the system-audio checkbox and the "share this tab instead" button out of the dialog (a
 * capture that moves to another tab would leave the overlay on the wrong page). A Chrome that does not know a hint
 * ignores it.
 */
export const DISPLAY_MEDIA_CONSTRAINTS = Object.freeze({
  video: Object.freeze({ displaySurface: 'browser' }),
  audio: Object.freeze({ suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false,
    autoGainControl: false }),
  surfaceSwitching: 'exclude',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'exclude',
});

/** The first Chrome whose side panel shows the share dialog over the browser window (§22). */
export const PANEL_DIALOG_MIN_CHROME = 153;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// The engine brands only: another Chromium browser (Edge, Opera, Brave) lists "Chromium" next to its own name, and its
// own version number says nothing about the Chromium code it runs.
const ENGINE_BRANDS = Object.freeze(['Google Chrome', 'Chromium']);
const UA_CHROME = /Chrome\/(\d+)/;

function majorOfVersion(value) {
  const match = typeof value === 'string' ? /^(\d{1,6})(?:\.|$)/.exec(value) : null;
  const major = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

/**
 * The Chrome (Chromium) major version of `navigatorLike`, or null when it cannot be told: the "Google Chrome" or
 * "Chromium" entry of navigator.userAgentData.brands first, else `Chrome/<n>` in navigator.userAgent. Never throws.
 */
export function chromeMajorOf(navigatorLike) {
  const brands = attempt(() => navigatorLike.userAgentData.brands);
  if (Array.isArray(brands)) {
    for (const entry of brands) {
      if (!ENGINE_BRANDS.includes(attempt(() => entry.brand))) continue;
      const major = majorOfVersion(attempt(() => entry.version));
      if (major !== null) return major;
    }
  }
  const agent = attempt(() => navigatorLike.userAgent);
  const match = typeof agent === 'string' ? UA_CHROME.exec(agent) : null;
  return match ? majorOfVersion(match[1]) : null;
}

/**
 * §22: true when the side panel may ask for the share dialog itself and relay the chosen tab's audio: Chrome 153 or
 * later, a MediaStreamTrackProcessor and a BroadcastChannel in the panel's realm (`env`), and a getDisplayMedia on its
 * navigator. Anything unknown is false (the offscreen document then asks, as before). Never throws.
 */
export function canOpenDialogInPanel({ navigator: navigatorLike, env } = {}) {
  const major = chromeMajorOf(navigatorLike);
  return major !== null && major >= PANEL_DIALOG_MIN_CHROME
    && typeof attempt(() => env.MediaStreamTrackProcessor) === 'function'
    && typeof attempt(() => env.BroadcastChannel) === 'function'
    && typeof attempt(() => navigatorLike.mediaDevices.getDisplayMedia) === 'function';
}
