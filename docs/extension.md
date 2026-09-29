# Chrome side-panel extension — implementation contract

## Status

IMPLEMENTED on 2026-09-29 and committed in three steps:
- `2f6901a` session: the opt-in isolated Live slot (`isolated` on `createSessionManager` and `createAppConfig`; `app/config.js`, `app/engine/session-manager.js`, `tests/session-isolated.test.mjs`). These are the only edits under `app/`.
- `43febec` extension: `extension/**` (46 files, 3.1), `scripts/build-extension.mjs`, the repo-gate edits of section 12, 23 test files and 4 fixtures under `tests/`, and this document.
- `7773fbc` test hardening: a mutation study of the 12 MUST rules found 13 real test gaps; tests only, no source change.
- `540c7fc` router: `app/providers/router.js` passes the two-way `languages` pair through to the provider (the known defect K21; a shape check and a forwarded copy of the pair plus real-stack tests; the only `app/` edit after `2f6901a`).
- The commit after `540c7fc`: TWO-WAY MODE in the extension (added after the first delivery). The owner asked for it on 2026-09-29 ("양방향 모드 넣어"), which REVERSES the non-goal D10 ("no two-way"; 14.4 change 3). A lane can interpret in both directions between its first language and a partner language; it is off by default and per lane. What changed: `twoWay` and `partnerLanguage` per lane in the settings (7.1, 7.2); an optional `request.languages` pair in `host/lane-start` (4.2.1); the panel's two-way checkbox, partner select, hint and model note (8.2.1, 8.2.3); a per-row `lang` in caption frames (4.6.3); 5 new dictionary keys, 117 -> 122 (9.2); nine end-to-end tests (11.1) and six new checklist rows (13.52-13.57). Unchanged: `overlay.js`, the options page, everything else under `app/`.

Verification state:
- The whole suite (`node --test tests/*.test.mjs`) was green at delivery: 1789 tests, 1789 pass (orchestrator run of 2026-09-29 20:22, after the last source change) and again after this docs polish; the 24 extension-related files alone counted 778 tests (11.1). After the two-way mode the 24 files count 844 tests and the whole suite 1858 tests, 1858 pass (run of 2026-09-29 after the last source change: 1792 before the mode plus 66 new; 11.1 has the per-file numbers).
- NOTHING has been verified in a real Chrome or with real audio (owner rule: no sound, meeting in progress). Every statement about Chrome's behavior stays tagged `[verified-doc]`, `[observed]` or `[assumption A#]`, and all 57 checks of section 13 are NOT TESTED BY CLAUDE (13.52-13.57 are the two-way rows: the model's real two-way output, its direction choice and the speaker feedback loop are unobserved). A green suite proves the protocol, the state machines, the file tree and the build (fakes, 11.2 and 11.3), not Chrome behavior.

Document state: the text below began as the DESIGN CONTRACT written by the architect before any implementation, for four engineers (groups A, B, C, D, section 15) who implement disjoint parts in parallel from this document alone. The docs polish pass of 2026-09-29 (15.3 item 7) reconciled it with the delivered code, section by section, using scripts that diff the document against the code (file list, exports, message catalog, element ids, dictionaries, manifest, build API, check-i18n patch, tests). From here on the document describes the delivered extension: a difference between code and document is a defect in one of them, and the tests pin the code. Section 15 is kept as history.

Deviations from the first draft (delivered behavior that differs from the original contract text; each is now written into the section named):
1. Panel accessibility (8.2.1, 8.2.6, 8.2.8, 13.31, 13.33, 13.47-13.49): Start is never natively `disabled` but `aria-disabled="true"` with its click ignored, so it stays focusable and its description reachable; the per-lane status lines `#tab-status` / `#mic-status` are plain text, not live regions (the pill and the notices announce state); the two caption previews are `role="region"` with an `aria-label`; the muted mute button shows a slashed speaker (a shape cue), not only a colour.
2. Backup model (5.11, 8.2.3, 9.2): the warning is a persistent live region `#<lane>-route-note` (`ext.route.fallbackNote`); `ext.route.fallback` is a short label ("Backup model") that stays on the route line next to the model id.
3. Dictionaries (9.2, 9.6): 117 `ext.*` keys at first delivery (122 with the two-way keys `ext.twoWay.*`, see the Status list above), not 113: `ext.status.off` (a switched-off lane no longer reads "Ready to start"), `ext.route.fallbackNote`, `ext.key.savedBrowser` (the app key's Korean text is in a formal register) and `ext.options.modelLive` (the tab select does not tag its model "(default)"). The caption-lines and auto-hide labels state the ranges (1-6, 0-60); `ext.permission.title` (en) reads "Allow microphone" like the button; `ext.menu.open` and the `_locales` `menuOpen` read "Open the interpreter panel on this tab" (the click opens the panel, it does not start interpretation).
4. Microphone permission page (8.4): `#perm-help` is a persistent `role="status"` region whose text is written and cleared, never hidden; `#perm-request` and the panel's `#btn-mic-allow` are named `ext.permission.allowButton` (only the panel's icon button `#btn-mic-permission` keeps `permission.request`).
5. Options (7.3, 8.3): the two number fields reject an out-of-range or fractional value (the stored value comes back, nothing is written, no "Saved.").
6. Idle report (5.8, 6.9): a `sw/host-idle` answered `{closed:false}`, or two failed sends, makes the host's panel hub repeat the report 3 s, 6 s and 12 s later, at most 3 times; a panel port cancels and resets the chain (an idle offscreen document can no longer stay for good).
7. Stop races (6.3, 5.6): a start of a lane whose previous start is cancelled but still unwinding answers `LANE_STOPPING` (it used to answer `ALREADY_RUNNING`, which the panel ignores, so the press vanished); when a Stop overtakes a refused start, `START_CANCELLED` wins over the refusal.
8. Panel behavior (8.2.3, 8.2.5): a stale `MICROPHONE_DENIED` clears the moment the permission is granted; Start on a page known to be unsupported is a silent no-op for the tab lane (the arm note is the one explanation), the microphone lane of the same Start still runs; arm notes are dropped where the lane's own notice already says what to do.
9. Overlay (8.5.2): the host pins `direction: ltr` and `unicode-bidi: isolate`, every row carries `dir="auto"`, and the top-fade mask has a second opaque layer over the close button's corner.
10. Structure (5.1, 5.5, 5.6, 6, 10.1): the start/stop state machine both lanes share is `createLaneController` in `engine/lane-engine.js`; `lane-host.js` also exports `createRealmClock` and `createHostEnv`; `worker-timers.js` also exports `createEngineClock`; `host/lane-start` also applies the message's mute, captions, style and volume to the host settings; the build script exports `EXTRA_FILES`, `EXTENSION_CODES`, `isOwnOutput`, `parseArguments` and `runCli`, and scans for secrets BEFORE it writes anything.
11. i18n failure (9.5, 13.51): when the dictionaries fail to load, the panel and the options page show the three-key boot dictionary and retry silently (2 s, 6 s, 18 s); there is no Retry button (known, not fixed).
12. Tests (11.1): the file-fetch shim of `extension-integration` derives the checkout root from its own URL instead of the folder name `interp-app`, so the suite passes in any checkout or worktree.

How to read this document
- "MUST / MUST NOT" are binding. "SHOULD" is a default that needs a written reason to deviate.
- Every fact about Chrome behavior carries one of three tags where it matters:
  `[verified-doc]` = stated by Chrome documentation or Chromium source read by the scouts,
  `[observed]` = seen in the scouts' recorded headless run (Chrome for Testing 149, not the owner's Chrome),
  `[assumption A#]` = inferred by the architect or unverified; every assumption is registered in section 14.
- Nothing in this project has been run in a real browser with real audio. The owner is in a no-sound
  regime (BRIEF "HARD RULE"): everything that needs real tab capture, a real microphone or audible output is
  written into the manual checklist (section 13) and is marked NOT TESTED BY CLAUDE.
- Repo facts at DESIGN time (kept as history; the delivered numbers are in the Status block and in 11.1): the architect
  re-read on 2026-09-29 that `node --test tests/*.test.mjs` reported 1011 tests / 1011 pass, that
  `node scripts/check-i18n.mjs` reported `I18N_OK languages=3 keys=810 files=86`, and that `git apply --check` of the
  prepared check-i18n patch succeeded. At delivery the checker prints `I18N_OK languages=3 keys=810 files=123`.
- Working tree state this design builds on (committed since as `2f6901a`): `app/config.js` and `app/engine/session-manager.js`
  already carried the opt-in `isolated` option. Nothing else under `app/` changes (D14).
- Revision 2 (2026-09-29, after three independent reviews: MV3 security, testability/gates, UX/product): start/stop
  cancellation (5.6, 6.3, 6.11), live caption attach and mic-caption privacy (5.6.3, 6.6, 6.7, 8.5), panel-close
  disclosure and stop reasons (5.8, 6.9), lane-aware error wording, the quota copy family and the arming copy split
  (5.11, 9.2), sticky controls and overlay anchoring (8.2, 8.5), a real-tree/fixture split of the test files and a
  corrected dependency graph (11, 15). Appendix B maps every review issue to the place that resolves it; Appendix C
  carries the prototype test that group A starts from. Anything the reviews proved unworkable in D1-D14 is listed in
  section 14.4, not silently changed.
- Revision 3 (2026-09-29, after implementation and a second review round on the built extension): the docs polish of 15.3
  item 7. Sections keep their numbers; the text now describes the delivered code (Status block at the top for the list of
  deviations, 11.1 for the delivered test files and counts, 13 for the owner's checklist).

Table of contents
1. Goal, scope, non-goals, screenshot mapping
2. Architecture
3. Directory layout, ownership, import-graph rules
4. Protocols
5. Lane host (offscreen document)
6. Service worker
7. Settings schema and options page fields
8. UI specs (panel, options, permission page, overlay)
9. i18n (ext.* keys, _locales, loader)
10. Build script spec
11. Test plan
12. Repo-gate edits
13. Manual verification checklist (NOT TESTED BY CLAUDE)
14. Risks, open questions, assumptions register
15. Task breakdown (groups A-D; historical: delivered)
Appendix A: weakest points of this design
Appendix B: review ledger (issue -> resolution)
Appendix C: prototype test for group A (`tests/extension-i18n.test.mjs`)

---------------------------------------------------------------------------------------------------

## 1. Goal, scope, non-goals, screenshot mapping

### 1.1 Goal

Attach this repo's Gemini Live simultaneous-interpretation engine (`app/`) to third-party web pages as a
Manifest V3 Chrome extension with a side panel, in the shape of the owner's screenshot (a third-party
extension "Interpretab" docked next to a claude.ai document):

1. Tab lane: capture the audio of the current tab (`chrome.tabCapture`), interpret it into the user's language,
   keep the original tab audio audible at a chosen volume, optionally speak the translation, optionally draw
   captions on the page.
2. Mic lane: capture the microphone, interpret what the user says, caption and (optionally) speak the result.
3. Both lanes can run at once: two concurrent Live sessions on one key. The UI warns that this roughly doubles
   Google usage (D12: free-tier context; not a measured claim).
4. A caption overlay injected into the host page that can never break the page (isolated Shadow DOM).
5. A side panel, an options page (Gemini key, model per lane, voice gender, defaults, caption look) and a
   microphone-permission page, all in ko / en / ja.
6. Two-way (added after the first delivery; optional, per lane, OFF by default): a lane can interpret in both directions between
   its first language and a partner language, for a conversation in two of `ko|en|ja`. The panel offers it; the options page does not.

Distribution is "Load unpacked" from `dist/extension/` (plus an optional zip). NOT the Chrome Web Store (D11: a
store account fee would be a new cost, and publishing is an external act that needs the owner's approval).

### 1.2 In scope

- Everything in section 1.1, built on the unchanged web-app engine modules with the two backward-compatible
  edits already applied (`isolated` on `createSessionManager` and `createAppConfig`).
- A zero-npm-dependency build script that assembles a self-contained `dist/extension/`.
- A silent test suite (no browser, no audio hardware) that pins the protocol, the state machines, the sender
  rules, the key-handling rules, the build output and the i18n rules.

### 1.3 Non-goals (binding: nothing here may be implemented)

- No Chrome Web Store listing, no signing key (`.pem`), no CRX, no auto-update.
- No new paid service or API. No proxy, no server component, no telemetry.
- No change to the web app's behavior (D14) beyond the commits named in the Status block. The known defect "two-way `languages` is
  dropped by `app/providers/router.js`" (K21) was fixed in `540c7fc`, and the extension offers a two-way mode since then: the first draft's
  non-goal "no two-way mode" (D10) was REVERSED by the owner (14.4 change 3). What stays out: a pair of more than two languages, a source-language
  hint (the source is always auto), a per-utterance language picker, and any two-way switch in the options page.
- No sequential (push-to-talk) engine: the screenshot's mic "mode" dropdown becomes one static line (1.5).
- No real-audio verification by us; no test may touch a browser, `getUserMedia`, `tabCapture` or an output
  device (D13).
- No tab-audio recording, no audio persistence, no transcript storage. Captions are memory-only (the engine's
  caption store) and never written to storage.
- No built-in key rotation. `BUILTIN_KEYS[0]` is the only built-in key ever used (section 7.4).
- No `host_permissions`, no `<all_urls>` permission, no `externally_connectable`, no `web_accessible_resources`.
- No mic capture from the side panel page or from the service worker.
- No "captions-only screen" of the web app; no wake lock.

### 1.4 Vocabulary

| Term | Meaning |
|---|---|
| lane | One interpretation channel: `tab` (captured tab audio) or `mic` (microphone). Exactly two lane ids exist. |
| host | The single offscreen document `extension/engine/host.html` that runs both lanes' engines in one JS realm. |
| armed tab | A tab on which the user invoked the extension (toolbar icon, `_execute_action` shortcut, context-menu item). Chromium grants `tabCapture` for that tab only after such an invocation (D2). |
| panel | The side-panel page `extension/panel/panel.html`. |
| overlay | The caption content script `extension/overlay/overlay.js` inside the host page. |
| SW | The MV3 service worker `extension/background/service-worker.js`. |
| frame | A small JSON object pushed over a `chrome.runtime.Port` (data plane). |
| message | A JSON object sent with `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` (control plane). |

### 1.5 Screenshot mapping (every control in the screenshot -> element id and behavior)

The screenshot (`images/1.png`) shows, top to bottom, inside a Chrome side panel. Element ids are the binding
contract between group D (HTML) and group C (controller). All ids exist in `extension/panel/panel.html`.

| # | Screenshot element | Our element id | Behavior |
|---|---|---|---|
| 1 | Panel title "Interpretab" | `#panel-title` (`h1`, key `ext.name`) | Static. |
| 2 | Status pill "● 대기 중" | `#status-pill` (`p.badge`, `role="status"`, `aria-live="polite"`, `data-state`) | Overall status text from `sim.status.*` (8.2.3). `data-state` = `idle` / `starting` / `running` / `warning` / `error`; text always carries the state (never color alone). |
| 3 | Card "탭 오디오 — 이 탭 내 언어로", checkbox on | `#card-tab`; `#tab-enabled` (checkbox); title `#tab-title` (`ext.lane.tab.title`) + lead (`ext.lane.tab.lead`) | Enables the tab lane. Persisted as `lanes.tab.enabled`. While the host runs, unchecking stops that lane, checking starts it (8.2.5). |
| 4 | Select "번역할 언어" = Korean (한국어) | `#tab-target` (`select`, label `language.target`, options `language.ko/en/ja`) | `lanes.tab.targetLanguage`. Applies from the next start (hint `ext.applyNext` while running). While two-way is on, its label reads "First language" (`ext.twoWay.targetLabel`, in `#tab-target-label`). |
| 5 | Note "원래 언어는 자동으로 알아냅니다" | `#tab-source-note` (`p`, `ext.source.auto`) | Static. The source language is always auto-detected (request omits `sourceLanguage`). |
| 6 | Slider "원래 소리를 남겨 둘 크기" 65% | `#tab-volume` (`input[type=range]` 0-100 step 5) + `#tab-volume-value` (`output`, `ext.volume.value`) | `lanes.tab.originalVolume`, live: drives the passthrough GainNode (5.3). Default 65 (matches the screenshot). |
| 7 | Checkbox "페이지에 자막 표시" (tab) | `#tab-captions` (checkbox, `ext.captions.show`) | `lanes.tab.captions`, live: ticking it during a run attaches the overlay to the captured tab (6.6), unticking clears it. |
| 8 | Card "마이크 — 그 자리에서 하는 말을 소리 내어 번역", checkbox | `#card-mic`; `#mic-enabled`; `#mic-title` (`ext.lane.mic.title`) + lead (`ext.lane.mic.lead`) | Enables the mic lane. Same start/stop rules as the tab checkbox. |
| 9 | Mode select "Simultaneous — 말하는 동안 바로" | `#mic-mode` (`p`, key `ext.mic.mode`) | NOT a select: this engine has exactly one mode. A static line keeps the visual slot without a control that does nothing. |
| 10 | Select "번역할 언어" (mic) | `#mic-target` (`select`) | `lanes.mic.targetLanguage`. The same two-way label rule as `#tab-target` (`#mic-target-label`). |
| 11 | Note "원래 언어는 자동으로…" (mic) | `#mic-source-note` (`p`, `ext.source.auto`) | Static. |
| 12 | Checkbox "페이지에 자막 표시" (mic) | `#mic-captions` (checkbox) | `lanes.mic.captions`, OFF by default (7.1). Mic captions are drawn ONLY on the tab you are looking at (the active tab of the last focused window, 6.7), never on background tabs; the hint `#mic-captions-hint` (`ext.captions.micHint`) says so. Live like the tab checkbox. |
| 13 | Note "번역된 음성이 음소거되어 있습니다…" | `#mute-note` (`p`, persistent live region, key `ext.mic.mutedHint`) | Text present while `speechMuted` and at least one lane is enabled (8.2.6 live-region rule). Placed between the cards and the button row (not inside the mic card) because mute is global. While the voice is ON and the mic lane is enabled, `#echo-note` (`ext.sound.echoWarning`) takes its place. |
| 14 | Link "사용 방법: 통화 전에 할 일" | `#howto` (`details`), `summary` text `ext.howto.link`, body `ol#howto-steps` | Disclosure instead of navigation (no extra page). Steps: `ext.howto.keepOpen`, `sim.headphonesStart`, `ext.howto.step2`, `ext.howto.step3`, `ext.howto.step4`, `ext.howto.step5` (the voice plays only on this computer), `ext.howto.stepCall` (which lane to use for the other side of a call). |
| 15 | Button "Start" | `#btn-start` (`button.btn.btn-primary`) | Text `common.start` when no lane is starting/running, `common.stop` otherwise, `common.cancel` while the ONLY thing happening is the wait for the toolbar-icon click (`awaiting`). Start = start every enabled lane that is not running; Stop = stop all lanes, cancel every in-flight start (`sw/lane-stop`, 6.11) and cancel a pending arm. Not available while no key is stored or no lane is enabled: the button then carries `aria-disabled="true"` (NEVER the native `disabled` attribute, so it stays focusable and its `aria-describedby` reason stays reachable) and a click on it is ignored (8.2.6). The row is sticky at the bottom of the panel (8.2.2). |
| 16 | Mic-permission icon button | `#btn-mic-permission` (`button.btn.icon-btn`, `aria-label` = `permission.request`) + `#mic-permission-status` (`p`, `role="status"`) + `#btn-mic-allow` (`button.btn`, visible text `ext.permission.allowButton`, shown while the state is not `granted`) | Both buttons open the permission tab (D5) via `sw/permission-open` (the text button exists because the icon-only button is easy to miss); the status line shows `permission.title · permission.<granted, denied or prompt>` from `navigator.permissions.query({name:'microphone'})` and its `onchange`. |
| 17 | Mute-toggle icon button (red when muted) | `#btn-mute` (`button.btn.icon-btn`, `data-muted`, `aria-label` AND `title` = `ext.sound.on` when muted / `ext.sound.off` when audible) | Toggles the global `speechMuted` (default true). The labels name what the button controls (the INTERPRETED speech, not the tab's sound); same label-swap pattern as the web app's sound button (an action label, so no `aria-pressed`); muted = danger styling via `data-muted="true"`, a slash across the speaker (a second icon path shown only while muted, so the state is a shape and not only a colour, 8.2.2) plus the `#mute-note` text. |
| 18 | Button "옵션" | `#btn-options` (`button.btn`, key `ext.options.title`) | `runtime.openOptionsPage()`. |
| 19 | Footnote "둘을 함께 켜면 …두 배" | `#usage-note` (`p`, key `ext.usage.twoSessions`) | Shown while both `#tab-enabled` and `#mic-enabled` are checked (or both lanes run). Text states the doubling is not measured (D12). |

Additions that are not in the screenshot but are required by the design:
`#key-missing` (notice + `#btn-key-options`), `#no-lane-note` (no lane enabled), `#tab-arm-note` (needs-arm state, D2), `#tab-tabline` (title of the captured tab), per-lane `#tab-status`/`#mic-status` (plain text, NOT live regions: the pill and the notices already announce every state change), `#tab-route`/`#mic-route` (route label and model id, not live), `#tab-route-note`/`#mic-route-note` (persistent `role="status"` regions holding the backup-model warning `ext.route.fallbackNote`),
`#tab-output`/`#mic-output`, `#tab-gap`/`#mic-gap` (input/audio/reception gap line: the visible symptom of a starved uplink, K5), `#tab-level`/`#mic-level` (`meter`), `#tab-notice`/`#mic-notice` (`role="alert"`), per-lane caption preview
`#tab-preview`/`#mic-preview` (`role="region"`, focusable, `aria-live` off), `#tab-apply-next` / `#mic-apply-next` (`p`, inside the lane card, right below the language select it refers to), `#stop-note` (why the last run ended: panel closed / engine lost), `#close-note` (`ext.panel.closeStops`, shown while any lane runs),
`#echo-note` (`ext.sound.echoWarning`), `#mic-captions-hint`, `#btn-mic-allow`, and the two-way controls of each lane (not in the screenshot; 8.2.1, 8.2.3 rule 18): `#tab-two-way` / `#mic-two-way` (checkbox, `ext.twoWay.label`, `lanes.<lane>.twoWay`), `#tab-partner-row` / `#mic-partner-row` (hidden while two-way is off) holding a label (`ext.twoWay.partner`) and the select `#tab-partner` / `#mic-partner` (`lanes.<lane>.partnerLanguage`; options = the three languages minus the lane's first one), `#tab-two-way-hint` / `#mic-two-way-hint` (static help, `ext.twoWay.hint`, the checkbox's `aria-describedby`), `#tab-two-way-note` / `#mic-two-way-note` (`ext.twoWay.modelNote`, shown only while two-way is on AND the lane's model is the translation-only one) and `#tab-target-label` / `#mic-target-label` (the label text of the target select).

---------------------------------------------------------------------------------------------------

## 2. Architecture

### 2.1 Contexts and ownership

```
                          user gesture (toolbar icon / _execute_action / context menu)
                                            |
                                            v
 +------------------+   sendMessage    +-----------------------+  createDocument   +---------------------------+
 |  SIDE PANEL      |----------------->|  SERVICE WORKER       |------------------>|  OFFSCREEN HOST           |
 |  panel.html      | sw/lane-start    |  stateless, thin      |  getContexts      |  host.html (USER_MEDIA)   |
 |  (UI only)       | sw/permission-   |  * arm bookkeeping    |  closeDocument    |  ONE JS realm, TWO lanes  |
 |                  |   open           |  * ensureOffscreen    |                   |                           |
 |  storage.onChanged|<---session------|  * mint stream id LAST|--host/lane-start->|  lane "tab":              |
 |  (armed, host up)|   storage        |  * error mapping      |   {key,streamId}  |   getUserMedia(tab id)    |
 |                  |                  |  * tab events         |<--sw/host-idle----|   AudioContext graph      |
 |                  |                  +-----------+-----------+                   |   raw->gain->destination  |
 |                  |                              |                               |   raw->synthetic stream   |
 |                  |                  tabs.sendMessage                            |   createSimEngine(isolated)|
 |                  |                  content/overlay-attach                      |  lane "mic":              |
 |                  |                              |                               |   real getUserMedia (mic) |
 |                  |                              v                               |   createSimEngine(isolated)|
 |  port            |          +-----------------------------------+               |                           |
 |  interp-panel/1  |<=========|  frames: state, captions, bye     |===============|  panel-hub, overlay-hub   |
 |                  |          +-----------------------------------+               |                           |
 +------------------+                                                              +-------------+-------------+
                                                                                                 ^
 +------------------+   port interp-overlay/1  (frames: style, captions, clear, bye)             |
 |  OVERLAY         |============================================================================+
 |  content script  |   opened by the content script after content/overlay-attach
 |  Shadow DOM      |   delivered DIRECTLY to the host [observed], never through the SW
 +------------------+

 +------------------+   chrome.storage.local:  interp.settings.v1, interp.key.v1 (TRUSTED_CONTEXTS)
 |  OPTIONS PAGE    |   chrome.storage.session: interp.armed.v1, interp.host.v1
 |  MIC PERMISSION  |   Options and permission pages are ordinary extension pages opened in tabs.
 +------------------+
```

| Context | Entry file | Extension APIs it may use | Owns | Lifecycle |
|---|---|---|---|---|
| Service worker | `extension/background/service-worker.js` | all in the adapter (3.4) | arming, host lifecycle, mint, tab events, key/settings delivery, cancellation of in-flight starts | Event-driven, dies after ~30 s idle `[verified-doc]`. Durable state in `storage.session`; the only in-memory state is the set of in-flight starts (with their cancel flags) and the lifecycle mutex, both rebuilt empty after a restart (6.3.1, 6.10). Registers every listener at top level. |
| Side panel | `extension/panel/panel.html` -> `panel.js` | all in the adapter | UI, settings edits, start/stop intents | Destroyed when the panel closes `[verified-doc]`. Whether a panel that is merely hidden by another side-panel entry keeps its port open is UNRESOLVED `[assumption A21]`: the scouts found a source reading (cached view) and a third-party report (port disconnects) that contradict each other. The design works either way (5.8: the worst case is a 3 s grace stop that the panel explains on reopening). |
| Options page | `extension/options/options.html` -> `options.js` | all in the adapter | key entry, settings editing | Opened in a tab (`options_ui.open_in_tab: true`). |
| Mic-permission page | `extension/permission/mic-permission.html` -> `mic-permission.js` | `runtime` only needed | one `getUserMedia({audio:true})` call to obtain the permission for the extension origin | Opened by the SW with `tabs.create`, closes itself. |
| Offscreen host | `extension/engine/host.html` -> `host.js` | `runtime` ONLY `[verified-doc]` | both engines, tab audio graph, ports | Created by the SW with reasons `['USER_MEDIA']` ONLY (no `AUDIO_PLAYBACK`: it would auto-close after 30 s without audio `[verified-doc]`). Lives until the SW closes it. |
| Overlay | `extension/overlay/overlay.js` | `runtime` (connect, onMessage, id), `i18n.getMessage` | caption rendering | Static `content_scripts`, top frame only, isolated world, `document_idle`. |

Who owns what, in one sentence each:
- The SW owns everything that needs `chrome.tabs`, `tabCapture`, `sidePanel`, `offscreen`, `scripting`,
  `storage`: it is the only context that mints a stream id and the only one that reads the API key.
- The host owns audio and engines: audio never leaves it; the key enters it once per lane start and is dropped
  when the lane ends.
- The panel owns user intent and settings edits. It never holds an engine, a key or a stream.
- The overlay owns pixels on the host page and nothing else. It never sees a key, audio or a raw snapshot.

### 2.2 How D1-D14 are realized

| Decision | Realization | Section |
|---|---|---|
| D1 one offscreen doc, `['USER_MEDIA']`, isolation via `isolated:true`, one `createAppConfig` per lane, no iframes | `createLaneEngine` builds a fresh `createAppConfig({isolated:true})` and `createSimEngine` per lane start; `ensureOffscreen` creates the doc with exactly `reasons:['USER_MEDIA']`. | 5.5, 6.3.1 |
| D2 no Start-in-panel mint; arm via action click; mint last | `action.onClicked` -> `sidePanel.open` first statement -> `interp.armed.v1`; panel shows the needs-arm state and auto-starts once armed; `sw/lane-start` mints after the host answered `host/ping`. | 6.2, 6.3, 8.2 |
| D3 tab audio graph | `createTabAudioGraph`: raw -> `MediaStreamSource` -> `GainNode` -> `destination`, and raw -> `MediaStreamDestination` per engine start. Stop stops every raw track. | 5.3 |
| D4 platform shim | `createLanePlatform` wraps `createPlatform(shimEnv)` (`isActive` true, stub `document`, `isSecureContext` true, real audio classes; timers are the realm's by default, with a built one-constant switch to worker-driven timers, 5.13). | 5.4, 5.13 |
| D5 mic permission page | `mic-permission.html` via `tabs.create`; panel watches `navigator.permissions.query({name:'microphone'})`. The on-page instruction names the choice to AVOID ("Allow this time"), not a label to pick: Chrome's own help lists "Allow while visiting the site / Allow this time / Never allow" (14.4, change 2). | 8.4 |
| D6 overlay | Static classic-script IIFE; CLOSED Shadow DOM `all:initial` (14.4, change 1: D6 said "open"); port `interp-overlay/1` delivered directly to the host. Refinement: the overlay connects only after `content/overlay-attach` (4.5, 6.7). | 4.5, 6.7, 8.5 |
| D7 control plane | Every message carries `{v,target,type}`; panel port `interp-panel/1`; panel port disconnect -> grace -> stop -> `sw/host-idle {reason}` -> SW records `interp.lastStop.v1` and closes the doc. Refinement: the SW registers NO `runtime.onConnect` (it never needs to be a receiver of panel or overlay ports). | 4, 5.8 |
| D8 key handling | `storage.local` + `setAccessLevel TRUSTED_CONTEXTS` at every SW start AND at `runtime.onStartup`, and by the options page before it writes a key (a rejection refuses the save); key travels only inside `host/lane-start`; never to a content script; never logged; optional gitignored `--builtin-key-file`. | 4.8, 7.4, 10.6 |
| D9 layout | `extension/` source, `dist/extension/` mirrors the repo layout; ext dictionaries in `extension/i18n/`; check-i18n patch. | 3, 10, 12 |
| D10 i18n | ko/en/ja, 해요체. (The first draft also said "no two-way"; that half was REVERSED by the owner on 2026-09-29, 14.4 change 3: two-way is a per-lane opt-in, `twoWay` + `partnerLanguage` in the settings, sent as `request.languages`.) | 4.2.1, 7, 8.2, 9 |
| D11 Chrome 116 | `minimum_chrome_version: "116"`; newer APIs feature-detected; `_locales` for name/description. | 10.4 |
| D12 free-tier footnote | `ext.usage.twoSessions` says "about twice" and that it is an estimate, not a measurement; `ext.usage.quotaHint` is added when a quota-suspect error hits with both lanes on. | 9.2, 8.2.3 |
| D13 silent tests only | Fake chrome, fake audio, fake DOM; manual checklist for the rest. | 11, 13 |
| D14 no web-app edits | Only the files listed in section 12 change outside `extension/`, apart from the router fix `540c7fc` that the two-way mode needed (K21). | 12 |

### 2.3 Lifecycle of one interpretation run (happy path, tab lane, panel already open)

1. User clicks the toolbar icon on tab T. SW: `sidePanel.open({windowId})` (first statement), then writes
   `interp.armed.v1[T]`. Panel (`storage.onChanged`) shows "tab is ready".
2. User presses `#btn-start`. Panel -> SW `sw/lane-start {lane:'tab', tabId:T}`.
3. SW: read settings + key, check arming, `ensureOffscreen()` (create doc if missing, ping until `host/ping`
   answers), write `interp.host.v1 {up:true}`, mint `getMediaStreamId({targetTabId:T})`, send
   `host/lane-start {key, streamId, ...}` to the host.
4. Host: `getUserMedia` with the id, build the audio graph (passthrough is audible immediately), create the
   isolated config + engine, `engine.start(...)`, answer `{ok:true}`.
5. Panel connects `interp-panel/1` (it saw `interp.host.v1.up`), receives `state` and `captions` frames.
6. SW, after the start answer, tells the tab to attach the overlay (`content/overlay-attach`); the overlay
   opens `interp-overlay/1`; the host routes tab-lane caption frames to it.
7. Stop (button, panel closed, tab closed, error): the button goes panel -> SW `sw/lane-stop` -> host `host/lane-stop`
   (the SW hop also cancels a start that is still in flight, 6.11); the host tears the lane down in the order of 5.7,
   tells the panel and overlay, and when the panel is gone sends `sw/host-idle {reason}`; the SW records why and
   closes the offscreen document.

### 2.4 Failure isolation summary

- One lane failing never stops the other (5.9).
- The host never trusts a caller: every message is validated (4.3) and every sender is classified (4.4).
- A running session does not NEED the SW: nothing in the steady state (frames, captions, mute, volume) is routed
  through it except forwarding storage edits, and the SW restarts on the next event and rebuilds from storage.
  Whether an already-open panel or overlay port to the offscreen document survives a SW idle stop is not measured
  `[assumption A22]`; checklist 13.26 measures it (idle for 90 s, then change volume, toggle mute, press Stop).
- A closed panel stops the lanes after a grace period (5.8) so a forgotten session cannot keep a Live
  connection and the tab-capture indicator alive. This is disclosed in the UI (`ext.panel.closeStops`, the how-to)
  and explained after the fact (`interp.lastStop.v1`, `#stop-note`).

### 2.5 Refinements and additions the architect made beyond D1-D14 (decisions the owner should know about)

None of these reopens a D-decision; each fills a gap the decisions leave open. All are reversible in one place.

| # | Refinement | Why | Where |
|---|---|---|---|
| F1 | The SW registers no `runtime.onConnect`; only the offscreen host receives panel and overlay ports. | The SW never needs those ports, so it does not need to be a receiver of them. (Not claimed: that ports never wake the SW. The overlay scout saw a SW restart after a content script connected and sent a message even though that SW had registered no listeners, so waking is unproven either way and harmless.) | 4.5, 6.1 |
| F2 | The overlay does not connect at load: it connects after a `content/overlay-attach` message from the SW. The SW sends it after lane start, after a tab finishes loading and when the active tab changes. | Eager connect from every tab would wake the SW and hold ports for tabs nobody captions; ports opened before the host exists are dead anyway. | 6.7, 8.5.1 |
| F3 | One path for hot settings: panel and options write `storage.local`; the SW forwards `host/settings`. The panel port carries only host -> panel frames. | Two command paths (port and message) would diverge; the SW wake per edit is cheap. | 6.6 |
| F4 | Permissions `tabs`, `scripting`, `contextMenus` are added to `tabCapture`, `activeTab`, `offscreen`, `sidePanel`, `storage`. | `tabs` for `changeInfo.url` (arming) and pre-mint URL rejection; `scripting` for re-injecting the overlay into an already-open armed tab (a fresh Load-unpacked install never injected the static script there); `contextMenus` for the D2 alternative invocation. | 10.4 |
| F5 | The mic "mode" select of the screenshot is a static line; mute is one global toggle; there is no per-lane "speak" checkbox. | One engine mode exists; the screenshot has a single mute icon. | 1.5 |
| F6 | The panel shows a small caption preview per lane and an input-level meter. | The overlay cannot appear on every page (fullscreen video, restricted pages) and the owner cannot listen during a no-sound test: the meter is the only visible proof that capture works. | 8.2 |
| F7 | Model defaults differ per lane (tab: translation preview; mic: `gemini-3.8-live`). | 5.12; an assumption (A8), one constant to change. | 5.12, 7.1 |
| F8 | A tab lane whose Start is pressed on an un-armed tab waits in an `awaiting` state and starts by itself when the icon click arms the tab. | D2 says the panel Start can never mint; this makes the two clicks feel like one. | 8.2.5 |
| F9 | Icons 48 and 128 are derived at build time by an exact 4x box downscale of the existing 192 and 512 PNGs (dependency-free PNG code, verified by the architect on both files). | The repo has no 48/128 icons and `icons/` must not be edited. | 10.4 |
| F10 | The panel-close grace also has an initial grace (15 s) for a host that never gets a panel. | A crashed panel must not leave a running host and a capture indicator. | 5.2, 5.8 |
| F11 | HTML i18n binder attributes are `data-i18n`, `-label`, `-tip`, `-hint` (not `-aria-label`/`-title`). | The patched i18n checker flags the latter (verified). | 8.1 |
| F12 | A keyed build is allowed only into `dist/`; an unkeyed build is secret-scanned by the build itself. | The check-release gate does not cover `dist/extension`. | 10.6 |
| F13 | Every lane start carries a cancel flag (host: per-run token checked after every await; SW: in-flight map). Stop goes panel -> `sw/lane-stop` -> `host/lane-stop`, and "stop wins" even when it lands before the host exists. | Review: a Stop during `getUserMedia`, the resume wait or `ensureOffscreen` was lost, leaving live capture, a spent Live session and a stale panel. | 5.6, 6.3, 6.11 |
| F14 | The overlay shadow root is CLOSED (D6 said open), mic captions go only to the tab you are looking at and default to OFF, and the privacy copy says captions are drawn into the page. | Review: an open root lets any page script read the user's own translated speech. See 14.4 change 1. | 5.6.3, 7.1, 8.5 |
| F15 | The SW serializes `ensureOffscreen`, `closeHost` and start orchestration with one promise-chain mutex; `sw/host-idle` never closes while a start is in flight (the host then repeats its report 3 s, 6 s and 12 s later, at most 3 times: 5.8); a zombie offscreen document is closed and recreated once. | Review: a close between mint and send turned a valid Start into `HOST_UNAVAILABLE`. | 6.3.1, 6.9 |
| F16 | The host tells the SW WHY it went idle (`panel-gone`, `initial-grace`); the SW writes `interp.lastStop.v1`; a reopened panel explains it; `sw/host-probe` reconciles a stale `up` flag. | Review: closing the panel or losing the renderer stopped everything silently. | 4.10, 5.8, 6.11 |
| F17 | A worker-driven timer seam (`engine/worker-timers.js`) is BUILT in v1 but OFF (`TIMER_MODE = 'realm'`); the gap line in the panel and overlay is the visible symptom of a starved uplink. | Review: K5 was masked by a checklist item that kept the graph audible. | 5.13, 14.1 K5 |
| F18 | The overlay gets a `status` frame (reconnecting / stopped), so captions never vanish without a reason on the page. | Review: overlay failure UX was invisible. | 4.5, 8.5.3 |
| F19 | `extension/lib/constants.js` holds the enum lists and range rules that `protocol.js` validates and `settings.js` normalizes (no import cycle, no duplicated rule). | Review: `protocol.js` imports nothing yet must validate settings-shaped payloads. | 3.1, 3.3 R4 |

---------------------------------------------------------------------------------------------------

## 3. Directory layout, ownership, import-graph rules

### 3.1 Source tree `extension/` (one owner group per file)

Groups: A = core tests + repo gates + build + manifest + `_locales` + docs; B = offscreen host, lanes, platform
shim, audio graph, pure settings/state/protocol modules; C = service worker, page controllers, chrome adapter,
i18n loader; D = overlay, page HTML/CSS, ext dictionaries, test fixtures. (Section 15 restates this per group.)

```
extension/
  manifest.json                        A  MV3 manifest (full JSON in 10.4). Copied to dist root.
  _locales/en/messages.json            A  manifest strings + overlay strings (9.3). Copied to dist/_locales.
  _locales/ko/messages.json            A
  _locales/ja/messages.json            A
  i18n/en.json                         D  ext.* dictionary (9.2). Flat dotted keys, string values.
  i18n/ko.json                         D
  i18n/ja.json                         D
  lib/builtin-key.js                   A  `export const BUILTIN_KEYS = Object.freeze([]);` (empty in git; 10.6)
  lib/links.js                         C  KEY_GUIDE_URL / KEY_USAGE_URL constants (parity-tested with app/config.js)
  lib/constants.js                     B  enum lists and range rules shared by protocol.js and settings.js (imports nothing)
  lib/protocol.js                      B  constants, message catalog, validators, sender classification, router
  lib/settings.js                      B  settings schema, defaults, normalize/migrate, key record helpers
  lib/ui-state.js                      B  LaneState/UiState builders, snapshot mapping, error-key resolution
  lib/caption-frames.js                B  caption frame builder + frame coalescer
  lib/chrome-adapter.js                C  the ONLY file that names `chrome` (besides overlay.js); 3.4
  lib/i18n.js                          C  extension i18n loader (merge app + ext dictionaries)
  lib/dom-i18n.js                      C  applyI18n(root, i18n): data-i18n binder for the page controllers
  background/service-worker.js         C  ENTRY: builds the adapter, calls createServiceWorker(...).register()
  background/sw-core.js                C  createServiceWorker({...}): all SW logic with injected adapter
  background/arming.js                 C  armed-tab bookkeeping over storage.session
  engine/host.html                     B  offscreen document skeleton (one module script)
  engine/host.js                       B  ENTRY: builds env + adapter, calls createLaneHost(...).start()
  engine/lane-host.js                  B  createLaneHost: lanes, messages, ports, settings, grace
  engine/lane-engine.js                B  createLaneEngine: one isolated config + sim engine + snapshot mapping
  engine/tab-lane.js                   B  createTabLane: graph + platform + engine (tab lane)
  engine/mic-lane.js                   B  createMicLane: platform + engine (mic lane)
  engine/audio-graph.js                B  createTabAudioGraph: passthrough + synthetic engine streams
  engine/platform-shim.js              B  createLanePlatform: D4 shim over createPlatform
  engine/worker-timers.js              B  createWorkerTimers + TIMER_MODE (5.13); default mode 'realm' (built, not switched on)
  engine/timer-worker.js               B  the ~20-line worker script behind worker-timers.js (side effect: sets onmessage)
  engine/overlay-hub.js                B  createOverlayHub: overlay ports + frame routing
  engine/panel-hub.js                  B  createPanelHub: panel ports + grace timer
  panel/panel.html                     D  side-panel skeleton (ids in 1.5 and 8.2)
  panel/panel.css                      D  panel-only classes on top of ../../styles.css
  panel/panel.js                       C  ENTRY: composition root of the panel
  panel/controller.js                  C  createPanelController: DOM binding + actions
  panel/view-model.js                  C  buildViewModel: pure state -> view model
  panel/host-link.js                   C  createHostLink: panel port lifecycle
  options/options.html                 D  options skeleton
  options/options.js                   C  ENTRY
  options/controller.js                C  createOptionsController
  permission/mic-permission.html       D  permission page skeleton
  permission/mic-permission.js         C  ENTRY
  permission/controller.js             C  createPermissionController
  pages.css                            D  shared by options and permission pages
  overlay/overlay.js                   D  classic-script IIFE (8.5)
```

Delivered: `git ls-files extension` lists exactly these 46 paths (compared by script on 2026-09-29; `EXPECTED_FILES` in `tests/extension-static.test.mjs` pins the same list). No file was added, renamed or dropped. Exports beyond the names in the later sections are listed where the module is described (3.5, 4.3, 4.6, 5.1, 7.2).

Files outside `extension/` that belong to this work (owner in brackets):

```
scripts/build-extension.mjs            A  build script (section 10)
scripts/check-i18n.mjs                 A  patched with the prepared patch (12.1)
scripts/stage-release.mjs              A  optional one-word `export` on readBuiltinKey (12.4)
.gitignore                             A  adds `dist/` (12.2)
package.json                           A  adds script `build:extension` (12.3)
docs/extension.md                      A  this document (polish only after implementation)
tests/*.test.mjs, tests/fixtures/*     see section 11 for the owner of each file (incl. tests/extension-tree.test.mjs, A, M3 only; tests/fixtures/extension-lanes.mjs, B, optional)
```

No file may be owned by two groups; no file outside this list may be created or edited (D14).

### 3.2 Build output `dist/extension/` (mirrors the repo layout, D9)

`dist/` is gitignored. The build copies; it never transforms code except the one built-in-key slot (10.6).

```
dist/extension/
  manifest.json                        <- extension/manifest.json (validated, re-serialized)
  _locales/{en,ko,ja}/messages.json    <- extension/_locales/**
  icons/icon-16.png                    <- copy of icons/favicon-16.png
  icons/icon-32.png                    <- copy of icons/favicon-32.png
  icons/icon-48.png                    <- exact 4x box downscale of icons/icon-192.png
  icons/icon-128.png                   <- exact 4x box downscale of icons/icon-512.png
  styles.css                           <- copy of styles.css (byte-identical; linked by panel, options, permission)
  app/**                               <- import-closure subset of app/ (10.3), plus app/audio/capture-worklet.js
                                          and app/i18n/{ko,en,ja}.json; NEVER app/main.js, app/security/builtin-key.js
  extension/**                         <- every file under extension/ EXCEPT manifest.json and _locales/**
```

The same relative specifier therefore resolves to the same file in Node tests (repo tree) and in Chrome
(`dist/extension`). Examples: `extension/lib/i18n.js` imports `../../app/i18n/index.js`; `panel.html` links
`../../styles.css`.

### 3.3 Import-graph rules (enforced by tests in `tests/extension-static.test.mjs` and by the build)

| # | Rule |
|---|---|
| R1 | `app/**` MUST NOT import or reference `extension/**` (dependency direction is extension -> app only). |
| R2 | `extension/background/**` MAY import (directly) only `extension/lib/**` and `extension/background/**`. No direct `app/**` import. The SW's transitive closure still contains the few small pure app modules that `lib/settings.js` and `lib/ui-state.js` import under R4 (`live-config.js`, `listen-state.js`, `shared-key.js` and their tiny dependencies); none of them touches a global at import time. |
| R3 | `extension/overlay/overlay.js` is a CLASSIC script: no `import`, `export`, dynamic `import(`, `require`; wrapped in one IIFE; parseable by `new vm.Script(source)`. It reads `chrome` as a global. |
| R4 | `extension/lib/**` MAY import `extension/lib/**` and exactly these app modules: `app/i18n/index.js`, `app/i18n/boot-fallback.js`, `app/providers/gemini/live-config.js`, `app/engine/listen-state.js`, `app/security/shared-key.js`. `chrome-adapter.js`, `links.js`, `builtin-key.js`, `constants.js` import nothing; `protocol.js` imports ONLY `lib/constants.js` (it validates `voiceGender`, target languages and the style ranges through the rules in `constants.js`, so it needs neither `settings.js` nor an app module, and there is no cycle: `settings.js` imports `protocol.js` and `constants.js`). Parity tests pin `constants.js` against the app (`LIVE_VOICE_GENDERS`, `CAPTION_SIZE` of `app/preferences.js`): section 11.1 `extension-settings`. |
| R5 | `extension/engine/**` MAY import `extension/lib/**`, `extension/engine/**` and exactly these app modules: `app/config.js`, `app/engine/sim.js`, `app/platform.js`, `app/providers/gemini/live-config.js`. |
| R6 | `extension/panel/**`, `extension/options/**`, `extension/permission/**` MAY import `extension/lib/**`, their own directory and exactly these app modules: `app/i18n/index.js`, `app/providers/gemini/live-config.js` (options only, for `LIVE_MODELS`/`LIVE_VOICE_GENDERS`), `app/security/shared-key.js` (options only, for `validateKey`). |
| R7 | Every import/export specifier and every `new URL('...', import.meta.url)` literal is relative (starts with `.`), ends in `.js`/`.json`, and resolves to a file inside the repo (`extension/`, `app/`) that the build will copy. No bare specifiers, no URLs, no `chrome-extension:`. |
| R8 | The identifier `chrome` (and `browser`) appears only in `extension/lib/chrome-adapter.js` (as the default of a parameter) and `extension/overlay/overlay.js`. Everything else receives an adapter by injection. The test matches IDENTIFIERS after stripping string literals, template literals and comments (a justification string that says "browser" must not fail it). |
| R9 | Import-purity: importing any module other than an ENTRY file (below) touches no global (`chrome`, `document`, `window`, `navigator`, `localStorage`, `AudioContext`, `fetch`, timers). Environment objects arrive as parameters with `globalThis.x` as the DEFAULT value only. |
| R10 | Entry files (side effects allowed): `extension/background/service-worker.js`, `extension/engine/host.js`, `extension/engine/timer-worker.js`, `extension/panel/panel.js`, `extension/options/options.js`, `extension/permission/mic-permission.js`, `extension/overlay/overlay.js`. (`timer-worker.js` is loaded only through `new URL('./timer-worker.js', import.meta.url)` in `worker-timers.js`, which the build's closure follows, 10.3.) |
| R11 | Extension code follows the repo's rules: no `console.`, no `eval`/`new Function`, no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`, no `importScripts`, no `debugger`, no `localStorage`/`sessionStorage`/`indexedDB`, text only through `textContent` and i18n keys, key-shaped strings absent, URL literals limited to `ENDPOINT_ORIGINS` and the documentation origins. `attachShadow` appears only in `overlay.js` and only with `mode: 'closed'` (D6 change, 14.4). |
| R12 | HTML files: every `<script>` has `type="module"` and `src`; no inline script text, no `on*` attributes, no remote URL, all `href`/`src` relative and resolvable; no literal text between tags (text comes from `data-i18n` attributes). `<title>` is empty in markup and set from JS. |
| R13 | Every source path segment matches `[A-Za-z0-9._-]+` (same rule as `stage-release.mjs SAFE_PATH`). |

### 3.4 The chrome adapter (interface between groups B, C, D and the real browser)

`extension/lib/chrome-adapter.js` (group C) exports:

```js
// ADAPTER_SURFACE has EXACTLY the shape of the adapter object (nested where the adapter is nested), so a test can
// walk both in parallel: an array = member names copied from that namespace; `true` = an event/member copied by name.
export const ADAPTER_SURFACE = Object.freeze({
  runtime:      ['id', 'getURL', 'sendMessage', 'connect', 'openOptionsPage', 'getContexts',
                 'onMessage', 'onConnect', 'onInstalled', 'onStartup'],
  storage:      { local: ['get', 'set', 'remove', 'setAccessLevel'], session: ['get', 'set', 'remove'], onChanged: true },
  tabs:         ['get', 'query', 'create', 'update', 'sendMessage', 'onRemoved', 'onUpdated', 'onActivated'],
  windows:      ['getCurrent'],
  tabCapture:   ['getMediaStreamId', 'getCapturedTabs'],
  sidePanel:    ['open', 'setPanelBehavior'],
  action:       ['onClicked'],
  commands:     ['getAll'],
  contextMenus: ['create', 'removeAll', 'onClicked'],
  offscreen:    ['createDocument', 'closeDocument'],
  scripting:    ['executeScript'],
  i18n:         ['getMessage', 'getUILanguage'],
});
export function createChromeAdapter(chromeApi = globalThis.chrome) { /* returns a frozen adapter */ }
```

`createChromeAdapter` returns a frozen object with the shape:

```
adapter.runtime        { id, getURL(path), sendMessage(message) -> Promise, connect({name}) -> Port,
                         openOptionsPage() -> Promise, getContexts(filter) -> Promise<Context[]>,
                         onMessage, onConnect, onInstalled, onStartup }   // events = chrome Event objects
adapter.storage        { local: { get, set, remove, setAccessLevel }, session: { get, set, remove },
                         onChanged }                                       // onChanged(changes, areaName)
adapter.tabs           { get, query, create, update, sendMessage(tabId, message, options) -> Promise,
                         onRemoved, onUpdated, onActivated }
adapter.windows        { getCurrent() -> Promise<Window> }
adapter.tabCapture     { getMediaStreamId({targetTabId}) -> Promise<string>, getCapturedTabs() -> Promise }
adapter.sidePanel      { open({windowId|tabId}) -> Promise, setPanelBehavior({openPanelOnActionClick}) -> Promise }
adapter.action         { onClicked }
adapter.commands       { getAll() -> Promise<Command[]> }                  // panel only: shows the ACTUAL shortcut (A11); Command.shortcut is '' when unassigned [A29]
adapter.contextMenus   { create(props), removeAll(), onClicked }
adapter.offscreen      { createDocument({url, reasons, justification}) -> Promise, closeDocument() -> Promise }
adapter.scripting      { executeScript({target, files}) -> Promise }
adapter.i18n           { getMessage(name, substitutions), getUILanguage() }
```

Rules:
- Each namespace is present only if `chromeApi` has it, and each MEMBER is copied only if the real namespace has
  it: a member absent from the real namespace is SKIPPED, never bound (a naive `fn.bind` on a missing method would
  throw at host start, before any listener exists, and every start would fail with `HOST_UNAVAILABLE`). In the
  offscreen document `chromeApi` has only `runtime` `[observed]`, and only some `runtime` members are known to exist
  there (`id`, `getURL`, `sendMessage`, `connect`, `onMessage`, `onConnect`); the others (`getContexts`,
  `openOptionsPage`, `onInstalled`, `onStartup`) are unobserved. Code MUST feature-detect (`adapter.tabs?.`,
  `adapter.runtime.getContexts?.`) where a context may lack a namespace or member and MUST NOT assume any namespace
  in the host except `runtime` nor any `runtime` member in the host beyond the six above.
- Methods are bound to their namespace. Methods not in `ADAPTER_SURFACE` are NOT copied (a test walks the adapter
  and the surface in parallel and asserts they match, so a new API use forces a doc and test change).
- Events are passed through unchanged (`addListener`, `removeListener`, `hasListener`).
- All request/response methods are the promise forms (minimum Chrome 116; `getMediaStreamId` promise form is 116+
  `[verified-doc]`). `contextMenus.create` takes the callback-less form.
- `adapter.runtime.id` is a string property; `getURL('')` returns the extension origin URL with a trailing `/`.
- The adapter is the seam for tests: `tests/fixtures/fake-chrome.mjs` (group D, 11.2) produces a `chrome`-shaped
  object per context that `createChromeAdapter` wraps unchanged. The offscreen fake's `runtime` is EXACTLY the six
  members above, so a host that touches any other member fails in the test, not in Chrome.

### 3.5 Shared constants (single source: `extension/lib/protocol.js`, group B)

```js
export const PROTOCOL_VERSION = 1;
export const PORT_NAMES = Object.freeze({ panel: 'interp-panel/1', overlay: 'interp-overlay/1' });
export const LANES = Object.freeze(['tab', 'mic']);
export const TARGETS = Object.freeze(['sw', 'offscreen', 'panel', 'content']);   // 'panel' is reserved, unused in v1
export const STORAGE_KEYS = Object.freeze({
  settings: 'interp.settings.v1', key: 'interp.key.v1',      // storage.local
  armed: 'interp.armed.v1', host: 'interp.host.v1',          // storage.session
  lastStop: 'interp.lastStop.v1',                            // storage.session: why the last run ended (4.10)
});
export const PATHS = Object.freeze({                          // extension-root relative, no leading slash
  sw: 'extension/background/service-worker.js', panel: 'extension/panel/panel.html',
  options: 'extension/options/options.html', host: 'extension/engine/host.html',
  permission: 'extension/permission/mic-permission.html', overlay: 'extension/overlay/overlay.js',
});
export const LIMITS = Object.freeze({
  maxFrameBytes: 8192,      // JSON.stringify(frame).length, hard cap for state/captions/style frames
  maxRowChars: 400,         // one caption row text, kept from the END (newest words)
  maxRows: 6,               // rows in one captions frame
  maxOverlayPorts: 4,       // simultaneously attached overlay tabs: the captured tab, the tab you look at, plus transition slack (LRU eviction)
  maxPanelPorts: 4,         // simultaneously connected panels (one per window)
  frameIntervalMs: 100,     // coalescing interval per lane and destination
  panelGraceMs: 3000,       // last panel port gone -> stop lanes
  panelInitialGraceMs: 15000, // host created but no panel port yet -> stop lanes and report idle
  statusLingerMs: 9000,     // after a lane ends in error, overlay ports stay open this long so the `status` frame can be read
  stopWaitMs: 4000,         // SW: how long a Start waits for a lane that is still 'stopping' (bounded poll, 6.3 step 3)
  startSettleMs: 3000,      // host: how long stop() waits for an in-flight start to notice its cancel flag
  streamIdMaxChars: 512, keyMaxChars: 512, titleMaxChars: 60,
  maxArmedTabs: 32,
});
```

The overlay (a classic script, no imports) duplicates `PORT_NAMES.overlay`, `PROTOCOL_VERSION`,
`LIMITS.maxRows`, `LIMITS.maxRowChars` in ONE frozen object literal named `WIRE` (`{ port, v, maxRows, maxRowChars }`).
The two sides are pinned WITHOUT a cross-group import (review: the old wording made group D depend on group B):
`tests/extension-overlay.test.mjs` (D) pins `WIRE` against literal values written in the test, and
`tests/extension-tree.test.mjs` (A, M3 only) pins `protocol.js` against the same literals and against the `WIRE`
text extracted from `overlay.js` (same technique as `tests/appearance-boot.test.mjs`).

Also exported by `protocol.js`: `SENDER_ROLES` (the seven roles of 4.4), `PROTOCOL_CODES` (`INVALID_MESSAGE`, `FORBIDDEN`, `UNKNOWN_TYPE`, `INTERNAL`), `MESSAGE_CATALOG` (the 13 rows of 4.2, each `{target, roles, errors}`) and `MESSAGE_TYPES`; the message, sender and frame functions are in 4.2-4.5. `lib/constants.js` (imports nothing) exports the enum lists and range rules both validators share: `VOICE_GENDERS`, `TARGET_LANGUAGES`, `UI_LANGUAGES`, the two-way pair rules `defaultPartnerLanguage` and `isLanguagePair` (7.2), `CAPTION_SIZE`, `clampCaptionSize`, `CAPTION_POSITIONS`, `CAPTION_DISPLAYS`, `ORIGINAL_VOLUME`, `STYLE_LIMITS`, `DEFAULT_STYLE`, `normalizeStyle`, `isValidStyle`, the patterns `MACHINE_CODE_PATTERN`, `KEY_PATTERN`, `HOST_ID_PATTERN` with `isMachineCode`, `MODEL_MAX_CHARS`, the LaneState vocabulary (`LANE_PHASES`, `ENGINE_STATUSES`, `OUTPUT_STATES`, `ROUTES`, `GAP_KINDS`, `OVERLAY_STATES`, `STATUS_PHASES`, `CAPTION_ROLES`, `CAPTION_STATUSES`) and the helpers `isPlainObject` and `deepFreeze`.

---------------------------------------------------------------------------------------------------

## 4. Protocols

Two planes (D7):
- Control plane = `runtime.sendMessage` / `tabs.sendMessage` request-response messages (4.1-4.4). Rare, small,
  validated, always `target`-addressed.
- Data plane = ports (`interp-panel/1`, `interp-overlay/1`) carrying small coalesced JSON frames (4.5-4.6).

Facts this protocol is built on `[observed]` unless tagged: `runtime.sendMessage` fans out to EVERY extension
frame except the sender's, and the first `sendResponse` wins; a `runtime.connect` port opened by a content
script is delivered directly to the offscreen document and to every other extension page that listens, with
`sender.tab.id` and `sender.frameId`, and works both ways without the SW; messages and frames are JSON-serialized
(typed arrays, `Map`, `Set`, `ArrayBuffer` do not survive; 64 MiB cap `[verified-doc]`); `disconnect()` by one
receiver only notifies the sender.

Facts NOT observed, which this protocol therefore tolerates instead of relying on: (1) what `sendMessage` does when
listeners exist but none responds (real Chrome is believed to reject with "The message port closed before a response
was received."; the scouts saw only fan-out delivery) `[assumption A24]`; (2) what `sender.url` holds for a message
sent from an MV3 service worker (Chrome's reference describes it for "page or frame" only) `[assumption A23]`.
Every caller therefore goes through one helper (`sendToHost` / `sendToSw`, 6.3) that maps a rejection, an
`undefined` result, a non-object and `{ok:false}` to a machine code, and success requires `res?.ok === true`.

### 4.1 Envelope

```jsonc
// request (sendMessage / tabs.sendMessage)
{ "v": 1, "target": "sw" | "offscreen" | "panel" | "content", "type": "<prefix>/<name>", /* payload fields */ }
// response
{ "ok": true,  /* data fields */ }
{ "ok": false, "code": "NEEDS_ARM" }          // code matches /^[A-Z][A-Z0-9_]{1,40}$/, never free text
```

- `type` prefixes equal the target: `sw/…` -> `sw`, `host/…` -> `offscreen`, `content/…` -> `content`.
  (`panel` is reserved: no v1 message uses it, but the router supports it.)
- Responses carry machine codes only. An exception inside a handler becomes `{ok:false, code:'INTERNAL'}`;
  its message is discarded (never logged, never returned).
- Unknown extra fields in a request are ignored and never forwarded.

### 4.2 Message catalog (control plane)

`sender roles` are the outputs of `senderRole()` (4.4). A handler MUST reject any other role with
`{ok:false, code:'FORBIDDEN'}`. JSON shown is the exact payload; all fields listed are required unless marked `?`.

| type | target | sender roles | payload | success response | error codes |
|---|---|---|---|---|---|
| `sw/lane-start` | sw | panel | `{lane:'tab'\|'mic', tabId?:int}` (`tabId` REQUIRED for `tab`, ignored for `mic`) | `{ok:true}` | `NEEDS_ARM`, `CREDENTIAL_REQUIRED`, `TAB_UNSUPPORTED`, `TAB_GONE`, `TAB_CAPTURE_BUSY`, `TAB_CAPTURE_FAILED`, `TAB_AUDIO_BLOCKED`, `HOST_UNAVAILABLE`, `ALREADY_RUNNING`, `LANE_STOPPING`, `START_CANCELLED`, `MICROPHONE_DENIED`, `MICROPHONE_UNAVAILABLE`, `SESSION_LIMIT`, `MODEL_UNSUPPORTED`, `INVALID_REQUEST`, `INVALID_MESSAGE`, `FORBIDDEN`, `INTERNAL` |
| `sw/lane-stop` | sw | panel | `{lane?:'tab'\|'mic'}` (absent = both) | `{ok:true}` (always, even when no host exists) | `FORBIDDEN`, `INVALID_MESSAGE` |
| `sw/permission-open` | sw | panel | `{}` | `{ok:true, tabId:int}` | `INTERNAL`, `FORBIDDEN` |
| `sw/host-probe` | sw | panel | `{}` | `{ok:true, up:boolean}` (reconciles a stale `interp.host.v1.up`, 6.11) | `FORBIDDEN` |
| `sw/host-idle` | sw | offscreen | `{hostId:string, reason:'panel-gone'\|'initial-grace'}` | `{ok:true, closed:boolean}` | `FORBIDDEN`, `INVALID_MESSAGE` |
| `host/ping` | offscreen | sw | `{}` | `{ok:true, hostId:string, protocol:1, lanes:{tab:Phase, mic:Phase}, tabId:int\|null, panels:int}` (`tabId` = the tab the tab lane is bound to) | `FORBIDDEN` |
| `host/lane-start` | offscreen | sw | see 4.2.1 | `{ok:true, epoch:int}` | as `sw/lane-start` minus `NEEDS_ARM` |
| `host/lane-stop` | offscreen | sw | `{lane?:'tab'\|'mic'}` (absent = both) | `{ok:true}` | `FORBIDDEN`, `INVALID_MESSAGE` |
| `host/settings` | offscreen | sw | `{settings:HostSettings}` (4.2.2) | `{ok:true}` | `INVALID_MESSAGE`, `FORBIDDEN` |
| `host/overlay-wanted` | offscreen | sw | `{tabId:int, active:boolean}` (`active` = the tab is the active tab of the last focused window) | `{ok:true, wanted:boolean, lanes:('tab'\|'mic')[]}` | `FORBIDDEN` |
| `host/overlay-result` | offscreen | sw | `{tabId:int, ok:boolean, lanes:('tab'\|'mic')[]}` (echo of the `lanes` that were wanted) | `{ok:true}` | `FORBIDDEN` |
| `host/tab-removed` | offscreen | sw | `{tabId:int}` | `{ok:true}` | `FORBIDDEN` |
| `content/overlay-attach` | content | sw | `{}` | `{ok:true}` (answered by the overlay) | `FORBIDDEN` |

`Phase` = `'off'|'starting'|'running'|'reconnecting'|'stopping'|'error'` (4.6).

Notes on the new rows (all review fixes):
- The panel's Stop, unchecking a lane checkbox and Cancel all send `sw/lane-stop`, NOT `host/lane-stop`: only the SW knows
  about a start that has not reached the host yet (6.3, 6.11), so a direct host message would be lost ("no host = nothing
  to stop") and the lane would start after the user pressed Stop. `host/lane-stop` is therefore SW-only.
- `sw/host-probe` exists so a panel that lost its port unexpectedly can make the SW compare `interp.host.v1.up` with
  reality (`getContexts` + a fresh ping) and record `lastStop` (6.11).
- `START_CANCELLED` is the answer of a start that a stop overtook (silent in the UI); `LANE_STOPPING` is the answer while
  the previous run of that lane is still being torn down (shown as a short "try again" notice, 6.3 step 3).

Which contexts see which messages (fan-out): a message with `target:'offscreen'` reaches the panel, options and
permission pages as well; their routers return `false` without touching the payload (4.3 step 1). This means
`host/lane-start` (which carries the key) is delivered to other EXTENSION pages, which are trusted but MUST NOT
read past `target`; it is never delivered to a content script (`runtime.sendMessage` from an extension context
does not reach content scripts) `[verified-doc]`.

#### 4.2.1 `host/lane-start` payload

```jsonc
{
  "v": 1, "target": "offscreen", "type": "host/lane-start",
  "lane": "tab",                                   // 'tab' | 'mic'
  "key": "<1..512 printable ASCII, /^[\\x21-\\x7e]{1,512}$/>",   // NEVER logged, never echoed
  "request": { "targetLanguage": "ko", "model": "gemini-3.5-live-translate-preview",
               "languages": ["ko", "en"] },        // `languages?` ONLY for a two-way lane: [targetLanguage, partnerLanguage]
  "voiceGender": "female",                         // 'female' | 'male'
  "muted": true,                                   // initial mute of the translated voice
  "captions": false,                               // captions on the page for this lane (default of the mic lane is false, 7.1)
  "style": { "size": 1.5, "position": "bottom", "display": "dark", "showSource": false,
             "maxLines": 3, "autoHideSeconds": 8 },
  "tab": { "tabId": 123, "streamId": "<1..512 chars>", "originalVolume": 65 }   // ONLY when lane === 'tab'
}
```

Validation (`validateMessage`): `lane` in LANES; `key` shape above; `request.targetLanguage` in `ko|en|ja`;
`request.model` a string of at most 64 chars (the HOST additionally requires it to be in `LIVE_MODELS`, else
the sim engine falls back to the default; the SW sends only values normalized by `normalizeSettings`);
`voiceGender` in `VOICE_GENDERS` of `lib/constants.js` (parity-tested against `LIVE_VOICE_GENDERS`); `tab` present iff
`lane === 'tab'`; `tab.tabId` integer >= 0; `tab.streamId` string of 1..512 chars; `tab.originalVolume` integer 0..100;
`style` checked with the ONE rule set of `constants.js` (`STYLE_LIMITS`, `isValidStyle`: size step 0.125 in 1..2,
`position`/`display` enums, `maxLines` 1..6, `autoHideSeconds` 0..60), the same rules `settings.js` normalizes with, so the
SW can never send settings the host rejects (4.2.2).
`request.languages` is OPTIONAL and is present only for a two-way lane (7.2 `laneRequestOf`): when present it MUST be an array of exactly two DISTINCT values of `ko|en|ja`
(`isLanguagePair` of `lib/constants.js`); anything else (`null`, a string, another length, a repeated or unknown language, a hole) is `INVALID_MESSAGE`, refused before any epoch is consumed
or any engine or capture exists, so a half-valid pair can never be guessed into a one-way session. The validator copies the pair (a new array of the two values) and does not require the first language
to equal `targetLanguage` (the SW always sends `[targetLanguage, partnerLanguage]`). The host hands the pair to the engine UNCHANGED (5.5 step 5). The `model` stays what the user chose: the ENGINE, not
the SW, moves a translation-only model to an instruction-driven one for a pair (5.12). There is NO `sourceLanguage` (always auto).

#### 4.2.2 `HostSettings` and `style`

```jsonc
{ "speechMuted": true,
  "tabOriginalVolume": 65,                          // int 0..100
  "captions": { "tab": true, "mic": false },
  "style": { "size": 1.5,                           // rem scale 1..2 step 0.125 (CAPTION_SIZE)
             "position": "bottom",                  // 'top' | 'bottom'
             "display": "dark",                     // 'dark' | 'light' | 'mono'
             "showSource": false,                   // include source rows in caption frames
             "maxLines": 3,                         // int 1..6, rows in the OVERLAY frame
             "autoHideSeconds": 8 } }               // int 0..60, 0 = never auto-hide
```

`host/settings` is applied immediately to a running host (mute, volume, captions on/off, style). It never
carries a key, a language or a model (those apply at the next `host/lane-start`). A captions flag turning ON does not
by itself put anything on a page: the SW compares the old and new settings and runs `considerOverlay` for that lane
(6.6). A flag turning OFF makes the host send `clear {lane}`, which also resets the overlay's dismissal (8.5.3).

### 4.3 The message router (`createMessageRouter`, group B, `extension/lib/protocol.js`)

```js
createMessageRouter({ runtime, target, handlers, roleOf? }) -> Readonly<{ dispose(): void }>
// runtime  = adapter.runtime (needs onMessage, id, getURL)
// target   = the ONE target this context answers to ('sw' | 'offscreen' | 'panel' | 'content')
// handlers = { [type]: async (message, sender, role) => responseObject }   // response WITHOUT 'ok': the router adds it; `message` is the sanitized copy from validateMessage
// roleOf   = (sender, runtime) => role, default senderRole (a seam for tests)
```

`runtime.onMessage` listener contract (each numbered step is tested):
1. If `message` is not a plain object, `message.v !== 1`, or `message.target !== target`: `return false` and do NOT
   call `sendResponse`. (Other contexts must stay silent so the first `sendResponse` is the right one.)
2. `validateMessage(message)`; on failure `sendResponse({ok:false, code:'INVALID_MESSAGE'})`, return false.
3. `role = senderRole(sender, runtime)`; if `role` is not in the catalog row's allowed roles:
   `sendResponse({ok:false, code:'FORBIDDEN'})`, return false. A content-script sender is `FORBIDDEN` for every type.
4. Look up `handlers[message.type]`; missing -> `{ok:false, code:'UNKNOWN_TYPE'}`.
5. Run the handler; `sendResponse({ok:true, ...result})` or, if it throws, `{ok:false, code}` where `code` is
   the thrown object's `code` if it matches `/^[A-Z][A-Z0-9_]{1,40}$/` else `'INTERNAL'`. Return `true`
   (asynchronous response) for every accepted message.
6. Never `console`, never rethrow, never include exception text.

### 4.4 Sender classification and validation

`senderRole(sender, runtime)` returns one of `'sw' | 'panel' | 'offscreen' | 'options' | 'permission' | 'content' | 'foreign'`:

| Check (in order) | Result |
|---|---|
| `sender?.id !== runtime.id` | `'foreign'` (another extension or a web page via externally_connectable: none exist, but reject anyway) |
| `origin` = `sender.origin`, else the origin of `sender.url` when it is a string that parses, else `null`; `origin` equals the extension origin (`runtime.getURL('')`). Origins are compared as `scheme://host` (the code does not use `URL.origin`, which reads the string 'null' for a non-special scheme in some runtimes and would make every unparsable origin look like one) | extension sender: if `sender.url` is a string, classify by its path prefix: `extension/background/` -> `'sw'`; `extension/panel/` -> `'panel'`; `extension/engine/` -> `'offscreen'`; `extension/options/` -> `'options'`; `extension/permission/` -> `'permission'`; anything else -> `'foreign'`. If `sender.url` is NOT a string (`[assumption A23]`: Chrome may leave it undefined for a service worker): `'sw'` when `sender.tab === undefined` and `sender.documentId === undefined` and `sender.frameId === undefined`, else `'foreign'`. |
| `origin` is `null` (no `origin`, unparsable or missing `url`) and `sender.tab === undefined` and `sender.documentId === undefined` and `sender.frameId === undefined` and `sender.id === runtime.id` | `'sw'` (same url-less rule; a content script always has `sender.tab`, so it can never reach this row) |
| `sender.tab` is defined and `origin` is NOT the extension origin | `'content'` |
| otherwise | `'foreign'` |

Notes: the options and permission pages are opened in tabs, so their `sender.tab` is defined; classification
therefore uses the ORIGIN first, never `sender.tab` alone. A content script's `sender.url` is the host page's URL.
The url-less `'sw'` rule is deliberately narrow and is hygiene, not a security boundary: every extension page is trusted
(it can call `chrome.*` itself); the boundary that matters is "a content script is never `'sw'`, `'panel'` or
`'offscreen'`", which holds because a content script always has `sender.tab` and a non-extension origin. The fake
browser has a mode where the SW sender has no `url` (11.2) and a manual check that a first Start does not fail with
an immediate `FORBIDDEN` (13.2).

Port acceptance (host side):
- Panel port: `port.name === PORT_NAMES.panel`, `senderRole(port.sender) === 'panel'`, and fewer than
  `LIMITS.maxPanelPorts` open. Else `port.disconnect()` immediately.
- Overlay port: `port.name === PORT_NAMES.overlay`, `senderRole(port.sender) === 'content'`,
  `port.sender.frameId === 0`, `Number.isInteger(port.sender.tab?.id)`, the host `canAccept(tabId)` policy (6.7,
  5.6) is true. Else `port.disconnect()` immediately. ONE port per tab: a second accepted port for a `tabId` REPLACES
  the first (the hub keeps `Map<tabId, port>`; it explicitly `disconnect()`s the old port and forgets it BEFORE
  registering the new one), and every `onDisconnect`/`onMessage` handler compares its own `port` object with the entry
  stored for that tab and does nothing when they differ, so a late disconnect of a replaced port can never delete or
  dispose the new one.
- Any other port name is ignored (NOT disconnected: another extension page may own it; a `disconnect()` from a
  non-owner only notifies the sender).
- Frames received on a port are validated the same way as messages; an invalid frame is dropped silently. The validator is `validateFrame(direction, frame)` (directions `panel->host`, `host->panel`, `overlay->host`, `host->overlay`, listed in `FRAME_TYPES` / `FRAME_DIRECTIONS`), which returns `{ok:true, frame}` with a frozen sanitized copy or `{ok:false}`; `makeFrame(type, payload)` builds a frame and throws `INVALID_MESSAGE` for one no receiver would accept; `validateUiState` and `validateLaneState` check the state payload (4.6.1).

Content-script side (overlay): `runtime.onMessage` accepts only `sender.id === chrome.runtime.id`, `sender.tab === undefined`,
`message.v === 1`, `message.target === 'content'`, `message.type === 'content/overlay-attach'`.

### 4.5 Ports and frames (data plane)

Versioned names: `interp-panel/1`, `interp-overlay/1`. A frame is `{ "v": 1, "type": "<name>", ... }`; size cap
`LIMITS.maxFrameBytes` (8192) of `JSON.stringify`; frames are plain JSON (numbers, strings, booleans, arrays,
objects; no `undefined`, no typed arrays).

Panel port `interp-panel/1` (opened by the panel, `chrome.runtime.connect({name})`):

| direction | frame | payload | notes |
|---|---|---|---|
| panel -> host | `hello` | `{}` | First frame. The host answers with the full current `state` and the latest `captions` frame of each lane. |
| host -> panel | `state` | `{state: UiState}` | On every significant change; coalesced (4.7). |
| host -> panel | `captions` | CaptionFrame (4.6.3), `maxRows` 4 | Per lane; coalesced. |
| host -> panel | `bye` | `{}` | Host is closing. |

Overlay port `interp-overlay/1` (opened by the overlay after `content/overlay-attach`, at most one open port per content script: 8.5.1):

| direction | frame | payload | notes |
|---|---|---|---|
| overlay -> host | `hello` | `{}` | First frame. Host answers `style` then the latest `captions` frame per wanted lane. |
| host -> overlay | `style` | `{style:{size, position, display, maxLines, autoHideSeconds}}` | Also on every style change. (`showSource` is applied host-side while building rows.) The style frame carries no text: overlay labels come from `chrome.i18n` (8.5.1). |
| host -> overlay | `captions` | CaptionFrame (4.6.3), `maxRows = style.maxLines` | Only lanes whose captions are enabled and routed to this tab (5.6). |
| host -> overlay | `clear` | `{lane}` | Lane ended or its captions were turned off: overlay drops that lane's ROWS (its status row stays) and resets that lane's dismissal (8.5.3). |
| host -> overlay | `status` | `{lane, phase}`, `phase` in `'reconnecting'\|'stopped'\|'running'` | Machine phase only (never a code or provider text). Sent when the lane starts replacing its session (`reconnecting`), when it is back (`running`), and BEFORE the `clear` of a lane that ended in error or without being asked to (`stopped`). A lane stopped by the user gets no `status`. The overlay renders one localized row per lane for `reconnecting` (until `running`) and for `stopped` (about 8 s), 8.5.3. |
| host -> overlay | `bye` | `{}` | Overlay removes its UI and closes the port. Immediate after a requested stop; after `LIMITS.statusLingerMs` for a lane that ended in error, so the `stopped` row can be read. |

The overlay never sends anything but `hello`. The panel never sends commands over its port (commands are
messages, 4.2); hot settings (volume, mute, captions on/off) travel as storage edits that the SW forwards as
`host/settings` (6.6).

### 4.6 Compact UI state and caption frames

#### 4.6.1 `LaneState` and `UiState` (built by `extension/lib/ui-state.js`)

```jsonc
// UiState  (whole object <= 2 KB; every string bounded)
{ "v": 1,
  "seq": 17,                          // int >= 1, +1 per emitted state frame from this host
  "hostId": "h-<=64 chars>",
  "speechMuted": true,
  "concurrent": 0,                    // int 0..2: lanes whose phase is starting|running|reconnecting
  "lanes": { "tab": LaneState, "mic": LaneState } }

// LaneState
{ "lane": "tab",
  "phase": "off",                     // 'off'|'starting'|'running'|'reconnecting'|'stopping'|'error'
  "engineStatus": null,               // null | 'idle'|'preparing'|'connecting'|'running'|'reconnecting'|'stopping'|'stopped'|'failed'
  "retries": 0,                       // int 0..3 (automatic session replacements)
  "output": null,                     // null | 'muted'|'ready'|'blocked'|'delayed'|'catching-up'|'unavailable'
  "model": null,                      // null | string <= 64
  "route": null,                      // null | 'translation'|'flash'
  "fallback": false,                  // registered model fallback replaced the requested model
  "targetLanguage": null,             // null | 'ko'|'en'|'ja'  (language of the RUNNING session)
  "errorCode": null,                  // null | /^[A-Z][A-Z0-9_]{1,40}$/ (terminal error of the last run)
  "quota": false,                     // errorCode in QUOTA_CODES
  "keyFailure": false,                // errorCode in KEY_FAILURE_CODES
  "level": 0,                         // int 0..100 input level meter (rms/0.25*100, clipped)
  "tabId": null,                      // null | int (tab lane only)
  "captions": false,                  // page captions requested for this lane
  "overlay": "unknown",               // 'unknown' | 'attached' | 'unavailable' (mic lane: about the tab you look at; reset when another tab becomes active)
  "gap": null,                        // null | 'input' | 'audio' | 'reception': the first sticky gap flag of the running session (panel gap line, K5)
  "epoch": 0 }                        // int >= 0, +1 per lane start on this host
```

Never included: `sessionId`, `generation`, `metrics`, raw captions, discovered models, tab URL or title, keys.

#### 4.6.2 Snapshot -> LaneState mapping (pure; `laneStateFromSnapshot`)

Input: the frozen `engine.snapshot()` of `app/engine/sim.js` (`status`, `output`, `errorCode`, `retries`,
`model`, `route`, `fallback`, `captions`, ...), the lane's host-level facts (`tabId`, `captions`, `overlay`,
`epoch`, `stopRequested`, `hostError`), the last level percent.

| Engine `status` | `phase` | notes |
|---|---|---|
| `idle`, `stopped` (after a requested stop), none | `off` | `errorCode` cleared unless `hostError` is set |
| `preparing`, `connecting` | `starting` | the host-level "acquiring the tab stream" step also reports `starting` (`engineStatus: null`) |
| `running` | `running` | |
| `reconnecting` | `reconnecting` | UI shows `ext.status.reconnecting` with `{count: retries}` (5.11; the web app's `sim.status.replacing` is engine jargon) |
| `stopping` | `stopping` | |
| `failed` | `error` | `errorCode = snapshot.errorCode`; `quota`/`keyFailure` computed from the code |
| `stopped` while `stopRequested === false` | `error` with `errorCode:'BROWSER_INTERRUPTED'` | the sim engine reports a capture interruption (tab track ended, `mute`, hidden document, or the 2 s no-frames watchdog after frames had flowed) as a normal stop with no code; the host recognizes it because it did not ask for the stop |
| a start cancelled by a stop (5.6) | `off` | never `error`; no `errorCode`; the start's own promise rejects `START_CANCELLED` |

`gap` = the first true flag of `snapshot.captions.gaps` in the order `input`, `audio`, `reception`, else `null`. The `input`
flag is set by the engine when the uplink queue drops stale frames (`app/engine/sim.js` `onDrop` -> `markGap('input')`), i.e. it
is the engine's own accounting of a starved uplink and therefore the visible symptom of throttled offscreen timers (K5, 5.13).

Exported constants (`extension/lib/ui-state.js`; besides these it exports `laneStateFromSnapshot`, `createIdleLaneState(lane)` and `buildUiState({hostId, seq, speechMuted, lanes})`, and `ACTIVE_PHASES` = `starting|running|reconnecting`, the phases that count as `concurrent`):

```js
export const LANE_PHASES = Object.freeze(['off','starting','running','reconnecting','stopping','error']);   // re-exported from constants.js
export const QUOTA_CODES = Object.freeze(['RATE_LIMITED','DAILY_LIMIT','TOKEN_LIMIT','UNKNOWN_429']);
export const KEY_FAILURE_CODES = Object.freeze(['CREDENTIAL_REQUIRED','CREDENTIAL_MISMATCH','INVALID_KEY','PERMISSION_DENIED']);
export const EXTENSION_ERROR_CODES = Object.freeze(['TAB_CAPTURE_FAILED','TAB_UNSUPPORTED','TAB_GONE',
  'TAB_CAPTURE_BUSY','TAB_ENDED','TAB_AUDIO_BLOCKED','TAB_INPUT_LOST','HOST_UNAVAILABLE','OVERLAY_UNAVAILABLE',
  'LANE_STOPPING','MICROPHONE_EXPIRED','STORAGE_FAILED']);
export const OVERRIDDEN_ENGINE_CODES = Object.freeze(['CREDENTIAL_REQUIRED','INVALID_KEY','PERMISSION_DENIED',
  'CREDENTIAL_FORBIDDEN','IP_DENIED','MODEL_UNSUPPORTED','RATE_LIMITED','DAILY_LIMIT','TOKEN_LIMIT','UNKNOWN_429',
  'SESSION_LIMIT','BUDGET_EXHAUSTED','INPUT_UNSUPPORTED','MICROPHONE_DENIED','MICROPHONE_UNAVAILABLE','BROWSER_INTERRUPTED']);
export const TAB_CAPTURE_CODES = Object.freeze(['MICROPHONE_DENIED','MICROPHONE_UNAVAILABLE','BROWSER_INTERRUPTED']);
export function errorKeyFor(code, has, lane = null) {
  /* lane === 'tab' and code in TAB_CAPTURE_CODES -> 'ext.error.TAB_INPUT_LOST' (the shared capture code path of the sim
     engine reports a tab-audio failure as a microphone code; showing the microphone text would send the owner debugging
     the wrong thing). Otherwise 'ext.error.<code>' if has(...), else 'error.<code>' if has(...), else 'error.unknown'. */
}
```

`errorKeyFor` deliberately has TWO levels (`ext.error.*` then `error.*`) and does NOT consult `sim.error.*`:
several `sim.error.*` texts mention phones, Safari, HTTPS or "Reopen session" and would mislead here. Every code
that needs different wording is in `OVERRIDDEN_ENGINE_CODES` (or `EXTENSION_ERROR_CODES` for codes the extension itself
produces) and has an `ext.error.<CODE>` key. Review findings behind the list: `error.DAILY_LIMIT` says "existing content
remains visible" (untrue: the overlay clears on error), `error.TOKEN_LIMIT` / `UNKNOWN_429` offer no next step,
`error.SESSION_LIMIT` says "check that the previous connection has closed" (wrong when two lanes share one key),
`error.MODEL_UNSUPPORTED` says "run connection diagnostics" (the extension has none), `error.STORAGE_FAILED` says "turn
saving off" (no such option), `error.IP_DENIED` / `error.CREDENTIAL_FORBIDDEN` speak of a venue network and a
connection path (hub wording). The lane argument exists because the sim engine's capture path is shared: it reports
a tab-audio failure (`MICROPHONE_UNAVAILABLE` after the 2 s no-frames watchdog, a track that is ended or muted at
start, a worklet error) and `BROWSER_INTERRUPTED` for the tab lane exactly as for the microphone. `TIMEOUT` is NOT
remapped for the tab lane: the engine raises it both for the 30 s capture setup and for a provider response timeout,
and the generic `error.TIMEOUT` text ("The response timed out. Please retry.") is correct for both. A tab-lane
`MICROPHONE_DENIED` cannot happen (the tab lane never asks for a microphone) and maps to `TAB_INPUT_LOST` defensively.

#### 4.6.3 Caption frame (built by `extension/lib/caption-frames.js`)

```jsonc
{ "v": 1, "type": "captions", "epoch": 3, "seq": 41, "lane": "tab", "lang": "ko",
  "rows": [ { "id": "t12", "role": "translation", "status": "final", "text": "…", "skipped": false },
            { "id": "t13", "role": "translation", "status": "partial", "text": "…", "skipped": false } ],   // a TWO-WAY lane's rows also carry "lang": "ko" | "en" | "ja" (rule 10)
  "gaps": { "input": false, "audio": false, "reception": false },
  "live": true }
```

`buildCaptionFrame({ captions, skippedSegments, lane, lang, epoch, seq, showSource, maxRows, live, languages })` rules (the same module exports `buildStyleFrame(style)`, the overlay's `style` frame without `showSource`, and `createFrameCoalescer`, 4.7):
1. `captions` is the engine snapshot's `captions` object or null. Null -> `rows: []`, all gaps false.
2. Keep rows with `role === 'translation'`; also `role === 'source'` only when `showSource` (source and translation
   rows are NOT paired: role-local segment ids, so rows are shown in first-arrival order, never side by side).
3. Row text = `sourceText` for source rows, `translatedText` for translation rows; drop rows whose trimmed text is empty.
4. Partition into `partial` and settled (`final`, `interrupted`). Keep all partials (at most one per role) and the
   newest `max(0, maxRows - partials)` settled rows; sort the kept rows by `order` ascending (chronological: newest last).
5. Row `id` = `segmentId` truncated to 64 chars; `text` is truncated to `LIMITS.maxRowChars` KEEPING THE END
   (`'…' + text.slice(-(max-1))`); `skipped` = `role === 'translation' && skippedSegments.includes(segmentId)`.
6. `gaps` copies `captions.gaps` (`input`, `audio`, `reception`; sticky for the whole session, as in the engine).
7. `maxRows` is clamped to `1..LIMITS.maxRows`. The panel uses 4, the overlay uses `style.maxLines`.
8. Size fit: if `JSON.stringify(frame).length > LIMITS.maxFrameBytes`, drop the OLDEST rows one by one; if a
   single row still does not fit, truncate row texts to 120 chars; the result always fits.
9. `epoch`, `seq` and `live` come from the caller (the host stamps `seq` at send time; it passes `live = phase === 'running' || phase === 'reconnecting'`); an unknown `lang` is emitted as `'en'` and an unknown `lane` throws `Error{code:'INVALID_REQUEST'}`.
10. Two-way (`languages` = a pair of two distinct `ko|en|ja`; anything else counts as one-way): the engine reports no language per row, so every row gets `lang`, guessed by `guessRowLanguage(text, pair, lang)` from the SCRIPT of the row's
    text (the text as drawn, after the truncation of rule 5): Hangul or kana decide `ko` or `ja` (the larger count wins a mixed row, so names or loanwords in Latin letters never turn a Korean or Japanese line into English), Han letters alone
    mean `ja`, Latin letters mean `en`. A guess that is not in the pair (Han alone in a `ko`/`en` pair, kana in a `ko`/`en` pair) or a row with no letter at all (digits, punctuation) takes the lane's own language `lang`, or the pair's first
    language when the lane's language is not in the pair. The frame's own `lang` is then the newest row's `lang` (the overlay draws one `lang` attribute per lane section, 8.5.3), the lane's language when there are no rows.
    A one-way frame has no row `lang` and is byte-for-byte what it was before. The validators (`captionRowOf` in `protocol.js`) accept an optional row `lang` in `ko|en|ja`; a row with any other `lang` refuses the frame. The pair itself
    never crosses a port (only the `lang` values do), and the host's caption memo includes the pair, so a run with another pair rebuilds its frames.

#### 4.6.4 The engine's `MAX_CAPTIONS`-scale data never crosses

The engine notifies subscribers on every audio chunk, caption and metric change and its snapshot embeds up to 100
settled rows of up to 16k characters each. Whole snapshots MUST NOT be forwarded. Change detection uses reference
identity of `snapshot.captions` (memoised per publish); state changes are deduped by JSON (4.7).

### 4.7 Coalescing and throttling

`createFrameCoalescer({ now, setTimeout, clearTimeout, intervalMs = LIMITS.frameIntervalMs, send })`
(in `extension/lib/caption-frames.js`) returns `Readonly<{ push(key, frame), flush(), dispose() }>`:
- One pending slot per `key` (`'state'`, `'captions:tab'`, `'captions:mic'`, plus a per-destination suffix used by
  the hubs). `push` replaces the pending frame of that key.
- Leading edge: if the last send for the key was at least `intervalMs` ago, send immediately; otherwise schedule a
  single trailing send at `lastSend + intervalMs`. Never more than one send per key per interval.
- Skip a send whose JSON equals the last sent JSON for that key, comparing `JSON.stringify(frame)` with the
  top-level `seq` property removed (dedupe; `seq` changes on every emission and must not defeat it).
- `send(key, frame)` is the caller's callback: the HOST assigns the outgoing `seq` there (one counter per frame
  family), so the coalescer stays pure.
- `flush()` sends every pending frame now (used before `bye`, before `clear`, at lane end, so the final state is
  never lost). `dispose()` cancels timers and drops pending frames.
- Level meter changes ride the normal state frame: they are throttled to 10 Hz and deduped like everything else.
- Timers come from injected `setTimeout/clearTimeout/now`; a late frame is harmless. The engine's own timers (uplink pump,
  player monitor, capture watchdog) are a separate, measured-later risk (5.13, section 14 K5).

### 4.8 What is forbidden to cross which boundary

| Item | Allowed only | Never |
|---|---|---|
| API key | inside one `host/lane-start` message (SW -> host); held in the host's per-lane config until the lane ends | any frame, any `content/*` message, `tabs.sendMessage`, `storage.session`, `UiState`, `LaneState`, response objects, error codes/messages, logs, DOM, `localStorage`, any file written by the build unless the explicit key flag is used (10.6) |
| Tab stream id | one `host/lane-start` message, consumed immediately by `getUserMedia` | stored, logged, re-sent, cached, sent to the panel |
| Audio (PCM, `MediaStream`, `Float32Array`) | inside the host realm only | any message or frame (typed arrays do not survive JSON) |
| Raw engine snapshot / caption store snapshot | inside the host | any message or frame (only `LaneState` and `CaptionFrame`) |
| Provider/raw error text | never leaves the engine | anything (only machine codes cross) |
| Tab URL / title | panel-local display (target line) and the SW's arming check | the host, frames, storage other than the origin string in `interp.armed.v1` |
| Settings key material | — | `host/settings` never contains `key` |

### 4.9 Error-code registry (machine codes that can cross)

- Engine codes (`ERROR_CODES` of `app/providers/contract.js`): passed through from `snapshot.errorCode` or an engine
  start exception (`error.code`), for example `CREDENTIAL_REQUIRED`, `INVALID_KEY`, `PERMISSION_DENIED`,
  `RATE_LIMITED`, `DAILY_LIMIT`, `TOKEN_LIMIT`, `UNKNOWN_429`, `SESSION_LIMIT`, `BUDGET_EXHAUSTED`,
  `MODEL_UNSUPPORTED`, `SETTINGS_UNSUPPORTED`, `NETWORK_ERROR`, `UNAVAILABLE`, `TIMEOUT`, `INPUT_UNSUPPORTED`,
  `SAFETY_BLOCKED`, `INVALID_RESULT`, `INVALID_REQUEST`. Capture codes: `MICROPHONE_DENIED`, `MICROPHONE_UNAVAILABLE`.
  Synthesized by the host: `BROWSER_INTERRUPTED` (see 4.6.2).
- Extension codes: `NEEDS_ARM` (not an error state: the panel shows the arm note), `TAB_UNSUPPORTED`, `TAB_GONE`,
  `TAB_CAPTURE_BUSY`, `TAB_CAPTURE_FAILED`, `TAB_ENDED`, `TAB_AUDIO_BLOCKED`, `TAB_INPUT_LOST` (tab lane only: the audio
  stopped arriving), `HOST_UNAVAILABLE`, `LANE_STOPPING` (the previous run of that lane is still being torn down; a
  short "try again" notice), `ALREADY_RUNNING` and `START_CANCELLED` (both ignored by the panel), protocol codes
  `INVALID_MESSAGE`, `FORBIDDEN`, `UNKNOWN_TYPE`, `INTERNAL` (rendered as `error.unknown`). Panel- and options-synthesized
  notice codes that never cross the protocol: `MICROPHONE_EXPIRED`, `STORAGE_FAILED`, `OVERLAY_UNAVAILABLE`.
- A code that matches no `ext.error.*` and no `error.*` key renders `error.unknown`.

### 4.10 `storage.session` shapes (written by the SW only; read by the panel and the SW)

```jsonc
// interp.armed.v1
{ "v": 1, "tabs": { "123": { "windowId": 1, "origin": "https://claude.ai", "at": 1790000000000 } } }
// at most LIMITS.maxArmedTabs (32) entries; the oldest `at` is evicted first. origin is null for opaque origins.
// interp.host.v1
{ "v": 1, "up": true, "hostId": "h-…", "at": 1790000000000 }   // up:false after the SW closes the document
// interp.lastStop.v1  (why the last run ended; written by the SW, read by the panel, removed by the SW at the next successful lane start)
{ "v": 1, "reason": "panel-gone" | "initial-grace" | "host-lost", "at": 1790000000000 }
// panel-gone / initial-grace come from `sw/host-idle {reason}`; host-lost is written by the SW itself when `sw/host-probe`
// finds `up:true` but no live offscreen document (renderer crash, manual close). The panel shows the notice only when `at` is
// within the last 60 s and no lane is running; it never contains a key, a stream id, a URL or any text.
```

`chrome.storage.session` is in-memory, cleared on browser restart / extension reload / update, and NOT exposed to
content scripts by default `[verified-doc]`. A test asserts nothing sensitive (key, stream id) is ever written there.

---------------------------------------------------------------------------------------------------

## 5. Lane host (offscreen document)

Owner: group B (all files under `extension/engine/` and the pure modules in `extension/lib/` that the host uses).
The host is the ONLY place where an engine, an `AudioContext`, a `MediaStream` or the API key exists.
Nothing here may reference a `chrome` global: the host receives `adapter` (only `adapter.runtime` exists in an
offscreen document `[observed]`) and `env` by injection.

### 5.1 Module map

| File | Export | Responsibility |
|---|---|---|
| `engine/host.js` (ENTRY) | none | `const realm = createRealmClock(globalThis); const engine = createEngineClock({ realm, Worker: globalThis.Worker }); createLaneHost({ adapter: createChromeAdapter(), env: createHostEnv(globalThis, engine), timers: realm }).start();` — the only side-effect module of the host (with `timer-worker.js`); `env.setTimeout/clearTimeout/now` are the ENGINE clock chosen by `TIMER_MODE` (5.13). |
| `engine/lane-host.js` | `createLaneHost`, `createRealmClock`, `createHostEnv` | message handlers, lane registry, hubs, coalescers, settings, grace, `sw/host-idle`; `createRealmClock(scope)` is the realm clock `{setTimeout, clearTimeout, now}` (arrow wrappers, so a native timer never gets a foreign `this`) and `createHostEnv(scope, clock)` builds the `env` of 5.2 from a global scope and the ENGINE clock. |
| `engine/lane-engine.js` | `createLaneEngine`, `createLaneController` | `createLaneEngine`: one isolated `createAppConfig` + `createSimEngine` per lane run; key install; voice; snapshot access; cleanup. `createLaneController({ lane, env, deps, timers, onChange, acquire, release })`: the start/stop state machine BOTH lanes share (cancel token per run, `abandon`, teardown order of 5.7, `LANE_STOPPING` / `ALREADY_RUNNING` refusal), so the rules of 5.6 exist once; `tab-lane.js` and `mic-lane.js` only supply `acquire` and `release`. |
| `engine/tab-lane.js` | `createTabLane`, `TAB_CAPTURE_INCLUDE_VIDEO` | tab stream acquisition, graph, platform, engine, tab-ended handling. |
| `engine/mic-lane.js` | `createMicLane` | microphone platform, engine, permission preflight. |
| `engine/audio-graph.js` | `createTabAudioGraph`, `RESUME_TIMEOUT_MS` | passthrough + synthetic engine streams (D3). |
| `engine/platform-shim.js` | `createLanePlatform` | D4 platform shim. |
| `engine/worker-timers.js` | `createWorkerTimers`, `createEngineClock`, `TIMER_MODE` | 5.13: worker-driven `setTimeout`/`clearTimeout`/`now` seam for the engine clock; default mode `'realm'` (not switched on). |
| `engine/timer-worker.js` | none | 5.13: the worker script (entry-like, R10). |
| `engine/overlay-hub.js` | `createOverlayHub` | overlay port registry and routing. |
| `engine/panel-hub.js` | `createPanelHub` | panel port registry, hello, broadcast, grace timer. |

### 5.2 `createLaneHost`

```js
createLaneHost({
  adapter,                  // { runtime }: the only namespace the host may touch
  env,                      // { AudioContext, AudioWorkletNode, navigator, WebSocket, fetch, setTimeout, clearTimeout,
                            //   now: () => number, random: () => number, isSecureContext }
  deps = {},                // overridable for tests; defaults are the real modules:
                            //   createAppConfig ('../../app/config.js'), createSimEngine ('../../app/engine/sim.js'),
                            //   createPlatform ('../../app/platform.js'), liveVoicePreference ('../../app/providers/gemini/live-config.js')
  hostId = `h-${random id}`,
  timers = env,             // { setTimeout, clearTimeout, now } used by hubs and coalescers (the REALM clock)
                            // `env.setTimeout/clearTimeout/now` are the ENGINE clock: the realm's by default, or the
                            // worker-driven ones when `host.js` runs with TIMER_MODE === 'worker' (5.13)
}) -> Readonly<{ start(): void, dispose(): Promise<void>, uiState(): UiState }>
```

`start()` (idempotent) registers, in this order: the message router (`target:'offscreen'`) on
`runtime.onMessage`; the port handler on `runtime.onConnect`; and arms the initial grace timer
(`LIMITS.panelInitialGraceMs` = 15000 ms: if no panel port connects in that time after the host was created, the
host stops all lanes and sends `sw/host-idle {reason:'initial-grace'}`, so a crashed panel cannot leave a running host). It performs NO
awaited work before the listeners are registered (the SW pings right after `createDocument` resolves).

Message handlers (all return response data WITHOUT `ok`; the router adds it):

| type | behavior |
|---|---|
| `host/ping` | `{hostId, protocol: 1, lanes:{tab: phase, mic: phase}, tabId: tabLane.facts().tabId, panels: panelHub.count()}` (`tabId` keeps the last run's tab id until the next start, so it is stale after the lane ended; whoever needs to know who WANTS an overlay asks `host/overlay-wanted`, which checks that the lane is active) |
| `host/lane-start` | 5.6.1 / 5.6.2. Returns `{epoch}` or throws `{code}` (router maps a thrown object with a valid `code`). While that lane's run has its cancel flag set and has not finished unwinding (phase `stopping`, also a start still inside its own `getUserMedia`) it throws `LANE_STOPPING` (never `ALREADY_RUNNING`, which is only for a run that is `starting`, `running` or `reconnecting` and not cancelled). Before it starts the lane, the handler applies the message's `muted`, `captions`, `style` (and, for the tab lane, `tab.originalVolume`) to the host settings like a `host/settings` would, except that speech mute is ONE flag: a lane that starts next to a running one follows the flag the host already has. |
| `host/lane-stop` | `lane` absent: stop both, else that lane (5.7). Always succeeds, ALSO when the lane is still `starting`: the stop sets the run's cancel flag, so a start that is inside `getUserMedia`, the resume wait or the permission query abandons itself (5.6). A stop that arrives before any start is a no-op (the SW re-sends it after the start answers, 6.3 step 7). The answer comes after an abandoned start has cleaned up, bounded by `LIMITS.startSettleMs` (3 s), so a Stop can take up to 3 s while `getUserMedia` hangs; `host/lane-start` answers after the engine START, not after `ready`. |
| `host/settings` | Replace `settings` (4.2.2): `speechMuted` -> both lanes' `setMuted`; `tabOriginalVolume` -> graph gain; `captions` -> lane overlay routing on/off (send `clear` when turned off; turning ON only re-enables routing: the SW attaches the overlay, 6.6); `style` -> push `style` frames to overlay ports and re-emit caption frames. |
| `host/overlay-wanted` | `lanes` = `['tab']` when (tab lane active && `captions.tab` && `tabLane.facts().tabId === message.tabId`), plus `'mic'` when (mic lane active && `captions.mic` && `message.active === true`). `wanted = lanes.length > 0 && (overlayHub.has(tabId) \|\| overlayHub.count() < LIMITS.maxOverlayPorts)`. Side effect: `active === true` records `micActiveTabId = tabId` (the tab you look at); `active === false` clears it when it equals `tabId`; a change of `micActiveTabId` re-routes the mic lane (5.6.3). So mic captions can NEVER be attached to a tab that is not the active tab of the last focused window. |
| `host/overlay-result` | Record the SW's attach outcome for `tabId`: `ok:false` -> every lane in `lanes` gets `overlay: 'unavailable'` (state frame; the mic lane's value is reset to `unknown` when `micActiveTabId` changes). For `ok:true` nothing (the port arriving marks `attached`). |
| `host/tab-removed` | If the tab lane is bound to `tabId`: `tabLane.stop({ error: 'TAB_ENDED' })`; if `micActiveTabId === tabId` clear it. |

Ports (`runtime.onConnect`): `panelHub.accept(port)` for `PORT_NAMES.panel`, `overlayHub.accept(port)` for
`PORT_NAMES.overlay`, anything else ignored (4.4).

State and frame emission (all through the coalescer, 4.7): on every lane change and every engine notification the
host recomputes the lane's `LaneState` (pure, `laneStateFromSnapshot`) and caption frames, and pushes them with
keys `state`, `captions:<lane>:panel`, `captions:<lane>:overlay`. `flush()` runs before `bye`, `clear`, lane end.

### 5.3 The tab audio graph (`createTabAudioGraph`, D3)

```js
createTabAudioGraph({ env, timers }) -> Readonly<{
  onEnded(fn: () => void): () => void,    // fires once when a raw track ends (tab closed / capture revoked); register it BEFORE attach
  attach(raw: MediaStream, { originalVolume }: { originalVolume: number }): Promise<void>,
                                          // rejects Error{code:'TAB_AUDIO_BLOCKED'}, or Error{code:'START_CANCELLED'} when stop() ran meanwhile
  createEngineStream(): MediaStream,      // a NEW MediaStreamAudioDestinationNode stream per call
  releaseEngineStream(stream: MediaStream): void,
  setOriginalVolume(percent: number): void,
  rawEnded(): boolean,                    // true when every raw audio track is already 'ended' (or there is none)
  stop(): Promise<void>,                  // raw tracks first, then disconnect, then close; idempotent; safe before attach and DURING attach
  snapshot(): { attached: boolean, contextState: string, volume: number },
}>
```

Graph (ONE `AudioContext` = `env.AudioContext()`, the "graph context"; it is never handed to the engine):

```
raw tab MediaStream --> MediaStreamAudioSourceNode (source) --+--> GainNode (gain = originalVolume/100) --> context.destination   [what the user hears]
                                                              +--> MediaStreamAudioDestinationNode (per engine start) .stream        [what the engine captures]
```

Rules:
- `attach` MUST be called in the same task as the `getUserMedia` resolution (no `await` in between): once a tab
  stream exists the tab's own audio is no longer played to the user `[verified-doc]`, so the passthrough must start
  immediately.
- `attach` FIRST (before creating anything, in the same synchronous turn) registers an `ended` listener on every raw audio
  track and, if every raw track is already ended, fires `onEnded` handlers: a track that ends while the resume wait below is
  pending (capture revoked, tab discarded) is therefore never missed (review). Then it creates the context, builds
  source -> gain -> destination, calls `context.resume()` and waits for it with a bound of `RESUME_TIMEOUT_MS = 1500`
  (timers injected). If `stop()` ran during that wait, `attach` rejects with `START_CANCELLED` (the stop already stopped
  the raw tracks and closed the context; `attach` creates nothing after it). If the context is not `running`
  afterwards, `attach` calls `stop()` (which stops the raw tracks, restoring the tab's audio) and rejects with an error
  whose `code` is `TAB_AUDIO_BLOCKED`. `AudioContext` needs no user activation in extension frames `[assumption A3]`.
- `originalVolume` is a percent 0..100 clamped to integers; gain = percent / 100 (linear). `setOriginalVolume`
  uses `gain.gain.setTargetAtTime(value, context.currentTime, 0.02)` when available, else assigns `.value`.
- `createEngineStream` creates a fresh destination node and connects `source` to it; the engine's capture stops the
  synthetic track when it finishes (`stream-capture` stops every track it was given), so each engine start needs its
  own destination. It throws if the graph is not attached or already stopped.
- `onEnded`: handlers may be added before `attach` (the lane does exactly that, 5.6.1 step 4) and are remembered; the raw
  tracks' `ended` listeners are installed by `attach` as its first act. The synthetic engine track never ends by itself,
  so this is the only way the host learns that the tab went away `[assumption A4]`. `rawEnded()` lets the lane re-check the
  raw tracks' `readyState` after every await.
- `stop` order: (1) `track.stop()` on every raw track (removes the capture indicator and restores direct tab
  audio), (2) disconnect source/gain/destinations, (3) `context.close()`. Each step is wrapped so a failure never
  blocks the next one.
- Audio context inventory in the host (5 at most, `[assumption A5]` on Chrome's per-document limit): tab lane =
  graph context + capture context (created by `stream-capture`) + playback context; mic lane = capture + playback.

### 5.4 The platform shim (`createLanePlatform`, D4)

```js
createLanePlatform({ env, getUserMedia }) -> platform   // frozen; shape consumed by app/audio/stream-capture.js
```

```js
const shimDocument = Object.freeze({ hidden: false, addEventListener() {}, removeEventListener() {} });
const shimEnv = {
  isSecureContext: true,
  navigator: { userActivation: { isActive: true }, mediaDevices: env.navigator?.mediaDevices },
  document: shimDocument,
  AudioContext: env.AudioContext, AudioWorkletNode: env.AudioWorkletNode,
  setTimeout: (fn, ms) => env.setTimeout(fn, ms), clearTimeout: (id) => env.clearTimeout(id),
  addEventListener() {}, removeEventListener() {},      // `page`: 'pagehide' must not interrupt the lane
};
const platform = createPlatform(shimEnv);               // app/platform.js, unchanged
return Object.freeze({ ...platform, ...(getUserMedia ? { getUserMedia } : {}) });
```

`env.setTimeout` / `env.clearTimeout` in the shim are the ENGINE clock (5.13): the capture watchdog (2 s) and setup timeout
(30 s) of `stream-capture.js` and the uplink pump of the engine all run on it.

Why (all `[assumption A2]` because offscreen behavior is unmeasured): an offscreen document has no user input, so
`navigator.userActivation.isActive` is expected to be false and `document.visibilityState` may be `hidden`;
`stream-capture` aborts on `!isUserActive()`, on `document.hidden`, and on `pagehide`. Real audio classes and real
timers stay real. `platform.getUserMedia` is overridden ONLY for the tab lane (5.6.1): the tab lane must never fall
through to a real microphone request. The spread copies the getter values of `createPlatform`'s result
(`offeredStream`, `inputDeviceId`); `stream-capture` reads neither.

### 5.5 The lane engine (`createLaneEngine`)

```js
createLaneEngine({ lane, deps, env, platform, onChange }) -> Readonly<{   // no `timers`: the engine clock is env.setTimeout/clearTimeout/now
  start({ key, request: { targetLanguage, model, languages? }, voiceGender, muted, sessionId }): { ready, done },  // throws Error{code}
  stop(): Promise<object | undefined>,     // resolves with the engine's lastResult
  setMuted(muted: boolean): void,
  resumeAudio(): Promise<boolean>,
  snapshot(): object | null,               // engine.snapshot() or null before start
  level(): number,                         // 0..100
  dispose(): Promise<void>,                // stop + engine.close + config.dispose + close playback context
}>
```

`start` sequence (D1: one `createAppConfig` per lane, isolated):
1. `config = deps.createAppConfig({ isolated: true, WebSocket: env.WebSocket, fetch: env.fetch })` (fresh per start:
   a changed key applies at the next start and `dispose` is clean; `storage` is omitted, so nothing is persisted).
2. `config.keyStore.setPersonal('gemini', key); config.keyStore.select('gemini', 'personal');` (the key is trimmed
   and validated upstream; `setPersonal` re-validates and throws `INVALID_KEY`).
3. `deps.liveVoicePreference.set({ gender: voiceGender })` (a module-level singleton shared by both lanes in this realm;
   D1 accepts one voice for both lanes; a change only affects sessions that start afterwards).
4. `engine = deps.createSimEngine({ router: config.router, sessionManager: config.sessionManager, platform,
   getAudioContext, resolveFallback: config.resolveFallback('gemini', 'live'), onLevel, now, setTimeout,
   clearTimeout, random })`, `engine.subscribe(onChange)`.
5. `engine.start({ targetLanguage, model, ...(languages === undefined ? {} : { languages }), ...(muted ? { muted: true } : {}) },
   { providerId: 'gemini', keySource: 'personal', sessionId })`. NO `sourceLanguage` (always auto), NO `signal` (the lane owns
   cancellation via `stop`); `languages` (the two-way pair of `host/lane-start`, 4.2.1) is passed UNCHANGED and only when the request has one. `sessionId` = `${lane}-${epoch}` (<= 256 chars).
   For a pair the sim engine (`app/engine/sim.js`, unchanged) validates it, builds ONE two-way instruction for the Live setup ("a live two-way INTERPRETER between A and B", `app/providers/gemini/live-config.js`) instead of a single
   translation target, and moves a translation-only `model` to the first instruction-driven model of its list (5.12). Its snapshot then reports the model it really runs (`model`, `route: 'flash'`, `fallback: false`: a chosen switch is
   not a fallback), which is what `LaneState` and the panel's route line show; the lane's `facts` also hold the pair (`facts().languages`, null for a one-way run) for the caption rows (4.6.3 rule 10).
6. Returns the engine's `{ready, done}`. A synchronous throw (`SESSION_LIMIT`, `MODEL_UNSUPPORTED`,
   `INVALID_REQUEST`) is rethrown as `Error{code}` after the config was disposed.

`getAudioContext` (per lane, called by the engine inside `start` before any await): creates the lane's OWN playback
context, first `new env.AudioContext({ sampleRate: 24000 })`, falling back to `new env.AudioContext()`; remembers it
for `dispose`. It is never shared with the other lane or with the passthrough graph, because `engine.setMuted(true)`
suspends the context returned by `getAudioContext()` (hard mute) and would silence anything else on it.

`level()`: `Math.min(100, Math.round(rms / 0.25 * 100))` from the engine's `onLevel({rms})` (coalesced by the
host at 10 Hz; `0.25` = LEVEL_FULL_SCALE_RMS of the web app).

`stop()`: `await engine.stop()` (capture cancelled, session closed and physically shut down), then
`engine.close()`, `config.dispose()`, `playbackContext.close()`. All wrapped: failures are swallowed.

### 5.6 The lanes

Both lanes implement the same contract (`createTabLane` / `createMicLane`, both `({ env, deps, timers, onChange })`, the tab lane also `includeVideo = TAB_CAPTURE_INCLUDE_VIDEO`; both are `createLaneController` with a lane-specific `acquire` (steps 3-6 of 5.6.1, steps 2-3 of 5.6.2) and `release`; `params` of `start` = the validated `host/lane-start` message plus the host-assigned `epoch`):

```js
Readonly<{
  lane: 'tab' | 'mic',
  start(params): Promise<{ epoch: number }>,       // rejects Error{code} (never a raw exception)
  stop(options?: { error?: string }): Promise<void>,   // idempotent; runs 5.7; valid in EVERY phase, including 'starting'
  setMuted(muted: boolean): void,
  setOriginalVolume(percent: number): void,        // tab lane applies it to the gain; mic lane no-op
  phase(): Phase,
  facts(): { tabId: number | null, epoch: number, targetLanguage, hostError: string | null, stopRequested: boolean,
            starting: boolean /* acquiring the input */, stopping: boolean /* the whole teardown */ },
  snapshot(): object | null,                       // engine snapshot
  level(): number,
  dispose(): Promise<void>,
  refusal(): string | null,                        // the code a start would be refused with right now ('LANE_STOPPING' | 'ALREADY_RUNNING'), or null; consumes nothing
  currentRun(): object | null,                     // internal seam of tab-lane.js (the run that holds the graph)
  isActive(): boolean,                             // phase is starting|running|reconnecting
}>
```

Start/stop concurrency rules (review issue "no stop is honored while a start is in flight"; F13; each rule is a test in `extension-lanes`):

- Every ACCEPTED start creates a run `{ epoch, cancelled: false }` and keeps its promise in `startPromise`. `stop()` sets `run.cancelled = true` on the current run FIRST, in every phase (also `starting`), then tears down whatever exists.
- `start` re-checks `run.cancelled` after EVERY await (mic: the permission query; tab: `getUserMedia`, then `graph.attach`) and on a hit runs `abandon(run)`: the full 5.7 teardown of everything the run created so far (raw tracks, graph, engine streams, engine, contexts), phase `off` (never `error`), and rejects with `Error{code:'START_CANCELLED'}`. A stream that resolves AFTER the stop (a `getUserMedia` that was pending) is stopped by the `abandon` path: no raw track and no capture indicator survive a cancelled start.
- `stop()` on a `starting` lane also awaits `startPromise` (bounded by `LIMITS.startSettleMs`, injected timers) before it reports phase `off`, so when `stop()` resolves nothing created by the abandoned run is still alive. The start itself never calls the public `stop()` (it would await its own promise): it calls the internal `abandon(run, options)` = the teardown of 5.7 steps 1-4 and 6 WITHOUT the step-5 wait; the public `stop()` = `abandon` + that wait.
- `start()` while the lane phase is `starting|running|reconnecting` rejects `ALREADY_RUNNING`; while it is `stopping`, or its run has the cancel flag set and has not finished unwinding (a start that a Stop overtook but that is still inside `getUserMedia`), it rejects `LANE_STOPPING` (a Stop followed at once by Start, the natural way to change the language, must not be silently dropped: the SW waits for the lane to settle before minting, 6.3 step 3).
- `epoch` = the host's counter incremented once per accepted lane start (used by frames and by the overlay's "hide until next session" rule).

#### 5.6.1 Tab lane start (steps are in this exact order)

1. `run` created; `phase = 'starting'`, `facts.tabId = tab.tabId`, emit state (flush).
2. Preflight: none for the tab (the SW already checked arming and minted).
3. `raw = await env.navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab',
   chromeMediaSourceId: streamId } } })` (audio only). The exported constant `TAB_CAPTURE_INCLUDE_VIDEO = false`
   switches the fallback shape that also passes the same `mandatory` object under `video` (the doc example passes
   both) — flip only if the manual check fails `[assumption A6]`; with it on, every video track is stopped
   immediately after acquisition. On rejection: if `run.cancelled` -> `START_CANCELLED`; else phase `error`,
   `hostError = 'TAB_CAPTURE_FAILED'`, throw `Error{code:'TAB_CAPTURE_FAILED'}`. `streamId` is a local; it is never
   stored, logged or re-used. On success, in the SAME synchronous turn: `if (run.cancelled)` stop every track of `raw`
   and throw `START_CANCELLED`.
4. Still in the same synchronous turn (no `await` between 3 and 4): create the graph, register `graph.onEnded(() =>
   stop({ error: 'TAB_ENDED' }))` FIRST, then `await graph.attach(raw, { originalVolume })`. Registering before the
   await means a raw track that ends during the resume wait is noticed (the previous order registered it afterwards and
   would have kept streaming silence). On rejection `TAB_AUDIO_BLOCKED`: `graph.stop()` (restores tab audio), phase
   `error`, rethrow; on `START_CANCELLED` the stop already tore the graph down: rethrow.
5. After the attach: `if (run.cancelled)` -> `await graph.stop()`, throw `START_CANCELLED`; `if (graph.rawEnded())` ->
   `await abandon(run, { error: 'TAB_ENDED' })` and throw `Error{code:'TAB_ENDED'}` (`abandon`, not `stop`: see the rules above).
6. `platform = createLanePlatform({ env, getUserMedia: async () => graph.createEngineStream() })`.
7. `engineLane.start({ key, request, voiceGender, muted, sessionId })`. On throw: full stop (5.7), phase `error`,
   `hostError = error.code`, rethrow with that code.
8. `handle.done.then(onEngineDone)`; `onEngineDone(result)`: if `stopRequested` -> phase `off`; else if
   `result.status === 'failed'` -> phase `error` (code from `result.errorCode`), then tear the graph down (a dead
   lane must not keep capturing); else (`stopped` without request) -> `error` `BROWSER_INTERRUPTED` and tear down.
9. Return `{ epoch }` right after step 7 (do NOT wait for `ready`; the Live setup can take seconds and its outcome is
   reported through state frames).

#### 5.6.2 Mic lane start

1. `run` created; `phase = 'starting'`, emit state (flush).
2. Preflight: if `env.navigator.permissions?.query` exists, `await query({ name: 'microphone' })`; then
   `if (run.cancelled)` -> `START_CANCELLED` (nothing exists yet, the lane returns to `off`). When the state is
   `denied` or `prompt`, throw `Error{code:'MICROPHONE_DENIED'}` (phase `error`) WITHOUT starting the engine: the
   host cannot show a prompt `[verified-doc]`. A missing or throwing `permissions.query` proceeds to step 3.
3. `platform = createLanePlatform({ env })` (real `navigator.mediaDevices.getUserMedia`, extension-origin permission).
4. `engineLane.start(...)`; a capture failure arrives later as `errorCode` `MICROPHONE_DENIED` /
   `MICROPHONE_UNAVAILABLE` through the snapshot (phase `error`). A stop that lands while the engine's own capture is
   inside `getUserMedia` is handled by the engine (`stream-capture` stops a stream that arrives after `finish`).
   Return `{ epoch }`.

#### 5.6.3 Caption routing

- Panel: every connected panel port receives the frames of BOTH lanes (`maxRows` 4).
- Overlay, tab lane: only the port whose `tabId === tabLane.facts().tabId`, only while `captions.tab` is on. This tab may
  be a background tab (it is the tab whose audio is captioned); the overlay itself renders nothing while
  `document.visibilityState === 'hidden'`.
- Overlay, mic lane (your own translated speech, private to you): only the port whose `tabId === micActiveTabId` (the
  active tab of the last focused window, recorded by `host/overlay-wanted {active}`, 5.2), only while `captions.mic` is
  on. It is NEVER sent to a background tab. When `micActiveTabId` changes, the host sends `clear {lane:'mic'}` to the
  previous port (and closes it with `bye` when no lane needs it) and the latest mic caption frame to the new port.
  Switching WINDOWS without switching tabs does not move the mic captions (v1 limitation: the SW listens to tab events,
  not window focus).
- Live enable: setting `captions.<lane>` to true only re-enables routing on ports that exist; attaching an overlay to a
  page is the SW's job and it does it when it sees the setting flip (6.6).
- `LaneState.overlay`: `attached` when the lane routes to at least one open port; `unavailable` after a
  `host/overlay-result {ok:false}` naming this lane; else `unknown`.
- `status` frames (4.5): the host sends `status {lane, phase:'reconnecting'}` to the ports the lane feeds when the lane phase
  becomes `reconnecting`, `status {lane, phase:'running'}` when it is back, and `status {lane, phase:'stopped'}` before the
  `clear` of a lane that ended in error or without being asked to.
- When a lane's captions setting turns off, or the lane ends, the host sends `clear {lane}` to the ports it was
  feeding; a port that no lane needs any more gets `bye` and is closed by the host (after `LIMITS.statusLingerMs` when
  the lane ended in error).
- The hub forgets a port at once when it tells it `bye`, but disconnects it from its side only 250 ms later (`closeDelayMs`: a frame posted in the same turn as `disconnect()` may be dropped, whether real Chrome delivers it is unverified, and the overlay closes its own port on `bye` anyway); only a REPLACED port is disconnected immediately.
- A lane that ended in `error` keeps showing what it last said in the panel preview (8.2.3 rule 16): the last caption frame of THIS run (same epoch) stays, marked `live:false`; a requested stop sends an empty frame; another run's rows are never shown. After a run the lane keeps only a slim snapshot (status, error, model, route; no captions) and forces a status that is not terminal to `stopped`.

#### 5.6.4 Mute, unmute and blocked output

`speechMuted` is one global flag applied to both lanes (`lane.setMuted`). Both lanes start with
`muted: settings.speechMuted` (default true: captions only). Unmuting calls `engine.setMuted(false)` and then
`engine.resumeAudio()`. If the playback context stays suspended (autoplay policy: unverified in offscreen
documents, `[assumption A3]`) the engine reports `output: 'blocked'`, the panel shows `ext.output.blocked` (NOT the web
app's `sim.output.blocked`, which tells the user to press the very button they just pressed), and captions continue;
v1 has no other remedy (see K3 in section 14). Checklist 13.7 records the blocked/unblocked outcome explicitly. A mute toggled while a start is still acquiring its input has no engine to act on yet: the lane applies its newest value when the engine is created.

### 5.7 Stop and cleanup order (both lanes; each step swallows its own failure)

1. `run.cancelled = true` (a start still in flight abandons itself, 5.6), `stopRequested = true`; phase `stopping`; emit
   state (flush).
2. `engineLane.stop()`: cancels capture, uplink and player, closes the Live session physically, closes the engine,
   the config (key store, session manager) and the lane's playback context. (No engine exists yet for a run that was still
   inside `getUserMedia` or the resume wait: this step is then a no-op.)
3. Tab lane only: `graph.stop()` (raw tracks stopped -> the tab's own audio returns and the capture indicator
   disappears; then nodes disconnected; then the graph context closed). A no-op when the graph does not exist yet; when the
   graph is mid-`attach` it makes `attach` reject `START_CANCELLED`.
4. Overlay: when the lane ended in error or the stop was not asked for: `status {lane, phase:'stopped'}` (flush), then
   `clear {lane}` (flush); `bye` + close for ports no lane needs (immediately after a requested stop, after
   `LIMITS.statusLingerMs` after an error).
5. Public `stop()` only (not `abandon`): if `startPromise` is still pending, await it (bounded by `LIMITS.startSettleMs`): the abandoned start must finish its own
   cleanup of streams it created after the stop. Phase becomes `off` (or `error` when `options.error` / a terminal
   `errorCode` exists); emit state (flush).
6. If no lane is active and no panel port exists, arm the grace timer (5.8).

Failure to complete step 2 or 3 never prevents steps 4-6. `dispose()` of the host = `stop()` of both lanes, hubs
closed, listeners removed.

### 5.8 Panel hub and disconnect grace

```js
createPanelHub({ runtime, timers, graceMs = LIMITS.panelGraceMs, initialGraceMs = LIMITS.panelInitialGraceMs,
                 maxPorts = LIMITS.maxPanelPorts, rearmBaseMs = 3000, maxRearms = 3,
                 onHello, onAllGone, roleOf }) -> Readonly<{ accept(port): boolean, broadcast(frame): void,
                     sendTo(port, frame): boolean, count(): number, armInitialGrace(): void, armGrace(): void,
                     rearm(reason): boolean, dispose(): void }>
// `runtime` gives senderRole its id and origin; `roleOf` is a seam for tests; `sendTo` is the hello reply; `armGrace()` is 5.7 step 6
```
- `accept` validates (4.4), registers, listens to `onMessage` (`hello` -> `onHello(port)`, which sends the full state
  and the latest captions frames) and `onDisconnect`. A new accepted port cancels any pending grace timer.
- When the LAST panel port disconnects, a `graceMs` timer starts; on expiry `onAllGone('panel-gone')` runs: the host stops all
  lanes (5.7) and sends `runtime.sendMessage({ v:1, target:'sw', type:'sw/host-idle', hostId, reason:'panel-gone' })`. The
  initial grace (no panel ever connected) does the same with reason `'initial-grace'`. If that send rejects, the host retries
  it once after 500 ms (injected timers). The report is one-shot per absence, so an answer that is not final would leave an idle
  offscreen document (and `interp.host.v1.up`) for good: an answer of `{closed:false}` (the SW still saw a start of its own in
  flight, 6.9), or two failed sends, make the host call `panelHub.rearm(reason)`, which arms ONE more report of the same reason
  on the injected clock after 3 s, then 6 s, then 12 s, at most 3 repeats in all (4 asks, about 21 s of coverage; constants
  `REARM_BASE_MS = 3000`, `MAX_REARMS = 3`, overridable through `rearmBaseMs` / `maxRearms`). `{closed:true}` and a refusal
  (`ok:false`: `FORBIDDEN`, `INVALID_MESSAGE`) are final and never repeated. Any accepted panel port cancels a pending repeat and
  resets the chain (a panel that connects is a fresh start for the whole report cycle, and its own disconnect arms its own grace);
  `dispose()` cancels it too. After the cap a lost report is reconciled by the panel-side `sw/host-probe` and the next Start (6.11).
- `broadcast(frame)` sends to every port; per-port dedupe of identical JSON; a `postMessage` that throws removes the port.
- The hub never relies on `sidePanel.onClosed` (fires for "replaced" too, Chrome 142+): only a real port
  disconnect counts. Whether a panel that is merely HIDDEN by another side-panel entry keeps its port is NOT known
  `[assumption A21]`: the design is correct either way. If the hidden panel keeps its port, its lanes keep running. If it
  drops the port, the lanes stop after the 3 s grace and the reopened panel shows `ext.notice.panelGone` (`interp.lastStop.v1`,
  4.10); the user-facing copy therefore says "closing (or hiding) this panel also stops interpretation" only as
  `ext.panel.closeStops` (closing) and the how-to `ext.howto.keepOpen` (keep the panel open while interpreting). Checklist
  13.17 records which of the two happens and the fallback if it is the second one (K22).

### 5.9 Reconnect, isolation and the one-lane-fails rule

- Reconnect: the sim engine already replaces a broken Live session at most three times (1/2/4 s, counter resets
  after 60 s stable). The host adds NO retry and NO automatic restart after a terminal error (every restart spends
  quota; the user presses Start). During replacement `phase` is `reconnecting` and `retries` counts 1..3; the tab
  capture and the passthrough keep running untouched.
- `RATE_LIMITED`, `DAILY_LIMIT`, `TOKEN_LIMIT`, `UNKNOWN_429`, `INVALID_KEY`, `PERMISSION_DENIED`,
  `CREDENTIAL_*`, `SAFETY_BLOCKED` are terminal at once in the engine (`NO_REPLACEMENT_CODES`); the lane goes to
  `error` with that code and `quota` / `keyFailure` flags.
- Model fallback (`3.8-live` -> `translate-preview` -> `native-audio`, forward only, on `MODEL_UNSUPPORTED`,
  `SETTINGS_UNSUPPORTED`, `UNAVAILABLE`, `NETWORK_ERROR`) is surfaced as `fallback: true` with the new `model`/`route`.
- One lane failing (start error, engine `failed`, tab ended, interruption) affects ONLY that lane object: the
  other lane's engine, config, graph, contexts and ports are untouched. The only actions that stop both lanes are
  `host/lane-stop` without `lane`, panel-gone grace, and `dispose()`.
- Two lanes = two `createAppConfig({isolated:true})` = two Live sockets on one key. Google's concurrent-session
  limit is not documented in this repo; when hit it arrives as `SESSION_LIMIT` (only with a structured
  `ConcurrentSessions` quota failure) or as a 429-family code `[assumption A9]`. `SESSION_LIMIT` is in
  `live-recovery`'s retryable set and NOT in `NO_REPLACEMENT_CODES` (read on 2026-09-29: `app/engine/live-recovery.js`
  lines 5-6, `app/engine/sim.js` lines 34-36), so a concurrent-session refusal is retried up to three times (1/2/4 s) and
  then ends as `BUDGET_EXHAUSTED`, which reads like a network problem. The extension does not change that engine behavior
  (D14); it compensates in copy: with both lanes enabled, `BUDGET_EXHAUSTED` is treated as quota-suspect and its text says
  to try again with one interpretation (5.11, 8.2.3 rule 12).

### 5.10 Tab closed or navigated

- Tab closed: Chromium ends the capture, the raw track fires `ended` -> `graph.onEnded` -> `tabLane.stop({error:'TAB_ENDED'})`.
  The SW also forwards `tabs.onRemoved` as `host/tab-removed` (belt and braces).
- Same-origin navigation: the grant stays; the capture continues; the SW re-attaches the overlay to the new document
  (6.7).
- Cross-origin navigation: Chromium clears the per-tab grant (`[verified-doc]`); whether an already running
  capture survives is unverified for the `getMediaStreamId` path `[assumption A7]`. Either the capture continues
  (lane keeps running, the SW clears the armed record, a later Start needs re-arming) or the track ends
  (`TAB_ENDED` path). Both are correct behavior.
- An overlay port disconnecting is NOT a stop signal (navigation disconnects it too); the host just forgets the port.

### 5.11 Snapshot -> UI mapping, status vocabulary, error -> i18n

The panel derives every label from `LaneState` (4.6.1). Vocabulary (existing app keys reused verbatim where the wording is
right for an extension, `ext.*` where a review found it wrong):

| LaneState | Text key |
|---|---|
| `phase:'off'`, no error | `sim.status.idle`; `ext.status.off` when the lane's checkbox is off (a switched-off lane is not "ready to start") |
| local `awaiting` (Start pressed, waiting for the toolbar-icon click; panel-local, never in `LaneState`) | `ext.status.awaitingArm` (nothing is being "checked": the flow is blocked on the user) |
| `phase:'starting'`, `engineStatus` `preparing` or null | `sim.status.preparing` |
| `phase:'starting'`, `engineStatus:'connecting'` | `sim.status.connecting` |
| `phase:'running'` | `sim.status.running` |
| `phase:'reconnecting'` | `ext.status.reconnecting` with `{count: retries}` ("connection lost, reconnecting (n/3), captions may pause": the web app's `sim.status.replacing` is engine jargon with no hint that it is automatic) |
| `phase:'stopping'` | `sim.status.stopping` |
| `phase:'error'`, code `TAB_ENDED` / `TAB_GONE` | `sim.status.stopped` (not an alarm) plus the notice below |
| `phase:'error'`, any other code | `ext.status.failed` ("interpretation failed"; `sim.status.failed` says "Listening failed", a listen-mode word) plus the notice below |
| `output` `blocked` | `ext.output.blocked` ("Chrome blocked playback of interpreted speech from this extension. Captions continue."; NOT the web app's `sim.output.blocked`, which tells the user to press the button they just pressed) |
| `output` `delayed` / `catching-up` / `unavailable` | `sim.output.delayed` / `.catching_up` / `.unavailable` (dash becomes underscore); `muted` and `ready` are not shown per lane (the global mute note covers `muted`) |
| `gap` `input` / `audio` / `reception` | `ext.gap.input` / `sim.gap.audio` / `sim.gap.reception` in `#<lane>-gap` (`sim.gap.input` says "microphone input", wrong for the tab lane) |
| route line while `running` | `` `${t(fallback ? 'ext.route.fallback' : route === 'translation' ? 'sim.route.translation' : 'sim.route.flash')} · ${model}` `` in `#<lane>-route` (not a live region; `ext.route.fallback` is only a short label, "Backup model", so it can sit in front of the model id); while `fallback` is true the WARNING `ext.route.fallbackNote` ("A backup model is interpreting. It may answer what it hears instead of translating.") goes into the persistent live region `#<lane>-route-note` (`sim.route.fallback` says "the default model failed", but the tab lane's default is the translation model, and the flash fallback may ANSWER what it hears) |

Overall pill (8.2.3 rule 4): `ext.status.failed` only when NO lane is running; when one lane failed and the other runs, `ext.status.partial`.

Error notice (`errorKeyFor(errorCode, i18n.has, lane)`; extra behavior in the last column). Notices are `role="alert"` regions (8.2.6):

| `errorCode` | Key | Extra UI |
|---|---|---|
| `CREDENTIAL_REQUIRED`, `INVALID_KEY`, `PERMISSION_DENIED`, `CREDENTIAL_FORBIDDEN`, `IP_DENIED` | `ext.error.<CODE>` | `#btn-options` gets `data-attention="true"`; when BOTH lanes report a key failure the notice is shown once, in the tab card (8.2.3 rule 8) |
| `CREDENTIAL_MISMATCH` | `error.CREDENTIAL_MISMATCH` | same |
| `RATE_LIMITED`, `DAILY_LIMIT`, `TOKEN_LIMIT`, `UNKNOWN_429`, `SESSION_LIMIT` | `ext.error.<CODE>` (each states a next step and, for `SESSION_LIMIT`, the two-lane cause) | `quota`: when both lanes are enabled, `#usage-note` gets `data-emphasis="true"` AND the extra sentence `ext.usage.quotaHint` (emphasis is never color alone) |
| `BUDGET_EXHAUSTED` | `ext.error.BUDGET_EXHAUSTED` (names "run only one" when both are on) | with both lanes enabled it is treated as quota-suspect: same emphasis as above (a concurrent-session refusal is retried three times and then ends as `BUDGET_EXHAUSTED`, 5.9) |
| `MICROPHONE_DENIED` | `ext.error.MICROPHONE_DENIED`, or `ext.error.MICROPHONE_EXPIRED` when the panel saw the permission `granted` earlier in its life and it is now `prompt` (a one-time grant expired) | `#btn-mic-permission` and `#btn-mic-allow` get `data-attention="true"` |
| `MICROPHONE_UNAVAILABLE`, `INPUT_UNSUPPORTED`, `BROWSER_INTERRUPTED` (mic lane) | `ext.error.<CODE>` | |
| `MICROPHONE_UNAVAILABLE`, `BROWSER_INTERRUPTED`, `MICROPHONE_DENIED` (TAB lane) | `ext.error.TAB_INPUT_LOST` ("the tab's audio stopped arriving: click the toolbar icon on the tab, then Start") | `#tab-arm-note` shows `ext.arm.needed` |
| `TAB_CAPTURE_FAILED`, `TAB_UNSUPPORTED`, `TAB_GONE`, `TAB_CAPTURE_BUSY`, `TAB_ENDED`, `TAB_AUDIO_BLOCKED`, `HOST_UNAVAILABLE`, `LANE_STOPPING` | `ext.error.<CODE>` | `TAB_ENDED`, `TAB_GONE`: pill uses `data-state="warning"` (not an alarm) |
| `MODEL_UNSUPPORTED` | `ext.error.MODEL_UNSUPPORTED` (no "run connection diagnostics") | |
| `NETWORK_ERROR`, `UNAVAILABLE`, `TIMEOUT`, `SETTINGS_UNSUPPORTED`, `SAFETY_BLOCKED`, `INVALID_RESULT` | `error.<CODE>` | |
| `ALREADY_RUNNING`, `START_CANCELLED`, `NEEDS_ARM` | none (silent) | |
| anything else | `error.unknown` | |

### 5.12 Model defaults and rationale (an assumption, not a measurement: A8)

Settings hold one model per lane (7.1). Defaults:

- Tab lane default: `gemini-3.5-live-translate-preview` (translation route). Rationale: the tab carries THIRD-PARTY
  speech (video, meetings, calls) that often contains questions or commands addressed to "you"; the translation
  route "structurally cannot reply", whereas the flash route depends on a system instruction plus the reply
  detector (`detectReply`, which skips segments after the fact). The translation route ignores a source-language
  hint, which is fine because the tab lane is always auto-detect. Cost: it is a preview model and its fallback is
  the native-audio flash model.
- Mic lane default: `gemini-3.8-live` (`DEFAULT_LIVE_MODEL`, the owner's 2026-09-24 default). Rationale: the person
  speaking is the source, so a reply to their words is not the failure mode of a video; the stable general model
  is the web app's reviewed default. The options page (7.3) lets the owner flip either lane.
- Two-way (an assumption, A30, and a risk, K28): a pair needs an INSTRUCTION-driven model, and the translation-only model cannot serve one. The setting keeps what the user chose (the tab default stays the translation-only model, so
  turning two-way off restores the translation route); for a pair the sim engine moves a translation-only model to the first instruction-driven model of `LIVE_MODELS`, today `gemini-3.8-live`, and the panel says so (`ext.twoWay.modelNote`,
  shown while two-way is on and the lane's chosen model is the translation-only one; the route line names the model in use). The price is the protection this section gave the tab lane: a two-way tab lane runs on the route that
  "can reply" and depends on the system instruction plus the reply detector (which is pair-aware). The panel cannot import `live-config.js` (R6 of 3.3: the build refuses it), so `view-model.js` pins the two model ids and
  `tests/extension-panel.test.mjs` compares them with `live-config.js` and with the sim engine's choice.
- Not verified with real audio. If the owner prefers a single default, change `DEFAULT_SETTINGS.lanes.tab.model`
  in `extension/lib/settings.js` and the matching test constant; nothing else depends on it.

### 5.13 The engine clock and the worker-timer seam (K5)

The risk (measured nowhere): an offscreen document is never composited and Chrome may treat it as hidden. If its main-thread
timers are throttled to about 1 Hz, the engine's uplink pump (`app/audio/uplink-queue.js`: paces sends with
`setTimeout(pump, max(0, nextAt - now))` and drops frames older than 256 ms from a queue of 8), the player monitor (50 ms
timers) and the capture watchdog (2 s) degrade. The exemption believed to apply to AUDIBLE pages (a secondary source, never
fetched by the scouts) does not cover the case this product exists for: captions only, with the translated speech muted and the
original volume at 0, where the document produces no audible sound. Nothing is measured, so the design (1) builds the fix as a
seam, (2) makes the symptom visible, (3) points the manual check at the worst case.

- Seam: `engine/worker-timers.js` exports `TIMER_MODE` (`'realm'` | `'worker'`; the v1 value is `'realm'`) and
  `createWorkerTimers({ Worker, url, realm }) -> { setTimeout, clearTimeout, now, dispose }`. `host.js` builds the ENGINE clock
  from it (`createEngineClock({ mode = TIMER_MODE, realm, Worker })`: the realm clock unchanged in `'realm'` mode, worker-driven timers in `'worker'` mode). `'realm'` = the realm's `setTimeout`, `clearTimeout`, `performance.now` (exactly D4's "real timers"). `'worker'` =
  `setTimeout(fn, ms)` posts `{ t: 'set', id, ms }` to a dedicated module worker
  (`new Worker(new URL('./timer-worker.js', import.meta.url), { type: 'module' })`, which the build closure follows, 10.3) whose
  script runs the real timer and posts `{ t: 'fire', id }` back; the main thread runs `fn` on that message (a message event is a
  task, not a timer). `clearTimeout(id)` posts `{ t: 'clear', id }` and forgets the callback; `now` stays `performance.now`. If the
  worker cannot be created or emits `error`, the module falls back to the realm timers for every later call and re-arms pending
  timers there (never a silent hang). The clock reaches the engine as `env.setTimeout/clearTimeout/now` (`createSimEngine`, the
  platform shim). Hubs, coalescers and grace timers keep the REALM clock: a late panel frame is harmless.
- It ships OFF because "a dedicated worker's timers are not throttled like page timers" is itself unmeasured `[assumption A27]`;
  the seam is tested in Node with a fake `Worker` (fire, clear, error fallback, dispose) and switching it on is one constant plus
  the measurement of checklist 13.22.
- Visibility without DevTools: `LaneState.gap === 'input'` (the engine's own accounting of dropped stale frames, 4.6.2) is shown
  in `#<lane>-gap` while the lane runs and as the overlay's gap line (8.5.3). A gap line appearing within the first minutes of
  13.22 is the trigger to flip `TIMER_MODE`.
- Checklist 13.22 is revised to the worst case: original volume 0, translated speech muted, panel and tab in the background, at
  least 60 s, record the caption delay and whether a gap line appears (the earlier wording kept the graph audible and could pass
  while volume 0 plus muted fails).

---------------------------------------------------------------------------------------------------

## 6. Service worker

Owner: group C (`extension/background/*`). The SW is thin and idempotent: every durable fact it needs is in `chrome.storage` or
obtained from the host. The only module-level state is (a) the map of IN-FLIGHT STARTS with their cancel flags and (b) the
lifecycle mutex (6.3.1); both are rebuilt empty after a restart (6.10), so a restart can lose at most a cancel flag, never
correctness (the "stop wins" reconciliation of 6.3 step 7 and the host's own checks cover it). It imports ONLY `extension/lib/**`
(R2).

```js
// extension/background/service-worker.js  (ENTRY, the whole file)
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createServiceWorker } from './sw-core.js';
createServiceWorker({ adapter: createChromeAdapter() }).register();
```

```js
// extension/background/sw-core.js
createServiceWorker({ adapter, now = () => Date.now(), setTimeout = globalThis.setTimeout }) -> Readonly<{
  register(): void,                       // registers every listener SYNCHRONOUSLY, then starts bootstrap() (not awaited)
  bootstrap(): Promise<void>,
  handlers: Readonly<{ onActionClicked, onMenuClicked, onInstalled, onStartup, onTabRemoved, onTabUpdated,
                       onTabActivated, onStorageChanged }>,
  startLane({ lane, tabId }): Promise<void>,      // throws Error{code}
  stopLane({ lane }): Promise<void>,              // never throws
  ensureOffscreen(): Promise<{ hostId: string }>,
  closeHost({ except }): Promise<boolean>,
  probeHost(): Promise<boolean>,
  considerOverlay(tabId: number): Promise<void>,
}>
```

### 6.1 Top-level listener list (all registered in `register()`, none conditional, none inside a promise)

| # | Event | Handler | Purpose |
|---|---|---|---|
| 1 | `runtime.onInstalled` | `onInstalled(details)` | recreate the context menu; clear stale session keys; run `bootstrap()` |
| 2 | `runtime.onStartup` | `onStartup()` | run `bootstrap()` when the browser starts, so the storage access level is re-applied at browser start and not only at the first arbitrary SW wake-up (which can come after content scripts loaded in restored tabs) |
| 3 | `runtime.onMessage` | `createMessageRouter({runtime, target:'sw', handlers})` | `sw/lane-start`, `sw/lane-stop`, `sw/permission-open`, `sw/host-probe`, `sw/host-idle` |
| 4 | `action.onClicked` | `onActionClicked(tab)` | arm + open the side panel (D2) |
| 5 | `contextMenus.onClicked` | `onMenuClicked(info, tab)` | arm + open the side panel via the menu |
| 6 | `tabs.onRemoved` | `onTabRemoved(tabId)` | clear armed record; tell the host |
| 7 | `tabs.onUpdated` | `onTabUpdated(tabId, changeInfo, tab)` | clear armed record on cross-origin navigation; re-attach overlay on `status:'complete'` |
| 8 | `tabs.onActivated` | `onTabActivated({tabId, windowId})` | the mic captions follow the tab you look at |
| 9 | `storage.onChanged` | `onStorageChanged(changes, areaName)` | forward live settings edits to the host; attach the overlay when a captions flag turns on |

NOT registered: `runtime.onConnect` (the SW never needs to be a receiver of panel or overlay ports; D7 refinement F1) and
`commands.onCommand` (the only command is `_execute_action`, which dispatches `action.onClicked`, `[verified-doc]`).

`bootstrap()` (run at EVERY SW start, at `onInstalled` and at `onStartup`; errors swallowed; ordering irrelevant):
1. `sidePanel.setPanelBehavior({ openPanelOnActionClick: false })` — the preference persists in the profile and
   `true` would suppress both `action.onClicked` and the tab grant `[verified-doc]`.
2. `storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` — the key must not be readable by content
   scripts; whether the level persists across restarts is unstated, so it is re-applied at every start
   `[assumption A10]`. Because `bootstrap` swallows a failure silently, the guarantee that matters is enforced where the key
   is WRITTEN: the options page calls `setAccessLevel` itself (it is a trusted context) before `writeKey` and refuses to
   save the key when the call rejects (7.4, 8.3). What a content context sees when the level is set (an absent
   `chrome.storage`, or a present object whose calls reject) is unverified `[assumption A25]`; the fake models the rejection
   and checklist 13.3/13.23 accept either.

`onInstalled`: `contextMenus.removeAll()` then `contextMenus.create({ id: 'interp-open', title:
i18n.getMessage('menuOpen'), contexts: ['page', 'video', 'audio', 'frame'] })`; `storage.session.remove([armed, host, lastStop])`.
(Menus persist across SW restarts; creating at top level on every start would throw "duplicate id".)

### 6.2 Arming bookkeeping (`extension/background/arming.js`)

```js
createArming({ storageSession, now, maxTabs = LIMITS.maxArmedTabs }) -> Readonly<{
  arm(tab: { id: number, windowId: number, url?: string }): Promise<void>,
  isArmed(tabId: number): Promise<boolean>,
  get(tabId: number): Promise<{ windowId, origin, at } | null>,
  clear(tabId: number): Promise<void>,
  clearAll(): Promise<void>,
  onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void>,
}>
```

- Shape: `interp.armed.v1 = { v: 1, tabs: { "<tabId>": { windowId, origin, at } } }` (4.10). Read-modify-write is
  serialized through one promise chain inside `createArming` so concurrent events cannot lose an update.
- `arm`: `origin = originOf(tab.url)` where `originOf` returns `new URL(url).origin` for `http:`/`https:` and `null` for
  everything else (opaque, `file:`, unparsable, missing url). Evicts the entry with the smallest `at` when more than
  `maxTabs` entries exist.
- `onTabUpdated(tabId, changeInfo)`: only when `changeInfo.url` is a string: clear the record if it exists and
  (`originOf(changeInfo.url) === null` or differs from the stored origin). Same-origin navigation (including SPA
  `pushState`) keeps the grant, matching Chromium (`[verified-doc]`: cleared on cross-origin main-frame navigation,
  tab destroy, extension unload).
- `tabs.onRemoved` -> `clear(tabId)`.
- The record is bookkeeping for the UI ("this tab is ready") and for the `NEEDS_ARM` decision; Chromium is the real
  authority, so a stale "armed" record is harmless: the mint fails with `NEEDS_ARM` and the record is cleared (6.4).
- The `tabs` permission is required for `changeInfo.url` and `tab.url` (manifest, 10.4).

### 6.3 Start orchestration: `sw/lane-start` -> `startLane({ lane, tabId })`

The handler for `sw/lane-start` (sender role `panel`) calls `startLane` and returns `{}` (router adds `ok:true`) or
lets the thrown `Error{code}` become `{ok:false, code}`. In-memory state: `const starting = new Map()` (lane -> `run`, `run =
{ cancelled: false }`). Every caller talks to the host through ONE helper:

```js
// sendToHost(message) never throws and never returns a non-object:
//   a rejection ("Receiving end does not exist", "The message port closed before a response was received"), `undefined`,
//   a non-object or a response without `ok === true` all become { ok:false, code: res?.code ?? 'HOST_UNAVAILABLE' }
```
Only the side panel sends SW-bound messages; its `sendToSw` (in `panel/controller.js`) uses the identical normalization (a rejection means the SW could not be reached, and every SW-bound call is one whose failure the page can show or ignore); the options and permission pages send none.
(review: with a fake that resolves `undefined` for "listeners exist but nobody answered" and a real Chrome that probably rejects,
`res.ok` on `undefined` would be a `TypeError` mapped to `INTERNAL`; success now REQUIRES `res?.ok === true`,
`[assumption A24]`.) Steps, in this exact order:

0. `inFlight = starting.get(lane)`: when it exists throw `LANE_STOPPING` if `inFlight.cancelled` and `ALREADY_RUNNING` otherwise (in-memory; the host repeats the
   check authoritatively). A start that a Stop already cancelled still holds the lane until it has unwound (a hung `getUserMedia` inside the host can keep it there
   for a long time); answering `ALREADY_RUNNING` to the NEXT press would be wrong twice: nothing is running, and the panel deliberately ignores that code, so
   the press would vanish without a word. `LANE_STOPPING` is what the panel shows as "still stopping, press Start again" (8.2.5). Otherwise
   `run = { cancelled: false }; starting.set(lane, run)`; the whole body runs in `try { ... } finally { if (starting.get(lane) === run) starting.delete(lane); }`.
   After every `await` below: `if (run.cancelled) throw START_CANCELLED` (a Stop pressed meanwhile; 6.11).
1. Read `settings = readSettings(storage.local)` and `key = resolveKey({ personal: readKey(storage.local),
   builtin: BUILTIN_KEYS })`. No key -> throw `CREDENTIAL_REQUIRED`. (The SW is the only context that reads the key.) A storage failure while reading the settings or the key is `INTERNAL`: `STORAGE_FAILED` is a panel/options notice code and does not cross the protocol (4.9).
2. Tab lane only:
   a. `tab = await tabs.get(tabId)`; failure -> `TAB_GONE`. If `tab.url` is a string whose scheme is not in
      `['http:', 'https:', 'file:']` -> `TAB_UNSUPPORTED` (no mint attempted). `chrome:`, `chrome-extension:`,
      `about:`, `edge:`, `view-source:`, `devtools:`, `data:` are therefore rejected before any stream id exists.
   b. `if (!(await arming.isArmed(tabId)))` -> `NEEDS_ARM`.
3. Wait out a stopping lane (both lanes): when an offscreen document exists (`getContexts`), `ping = sendToHost('host/ping')`; while
   `ping.lanes[lane] === 'stopping'`, poll every 100 ms up to `LIMITS.stopWaitMs` (injected timers, a FRESH ping each time). Still
   stopping -> throw `LANE_STOPPING`. This wait MUST happen before the mint: a minted id that the host then refuses stays pending
   and blocks the next mint of that tab for its lifetime ("Cannot capture a tab with an active stream.").
4. `await ensureOffscreen()` (mutex + zombie recovery; 6.3.1). Then write `interp.host.v1 = {v:1, up:true, hostId, at}` if it changed.
5. Build the `host/lane-start` message from settings (`laneRequestOf`: `{ targetLanguage, model }` plus `languages: [targetLanguage, partnerLanguage]` for a lane whose `twoWay` is on, 7.2; `voiceGender`, `muted: settings.speechMuted`,
   `captions: settings.lanes[lane].captions`, `style: hostSettingsOf(settings).style`; tab lane: `tab: { tabId, originalVolume: settings.lanes.tab.originalVolume }` and `streamId` added in step 6).
6. Tab lane only: `streamId = await mintStreamId(tabId, lane)` (6.4). This is the LAST awaited step before the send: the id
   is single-use and "expires after a few seconds" `[verified-doc]` (exact TTL unknown), so nothing slow may sit between
   mint and consume, and nothing may store or re-send it. A Stop that lands DURING the mint strands that single-use id until it expires (nothing is sent: sending it would break "stop wins"); a Start inside the id's lifetime then goes through the recovery of 6.4 and can end in `TAB_CAPTURE_BUSY` (rare; unmeasured in a real browser).
   `res = await sendToHost(message)`. Exactly ONE retry, only for `HOST_UNAVAILABLE` (the document was not listening yet):
   `await ensureOffscreen()` (then the cancel check) and send the same message again.
7. "Stop wins": after the answer, `if (run.cancelled)` -> `sendToHost('host/lane-stop', { lane })` (idempotent; this covers a stop
   that reached the host BEFORE the start did, and a start the host accepted just before the stop) and throw `START_CANCELLED`, even when
   the host refused the start (a cancelled start is silent in the panel, a refusal would not be). Otherwise `res.ok === false` -> throw
   `Error{code: res.code}`; on success remove `interp.lastStop.v1` (a new run began) and fire-and-forget `afterLaneStarted(lane, tabId)` (6.7). Failure paths
   never leave a half-started state: the host cleans its own lane (5.6) and the SW holds nothing to undo.

#### 6.3.1 `ensureOffscreen()` (mutex, handshake by ping, zombie recovery)

```js
let chain = Promise.resolve();                              // the lifecycle mutex (module-level state, rebuilt empty)
const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

const ensureOffscreen = () => exclusive(async () => {
  const url = runtime.getURL(PATHS.host);
  let existing = (await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length > 0;
  for (let attempt = 0; attempt < 2; attempt++) {            // attempt 1 may find a ZOMBIE: a document whose host.js failed at import
    if (!existing) {
      try { await offscreen.createDocument({ url: PATHS.host, reasons: ['USER_MEDIA'], justification: HOST_JUSTIFICATION }); }
      catch (error) { if (!/single offscreen document/i.test(String(error?.message))) throw codeError('HOST_UNAVAILABLE'); }
    }
    const ping = await waitForHost();                        // ping until the host answers, else null
    if (ping) return { hostId: ping.hostId };
    await closeDocumentQuietly();                            // zombie: close it, then recreate ONCE
    existing = false;
  }
  throw codeError('HOST_UNAVAILABLE');
});
```

- Reasons are EXACTLY `['USER_MEDIA']` (a test asserts it; `AUDIO_PLAYBACK` would close the document after 30 s
  without audio `[verified-doc]`). `HOST_JUSTIFICATION` is a fixed English constant (not UI text).
- `createDocument` resolves after the page's initial load, but the host's listeners may not be registered yet, so the
  "engine ready" handshake is a ping loop: `waitForHost` sends `host/ping` up to 20 times with 100 ms between
  attempts (injected timers) through `sendToHost`; the first `{ok:true, hostId}` wins; exhaustion returns `null`. The host
  registers its listeners synchronously in `start()` before doing anything else (5.2), so the loop normally succeeds first try.
  Without the recreate-once rule a zombie document would make every later start fail with `HOST_UNAVAILABLE` forever.
- Only one offscreen document may exist per extension `[verified-doc]`; `getContexts` (Chrome 116) is the existence check.
- `closeHost({ except })` (below) also runs inside `exclusive`, so a close can never interleave with an ensure.

### 6.4 The mint (`mintStreamId`) and error mapping

```js
async function mintStreamId(tabId, lane) {
  try { return await tabCapture.getMediaStreamId({ targetTabId: tabId }); }
  catch (error) {
    if (isActiveStreamError(error)) return recoverActiveStream(tabId, lane);   // the ONE case with a recovery (below)
    throw await mapMintError(error, tabId);                                     // the others map to a code at once
  }
}
```

Exact error strings (Chromium source, `[verified-doc]`; the fake browser reproduces them verbatim):

| Message (prefix match where noted) | Meaning | SW result |
|---|---|---|
| `Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.` (match `startsWith('Extension has not been invoked')`) | no per-tab grant | `arming.clear(tabId)`; throw `NEEDS_ARM` |
| `Cannot capture a tab with an active stream.` | a capture for that tab is pending or active | recovery below |
| `Cannot capture this page.` | file:// without access, policy- or user-blocked host | `TAB_UNSUPPORTED` |
| `Error finding tab to capture.` or `Invalid tab specified.` | tab gone | `TAB_GONE` |
| anything else | unknown | `TAB_CAPTURE_FAILED` (message discarded) |

Recovery for `Cannot capture a tab with an active stream.` (only one attempt of each step):
1. `ping = sendToHost('host/ping')` (a FRESH ping, never a cached one). If `ping.lanes.tab` is `starting|running|reconnecting|stopping` -> throw `ALREADY_RUNNING`.
2. Wait 250 ms (a stop just completed may still be releasing the registry) and mint again, once (any other mint error is mapped by the table above).
3. Still active, and a fresh ping shows BOTH host lanes `off|error`: this is an orphaned capture our own dead document held (or a
   leftover after a crash): `closeHost({ except: lane })` (it ignores this very start but refuses while another lane is starting),
   `ensureOffscreen()`, mint again, once.
4. Still failing (or the mic lane is running so step 3 was skipped): throw `TAB_CAPTURE_BUSY` (another extension or
   tool captures the tab; we cannot release it).

`tabCapture.getCapturedTabs()` is NOT required by this recovery (the mint error already says the state); it is in the
adapter surface for diagnostics/tests only.

### 6.5 Invocation paths (D2)

Only these produce the per-tab `tabCapture` grant `[verified-doc]` (read from a Chromium main-branch source snapshot that may be newer than the owner's Chrome, and only ever observed in the scouts' run with the test-only allowlist switch: `[assumption A1]`): an action click with NO popup and NO
`openPanelOnActionClick`, the `_execute_action` shortcut, a context-menu click, an omnibox accept. A click inside the
side panel and `sidePanel.open()` never grant. Therefore:

```js
function onActionClicked(tab) {
  // FIRST statement, no await and no storage read before it: sidePanel.open needs the user gesture.
  const opened = adapter.sidePanel.open({ windowId: tab.windowId });
  const armed = arming.arm(tab);
  return Promise.allSettled([opened, armed]).then(() => afterArm(tab.id));
}
function onMenuClicked(info, tab) {
  if (info.menuItemId !== 'interp-open' || !tab) return undefined;
  const opened = adapter.sidePanel.open({ windowId: tab.windowId });   // first statement after the guard
  const armed = arming.arm(tab);
  return Promise.allSettled([opened, armed]).then(() => afterArm(tab.id));
}
```

- Keyboard: `commands._execute_action.suggested_key.default = "Alt+Shift+Y"` `[assumption A11: not checked for
  conflicts; the user can rebind at chrome://extensions/shortcuts]`. A shortcut command must not be `global` (global
  commands get no tab grant). No `commands.onCommand` listener exists. The panel reads the ACTUAL shortcut with
  `commands.getAll()` (adapter surface, 3.4) and shows it in the arm note, or says it is unassigned.
- Context menu: id `interp-open`, title from `_locales` `menuOpen`, contexts `page`, `video`, `audio`, `frame`. The title says what the click does and uses the same wording as `commandOpen` ("Open the interpreter panel on this tab"): the click opens the panel and arms the tab, and interpretation starts only with Start (UX review: the earlier title "Interpret this tab" promised interpretation the click does not start).
- `afterArm(tabId)`: if the host is up, `considerOverlay(tabId)`; otherwise nothing.
- The armed record is what the panel watches (`storage.onChanged` on `interp.armed.v1`) to turn "click the toolbar
  icon" into "this tab is ready" and to auto-start a pending tab lane (8.2.5).

### 6.6 Forwarding live settings to the host

`onStorageChanged(changes, areaName)`: when `areaName === 'local'` and `changes['interp.settings.v1']` exists and the host
is up (`interp.host.v1.up === true`):
1. `next = normalizeSettings(change.newValue)`, `prev = normalizeSettings(change.oldValue)` (an absent old value normalizes to the
   defaults). Send `host/settings { settings: hostSettingsOf(next) }` (errors ignored).
2. AFTER that send, for each lane whose `captions` flag went from false to true (`prev.lanes[lane].captions === false &&
   next.lanes[lane].captions === true`): tab lane -> `ping = sendToHost('host/ping')`, then `considerOverlay(ping.tabId)` when it is an
   integer; mic lane -> `considerOverlay(await activeTabId())` (6.7). Ticking "Show captions on the page" during a run therefore
   attaches the overlay immediately; without this step the checkbox did nothing until the user navigated or switched tabs
   (review). Turning a flag off needs nothing here: the host sends `clear {lane}`, and that also resets the overlay's
   dismissal, so off/on brings a dismissed overlay back (8.5.3).
Nothing else is forwarded: language, model and key changes apply at the next `host/lane-start` (the options page states this,
`ext.applyNext` / `ext.options.modelTabHint`). This single path serves both the panel (volume slider, mute button, captions
checkboxes) and the options page.

### 6.7 Overlay attach and tab events

`activeTabId()`: `(await tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null` (no `tabs` fields beyond `id` are needed; `lastFocusedWindow` is
a `tabs.query` filter, not a new API).

`considerOverlay(tabId)`:
1. If `interp.host.v1.up !== true` return.
2. `active = (await activeTabId()) === tabId`; `res = await sendToHost('host/overlay-wanted', { tabId, active })`; `!res.ok || !res.wanted` -> return.
   (`active` is what keeps the user's own translated speech off background tabs: the host attaches the MIC lane only to the tab
   you look at, 5.6.3. A background tab that merely finished loading is never attached for the mic lane.)
3. `ok = await attachOverlay(tabId, { inject: await arming.isArmed(tabId) })`.
4. `sendToHost('host/overlay-result', { tabId, ok, lanes: res.lanes })` (errors ignored).

`attachOverlay(tabId, { inject })`: try `tabs.sendMessage(tabId, {v:1,target:'content',type:'content/overlay-attach'},
{ frameId: 0 })` with delays `[0, 150, 400, 1000]` ms between attempts (the content script may not be listening yet
right after `status:'complete'`). If it still fails and `inject` is true (the tab is armed, so `activeTab` gives
`scripting` access): `scripting.executeScript({ target: { tabId }, files: [PATHS.overlay] })` (an already-open tab
never received the static content script), then one more attach attempt. The overlay is idempotent and ignores an attach while its
port is open (8.5.1), so repeated attaches from several triggers within milliseconds are harmless. Result: `true` when an attach
message was acknowledged, else `false`. An already-open tab that never received the static script and is not armed (typical for the
MIC lane, whose tab is not the armed one) yields `false`: the host marks the lane `overlay: 'unavailable'` and the panel says
so (`ext.error.OVERLAY_UNAVAILABLE`, which tells the user to reload that tab).

Triggers:
- `afterLaneStarted(lane, tabId)`: tab lane -> `considerOverlay(tabId)`; mic lane -> `considerOverlay(await activeTabId())` (one tab).
- `tabs.onUpdated` with `changeInfo.status === 'complete'` -> `considerOverlay(tabId)` (a navigation created a new
  document with a new content script; SPA `pushState` does not, and needs nothing). Because of `active`, only the tab-lane tab and the
  active tab can be attached.
- `tabs.onActivated` -> `considerOverlay(tabId)` (mic captions follow the tab the user looks at; the host clears them on the previous tab).
- `tabs.onRemoved(tabId)` -> `arming.clear(tabId)`; if the host is up, `host/tab-removed { tabId }`.
- `onStorageChanged` when a captions flag turns on (6.6).

The host is the authority on who wants an overlay (`host/overlay-wanted`), so the SW carries no lane bookkeeping.

### 6.8 `sw/permission-open`

`tabs.query({ url: runtime.getURL(PATHS.permission) })`: if a permission tab exists, `tabs.update(id, { active: true })`
and answer its id; else `tabs.create({ url: runtime.getURL(PATHS.permission) })` and answer the new id. No gesture is
required for `tabs.create`. The SW never calls `getUserMedia` (no `document`).

### 6.9 Closing the host: `sw/host-idle` and `closeHost()`

`sw/host-idle { hostId, reason }` (sender role `offscreen`): a FRESH `ping = sendToHost('host/ping')`. If the ping fails while
`interp.host.v1.up` is true, the host is already gone: write `up:false` and `lastStop` (with the reason the host reported) and answer `{closed:false}`. Otherwise, if `starting.size === 0` (no start is in
flight in this SW: a start that has passed `ensureOffscreen` and the mint but has not yet delivered `host/lane-start` is invisible to
`host/ping`, so the in-memory set is the only thing that can see it) and `ping.panels === 0` and both lanes are `off|error` ->
`closeHost({ except: null })`, write `interp.lastStop.v1 = { v:1, reason, at }` and answer `{closed:true}`; otherwise `{closed:false}` (a
panel reconnected, or a start is under way). The host does not take `{closed:false}` for an answer that ends the matter: it asks again 3 s, 6 s and 12 s later, at most 3 times, unless a panel connects meanwhile (5.8), so a start that was in flight when the first report arrived can never leave an idle offscreen document (and `interp.host.v1.up`) behind. `closeHost({ except })` runs inside the mutex: it refuses (returns `false`) while a lane other than
`except` is in `starting`; else `offscreen.closeDocument()` (an error "No current offscreen document." is ignored), then writes
`interp.host.v1 = {v:1, up:false, hostId:null, at}`. The SW closes the host ONLY through this path, through the orphan-capture recovery of
6.4, through `sw/host-probe` (6.11), and never while a lane is running. `ext.error.HOST_UNAVAILABLE` therefore no longer arises from a close
that raced a valid Start.

### 6.10 What survives a SW restart

Nothing needs to. After `kill`, the next event re-runs the module: listeners are re-registered synchronously;
`bootstrap()` re-applies the two API preferences; the armed map, host flag, `lastStop`, settings and key are read from storage on
demand; an existing offscreen document is found with `getContexts`; the `starting` map and the mutex are empty (a Stop after a restart
forwards `host/lane-stop` anyway; a start that was in flight when the SW died is either finished by the host or times out at the panel,
and the host's own cancel checks still apply). `tests/extension-sw.test.mjs` proves each of these with the fake browser's SW
kill/revive (11.2). Whether an open panel or overlay port to the offscreen document survives the idle kill is not measured
`[assumption A22]`; checklist 13.26.

### 6.11 `sw/lane-stop` and `sw/host-probe`

`sw/lane-stop { lane? }` (sender role `panel`) -> `stopLane`: (1) for each named lane (both when absent): `starting.get(lane)` -> set
`run.cancelled = true`; (2) `sendToHost('host/lane-stop', { lane? })`, best effort: a rejection, `undefined` or `{ok:false}` means
"no host yet", which is fine because the in-flight `startLane` re-sends the stop after its own answer (6.3 step 7); (3) answer `{}` (always
`ok:true`). The panel's Stop button, the lane checkboxes and Cancel all use it; a direct `host/lane-stop` from the panel would be lost
whenever the start is still inside `ensureOffscreen` or the mint (review).

`sw/host-probe {}` (sender role `panel`) -> `probeHost`: compare `interp.host.v1.up` with reality. `getContexts` finds no offscreen
document but `up` is true -> write `up:false` and `lastStop { reason:'host-lost' }`, answer `{up:false}`. A document exists but a fresh
ping fails (renderer crash left a zombie) -> `closeHost`, same `lastStop`, `{up:false}`. Otherwise `{up:true}` (also writing `up:true` when a live host answers while the flag said down: it heals in both directions). The panel calls it when its
port dropped and it did not ask for a stop (8.2.7), so the stale `up:true` flag ("connect will disconnect immediately") heals itself.


---------------------------------------------------------------------------------------------------

## 7. Settings schema and options page fields

### 7.1 Storage keys and defaults

`storage.local` (extension-private after `setAccessLevel`):
- `interp.settings.v1` = the settings object below (no secrets).
- `interp.key.v1` = `{ "v": 1, "value": "<Gemini API key>" }` (the ONLY place a personal key is stored).

```jsonc
// DEFAULT_SETTINGS (exported frozen from extension/lib/settings.js; createDefaultSettings(uiLanguage) seeds the
// two target languages from the UI language on first run)
{ "v": 1,
  "uiLanguage": "auto",                  // 'auto' | 'ko' | 'en' | 'ja'
  "voiceGender": "female",               // LIVE_VOICE_GENDERS: 'female' (Kore) | 'male' (Orus); one voice for both lanes
  "speechMuted": true,                   // global mute of the translated voice; default muted = captions only
  "lanes": {
    "tab": { "enabled": true,  "targetLanguage": "ko", "twoWay": false, "partnerLanguage": "en",   // two-way: OFF by default; the partner is the language the lane pairs its target with
             "model": "gemini-3.5-live-translate-preview", "originalVolume": 65, "captions": true },
    "mic": { "enabled": false, "targetLanguage": "en", "twoWay": false, "partnerLanguage": "ko",
             "model": "gemini-3.8-live", "captions": false } },   // OFF by default: your own translated speech is drawn into a web page only after an explicit opt-in (F14)
  "captions": { "size": 1.5,             // rem scale 1..2 step 0.125 (same numbers as app CAPTION_SIZE; parity-tested)
                "position": "bottom",    // 'top' | 'bottom'
                "display": "dark",       // 'dark' | 'light' | 'mono'
                "showSource": false,     // also show received source rows (rows are not paired)
                "maxLines": 3,           // 1..6: rows in the overlay
                "autoHideSeconds": 8 } } // 0..60, 0 = never hide
```

`createDefaultSettings(uiLanguage)`: `tab.targetLanguage = uiLanguage`; `mic.targetLanguage` = the first of `['en','ja','ko']`
that differs from `uiLanguage`. `uiLanguage` = `selectLanguage(navigator.languages)` (from `app/i18n/index.js`) when the
stored value is `'auto'` or absent. The model defaults and their rationale are 5.12 (assumption A8).
`twoWay` is `false` for both lanes. `partnerLanguage` = `defaultPartnerLanguage(targetLanguage)` of `lib/constants.js`: English, or Korean when the lane's own target is English (so the listing above,
seeded from `'ko'`, has partner `en` for the tab lane and `ko` for the microphone lane). The pair sent for a two-way lane is `[targetLanguage, partnerLanguage]`.

### 7.2 Validation, normalization, migration (`extension/lib/settings.js`, group B)

```js
export const DEFAULT_SETTINGS;                                      // = createDefaultSettings('ko'), the listing of 7.1
export { CAPTION_SIZE };                                            // Object.freeze({ min: 1, max: 2, step: 0.125, initial: 1.5 }), defined in lib/constants.js
export function createDefaultSettings(uiLanguage = 'en')            // frozen
export function normalizeSettings(raw)                              // total: never throws; frozen; unknown fields dropped
export const MIGRATIONS                                             // frozen {} (the hook for a future v2)
export function migrateSettings(raw, migrations = MIGRATIONS)       // raw from storage (any shape) -> normalized v1
export function hostSettingsOf(settings)                            // HostSettings (4.2.2), no key, no language/model
export function laneRequestOf(settings, lane)                       // { targetLanguage, model } plus languages: [targetLanguage, partnerLanguage] iff twoWay and the two differ
export async function readSettings(area)                            // area = adapter.storage.local
export function writeSettings(area, settings)                      // normalizes, area.set({[key]: ...}), resolves with the settings; writers to one area run one after another
export async function updateSettings(area, mutate)                  // read -> mutate(current) -> write; returns the new settings
export async function readKey(area) / writeKey(area, value) / deleteKey(area) / hasKey(area)
export function resolveKey({ personal, builtin })                   // personal wins; else builtin[0]; else null
```

Rules of `normalizeSettings` (each is a test):
- Non-object input -> `createDefaultSettings('en')`. Missing fields take the default of that field.
- `uiLanguage` in `auto|ko|en|ja`; `voiceGender` in `LIVE_VOICE_GENDERS`; `speechMuted` boolean.
- Per lane: `enabled` boolean; `targetLanguage` in `ko|en|ja`; `twoWay` boolean (missing -> false); `partnerLanguage` in `ko|en|ja` AND different from that lane's `targetLanguage`, else `defaultPartnerLanguage(targetLanguage)`
  (one repair rule covers a record stored before two-way existed, an equal pair and a value that is no language; it repairs to the default partner OF THE TARGET, never to the lane's static default, so the pair is always two languages);
  `model` in `LIVE_MODELS` (else that lane's default); tab `originalVolume` integer clamped to 0..100 (non-finite -> 65); `captions` boolean.
  There is NO version bump for the two new fields: they are optional in storage, `v` stays 1 and `MIGRATIONS` stays `{}`; a record without them reads as one-way with the default partner (a test seeds such a record end to end).
- `captions.size` = nearest valid step (`clampCaptionSize` semantics, implemented ONCE in `lib/constants.js` and shared with
  `protocol.js`'s validator; parity test against `app/preferences.js`); `position`, `display` enums; `showSource` boolean;
  `maxLines` integer 1..6 (else 3); `autoHideSeconds` integer 0..60 (else 8): these two are replaced by their default, not clamped, which is why the options page checks the range itself and never lets an out-of-range typed value reach this rule (7.3). The enum lists (`VOICE_GENDERS`,
  `TARGET_LANGUAGES`, positions, displays) and the ranges live in `constants.js` too.
- `laneRequestOf(settings, lane)`: `{ targetLanguage, model }` and, only when `twoWay` is true and `partnerLanguage !== targetLanguage` (always the case after normalization), `languages: [targetLanguage, partnerLanguage]` (frozen; `targetLanguage` stays in
  the request). The model is the one the user chose: the engine switches a translation-only model for a pair (5.12).
- Output `v` is always 1; unknown top-level or lane fields are dropped; result deep-frozen.
- `migrateSettings(raw)`: `raw` nullish or not an object -> defaults; otherwise `normalizeSettings(raw)`. There is no
  older schema; a `v` greater than 1 (a future writer) is read as v1 with unknown fields dropped and is NEVER
  rewritten until the user changes something (`readSettings` does not write). The `MIGRATIONS` table (`{}`) is the
  hook for a future v2: `migrateSettings` applies `MIGRATIONS[raw.v]` steps in order before normalizing.
- Keys: `readKey` returns the string only if `record.v === 1` and `/^[\x21-\x7e]{1,512}$/` matches, else null (corrupt
  record = no key). `writeKey` trims, validates with `validateKey` from `app/security/shared-key.js` and throws
  `Error{code:'INVALID_KEY'}`. `hasKey` reads and discards the value (the panel only needs a boolean).
  `resolveKey({personal, builtin})`: `personal` (a valid string) wins; else `builtin[0]` when it matches the shape; else null.
- Writers change ONLY their own fields (`updateSettings` with a small mutator on a fresh read). Whole-object writes
  are last-writer-wins; the panel and options page are user-driven, so the race window is negligible.

### 7.3 Options page fields (`extension/options/options.html`, ids are the C/D contract)

All controls save immediately on `change` (no global Save button; the key has its own Save). After a successful
write `#opt-saved` (`p`, `role="status"`, `ext.options.saved`) is shown for 2 s. Live = applies to a running host
through 6.6; Next = applies from the next start.

| id | Control | Label key | Setting | Validation | Applies |
|---|---|---|---|---|---|
| `#opt-key` | `input[type=password]`, `maxlength=512`, `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"` | `settings.key` (placeholder `settings.keyPlaceholder`) | `interp.key.v1` | trim + `validateKey`; invalid -> `error.INVALID_KEY` in `#opt-key-status` | Next |
| `#opt-key-toggle` | `button`, `aria-controls="opt-key"` (NO `aria-pressed`: the visible label already swaps, the double-state pattern the mute button avoids) | label swaps `ext.options.keyShow` / `ext.options.keyHide` | none | — | — |
| `#opt-key-save` | `button.btn-primary` | `common.save` | calls `storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` FIRST and refuses to save when it rejects (`#opt-key-status` = `ext.error.STORAGE_FAILED`); then writes the key, clears the input | see above | Next |
| `#opt-key-delete` | `button` | `settings.deleteKey` | deletes the key | — | Next |
| `#opt-key-status` | `p[role=status]` | `settings.keyStored` / `settings.noKey` / `ext.key.savedBrowser` / `settings.keyDeleted` / `ext.key.builtin` (the app's `settings.keySavedBrowser` is not used: its Korean text is in a formal register) | derived | never shows key characters | — |
| `#opt-key-guide` | `a[target=_blank][rel="noopener noreferrer"]` | `keyGuide.createLink` + visible `keyGuide.newTab` | `KEY_GUIDE_URL` | — | — |
| `#opt-key-note` | `p` | `ext.keyStorage`, then `settings.keyStorageWarning` | — | — | — |
| `#opt-ui-language` | `select` + hint `#opt-ui-language-hint` (`ext.options.uiLanguageHint`: panel and options follow this; captions drawn on web pages, the toolbar tooltip and the context-menu title follow Chrome's own language because they come from `chrome.i18n`) | `language.ui` (options `language.auto`, `language.ko`, `language.en`, `language.ja`) | `uiLanguage` | enum | Live (page re-renders) |
| `#opt-target-tab` | `select` | `ext.lane.tab.title` + `language.target` | `lanes.tab.targetLanguage` | ko/en/ja | Next |
| `#opt-target-mic` | `select` | `ext.lane.mic.title` + `language.target` | `lanes.mic.targetLanguage` | ko/en/ja | Next |
| `#opt-model-tab` | `select`, options = `LIVE_MODELS` with text `ext.options.modelLive`, `sim.model1`, `sim.model2` by index (`sim.model0` carries the app's "(default)" tag, which is true for the microphone only, so the tab select shows the same model untagged) | `ext.options.modelTab` (+ hint `#opt-model-tab-hint`, `ext.options.modelTabHint`) | `lanes.tab.model` | in `LIVE_MODELS` | Next |
| `#opt-model-mic` | `select`, options text `sim.model0..2` by index | `ext.options.modelMic` (+ hint `ext.options.modelMicHint`) | `lanes.mic.model` | in `LIVE_MODELS` | Next |
| `#opt-voice` | `select` (`sim.voice.female`, `sim.voice.male`) | `sim.voice` (+ hint `sim.voiceRestart`) | `voiceGender` | enum | Next |
| `#opt-volume` | `input[type=range]` 0-100 step 5 + `output#opt-volume-value` | `ext.tab.originalVolume` | `lanes.tab.originalVolume` | int | Live |
| `#opt-captions-tab` | checkbox | `ext.captions.show` (with lane title) | `lanes.tab.captions` | bool | Live |
| `#opt-captions-mic` | checkbox + hint `ext.captions.micHint` | `ext.captions.show` (with lane title) | `lanes.mic.captions` (default OFF) | bool | Live |
| `#opt-caption-size` | `input[type=range]` 1-2 step 0.125 + `output#opt-caption-size-value` (`display.captions.value` with the parameter `{size}` = the number, e.g. `1.5`, giving "1.5rem") | `display.captions.size` (hint `display.captions.range`) | `captions.size` | `CAPTION_SIZE` | Live |
| `#opt-caption-position` | `select` (`ext.options.position.top`, `.bottom`) | `ext.options.captionPosition` | `captions.position` | enum | Live |
| `#opt-caption-display` | `select` (`captionOnly.display.dark`, `.light`, `.mono`) | `captionOnly.display` | `captions.display` | enum | Live |
| `#opt-caption-source` | checkbox | `sim.captions.showSource` | `captions.showSource` | bool | Live |
| `#opt-caption-lines` | `input[type=number]` min 1 max 6 | `ext.options.captionLines` (the label states the range, "1-6") | `captions.maxLines` | int 1..6; anything else (0, 7, 2.5, empty) puts the STORED value back, writes nothing and shows no "Saved." | Live |
| `#opt-caption-hide` | `input[type=number]` min 0 max 60 | `ext.options.autoHide` (the label states the range, "0-60") | `captions.autoHideSeconds` | int 0..60; anything else restores the stored value the same way | Live |
| `#opt-privacy-audio` | `p` | `ext.privacy.audio` | — | — | — |
| `#opt-privacy-free` | `p` | `ext.privacy.freeTier` (on the free tier, Google may use the audio and results to improve its products and people may review them; source in 14.5) | — | — | — |
| `#opt-privacy-page` | `p` | `ext.privacy.page` (says captions are drawn into the page, in a protected container, only on the tab you look at for the microphone lane) | — | — | — |
| `#opt-saved` | `p[role=status]` | `ext.options.saved` | — | — | — |

Two-way is NOT an options-page field: `twoWay` and `partnerLanguage` are edited in the side panel only (8.2.1). Changing `#opt-target-tab` / `#opt-target-mic` there leaves the stored partner alone, and the normalization of the same write repairs
a partner that now equals the target to the default partner (the panel instead moves the language just left into the partner's place, 8.2.4). The options page's model selects still offer the translation-only model for a lane whose two-way is on:
that is the case the panel's note explains (5.12).

Sections (`h2` ids): `#opt-h-key`, `#opt-h-lanes` (`ext.options.section.lanes`), `#opt-h-captions`
(`ext.options.section.captions`), `#opt-h-privacy` (`ext.options.section.privacy`). "Overlay defaults" = the caption
fields above; "default languages / original-volume default" = the lane fields (the panel edits the same fields, so
they are the last-used values as well as the defaults).

### 7.4 Key handling rules (D8, binding)

- Personal key: `storage.local['interp.key.v1']`; `setAccessLevel('TRUSTED_CONTEXTS')` at every SW start, at `runtime.onStartup`
  and by the OPTIONS PAGE immediately before every `writeKey` (a rejection refuses the save and shows `ext.error.STORAGE_FAILED`:
  the promise that `ext.keyStorage` makes to the user is only made when the level really was set); never
  `localStorage` (the options page shares the extension origin, but the rule is absolute), never in a message except
  `host/lane-start`, never in any frame, never logged, never rendered (the options page shows only a stored/not-stored
  state). The `#opt-key` value is cleared from the input after a successful save.
- Built-in key: `extension/lib/builtin-key.js` exports `BUILTIN_KEYS` (empty in git). Only `--builtin-key-file` at
  build time (10.6) fills it, in the gitignored output. `resolveKey` prefers the personal key; there is NO rotation:
  only `BUILTIN_KEYS[0]` is ever used. Whether a built-in key restricted to web HTTP referrers works from a
  `chrome-extension://` origin is unverified `[assumption A12]`; a personal key is the documented path.
- The panel learns only `hasKey(local) || BUILTIN_KEYS.length > 0` (a boolean) to enable Start.
- The key's shape (`/^[\x21-\x7e]{1,512}$/`) is checked at write time (options), at read time (`readKey`) and at
  message time (`validateMessage`); the engine's `setPersonal` checks it again.

---------------------------------------------------------------------------------------------------

## 8. UI specs

### 8.1 Rules common to every extension page

- Markup lives in `.html` written by group D; behavior in controllers written by group C. The contract between them is
  the element ids (this section, 1.5, 7.3) and the `data-i18n*` attributes. D MUST NOT rename an id; C MUST NOT query an
  id that is not in this document (a test asserts: every `getElementById('x')` / `#x` id used by a controller exists in
  its page, and every id in this document exists in the page). Each controller exports the ids it touches as a frozen list that this test reads: `PANEL_ELEMENT_IDS` (43 ids, `panel/controller.js`), `OPTIONS_ELEMENT_IDS` (24, `options/controller.js`) and `PERMISSION_ELEMENT_IDS` (`perm-request`, `perm-close`, `perm-status`, `perm-help`, `permission/controller.js`). `panel/view-model.js` also exports `LANE_TITLE_KEY` (`{tab: 'ext.lane.tab.title', mic: 'ext.lane.mic.title'}`, the lane names of the status line).
- Styling: link `../../styles.css` (byte-identical copy of the web app's stylesheet, built into `dist/extension/styles.css`)
  and reuse `.btn .btn-primary .card .badge .notice .text-sub`, the tokens and the focus ring. Panel-only classes go in
  `panel.css`, options/permission classes in `pages.css`. No new colors (DESIGN.md), no `url()`, no `@import`, no
  web fonts, no fixed-px text (rem only; 44 px touch targets via `--touch`). State is text + attribute, never color alone.
  Dark mode follows `prefers-color-scheme` (no `data-mode` attribute is set: system mode), tone is the default navy.
- Text: every visible string comes from an i18n key through `data-i18n="key"` (sets `textContent`), `data-i18n-label="key"` (sets
  `aria-label`), `data-i18n-tip="key"` (sets `title`), `data-i18n-hint="key"` (sets `placeholder`), or from controller code via
  `i18n.t(...)` + `textContent`. `<title>` is empty in markup with `data-i18n` and set by `applyI18n`. `<html lang>` is set to
  `i18n.language` at boot and on language change.
  IMPORTANT (verified against the patched checker on 2026-09-29): `checkSource` with `{html:true}` flags any attribute NAMED
  `title`, `placeholder`, `aria-label` or `alt` whose value is non-empty, and its `\b` also matches inside `data-i18n-title=` and
  `data-i18n-aria-label=` (a hyphen is a word boundary), so those spellings FAIL `check-i18n`. The four binder attributes above
  (`data-i18n`, `-label`, `-tip`, `-hint`) pass and their keys are validated (`data-i18n(-…)?="key"` is one of the checked
  patterns). In `.js` files the same checker flags assignments such as `x.title = 'text'` or `const placeholder = 'text'`
  (any of `title|placeholder|ariaLabel` followed by `=` and a non-blank quoted literal) and `textContent = 'text'`: never
  write those spellings, set attributes with `setAttribute('aria-label', i18n.t(key))` and text with `textContent = i18n.t(key)`.
- `applyI18n(root, i18n)` (`extension/lib/dom-i18n.js`, group C): for each element with `data-i18n` set `textContent`; for
  `data-i18n-label` / `-tip` / `-hint` set `aria-label` / `title` / `placeholder`; if `root` is a document also set `document.title`
  from the `<title data-i18n>`. It never uses `innerHTML`. It is idempotent (called again on language change).
- No inline script, no inline event handler, no `eval` (extension-page CSP: `script-src 'self'; object-src 'self'` `[verified-doc]`).
- No sound is ever produced by any page (no autoplay); the panel never plays audio.
- Every page renders correctly with `chrome.storage` empty and with any single API rejecting (each controller wraps its
  API calls; the fallback is the default state, never an exception to the console).

### 8.2 Side panel (`extension/panel/panel.html`)

#### 8.2.1 Markup skeleton (group D copies this structure; classes and wrappers may be added, ids/order/attributes below are binding)

Live-region rule (review: a `role="status"` element that goes from `hidden` to visible with its text in the same update is a
known case where screen readers often do not announce it; unverified here, standard practice, and the arming instruction and every
error notice depend on it): every element marked `<!-- live -->` is a PERSISTENT region. It is never `hidden` and carries no static
text; the controller writes `textContent` when the note applies and sets `textContent = ''` when it does not, and the CSS collapses
an empty one (`:empty { margin: 0; padding: 0; border: 0; min-height: 0; }`, NOT `display: none`, which would remove the region from
the accessibility tree again). The controller maps ids to fixed keys in one constant table (literal `ext.*` keys, so the i18n checker
validates them). Elements that are not live regions (`#tab-tabline`, `#tab-route`, `#mic-route`, meters, `#close-note`, and the two-way elements `#<lane>-partner-row` and `#<lane>-two-way-note`) may still use `hidden`. The per-lane status lines `#tab-status` / `#mic-status` are plain text with NO role (the pill and the notices already announce every state change; announcing it a second time was a finding of the UX review of the built panel).

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title data-i18n="ext.name"></title>
  <link rel="stylesheet" href="../../styles.css">
  <link rel="stylesheet" href="./panel.css">
</head>
<body class="panel">
  <main id="app">
    <header class="panel-head">
      <h1 id="panel-title" data-i18n="ext.name"></h1>
      <p id="status-pill" class="badge" role="status" aria-live="polite" data-state="idle"></p>
    </header>

    <div id="key-missing" class="notice" role="status"><!-- live: text = ext.key.missing while no key; explains why Start is disabled -->
      <span id="key-missing-text"></span>
      <button id="btn-key-options" type="button" class="btn" hidden data-i18n="ext.key.enter"></button>
    </div>
    <p id="stop-note" class="notice" role="status"></p><!-- live: ext.notice.panelGone | ext.notice.hostLost, from interp.lastStop.v1 or a lost port -->

    <section id="card-tab" class="card lane-card" aria-labelledby="tab-title" data-lane="tab">
      <label class="lane-head"><input id="tab-enabled" type="checkbox"><span id="tab-title" data-i18n="ext.lane.tab.title"></span></label>
      <p class="text-sub" data-i18n="ext.lane.tab.lead"></p>
      <label class="field"><span id="tab-target-label" data-i18n="language.target"></span><!-- while two-way is on the controller re-points it to ext.twoWay.targetLabel -->
        <select id="tab-target">
          <option value="ko" data-i18n="language.ko"></option><option value="en" data-i18n="language.en"></option><option value="ja" data-i18n="language.ja"></option>
        </select></label>
      <label class="field field-check"><input id="tab-two-way" type="checkbox" aria-describedby="tab-two-way-hint"><span data-i18n="ext.twoWay.label"></span></label>
      <div id="tab-partner-row" class="partner-row" hidden><!-- shown while two-way is on; the options are the languages other than the target, rebuilt by the controller -->
        <label class="field"><span data-i18n="ext.twoWay.partner"></span>
          <select id="tab-partner">
            <option value="en" data-i18n="language.en"></option><option value="ja" data-i18n="language.ja"></option><!-- markup default for a `ko` target; replaced by the controller -->
          </select></label>
      </div>
      <p id="tab-two-way-hint" class="text-sub" data-i18n="ext.twoWay.hint"></p><!-- not live: static help for the checkbox (aria-describedby) -->
      <p id="tab-two-way-note" class="text-sub" hidden data-i18n="ext.twoWay.modelNote"></p><!-- not live: shown while two-way is on and this lane's model is the translation-only one -->
      <p id="tab-apply-next" class="text-sub" role="status"></p><!-- live: ext.applyNext, below the language controls it refers to -->
      <p id="tab-source-note" class="text-sub" data-i18n="ext.source.auto"></p>
      <label class="field field-range"><span data-i18n="ext.tab.originalVolume"></span>
        <input id="tab-volume" type="range" min="0" max="100" step="5">
        <output id="tab-volume-value" for="tab-volume"></output></label>
      <label class="field field-check"><input id="tab-captions" type="checkbox"><span data-i18n="ext.captions.show"></span></label>
      <p id="tab-tabline" class="text-sub" hidden></p>
      <p id="tab-arm-note" class="notice" role="status"></p><!-- live: ext.arm.needed | ext.arm.waiting | ext.arm.ready | ext.error.TAB_UNSUPPORTED (+ pin/shortcut hint) -->
      <p id="tab-status" class="text-sub"></p><!-- not live: the pill and the notices announce state changes -->
      <p id="tab-route" class="text-sub" hidden></p>
      <p id="tab-route-note" class="notice" role="status"></p><!-- live: ext.route.fallbackNote while a backup model interprets -->
      <p id="tab-output" class="text-sub" role="status"></p><!-- live -->
      <p id="tab-gap" class="text-sub" role="status"></p><!-- live: ext.gap.input | sim.gap.audio | sim.gap.reception -->
      <meter id="tab-level" min="0" max="100" value="0" data-i18n-label="ext.level.tab" hidden></meter>
      <p id="tab-notice" class="notice" role="alert"></p><!-- live (assertive): the error notice of the lane -->
      <div id="tab-preview" class="caption-preview" role="region" tabindex="0" aria-live="off" data-i18n-label="sim.captions.latest" hidden></div>
    </section>

    <section id="card-mic" class="card lane-card" aria-labelledby="mic-title" data-lane="mic">
      <label class="lane-head"><input id="mic-enabled" type="checkbox"><span id="mic-title" data-i18n="ext.lane.mic.title"></span></label>
      <p class="text-sub" data-i18n="ext.lane.mic.lead"></p>
      <p id="mic-mode" class="text-sub" data-i18n="ext.mic.mode"></p>
      <label class="field"><span id="mic-target-label" data-i18n="language.target"></span>
        <select id="mic-target">
          <option value="ko" data-i18n="language.ko"></option><option value="en" data-i18n="language.en"></option><option value="ja" data-i18n="language.ja"></option>
        </select></label>
      <label class="field field-check"><input id="mic-two-way" type="checkbox" aria-describedby="mic-two-way-hint"><span data-i18n="ext.twoWay.label"></span></label>
      <div id="mic-partner-row" class="partner-row" hidden><!-- as in the tab card -->
        <label class="field"><span data-i18n="ext.twoWay.partner"></span>
          <select id="mic-partner">
            <option value="en" data-i18n="language.en"></option><option value="ja" data-i18n="language.ja"></option>
          </select></label>
      </div>
      <p id="mic-two-way-hint" class="text-sub" data-i18n="ext.twoWay.hint"></p><!-- not live -->
      <p id="mic-two-way-note" class="text-sub" hidden data-i18n="ext.twoWay.modelNote"></p><!-- not live -->
      <p id="mic-apply-next" class="text-sub" role="status"></p><!-- live: ext.applyNext -->
      <p id="mic-source-note" class="text-sub" data-i18n="ext.source.auto"></p>
      <label class="field field-check"><input id="mic-captions" type="checkbox"><span data-i18n="ext.captions.show"></span></label>
      <p id="mic-captions-hint" class="text-sub" data-i18n="ext.captions.micHint"></p>
      <p id="mic-permission-status" class="text-sub" role="status"></p>
      <button id="btn-mic-allow" type="button" class="btn" hidden data-i18n="ext.permission.allowButton"></button>
      <p id="mic-status" class="text-sub"></p><!-- not live -->
      <p id="mic-route" class="text-sub" hidden></p>
      <p id="mic-route-note" class="notice" role="status"></p><!-- live: ext.route.fallbackNote -->
      <p id="mic-output" class="text-sub" role="status"></p><!-- live -->
      <p id="mic-gap" class="text-sub" role="status"></p><!-- live -->
      <meter id="mic-level" min="0" max="100" value="0" data-i18n-label="seq.inputLevel" hidden></meter>
      <p id="mic-notice" class="notice" role="alert"></p><!-- live (assertive) -->
      <div id="mic-preview" class="caption-preview" role="region" tabindex="0" aria-live="off" data-i18n-label="sim.captions.latest" hidden></div>
    </section>

    <p id="no-lane-note" class="notice" role="status"></p><!-- live: ext.status.noLane -->
    <p id="mute-note" class="text-sub" role="status"></p><!-- live: ext.mic.mutedHint while speech is muted -->
    <p id="echo-note" class="notice" role="status"></p><!-- live: ext.sound.echoWarning while speech is ON and the mic lane is enabled -->
    <p id="close-note" class="text-sub" hidden data-i18n="ext.panel.closeStops"></p><!-- shown while any lane runs -->

    <details id="howto">
      <summary data-i18n="ext.howto.link"></summary>
      <ol id="howto-steps">
        <li data-i18n="ext.howto.keepOpen"></li><li data-i18n="sim.headphonesStart"></li><li data-i18n="ext.howto.step2"></li>
        <li data-i18n="ext.howto.step3"></li><li data-i18n="ext.howto.step4"></li>
        <li data-i18n="ext.howto.step5"></li><li data-i18n="ext.howto.stepCall"></li>
      </ol>
    </details>

    <p id="usage-note" class="text-sub" role="status"></p><!-- live: ext.usage.twoSessions while both lanes are enabled (+ ext.usage.quotaHint when emphasized) -->

    <div class="button-row"><!-- sticky at the bottom of the panel (8.2.2) -->
      <button id="btn-start" type="button" class="btn btn-primary" aria-disabled="true" aria-describedby="key-missing no-lane-note"></button><!-- aria-disabled, NEVER disabled: it stays focusable so its description is reachable; the controller ignores the click -->
      <button id="btn-mic-permission" type="button" class="btn icon-btn" data-i18n-label="permission.request" data-i18n-tip="permission.request">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" class="icon"><!-- microphone path --></svg></button>
      <button id="btn-mute" type="button" class="btn icon-btn" data-muted="true">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" class="icon"><!-- speaker path; then a second <path class="icon-slash">, the slash, which panel.css shows only while data-muted="true" --></svg></button>
      <button id="btn-options" type="button" class="btn" data-i18n="ext.options.title"></button>
    </div>

  </main>
  <script type="module" src="./panel.js"></script>
</body>
</html>
```

Notes: `#btn-start` and `#btn-mute` labels are set by the controller (they swap: `common.start`/`common.stop`/`common.cancel`, `ext.sound.on`/`ext.sound.off`, the latter for BOTH `aria-label`
and `title`); their `aria-label`/text is never literal. `#btn-start` carries `aria-disabled="true"` in the markup and the controller toggles that attribute (`aria-disabled` is removed when Start is available; the native `disabled` property is not used anywhere in the panel). `hidden` is the HTML attribute (the controller toggles it) but only on the non-live elements named above. The SVG paths are inline
path data only (no text, no `<title>`). The microphone-permission button's status line is `#mic-permission-status`. `#btn-key-options` has its own label (`ext.key.enter`) so a screen-reader
list does not show two buttons both named "Options". Note that `#howto` starts with the "keep the panel open" step because closing the panel stops every lane (5.8). The two-way block sits between the target select and `#<lane>-apply-next` so the "applies next" hint stays below every language control it can refer to. The partner select's options are made by the controller (the languages other than the lane's first one, each with its `data-i18n` key so a language switch re-translates them; rebuilt only when the choice list changes, because rebuilding closes an open dropdown); `.partner-row` in `panel.css` indents the row under the checkbox text.

#### 8.2.2 Layout rules (group D, `panel.css`)

- Single column, mobile-first; works from 320 px up (actual side-panel width is unverified `[assumption A13]`); `main` padding
  `--page-x`; cards use `.card` (radius `--radius-card`, 1 px border, no shadow), vertical rhythm `--space-3`.
- `.button-row`: flex, wrap, gap `--space-2`; Start is the visually first control; `.icon-btn` min 44 x 44 px. The row is STICKY:
  `position: sticky; bottom: 0; z-index: 1; background: var(--surface); border-top: 1px solid var(--border); padding-block: var(--space-2)`
  (opaque, so scrolled content never shows through). Reason (an estimate, not a measurement): with both lanes running each card
  stacks about a dozen elements and a caption preview of up to 10 rem, so Stop and mute would sit roughly 1,000 px down a typical
  700-900 px panel, and mute is the emergency control for the speaker/microphone feedback loop. `#usage-note`, `#mute-note`,
  `#echo-note` and `#close-note` sit ABOVE the row in the DOM so they scroll with the content and are never hidden under it.
  A static CSS test asserts the sticky rule; checklist 13.29 checks Start/Stop/mute are reachable without scrolling at 700 px.
- `#btn-mute[data-muted="true"]`: danger styling (border and icon color `--danger`, fill `--surface-alt`) so the "red when muted"
  cue of the screenshot exists AND the state is carried by label text + `#mute-note`, AND by a SHAPE: the icon has a second path `.icon-slash` (a slash across the speaker, filled with `currentColor`, so forced colors keep it) that `panel.css` hides by default and shows only for `#btn-mute[data-muted="true"]` (CSS only, no controller code; the first build drew the same glyph in both states and told them apart by colour alone, checklist 13.47).
- Empty live regions collapse (`:empty` rule of 8.2.1), so a note that does not apply takes no room.
- `#status-pill[data-state]`: `styles.css` defines only `recording|connected|warning|error` for `.badge[data-state]`. `panel.css` therefore
  defines the three panel-only values itself: `idle` neutral (default border), `starting` = the `warning` look (dashed `--warning` border),
  `running` = the `connected` look (solid `--success` border); `warning` and `error` come from `styles.css`. The text is always present.
- `.caption-preview` (the `div` is `role="region"` with an `aria-label` and `tabindex="0"`, 8.2.6): max 4 rows, `font-size` 1rem, rows separated by 1 px `--border`, `partial` rows `--text-muted` with a
  3 px dashed accent start bar, `interrupted` rows a 3 px solid danger start bar, `skipped` rows muted; `max-height: 10rem; overflow-y: auto`.
- Beyond the attribute table below, `panel.css` also has `#key-missing:has(> #key-missing-text:empty)` (the key notice holds a span and a button, so it is never `:empty` itself; `:has()` is Chrome 105+, the extension needs 116) and `.caption-flag` (the text label the controller puts before a skipped or interrupted preview row); the preview rows are the direct children of `.caption-preview`, styled through `[data-status]` and `[data-skipped="true"]`.
- All hover effects only inside `@media (hover: hover)`; all transitions off under `prefers-reduced-motion: reduce`;
  `forced-colors` must keep borders visible (use `border`, not only `background`).

Attributes set by the controller and the CSS each REQUIRES (review: the view model set `data-attention`, `data-emphasis` and
`data-state` values that no CSS rule defined; state is never color alone, so every row has a non-color cue). `tests/extension-html.test.mjs`
asserts that `panel.css` contains a rule for every selector in this table:

| Attribute (element) | Set when | Required CSS |
|---|---|---|
| `[data-attention="true"]` on `#btn-options`, `#btn-mic-permission`, `#btn-mic-allow` | 5.11 (key failure -> Options; microphone -> the two microphone buttons) | `outline: 2px solid var(--accent); outline-offset: 2px; font-weight: 700` |
| `[data-attention="true"]` on `#tab-arm-note` | the wait for the toolbar-icon click (`awaiting`) | `outline: 2px solid var(--accent)` AND a leading glyph `::before { content: "\2192\00a0"; }` (a text cue that survives forced-colors) |
| `[data-emphasis="true"]` on `#usage-note` | quota-suspect error with both lanes enabled (rule 12) | `font-weight: 700; border-inline-start: 4px solid var(--warning); padding-inline-start: var(--space-2)`; the emphasis is ALSO in the text (`ext.usage.quotaHint` is appended), so it reaches screen readers |
| `#status-pill[data-state]` = `idle`, `starting`, `running` | rule 4 | see the pill bullet above |
| `#btn-mute[data-muted="true"]` | `speechMuted` | see the mute bullet above |
| `.icon-slash`, `#btn-mute[data-muted="true"] .icon-slash` | the slash path of the mute icon | `display: none` by default, `display: inline` while muted (shape cue) |
| `.btn[aria-disabled="true"]` on `#btn-start` | Start is unavailable (no key, or no lane enabled) | drawn like `:disabled`, no hover effect; this one rule lives in `styles.css` (shared with the web app), `panel.css` adds nothing |
| `.notice:empty`, `.text-sub:empty` | live region without text | zero margin, padding, border and min-height (still rendered) |

#### 8.2.3 The pure view model (`extension/panel/view-model.js`, group C)

```js
buildViewModel({
  settings,            // normalized settings
  keyPresent,          // boolean: hasKey(local) || BUILTIN_KEYS.length > 0
  host,                // UiState | null (null = no host / not connected)
  armed,               // boolean: the panel's target tab is armed
  targetTab,           // { id, title, capturable } | null (title bounded to 60 chars; capturable from the URL scheme)
  shortcut,            // string | null: the ACTUAL keyboard shortcut of _execute_action (commands.getAll), null = unassigned/unknown
  micPermission,       // 'granted' | 'denied' | 'prompt' | 'unknown'
  micWasGranted,       // boolean, panel-local: the permission was 'granted' at some point while this panel was open
  pending,             // { tab: boolean, mic: boolean } local: Start pressed, waiting (arm) or in flight
  localErrors,         // { tab: string | null, mic: string | null } codes from a failed sw/lane-start
  stopReason,          // null | 'panel-gone' | 'host-lost': from interp.lastStop.v1 (fresh, no lane running) or a port lost unexpectedly
  previews,            // { tab: CaptionFrame | null, mic: CaptionFrame | null }
  capturedTitle,       // string | null: the title of the CAPTURED tab, resolved by the controller with tabs.get (rule 10)
  runWith,             // { tab: { twoWay, partnerLanguage } | null, mic: ... }: the two-way choice each lane was STARTED with (panel-local; LaneState carries no pair), for rule 13
  language,            // 'ko' | 'en' | 'ja': echoed as ViewModel.language
  has,                 // (key) => boolean, the loaded dictionary's key test, handed to errorKeyFor (optional: a built-in table of the ext.error.* and error.* keys is the default)
}) -> deeply frozen ViewModel
```

```jsonc
ViewModel = {
  "language": "ko",
  "pill": { "state": "idle|starting|running|warning|error", "key": "sim.status.idle", "params": {} },
  "keyMissing": false,
  "noLane": false,
  "stopNote": null | "ext.notice.panelGone" | "ext.notice.hostLost",
  "closeNote": false,                                   // any lane starting|running|reconnecting|stopping: "closing this panel also stops interpretation"
  "primary": { "mode": "start|stop", "key": "common.start|common.stop|common.cancel", "disabled": false },   // disabled is rendered as aria-disabled="true" plus an ignored click (8.2.6), never as the native attribute
  "lanes": { "tab": LaneVM, "mic": LaneVM },
  "micPermission": { "state": "granted", "textKeys": ["permission.title", "permission.granted"], "attention": false, "allowButton": false },
  "mute": { "muted": true, "labelKey": "ext.sound.on", "noteVisible": true },
  "echoNote": false,                                    // speech is ON and the mic lane is enabled
  "usageNote": { "visible": false, "emphasis": false }  // emphasis also appends ext.usage.quotaHint to the text
}
LaneVM = {
  "enabled": true, "targetLanguage": "ko", "captions": false, "volume": 65 /* tab only */,
  "twoWay": false, "partnerLanguage": "en", "partnerOptions": ["en", "ja"],       // rule 18
  "targetLabelKey": "language.target" | "ext.twoWay.targetLabel", "modelNote": false,
  "phase": "off|awaiting|starting|running|reconnecting|stopping|error",     // 'awaiting' = local pending, waiting for arm
  "status": { "key": "sim.status.idle", "params": {} },                       // rendered through ext.lane.statusLine
  "route": null | { "textKey": "sim.route.flash", "model": "gemini-3.8-live" },
  "routeNote": null | "ext.route.fallbackNote",                                 // the backup-model warning, in its own live region (rule 6)
  "output": null | "ext.output.blocked",
  "gap": null | "ext.gap.input" | "sim.gap.audio" | "sim.gap.reception",
  "notice": null | { "key": "ext.error.TAB_ENDED", "params": {}, "attention": "options|permission|null" },
  "armNote": null | { "key": "ext.arm.needed|ext.arm.waiting|ext.arm.ready|ext.error.TAB_UNSUPPORTED", "attention": true,
                      "hintKeys": ["ext.arm.pinHint"], "shortcut": "Alt+Shift+Y" },   // tab only; hints and shortcut only on needed/waiting
  "tabline": null | { "title": "…" },                                        // tab only: 'ext.tab.target' with {title}
  "applyNext": false,                                                        // 'ext.applyNext' in this lane's card (language, model or two-way choice, rule 13)
  "level": 0, "levelVisible": false,
  "preview": [ { "id":"…", "role":"translation", "status":"final", "text":"…", "skipped": false } ]    // max 4 rows, from the last CaptionFrame
}
```

Derivation rules (each is a unit test in `tests/extension-panel.test.mjs`):
1. Lane phase: from `host.lanes[lane].phase` when `host` is not null; else `off`. If `pending[lane]`: `awaiting` when the lane is the tab
   lane, not armed and the host does not run it; otherwise `starting`. A host phase that is already `starting|running|reconnecting|stopping` wins over a local `pending` flag (a Start whose `sw/lane-start` has not answered yet does not drag a running lane back to "starting"), and a lane with a local error and an idle host is `phase: 'error'`, so the pill and the notice agree.
2. `primary.mode = 'stop'` when any lane phase is `starting|running|reconnecting|stopping|awaiting`, else `'start'`.
   `primary.key`: `common.start` in mode `start`; in mode `stop`, `common.cancel` when every lane that is not `off` is `awaiting` (nothing has
   started yet: the only thing to abort is the wait for the toolbar-icon click), else `common.stop`. `noLane = (mode === 'start' && !settings.lanes.tab.enabled && !settings.lanes.mic.enabled)`
   (shows `#no-lane-note`). `primary.disabled = (mode === 'start' && (!keyPresent || noLane))`. Stop/Cancel is never disabled. The controller renders `disabled` as `aria-disabled="true"` on `#btn-start` and `onPrimary` returns at once while it is set (8.2.6).
3. `keyMissing = !keyPresent`.
4. Pill precedence (lanes that are enabled OR not `off` participate; E = lanes in `error`, R = lanes in `starting|awaiting|running|reconnecting`):
   E nonempty and R empty -> `warning` / `sim.status.stopped` when every error code is `TAB_ENDED` or `TAB_GONE` (not an alarm), else `error` /
   `ext.status.failed`; E nonempty and R nonempty -> `warning` / `ext.status.partial` (one interpretation fails while the other runs: the pill must not
   contradict the running lane); else any `reconnecting` -> `warning` / `ext.status.reconnecting` with `{count: max retries}`; else any `stopping` -> `warning` /
   `sim.status.stopping`; else any `awaiting` and none `starting` -> `warning` / `ext.status.awaitingArm` (dashed border: the user has something to DO;
   "Checking permissions and audio readiness" would be false); else any `starting` -> `starting` / `sim.status.connecting` (or `sim.status.preparing` when a
   lane's `engineStatus` is null or `preparing`); else any `running` -> `running` / `sim.status.running`; else `idle` / `sim.status.idle`.
5. Lane status line = `ext.lane.statusLine` with `{lane: t('ext.lane.<lane>.title'), status: t(status.key, status.params)}`; status key by the table of 5.11
   (a local `awaiting` phase uses `ext.status.awaitingArm`; an idle lane whose checkbox is off reads `ext.status.off`, not `sim.status.idle`).
6. `route` only while `phase === 'running'`: `{ textKey: fallback ? 'ext.route.fallback' : route === 'translation' ? 'sim.route.translation' : 'sim.route.flash', model }`, rendered as `label · model` in `#<lane>-route`; `ext.route.fallback` is only the short label ("Backup model"). `routeNote = 'ext.route.fallbackNote'` while running with `fallback`, else null: the warning is rendered into the persistent live region `#<lane>-route-note` (a sentence appended to a non-live line would never be announced), and the region is emptied when it does not apply.
7. `output`: `ext.output.blocked`, `sim.output.delayed|catching_up|unavailable` only while `running` (rendered in `#tab-output` / `#mic-output`); `muted`/`ready` -> null.
   `gap`: `ext.gap.input` / `sim.gap.audio` / `sim.gap.reception` from `LaneState.gap` while `running|reconnecting`, else null.
8. `notice` priority: `localErrors[lane]` > host `errorCode` (phase `error`) > mic permission (`denied` with mic enabled, or `prompt` with a
   `localErrors.mic` of `MICROPHONE_DENIED`) > overlay (`phase running`, `captions` on, `overlay === 'unavailable'` -> `ext.error.OVERLAY_UNAVAILABLE`, both lanes).
   The key comes from `errorKeyFor(code, has, lane)`; `attention` follows 5.11 (`options` for key failures, `permission` for `MICROPHONE_DENIED`, else null).
   `MICROPHONE_DENIED` becomes `ext.error.MICROPHONE_EXPIRED` when `micPermission === 'prompt' && micWasGranted` (a one-time grant expired).
   `NEEDS_ARM`, `ALREADY_RUNNING` and `START_CANCELLED` never become notices; `LANE_STOPPING` does. When BOTH lanes' notices are key failures (the same key),
   only the tab card keeps it (`notice = null` for the mic lane): one problem is announced once, not once per lane. A local `TAB_UNSUPPORTED` recorded on an earlier page is ignored while the target tab is known to be unsupported (the arm note already names it), and a local `MICROPHONE_DENIED` is cleared by the controller the moment the permission becomes `granted` (8.2.4 step 3).
9. `armNote` (tab lane only): `null` while the lane is `starting|running|reconnecting` and while its checkbox is off; target tab not capturable -> `ext.error.TAB_UNSUPPORTED`; `null` too while the lane's own error notice already says what to do about the icon
   (`TAB_INPUT_LOST`, `TAB_ENDED`, `TAB_GONE`, `TAB_UNSUPPORTED` or a code of `TAB_CAPTURE_CODES`: "click the icon" twice, or "ready" next to a notice that says "click the icon", only adds noise or contradicts it); armed -> `ext.arm.ready`
   (no attention); not armed and the lane is enabled -> `ext.arm.waiting` with `attention: true` when `pending.tab` (Start was pressed: the icon click will start it), else
   `ext.arm.needed` (idle: the icon click only gets the tab ready, Start is still to be pressed; no attention). The two keys are DIFFERENT because their promises differ.
   `hintKeys` (`['ext.arm.pinHint']`) and `shortcut` (rendered by the controller as `t('ext.arm.shortcut', { shortcut })`; omitted when the shortcut is null, i.e. unassigned or unknown) are attached only to `needed` and `waiting`. An error notice of `TAB_ENDED`, `TAB_GONE` or `TAB_INPUT_LOST` never sets
   `pending.tab` (no auto-start after an error): the arm note stays empty while such a notice shows, and the notice itself says "click the icon, then press Start".
10. `tabline`: shown when the tab lane is `starting|running|reconnecting` and a title is known: `ext.tab.target` with `{title}`
    (the title of the CAPTURED tab, resolved by the controller with `tabs.get(host.lanes.tab.tabId)`).
11. `mute.muted = settings.speechMuted`; `labelKey = muted ? 'ext.sound.on' : 'ext.sound.off'` (they name the INTERPRETED speech); `noteVisible = muted && (tab.enabled || mic.enabled)`;
    `echoNote = !muted && mic.enabled` (`ext.sound.echoWarning`: speakers feed the interpreted voice and the tab audio back into the microphone, doubling captions and quota).
12. `usageNote.visible = settings.lanes.tab.enabled && settings.lanes.mic.enabled`; `emphasis = visible && any lane errorCode is in
    QUOTA_CODES or equals SESSION_LIMIT or BUDGET_EXHAUSTED` (both lanes enabled and a "reopened three times" failure is most likely a concurrent-session refusal, 5.9); when
    `emphasis`, the controller appends `ext.usage.quotaHint` to the note text (emphasis is not color alone).
13. `LaneVM.applyNext = lane phase in starting|running|reconnecting && host lane known && (settings target !== host lane targetLanguage || (effectiveModel !== host model && !host fallback) || pairChanged)`,
    rendered in THAT lane's card (`#tab-apply-next`, `#mic-apply-next`). `effectiveModel` is `gemini-3.8-live` when the lane's two-way is on and its model setting is the translation-only one (the engine's own switch, 5.12), else the setting's model:
    comparing the raw setting would show "applies next" for the whole run of a two-way lane on the translation-only default. `pairChanged` compares `runWith[lane]` (the two-way choice the panel started the lane with) with the settings: true when
    `twoWay` differs or, with two-way on, when `partnerLanguage` differs. Without a record (a lane started by another panel or window, or after a lost connection) nothing is claimed: the safe direction.
14. `micPermission.textKeys = ['permission.title', 'permission.<state>']` for `granted|denied|prompt`; `unknown` -> `['permission.checking']`;
    `attention = (micPermission !== 'granted') && (mic enabled && (pending.mic || localErrors.mic === 'MICROPHONE_DENIED'))` or the host mic error is `MICROPHONE_DENIED`;
    `allowButton = micPermission !== 'granted'` (the inline text button `#btn-mic-allow`).
15. `levelVisible = phase === 'running' || phase === 'reconnecting'`; `level = host level`.
16. `preview` = the last caption frame rows (max 4) for the lane, mapped to `{id, role, status, text, skipped}`; empty when the lane is `off` with no error. Skipped rows stay in the
    panel (labelled `sim.captions.skipped`); the overlay hides them (8.5.3).
17. `stopNote`: `ext.notice.panelGone` for `stopReason` `panel-gone`, `ext.notice.hostLost` for `host-lost`, else null; `closeNote = any lane phase in starting|running|reconnecting|stopping`.
18. Two-way (per lane, from the settings): `twoWay = lanes[lane].twoWay === true`; `partnerLanguage` = the setting; `partnerOptions` = `TARGET_LANGUAGES` without the lane's `targetLanguage` (the select never offers the first language, so a pair is always two
    languages); `targetLabelKey = twoWay ? 'ext.twoWay.targetLabel' : 'language.target'` (the lane no longer interprets INTO one language); `modelNote = twoWay && model === TRANSLATION_ONLY_MODEL` (the non-live `#<lane>-two-way-note`, `ext.twoWay.modelNote`,
    is shown only then). `view-model.js` exports the two model ids it needs, `TRANSLATION_ONLY_MODEL` (`gemini-3.5-live-translate-preview`) and `PAIR_MODEL` (`gemini-3.8-live`), instead of importing `live-config.js` (a panel module may import no app module
    but `app/i18n/index.js`, R6 of 3.3); `tests/extension-panel.test.mjs` compares them with `live-config.js` and with the choice the sim engine makes for a pair, and fails if a second translation-only model appears. The partner row is hidden while `twoWay` is false.

#### 8.2.4 Panel controller (`extension/panel/controller.js`, group C)

```js
createPanelController({ document, adapter, i18n /* mutable holder: { current } */, loadI18n, settingsApi,
                        createHostLink /* factory, default host-link.js */, timers, navigator })
  -> Readonly<{ start(): Promise<void>, dispose(): void, viewModel(): ViewModel }>
```

`start()`:
1. Read settings (`readSettings`; on the very first run, when `interp.settings.v1` does not exist, write `createDefaultSettings(selectLanguage(navigator.languages))` so the two target languages follow the browser language, as the options page does too) and `keyPresent`; resolve i18n (`loadExtensionI18n`, settings language else `navigator.languages`); `applyI18n(document, i18n)`.
2. `windowId = (await adapter.windows.getCurrent()).id`; `targetTab = tabs.query({active:true, windowId})[0]`; resolve `armed` from `storage.session['interp.armed.v1']`;
   `shortcut` from `adapter.commands?.getAll()` (the entry named `_execute_action`, its `shortcut` string; an empty string means unassigned and becomes null, as does a failure); `stopReason` from
   `storage.session['interp.lastStop.v1']` when its `at` is within 60 s and no lane runs.
3. Subscribe: `storage.onChanged` (`local`: settings, key; `session`: armed, host, lastStop), `tabs.onActivated` / `tabs.onUpdated` (target tab changes), mic
   `PermissionStatus.onchange` (`navigator.permissions.query({name:'microphone'})`, feature-detected; failure -> `'unknown'`; a `granted` value sets the panel-local
   `micWasGranted` and clears a local `MICROPHONE_DENIED` refusal: its notice would send the user to an Allow button that is gone and the pill would keep saying "failed"; the next Start writes a fresh result).
4. `hostLink` (8.2.7): connect when `interp.host.v1.up` is true.
5. Render = `applyViewModel(document, viewModel, i18n)`: only `textContent`, attributes (among them `aria-disabled` on `#btn-start`), `hidden`, `value`, `checked`. Live regions follow the rule of 8.2.1
   (write text or `''`, never toggle `hidden`).

Every user event writes settings first (`updateSettings` with a one-field mutator) and then performs its command.

Two-way events: `#<lane>-two-way` writes `twoWay` and `#<lane>-partner` writes `partnerLanguage`; both apply from the next start (a running lane shows `ext.applyNext`, like a target change). `#<lane>-target` writes the target and, in the SAME write, when the new
target equals the stored partner, moves the language just left into the partner's place (the swap a user expects), so the repaired pair is saved with the change and an equal pair is never stored. The controller renders `#<lane>-target-label`
(`data-i18n` and text from `targetLabelKey`), the partner row's `hidden`, the partner options (rebuilt only when the choice list changes) and the note. It also records `{ twoWay, partnerLanguage }` of every start it sent as `runWith[lane]` (cleared when
the lane is off or in error, and on a lost connection) because `LaneState` deliberately carries no pair: a `laneStateFromSnapshot` state of a two-way lane has exactly the one-way keys.

#### 8.2.5 Interaction flows (state machine of the panel)

Local pending state per lane: `pending.tab`, `pending.mic` (booleans), `localErrors`, and a `startRun` counter that Stop increments. Internally the controller keeps `awaiting` (a Start waiting for the toolbar-icon click) and `inFlight` (a `sw/lane-start` under way, per lane) apart and hands the view model `pending = { tab: awaiting || inFlight.tab, mic: inFlight.mic }`; one flag for both would send a duplicate start when the armed record changes during a call.

- `#btn-start` while `primary.disabled` (no key, or no lane enabled): the click is ignored (`onPrimary` returns at once: no message, no notice, no pill change); the button is `aria-disabled`, not `disabled`, so it still receives the click.
- `#btn-start` when `mode === 'start'`: `startEnabled()`:
  1. Clear `localErrors` and `stopReason`; `run = ++startRun`. For each enabled lane, in the order tab, then mic (sequential: await the first `sw/lane-start` before the second; before
     EACH lane and after each await: `if (run !== startRun) return`, so a Stop pressed meanwhile also prevents the second lane from being sent):
  2. Mic: if `micPermission` is `denied` or `prompt` set `localErrors.mic = 'MICROPHONE_DENIED'` (no message sent; `attention` on the permission buttons), continue; `granted` and `unknown` (no Permissions API) proceed and the host preflight decides.
  3. Tab: no target tab -> `localErrors.tab = 'TAB_GONE'`; a target tab that is not capturable -> nothing for the tab lane (a silent no-op: the arm note `ext.error.TAB_UNSUPPORTED` is the one explanation, an alert and a "failed" pill would only repeat it; the microphone lane of the same Start still runs); if not armed -> `pending.tab = true` (state `awaiting`, `ext.arm.waiting`), continue.
  4. Otherwise `pending[lane] = true` for the duration of the call (state `starting`; Stop/Cancel is therefore available immediately) and `sendMessage(makeMessage('sw/lane-start', {lane, tabId?}))`; then clear `pending[lane]`.
     `ok` -> nothing more (state arrives over the port); `{ok:false, code}`: `NEEDS_ARM` -> `pending.tab = true` (and the armed record is gone so the note reappears);
     `ALREADY_RUNNING` and `START_CANCELLED` -> ignore; other codes (including `LANE_STOPPING`) -> `localErrors[lane] = code`.
- `#btn-start` when `mode === 'stop'` (label Stop, or Cancel while only `awaiting`): `startRun++`; `pending = {tab:false, mic:false}`; `sendMessage(makeMessage('sw/lane-stop', {}))`. The message goes to the SW, NOT to the host: only the SW knows about a start that has not reached the host yet
  (6.3, 6.11); a `host/lane-stop` sent straight to a host that does not exist yet used to be lost ("no host = nothing to stop") and the lane then started after the user pressed Stop. A rejection is ignored.
- Auto-start: whenever the armed map changes (or the target tab changes) and `pending.tab && armed(targetTab.id)`, clear `pending.tab` and send `sw/lane-start` for the tab lane.
  The user's click on the toolbar icon therefore both arms and starts, but ONLY when Start was pressed first (`ext.arm.waiting`); after an error the arm just makes the tab ready (`ext.arm.ready`, then Start).
  Pending is cancelled by Stop/Cancel, by unchecking `#tab-enabled`, and expires with the panel.
- `#tab-enabled` / `#mic-enabled` change: persist `lanes.<lane>.enabled`. While `mode === 'stop'`: unchecked -> `sw/lane-stop {lane}` and clear that lane's pending;
  checked -> the same start path as `startEnabled()` for that lane only. While idle: persist only.
- `#tab-target` / `#mic-target`: persist; running lane keeps its language (hint `#tab-apply-next` / `#mic-apply-next`).
- `#tab-volume` `input` (throttled to at most one write per 120 ms with injected timers, final value on `change`): persist `lanes.tab.originalVolume`; `#tab-volume-value` shows
  `ext.volume.value` `{percent}`; `aria-valuetext` is the same text. The SW forwards the edit (6.6).
- `#tab-captions` / `#mic-captions`: persist (Live: ticking one during a run attaches the overlay through the SW, 6.6).
- `#btn-mute`: persist `speechMuted` toggled (Live).
- `#btn-mic-permission` and `#btn-mic-allow`: `sendMessage(makeMessage('sw/permission-open', {}))`.
- `#btn-options`, `#btn-key-options`: `adapter.runtime.openOptionsPage()`.
- The panel never sends `host/lane-start` or `host/lane-stop` and never holds a stream id or key.

#### 8.2.6 Keyboard and ARIA

- DOM order equals visual order (no CSS `order`). Tab order: `#tab-enabled`, `#tab-target`, `#tab-two-way`, `#tab-partner`, `#tab-volume`, `#tab-captions`, `#tab-preview`, `#mic-enabled`,
  `#mic-target`, `#mic-two-way`, `#mic-partner`, `#mic-captions`, `#btn-mic-allow`, `#mic-preview`, `#howto`, `#btn-start`, `#btn-mic-permission`, `#btn-mute`, `#btn-options` (`#btn-key-options` and `#btn-mic-allow`
  are in the order only while they are not `hidden`; the same holds for `#<lane>-partner`, whose row is hidden while two-way is off). The two-way checkbox is described by `#<lane>-two-way-hint` (`aria-describedby`); the hint and the model note `#<lane>-two-way-note`
  are plain text, not live regions.
- Live regions (persistent, never `hidden`, text written by the controller; rule of 8.2.1): `#status-pill`, `#tab-arm-note`, `*-route-note`, `*-output`, `*-gap`, `*-apply-next`, `#mic-permission-status`, `#mute-note`,
  `#echo-note`, `#no-lane-note`, `#stop-note`, `#key-missing`, `#usage-note` are `role="status"` (implicit polite). The per-lane status lines `#tab-status` / `#mic-status` are NOT live regions (no role, no `aria-live`): the pill and the notices already announce every state change they show, and saying it twice was noise. The route lines `#<lane>-route` are not live either; their warning is `#<lane>-route-note`. The lane error notices `#tab-notice` / `#mic-notice` are `role="alert"`
  (assertive): an error is what a person who cannot see the panel most needs to hear. A problem shared by both lanes (a rejected key) is announced ONCE (rule 8 of 8.2.3), not once per lane.
  Caption previews are `role="region"`, `aria-live="off"` and focusable (`tabindex="0"`, `aria-label` `sim.captions.latest`; the role makes the label a name that is announced, a bare `div` gets none); captions are NOT announced anywhere in v1 (no partial reads, as in the web app;
  the overlay is not live either, 8.5.2): a screen-reader user can read the preview on focus, and that is the whole story today (an opt-in "announce final rows" mode is a possible later addition).
- The controller never moves focus on a state change. `aria-disabled` is used for Start ONLY: a natively `disabled` button is skipped by Tab, so its reason could never be reached from the keyboard. Start therefore stays focusable with `aria-disabled="true"`
  and `aria-describedby="key-missing no-lane-note"` while it is unavailable, the controller ignores its click (8.2.5), and `styles.css` draws `.btn[aria-disabled="true"]` like `:disabled`; a keyboard or screen-reader user who lands on it hears WHY it cannot start. That this is announced as intended is unverified (13.31, 13.49).
- Every control has an accessible name from a `<label>` or an i18n `aria-label`; icon buttons carry no visible text and an `aria-label`; meters carry an `aria-label`. The two buttons that used to
  share the name "Options" are now `ext.key.enter` (in the key notice) and `ext.options.title` (in the row).
- Targets >= 44 px; visible focus ring from styles.css; state never by color alone.
- Manual VoiceOver pass and keyboard-only pass: checklist 13.31 (fakes cannot prove announcements).

#### 8.2.7 Host link (`extension/panel/host-link.js`, group C)

```js
createHostLink({ adapter, onState, onCaptions, onConnection }) -> Readonly<{ connect(): void, disconnect(): void, connected(): boolean }>
// onState(uiState), onCaptions(captionFrame), onConnection(connected, { bye }): `bye` says whether the host announced its own end before the port closed (an expected loss)
```
`connect()` opens `adapter.runtime.connect({ name: PORT_NAMES.panel })`, immediately posts `{v:1,type:'hello'}`, routes `state`/`captions`/`bye` frames to the callbacks (frames are
validated: `v === 1`, known `type`, size, shape; invalid frames are dropped), and on `onDisconnect` sets `connected() = false`, calls `onConnection(false, { bye })` and does NOT reconnect by itself (the panel's own `disconnect()`, on dispose or when the host flag goes down, is not a loss and calls nothing; every port handler first checks `port === current`).
The controller reconnects on (a) start, (b) `interp.host.v1.up` turning true, (c) a successful `sw/lane-start` response. A port with no receiver disconnects immediately (no host): the panel then shows the idle state.
UNEXPECTED loss (review: it used to end in a silent "idle"): when `onConnection(false)` arrives, the last state had a lane in `starting|running|reconnecting`, the host did not send `bye`, and this
panel sent no stop within the last 5 s, the controller sets `stopReason = 'host-lost'` (shows `ext.notice.hostLost`) and sends `sw/host-probe`, which reconciles the stale `interp.host.v1.up` flag (6.11) so the
port is not retried against a document that no longer exists. If the SW's `lastStop` says `panel-gone`, that notice wins (a reopened panel after a grace stop).

#### 8.2.8 State gallery (every panel state -> what is visible; each row is a `buildViewModel` case and an HTML/CSS review item)

| State | When | Visible / changed elements (keys) |
|---|---|---|
| Idle | no lane running, key present, a lane enabled | pill `idle` `sim.status.idle`; lane status lines `sim.status.idle` (`ext.status.off` for a lane whose checkbox is off); `#btn-start` = `common.start`, available; `#mute-note` when muted |
| Key missing | no personal key and no built-in key | `#key-missing` text (`ext.key.missing`) + `#btn-key-options` (`ext.key.enter`); `#btn-start` `aria-disabled="true"` and described by it (its click is ignored) |
| No lane enabled | both checkboxes off, mode `start` | `#no-lane-note` (`ext.status.noLane`); `#btn-start` `aria-disabled="true"` |
| Tab: not armed | tab lane enabled, target tab not armed, Start NOT pressed | `#tab-arm-note` = `ext.arm.needed` + `ext.arm.pinHint` (+ the shortcut) (no attention: the icon click only gets the tab ready, then Start) |
| Tab: armed | target tab armed | `#tab-arm-note` = `ext.arm.ready` ("ready, press Start") |
| Tab: unsupported page | target tab URL scheme not capturable | `#tab-arm-note` = `ext.error.TAB_UNSUPPORTED` |
| Awaiting arm | Start pressed, tab lane pending | `#btn-start` = `common.cancel`; pill `warning` `ext.status.awaitingArm`; `#tab-status` `ext.status.awaitingArm`; `#tab-arm-note` = `ext.arm.waiting` with `data-attention="true"`; starts by itself once armed |
| Starting | host lane `starting` | pill `starting` (`sim.status.preparing` then `sim.status.connecting`); `#btn-start` = `common.stop`; level meter hidden; `#close-note` |
| Running (per lane) | lane `running` | pill `running` `sim.status.running`; `#<lane>-route` (`sim.route.* · model`); level meter visible; `#tab-tabline` (`ext.tab.target`); preview rows; `#<lane>-gap` when the uplink dropped input; `#close-note` |
| Reconnecting | lane `reconnecting` | pill `warning` `ext.status.reconnecting` `{count}`; meter visible; capture and passthrough untouched |
| Stopping | lane `stopping` | pill `warning` `sim.status.stopping` |
| Lane error | lane `error` | `#<lane>-notice` = `errorKeyFor(code, has, lane)` text (role alert); pill `error` `ext.status.failed` (`warning` `sim.status.stopped` for `TAB_ENDED`/`TAB_GONE`; `warning` `ext.status.partial` when the other lane runs); `data-attention` on `#btn-options` or the microphone buttons per 5.11; the other lane is unaffected |
| Mic permission needed / denied | `prompt` or `denied` with the mic lane enabled | `#mic-permission-status` = `permission.title · permission.<state>`; `#btn-mic-allow` visible; after a Start attempt `#mic-notice` = `ext.error.MICROPHONE_DENIED` (or `MICROPHONE_EXPIRED`) and the two buttons get `data-attention` |
| Both lanes warning | both checkboxes on | `#usage-note` visible; `data-emphasis="true"` + `ext.usage.quotaHint` while a lane shows a quota code, `SESSION_LIMIT` or `BUDGET_EXHAUSTED` |
| Muted note | `speechMuted` and a lane enabled | `#mute-note`; `#btn-mute[data-muted="true"]` with label `ext.sound.on` |
| Echo warning | speech ON and the mic lane enabled | `#echo-note` = `ext.sound.echoWarning` |
| Output blocked/delayed | engine output state | `#<lane>-output` = `ext.output.blocked`, `sim.output.delayed` etc. |
| Model fallback | `fallback: true` | `#<lane>-route` = `ext.route.fallback` ("Backup model") `· model`; `#<lane>-route-note` (live) = `ext.route.fallbackNote` |
| Overlay unavailable | a lane `overlay: 'unavailable'` while running with captions on | that lane's notice = `ext.error.OVERLAY_UNAVAILABLE` (mentions reloading the page); preview still shows captions |
| Apply next | a running lane's language, model or two-way choice differs from settings | that card's `#<lane>-apply-next` (`ext.applyNext`) |
| Two-way on | `twoWay` checked for a lane | that card: `#<lane>-partner-row` visible (label `ext.twoWay.partner`, the select without the lane's first language); `#<lane>-target-label` = `ext.twoWay.targetLabel`; `#<lane>-two-way-hint` is always visible |
| Two-way on the translation-only model | two-way on and the lane's model setting is `gemini-3.5-live-translate-preview` | `#<lane>-two-way-note` visible (`ext.twoWay.modelNote`); when the lane runs, its route line reads `sim.route.flash · gemini-3.8-live` and `#<lane>-apply-next` stays empty |
| Stopped for a reason | `interp.lastStop.v1` fresh (within 60 s) and no lane running, or an unexpected port loss | `#stop-note` = `ext.notice.panelGone` / `ext.notice.hostLost`; cleared by the next Start |
| No host | no offscreen document / port closed by the user's own Stop | all lanes `off`; state as Idle |

### 8.3 Options page (`extension/options/options.html`)

Ids are in 7.3; inside a section the DOM order is the row order of the 7.3 table. Structure (DOM order): `h1#opt-title` (`ext.options.title`), `p#opt-lead` (`ext.options.lead`), section key (`h2#opt-h-key` text `settings.key`), section lanes
(`h2#opt-h-lanes`: language, model, voice, volume, captions-per-lane, `p#opt-defaults-hint` `ext.options.defaultsHint`), section captions (`h2#opt-h-captions`), section privacy (`h2#opt-h-privacy`),
`p#opt-saved`. Controller: `createOptionsController({ document, adapter, i18n, loadI18n, settingsApi, timers })` -> `{ start(), dispose() }`. Behavior:
- Loads settings and shows them; every `change` writes ONE field through `updateSettings` and shows `#opt-saved` for 2000 ms (the two number fields, `#opt-caption-lines` and `#opt-caption-hide`, check their range first: a value outside it, a fractional one or an empty one puts the STORED value back and writes and says nothing, because `normalizeSettings` would otherwise turn it into a default while "Saved." was shown, 7.2); `storage.onChanged` re-renders (panel edits show up live).
- Key: `#opt-key-save` trims and validates (`validateKey`); invalid -> `#opt-key-status` = `error.INVALID_KEY`; valid -> `await adapter.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` (a rejection or a
  missing API -> the key is NOT written, `#opt-key-status` = `ext.error.STORAGE_FAILED`), then `writeKey`, clear `#opt-key`, status `ext.key.savedBrowser` (not the app's `settings.keySavedBrowser`: its Korean text is in a formal register), which stays until the next key action; a page that is opened afterwards reports `settings.keyStored`.
  `#opt-key-delete` -> `deleteKey`, status `settings.keyDeleted` (until the next key action; a page that is opened afterwards reports `settings.noKey`, or `ext.key.builtin` when the build carries a key). `#opt-key-toggle` switches `#opt-key` between `password` and `text`
  (the label swaps `ext.options.keyShow` / `ext.options.keyHide`; no `aria-pressed`). The stored key is NEVER read back into the input.
- `#opt-key-guide` opens `KEY_GUIDE_URL` in a new tab with `rel="noopener noreferrer"`.
- Language change re-renders the page (`applyI18n` again, `html lang`).
- The page works with an empty store (defaults) and with `storage` rejecting (shows defaults, `ext.error.STORAGE_FAILED` in `#opt-saved`; the web app's `error.STORAGE_FAILED` tells the user to "turn saving off", an option this page does not have).
- The privacy section shows `ext.privacy.audio`, `ext.privacy.freeTier` and `ext.privacy.page` (7.3).

### 8.4 Microphone-permission page (`extension/permission/mic-permission.html`)

The entry `mic-permission.js` reads `uiLanguage` from `storage.local` for the page's language (the controller itself takes a ready I18n instance).

Purpose (D5): obtain the microphone permission for the extension origin, because neither the offscreen document nor (probably) the side panel can show the prompt `[verified-doc / assumption A14]`.
Ids: `h1#perm-title` (`ext.permission.title`), `p#perm-lead` (`ext.permission.lead`), `p#perm-always` (`ext.permission.chooseAlways`), `button#perm-request` (`ext.permission.allowButton`), `p#perm-status[role=status]`,
`p#perm-help[role=status]` (`ext.permission.blockedHelp`), `button#perm-close` (`common.close`). `#perm-status` and `#perm-help` are persistent live regions (8.2.1 rule): their text is written (`#perm-help` only after a denial) and cleared, and neither is ever `hidden` (a region that appears together with its text is often not announced). The allow action has ONE name: `ext.permission.allowButton` on this page's button and on the panel's `#btn-mic-allow`, the same words as the page title `ext.permission.title` and as the notices that send the user there (`ext.error.MICROPHONE_DENIED`, `ext.error.MICROPHONE_EXPIRED`); only the panel's icon button `#btn-mic-permission` keeps `permission.request` (two visible buttons with the same name next to each other would be worse).

`createPermissionController({ document, navigator, window, i18n, timers })` flow:
1. Status `permission.checking`; `permissions.query({name:'microphone'})` (feature-detected). `granted` -> step 4.
2. Call `navigator.mediaDevices.getUserMedia({ audio: true })` on load (the prompt appears). The page tells the user what to AVOID (`ext.permission.chooseAlways`: do not choose "Allow this time"), not a label
   to pick: Chrome's own help lists the choices as "Allow while visiting the site", "Allow this time" and "Never allow" (https://support.google.com/chrome/answer/2693767, fetched 2026-09-29), which is NOT the
   "Allow on every visit" that the first draft quoted in all three languages. Whether the same three appear for an extension origin is unverified `[assumption A14]`; checklist 13.8 records the labels the owner
   actually sees. A one-time grant expires (page close, navigation, about 16 h for some grants, per the capture scout), after which the panel shows `ext.error.MICROPHONE_EXPIRED` instead of the generic
   denial (8.2.3 rule 8). Status `permission.prompt`.
3. Outcome: success -> stop every track immediately -> step 4. `NotAllowedError` / `SecurityError` -> status `permission.denied` + the text of `#perm-help` written (`ext.permission.blockedHelp`; every other branch clears it). `NotFoundError` -> `permission.noDevice` + `permission.noDeviceHint`.
   `NotReadableError` -> `permission.busy` + `permission.busyHint`. Any other error -> `permission.denied`.
4. Granted: status `permission.granted`, show `ext.permission.done` ("Allowed. This tab closes in a moment."), call `window.close()` after 2000 ms (timers injected; long enough to read the line); `#perm-close` also closes.
`#perm-request` repeats step 2. The microphone is never left on: tracks are stopped in every branch (a test asserts it).

### 8.5 Caption overlay (`extension/overlay/overlay.js`, group D)

#### 8.5.1 Shape and lifecycle

- One classic-script IIFE, no imports (R3). Injected by the static `content_scripts` entry (top frame, `document_idle`, isolated world) and, as a fallback for already-open armed tabs, by `scripting.executeScript` (6.7).
- Wire constants live in ONE frozen object literal `const WIRE = Object.freeze({ port: 'interp-overlay/1', v: 1, maxRows: 6, maxRowChars: 400 });` (pinned by tests without a cross-group import, 3.5).
- Idempotent: `const KEY = Symbol.for('interp.overlay.v1'); if (globalThis[KEY]) return;` then `globalThis[KEY] = Object.freeze({ dispose })`. A second injection does nothing.
- At load it does NOT connect. It listens on `chrome.runtime.onMessage` for `content/overlay-attach` (accepted only from `sender.id === chrome.runtime.id && sender.tab === undefined`,
  `v === 1`, `target === 'content'`, `type === 'content/overlay-attach'`) and answers `{ok:true}` for EVERY message it accepts (also when a port is already open and also when `connect` throws); a message that fails the trust check gets no answer at all (answering what the overlay refuses would fake a success). Attach is IDEMPOTENT while connected (review: several triggers can send it within milliseconds): if a port is already open it does nothing more; otherwise it
  calls `chrome.runtime.connect({ name: WIRE.port })`, stores that port as `current`, posts `{v:1,type:'hello'}` and handles frames. Every port handler (`onMessage`, `onDisconnect`) first checks `port === current` and
  does nothing when it is not (a late disconnect of a port the host replaced can never dispose the UI now owned by the new one).
- Orphan guard: every `chrome.*` access is wrapped in `try`; before use it checks `chrome.runtime?.id`. If the id is gone (extension reloaded/updated) or the port disconnects for good, it removes its DOM and listeners
  (`dispose()`) and never throws into the page. On `port.onDisconnect` (for `current`) it disposes the UI and clears `current` but keeps the `onMessage` listener, so a later `content/overlay-attach` (new lane) can attach again.
- It never reads the page: the only page properties it touches are `document.documentElement`, `document.fullscreenElement` (plus that element's `tagName`, `isConnected` and `shadowRoot`, and one `appendChild` call on it under strategy 1 of 8.5.3), `document.visibilityState` and the `fullscreenchange` / `visibilitychange` events.
  It sets no attribute or class on page elements, adds no listener on page elements, and appends exactly one element (the host), created when the FIRST frame is accepted and not at attach, so a port that never reaches a host (no receiver, or the host closes it at once) leaves no mutation on the page at all; the fullscreen handling of 8.5.3 moves that same element temporarily and always restores it.
- Strings (lane names, region label, status rows) come from `chrome.i18n.getMessage` (`_locales`, 9.3): content scripts cannot load the ext dictionary. The names are `overlayRegion`, `overlayHide`, `overlayLaneTab`, `overlayLaneMic`, `overlayGap`,
  `overlayReconnecting`, `overlayStopped`. A missing message renders an empty string, never a key name. They follow CHROME's UI language, not `settings.uiLanguage` (the panel and options do): with Chrome in English and the
  UI language set to Korean, the panel is Korean and the chips on the page are English. Pushing resolved strings in the attach message was considered and rejected (7 short labels; the SW would need its own dictionary fetch and a menu
  rebuild on language change; cost above value); the options page says so (`ext.options.uiLanguageHint`) and checklist 13.32 records it.

#### 8.5.2 DOM and styling (never breaks the host page)

- Host element: `document.createElement('interp-live-captions')` (an unknown tag; not `div`, so page CSS on `div` never matches). Styles set with CSSOM (`host.style.setProperty(name, value, 'important')`; measured to
  work under a strict page CSP `[observed]`): `all: initial; direction: ltr; unicode-bidi: isolate; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block; contain: layout style;`.
  `direction` and `unicode-bidi` are pinned separately because the CSS `all` shorthand does not reset them `[spec knowledge, unverified in a browser]`: without the pin an `<html dir="rtl">` page would flip the caption bar, move the
  start-edge markers of partial and interrupted rows and put the neutral punctuation of ko/ja/en captions on the wrong end. Each row also carries `dir="auto"`, so a row is shaped by its own text. Checklist 13.40 checks it on an rtl page.
- `const root = host.attachShadow({ mode: 'closed' })` and `root` is kept ONLY in the closure of the isolated world (14.4 change 1: D6 said `open`). Why: with an open root any script on the page, including third-party ads and analytics, can read
  `host.shadowRoot` and the caption text, which for the microphone lane is the user's OWN translated speech. With a closed root `host.shadowRoot` is `null` for everyone, and the closure variable is unreachable from the page's main world
  because a content script runs in an isolated JavaScript world `[assumption A28: reasoned from Chrome's isolated-world model, not measured here; checklist 13.28 checks it from the page's console]`. Nothing in the scouts' evidence required `open`
  (they exercised `open` only for CSS behavior). Stylesheet inside the shadow root: a constructable `CSSStyleSheet` via `adoptedStyleSheets` (primary); if unsupported, a `<style>` element with `textContent` (fallback);
  `securitypolicyviolation` is not handled (diagnostic only). `[observed]` all techniques applied under `style-src 'self'` with an OPEN root; that they behave the same for a closed root is expected (they attach to the `ShadowRoot` object the
  script holds, whatever its mode) but unmeasured; a third-party report of the opposite for strict CSP is unresolved `[assumption A15]`. Tests keep their own handle: the fake `attachShadow` records `lastShadowRoot`.
- Structure inside the shadow root:

```
<div class="wrap" data-position="bottom" data-display="dark" role="region" aria-label="{overlayRegion}">
  <button class="close" type="button" aria-label="{overlayHide}"></button>          (the ONLY pointer-events:auto element; glyph from CSS)
  <section class="lane" data-lane="tab" lang="ko"> <span class="chip">{overlayLaneTab}</span>
     <div class="rows"><p class="row" dir="auto" data-status="final|partial|interrupted">text (textContent)</p> … </div>
     <p class="status" data-phase="reconnecting|stopped">{overlayReconnecting|overlayStopped}</p>        (only while the lane has a status)
  </section>
  <section class="lane" data-lane="mic" lang="en"> … </section>
  <p class="gap">{overlayGap}</p>        (for about 8 s after a gap flag turns on)
</div>
```
  The close glyph is drawn by CSS (`.close::before { content: "\00d7"; }`), NOT by a `textContent` literal (the i18n checker flags literal text assignments); the button's only text is its `aria-label`.
- CSS (all inside the shadow stylesheet; px, not rem, because the host page's root font size is unknown): `.wrap { position: fixed; left: 50%; transform: translateX(-50%); width: min(90vw, 896px);
  max-height: min(40vh, calc(var(--size) * 16px * 1.35 * 8)); display: flex; flex-direction: column; justify-content: flex-end; min-height: 0; overflow: hidden; box-sizing: border-box; padding: 8px 12px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text);
  font: 600 calc(var(--size) * 16px)/1.35 -apple-system, "Segoe UI", Roboto, "Noto Sans KR", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif; letter-spacing: 0; text-align: start; pointer-events: none; opacity: 0.96; }`;
  `.lane, .rows { display: flex; flex-direction: column; justify-content: flex-end; min-height: 0; }`
  **Overflow anchoring (review: the newest row is LAST, and a plain block with `overflow: hidden` clips the BOTTOM edge, so a long sentence hid exactly the line being spoken):** `justify-content: flex-end` on the column makes an overflowing
  container overflow at its START edge, so it is the OLDEST lines that clip; the bound is about 8 visual lines at the current size (`max-height` above), and a top fade
  `.wrap { mask-image: linear-gradient(to bottom, transparent 0, #000 1.5em), linear-gradient(#000, #000); mask-size: 100% 100%, 40px 40px; mask-position: 0 0, right 0 top 0; mask-repeat: no-repeat; }` (plus the `-webkit-` spellings; no `url()`) hides the cut: the first layer is the fade, the second an opaque 40 px square over the close button's corner, so the button itself is never faded (the fade alone was the first build). A static CSS test asserts these rules; checklist
  13.30 checks long sentences at size 2.0 in a 500 px-high window (the fake DOM has no layout, so only a manual check proves it).
  `.wrap[data-position="top"] { top: 16px; }` `.wrap[data-position="bottom"] { bottom: 16px; }` `.wrap[hidden] { display: none; }` `.close { position: absolute; top: 4px; inset-inline-end: 4px; pointer-events: auto;
  min-width: 28px; min-height: 28px; ... }` `.row[data-status="partial"] { color: var(--muted); border-inline-start: 3px dashed var(--accent); padding-inline-start: 8px; }`
  `.row[data-status="interrupted"] { border-inline-start: 3px solid var(--danger); padding-inline-start: 8px; color: var(--muted); }` `.status { font: 600 13px/1.3 sans-serif; color: var(--muted); border-inline-start: 3px dashed var(--accent); padding-inline-start: 8px; }`
  `.gap { font: 600 13px/1.3 sans-serif; color: var(--muted); }` `.close::before { content: "\00d7"; }` `.chip { font: 700 12px/1 sans-serif; color: var(--muted); }` `@media (prefers-reduced-motion: no-preference) { .wrap { transition: opacity 150ms ease-out; } }`
  `@media (forced-colors: active) { .wrap { border-color: CanvasText; } }`. (Skipped translation rows are not rendered at all in the overlay: a struck-through line with no label is unexplained over a video; the panel keeps them, labelled.)
- Tokens per `data-display` (hex values copied from `styles.css`; `tests/extension-html.test.mjs` parses `styles.css` and asserts equality):

| token | `dark` (`--dark-*`) | `light` (`--light-*`) | `mono` (mono board block) |
|---|---|---|---|
| `--bg` | `#1e2329` (surface) | `#ffffff` (surface) | `#000000` |
| `--text` | `#edf0f3` | `#1a1d21` | `#ffffff` |
| `--muted` | `#aab3bd` | `#4d5560` | `#d4d4d4` |
| `--border` | `#3a434d` | `#c9d0d8` | `#8a8a8a` |
| `--accent` | `#7fb6dd` | `#1f5f8b` | `#ffffff` |
| `--danger` | `#ff8a80` | `#a5282c` | `#ffb4ab` |

  The same test computes WCAG contrast ratios with a small pure helper over this table and the panel tokens (text pairs >= 4.5:1, non-text borders and bars >= 3:1) so today's passing pairs stay passing.
- `--size` = the style frame `size` (1..2). z-index is the maximum 32-bit value; the overlay never uses `position: sticky/absolute` relative to page ancestors (it is `fixed` under the host which is `fixed` under `documentElement`).
- The captions are ko/en/ja (left-to-right), so the overlay does not follow the page's direction: the host pins `direction: ltr` and `unicode-bidi: isolate` and each row carries `dir="auto"` (the CSS `all` shorthand does not reset `direction`, above); `text-align: start` and logical properties are used anyway.
- The overlay has no focus trap and never calls `focus()`. The close button is keyboard-reachable only by tabbing to it (it is in the page's tab order at the end of the DOM, an accepted limitation `[assumption A16]`). There is no `aria-live` on the overlay
  (partial captions would flood screen readers), and NO surface announces captions in v1: the panel previews are `aria-live="off"` too (8.2.6). A screen-reader user can read the panel preview on focus; that is a stated limitation, not a solved case.

#### 8.5.3 Frame handling and display rules

State: `style` (from the last `style` frame, defaults `{size:1.5, position:'bottom', display:'dark', maxLines:3, autoHideSeconds:8}`), `lanes = { tab: null | frame, mic: null | frame }`, `dismissedEpoch = { tab: null, mic: null }` (`null`, or the epoch that was on screen when the user pressed close; `null` and not `-1`, because a lane that has only a status row, a `stopped` status followed by `clear`, has no frame epoch), the last accepted epoch per lane,
`status = { tab: null | 'reconnecting' | 'stopped', mic: ... }`, `gapOn` (a boolean with its own 8 s timer), `prevGaps = { tab: {input,audio,reception}, mic: ... }` (all false).

- `style` frame: validate ranges (size 1..2, position, display, maxLines 1..6, autoHideSeconds 0..60), store, re-render. Out-of-range values keep the previous value.
- `captions` frame for `lane`: ignore if the frame is malformed, larger than 16384 characters when stringified, or `lane` unknown. **Ignore when `dismissedEpoch[lane]` is set and `frame.epoch <= dismissedEpoch[lane]`** (one rule; the earlier text said `<` in one place and "same or older" in another, and with `<` the very next frame
  of the same epoch, about 100 ms later, re-showed the overlay, so the close button looked broken). Store it. Rows shown per lane = the last `maxLines` rows of `frame.rows` that are NOT `skipped` (chronological, newest LAST; the host already selected them). The newest row is at the
  bottom in both `top` and `bottom` positions. `partial` rows are muted with a dashed bar; `final` rows are plain; `interrupted` rows are muted with a solid danger bar and are dropped as soon as a newer row exists in the lane.
  Text is set with `textContent` after defensive truncation to 400 characters keeping the END; `lang` = `frame.lang` (in a two-way lane that is the NEWEST row's language, 4.6.3 rule 10; a row's own `lang` travels in the frame but this script, unchanged by the two-way work, does not read it, so an older row of the pair's other language sits in a section labelled with the newest row's language: a known limitation, checklist 13.56; an unknown `lang` is drawn without a `lang` attribute instead of dropping the frame; rows are validated for `text` (a string) and `status` (`final|partial|interrupted`) only, and `skipped` counts only when it is `true`).
  Gap line (review: the sticky flag made the warning permanent after one hiccup): on a `false -> true` transition of any `gaps` flag of the frame compared with `prevGaps[lane]` (reset when the epoch changes) the overlay shows `.gap` for about 8 s
  (`gapUntil`, a page-realm timer) and then hides it; a later new transition shows it again.
- `status` frame for `lane` (`phase` in `reconnecting|stopped|running`): `running` clears `status[lane]`; `reconnecting` sets it and it stays until `running` or `bye`; `stopped` sets it and a timer of about 8 s clears it. Each lane with a status renders one `.status` row
  (`overlayReconnecting` / `overlayStopped`). Without this channel captions vanished on an error or a reconnect with no explanation exactly when the user was looking at the page (review).
- There is NO toggle inside the overlay for source text, size or position: `showSource`, `size`, `position`, `display`, `maxLines`, `autoHideSeconds` are options-page settings that the host applies while building rows and `style` frames (Live).
- `clear {lane}`: drop that lane's rows AND reset `dismissedEpoch[lane] = null` and `prevGaps[lane]` (so the panel's captions checkbox off/on, which makes the host send `clear`, brings a dismissed overlay back). The lane's `status` row is kept. `bye`: dispose the UI and close the port; after `bye` or a disconnect every dismissal is forgotten, so a host that resumes a lane at the same epoch on a new port shows it again.
- Empty state: when there are no rows in any lane and no status row and no gap line, the whole `.wrap` is `hidden` (nothing is drawn over the page).
- Auto-hide after silence: every accepted `captions` frame whose rows differ from the previous frame of that lane (JSON compare) restarts a timer of `autoHideSeconds`; on expiry the rows are hidden (the port stays open); the next differing frame shows them again.
  `autoHideSeconds === 0` never hides. Status and gap rows have their own 8 s timers. Timers use `setTimeout` from the page realm.
- Dismiss: the `×` button hides the wrap and records `dismissedEpoch[lane] = frame.epoch` (the last epoch seen) for every lane shown (it also hides a gap line that is showing and cancels its timer); while a lane is dismissed neither its rows nor its status row render; frames with `epoch <= dismissedEpoch[lane]` are ignored;
  a NEW lane start (higher `epoch`) shows the overlay again, and so does `clear {lane}`.
- Visibility: while `document.visibilityState === 'hidden'` nothing is rendered (`hidden`); on `visibilitychange` to visible the last frames render again.
- Fullscreen (review: appending the host into an arbitrary page element contradicted "appends exactly one element / never breaks the page"; elements that cannot render light-DOM children make the overlay vanish while it is removed from `documentElement`):
  on `fullscreenchange`, let `fs = document.fullscreenElement`.
  - `fs` is null: restore. If the host is not a child of `document.documentElement`, `documentElement.appendChild(host)`; if strategy 2 was used, `hidePopover()` and remove the `popover` attribute.
  - `fs` is `document.documentElement` (or the host is already inside `fs`): nothing to do.
  - Strategy 1 (plain container): `fs.tagName` (upper-cased) is NOT one of `VIDEO IFRAME CANVAS IMG EMBED OBJECT INPUT TEXTAREA SELECT SVG` and `fs.shadowRoot` is `null` (an open root: a light-DOM child would not render without a slot; a closed root cannot be detected, an accepted residual risk) ->
    `fs.appendChild(host)` inside `try`; on any exception, restore at once. The host is `position: fixed`, so it stays a viewport overlay inside the top-layer container. Framework observers of that container will see a foreign child for the duration of the fullscreen (documented, temporary).
  - Strategy 2 (element that cannot host children, e.g. a bare `<video>`): if `host.showPopover` exists, `host.popover = 'manual'; host.hidePopover?.(); host.showPopover()` (re-issued on every `fullscreenchange` so the host is above the fullscreen element in the top layer). Failure or absence -> strategy 3.
  - Strategy 3: do nothing (invisible during fullscreen; the panel preview is the fallback).
  Restoration is also guaranteed when the fullscreen element is REMOVED from the DOM (Chrome then fires `fullscreenchange`) and at every render (`if (!host.isConnected) documentElement.appendChild(host)`).
  Strategies 1 and 2 are both UNTESTED on real sites (`[assumption A17]`); checklist 13.14 records which works where, and a single constant orders them.
- Never throws into the page: every handler is wrapped; a failure in `render` disposes the overlay silently.
- Never sends anything but `hello`; never stores anything (no `localStorage`, no `chrome.storage`); never logs.

### 8.6 Options/permission page details that are not in the tables

- Both pages are opened in a normal tab; both are usable at 320 px and at 1280 px; both follow `prefers-color-scheme`; both set `lang`.
- Neither page ever displays the API key or any part of it.

---------------------------------------------------------------------------------------------------

## 9. i18n

### 9.1 Where things live

- App dictionaries (reused): `app/i18n/{ko,en,ja}.json` (810 keys, identical key sets). Copied by the build to
  `dist/extension/app/i18n/`.
- Extension dictionaries: `extension/i18n/{ko,en,ja}.json` (group D): flat dotted keys, ALL keys start with `ext.`, string
  values, identical key sets and `{placeholders}` in the three languages. 122 keys (9.2; 117 at first delivery, +5 `ext.twoWay.*`). Validated by the patched
  `scripts/check-i18n.mjs` (12.1): prefix, parity, placeholders, no collision with an app key, and every source and HTML
  file under `extension/` checked against the union of app and ext keys.
- Chrome's own `_locales/{en,ko,ja}/messages.json`: manifest name/description, action title, shortcut description, context-menu
  title and the overlay strings (content scripts cannot load the ext dictionary; the offscreen document and content scripts
  have no dictionary, only `chrome.i18n` in content scripts). Mirrored by parity test (9.3).
- Tone (matches the existing dictionary): Korean statements and hints in polite 해요체 (`~해요`, `~돼요`), instructions as polite
  imperatives (`~하세요`), labels as short noun phrases without a final period; English sentence case, no period on labels,
  full sentences end with a period; Japanese です・ます体, labels as short phrases, 「」 quotes, full-width parentheses.
  Product terms: 통역, 자막, 소리 (for sound toggles), 세션. Placeholders are `{name}`.
- The extension offers ko/en/ja for BOTH the UI and the interpretation languages (`SUPPORTED_LANGUAGES`); the two-way mode is
  offered per lane, off by default (D10 was reversed, 14.4 change 3; its five keys are `ext.twoWay.*`). Language labels are `language.ko|en|ja` in the CURRENT UI language (not the screenshot's bilingual labels).

### 9.2 The complete `ext.*` key list (122 keys, 117 + the five `ext.twoWay.*` keys of the two-way mode; the tables below were regenerated by script from `extension/i18n/{ko,en,ja}.json` on 2026-09-29 (a diff of every cell reports 0 differences) and the machine checks were re-run on the delivered dictionaries: key shape,
`ext.` prefix, no collision with the 810 app keys, placeholder parity across languages, description <= 132 characters,
name <= 45 characters, the `ext.error.*` set equal to `EXTENSION_ERROR_CODES` plus `OVERRIDDEN_ENGINE_CODES`, the mute hint naming the
mute button label exactly, and the D12 marker words `측정` / `estimate` / `実測` in `ext.usage.twoSessions`; the dictionaries win over this text if they ever disagree: `tests/extension-html.test.mjs` pins the wording that matters)

Placeholders: `{lane}` and `{status}` in `ext.lane.statusLine` (lane title and status text), `{percent}` in `ext.volume.value` (integer), `{title}` in
`ext.tab.target` (tab title, at most 60 characters, rendered with `textContent`), `{count}` in `ext.status.reconnecting` (integer 1..3), `{shortcut}` in
`ext.arm.shortcut` (the shortcut text from `commands.getAll`). Tone is 9.1. Wording was revised after the UX review: arming copy is split by state,
quota copy names a next step, the microphone-permission copy no longer quotes a Chrome label that does not exist, and the sound button names what it controls (the
INTERPRETED speech, not the tab's sound). It was revised once more after the review of the built extension: the caption-lines and auto-hide labels state their ranges (1-6, 0-60), the backup-model warning moved to its own key `ext.route.fallbackNote` (`ext.route.fallback` is now a short label), a switched-off lane reads `ext.status.off`, the tab model select reads `ext.options.modelLive` (no "(default)" tag), the key-saved status is `ext.key.savedBrowser` (the app's Korean text is in a formal register), and the English microphone page title reads "Allow microphone" like its button. The four keys that did not exist in the first draft are `ext.status.off`, `ext.route.fallbackNote`, `ext.key.savedBrowser` and `ext.options.modelLive`.

**Brand and manifest (paired with _locales)**

| key | ko | en | ja |
|---|---|---|---|
| `ext.name` | 실시간 통역 | Live Interpreter | リアルタイム通訳 |
| `ext.description` | 탭 소리와 내 마이크를 Gemini Live로 바로 통역하고, 자막을 페이지에 띄워 줘요. | Interpret tab audio and your microphone live with Gemini Live, with captions on the page. | タブの音声と自分のマイクをGemini Liveでその場で通訳し、字幕をページに表示します。 |
| `ext.action.title` | 통역 패널 열기 | Open the interpreter panel | 通訳パネルを開く |
| `ext.command.open` | 이 탭에서 통역 패널 열기 | Open the interpreter panel on this tab | このタブで通訳パネルを開く |
| `ext.menu.open` | 이 탭에서 통역 패널 열기 | Open the interpreter panel on this tab | このタブで通訳パネルを開く |

**Side panel**

| key | ko | en | ja |
|---|---|---|---|
| `ext.lane.tab.title` | 탭 오디오 | Tab audio | タブの音声 |
| `ext.lane.tab.lead` | 이 탭의 소리를 내 언어로 통역해요. | Interprets this tab's audio into your language. | このタブの音声を自分の言語に通訳します。 |
| `ext.lane.mic.title` | 마이크 | Microphone | マイク |
| `ext.lane.mic.lead` | 내가 하는 말을 그 자리에서 통역해요. | Interprets what you say, right as you say it. | 自分の話す言葉をその場で通訳します。 |
| `ext.lane.statusLine` | {lane} · {status} | {lane} · {status} | {lane} · {status} |
| `ext.mic.mode` | 동시통역 — 말하는 동안 바로 | Simultaneous — as you speak | 同時通訳 — 話している間にすぐ |
| `ext.source.auto` | 말하는 언어는 자동으로 찾아요. | The spoken language is detected automatically. | 話されている言語は自動で検出します。 |
| `ext.twoWay.label` | 양방향 통역 | Two-way interpretation | 双方向通訳 |
| `ext.twoWay.partner` | 상대 언어 | Other language | 相手の言語 |
| `ext.twoWay.targetLabel` | 첫 번째 언어 | First language | 1つ目の言語 |
| `ext.twoWay.hint` | 두 언어를 서로 통역해요. 두 언어로 말이 오가는 자리에 알맞아요. | Interprets between the two languages in both directions, for a conversation in both. | 2つの言語を相互に通訳します。2つの言語で会話する場面に向いています。 |
| `ext.twoWay.modelNote` | 양방향은 통역 전용 모델을 쓸 수 없어서 이 레인은 Gemini 3.8 Live를 써요. | Two-way cannot use the translation-only model, so this lane uses Gemini 3.8 Live. | 双方向では翻訳専用モデルを使えないため、このレーンはGemini 3.8 Liveを使います。 |
| `ext.tab.originalVolume` | 통역하는 동안 남겨 둘 원래 소리 크기 | Original audio volume while interpreting | 通訳中に残す元の音声の音量 |
| `ext.volume.value` | {percent}% | {percent}% | {percent}% |
| `ext.captions.show` | 페이지에 자막 표시 | Show captions on the page | ページに字幕を表示 |
| `ext.captions.micHint` | 내 말의 자막은 지금 보고 있는 탭에만 표시돼요. | Captions of your speech appear only on the tab you are looking at. | 自分の話の字幕は、今見ているタブにだけ表示されます。 |
| `ext.tab.target` | 대상 탭: {title} | Target tab: {title} | 対象タブ: {title} |
| `ext.mic.mutedHint` | 통역 음성이 꺼져 있어서 자막만 나와요. 들으려면 ‘통역 음성 켜기’ 버튼(스피커 아이콘)을 누르세요. | Interpreted speech is off, so you get captions only. To hear it, press the Turn interpreted speech on button (speaker icon). | 通訳音声はオフのため字幕のみ表示されます。聞くには「通訳音声をオンにする」ボタン（スピーカーのアイコン）を押してください。 |
| `ext.sound.on` | 통역 음성 켜기 | Turn interpreted speech on | 通訳音声をオンにする |
| `ext.sound.off` | 통역 음성 끄기 | Turn interpreted speech off | 通訳音声をオフにする |
| `ext.sound.echoWarning` | 이어폰을 쓰세요. 스피커로 들으면 통역 음성(과 탭 소리)이 마이크로 다시 들어가 한 번 더 통역될 수 있어요. | Use headphones. Through speakers, the interpreted voice (and the tab audio) can re-enter the microphone and be interpreted again. | イヤホンを使ってください。スピーカーで聞くと、通訳音声（とタブの音声）がマイクに戻り、もう一度通訳されることがあります。 |
| `ext.usage.twoSessions` | 둘을 함께 켜면 통역 세션이 두 개 열려서 Google 무료 한도(또는 요금)를 약 두 배 빠르게 쓸 수 있어요. 측정한 값은 아니에요. | Turning both on opens two sessions, so your Google free quota (or charges) may go about twice as fast. This is an estimate, not a measurement. | 両方をオンにするとセッションが2つ開くため、Googleの無料枠（または料金）の消費が約2倍になる可能性があります。実測値ではありません。 |
| `ext.usage.quotaHint` | 통역을 둘 다 켜 두면 한도를 더 빨리 써요. 하나만 켜 보세요. | Having both on uses the limit faster. Try with just one. | 両方をオンにすると枠を早く使い切ります。1つだけにしてみてください。 |
| `ext.status.noLane` | 켜 둔 통역이 없어요. 탭 오디오나 마이크를 하나 이상 켜세요. | No interpretation is turned on. Turn on tab audio or the microphone. | オンになっている通訳がありません。タブの音声かマイクを1つ以上オンにしてください。 |
| `ext.status.off` | 꺼져 있어요 | Off | オフ |
| `ext.status.awaitingArm` | 탭 준비를 기다리는 중이에요 | Waiting for the tab to be ready | タブの準備を待っています |
| `ext.status.failed` | 통역에 실패했어요 | Interpretation failed | 通訳に失敗しました |
| `ext.status.partial` | 한쪽만 통역 중이에요 | Only one of the two is interpreting | どちらか一方のみ通訳中です |
| `ext.status.reconnecting` | 연결이 끊겨 다시 연결하는 중이에요 ({count}/3). 자막이 잠시 멈출 수 있어요. | Connection lost. Reconnecting ({count}/3). Captions may pause. | 接続が切れたため再接続しています（{count}/3）。字幕が一時停止することがあります。 |
| `ext.gap.input` | 오디오 일부를 보내지 못해서 자막이 빠질 수 있어요. | Some audio was not sent, so some captions may be missing. | 音声の一部を送信できなかったため、字幕が欠ける可能性があります。 |
| `ext.output.blocked` | Chrome이 이 확장 프로그램의 통역 음성 재생을 막았어요. 자막은 계속 나와요. | Chrome blocked playback of interpreted speech from this extension. Captions continue. | Chromeがこの拡張機能の通訳音声の再生をブロックしました。字幕は引き続き表示されます。 |
| `ext.route.fallback` | 예비 모델 | Backup model | 予備モデル |
| `ext.route.fallbackNote` | 예비 모델이 통역 중이에요. 들리는 말에 통역 대신 대답할 수 있어요. | A backup model is interpreting. It may answer what it hears instead of translating. | 予備モデルが通訳しています。聞こえた内容を通訳せずに返答することがあります。 |
| `ext.key.missing` | Gemini API 키가 필요해요. 옵션에서 키를 입력하세요. | A Gemini API key is required. Enter it in Options. | Gemini APIキーが必要です。オプションで入力してください。 |
| `ext.key.builtin` | 이 빌드에는 기본 키가 들어 있어요. 개인 키를 저장하면 개인 키를 먼저 써요. | This build includes a default key. A personal key you save is used first. | このビルドには既定のキーが含まれています。個人キーを保存すると、個人キーが優先されます。 |
| `ext.key.enter` | API 키 입력 | Enter API key | APIキーを入力 |
| `ext.key.savedBrowser` | 키를 이 브라우저에 저장했어요. | Key saved in this browser. | キーをこのブラウザに保存しました。 |
| `ext.notice.panelGone` | 패널을 닫아서 통역이 멈췄어요. 다시 하려면 시작을 누르세요. | Interpretation stopped because the panel was closed. Press Start to run it again. | パネルを閉じたため通訳が停止しました。もう一度実行するには開始を押してください。 |
| `ext.notice.hostLost` | 통역 엔진이 예기치 않게 멈췄어요. 시작을 눌러 다시 실행하세요. | The interpretation engine stopped unexpectedly. Press Start to run it again. | 通訳エンジンが予期せず停止しました。開始を押してもう一度実行してください。 |
| `ext.panel.closeStops` | 패널을 닫으면 통역도 멈춰요. | Closing this panel also stops interpretation. | パネルを閉じると通訳も停止します。 |
| `ext.howto.link` | 사용 방법: 통화 전에 할 일 | How to use: before a call | 使い方：通話の前にすること |
| `ext.howto.keepOpen` | 통역하는 동안에는 이 패널을 열어 두세요. 닫으면 통역과 페이지 자막이 멈춰요. | Keep this panel open while interpreting. Closing it stops interpretation and the captions on the page. | 通訳中はこのパネルを開いたままにしてください。閉じると通訳とページの字幕が停止します。 |
| `ext.howto.step2` | 통역할 탭에서 툴바의 ‘실시간 통역’ 아이콘을 눌러 패널을 열고 탭 오디오를 켜세요. | On the tab you want to interpret, click the Live Interpreter icon in the toolbar to open the panel, then turn on tab audio. | 通訳したいタブでツールバーの「リアルタイム通訳」アイコンをクリックしてパネルを開き、タブの音声をオンにしてください。 |
| `ext.howto.step3` | 마이크를 쓰려면 마이크 버튼을 눌러 권한을 먼저 허용하세요. | To use the microphone, press the microphone button and allow permission first. | マイクを使うには、先にマイクのボタンを押して権限を許可してください。 |
| `ext.howto.step4` | 시작을 누르고 자막이 나오는지 확인하세요. | Press Start and check that captions appear. | 開始を押して、字幕が表示されることを確認してください。 |
| `ext.howto.step5` | 통역 음성은 이 컴퓨터의 소리 출력으로만 나와요. 화상 통화 상대에게는 전달되지 않아요. | Interpreted speech plays only through this computer's audio output. It is not sent to the other people on a call. | 通訳音声はこのパソコンの音声出力からのみ再生されます。通話の相手には送られません。 |
| `ext.howto.stepCall` | 통화 상대의 말을 통역하려면 통화 중인 탭에서 탭 오디오를 켜고, 내 말을 통역하려면 마이크를 켜세요. | To interpret the other side of a call, turn on tab audio on the call's tab; turn on the microphone for your own speech. | 通話の相手の話を通訳するには通話中のタブでタブの音声をオンに、自分の話を通訳するにはマイクをオンにしてください。 |
| `ext.arm.needed` | 이 탭을 통역하려면 먼저 툴바의 ‘실시간 통역’ 아이콘을 눌러 탭을 준비하세요. 그다음 시작을 누르세요. | To interpret this tab, first click the Live Interpreter icon in the toolbar to get the tab ready. Then press Start. | このタブを通訳するには、先にツールバーの「リアルタイム通訳」アイコンをクリックしてタブを準備し、そのあと開始を押してください。 |
| `ext.arm.waiting` | 툴바의 ‘실시간 통역’ 아이콘을 누르면 바로 시작해요. | Click the Live Interpreter icon in the toolbar and it starts right away. | ツールバーの「リアルタイム通訳」アイコンをクリックすると、すぐに開始します。 |
| `ext.arm.ready` | 이 탭은 준비가 됐어요. 시작을 누르세요. | This tab is ready. Press Start. | このタブは準備ができました。開始を押してください。 |
| `ext.arm.pinHint` | 아이콘이 안 보이면 퍼즐 조각 메뉴에서 ‘실시간 통역’을 핀으로 고정하세요. | If you cannot see the icon, pin Live Interpreter from the puzzle-piece menu. | アイコンが見当たらない場合は、パズルのメニューから「リアルタイム通訳」をピン留めしてください。 |
| `ext.arm.shortcut` | 단축키: {shortcut} | Shortcut: {shortcut} | ショートカット: {shortcut} |
| `ext.applyNext` | 언어와 모델 변경은 다음 시작부터 적용돼요. | Language and model changes apply from the next start. | 言語とモデルの変更は次回の開始から適用されます。 |
| `ext.level.tab` | 탭 소리 입력 레벨 | Tab audio input level | タブ音声の入力レベル |

**Options page**

| key | ko | en | ja |
|---|---|---|---|
| `ext.options.title` | 옵션 | Options | オプション |
| `ext.options.lead` | 키, 모델, 목소리, 자막 기본값을 정해요. | Set your key, models, voice and caption defaults. | キー、モデル、声、字幕の既定値を設定します。 |
| `ext.options.section.lanes` | 통역 기본값 | Interpretation defaults | 通訳の既定値 |
| `ext.options.section.captions` | 페이지 자막 | Captions on the page | ページの字幕 |
| `ext.options.section.privacy` | 개인정보 | Privacy | プライバシー |
| `ext.options.defaultsHint` | 패널을 열 때 처음 선택돼 있을 값이에요. 패널에서 바꾼 값도 여기에 저장돼요. | These are the values selected when the panel opens. Changes made in the panel are saved here too. | パネルを開いたときに最初に選ばれている値です。パネルで変更した値もここに保存されます。 |
| `ext.options.modelTab` | 탭 오디오 모델 | Tab audio model | タブ音声のモデル |
| `ext.options.modelMic` | 마이크 모델 | Microphone model | マイクのモデル |
| `ext.options.modelLive` | Gemini 3.8 Live | Gemini 3.8 Live | Gemini 3.8 Live |
| `ext.options.modelTabHint` | 탭 소리에는 번역 전용 모델(Gemini 3.5 Live Translate)을 권장해요. 영상 속 말에 통역이 대답하는 일이 거의 없어요. 모델은 다음 시작부터 적용돼요. | For tab audio, the translation-only model (Gemini 3.5 Live Translate) is recommended: it usually does not answer what it hears in a video. The model applies from the next start. | タブの音声には翻訳専用モデル（Gemini 3.5 Live Translate）をおすすめします。動画の中の発言に通訳が返答することはほとんどありません。モデルは次回の開始から適用されます。 |
| `ext.options.modelMicHint` | 마이크에는 기본 모델(Gemini 3.8 Live)을 권장해요. 모델은 다음 시작부터 적용돼요. | For the microphone, the default model (Gemini 3.8 Live) is recommended. The model applies from the next start. | マイクには既定のモデル（Gemini 3.8 Live）をおすすめします。モデルは次回の開始から適用されます。 |
| `ext.options.uiLanguageHint` | 패널과 옵션의 언어예요. 웹페이지에 뜨는 자막의 안내 문구, 툴바 툴팁, 메뉴 이름은 Chrome의 언어를 따라가요. | The language of the panel and options. Labels on captions drawn into web pages, the toolbar tooltip and the menu item follow Chrome's own language. | パネルとオプションの言語です。ウェブページに表示される字幕の案内文、ツールバーのツールチップ、メニュー名はChromeの言語に従います。 |
| `ext.options.saved` | 저장했어요. | Saved. | 保存しました。 |
| `ext.options.keyShow` | 키 보기 | Show key | キーを表示 |
| `ext.options.keyHide` | 키 숨기기 | Hide key | キーを隠す |
| `ext.options.captionPosition` | 자막 위치 | Caption position | 字幕の位置 |
| `ext.options.position.top` | 위쪽 | Top | 上 |
| `ext.options.position.bottom` | 아래쪽 | Bottom | 下 |
| `ext.options.captionLines` | 자막 줄 수 (1~6) | Caption lines (1–6) | 字幕の行数（1〜6） |
| `ext.options.autoHide` | 조용해지면 자막 숨기기 (0~60초, 0은 숨기지 않음) | Hide captions after silence (0–60 seconds; 0 keeps them) | 無音が続いたら字幕を隠す（0〜60秒、0は隠さない） |
| `ext.keyStorage` | 키는 이 브라우저의 확장 프로그램 저장소에만 보관하고 Google 외에는 보내지 않아요. | The key is kept only in this browser's extension storage and is sent to no one but Google. | キーはこのブラウザの拡張機能ストレージにのみ保存し、Google以外には送信しません。 |
| `ext.privacy.audio` | 통역하는 동안 선택한 오디오(탭 소리, 마이크)가 Google Gemini로 전송돼요. | While interpreting, the audio you selected (tab audio, microphone) is sent to Google Gemini. | 通訳中は、選択した音声（タブの音声、マイク）がGoogle Geminiに送信されます。 |
| `ext.privacy.freeTier` | 결제 계정을 연결하지 않은 무료 한도로 쓰면, Google이 입력한 오디오와 결과를 서비스 개선에 쓰고 사람이 검토할 수 있어요. 중요한 통화나 회의에는 쓰지 마세요. | On the free tier (no billing account linked), Google may use the audio you send and the results to improve its products, and people may review them. Do not use it for sensitive calls or meetings. | 請求先アカウントを連携していない無料枠では、送信した音声と結果がGoogleのサービス改善に使われ、担当者が確認することがあります。機密性の高い通話や会議には使わないでください。 |
| `ext.privacy.page` | 자막을 그리는 것 외에는 페이지 내용을 읽거나 바꾸지 않아요. 자막은 페이지 안의 보호된 상자에 그려서 페이지의 스크립트에는 내용이 공개되지 않아요. 내 말의 자막은 지금 보고 있는 탭에만 그려요. 탭 주소는 통역할 탭을 확인하는 데만 쓰고 기기 밖으로 보내지 않아요. | Apart from drawing captions, it does not read or change the page. Captions are drawn into the page in a protected box whose content is not exposed to the page's own scripts, and captions of your own speech go only to the tab you are looking at. Tab addresses are used only to identify the tab to interpret and never leave your device. | 字幕を表示する以外に、ページの内容を読んだり変更したりしません。字幕はページ内の保護された枠に表示され、ページ自身のスクリプトには内容が公開されません。自分の話の字幕は、今見ているタブにだけ表示します。タブのアドレスは通訳するタブの確認にだけ使い、端末の外には送信しません。 |

**Microphone-permission page**

| key | ko | en | ja |
|---|---|---|---|
| `ext.permission.title` | 마이크 허용 | Allow microphone | マイクを許可 |
| `ext.permission.lead` | 내 말을 통역하려면 이 확장 프로그램이 마이크를 쓸 수 있어야 해요. 허용해도 시작을 누르기 전에는 마이크를 켜지 않아요. | To interpret your speech, this extension needs to use the microphone. Even after you allow it, the microphone stays off until you press Start. | 自分の話を通訳するには、この拡張機能がマイクを使えるようにする必要があります。許可しても、開始を押すまでマイクはオンになりません。 |
| `ext.permission.chooseAlways` | 허용 창이 뜨면 ‘이번만 허용’은 고르지 말고, 계속 허용되는 항목을 고르세요. | When the prompt appears, do not choose Allow this time; choose the option that keeps the microphone allowed. | 許可の確認が表示されたら「今回のみ許可」は選ばず、今後も許可される項目を選んでください。 |
| `ext.permission.done` | 허용됐어요. 이 탭은 곧 닫혀요. | Allowed. This tab closes in a moment. | 許可されました。このタブはまもなく閉じます。 |
| `ext.permission.allowButton` | 마이크 허용 | Allow microphone | マイクを許可 |
| `ext.permission.blockedHelp` | 마이크가 차단돼 있어요. 브라우저 설정의 사이트 권한에서 이 확장 프로그램의 마이크를 허용한 뒤 다시 시도하세요. | The microphone is blocked. Allow it for this extension under site permissions in the browser settings, then try again. | マイクがブロックされています。ブラウザ設定のサイトの権限でこの拡張機能のマイクを許可してから、もう一度お試しください。 |

**Errors and notices (ext.error.<CODE>; take precedence over error.<CODE>)**

| key | ko | en | ja |
|---|---|---|---|
| `ext.error.TAB_CAPTURE_FAILED` | 이 탭의 소리를 가져오지 못했어요. 탭을 새로고침하고 시작을 다시 누르세요. | Could not capture this tab's audio. Reload the tab and press Start again. | このタブの音声を取得できませんでした。タブを再読み込みしてから、もう一度開始を押してください。 |
| `ext.error.TAB_UNSUPPORTED` | 이 페이지의 소리는 가져올 수 없어요. 일반 웹페이지에서 사용하세요. | This page's audio cannot be captured. Use it on a regular web page. | このページの音声は取得できません。通常のWebページでお使いください。 |
| `ext.error.TAB_GONE` | 대상 탭을 찾을 수 없어요. 탭을 열고 툴바의 ‘실시간 통역’ 아이콘을 누른 뒤 시작을 누르세요. | The target tab was not found. Open the tab, click the Live Interpreter icon in the toolbar, then press Start. | 対象のタブが見つかりません。タブを開き、ツールバーの「リアルタイム通訳」アイコンをクリックしてから開始を押してください。 |
| `ext.error.TAB_CAPTURE_BUSY` | 이 탭의 소리를 다른 곳에서 이미 가져가고 있어요. 다른 녹음·캡처 확장 프로그램을 끄고 다시 시도하세요. | Another tool is already capturing this tab's audio. Turn off other recording or capture extensions and try again. | このタブの音声は別の機能がすでに取得しています。他の録音・キャプチャ拡張機能をオフにして、もう一度お試しください。 |
| `ext.error.TAB_ENDED` | 이 탭의 소리를 더 가져올 수 없어요. 탭을 닫았거나 다른 사이트로 이동했을 수 있어요. 다시 하려면 툴바 아이콘을 누른 뒤 시작을 누르세요. | Audio can no longer be taken from this tab. It may have been closed or moved to another site. To start again, click the toolbar icon, then press Start. | このタブの音声をこれ以上取得できません。タブを閉じたか、別のサイトに移動した可能性があります。再開するには、ツールバーのアイコンをクリックしてから開始を押してください。 |
| `ext.error.TAB_AUDIO_BLOCKED` | 탭 소리를 다시 내보내지 못해서 캡처를 멈췄어요. 다시 시도하고, 계속되면 확장 프로그램을 새로고침하세요. | Chrome could not play the tab audio back, so capture was stopped. Try again; if it repeats, reload the extension. | タブの音声を再生できなかったため、取得を停止しました。もう一度お試しいただき、繰り返す場合は拡張機能を再読み込みしてください。 |
| `ext.error.TAB_INPUT_LOST` | 탭 소리가 더 이상 들어오지 않아요. 탭에서 툴바 아이콘을 눌러 다시 준비한 뒤 시작을 누르세요. | The tab's audio stopped arriving. Click the toolbar icon on the tab to get it ready again, then press Start. | タブの音声が届かなくなりました。タブでツールバーのアイコンをクリックして再び準備してから、開始を押してください。 |
| `ext.error.HOST_UNAVAILABLE` | 통역 엔진이 시작되지 않았어요. 시작을 다시 누르세요. 계속되면 확장 프로그램 관리 페이지에서 이 확장 프로그램을 새로고침하세요. | The interpretation engine did not start. Press Start again; if it repeats, reload this extension on the extensions page. | 通訳エンジンが開始しませんでした。もう一度開始を押してください。繰り返す場合は、拡張機能の管理ページでこの拡張機能を再読み込みしてください。 |
| `ext.error.LANE_STOPPING` | 이전 통역을 아직 멈추는 중이에요. 잠시 뒤에 시작을 다시 누르세요. | The previous run is still stopping. Press Start again in a moment. | 前回の通訳をまだ停止している最中です。しばらくしてから、もう一度開始を押してください。 |
| `ext.error.OVERLAY_UNAVAILABLE` | 이 페이지에는 자막을 띄울 수 없어요. 브라우저 내부 페이지이거나, 확장 프로그램을 설치하기 전에 열려 있던 탭일 수 있어요(새로고침하면 돼요). 통역은 계속되고, 자막은 패널에서 볼 수 있어요. | Captions cannot be shown on this page. It may be a browser page, or a tab that was open before the extension was installed (reload it). Interpretation continues, and you can read the captions in the panel. | このページには字幕を表示できません。ブラウザの内部ページか、拡張機能をインストールする前から開いていたタブの可能性があります（再読み込みしてください）。通訳は続行され、字幕はパネルで確認できます。 |
| `ext.error.CREDENTIAL_REQUIRED` | API 키가 없어서 시작할 수 없어요. 옵션에서 Gemini API 키를 입력하세요. | Cannot start without an API key. Enter your Gemini API key in Options. | APIキーがないため開始できません。オプションでGemini APIキーを入力してください。 |
| `ext.error.INVALID_KEY` | API 키가 거부됐어요. 옵션에서 키를 확인하세요. | The API key was rejected. Check the key in Options. | APIキーが拒否されました。オプションでキーを確認してください。 |
| `ext.error.PERMISSION_DENIED` | 이 키로는 Live API를 쓸 수 없어요. 키 제한과 API 사용 권한을 확인하세요. | This key cannot use the Live API. Check the key restrictions and API access. | このキーではLive APIを使えません。キーの制限とAPIの利用権限を確認してください。 |
| `ext.error.CREDENTIAL_FORBIDDEN` | 이 키는 이 확장 프로그램에서 쓸 수 없어요. 키의 사용 제한(웹사이트 제한 등)을 확인하고 제한 없는 키를 쓰세요. | This key cannot be used from this extension. Check the key's restrictions (such as web referrer limits) or use an unrestricted key. | このキーはこの拡張機能では使えません。キーの制限（ウェブサイト制限など）を確認するか、制限のないキーを使ってください。 |
| `ext.error.IP_DENIED` | 이 키는 IP 제한 때문에 지금 네트워크에서 쓸 수 없어요. 키의 IP 제한을 확인하세요. | This key cannot be used from your current network because of an IP restriction. Check the key's IP restriction. | このキーはIP制限のため、現在のネットワークでは使えません。キーのIP制限を確認してください。 |
| `ext.error.MODEL_UNSUPPORTED` | 이 모델을 지금 쓸 수 없어요. 옵션에서 다른 모델을 고르고 다시 시작하세요. | This model is unavailable right now. Choose another model in Options and start again. | このモデルは現在利用できません。オプションで別のモデルを選んで、もう一度開始してください。 |
| `ext.error.RATE_LIMITED` | 요청 한도에 걸려 통역을 멈췄어요. 남은 한도를 아끼려고 자동으로 다시 열지 않아요. 잠시 뒤에 시작을 다시 누르세요. | The request limit was hit, so interpretation stopped. It is not reopened automatically, to save the remaining quota. Press Start again in a moment. | リクエスト上限に達したため通訳を停止しました。残りの枠を節約するため、自動では再開しません。しばらくしてから、もう一度開始を押してください。 |
| `ext.error.DAILY_LIMIT` | 이 키의 오늘 사용 한도를 다 썼어요. 한도가 다시 채워진 뒤에 시작하거나 다른 키를 쓰세요. | This key's daily quota is used up. Start again after the quota resets, or use another key. | このキーの本日の利用枠を使い切りました。枠がリセットされてから開始するか、別のキーを使ってください。 |
| `ext.error.TOKEN_LIMIT` | 이번 세션의 처리 한도에 도달했어요. 시작을 다시 눌러 새 세션을 여세요. | This session reached its processing limit. Press Start to open a new session. | このセッションの処理上限に達しました。開始を押して新しいセッションを開いてください。 |
| `ext.error.UNKNOWN_429` | 요청이 제한됐지만 원인과 재개 시각을 알 수 없어요. 자동 반복은 멈췄어요. 잠시 뒤 시작을 다시 누르세요. | Requests are limited, but the cause and reset time are unknown. Automatic retries have stopped. Press Start again in a moment. | リクエストが制限されていますが、原因と再開時刻は不明です。自動の再試行は停止しました。しばらくしてから、もう一度開始を押してください。 |
| `ext.error.SESSION_LIMIT` | 이 키로 열린 연결이 너무 많아요. 통역을 하나만 켜거나 같은 키를 쓰는 다른 탭·앱을 닫은 뒤 시작을 다시 누르세요. | Too many connections are open with this key. Turn on just one interpretation, or close other tabs and apps that use the same key, then press Start again. | このキーで開いている接続が多すぎます。通訳を1つだけオンにするか、同じキーを使っている他のタブやアプリを閉じてから、もう一度開始を押してください。 |
| `ext.error.BUDGET_EXHAUSTED` | 연결이 안정되지 않아 세션을 세 번 다시 열었어요. 네트워크를 확인하세요. 통역을 둘 다 켜 두었다면 하나만 켜고 다시 시도해 보세요. | The session was reopened three times without a lasting connection. Check the network. If both interpretations are on, try again with just one. | 安定した接続が得られないままセッションを3回開き直しました。ネットワークを確認してください。通訳を両方オンにしている場合は、1つだけにしてもう一度お試しください。 |
| `ext.error.INPUT_UNSUPPORTED` | 이 브라우저에서는 실시간 오디오 처리를 쓸 수 없어요. Chrome을 최신 버전으로 업데이트하세요. | Live audio processing is unavailable in this browser. Update Chrome to the latest version. | このブラウザではリアルタイム音声処理を使えません。Chromeを最新版に更新してください。 |
| `ext.error.MICROPHONE_DENIED` | 마이크 권한이 없어요. ‘마이크 허용’ 버튼으로 권한을 허용한 뒤 다시 시작하세요. | Microphone permission is missing. Allow it with the Allow microphone button, then start again. | マイクの権限がありません。「マイクを許可」ボタンで許可してから、もう一度開始してください。 |
| `ext.error.MICROPHONE_EXPIRED` | 마이크 허용이 만료됐어요. ‘마이크 허용’ 버튼을 눌러 다시 허용하고, ‘이번만 허용’은 고르지 마세요. | The microphone permission has expired. Press Allow microphone to allow it again, and do not choose Allow this time. | マイクの許可の有効期限が切れました。「マイクを許可」を押して、もう一度許可してください。「今回のみ許可」は選ばないでください。 |
| `ext.error.MICROPHONE_UNAVAILABLE` | 마이크를 열 수 없어요. 다른 앱이 쓰고 있거나 입력 장치가 없을 수 있어요. | The microphone could not be opened. Another app may be using it, or there is no input device. | マイクを開けませんでした。ほかのアプリが使用中か、入力デバイスがない可能性があります。 |
| `ext.error.BROWSER_INTERRUPTED` | 오디오 입력이 끊겼어요. 시작을 다시 누르세요. | The audio input was interrupted. Press Start again. | 音声入力が中断されました。もう一度開始を押してください。 |
| `ext.error.STORAGE_FAILED` | 브라우저 저장소에 저장하지 못했어요. 저장 공간이나 브라우저 프로필 설정을 확인한 뒤 다시 시도하세요. | Could not save to browser storage. Check free space and the browser profile settings, then try again. | ブラウザのストレージに保存できませんでした。空き容量とブラウザプロファイルの設定を確認してから、もう一度お試しください。 |

**Caption overlay (also mirrored in _locales)**

| key | ko | en | ja |
|---|---|---|---|
| `ext.overlay.region` | 통역 자막 | Interpretation captions | 通訳字幕 |
| `ext.overlay.hide` | 자막 숨기기 | Hide captions | 字幕を隠す |
| `ext.overlay.gap` | 일부 자막이 빠졌을 수 있어요. | Some captions may be missing. | 一部の字幕が欠けている可能性があります。 |
| `ext.overlay.reconnecting` | 연결이 끊겨 다시 연결하는 중이에요… | Reconnecting… | 再接続しています… |
| `ext.overlay.stopped` | 통역이 멈췄어요. 패널을 확인하세요. | Interpretation stopped. Check the panel. | 通訳が停止しました。パネルを確認してください。 |

### 9.3 `_locales` content and the mirror rule

Manifest: `"default_locale": "en"` (mandatory when `_locales` exists `[verified-doc]`). Message names are camelCase (no dots).
Each message equals the mirrored `ext.*` value EXACTLY, in every language; `tests/extension-tree.test.mjs` (M3) asserts equality for every
pair in this table, and `tests/extension-i18n.test.mjs` asserts that the three `_locales` files have the same message names:

| message name | mirrors | used by |
|---|---|---|
| `extName` | `ext.name` | manifest `name` (`__MSG_extName__`) |
| `extDescription` | `ext.description` | manifest `description` |
| `actionTitle` | `ext.action.title` | manifest `action.default_title` |
| `commandOpen` | `ext.command.open` | manifest `commands._execute_action.description` |
| `menuOpen` | `ext.menu.open` | SW `chrome.i18n.getMessage('menuOpen')` for the context menu |
| `overlayRegion` | `ext.overlay.region` | overlay region `aria-label` |
| `overlayHide` | `ext.overlay.hide` | overlay close button `aria-label` |
| `overlayLaneTab` | `ext.lane.tab.title` | overlay lane chip |
| `overlayLaneMic` | `ext.lane.mic.title` | overlay lane chip |
| `overlayGap` | `ext.overlay.gap` | overlay gap line |
| `overlayReconnecting` | `ext.overlay.reconnecting` | overlay status row (reconnecting) |
| `overlayStopped` | `ext.overlay.stopped` | overlay status row (stopped) |

Every message object has `message` and `description` (English description, not translated). Every `getMessage('...')` literal in
the source (SW, overlay) must exist in all three files (test). `extDescription` is at most 132 characters and `extName` at most
45 characters in every language (test). These strings follow CHROME's UI language, not `settings.uiLanguage` (8.5.1, `ext.options.uiLanguageHint`).

`extension/_locales/en/messages.json`

```json
{
  "extName": {
    "message": "Live Interpreter",
    "description": "Extension name shown in Chrome."
  },
  "extDescription": {
    "message": "Interpret tab audio and your microphone live with Gemini Live, with captions on the page.",
    "description": "Extension description shown in Chrome (max 132 characters)."
  },
  "actionTitle": {
    "message": "Open the interpreter panel",
    "description": "Toolbar icon tooltip."
  },
  "commandOpen": {
    "message": "Open the interpreter panel on this tab",
    "description": "Description of the keyboard shortcut."
  },
  "menuOpen": {
    "message": "Open the interpreter panel on this tab",
    "description": "Context menu item title."
  },
  "overlayRegion": {
    "message": "Interpretation captions",
    "description": "Accessible name of the caption overlay."
  },
  "overlayHide": {
    "message": "Hide captions",
    "description": "Accessible name of the overlay close button."
  },
  "overlayLaneTab": {
    "message": "Tab audio",
    "description": "Label chip of the tab-audio caption lane."
  },
  "overlayLaneMic": {
    "message": "Microphone",
    "description": "Label chip of the microphone caption lane."
  },
  "overlayGap": {
    "message": "Some captions may be missing.",
    "description": "Shown when some captions may be missing."
  },
  "overlayReconnecting": {
    "message": "Reconnecting…",
    "description": "Shown on the page while the interpretation session reconnects."
  },
  "overlayStopped": {
    "message": "Interpretation stopped. Check the panel.",
    "description": "Shown on the page after interpretation stopped unexpectedly."
  }
}
```

`extension/_locales/ko/messages.json`

```json
{
  "extName": {
    "message": "실시간 통역",
    "description": "Extension name shown in Chrome."
  },
  "extDescription": {
    "message": "탭 소리와 내 마이크를 Gemini Live로 바로 통역하고, 자막을 페이지에 띄워 줘요.",
    "description": "Extension description shown in Chrome (max 132 characters)."
  },
  "actionTitle": {
    "message": "통역 패널 열기",
    "description": "Toolbar icon tooltip."
  },
  "commandOpen": {
    "message": "이 탭에서 통역 패널 열기",
    "description": "Description of the keyboard shortcut."
  },
  "menuOpen": {
    "message": "이 탭에서 통역 패널 열기",
    "description": "Context menu item title."
  },
  "overlayRegion": {
    "message": "통역 자막",
    "description": "Accessible name of the caption overlay."
  },
  "overlayHide": {
    "message": "자막 숨기기",
    "description": "Accessible name of the overlay close button."
  },
  "overlayLaneTab": {
    "message": "탭 오디오",
    "description": "Label chip of the tab-audio caption lane."
  },
  "overlayLaneMic": {
    "message": "마이크",
    "description": "Label chip of the microphone caption lane."
  },
  "overlayGap": {
    "message": "일부 자막이 빠졌을 수 있어요.",
    "description": "Shown when some captions may be missing."
  },
  "overlayReconnecting": {
    "message": "연결이 끊겨 다시 연결하는 중이에요…",
    "description": "Shown on the page while the interpretation session reconnects."
  },
  "overlayStopped": {
    "message": "통역이 멈췄어요. 패널을 확인하세요.",
    "description": "Shown on the page after interpretation stopped unexpectedly."
  }
}
```

`extension/_locales/ja/messages.json`

```json
{
  "extName": {
    "message": "リアルタイム通訳",
    "description": "Extension name shown in Chrome."
  },
  "extDescription": {
    "message": "タブの音声と自分のマイクをGemini Liveでその場で通訳し、字幕をページに表示します。",
    "description": "Extension description shown in Chrome (max 132 characters)."
  },
  "actionTitle": {
    "message": "通訳パネルを開く",
    "description": "Toolbar icon tooltip."
  },
  "commandOpen": {
    "message": "このタブで通訳パネルを開く",
    "description": "Description of the keyboard shortcut."
  },
  "menuOpen": {
    "message": "このタブで通訳パネルを開く",
    "description": "Context menu item title."
  },
  "overlayRegion": {
    "message": "通訳字幕",
    "description": "Accessible name of the caption overlay."
  },
  "overlayHide": {
    "message": "字幕を隠す",
    "description": "Accessible name of the overlay close button."
  },
  "overlayLaneTab": {
    "message": "タブの音声",
    "description": "Label chip of the tab-audio caption lane."
  },
  "overlayLaneMic": {
    "message": "マイク",
    "description": "Label chip of the microphone caption lane."
  },
  "overlayGap": {
    "message": "一部の字幕が欠けている可能性があります。",
    "description": "Shown when some captions may be missing."
  },
  "overlayReconnecting": {
    "message": "再接続しています…",
    "description": "Shown on the page while the interpretation session reconnects."
  },
  "overlayStopped": {
    "message": "通訳が停止しました。パネルを確認してください。",
    "description": "Shown on the page after interpretation stopped unexpectedly."
  }
}
```

### 9.4 Existing app keys reused verbatim (all verified to exist in ko/en/ja on 2026-09-29)

`common.start`, `common.stop`, `common.cancel`, `common.close`, `common.save`, `common.delete`, `common.retry`; `language.auto`, `language.ko`, `language.en`, `language.ja`,
`language.target`, `language.ui`; `sim.status.idle|preparing|connecting|running|stopping|stopped`;
`sim.output.delayed|catching_up|unavailable`; `sim.route.translation|flash`;
`sim.headphonesStart`; `sim.captions.empty|latest|showSource|partial|final|interrupted|skipped`; `sim.gap.audio|reception`;
`sim.voice`, `sim.voice.female`, `sim.voice.male`, `sim.voiceRestart`; `sim.model0`, `sim.model1`, `sim.model2` (index in `LIVE_MODELS`; `sim.model0` says "(default)", which is the WEB APP's default and true for the microphone only: the microphone select keeps it, the tab select shows the same model as `ext.options.modelLive`, "Gemini 3.8 Live" without the tag, and the options hints name the recommended model per lane, because the model names are not i18n data and a key family for three names costs more than it earns);
`display.captions.size|value|range`; `captionOnly.display`, `captionOnly.display.dark|light|mono`; `settings.key`, `settings.keyPlaceholder`,
`settings.keyStorageWarning`, `settings.keyStored`, `settings.noKey`, `settings.keyDeleted`, `settings.deleteKey`;
`keyGuide.createLink`, `keyGuide.newTab`; `permission.title|request|granted|denied|prompt|checking|noDevice|noDeviceHint|busy|busyHint`;
`seq.inputLevel`; `error.unknown`, `error.INVALID_KEY` (typed into the options key field; NOT via `errorKeyFor`) and the generic `error.<CODE>` keys that `errorKeyFor` still falls back to
(`error.CREDENTIAL_MISMATCH`, `error.NETWORK_ERROR`, `error.UNAVAILABLE`, `error.TIMEOUT`, `error.SETTINGS_UNSUPPORTED`, `error.SAFETY_BLOCKED`, `error.INVALID_RESULT`).

Reviewed and REPLACED by `ext.*` overrides because their app wording is wrong or has no next step in an extension: `sim.status.failed` ("Listening failed"), `sim.status.replacing` (engine jargon),
`sim.output.blocked` (tells the user to press the button they just pressed), `sim.route.fallback` ("the default model failed": not true for the tab lane), `sim.gap.input` ("microphone input", wrong for the tab lane),
`sim.mute` / `sim.enableSound` (they read as if they control the tab's sound), `error.DAILY_LIMIT`, `error.TOKEN_LIMIT`, `error.UNKNOWN_429`, `error.SESSION_LIMIT`, `error.MODEL_UNSUPPORTED`, `error.STORAGE_FAILED`,
`error.IP_DENIED`, `error.CREDENTIAL_FORBIDDEN` (see 4.6.2), `settings.keySavedBrowser` (its Korean text is in the formal register of the app; the extension uses `ext.key.savedBrowser`) and the "(default)" tag of `sim.model0` on the tab select (`ext.options.modelLive`).

Deliberately NOT reused (wrong platform wording for an extension): `sim.direct`, `sim.personalKey`, `sim.seatAudio`, `sim.hub`, `sim.builtin*`,
`sim.error.*` (all of them, see 4.6.2), `permission.help.*`, `permission.gestureOnly`, `error.BROWSER_INTERRUPTED` (says "the app left the
foreground"), `error.APP_VERSION_TOO_OLD`, `error.POLICY_*`, `error.HUB_*`, `error.EVENT_*`, `error.SHARED_*`, `hub.*`, `event.*`, `policy.*`, `admin.*`.

### 9.5 The extension i18n loader (`extension/lib/i18n.js`, group C)

```js
export async function loadExtensionI18n({ fetch = globalThis.fetch, language, languages = [], signal } = {}) -> Promise<I18n>
export function createFallbackI18n({ language } = {}) -> I18n     // 3-key English boot dictionary (app/i18n/boot-fallback.js)
```

- URLs (no `chrome` global needed, so it is testable with an injected `fetch`): ``new URL(`../../app/i18n/${lang}.json`, import.meta.url)`` and
  ``new URL(`../i18n/${lang}.json`, import.meta.url)`` for `lang` in `SUPPORTED_LANGUAGES`; `fetch(url, { credentials: 'omit', signal })`.
- Validation: `response.ok`, a plain JSON object whose values are all non-blank strings; the app dictionary must contain `error.unknown`; every
  key of an ext dictionary must start with `ext.`. Any failure -> `throw new Error('I18N_LOAD_FAILED')` (no cause, URL or body retained). An
  abort signal rejects the whole load the same way.
- Merge order: `dictionaries[lang] = { ...appDictionary[lang], ...extDictionary[lang] }` (ext last is defensive; collisions are impossible by the
  checker).
- Language negotiation: `language` (one of `ko|en|ja`) when valid, else `selectLanguage(languages)` (pass `navigator.languages`; the loader never reads
  a global). The controller passes `settings.uiLanguage` when it is not `'auto'`. Runtime change: `i18n.setLanguage(code)` then `applyI18n`.
- Fallback chain: per key `current language -> en -> error.unknown` (built into `createI18n`; unknown keys are never echoed). If the load throws, the
  page uses `createFallbackI18n()` (every label then reads the same `error.unknown` sentence): the side panel and the options page retry the loader silently three times (after 2 s, 6 s and 18 s) and re-render when one succeeds; the permission page has no retry. There is NO Retry button in the markup (KNOWN, NOT FIXED: UX review 14, checklist 13.51); the first draft promised one (`common.retry`).
- Import rule: `lib/i18n.js` may import `app/i18n/index.js` and `app/i18n/boot-fallback.js` (R4).

### 9.6 Dynamic key families (explicit `has()` tests, because the checker only sees literals)

`ext.error.<CODE>` for every code in `EXTENSION_ERROR_CODES` and `OVERRIDDEN_ENGINE_CODES` (exactly that set exists, in all three languages: 12 + 16 = 28 keys today);
`sim.status.<status>` for `idle|preparing|connecting|running|stopping|stopped` (the statuses the panel still takes from the app; `reconnecting` and `failed` are `ext.status.*`);
`sim.output.<state with '-' replaced by '_'>` for `delayed|catching-up|unavailable`; `sim.gap.<audio|reception>`; `language.<ko|en|ja>`;
`permission.<granted|denied|prompt|checking>`; `captionOnly.display.<dark|light|mono>`;
`ext.lane.<tab|mic>.title`; `ext.options.position.<top|bottom>`; `sim.model<i>` for `i < LIVE_MODELS.length` (the tab select uses `ext.options.modelLive` in place of `sim.model0`). For every code that can appear in a
`LaneState.errorCode` or a `sw/lane-start` error, `errorKeyFor(code, i18n.has, lane)` resolves, for BOTH lanes, to a key that exists (test over `ERROR_CODES` plus the extension codes),
never to a `sim.error.*` key, and for the tab lane never to a key whose text says "microphone" (`MICROPHONE_UNAVAILABLE`, `BROWSER_INTERRUPTED`, `MICROPHONE_DENIED` -> `ext.error.TAB_INPUT_LOST`).

---------------------------------------------------------------------------------------------------

## 10. Build script spec (`scripts/build-extension.mjs`, group A)

A copy step with zero npm dependencies (no bundler, no transpiler). It follows the repo's script conventions
(`scripts/stage-release.mjs`): exported functions with injected paths, a CLI guarded by
`if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)`, fixed `EXTENSION_*` error
codes, output limited to codes and counts (never file contents, never a key), `Object.freeze` results, no import-time side effects.

### 10.1 CLI and API

```
node scripts/build-extension.mjs [--out <dir>] [--clean] [--zip] [--builtin-key-file <path>]
npm run build:extension            # = node scripts/build-extension.mjs   (12.3); safe to run again and again (10.2 step 4)
```

Rebuild semantics (review: the first draft refused a non-empty `out` unless `--clean` was given, but the npm script had no `--clean`, so the SECOND `npm run build:extension` failed with
`EXTENSION_OUT_EXISTS`, the acceptance command of 15.3 failed on its second run, and every rebuild after a code change needed a flag the owner was never told about): an existing output that
the build recognizes as its OWN (`isOwnOutput`, 10.2 step 4) is replaced automatically. `--clean` is kept for one extra case only: it also permits replacing a non-empty `out` that is inside
`<root>/dist/` but not recognized as an own output (a half-written directory left by a failed build). A foreign directory is never touched. After every rebuild the owner must press
Reload on the extension's card at `chrome://extensions` (Chrome does not watch the folder): 13.1 and 13.2 say so.

```js
export const ALLOWED_PERMISSIONS;      // frozen sorted array, 10.5
export const EXTENSION_PAGES;          // ['extension/engine/host.html', 'extension/permission/mic-permission.html'] (pages not in the manifest)
export const KEY_SLOT = 'export const BUILTIN_KEYS = Object.freeze([]);';
export const KEY_FILE = 'extension/lib/builtin-key.js';
export const EXTRA_FILES;             // ['styles.css', 'app/audio/capture-worklet.js', 'app/i18n/{ko,en,ja}.json'] (10.2 step 3c)
export const EXTENSION_CODES;          // frozen list of the 16 codes of 10.7
export async function buildExtension({ root = projectRoot, out = join(root, 'dist', 'extension'), clean = false,
  zip = false, builtinKeyFile = null, zipFn = defaultZip } = {}) -> Promise<Readonly<{
    out: string, files: string[] /* sorted POSIX paths relative to out */, version: string,
    builtinKeys: number, zip: string | null }>>
export async function computeImportClosure({ root, entries, classicScripts = [] }) -> Promise<Readonly<{ files: string[] /* the app/ subset */, graph: Map<string, string[]> /* every walked file -> its sorted dependencies */ }>>
export function lintManifest(manifest, { fileExists, messages }) -> string[]   // list of EXTENSION_MANIFEST_* reasons, [] = ok; `messages` = { en, ko, ja }, the parsed _locales files
export async function isOwnOutput(out) -> Promise<boolean>              // 10.2 step 4
export function parseArguments(args) -> Readonly<{ out, clean, zip, builtinKeyFile }>   // throws EXTENSION_ARGUMENT_INVALID
export async function runCli(args, { stdout, stderr, build }) -> Promise<number>        // the exit code; prints only the lines below
export async function decodePng(bytes) / encodePng({ width, height, rgb }) / downscale4(image)    // icons, exported for tests
```

CLI flags: each flag once; `--out`, `--builtin-key-file` take a value; `--clean`, `--zip` are booleans. Any other argument ->
`EXTENSION_ARGUMENT_INVALID`. Success prints exactly:
`EXTENSION_BUILT out=<absolute path> files=<n> version=<manifest version>` and, for a keyed build, a second line
`EXTENSION_BUILTIN_KEY keys=<n>`, and, when `--zip` produced a file, `EXTENSION_ZIP name=<file name>`; a skipped zip prints
`EXTENSION_ZIP_UNAVAILABLE` (still exit 0). Failure prints one code on stderr (`/^EXTENSION_[A-Z_]+$/`, else
`EXTENSION_BUILD_FAILED`) and sets `process.exitCode = 1`.

### 10.2 Steps of `buildExtension`

1. Validate targets (10.7): resolve `root`/`out`; refuse unsafe `out` before touching anything.
2. Read `extension/manifest.json` and the three `_locales` files; parse (a parse failure is the reason `EXTENSION_MANIFEST_JSON`); `lintManifest` (10.5) with `fileExists` bound to the SOURCE tree
   (`extension/...` paths) and to generated icon names and with `messages` = the parsed `_locales` tables; any reason -> `EXTENSION_MANIFEST_INVALID`.
3. Compute the copy set:
   a. every file under `extension/` (recursive; names checked, symlinks refused) except `extension/manifest.json` and
      `extension/_locales/**` (those go to the output root); allowed file types under `extension/`: `.js`, `.html`, `.css`, `.json`;
   b. `computeImportClosure` (10.3) from all JS and HTML entries -> the `app/` subset;
   c. fixed extras (`EXTRA_FILES`): `styles.css`, `app/audio/capture-worklet.js`, `app/i18n/ko.json`, `app/i18n/en.json`, `app/i18n/ja.json`.
   Everything is read into memory (and the icons are built) BEFORE the output directory is touched, so a refusal leaves the previous build alone.
4. Prepare `out`: absent -> create; present and empty -> use it; present and non-empty -> if `isOwnOutput(out)` (a `manifest.json` whose `name` is
   `__MSG_extName__` and `default_locale` is `en`) remove ONLY that directory tree and recreate it (no flag needed); else if `clean === true` and `out`
   is inside `<root>/dist/` do the same; otherwise `EXTENSION_OUT_EXISTS`.
5. Write files in sorted order, bytes verbatim, mirroring the repo layout (3.2). Write `manifest.json` re-serialized:
   `JSON.stringify(manifest, null, 2) + '\n'`. Write the four icons (10.4).
6. Key handling (10.6) when `builtinKeyFile !== null`; in EVERY build the slot `KEY_SLOT` must occur exactly once in the output copy of `KEY_FILE`, else `EXTENSION_KEY_SLOT_INVALID` (so an unkeyed build can never ship a list someone filled in the source).
7. Secret scan over the bytes about to be written (not over the finished folder): no text file (`.js`, `.html`, `.css`, `.json`) may match `SECRET_PATTERNS` (imported from `scripts/check-release.mjs`);
   a match -> throw `EXTENSION_SECRET_FOUND` before anything is written (the build fails loudly). A keyed build exempts exactly `KEY_FILE`.
8. Optional zip (10.8). Return the frozen result.

Order in the code: 1, 2, 3, then 6 and 7, then 4 and 5, then 8. Steps 6 and 7 come before the output is prepared, so a refused build writes nothing at all (no half-written folder).

Determinism: sorted order, no timestamps, verbatim bytes; two builds of the same tree are byte-identical (test).

### 10.3 Import-closure computation (`computeImportClosure`)

- Roots: the manifest's `background.service_worker`, `side_panel.default_path`, `options_ui.page`, every `content_scripts[].js`,
  `EXTENSION_PAGES` and every `.js` / `.html` file under `extension/` (the tree is copied whole, so the closure must also cover a module no entry reaches, or the built folder could import a file it does not contain). HTML roots contribute their `<script src>` and `<link rel="stylesheet" href>` references (relative only).
- For every JS file (comments stripped first with the build's own `stripComments`, a scanner that leaves string, template and regular-expression literals alone: the privacy test's two-regexp routine is enough for checking bans, but it would delete real code after a string such as `'http://*/*'`, and a missed import silently ships an incomplete extension) collect specifiers with these
  patterns, all requiring a string literal:
  - static: `/\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"\n]+)\1/g` (covers `import x from`, `export * from`, side-effect `import 'x'`);
  - dynamic: `/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g`;
  - assets: `/new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g` (this is how `stream-capture.js` names `./capture-worklet.js`).
  Template-literal URLs (``new URL(`../i18n/${lang}.json`, import.meta.url)``) are NOT followed; their targets are in the fixed extras of 10.2 (test:
  every template-URL site in the closure is covered by the extras).
- Every specifier must start with `.`; anything else (bare name, `chrome-extension:`, absolute path, `http`) -> `EXTENSION_IMPORT_UNRESOLVED`.
  A specifier must resolve to an existing regular, non-symlink file with extension `.js`, `.json` or `.css` under `app/` or `extension/` (or `styles.css` at the root);
  otherwise `EXTENSION_IMPORT_UNRESOLVED`.
- Import rules R1-R7 (3.3) are checked on every edge; a violation -> `EXTENSION_IMPORT_FORBIDDEN`. In particular the closure must never
  contain `app/main.js` or `app/security/builtin-key.js` (test). R3 is checked here, not in `lintManifest`: a content script (`classicScripts`, and everything under `extension/overlay/`) must compile with `vm.Script` and contain no `import(`, else `EXTENSION_IMPORT_FORBIDDEN`.
- The result `files` is the sorted set of repo-relative POSIX paths under `app/`. Expected size today (measured on 2026-09-29 with a regexp walk over static
  imports from `config.js`, `engine/sim.js`, `platform.js`, `providers/gemini/live-config.js`, `i18n/index.js`, `i18n/boot-fallback.js`, `engine/listen-state.js`,
  `security/shared-key.js`): 43 JavaScript files, none of them `app/main.js` or `app/security/builtin-key.js`; the worklet (via `new URL(...)`) and the three
  dictionaries (extras) come on top. The number is informational, not asserted. Delivered (a build of 2026-09-29 into a scratch directory): `EXTENSION_BUILT ... files=98 version=0.1.0` = `manifest.json`, 3 `_locales` files, 4 icons, `styles.css`, 47 `app/` files (43 closure modules, the worklet, 3 dictionaries) and 42 `extension/` files; a second run into the same directory (with `--zip`) succeeded too.

### 10.4 The manifest (`extension/manifest.json`, group A; full content) and icons

```json
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "description": "__MSG_extDescription__",
  "version": "0.1.0",
  "default_locale": "en",
  "minimum_chrome_version": "116",
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_title": "__MSG_actionTitle__",
    "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png" }
  },
  "background": { "service_worker": "extension/background/service-worker.js", "type": "module" },
  "side_panel": { "default_path": "extension/panel/panel.html" },
  "options_ui": { "page": "extension/options/options.html", "open_in_tab": true },
  "permissions": ["activeTab", "contextMenus", "offscreen", "scripting", "sidePanel", "storage", "tabCapture", "tabs"],
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["extension/overlay/overlay.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "commands": {
    "_execute_action": {
      "suggested_key": { "default": "Alt+Shift+Y" },
      "description": "__MSG_commandOpen__"
    }
  }
}
```

Why each entry (all `[verified-doc]` unless tagged):
- No `action.default_popup` (a popup suppresses `action.onClicked`); no `side_panel` toggle on click (the SW sets `openPanelOnActionClick:false`).
- `tabCapture` alone yields the per-tab grant; `activeTab` is kept for the `scripting.executeScript` fallback on an armed tab (6.7) and does not change the grant.
  `tabs` gives `tab.url` / `changeInfo.url` (needed to clear an armed record on a cross-origin navigation and to reject `chrome:` pages before minting; its install
  warning is irrelevant for Load unpacked). `scripting` is used only for that fallback. `contextMenus` for the menu item. `storage`, `sidePanel`, `offscreen` are the APIs themselves. No further permission is needed for the two API uses added in Revision 2: the Commands API "does not require a permissions entry" (Chrome reference, fetched 2026-09-29, https://developer.chrome.com/docs/extensions/reference/api/commands), and the `active` / `lastFocusedWindow` filters of `tabs.query` need none while only `url`, `title` and `favIconUrl` are gated by `tabs` (https://developer.chrome.com/docs/extensions/reference/api/tabs, fetched 2026-09-29).
- No `host_permissions`: the Live WebSocket to `wss://generativelanguage.googleapis.com` is opened from an extension page under the DEFAULT extension-page CSP
  (`script-src 'self'; object-src 'self'`, which defines no `connect-src`, so connections are unrestricted `[assumption A18: not shown by Chrome's page; from MDN's
  connect-src fallback rule]`). No `content_security_policy` key is set (a tightened `connect-src` cannot be verified without a browser; the exact hardening string is in section 14, K10).
- No `web_accessible_resources`: extension pages load their own files; the content script loads nothing from the extension.
- `matches` is `http`/`https` only (the overlay is pointless on `file:`; the user can widen it in a fork). Top frame only.
- `minimum_chrome_version: "116"`: `getContexts`, promise-returning `getMediaStreamId`, `sidePanel.open`. Whether the value is enforced for unpacked loads is unstated `[assumption A19]`.
- Version `0.1.0`: independent of `package.json` (`0.7.0`, pinned to the web app by tests) and of `app/version.js`; format = 1-4 dot-separated integers 0..65535, no leading zeros, not all zero.
- `_execute_action` suggested key `Alt+Shift+Y` (assumption A11); the user can rebind at `chrome://extensions/shortcuts`.
- Icons: `"16"` and `"32"` are byte copies of `icons/favicon-16.png` / `icons/favicon-32.png`; `"48"` is an exact 4x4-box downscale of `icons/icon-192.png`; `"128"` is an exact 4x4-box downscale of
  `icons/icon-512.png`. The repo's own icon generator writes 8-bit RGB (color type 2), non-interlaced PNGs (`tests/manifest.test.mjs`), so a dependency-free decoder suffices:

```
decodePng(bytes): verify signature and every chunk CRC (zlib.crc32), read IHDR (must be bit depth 8, color type 2, compression 0, filter 0, interlace 0),
                  concatenate IDAT, zlib.inflateSync, unfilter scanlines (filter types 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) -> { width, height, rgb: Uint8Array }
downscale4(image): width and height must be divisible by 4; each output pixel = rounded mean of the 4x4 block per channel
encodePng({width,height,rgb}): filter type 0 on every scanline, zlib.deflateSync(level 9), chunks IHDR, IDAT, IEND, CRC via zlib.crc32
```
  Any other source format, size mismatch (16, 32, 192, 512 expected) or CRC error -> `EXTENSION_ICON_INVALID`. `icons/` in the repo is never edited.

### 10.5 `lintManifest` (each reason is a test)

Returns reason strings (empty = valid): `manifest_version === 3`; `version` matches Chrome's format (`/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/`, each part <= 65535, not all zero);
`minimum_chrome_version` is a numeric string >= 116; `default_locale === 'en'` and `_locales/{en,ko,ja}/messages.json` exist; `name`, `description`, `action.default_title`
and every `description` under `commands` are `__MSG_<name>__` references whose `<name>` exists in every `_locales` file; `permissions` is EXACTLY
`ALLOWED_PERMISSIONS` = `['activeTab','contextMenus','offscreen','scripting','sidePanel','storage','tabCapture','tabs']` (adding one requires a doc and test change);
no `host_permissions`, `optional_permissions`, `optional_host_permissions`, `web_accessible_resources`, `externally_connectable`, `content_security_policy`,
`incognito` other than absent, `action.default_popup`; `background.type === 'module'` and its file exists; `side_panel.default_path`, `options_ui.page`, every `content_scripts[].js`
and every icon path exist (source paths for `extension/...`, the generated icon list for `icons/...`); content-script `matches` are exactly `http://*/*` and `https://*/*`,
`all_frames === false`, `run_at === 'document_idle'`; the `_execute_action` command exists with a non-`global` suggested key. (R3, no `import`/`export` in a content script, needs file contents and is checked by the closure walk, 10.3.) The reason strings are `EXTENSION_MANIFEST_` + `NOT_OBJECT`, `MANIFEST_VERSION`, `VERSION`, `MINIMUM_CHROME_VERSION`, `DEFAULT_LOCALE`, `LOCALE_FILE`, `MESSAGE_REFERENCE`, `PERMISSIONS`, `FORBIDDEN_KEY`, `BACKGROUND`, `PATH_MISSING`, `CONTENT_SCRIPTS`, `COMMAND` and `MESSAGE_LIMITS` (plus `JSON`, from the build, for a manifest that does not parse).
`extDescription` (every language) is at most 132 characters and `extName` at most 45.

### 10.6 Built-in key (D8): default OFF, mirrors `scripts/stage-release.mjs`

- Flag `--builtin-key-file <path>` (or the `builtinKeyFile` option). Semantics identical to `stage-release.mjs`: one key per line, blank lines and lines starting with `#`
  ignored, duplicates collapse, every key matches `/^[\x21-\x7e]{1,512}$/` and contains no `'` or `\`. Reading uses the exported `readBuiltinKey` of `stage-release.mjs`
  (12.4); its `RELEASE_KEY_FILE_MISSING` / `RELEASE_KEY_INVALID` are mapped to `EXTENSION_KEY_FILE_MISSING` / `EXTENSION_KEY_INVALID`.
- Injection: in the OUTPUT copy of `extension/lib/builtin-key.js` (never in the source), the text must contain `KEY_SLOT` exactly once, else `EXTENSION_KEY_SLOT_INVALID`; it is replaced by
  `export const BUILTIN_KEYS = Object.freeze(['<key1>', '<key2>']);` (only the first is ever used, 7.4).
- A keyed build is allowed ONLY with `out` inside `<root>/dist/` (gitignored), else `EXTENSION_OUT_INVALID`; the zip name gains `-keyed`.
- The build announces it: `EXTENSION_BUILTIN_KEY keys=<n>` on stdout. It never prints, logs or echoes a key, and the keyed file is exempt from the secret scan only for `KEY_FILE`.
- A default build MUST contain `BUILTIN_KEYS = Object.freeze([])` and no `SECRET_PATTERNS` match anywhere (10.2 step 7; test).
- Whoever runs a keyed build must know: the key is readable by anyone who has the folder or the zip (a key pushed to a public repository is revoked within minutes by secret scanning: it happened on 2026-09-07), a built-in key
  may be rejected from a `chrome-extension://` origin (A12), and `dist/` must be gitignored BEFORE the first keyed build (12.2). The doc for the owner is 13.2.

### 10.7 Refusals and error codes

| Code | When |
|---|---|
| `EXTENSION_ARGUMENT_INVALID` | unknown/duplicate flag, missing value, boolean flag with a value |
| `EXTENSION_OUT_INVALID` | `out` equals the repo root or contains it; `out` is inside the repo but not inside `<root>/dist/`; `out` is a symlink; a keyed build whose `out` is not inside `<root>/dist/`; `out` is a file; with `--zip`, the generated zip name exists and is not a regular file |
| `EXTENSION_OUT_EXISTS` | `out` exists and is non-empty, is NOT an own output, and (`clean` is false or `out` is not inside `<root>/dist/`) |
| `EXTENSION_SOURCE_MISSING` | a required source (`extension/manifest.json`, an icon source, `styles.css`, a `_locales` file) is absent |
| `EXTENSION_SOURCE_INVALID` | a source is a symlink or not a regular file; an `extension/` file has a type outside `.js/.html/.css/.json` |
| `EXTENSION_SOURCE_NAME_INVALID` | a path segment fails `[A-Za-z0-9._-]+` |
| `EXTENSION_MANIFEST_INVALID` | `lintManifest` returned reasons |
| `EXTENSION_IMPORT_UNRESOLVED` | a specifier is not relative or does not resolve to a copyable file |
| `EXTENSION_IMPORT_FORBIDDEN` | an import violates R1-R7 |
| `EXTENSION_ICON_INVALID` | icon decode/size failure |
| `EXTENSION_KEY_FILE_MISSING`, `EXTENSION_KEY_INVALID`, `EXTENSION_KEY_SLOT_INVALID` | 10.6 |
| `EXTENSION_SECRET_FOUND` | the post-build scan matched a secret pattern in an unkeyed build |
| `EXTENSION_ZIP_UNAVAILABLE` | reported (not thrown) when the zip step cannot run |
| `EXTENSION_BUILD_FAILED` | anything unexpected (message discarded) |

Path rules mirror `stage-release.mjs`: `SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/`, `lstat` before every read (symlinks and non-regular files refused), dotfiles skipped
(never copied), `containsRoot(outPath, rootPath)` for the ancestor check.

### 10.8 Zip step (decision: use the system `zip` binary, skip if absent)

`--zip` runs `zip -q -r -X <zipPath> .` with `cwd = out` through an injectable `zipFn({ cwd, zipPath })` (default: `child_process.execFile`, no shell).
`zipPath = join(dirname(out), 'interp-extension-<version>[-keyed].zip')` (with the default `out` that is `dist/interp-extension-0.1.0.zip`, inside the gitignored `dist/`). An existing file at exactly that generated
name is a build product and is overwritten (a rerun must not fail).
Rationale: `zip` ships with macOS (the owner's machine), a zero-dependency in-process ZIP writer would be ~150 lines of untested archive code, and Load unpacked needs
only the folder. If `execFile` fails with `ENOENT` the build still succeeds (`zip: null`, `EXTENSION_ZIP_UNAVAILABLE`); any other failure -> `EXTENSION_BUILD_FAILED`.
Tests inject a fake `zipFn` (no real `zip` process, no dependency on the host).

---------------------------------------------------------------------------------------------------

## 11. Test plan

All tests are `node:test`, top-level `tests/<name>.test.mjs` (the glob `tests/*.test.mjs` does not recurse), zero npm dependencies, no jsdom,
no browser, no real audio (D13). Injected fakes only. `node --test tests/*.test.mjs` reported 1011 tests, all passing, when this plan was written
(2026-09-29), 1789 at delivery and 1858 after the two-way mode (the counts per file are below the table); every new file had to keep the whole suite green and not edit an existing test file.

Two kinds of test file (review: a test file that mixes them makes "the file passes" meaningless at a group's delivery, and the old graph made group A unable to pass its own acceptance):
- FIXTURE tests use only injected fakes, embedded fixture data or temp-dir fixture roots. They pass as soon as the owning group has landed (and its stated dependencies).
- REAL-TREE tests read the real `extension/`, `app/` and `_locales` and the real repository. They can only pass at M3 (all four groups landed). They live in their OWN files, marked M3 below:
  `tests/extension-static.test.mjs` and `tests/extension-tree.test.mjs` (both group A).

Hard rules for every test author:
- NEVER create a real `AudioContext`, `MediaStream`, `getUserMedia`, `tabCapture`, `WebSocket` to a real host, or launch a browser. Use `tests/fixtures/fake-audio.mjs`,
  `fake-chrome.mjs`, `extension-dom.mjs` (below) and the existing `tests/fixtures/live.mjs` (`createSocketFixture`), `tests/fixtures/stream-audio.mjs`.
- Each test file runs in its own process (`directory.test.mjs`), so module-level state (`liveVoicePreference`, the shared Live slot) does not leak between files; inside a file
  a test that starts an engine MUST close it (`t.after`), because the default Live slot is shared per process. Two-lane tests use `isolated: true`.
- The privacy scan (`tests/privacy.test.mjs`) reads every file under `tests/`, `docs/` and `scripts/` and fails on key-shaped literals: build fake keys at RUNTIME
  (`'synthetic-' + 'x'.repeat(24)`, printable ASCII, valid for `validateKey`), never spell one; do not paste a real key anywhere, including this document.
- No test asserts on wall-clock time; timers come from the fake clock (`browser.clock`).
- A test that must NAME a forbidden token (the D13 scan names `afplay`, `getDisplayMedia`, `puppeteer`, ...; the privacy-style scans name key shapes) builds it at runtime
  (`['af', 'play'].join('')`), and the scan EXCLUDES its own file (`extension-static.test.mjs` would otherwise fail on itself the first time it runs).

### 11.1 Test files (name, owner group, when it can pass, what it asserts, fixtures)

| File | Group | Passes at | Asserts | Fixtures / fakes |
|---|---|---|---|---|
| `tests/session-isolated.test.mjs` | A | M0 | `createSessionManager({isolated:true})`: two isolated managers each hold a lease at once and never block, retire or close each other; an isolated manager leaves `createSessionManager().occupied` false; a failed close on one isolated slot does not poison another or the shared slot; default managers still share one slot (regression of existing behavior); `createAppConfig({isolated:true})` exposes a `sessionManager` distinct from another config's and from the default, and `dispose()` closes only its own; TWO-LANE sim: two configs + two `createSimEngine` over two fake sockets both reach `running` with retries 0, stopping A leaves B running, a shared config for both lanes reproduces `SESSION_LIMIT` -> `BUDGET_EXHAUSTED` (documents "one config per lane" and the retry behavior that 5.9 relies on) | `tests/fixtures/live.mjs`, `tests/fixtures/stream-audio.mjs`, sim-fixture pattern |
| `tests/extension-i18n.test.mjs` | A | M0 (fixture roots + A's own `_locales` files) | starts from the prototype of Appendix C (3 tests: extension dictionary parity/placeholders/prefix without the app error keys; the checker skips a tree without `extension/` and validates one that has it; sources are checked against the union of app and ext keys, the app never sees ext keys, collisions are detected) and adds: the three REAL `extension/_locales/*/messages.json` files have identical message-name sets, every message has `message` and `description`, `extDescription` <= 132 and `extName` <= 45 in every language | fixture roots in temp dirs, A's `_locales` files |
| `tests/extension-manifest.test.mjs` | A | M0 | `lintManifest` on an EMBEDDED fixture manifest equal to 10.4 (with a stub `fileExists` and an in-test `_locales` table) returns `[]`; each rule of 10.5 fails on a mutated copy (permission added, popup added, `host_permissions` added, `web_accessible_resources` added, CSP added, wrong `default_locale`, missing `_locales` file, missing `__MSG_` name, bad version, `minimum_chrome_version` 115, `all_frames` true, `<all_urls>` match) | in-test fixtures only (the REAL manifest is linted in `extension-tree`) |
| `tests/extension-build.test.mjs` | A | M0 (fixture roots; needs A's own build script only) | with FIXTURE roots (temp dirs, minimal synthetic trees): refusals of 10.7 (each code); REBUILD IDEMPOTENCE (building twice into the same `out` succeeds without `--clean`; a foreign non-empty directory is refused with `EXTENSION_OUT_EXISTS`; a half-written directory inside `dist/` is replaced only with `clean`; an existing zip of the generated name is overwritten); determinism (two builds byte-identical); symlink and unsafe-name refusal; closure rules (relative-only, forbidden imports, template URLs covered by extras, a `new URL('./x.js', import.meta.url)` worker script is followed); icon pipeline (`decodePng`/`downscale4`/`encodePng` round trip, dimensions 16/32/48/128, CRC valid, source format errors); keyed build through `buildExtension()` on a fixture root (runtime-assembled fake key: injected only into the OUTPUT `builtin-key.js`, notice printed, key absent from every other file and from stdout/stderr, refused when `out` is outside `dist/`); unkeyed build carries `BUILTIN_KEYS = Object.freeze([])` and passes the secret scan; zip via injected `zipFn` (`ENOENT` -> `zip:null`). The CLI has NO `--root` flag (the root is derived from the script location, like `stage-release.mjs`), so a child `node` process always sees the REAL repository: child-process tests are limited to ARGUMENT errors (`EXTENSION_ARGUMENT_INVALID` for unknown, duplicate and value-less flags, one code on stderr, exit code 1, nothing built). Keyed builds, `--clean` and `--zip` are exercised only through `buildExtension()` (a keyed CLI test would write the real `dist/`; the CLI `--zip` would spawn the real `zip`) | temp dirs, injected `zipFn` |
| `tests/extension-static.test.mjs` | A | M3 (real tree) | R1-R13 of 3.3 over the real `extension/**` and `app/**`: no `console.`, `eval(`, `new Function(`, `.innerHTML`, `.outerHTML`, `insertAdjacentHTML`, `document.write`, `importScripts(`, `debugger`, `localStorage`, `sessionStorage`, `indexedDB` (comments stripped, same helper as `privacy.test.mjs`); URL literals' origins subset of `ENDPOINT_ORIGINS` + documentation origins; `SECRET_PATTERNS` no match, `SECRET_MARK` absent; the identifiers `chrome`/`browser` appear only in the two allowed files (identifiers only: string literals, template literals and comments are stripped first); import allowlists R1-R7; every specifier relative and resolvable; `overlay.js` parses as a classic script with `new vm.Script` and contains no `import`/`export`/`require`; `attachShadow(` appears only in `overlay.js` and with `mode: 'closed'`; every HTML file follows R12; entry files listed in R10 are the only modules with import-time effects: every other module imports cleanly with throwing getters on `globalThis` for `chrome`, `document`, `window`, `localStorage`, `AudioContext`, `fetch`; `app/` never references `extension/`; no `ext.`-shaped string literal outside the dictionary in `app/**`; no `iframe` element in any extension HTML or JS (D1); the D13 no-sound scan (11.4) | real files, `vm` |
| `tests/extension-tree.test.mjs` | A | M3 (real tree) | everything that needs the REAL tree and used to sit in files that could otherwise pass earlier: `lintManifest` on the real `extension/manifest.json` returns `[]` and the manifest `name`/`description` strings equal the en `_locales` values through the `__MSG_` indirection; ONE integration test builds the REAL repo (`buildExtension` and, through a child `node` process, `scripts/build-extension.mjs --out <temp dir>`, which is allowed because the temp dir is outside the repo and the build is unkeyed) and asserts: every manifest-referenced path exists in the output, every relative import of every built JS resolves to a built file, output contains no `tests/`, `docs/`, `scripts/`, `.claude/`, `app/main.js`, `app/security/builtin-key.js`, no dotfiles, `styles.css` is byte-identical to the source, `app/audio/capture-worklet.js` sits next to `stream-capture.js`, `extension/engine/timer-worker.js` is present, a second build into the same temp dir succeeds; real-tree i18n: `checkI18n()` is ok with `extension/` present, ext dictionaries parity/placeholders/prefix, no ext key collides with an app key, every reused key of 9.4 exists in ko/en/ja, every `_locales` message equals its mirrored `ext.*` value (9.3), every `getMessage('x')` literal in `extension/**/*.js` exists in all three locales, dynamic key families (9.6), `EXTENSION_ERROR_CODES` ∪ `OVERRIDDEN_ENGINE_CODES` equals the set of `ext.error.*` keys, `errorKeyFor` resolves every code of `ERROR_CODES` and the extension codes, for BOTH lanes, to an existing key and never to `sim.error.*` (tab lane never to a "microphone" text), HTML `data-i18n*` attributes use only the four binder spellings (8.1); WIRE parity: `PORT_NAMES.overlay`, `PROTOCOL_VERSION`, `LIMITS.maxRows`, `LIMITS.maxRowChars` of `protocol.js` equal the `WIRE` literal extracted from `overlay.js` and the literals of 3.5 (this is the ONLY place the two groups meet); the `links.js` constants equal `app/config.js` `DOCUMENTATION_LINKS` | real files, temp dir, child `node` |
| `tests/extension-protocol.test.mjs` | B | after B (needs D's `fake-chrome` from M1) | `makeMessage`/`validateMessage` for every catalog row (valid and invalid payloads, extra fields dropped, `key`/`streamId`/`tab` shape rules of 4.2.1, `sw/lane-stop`, `sw/host-probe`, `sw/host-idle {reason}`, `host/overlay-wanted {active}`); the validator accepts every output of `normalizeStyle` over a grid (size steps, enums, `maxLines`, `autoHideSeconds`) and rejects off-grid raw values, so the SW cannot send settings the host rejects (the rules live once, in `constants.js`); `senderRole` for every row of the table in 4.4 including options/permission pages with `sender.tab` set AND a SW sender WITHOUT `url` (the fake's url-less mode), where a content script is never `'sw'`; `createMessageRouter` steps 1-6 (silent for other targets, `INVALID_MESSAGE`, `FORBIDDEN`, `UNKNOWN_TYPE`, handler exception -> `INTERNAL` with no message text, thrown `code` passes, content-script sender always `FORBIDDEN`); constants are frozen; `LIMITS` values | `fake-chrome` (runtime bus) |
| `tests/extension-settings.test.mjs` | B | after B | `DEFAULT_SETTINGS` frozen and equals 7.1 (mic captions default false); `createDefaultSettings` seeding; every `normalizeSettings` rule of 7.2 (clamps, enums, model in `LIVE_MODELS`, unknown fields dropped, never throws on garbage such as arrays, numbers, nested junk); `migrateSettings` (nullish, v1, future v9); PARITY of `constants.js` with the app: `VOICE_GENDERS` equals `LIVE_VOICE_GENDERS`, `CAPTION_SIZE` equals `app/preferences.js` `CAPTION_SIZE` and `clampCaptionSize` parity on a value grid; `hostSettingsOf`, `laneRequestOf`; `readKey` rejects corrupt records; `writeKey` trims/validates and throws `INVALID_KEY`; `resolveKey` precedence and shape checks; storage-area calls are exactly the documented keys | fake storage area |
| `tests/extension-ui-state.test.mjs` | B | after B | `laneStateFromSnapshot` for every engine `status`/`output`/error code (table 4.6.2), the "stopped without request" -> `BROWSER_INTERRUPTED` rule, a start cancelled by a stop -> `off` with no code, `gap` derivation, `quota`/`keyFailure` flags, level clamp, bounded strings, frozen results, no `sessionId`/`metrics`/`generation` field ever present; `buildUiState` shape and size <= 2 KB; `errorKeyFor(code, has, lane)` two-level chain plus the lane rule (tab lane: `MICROPHONE_UNAVAILABLE`, `BROWSER_INTERRUPTED`, `MICROPHONE_DENIED` -> `ext.error.TAB_INPUT_LOST`; `TIMEOUT` is NOT remapped); `buildCaptionFrame` rules 1-8 of 4.6.3 (source rows only with `showSource`, partial/settled selection, chronological order, truncation keeps the END, `skipped`, size fit under 8192 with pathological 16k-char rows and 100 rows); `createFrameCoalescer` (leading/trailing edge, one send per interval, dedupe ignoring `seq`, flush, dispose) with the fake clock | fake clock, real `createCaptionStore` snapshots |
| `tests/extension-audio-graph.test.mjs` | B | after B | `createTabAudioGraph`: raw -> gain -> destination wiring, gain = percent/100, `setOriginalVolume` clamps, a NEW destination per `createEngineStream`, `releaseEngineStream`, `onEnded` fires once when a raw track ends, a handler registered BEFORE `attach` still fires when a track ends DURING the resume wait (and when every raw track is already ended at attach), `stop()` during the resume wait makes `attach` reject `START_CANCELLED` and creates nothing afterwards, `rawEnded()`, `stop` order (raw tracks first, then disconnect, then `context.close`), idempotent stop (also before `attach`), suspended context after `resume` -> rejects `TAB_AUDIO_BLOCKED` AND stops the raw tracks (tab audio restored), `attach` uses no `await` between the caller's `getUserMedia` resolution and its own first call (asserted by call ordering); `createLanePlatform`: `isUserActive()` true, `document.hidden` false, `isSecureContext` true, real timers (or the injected engine clock), `page` events are no-ops, tab override of `getUserMedia` never touches `navigator.mediaDevices`, mic platform uses `navigator.mediaDevices.getUserMedia` | `fake-audio` |
| `tests/extension-timers.test.mjs` | B | after B | `createWorkerTimers` with a FAKE `Worker` (no real worker is spawned): `setTimeout` posts `{t:'set'}` and runs the callback on the `fire` message, `clearTimeout` posts `{t:'clear'}` and forgets the callback, an `error` event or a constructor failure falls back to the realm timers and re-arms pending ones, `dispose` terminates, `TIMER_MODE` is `'realm'` in v1 and `'realm'` makes `host.js`'s engine clock the realm's own | fake `Worker`, fake clock |
| `tests/extension-lanes.test.mjs` | B | after B | `createLaneEngine`: one fresh isolated config per start, key installed via `setPersonal`+`select`, `liveVoicePreference.set` called with the gender, request shape has NO `sourceLanguage`/`signal` and `languages` ONLY for a two-way request (passed unchanged, next to `targetLanguage` and `model`), `muted:true` only when muted, own playback context per lane and closed on stop, `dispose` order; `createTabLane` start sequence of 5.6.1 (order asserted with a call log, including `onEnded` registered BEFORE `attach`; `TAB_CAPTURE_FAILED` on `getUserMedia` rejection; graph stop restores tab audio on engine start failure; `handle.done` mapping: requested stop -> `off`, `failed` -> `error` with code and graph teardown, unrequested stop -> `BROWSER_INTERRUPTED`); CANCELLATION (F13): stop during `getUserMedia` (a stream that resolves AFTER the stop has every track stopped, no engine is created, phase `off`, the start rejects `START_CANCELLED`), stop during the resume wait, stop during the mic permission query, stop that lands before any start is a no-op, stop awaits the in-flight start (bounded), a raw track that ends during the resume wait ends the run with `TAB_ENDED`, start while `stopping` -> `LANE_STOPPING`, start while `starting` or `running` -> `ALREADY_RUNNING`; `TAB_CAPTURE_INCLUDE_VIDEO` both constraint shapes; `createMicLane` preflight (`prompt`/`denied` -> `MICROPHONE_DENIED` without starting the engine; missing `permissions.query` proceeds); mic capture failure surfaces as `MICROPHONE_DENIED`; stop order 5.7 with injected failures in each step (later steps still run); two lanes (tab + mic) run concurrently on isolated configs, one failing (`INVALID_KEY` on one socket) leaves the other `running`; `SESSION_LIMIT` handling; model defaults per lane | `fake-audio`, `tests/fixtures/live.mjs` sockets, real `createSimEngine` |
| `tests/extension-host.test.mjs` | B | after B | `createLaneHost` with a fake browser: only the six known `runtime` members are used (the offscreen fake has exactly those); handlers of 5.2 (`host/ping` incl. `tabId`, `host/lane-start` validation, `ALREADY_RUNNING` and `LANE_STOPPING`, `host/lane-stop` incl. while `starting`, `host/lane-stop {lane}` stops ONLY that lane and a start the host refuses (microphone permission denied, a bad stream id) leaves the other, running lane alone, `host/settings` live mute/volume/captions/style, `host/overlay-wanted` rules incl. `active`, `host/overlay-result` for both lanes, `host/tab-removed`); panel hub (hello -> state + captions, per-port dedupe, cap of `maxPanelPorts`, wrong role/name refused, grace stop after `panelGraceMs` then one `sw/host-idle {reason:'panel-gone'}` per report (retried once after 500 ms when the send rejects; a `{closed:false}` answer, or two failed sends, make the hub repeat the report with the same reason 3 s, 6 s and 12 s later, at most 3 times and with no timer left behind; `{closed:true}` or a refusal is never repeated; a panel port cancels the chain and restores the cap and an answer to an older report is void; `dispose` cancels it; one end-to-end case with the REAL SW core and the REAL host: a Start held in `getUserMedia`, the panel closed, the worker answers `closed:false`, the host asks again and the second answer closes the document), both port hubs enforce the sender ROLE (an options or permission page that has `sender.tab` and `frameId 0` is no overlay, and on a fresh hub with room to spare it is no panel), reconnect within grace cancels, initial grace of `panelInitialGraceMs` -> reason `initial-grace`); overlay hub (accept rules: name, role `content`, `frameId 0`, integer `tab.id`, `canAccept`; ONE port per tab: a second port REPLACES the first, the old port is disconnected by the hub, and a LATE `onDisconnect` of the old port neither deletes nor disposes the new one; LRU eviction at `maxOverlayPorts`; routing: tab lane frames only to the captured tab, mic lane frames only to the port of `micActiveTabId` and NEVER to a background tab, moving `micActiveTabId` sends `clear {lane:'mic'}` to the old port and the latest frame to the new; `clear`/`bye`/`status`; `bye` after an error is delayed by `statusLingerMs`; frames never contain the key, the stream id or `sessionId`); coalescing at the fake clock (<= 10 frames/s per key); tab removed and track ended both stop the tab lane with `TAB_ENDED`; mute applies to both lanes and calls `resumeAudio` on unmute; state frames match 4.6.1 shape and size | `fake-chrome`, `fake-audio`, socket fixtures |
| `tests/extension-chrome-adapter.test.mjs` | C | after C | `createChromeAdapter` walks the adapter and the NESTED `ADAPTER_SURFACE` in parallel and they match (an extra method on the fake `chrome` is not copied; a member absent from a real namespace is SKIPPED, never bound: a fake `runtime` without `getContexts` yields an adapter without it and no throw); namespaces absent in the fake stay `undefined`; the offscreen fake (exactly `id, getURL, sendMessage, connect, onMessage, onConnect`) yields only those; `commands.getAll`, `runtime.onStartup` present when the fake has them; methods bound; frozen; the file contains the only `chrome` identifier besides the overlay | `fake-chrome` |
| `tests/extension-i18n-loader.test.mjs` | C | after C (needs the real dictionaries: D's `extension/i18n/*.json` from M1) | `loadExtensionI18n` with an injected `fetch` over `file:` URLs of the real dictionaries: merge, negotiation (`language` beats `languages`), fallback per key, `I18N_LOAD_FAILED` on http error/invalid JSON/blank value/missing `error.unknown`/non-`ext.` key/abort, no cause retained; `createFallbackI18n`; `applyI18n` on a parsed HTML skeleton (text, `-label`, `-tip`, `-hint`, `document.title`, idempotence, no `innerHTML`) | `extension-dom` |
| `tests/extension-arming.test.mjs` | C | after C | `createArming`: arm/isArmed/get/clear, eviction beyond 32, serialized read-modify-write (interleaved calls lose nothing), `onTabUpdated` keeps same-origin (including `pushState`-like url changes) and clears cross-origin, non-http(s) and unparsable urls; `originOf` table | fake session storage |
| `tests/extension-sw.test.mjs` | C | after C | with the fake browser and a STUB host (a fake offscreen context answering `host/*`): top-level listener registration (exactly ONE listener on each of the NINE events of 6.1, none inside a promise, NO `runtime.onConnect`, NO `commands.onCommand`); `bootstrap` calls `setPanelBehavior({openPanelOnActionClick:false})` and `setAccessLevel('TRUSTED_CONTEXTS')` on EVERY start including after `sw.kill()`, and `runtime.onStartup` runs it too; `onActionClicked`: `sidePanel.open` is the FIRST call in the same synchronous turn (strict gesture model), then the armed record; menu path same; `sw/lane-start` order of 6.3 (key check, arming check, stopping-lane wait, `ensureOffscreen`, mint LAST — asserted by a call log: no await-able call between `getMediaStreamId` and the `host/lane-start` send other than the send itself), the MUTEX (`closeHost` runs inside it too: an `ensureOffscreen` that begins during a close waits and gets a fresh document, and a close waits for an ensure that is still creating; ten concurrent `ensureOffscreen()` calls create ONE document, reasons exactly `['USER_MEDIA']`; `sw/host-idle` never closes while a start is in flight; a zombie document whose host never answers is closed and recreated ONCE, then `HOST_UNAVAILABLE`; `host/lane-start` is re-sent once after `HOST_UNAVAILABLE`), `sendToHost` tolerance (real-Chrome-style rejection "The message port closed before a response was received", `undefined`, a non-object and `{ok:false}` all become a machine code; success needs `res?.ok === true`; run once with each of the fake's two no-responder modes), a SW sender WITHOUT `url` (the fake's url-less mode) is still `'sw'` for the host and is never `FORBIDDEN`; ping handshake retries then `HOST_UNAVAILABLE`, `NEEDS_ARM` on the exact kGrantError text and the record cleared, the recovery of 6.4 for `Cannot capture a tab with an active stream.` (ALREADY_RUNNING / retry / close-recreate with a FRESH ping / `TAB_CAPTURE_BUSY`), the other mint strings, `TAB_UNSUPPORTED` before any mint for `chrome:` urls, `TAB_GONE`; `LANE_STOPPING` wait (a lane `stopping` at the ping settles before the mint; still stopping after `stopWaitMs` -> `LANE_STOPPING` and NO mint; a start of a lane whose previous start is cancelled but still unwinding answers `LANE_STOPPING` at once (Start, Stop, Start in one tick; a start hanging inside the host; both lanes), while an un-cancelled duplicate still answers `ALREADY_RUNNING`); CANCELLATION: `sw/lane-stop` during the settings and key read, during `tabs.get`, during the arm lookup, during `ensureOffscreen`, during the mint and between mint and send each ends in `START_CANCELLED` and a `host/lane-stop` reaching the host (stop wins), a stop that reaches the host BEFORE the start still ends with the lane off, a stop after a SW kill still forwards; stream id single-use and expiring in the fake (a stale id would be rejected: the SW never reuses one); settings forwarding only when the host flag is up; `onStorageChanged` compares old and new: captions false->true attaches the overlay (tab lane through `host/ping.tabId`, mic lane to the active tab) and true->false does not; `sw/host-idle` closes only when panels 0 and lanes off and records `interp.lastStop.v1` with the reason (a panel that reconnected after the grace stopped the lanes keeps the document); `sw/host-probe` heals a stale `up:true` (no document; a zombie document) and records `host-lost`; `sw/permission-open` creates or focuses one tab; `considerOverlay`/`attachOverlay` retries `[0,150,400,1000]`, injection fallback only for armed tabs, results reported for the lanes that wanted the overlay, the MIC lane is attached ONLY to the active tab of the last focused window (a background tab finishing loading is never attached for the mic; `tabs.onActivated` moves it); tab events (`onRemoved` clears + `host/tab-removed`, `onUpdated` cross-origin clears, `complete` re-attaches, `onActivated` re-attaches for mic captions); senders other than the panel are `FORBIDDEN`; SW kill/revive between every step keeps correctness (armed map, host flag, existing offscreen doc found) | `fake-chrome` |
| `tests/extension-panel.test.mjs` | C | after C | `buildViewModel` rules 1-17 of 8.2.3 (table driven, one case per rule and per lane phase, pill precedence incl. `ext.status.partial`, `ext.status.awaitingArm` and the Cancel label, arm states with the `needed`/`waiting`/`ready` split, notice priority, key-failure notices shown once, `MICROPHONE_EXPIRED`, `applyNext` per lane, `usageNote` emphasis incl. `BUDGET_EXHAUSTED`, `echoNote`, `noLane`, `stopNote`); after `TAB_ENDED` an arm event must NOT leave a note that claims an auto-start; controller against the PARSED real `panel.html` (every id the controller uses exists, every id of 1.5 exists): start flows of 8.2.5 (sequential tab then mic with the `startRun` abort between lanes, pending arm and auto-start when the armed record appears, Stop/Cancel/uncheck send `sw/lane-stop` (never `host/lane-stop`) and clear pending, `NEEDS_ARM` response, `ALREADY_RUNNING` and `START_CANCELLED` ignored, `LANE_STOPPING` shown, mic permission gate), settings writes are one-field patches, volume throttling with the fake clock, mute toggle labels (`ext.sound.*` on `aria-label` and `title`), `#btn-start` label rules and `aria-disabled` (never `disabled`: the click is ignored while it is set, no message, no notice, no pill change), textContent-only rendering (the fake element throws on `innerHTML`), the live-region rule (the listed regions, among them `#<lane>-route-note`, are never `hidden`, empty text when not applicable, `#tab-notice`/`#mic-notice` are `role="alert"`; the per-lane status lines are not live, so a state change is announced once; the backup-model warning is written into `#<lane>-route-note` while the route line keeps label and model), a `MICROPHONE_DENIED` refusal recorded while the permission was missing is gone the moment it is granted (and only that refusal), Start on a known-unsupported page is a silent no-op for the tab lane while the microphone lane of the same Start still runs, an arm note is dropped where the lane's own notice already says what to do, an idle lane that is switched off reads `ext.status.off`, i18n language switch re-renders, host-link connect/disconnect/reconnect triggers, an unexpected port loss shows `ext.notice.hostLost` and sends `sw/host-probe`, `lastStop` shows `ext.notice.panelGone`, invalid frames dropped | `extension-dom`, `fake-chrome` |
| `tests/extension-options.test.mjs` | C | after C | options controller against the parsed `options.html`: every id of 7.3 exists and is bound; each control writes exactly its setting and shows `#opt-saved`; key flow (trim, `validateKey`, `setAccessLevel` BEFORE `writeKey`, a rejecting or missing `setAccessLevel` refuses the save with `ext.error.STORAGE_FAILED` and writes nothing, input cleared, status keys, delete, show/hide toggle without `aria-pressed`, key never rendered into any element or attribute — scan the whole fake DOM for the key substring; the saved status is `ext.key.savedBrowser`, with an exact Korean string pinned); the two number fields refuse an out-of-range or fractional value (table-driven, lines: 0, 7, 10, 2.5, -1, 1e3; hide: 61, 90, -1, 2.5, 1e3): the stored value comes back, nothing is written, no "Saved.", the boundaries 1, 6, 0 and 60 are accepted, and the labels state the ranges; the tab model select shows its first model without the "(default)" tag while the microphone select keeps it; storage failure shows defaults and `ext.error.STORAGE_FAILED`; language change re-renders; `links.js` parity: `KEY_GUIDE_URL` / `KEY_USAGE_URL` equal `app/config.js` `DOCUMENTATION_LINKS` (this file owns that parity test for `extension/lib/links.js`) | `extension-dom`, `fake-chrome` |
| `tests/extension-permission.test.mjs` | C | after C | permission controller: query -> getUserMedia -> success stops EVERY track and closes after 2000 ms (fake clock); each error branch of 8.4; retry button; never leaves a track live; `#perm-help` is a persistent live region on every branch (text after a denial, empty otherwise, never `hidden`); the allow action has one name (`ext.permission.allowButton`) | `extension-dom`, `fake-audio` |
| `tests/extension-integration.test.mjs` | C | M3 (needs B, C, D) | end-to-end, silent: fake browser + REAL SW core + REAL lane host + REAL panel controller + fake audio + fake sockets: icon click arms and opens the panel; Start starts the tab lane; the key reaches the host in exactly ONE `host/lane-start` and appears in NO other delivery (scan every message, response, port frame and every delivery to a `content` context for the key and the stream id); captions appear in the panel and on the overlay port; mic + tab concurrent; mute default; volume slider changes the gain through storage -> SW -> host; Start then Stop within one fake second ends with no live raw track and no engine; ticking "Show captions on the page" mid-run attaches the overlay; mic captions reach only the active tab; panel close -> lanes stop after grace -> `sw/host-idle` -> offscreen closed and `lastStop` recorded; tab close -> tab lane `TAB_ENDED`, mic continues; cross-origin navigation clears arming; SW killed mid-session: settings edits still reach the host on the next event; the dictionaries are fetched through a `file:` URL shim whose checkout root comes from the test file's own URL, so the file passes in any folder name (it used to hardcode `interp-app`); quota error on one lane shows the notice and keeps the other running; TWO-WAY (nine tests, added with the mode; the REAL sim engine is watched at `deps.createSimEngine`, so the request the host hands to `engine.start` is recorded next to the Live setup message the fake socket receives): the mic lane (target, toggle and partner stored -> `sw/lane-start` -> the one `host/lane-start` carries `request.languages` exactly `[target, partner]` -> the engine is given it -> the setup is ONE two-way instruction on the instruction-driven model, no translation target), the tab lane on the translation-only default (the panel note is visible, the engine moves it to Gemini 3.8 Live, the state and the route line name the model in use, no false "applies next", overlay rows carry `lang`), each lane two-way while the other is one-way (no pair leaks across), one-way lanes and a toggle turned on and off again send no pair, equal languages never leave the panel (the swap on a target change) and never leave the worker whatever is stored (equal, missing, not a language, a number), a record stored before two-way existed stays one-way and keeps every older field when two-way is switched on, a change made while a lane runs shows the "applies next" hint and takes effect at the next start; over all of them the key is in exactly one message per lane start and the pair only in `host/lane-start` (no port frame, response, storage record or overlay frame) | everything |
| `tests/extension-fixtures.test.mjs` | D | after D (M1) | self-tests of the fakes: JSON round trip (typed arrays become objects, `Map` becomes `{}`), 64 MiB cap, fan-out and first-`sendResponse`-wins, "Receiving end does not exist", BOTH no-responder modes ("The message port closed before a response was received" rejection, and the `undefined` resolution), port fan-out and `disconnect()` semantics, SW idle kill at 30 s of fake time and revive, port `postMessage` resets the idle timer but opening a port does not, the SW sender's `url` present or ABSENT (mode), single offscreen document (`Only a single offscreen document may be created.`), the offscreen `runtime` has exactly six members, reasons validated, AUDIO_PLAYBACK-only auto-close, `closeDocument` error, storage areas and access levels (session invisible to content, local hidden after `TRUSTED_CONTEXTS`, and a mode where the content context HAS `chrome.storage` but its calls reject), grant model (no grant from `sidePanel.open` or a panel click; grant from action click, shortcut, menu; cleared on cross-origin navigation and tab close; `openPanelOnActionClick:true` suppresses dispatch and grant), exact error strings, stream-id single use and expiry, one capture per tab, strict gesture for `sidePanel.open`, fake audio classes (states, `resume`/`suspend`/`close`, destination stream, worklet frames, a throwing `fetch` in the env), fake DOM (`attachShadow` records `lastShadowRoot` and a closed root exposes `host.shadowRoot === null`, `adoptedStyleSheets`, `innerHTML` throws, `parseHtml`) | the fixtures themselves |
| `tests/extension-overlay.test.mjs` | D | after D (M1 fixtures; NO dependency on B) | overlay.js in a `vm` sandbox with `fake-chrome` (content context) and the fake DOM: idempotent double injection; no connect at load; `content/overlay-attach` accepted only from the SW-shaped sender (`sender.tab` undefined, right id, `v`, `target`); attach while a port is open does NOT open a second port but still answers `{ok:true}`; a late `onDisconnect` of a replaced port does not dispose the new UI; connects `interp-overlay/1` and posts only `hello`; `WIRE` pinned against LITERAL values written in the test (`interp-overlay/1`, 1, 6, 400; the match with `protocol.js` is asserted in `extension-tree`); style frame validation; caption rendering rules of 8.5.3 (last `maxLines` rows, newest last, partial/final/interrupted styling attributes, skipped rows NOT rendered, truncation keeps the end, `lang`, gap line for about 8 s per false->true transition, `clear` (resets dismissal), `bye`), `status` frames (reconnecting persists until running, stopped clears after about 8 s, status alone shows the wrap), everything via `textContent` (fake element throws on `innerHTML`); auto-hide timers and re-show; dismiss: a same-epoch frame after dismissal stays hidden, a higher epoch re-shows, `clear {lane}` re-shows (off/on); a late captions frame of a port that was detached with `bye` draws nothing (the overlay is never resurrected); hidden document renders nothing; fullscreen: strategy 1 re-parents under a plain container and restores on exit, on an exception and when the container is removed, refuses `VIDEO`/`CANVAS`/`IMG`/`IFRAME`/`INPUT` hosts, strategy 2 uses `popover` + `showPopover` for a bare `<video>` and strategy 3 does nothing when `showPopover` is absent; orphan guard (`chrome.runtime.id` undefined -> disposes without throwing); a throwing `render` disposes silently; host element styles via CSSOM (`all: initial`, `direction: ltr`, `unicode-bidi: isolate`, `pointer-events: none`, z-index max, and exactly those nine properties, all `!important`); every row carries `dir="auto"`; the shadow root is `mode: 'closed'` (`host.shadowRoot === null`, the test reads `lastShadowRoot`); constructable stylesheet primary and `<style>` fallback; no listener or attribute added to page elements other than the two document events | fake DOM, fake-chrome |
| `tests/extension-html.test.mjs` | D | after D | every extension HTML file: R12; ids of 1.5, 7.3, 8.2.1, 8.3, 8.4 all present exactly once; `data-i18n*` keys exist in the union dictionary; DOM order of the panel ids equals the tab order of 8.2.6; the live regions of 8.2.1 carry a `role` and are NOT `hidden` and have no static text; `#tab-notice`/`#mic-notice` are `role="alert"`; the per-lane status lines have no role and no `aria-live`; both caption previews are `role="region"` next to `tabindex="0"` and their `aria-label` binder; no element anywhere is natively `disabled` and only `#btn-start` carries `aria-disabled` (`styles.css` draws it like `:disabled`, hover skips it); the mute icon has two paths, the second `.icon-slash`; `#btn-start` has `aria-describedby`; the caption-lines and auto-hide labels state 1-6 and 0-60 in all three languages, `ext.permission.title` equals `ext.permission.allowButton` and the `MICROPHONE_DENIED` notice names that button exactly; `styles.css` linked with the exact relative path; CSS files contain no `url(`, no `@import`, no `@font-face`, only tokens from `styles.css` or literal hex values that exist in `styles.css`; `panel.css` contains a rule for EVERY selector of the attribute table of 8.2.2 (data-attention, data-emphasis, the three panel-only `data-state` values, empty live regions) and the sticky rule of `.button-row`; the overlay token table (8.5.2) equals `styles.css` values (light/dark from `--light-*`/`--dark-*`, mono from the mono board block); overlay CSS text uses `prefers-reduced-motion` and `forced-colors`, the flex-end overflow anchor of 8.5.2 and no `url(`; a pure WCAG contrast helper asserts text pairs >= 4.5:1 and non-text borders/bars >= 3:1 over the overlay token table and the panel tokens | real files, `parseHtml` |

Delivered: the 24 files of the table exist (`tests/session-isolated.test.mjs` and the 23 `tests/extension-*.test.mjs`; nothing missing, nothing extra) and pass. Real counts, each file run ONCE with `node --test <file>` on 2026-09-29 after the hardening commit `7773fbc` (all pass, 0 fail, 0 skipped): `session-isolated` 8; `extension-arming` 9; `extension-audio-graph` 25; `extension-build` 64; `extension-chrome-adapter` 9; `extension-fixtures` 60; `extension-host` 61; `extension-html` 39; `extension-i18n-loader` 9; `extension-i18n` 5; `extension-integration` 11; `extension-lanes` 36; `extension-manifest` 29; `extension-options` 45; `extension-overlay` 63; `extension-panel` 69; `extension-permission` 24; `extension-protocol` 28; `extension-settings` 23; `extension-static` 36; `extension-sw` 53; `extension-timers` 13; `extension-tree` 24; `extension-ui-state` 35; together 778 tests. The whole suite is 1789 tests at delivery: the 1011 that existed before this work plus these 778. No test reads this document; `tests/privacy.test.mjs` scans it for key-shaped strings, `tests/extension-static.test.mjs` and `tests/extension-tree.test.mjs` read the real `extension/` tree.

Two-way mode (added after the first delivery; the rows above keep their text where the mode did not change it). The current test files were also run against the source tree from before the mode (`git archive` of `540c7fc` into a scratch folder, the nine changed test files and one fixture copied in): all nine new integration tests, 3 of the 3 new protocol tests, 3 of the 3 new loader tests, 5 of the 6 new host tests and 8 of the 9 new lanes tests fail there (the ones that pass are one-way controls, which must pass on both trees), `extension-html` reports 9 failures, and `extension-panel`, `extension-settings` and `extension-ui-state` do not even load (they import `PAIR_MODEL`, `isLanguagePair` and `guessRowLanguage`, which did not exist). The integration file was also run against 12 one-line mutants in a scratch copy (drop the pair in `laneRequestOf`, in the protocol validator, in the lane engine or in the router; keep an equal partner; no swap on a target change; send a pair while two-way is off; two wrong "applies next" rules; a model note that ignores the model; rows without `lang`; no start record in the controller): 11 make at least one test fail, and the survivor (leaving the pair out of the host's caption memo key) is equivalent inside one run, because the epoch in the same key already changes with every start. Real counts, each file run ONCE with `node --test <file>` on 2026-09-29 after the mode landed (all pass, 0 fail, 0 skipped): `extension-host` 61 -> 67, `extension-html` 39 -> 44, `extension-i18n-loader` 9 -> 12, `extension-integration` 11 -> 20, `extension-lanes` 36 -> 45, `extension-panel` 69 -> 86, `extension-protocol` 28 -> 31, `extension-settings` 23 -> 32, `extension-ui-state` 35 -> 40; the other 15 files are unchanged; the 24 files together count 844 tests (778 + 66) and the whole suite 1858 (1792 + 66). What the new tests pin:
- `extension-protocol`: `host/lane-start` `request.languages` (an ordered copy of exactly two distinct `ko|en|ja` values; every other shape is `INVALID_MESSAGE` and never echoed); a caption row's optional `lang` (a bad one drops the frame).
- `extension-settings`: defaults (`twoWay` off, the partner rule), `isLanguagePair`, a record from before two-way reads as one-way with the default partner and everything else kept, `twoWay` strict boolean, a partner equal to the target repaired to the default partner of that target, storage round trip (an old record is read without a write; a target changed to the partner is repaired in the saved record), `laneRequestOf` adds `languages` only for a two-way lane and its output passes the message validator, `hostSettingsOf` never carries two-way.
- `extension-ui-state`: `guessRowLanguage` (the script decides and the answer is always one of the pair), `buildCaptionFrame` two-way (row `lang`, the frame `lang` = the newest row's, the size cap keeps that equality), one-way frames unchanged, an invalid pair means one-way; real engine snapshots: a two-way lane on the translation-only model reports the model it really runs (instruction route, no fallback).
- `extension-lanes`: the engine is given the pair unchanged (`sourceLanguage` still out); a pair on the translation-only model starts on the instruction route and the lane state names the real model; the one-way control keeps the translation setup; a mic pair keeps the order `[target, partner]`; a replacement session after a failure is two-way too; a pair the engine refuses fails the lane with the engine's code and releases the capture; two-way then one-way on one lane forgets the pair; a two-way and a one-way lane side by side; the key never appears in a two-way lane's facts, snapshot, state or setup. Two assertions the mode reverses were changed ("the engine request never has `languages`" now holds for one-way requests only; the tab lane's `facts()` gained `languages: null`).
- `extension-host`: two-way over the host (the panel state names the model in use; rows carry `lang` to the panel and the overlay; a late panel gets them too), no key, audio or engine internals in any port frame and no `"languages"` either, one-way unchanged, only the two-way lane labels its rows, a two-way run followed by a one-way run, `host/lane-start` with a bad pair is `INVALID_MESSAGE` with no engine, no epoch and no lane change.
- `extension-panel`: the view model (partner options, label key, model note, rule 13 with the swapped model and a changed pair or mode), the pinned model ids against `live-config.js` and the sim engine's choice, and the controller against the parsed real panel: rendering of the stored choice, toggle and partner saves (own lane only), the swap on a target change, repair of a stored pair on load, a storage failure snaps the controls back, another window or the options page is followed, the UI language re-translates every two-way string, the mid-run hint, a failed start leaves no record, a lost connection drops the claim, the panel's request carries no pair of its own.
- `extension-html`: 122 keys and the pinned two-way wording in three languages (the former assertion that the extension has NO two-way key now asserts the opposite: exactly the five `ext.twoWay.*` keys), the markup contract of the new ids, their tab order, and the `.partner-row` rule of `panel.css`. `extension-i18n-loader`: the keys resolve in three languages and fall back per key; all 122 keys resolve; `applyI18n` fills the two-way lines of the real markup.

### 11.2 Fake-chrome helper API (`tests/fixtures/fake-chrome.mjs`, group D) — the contract B and C code their tests against

```js
export const GRANT_ERROR  = 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.';
export const ACTIVE_STREAM_ERROR = 'Cannot capture a tab with an active stream.';
export const STREAM_ID_TTL_MS = 5000;              // fake stand-in for "a few seconds" (unknown real value, A20)
export function createFakeBrowser({ extensionId = 'abcdefghijklmnopabcdefghijklmnop', strictGesture = true,
  noResponder = 'reject',        // what sendMessage does when listeners exist but none answers: 'reject' (real Chrome is believed to reject with
                                 // 'The message port closed before a response was received.', A24) or 'undefined' (the first draft's assumption)
  swSenderHasUrl = true,         // false: the SW's MessageSender has NO `url` (A23); origin/id/no tab/no frameId only
  contentStorage = 'absent',     // content context after TRUSTED_CONTEXTS: 'absent' (no chrome.storage) or 'rejects' (present, every call rejects) (A25)
  shortcut = 'Alt+Shift+Y',      // what commands.getAll reports for _execute_action (null = unassigned)
  messages = {} /* _locales messages for i18n.getMessage */ } = {}) -> browser
```

`browser` members (all synchronous unless stated):
- `clock`: `{ now(), advance(ms): Promise<void>, setTimeout, clearTimeout, pending(): number }` — virtual time; `advance` fires due timers in order and flushes
  microtasks between them. Every fake API that has a time behavior (stream-id TTL, SW idle, AUDIO_PLAYBACK close, port timers) uses it.
- `extensionId`, `origin`, `url(path)`.
- Tabs/windows: `addTab({ id, url, windowId = 1, active })` -> tab; `navigate(tabId, url): Promise<void>` (fires `tabs.onUpdated` `{status:'loading', url}` then `{status:'complete'}`;
  clears the grant on cross-origin; disconnects that tab's content ports; re-creates the tab's content context when the new URL is `http(s)` and `browser.contentScripts` is true);
  `closeTab(tabId)` (fires `tabs.onRemoved`, ends that tab's capture track with `ended`, disconnects ports, clears grants); `activateTab(tabId)` (fires `tabs.onActivated`; also marks the tab `active` in its window);
  `focusWindow(windowId)` (the `lastFocusedWindow` used by `tabs.query({active:true, lastFocusedWindow:true})`, which the fake supports together with `active`, `windowId` and `url` filters);
  `browser.startup()` fires `runtime.onStartup` in the SW; `commands.getAll()` resolves `[{ name: '_execute_action', shortcut }]`;
  `browser.contentScripts` (default true) simulates the static content script; `browser.tabs` (Map); `hasContent(tabId)`.
- Contexts: `createContext(kind, { url, tabId, frameId = 0 })` with `kind` in `panel|options|permission|offscreen|content` -> `context` with `context.chrome` (a `chrome`-shaped object
  restricted to what that kind may see: offscreen = `runtime` only, and its `runtime` is EXACTLY `{ id, getURL, sendMessage, connect, onMessage, onConnect }` (a host that touches any other member fails in the test, not in Chrome);
  content = `runtime` (`id`, `connect`, `onMessage`, `sendMessage`) and `i18n` only; storage present only for extension pages),
  `context.sender` (the `MessageSender` other contexts observe: `{ id, url, origin, tab?, frameId? }`), `context.close()` (unload: fires peers' `onDisconnect`).
  `browser.sw`: `{ register(bootstrap /* (chrome) => void, run at every SW start */), running, starts, kill(), idleTimeoutMs = 30000 }`; the SW context is created from `register`; its `sender` carries `url` only when `swSenderHasUrl`.
  The SW dies after `idleTimeoutMs` of fake time without an event, an extension API call or a port message (opening a port does not count); the next delivered event restarts it (re-runs `bootstrap`).
  `browser.contexts()` lists live contexts.
- Messaging: `runtime.sendMessage` JSON round-trips its argument and the response; fans out to every other context that registered `onMessage`; the first `sendResponse` wins; a listener returning `true` keeps the
  channel open; listeners exist but none answers -> per `noResponder`: rejects `Error('The message port closed before a response was received.')` (default) or resolves `undefined`; no other context
  with a listener -> rejects `Error('Could not establish connection. Receiving end does not exist.')`; 64 MiB cap throws. Callers must survive ALL THREE outcomes plus `{ok:false}` (6.3 `sendToHost`).
  `tabs.sendMessage(tabId, message, { frameId })` reaches only that tab's content context (same rejection when none). `runtime.connect({ name })` delivers a `Port` to every other context with an `onConnect`
  listener (the `sender` above); a port with no receiver disconnects asynchronously at once; `port.disconnect()` by a receiver notifies only the sender; unload/navigation notifies peers;
  `port.postMessage` JSON round-trips.
- Storage: `storage.local` / `storage.session` (`get`, `set`, `remove`, JSON copies, `onChanged(changes, areaName)` async to every context with access); `setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` recorded on
  `browser.accessLevel`; while the level is `TRUSTED_CONTEXTS` a `content` context has NO `chrome.storage` at all (`contentStorage: 'absent'`) or has the object and every call REJECTS (`'rejects'`); `session` is never visible to `content`;
  offscreen has no storage. `browser.failSetAccessLevel(true)` makes `setAccessLevel` reject (options page refusal test).
- Grants and gestures: `browser.clickAction(tabId)`, `browser.pressShortcut(tabId)`, `browser.clickContextMenu(tabId, menuItemId)` grant `tabCapture`+`activeTab` for that tab BEFORE dispatching to the SW
  listeners, and mark `gestureActive` true for the SYNCHRONOUS part of the listener call only when `strictGesture` (any `await` before `sidePanel.open` makes it reject); with
  `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` set, `clickAction` dispatches nothing and grants nothing. `sidePanel.open` rejects
  ``Error('`sidePanel.open()` may only be called in response to a user gesture.')`` without a gesture and records `browser.panelOpens`. `sidePanel.setPanelBehavior` records `browser.panelBehavior`.
  `tabCapture.getMediaStreamId({ targetTabId })`: no grant -> rejects `GRANT_ERROR`; an existing capture or a pending unexpired id for the tab -> `ACTIVE_STREAM_ERROR`; unknown tab -> `'Invalid tab specified.'`;
  `chrome:`/`about:`/`chrome-extension:` url -> `'Cannot capture this page.'`; else returns `fake-stream-<n>` (single use, expires after `STREAM_ID_TTL_MS`). `tabCapture.getCapturedTabs()` lists active captures.
  `browser.consumeStreamId(id)` -> a `FakeMediaStream` with one audio `FakeTrack` (marks the capture active; stopping the track releases it) or throws `{ name: 'NotAllowedError' }` for unknown, expired or used ids;
  `browser.captures` (Map tabId -> capture). A fake `navigator.mediaDevices.getUserMedia` in `fake-audio` calls `consumeStreamId` for `{audio:{mandatory:{chromeMediaSource:'tab', chromeMediaSourceId}}}`.
- Offscreen: `offscreen.createDocument({ url, reasons, justification })`: `reasons` non-empty and within the 15 documented values else rejects ``'A `reason` must be provided.'``; a second document rejects
  `'Only a single offscreen document may be created.'`; records `browser.offscreenDocument = { url, reasons }`; calls `browser.onCreateOffscreen(context)` (the test wires the real host into `context.chrome`);
  an `AUDIO_PLAYBACK`-only document closes after 30 s of fake time unless `browser.audible` is true; `closeDocument` with none rejects `'No current offscreen document.'`, else destroys the context.
  `runtime.getContexts({ contextTypes, documentUrls })` returns `{ contextType: 'OFFSCREEN_DOCUMENT'|'SIDE_PANEL'|'TAB'|'BACKGROUND', documentUrl, tabId }` records.
- Scripting/menus/i18n: `scripting.executeScript({ target:{tabId}, files })` rejects unless the tab holds an activeTab grant, else calls `browser.onInject(tabId, files)` (the test runs the overlay in a content context);
  `contextMenus.create` throws on a duplicate id, `removeAll` clears, `browser.menus` lists; `i18n.getMessage(name)` reads `messages`; `getUILanguage()` returns `'en'`.
- Deliveries log: `browser.deliveries` records every message request/response and every port frame as `{ from, to, kind, json }` (already JSON-serialized) so tests can scan for the key or the stream id.
- Delivered beyond the members above (see the header comment of `tests/fixtures/fake-chrome.mjs`): `browser.settle()`, `withGesture(fn)`, `pushState(tabId, url)`, `install(reason)`, `context.invalidate()` (the extension was reloaded under a content script), the hooks `onCreateOffscreen`, `onInject`, `onContentCreated`, `onTabCreate`, `onPanelOpen`, `onOpenOptions`, and the exported error strings (`NO_RECEIVER_ERROR`, `PORT_CLOSED_ERROR`, `GESTURE_ERROR`, ...). `createFakeAudioEnv({ browser, clock, sockets, autoplay, micPermission })` also takes `autoplay` (`'allowed'` or `'blocked'`) and `micPermission`, and returns `clock` next to the members listed in 11.3.

### 11.3 Fake audio and fake DOM helpers

`tests/fixtures/fake-audio.mjs` (group D): `createFakeAudioEnv({ browser, sockets })` -> `{ env, contexts, worklets, setMicPermission(state), setMicError(name), micStreams }` where `env` has the shape the host expects
(`AudioContext`, `AudioWorkletNode`, `MediaStream`, `navigator: { mediaDevices: { getUserMedia }, permissions: { query }, userActivation: { isActive: false } }`, `WebSocket` (from `sockets`), timers and `now` from the clock,
`random: () => 0.5`, `isSecureContext: true`, and `fetch: async () => { throw new Error('unexpected fetch'); }`: the host passes `env.fetch` to `createAppConfig` (5.2, 5.5), so without it a test that reaches a REST path would try a real network call;
`tests/fixtures/sim.mjs` does the same for the same reason). `FakeAudioContext` has `state` (`suspended` until `resume()` unless `options.autoplay = 'blocked'`), `sampleRate`, `currentTime` (from the clock), `destination`,
`resume/suspend/close` (state changes + `statechange`), `audioWorklet.addModule`, `createMediaStreamSource`, `createGain` (`gain.value`, `setTargetAtTime`), `createMediaStreamDestination` (a new stream with a live track each call),
`createBuffer`/`createBufferSource` (enough for `stream-player`), `addEventListener`. `FakeAudioWorkletNode` exposes `port` and `emitFrames(value = 0.25)` (posts `Float32Array(1024)` like `tests/fixtures/sim.mjs`).
`FakeTrack`/`FakeMediaStream` implement `stop`, `readyState`, `muted`, `clone`, `getTracks`, `getAudioTracks`, `addEventListener`. Nothing here touches a real device or makes a sound.

`tests/fixtures/extension-dom.mjs` (group D): `FakeElement` (does NOT extend the app fixtures; it throws on `innerHTML`, `outerHTML`, `insertAdjacentHTML` like `tests/fixtures/scenarios.mjs`) with `id`, `tagName`, attributes,
`dataset`, `classList`, `hidden`, `disabled`, `checked`, `value`, `textContent`, `children`, `parentNode`, `append/appendChild/replaceChildren/remove`, `addEventListener/removeEventListener/dispatchEvent`, `click()`, `focus()`,
`style.setProperty/getPropertyValue`, `attachShadow({mode})` (a `FakeShadowRoot` with `adoptedStyleSheets`, children, `host`; the element's `shadowRoot` getter returns `null` for `mode: 'closed'`, and the created root is recorded as `lastShadowRoot`
on the element so a test can inspect what the page could not), `popover` / `showPopover()` / `hidePopover()` (recording calls; `showPopover` can be removed to model an older Chrome), upper-cased `tagName`, `getRootNode()`, `isConnected`; `FakeCSSStyleSheet.replaceSync(text)`;
`parseHtml(source)` -> `FakeDocument` (`getElementById`, `querySelector('#id' | '.class' | 'tag')`, `querySelectorAll('[attr]' | '.class' | 'tag')`, `documentElement`, `title`, `createElement`, `visibilityState`,
`fullscreenElement`, `hidden`, event dispatch for `visibilitychange` and `fullscreenchange`); the parser only needs to handle the controlled markup of section 8 (no scripts, well-formed, void elements, boolean attributes);
`runClassicScript(source, sandbox)` runs a classic script in `vm.createContext(sandbox)`.

`tests/fixtures/extension-lanes.mjs` (group B, OPTIONAL): a helper that builds a `createLaneHost` (or one lane) over `fake-chrome` + `fake-audio` + socket fixtures so `extension-lanes`, `extension-host` and (through the same seam) C's integration test do not each repeat the wiring. It is listed here and in 15.4, and the D13 no-sound scan covers it (the glob is `tests/fixtures/extension-*.mjs`, so `extension-dom.mjs` and this file are both scanned, together with `fake-chrome.mjs` and `fake-audio.mjs`).

### 11.4 Mapping of decisions D1-D14 to tests

| Decision | Tests that pin it |
|---|---|
| D1 one host, `['USER_MEDIA']`, isolated lanes, one config per lane, no iframes | `extension-sw` (reasons exactly `['USER_MEDIA']`, one document under ten concurrent ensures), `session-isolated`, `extension-lanes` (two lanes, per-lane config), `extension-static` (no `<iframe>` in extension HTML/JS) |
| D2 arm via action click, sidePanel.open first, mint last, needs-arm, auto-start | `extension-sw` (order, strict gesture, NEEDS_ARM, mint last, cancellation before/after the mint), `extension-fixtures` (grant model), `extension-panel` (pending + auto-start, the `needed`/`waiting` split), `extension-integration` |
| D3 tab audio graph | `extension-audio-graph`, `extension-lanes` |
| D4 platform shim | `extension-audio-graph` (shim), `extension-lanes` (engine runs with hidden=false/isActive=true fakes reporting the opposite on the real env) |
| D5 mic permission page, permission watch (the on-page instruction names the choice to AVOID, 14.4 change 2) | `extension-permission`, `extension-panel` (permission gate, `MICROPHONE_EXPIRED`), `extension-sw` (`sw/permission-open`), `extension-lanes` (preflight) |
| D6 overlay: static IIFE, CLOSED Shadow DOM (14.4 change 1), port direct to host, textContent, fullscreen strategies | `extension-overlay`, `extension-host` (overlay hub), `extension-static` (classic script, `attachShadow` only closed), `extension-html` (tokens, anchors), `extension-tree` (WIRE parity) |
| D7 control plane: target envelope, panel port, grace, SW stateless-by-storage, no reliance on `sidePanel.onClosed`, stop reasons | `extension-protocol`, `extension-host` (grace, reasons), `extension-sw` (kill/revive, no `onConnect`, `lastStop`), `extension-integration` |
| D8 key: storage.local + TRUSTED_CONTEXTS (SW start, `onStartup`, options page before `writeKey`), message only, never to content, never logged, optional key flag | `extension-sw` (access level, `onStartup`), `extension-options` (refusal when `setAccessLevel` rejects), `extension-settings`, `extension-integration` (delivery scan), `extension-build` (keyed/unkeyed), `extension-static` (no secrets/logging) |
| D9 layout: source in `extension/`, dist mirrors repo, ext dictionaries, check-i18n patch | `extension-build` (layout, closure, fixture roots), `extension-tree` (real-repo build), `extension-i18n`, `extension-static` (R1) |
| D10 ko/en/ja 해요체 (its "no two-way" half was reversed, 14.4 change 3) | `extension-i18n` and `extension-html` (parity of 122 keys, 해요체, the five `ext.twoWay.*` keys with pinned wording), `extension-settings` (`twoWay`, `partnerLanguage`, `laneRequestOf`), `extension-protocol` (`request.languages`), `extension-lanes`, `extension-host`, `extension-panel`, `extension-integration` (the pair from the panel to the Live setup) |
| D11 Chrome 116, feature detection, `_locales`, Load unpacked | `extension-manifest` (fixture), `extension-tree` (real manifest, mirrors), `extension-i18n` (locale files), `extension-sw` (`getContexts` used, no `hasDocument`), `extension-chrome-adapter` (absent members skipped) |
| D12 free-tier footnote | `extension-tree` (`ext.usage.twoSessions` exists in 3 languages and contains a marker word for the not-measured statement: `측정` / `estimate` / `実測`), `extension-panel` (rule 12: the note is shown when both lanes are enabled) |
| D13 silent tests only | every file above; `extension-static` asserts that none of `tests/extension-*.test.mjs` (EXCEPT itself), `tests/session-isolated.test.mjs` and every fixture matching `tests/fixtures/extension-*.mjs`, `fake-chrome.mjs`, `fake-audio.mjs` contains `afplay`, `getDisplayMedia`, `--use-fake-device-for-media-stream`, `puppeteer`, `playwright`, `chrome-launcher`, `osascript`, or a `child_process` import. The forbidden tokens are ASSEMBLED AT RUNTIME inside the scan (`['af', 'play'].join('')`), because the scan file would otherwise contain them itself. The only files allowed to import `child_process` are `extension-build.test.mjs` (argument-error tests) and `extension-tree.test.mjs` (real-root CLI build into a temp dir); both spawn only `node scripts/build-extension.mjs`. |
| D14 no web-app edits | `extension-static` (`app/` never references `extension/`), the untouched existing 1011 tests; the section-12 edit list is the only change set outside `extension/`, apart from the two backward-compatible `app/` files of the isolated slot (`2f6901a`, pinned by `session-isolated` and by the 1011 existing tests) and the router fix `540c7fc` (`app/providers/router.js`, pinned by `tests/provider-integration.test.mjs`) |

---------------------------------------------------------------------------------------------------

## 12. Repo-gate edits (group A; the only edits outside `extension/`, D14)

Delivered in `43febec` as specified below: `.gitignore` (the line `dist/`), `package.json` (the script `build:extension`), `scripts/check-i18n.mjs` (its diff against the parent commit equals the patch of 12.1 line for line, all 51 changed lines, compared by script on 2026-09-29) and `scripts/stage-release.mjs` (the one `export`). At delivery `node scripts/check-i18n.mjs` prints `I18N_OK languages=3 keys=810 files=123`. The two `app/` edits of the isolated Live slot are commit `2f6901a`. The instructions below are kept as written for the record.

Apply in this order; after each edit run `node --test tests/*.test.mjs` (must stay 1011+ passing) and `node scripts/check-i18n.mjs`.

### 12.1 `scripts/check-i18n.mjs`: apply the prepared, tested patch

Run first: `git apply --check <patch>` (it applied cleanly against the current file on 2026-09-29; re-run the check in case another edit touched the file), then `git apply <patch>`.
The patch adds `EXTENSION_KEY_PREFIX = 'ext.'`; `validateDictionaries(dictionaries, { requireErrorKeys = true, keyPrefix = null } = {})`;
`checkSource(source, dictionary, { html = false, literalPrefix = null } = {})`; the private `extensionDictionaries(root)` (returns `null` when `extension/i18n` is absent); and,
inside `checkI18n`, a block that (when `extension/i18n` exists) validates the ext dictionaries, reports `I18N_KEY_COLLISION`, and checks every `.js`/`.mjs`/`.html` file under `extension/`
(the directory named `i18n` is skipped by `sourceFiles`) against the union of app and ext English keys with `literalPrefix: 'ext.'`, adding those files to `files`. The single-line
`I18N_OK languages=3 keys=<app keys> files=<n>` output shape is unchanged (pinned by `tests/i18n.test.mjs`). With the patch and a legitimate extension tree all 1011 existing tests pass
(measured in a scratch copy). Its content, verbatim:

```diff
--- a/scripts/check-i18n.mjs
+++ b/scripts/check-i18n.mjs
@@ -10,7 +10,11 @@
 const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
 const placeholders = (value) => [...new Set([...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]))].sort().join(',');
 
-export function validateDictionaries(dictionaries) {
+// Keys of the browser-extension dictionaries (extension/i18n) all start here, so
+// they can never shadow a web-app key and the web app never needs them.
+export const EXTENSION_KEY_PREFIX = 'ext.';
+
+export function validateDictionaries(dictionaries, { requireErrorKeys = true, keyPrefix = null } = {}) {
   const issues = [];
   const english = dictionaries.en;
   const validObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
@@ -26,13 +30,14 @@
         issues.push('I18N_INVALID_ENTRY');
         continue;
       }
+      if (keyPrefix !== null && !key.startsWith(keyPrefix)) issues.push('I18N_KEY_PREFIX');
       if (typeof english[key] === 'string' && placeholders(value) !== placeholders(english[key])) {
         issues.push('I18N_PLACEHOLDER_MISMATCH');
       }
     }
   }
-  for (const key of ['error.unknown', ...ERROR_CODES.map((code) => `error.${code}`),
-    ...SECURITY_CODES.map((code) => `error.${code}`)]) {
+  for (const key of requireErrorKeys ? ['error.unknown', ...ERROR_CODES.map((code) => `error.${code}`),
+    ...SECURITY_CODES.map((code) => `error.${code}`)] : []) {
     if (!Object.hasOwn(english, key)) issues.push('I18N_MISSING_ERROR');
   }
   return [...new Set(issues)];
@@ -45,7 +50,7 @@
  * This deliberately does not claim to parse all JavaScript or detect every
  * possible hardcoded UI string (computed assignments, aliases, templates).
  */
-export function checkSource(source, dictionary, { html = false } = {}) {
+export function checkSource(source, dictionary, { html = false, literalPrefix = null } = {}) {
   const issues = [];
   const patterns = [
     /\bt\(\s*(['"])([^'"\r\n]+)\1/g,
@@ -57,6 +62,15 @@
       if (!Object.hasOwn(dictionary, match[2])) issues.push('I18N_UNKNOWN_UI_KEY');
     }
   }
+  // A quoted literal that is shaped like a key of the given namespace must be one
+  // (catches bind.text(el, 'ext.typo') and other call shapes the patterns above
+  // do not know). Dynamic keys still need explicit has() tests.
+  if (literalPrefix) {
+    const escaped = literalPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
+    for (const match of source.matchAll(new RegExp(`(['"\`])(${escaped}[A-Za-z]\\w*(?:\\.\\w+)*)\\1`, 'g'))) {
+      if (!Object.hasOwn(dictionary, match[2])) issues.push('I18N_UNKNOWN_UI_KEY');
+    }
+  }
   if (/\b(?:textContent|innerText|innerHTML|outerHTML)\s*=\s*(['"`])[^'"`]*[^\s'"`][^'"`]*\1/.test(source)
       || /\b(?:placeholder|title|ariaLabel)\s*=\s*(['"`])[^'"`]*[^\s'"`][^'"`]*\1/.test(source)
       || /\b(?:createTextNode|alert|confirm|prompt)\(\s*(['"`])[^'"`]+\1/.test(source)) {
@@ -87,6 +101,14 @@
   return files;
 }
 
+/** extension/i18n/{ko,en,ja}.json, or null when the tree has no extension. */
+async function extensionDictionaries(root) {
+  const directory = resolve(root, 'extension/i18n');
+  try { await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
+  return Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
+    [language, JSON.parse(await readFile(resolve(directory, `${language}.json`), 'utf8'))])));
+}
+
 export async function checkI18n({ root = rootDirectory } = {}) {
   try {
     const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
@@ -110,6 +132,27 @@
         issues.push({ code, file: relative(root, file) });
       }
     }
+    // The browser extension (extension/) has its own dictionaries, ext.* keys
+    // only, and may also use every web-app key. It is checked when present; the
+    // web app is never checked against it (app/ must not use ext.* keys).
+    const extension = await extensionDictionaries(root);
+    if (extension) {
+      for (const code of validateDictionaries(extension, { requireErrorKeys: false, keyPrefix: EXTENSION_KEY_PREFIX })) {
+        issues.push({ code, file: 'extension/i18n' });
+      }
+      if (Object.keys(extension.en ?? {}).some((key) => Object.hasOwn(dictionaries.en, key))) {
+        issues.push({ code: 'I18N_KEY_COLLISION', file: 'extension/i18n' });
+      }
+      const union = { ...dictionaries.en, ...extension.en };
+      const extensionFiles = await sourceFiles(resolve(root, 'extension'));
+      for (const file of extensionFiles) {
+        const source = await readFile(file, 'utf8');
+        for (const code of checkSource(source, union, { html: file.endsWith('.html'), literalPrefix: EXTENSION_KEY_PREFIX })) {
+          issues.push({ code, file: relative(root, file) });
+        }
+      }
+      files.push(...extensionFiles);
+    }
     return { ok: issues.length === 0, issues, keys: Object.keys(dictionaries.en).length, files: files.length };
   } catch {
     return { ok: false, issues: ['I18N_CHECK_FAILED'] };
```

Consequences engineers must respect (verified by the architect on 2026-09-29 against the patched checker in a scratch copy, using the ext dictionaries of 9.2 and the panel skeleton of 8.2.1):
- HTML attributes named `title`, `placeholder`, `aria-label`, `alt` (also as the tail of `data-i18n-title` / `data-i18n-aria-label`) are flagged; use the four binder spellings of 8.1.
- `literalPrefix: 'ext.'` flags any quoted literal shaped `ext.<word>` that is not a key: never write a string literal like `'ext.js'`; template literals with `${` are not literals (dynamic keys are covered by the has() tests of 9.6).
- The prototype test `extension-i18n.test.mjs` (3 tests) lived only in the architect's session scratchpad, which disappears with the session; its full text is committed in Appendix C of this document, and group A starts from that text (not from a path).

### 12.2 `.gitignore`

Append one line (the file currently ends with `release/`):

```
dist/
```

`dist/` MUST be ignored before the first keyed build (10.6). Nothing else is added (no `*.pem`: no signing key is ever created).

### 12.3 `package.json`

Add exactly one script; nothing else changes (`version` stays `0.7.0`, pinned by `tests/policy-schema.test.mjs`; `type`, `engines`, `test`, `serve` unchanged). The script has NO `--clean`: the build replaces its own previous output by itself (10.1 rebuild semantics), so `npm run build:extension` can be repeated:

```json
"scripts": {
  "test": "node --test tests/*.test.mjs",
  "serve": "node scripts/serve.mjs",
  "build:extension": "node scripts/build-extension.mjs"
}
```

### 12.4 `scripts/stage-release.mjs` (optional, one word)

Change `async function readBuiltinKey(path) {` to `export async function readBuiltinKey(path) {`. No behavior change, no test edit. If group A prefers not to touch the file, it MUST duplicate the ~10 lines
verbatim in `scripts/build-extension.mjs` (same shape regex, same one-key-per-line rules) and map the errors to `EXTENSION_KEY_*`; the tests in 11.1 pass either way.

### 12.5 New files (not edits)

`scripts/build-extension.mjs`, `docs/extension.md`, the tests and fixtures of 11, everything under `extension/`. Verification that nothing else changed:
`git status --short` shows only the files of section 3.1, the three edited files above (plus the two `app/` files, committed since in `2f6901a`), and the pre-existing untracked entries.

---------------------------------------------------------------------------------------------------

## 13. Manual verification checklist (for the owner). Every item: NOT TESTED BY CLAUDE

Nothing below has been run. Claude ran no browser, no capture, no microphone and no audio (owner rule, meeting in progress). Each item lists steps, the expected result and the fallback if it fails (K = risk of section 14, A = assumption).
Use branded Chrome (the owner's is 154) with Developer mode on. Items 13.26-13.39 were added after the reviews of Revision 2; several exist only because a fake cannot prove them (announcements by a screen reader, layout, throttling, real process lifetime). Items 13.40-13.51 were added after the review of the BUILT extension (UX and security lenses): they are the human-only steps a fake DOM cannot do (how captions look over real video, glyphs, narrow widths, text expansion, voice, keyboard, Chrome's own site-access line). 13.42 and 13.51 record two defects that are KNOWN and NOT FIXED. Items 13.52-13.57 were added with the two-way mode: the model's real two-way output, its choice of direction, the speaker feedback loop, the caption `lang` attribute and the native dropdown cannot be proven by a fake. Rows 13.31, 13.33, 13.47, 13.48 and 13.49 were rewritten after the UX fixes to the built panel (a focusable `aria-disabled` Start, a slashed mute icon, range-checked number fields): their "At review time" wording is history, the expected results describe the delivered behavior, and all of them are still unrun.

| # | Item | Status | Steps | Expected | If it fails |
|---|---|---|---|---|---|
| 13.1 | Build | NOT TESTED BY CLAUDE | `cd /Users/gai/work/interp-app && npm run build:extension` (run it twice: the second run must also succeed) | prints `EXTENSION_BUILT out=…/dist/extension files=… version=0.1.0` both times; no `EXTENSION_*` error. After EVERY later rebuild press Reload on the extension's card at `chrome://extensions` (Chrome does not watch the folder) | fix the code printed (10.7) |
| 13.2 | Load unpacked | NOT TESTED BY CLAUDE | `chrome://extensions` -> Developer mode -> Load unpacked -> select `dist/extension`; pin the toolbar icon (puzzle-piece menu -> pin) | card "Live Interpreter" with no "Errors" button; "Inspect views: service worker"; keep the folder at a STABLE path (an unpacked extension's id derives from the path; moving it loses the stored key, K14) | read the error text; a manifest error means lint and Chrome disagree (K17) |
| 13.3 | Key entry | NOT TESTED BY CLAUDE | click the toolbar icon on any http(s) page; panel opens with the key notice and an unavailable Start (dimmed, `aria-disabled`); Options -> paste a Gemini key -> Save | status "Key saved in this browser." (`ext.key.savedBrowser`); the field is empty afterwards; Start becomes available; in a page's DevTools console (extension context of the content script) `chrome.storage` is either undefined OR present with calls that are rejected (A25: both are acceptable, K15) | K15: read the result of `storage.local.setAccessLevel` in the SW console; if Save refuses with the storage error text, `setAccessLevel` rejected |
| 13.4 | Icon click arms + opens panel | NOT TESTED BY CLAUDE | open a normal https page with a video; click the toolbar icon | side panel opens in the same click; `#tab-arm-note` shows "This tab is ready. Press Start." | K1, K23: if the panel does not open, `sidePanel.open` lost the gesture; if the note stays "first click the toolbar icon…", the grant path differs |
| 13.5 | Tab lane | NOT TESTED BY CLAUDE | play the video; enable Tab audio only; choose a target language; press Start | status "Checking permissions and audio readiness" -> Connecting -> Connected; NO immediate "forbidden"/`INTERNAL` notice on the very first Start (A23: the SW sender rule); the tab shows Chrome's capture indicator; original audio keeps playing at the slider volume WITHOUT a gap when Start is pressed; captions appear on the page if "Show captions on the page" is ticked; captions also in the panel preview | audio gap or silence: K3, A3, K4. No captions: check the panel preview first (host running?), then K13/overlay. `TAB_CAPTURE_FAILED`: K7 (flip `TAB_CAPTURE_INCLUDE_VIDEO`). Immediate failure with a FORBIDDEN-style error: A23 (`sender.url` of the SW), fake mode `swSenderHasUrl:false` shows the intended handling |
| 13.6 | Passthrough volume | NOT TESTED BY CLAUDE | while running move the slider 0 -> 65 -> 100 | original audio level follows the slider live; 0 = silent original, captions continue | K4 (fan-out/graph) |
| 13.7 | Mute default | NOT TESTED BY CLAUDE | speech is muted by default (mute icon red, note visible); press the mute button ("Turn interpreted speech on") | translated voice audible only after unmuting; muting again silences it; the ORIGINAL audio is unaffected by the mute button. RECORD explicitly: unmuting produced sound (A3 true) or the panel showed "Chrome blocked playback of interpreted speech…" (A3 false) | `output: blocked` = K3 (v1 has no remedy: captions continue) |
| 13.8 | Mic permission | NOT TESTED BY CLAUDE | press the microphone button (or "Allow microphone"); a tab opens; RECORD the exact choices Chrome shows (Chrome's help lists "Allow while visiting the site", "Allow this time", "Never allow" for web pages; A14 whether the same appear for an extension page); choose the one that is NOT "Allow this time"; repeat once choosing "Allow this time" | the tab says it closes in a moment and closes; the panel status line reads "Microphone permission · Allowed"; with "Allow this time" the panel later shows the "permission has expired" notice instead of the generic denial; macOS: Chrome must also be allowed in System Settings -> Privacy -> Microphone | K11 |
| 13.9 | Mic lane | NOT TESTED BY CLAUDE | enable Microphone only, Start, speak | captions of your speech in the target language in the panel preview; input meter moves; no prompt appears inside the panel; page captions appear ONLY if "Show captions on the page" of the mic card was ticked (default off) | K11 |
| 13.10 | Deny path | NOT TESTED BY CLAUDE | revoke the microphone permission for the extension (site settings), Start with mic enabled | mic notice "Microphone permission is missing…", the two microphone buttons are highlighted, tab lane (if enabled) unaffected | — |
| 13.11 | Two lanes | NOT TESTED BY CLAUDE | enable both; the doubling note is visible; Start; RECORD whether the free key allowed two concurrent sessions | both `Connected`; captions from both in the panel; a quota/limit error on one lane leaves the other running; if the free tier refuses the second session, note which text appeared (`SESSION_LIMIT`, or "reopened three times" after three automatic retries) and whether it named "try with just one" | K9 |
| 13.12 | Overlay: normal site | NOT TESTED BY CLAUDE | a plain article site, tab captions on | caption bar at the bottom, readable, does not block clicks (click through it), close button hides it AND it stays hidden (the next frame does not bring it back); a new Start shows it again | K13 |
| 13.13 | Overlay: strict CSP | NOT TESTED BY CLAUDE | a site with a strict `style-src` (for example a code-hosting site) | overlay styled correctly (no unstyled text), with the CLOSED shadow root | K13 (fallback order: adoptedStyleSheets -> `<style>`; A15) |
| 13.14 | Overlay: fullscreen | NOT TESTED BY CLAUDE | a site that fullscreens a container (video player page), then a bare `<video>` fullscreen | RECORD per site: strategy 1 (re-parent under the plain container: captions visible inside it) and strategy 2 (top-layer `popover`: captions visible over a bare `<video>`); the page is not broken after exiting fullscreen (host back under `<html>`) | K13, A17: strategy 3 = invisible in fullscreen, panel preview still shows them |
| 13.15 | Overlay: SPA and navigation | NOT TESTED BY CLAUDE | navigate inside a single-page app (URL changes without reload), then follow a normal link | SPA: overlay persists; full navigation: overlay re-appears within ~2 s (same origin keeps arming) | K1 |
| 13.16 | Panel closed | NOT TESTED BY CLAUDE | close the panel, wait >= 3 s; then reopen the panel; also close and reopen within 2 s | capture indicator disappears, tab audio normal; `chrome://extensions` -> Inspect views shows no offscreen document a few seconds later; the reopened panel shows "Interpretation stopped because the panel was closed…"; reopening within the 3 s grace keeps the lanes running | K22 |
| 13.17 | Panel replaced / hidden | NOT TESTED BY CLAUDE | open another side-panel feature (for example the reading list) while running; wait 10 s; come back | RECORD which happened (A21): the lanes kept running (the hidden panel keeps its port) OR they stopped after ~3 s and the panel shows the "panel was closed" notice on return | if they stop: v1 accepts it (the notice explains it); a later design moves the port owner (K22) |
| 13.18 | Tab closed | NOT TESTED BY CLAUDE | close the captured tab while the mic lane runs | tab lane ends with the "audio can no longer be taken from this tab" note (says: click the icon, then Start); the mic lane continues | A4 |
| 13.19 | Cross-origin navigation | NOT TESTED BY CLAUDE | navigate the captured tab to another origin | record what happens (capture continues or ends with TAB_ENDED); either is acceptable; a later Start on the new origin requires clicking the icon again, and the arm alone must NOT start the lane unless Start was pressed first | K8 |
| 13.20 | Extension reload | NOT TESTED BY CLAUDE | reload the extension on `chrome://extensions` while a page with the overlay is open | no errors in the page console; clicking the icon on that tab re-injects the overlay (fallback) | K13 |
| 13.21 | Offscreen probe (measurements for A2/A3) | NOT TESTED BY CLAUDE | `chrome://extensions` -> Inspect views: offscreen document -> Console: `[navigator.userActivation.isActive, document.visibilityState, new AudioContext().state]` while a lane is running | record the three values (expected `false`, possibly `hidden`, `running`) | K2, K3 |
| 13.22 | Timers (WORST CASE, K5) | NOT TESTED BY CLAUDE | with a lane running set the original volume to 0, keep the translated speech MUTED, put the panel and the tab in the background (another window in front), and wait at least 60 s; then look at the panel and page | captions keep arriving with normal delay, the meter keeps moving, NO "audio was not sent" gap line appears. RECORD the caption delay and the gap line. (The offscreen document is not the browser window; at the default 65% volume the graph stays audible and could pass while volume 0 plus muted fails) | if a gap line appears or captions lag: switch `TIMER_MODE` to `'worker'` (5.13, one constant) and repeat; K5 |
| 13.23 | Key privacy | NOT TESTED BY CLAUDE | in DevTools of a normal page, switch the console context to the extension's content script and run `chrome.storage.local.get(null)` | rejected or `chrome.storage` undefined | K15, A25 |
| 13.24 | Optional keyed build | NOT TESTED BY CLAUDE | `node scripts/build-extension.mjs --builtin-key-file <file>` (only if wanted) | second line `EXTENSION_BUILTIN_KEY keys=1`; the key exists only in `dist/`; test Start with no personal key | K12 |
| 13.25 | Shortcut | NOT TESTED BY CLAUDE | `chrome://extensions/shortcuts` shows "Alt+Shift+Y" for the panel (or unassigned on conflict); the panel's arm note shows the same shortcut or none | pressing it on a page arms and opens the panel | K16 |
| 13.26 | SW idle mid-session (A22) | NOT TESTED BY CLAUDE | start a lane, open the panel, then do NOTHING for at least 90 s; then change the volume slider, toggle the mute button and press Stop | captions never pause during the wait; volume and mute take effect; Stop stops the lane (with the SW dead in between, its restart handles the edits) | A22: if the panel or overlay port died with the SW, note it: the design needs a keep-alive or a SW-free settings path |
| 13.27 | Start then Stop within one second | NOT TESTED BY CLAUDE | press Start (tab lane, then also mic lane, then both) and press Stop/Cancel within about 1 s; also press Start on an un-armed tab and Cancel while "waiting for the tab" | no capture indicator remains on the tab, `chrome://extensions` shows no live offscreen engine work, the panel is idle, no Live session was opened, no later "start" appears by itself | F13/K1: note which phase the Stop landed in |
| 13.28 | Mic-caption privacy (A28) | NOT TESTED BY CLAUDE | tick "Show captions on the page" for the MIC lane; in the PAGE's own console (main world) run `document.querySelector('interp-live-captions')?.shadowRoot` and try `document.querySelector('interp-live-captions')?.innerHTML`; open another tab in the background and let it finish loading | the shadow root is `null` and the host element exposes no caption text to the page; the background tab shows NO mic captions; switching to it makes them move there and clear from the previous tab | A28: if the root is reachable, switch to hiding mic captions from pages (keep them in the panel) |
| 13.29 | Sticky controls | NOT TESTED BY CLAUDE | both lanes running, panel height about 700 px | Start/Stop and the mute button are reachable without scrolling; scrolling content never shows through the sticky row | 8.2.2 |
| 13.30 | Overlay with long sentences | NOT TESTED BY CLAUDE | caption size 2.0, browser window about 500 px high, a long sentence | the NEWEST line is fully visible; older lines clip at the top edge | 8.5.2 anchor rule |
| 13.31 | Screen reader and keyboard | NOT TESTED BY CLAUDE | VoiceOver (macOS): trigger the arm note, a key failure, a quota error, then use only the keyboard: Tab through the panel, press Start while the key is missing | the arm note and each error notice are announced (a failure shared by both lanes once); a state change is announced once (by the pill), not a second time by the lane status line (`#tab-status` / `#mic-status` are not live); Start takes focus while it is unavailable and its description (why it cannot start) is read, and pressing it changes nothing; the backup-model warning in `#<lane>-route-note` and the text of `#perm-help` on the permission page are announced when they appear; nothing announces captions (limitation, 8.2.6) | record which notices were silent; if Start is skipped by Tab it has become natively `disabled` again (8.2.6) |
| 13.32 | UI-language split | NOT TESTED BY CLAUDE | Chrome in English, Options -> UI language Korean | panel and options Korean; the chips and status rows drawn on web pages and the toolbar tooltip stay English (documented in `ext.options.uiLanguageHint`) | 8.5.1 |
| 13.33 | Fresh profile, no key | NOT TESTED BY CLAUDE | load the build in a new Chrome profile, open the panel | key notice with an "Enter API key" button; Start unavailable (dimmed, `aria-disabled`, still focusable) and described by the key notice; after entering a key the notice disappears and Start looks normal | — |
| 13.34 | Echo | NOT TESTED BY CLAUDE | both lanes on, speech unmuted, once with headphones and once with speakers | the echo warning is visible while speech is on and the mic lane enabled; RECORD whether the mic lane interprets the tab audio and the interpreted voice a second time through speakers | K9 |
| 13.35 | Tab opened before install | NOT TESTED BY CLAUDE | open a page BEFORE loading the extension, load it, run the mic lane with page captions ticked on that page | the mic card shows "Captions cannot be shown on this page… reload it"; after reloading the page captions appear | 6.7 |
| 13.36 | Captions toggled mid-run | NOT TESTED BY CLAUDE | start with "Show captions on the page" OFF, tick it mid-run, dismiss the bar with x, untick and tick again | the bar appears within about a second of ticking (no navigation or tab switch needed), clears when unticked, and comes back after untick/tick even though it was dismissed | 6.6 |
| 13.37 | Stop then Start at once | NOT TESTED BY CLAUDE | while running press Stop and immediately Start (as when changing the language) | the second Start either runs or shows "the previous run is still stopping" (never silently nothing) | 6.3 step 3 |
| 13.38 | Overlay status rows | NOT TESTED BY CLAUDE | with captions on the page, break the network for a few seconds, then restore; later force an error (wrong key on the other lane is enough to see the pill) | "Reconnecting…" appears on the page during the retries; after a terminal error "Interpretation stopped. Check the panel." shows for about 8 s | 8.5.3 |
| 13.39 | Free-tier privacy text | NOT TESTED BY CLAUDE | read the Privacy section of Options; compare with Google's current terms at the address in 14.5 | the free-tier sentence matches the terms you find; if the terms changed, correct `ext.privacy.freeTier` | 14.5 |
| 13.40 | Overlay on a right-to-left page | NOT TESTED BY CLAUDE | open a page whose `<html>` has `dir="rtl"` (an Arabic or Hebrew site), or in DevTools of any page run `document.documentElement.dir = 'rtl'`; tab captions on; show a Korean or English caption that ends in a punctuation mark and one partial row | the bar looks the same as on a left-to-right page: text left-aligned, the dashed marker of the partial row on the left, the punctuation at the end of the sentence (`direction: ltr` and `unicode-bidi: isolate` are pinned on the host and every row has `dir="auto"`, 8.5.2; the CSS `all` shorthand does not reset `direction`, a spec fact not checked in a browser) | K13: read the computed `direction` of the host in DevTools; `rtl` means the inline pin lost |
| 13.41 | Live caption look | NOT TESTED BY CLAUDE | with a real video playing and captions on the page, change in Options while the overlay is open: options size / position (top) / display (light, mono = "High contrast") / lines / auto-hide applied LIVE to an open overlay, legibility over a bright and a dark video (only 13.30 at size 2.0 exists), and the one-line-caption case (see 13.42) | every change shows on the open overlay without a restart; the text is legible over both videos in every display tone; after the chosen silence the bar clears and the next caption brings it back | RECORD the tone, size and video where it is hard to read; K13, 8.5.2 |
| 13.42 | Top fade over the lane chip and the first row (KNOWN, NOT FIXED) | NOT TESTED BY CLAUDE | caption size 1.5, display dark, then light, then "High contrast"; show ONE short caption row of the tab lane over a white page and over a black page; read the lane chip ("Tab audio") and the top of the row | UNVERIFIED VISUAL, computed from the CSS only (no layout was run): the always-on top fade (`mask-image`, 1.5em = 36 px at size 1.5) covers the lane chip, which always sits at about y 9-21 px, so its opacity is about 0.28-0.53 and its contrast about 1.5-2.9:1 instead of 7.45:1; the top of a one-row caption (y 21-36 px) is dimmed too. If you see it, the chip is barely legible | NOT FIXED in this round (UX review 13). Fix when confirmed: apply the mask only when the content overflows, or pad the top by the fade height, or keep the chip outside the masked box; then update 8.5.2 |
| 13.43 | Korean and Japanese glyphs | NOT TESTED BY CLAUDE | Options -> UI language Korean, then Japanese; set the target language of a lane to ko, then ja; look at the panel and at the caption overlay over a page: Korean and Japanese glyph rendering in the overlay and the panel | every character is drawn (no empty boxes), lines are not clipped at their top or bottom, the overlay text looks like real Korean and Japanese type and not a fallback of mixed fonts | RECORD the operating system and the missing font; the overlay font stack is in 8.5.2 |
| 13.44 | Panel at narrow width and in dark mode | NOT TESTED BY CLAUDE | drag the side panel to 320-400 px width with the UI language Japanese and both lanes on; then switch the operating system or Chrome to dark mode | the panel at 320-400 px width in ja (the sticky row wraps: Start basis 128 + 2 x 44 + "オプション" ~114 + gaps 24 = ~354 px > 288-328 px content width, computed, unrendered): Start, both icon buttons and Options stay reachable, nothing overlaps or is cut off, no horizontal scrollbar; in dark mode every label, note and border is readable | RECORD the width where the row breaks and how it wraps; 8.2.2 |
| 13.45 | Text expansion | NOT TESTED BY CLAUDE | switch the UI language between Korean, English and Japanese (live) with both lanes on, the echo warning visible and one error notice showing; repeat at 150% browser zoom | no text is clipped, overlaps a control or pushes a control out of the panel or the options page; the longest notices wrap instead of scrolling sideways | RECORD the language, the element and the width |
| 13.46 | Voice gender | NOT TESTED BY CLAUDE | Options -> `#opt-voice` = female; unmute; Start; listen; Stop; choose male; Start; listen; also change it WHILE running | the hint says "The voice change applies at the next start. To switch now, stop and start again."; the change takes effect only at the next start; RECORD how the interpreted voice sounds for male and for female (whether each sounds male or female) | if a voice does not change, the mapping is in `app/` and is shared with the web app: note the model |
| 13.47 | Mute icon state cue | NOT TESTED BY CLAUDE | only the tab lane on; look at the mute button in both states (muted, which is the default, and unmuted) without hovering it | the state can be told apart WITHOUT colour and without the hover tooltip: the muted icon (the default) has a slash across the speaker, the unmuted one has none (a second icon path shown only while `data-muted="true"`, CSS only, 8.2.2; the first build drew the same glyph in both states and only its colour and border changed, UX review 3, fixed). Not looked at in a browser: RECORD whether the slash is clearly visible at 24 px in light mode, dark mode and forced colors | if it is hard to see, draw it thicker or move it; if the two states still look alike, the CSS rule for `.icon-slash` did not apply |
| 13.48 | Options number fields | NOT TESTED BY CLAUDE | in Options type out-of-range values into `#opt-caption-lines` (valid 1-6) and `#opt-caption-hide` (valid 0-60): 0, 10, 2.5, 61, -1; reopen Options | the labels state the ranges ("1-6", "0-60"); each out-of-range or fractional value is refused: the field shows the previous stored value again, no "Saved." appears and nothing is stored (also reopen Options to see what is stored); a valid value (1 or 6, 0 or 60) is accepted and confirmed with "Saved.". At review time out-of-range values showed "Saved." and snapped to the DEFAULT (3 lines, 8 s) instead of the previous value (UX review 2, fixed in the options controller). RECORD what each field shows, in particular what the browser's own number input does before the controller sees the value | if a refused value stays in the field or "Saved." shows, the range check of the options controller did not run (7.3) |
| 13.49 | Keyboard-only variant of 13.31 | NOT TESTED BY CLAUDE | fresh profile with no key (as 13.33); use only the keyboard: Tab from the top of the panel through every control, press Enter on "Enter API key"; then save a key and Tab to Start and press Enter | focus reaches "Enter API key" and Enter opens Options; the key notice is read in reading order before the controls; with a key saved, Tab reaches Start and Enter starts. RECORD whether Start itself takes focus while the key is missing: it should, because it is `aria-disabled`, not natively disabled (8.2.6), and its description (the key notice) should be read; pressing Enter or Space on it while the key is missing must do nothing (no message, no notice, no change of the pill) | if Start is skipped by Tab, the attribute is natively `disabled` again; if pressing it starts or announces anything, the guard in the panel's `onPrimary` is missing (UX review 5); if a control cannot be reached with Tab, note it |
| 13.50 | Chrome's site-access line next to the privacy sentence | NOT TESTED BY CLAUDE | `chrome://extensions` -> Details of "Live Interpreter": read "Site access" (the content script matches `http://*/*` and `https://*/*`); then read the Privacy section of Options (`ext.privacy.page`, which says the extension does not read or change the page apart from drawing captions) | Chrome's own "Site access: on all sites" next to `ext.privacy.page`: read it once on the extension's details page and decide whether the two read consistently (the overlay reads only `documentElement`, `fullscreenElement` and `visibilityState`, never page content) | if they read as a contradiction to you, reword `ext.privacy.page` (owner's decision) |
| 13.51 | Failed dictionary load (KNOWN, NOT FIXED) | NOT TESTED BY CLAUDE | not expected in a packaged build (the build copies the dictionary files, section 10); to see it, block the dictionary requests in the panel's DevTools (Network -> block request URL) and reload the panel | seen only with a fake browser: every label, button and option shows the same sentence ("The task could not be completed. Check settings and retry."), `<html lang>` names the chosen language, and there is no visible retry (three silent automatic retries) | NOT FIXED in this round (UX review 14). Fix when it matters: keep the English text as static markup or show one banner and leave labels empty until the dictionary arrives, and add a Retry button |
| 13.52 | Two-way, microphone lane: a real bilingual conversation | NOT TESTED BY CLAUDE | headphones on. Tab audio OFF, Microphone ON; first language Korean, tick "Two-way interpretation", other language English; unmute the interpreted voice; Start; say a Korean sentence, then have a second person say an English sentence, then a very short answer ("yes" / "네"), then a sentence with a name spelled in Latin letters | each utterance comes out in the OTHER language of the pair (Korean -> English, English -> Korean), as captions in the panel preview (and on the page when ticked) and as voice when unmuted; the route line reads "General Live model · gemini-3.8-live"; the direction is chosen per utterance without touching the panel. RECORD: the delay, a wrong direction on short or mixed utterances, whether the model ANSWERS a question instead of interpreting it, the `lang` each row got | K28, A30. If it answers instead of interpreting, note the sentence and the model: the reply detector (5.12) only skips segments after the fact |
| 13.53 | Two-way, tab lane on a two-language video or meeting | NOT TESTED BY CLAUDE | tab lane only; a video or call in which two languages alternate (for example Korean and English); first language = one of them, other language = the second; tick two-way; leave the tab model on its default (the translation-only model); arm, Start | the note "Two-way cannot use the translation-only model, so this lane uses Gemini 3.8 Live." is visible as soon as the box is ticked (before Start) and stays while running; captions come out in the language that is NOT being spoken; the original audio keeps playing at the slider volume without a gap (as 13.5). RECORD whether speech addressed to "you" in the video is answered by the model (the translation-only route cannot reply, 5.12; the instruction-driven route can) | K28. If the tab lane answers, keep the tab lane one-way and use two-way on the microphone lane only |
| 13.54 | Two-way: the model switch in the route line and the "applies next" hint | NOT TESTED BY CLAUDE | tab lane on the default translation-only model, two-way OFF: Start, read the route line, Stop. Tick two-way, Start, read the route line and the line under the language controls. While running untick two-way. Stop. Then set Options -> tab model to Gemini 3.8 Live and tick two-way again | one-way: "Translation-only model (selected) · gemini-3.5-live-translate-preview"; two-way: "General Live model · gemini-3.8-live" with NO "Backup model" label, no backup-model warning and no "applies from the next start" line; unticking mid-run shows that hint and does not restart the session; with the model set to Gemini 3.8 Live the two-way note is gone | if the route line names the translation-only model during a two-way run the engine did not switch: report the model id, the Live setup is the truth (K28) |
| 13.55 | Two-way: echo and feedback with speakers | NOT TESTED BY CLAUDE | Microphone lane, two-way on, interpreted voice UNMUTED. First with headphones, then with the laptop speakers at a moderate volume; say one Korean sentence | with headphones: one interpreted sentence. With speakers RECORD whether the microphone hears the interpreted voice and interprets it BACK into the other language, and again (a ping-pong: with a pair every interpreted output is itself in one of the two languages, so a loop does not die out the way a one-way loop can); the echo warning (`ext.sound.echoWarning`) is visible while speech is on; the mute button ends a loop at once | K28. A later design may pause the microphone while the interpreted voice plays; until then headphones are the advice (13.34) |
| 13.56 | Two-way: caption language attributes | NOT TESTED BY CLAUDE | a two-way lane (pair Korean and English) with "Show captions on the page" ticked; have a Korean row and then an English row appear. In DevTools -> Elements on that page find the lane's `<section class="lane">` in the caption host's shadow root (DevTools showing a closed root is unverified: say so if it does not) and read its `lang`; listen to the panel preview rows with a screen reader | the section's `lang` follows the NEWEST row (`ko` after a Korean row, `en` after an English one); the text is drawn in the right script. KNOWN limitation: a section holds up to `maxLines` rows and has ONE `lang`, so an older row of the other language carries the newest row's language (the frames carry a `lang` per row, `overlay.js` does not read it). RECORD whether a screen reader reads that older row with the wrong voice | 8.5.3; if it matters, set `lang` per row in `overlay.js` (a small change to the closed-root code; the frames already carry it) |
| 13.57 | Two-way: upgrade with stored settings, and the partner select in a real dropdown | NOT TESTED BY CLAUDE | in a Chrome profile that already holds settings saved by the first delivery (a target chosen, the tab volume changed), reload the extension with this build and open the panel: both two-way boxes must be off, the partner rows hidden. Tick two-way on the microphone lane, open the partner dropdown and pick the other language. Then set the FIRST language to the language the partner shows. Then switch the UI language in Options with the panel open | the old choices (targets, volume, captions) are untouched; ticking shows the partner row offering the two languages that are not the first one; a pick is saved; choosing the partner's language as the first language moves the language you left into the partner select (never two equal languages); the partner options re-translate with the UI language; an open dropdown is not closed by unrelated updates (the options are rebuilt only when the choice list changes) | RECORD any dropdown that closes by itself or shows a stale option (unverified in real Chrome, the fake DOM has no native select) |

---------------------------------------------------------------------------------------------------

## 14. Risks, open questions and the assumptions register

Legend: K = risk, A = assumption (something inferred or unverified). "Manual" points at section 13.

### 14.1 Risks (with the fallback if a manual check fails)

| K | Risk | What the design does | Fallback if the check fails |
|---|---|---|---|
| K1 | The per-tab `tabCapture` grant model is read from Chromium main-branch source and was never exercised with a real invocation (the scouts' capture run used the test-only allowlist switch). | Arm through icon/shortcut/menu, `sidePanel.open` first, mint last, `NEEDS_ARM` state (A1); the arm note names the icon, the pin menu and the real shortcut. | (a) one-click alternative: make `action.onClicked` itself start the tab lane in the same handler (mint and send immediately, no panel Start), possibly behind an opt-in setting; (b) `getDisplayMedia` picker as a no-activeTab alternative (untested). |
| K2 | Offscreen `userActivation.isActive` / `document.hidden` are unmeasured. | The platform shim (5.4) overrides both. | If capture still aborts on visibility, host the engine in the side-panel page instead (visible, dies with the panel) with the same `createLanePlatform`. |
| K3 | `AudioContext` autoplay in the offscreen document is unverified (source says extension frames get force-allow); the unmute click happens in another document. | Contexts created in the host; `resumeAudio()` after unmute; `blocked` output text `ext.output.blocked` (it no longer tells the user to press the button they just pressed); captions continue; 13.7 records the outcome. | Forward a user-gesture-bearing resume: play the translated speech from the side panel document (needs PCM over ports: a design change, not v1). |
| K4 | The raw tab track's `ended` is the only tab-gone signal; the synthetic destination fan-out (no `mute` events on the synthetic track) is unverified for tab tracks. | `graph.onEnded` on the raw tracks; `host/tab-removed`. | Use `MediaStream.clone()` for the engine stream (`createEngineStream` swap), or wrap the stream to hide `mute` events. |
| K5 | Timer throttling of a never-composited offscreen document could starve the engine's uplink pump (drops frames older than 256 ms), the player monitor and the capture watchdog. The case that matters is CAPTIONS ONLY (speech muted, original volume 0): no audible output, so the believed exemption for audible pages does not apply. Nothing is measured. | Built in v1 but OFF: the worker-timer seam (`TIMER_MODE`, 5.13); the symptom is visible (`gap: input` line in the panel and the overlay); 13.22 tests the worst case. | Set `TIMER_MODE = 'worker'` (one constant), re-run 13.22; if that fails too (A27), host the engine in the visible side-panel page (dies with the panel). |
| K6 | Chrome may cap concurrent `AudioContext`s per document; the host uses up to 5. | Contexts are closed on stop. | Share one capture context across lanes is not possible (stream-capture owns it); drop the per-lane playback context for the muted lane (`getAudioContext` -> null, allowed by the engine). |
| K7 | Audio-only `getUserMedia` with `chromeMediaSource: 'tab'` is not stated in the docs (the example passes audio and video). | `TAB_CAPTURE_INCLUDE_VIDEO = false` constant with a tested alternative shape (5.6.1). | Flip the constant to `true`; the video tracks are stopped at once. |
| K8 | Whether a `getMediaStreamId` capture survives a cross-origin navigation is unverified. | Both outcomes handled (5.10). | none needed |
| K9 | Two concurrent Live sessions on one key: Google's limit is undocumented here; the "about twice" statement is not measured. | Note text says not measured; `SESSION_LIMIT`/429 codes mapped per lane. | If two sessions are rejected, document "one lane at a time" and disable the second checkbox while one runs. |
| K10 | The default extension-page CSP leaves `connect-src` open. A tightened CSP would be defense in depth but cannot be verified without a browser. | No `content_security_policy` key. | After a manual pass, add to the manifest `"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com" }` (derived from `ENDPOINT_ORIGINS`); if `'self'` does not match the extension origin in `connect-src`, the i18n fetches break: revert. |
| K11 | Microphone prompt/permission for the extension origin: the prompt cannot show in offscreen (official sample); side panel behavior is third-party claim; a one-time grant may expire. | Permission tab (D5); the page tells the user what to AVOID ("Allow this time"), not a label to pick (14.4, change 2); panel watches `PermissionStatus.onchange`; host preflight refuses `prompt`/`denied`. | If the side panel CAN prompt, the permission tab is still correct; if grants expire, re-run the tab from the mic button. |
| K12 | A built-in key restricted to web HTTP referrers may be rejected from a `chrome-extension://` origin; a packaged key is readable by anyone with the folder/zip. | Personal key is the documented path; built-in is opt-in, gitignored, first key only. | Use a personal key. |
| K13 | Overlay: page CSP vs injected styles (a third-party report conflicts with the scouts' measurement, taken with an OPEN root; the CLOSED root is unmeasured), fullscreen strategies 1 and 2 are untested, the close button is last in the tab order, orphaned scripts after an extension reload. | Constructable sheet -> `<style>` fallback; strategy 1 re-parents only under plain containers and always restores, strategy 2 uses the top-layer `popover`; orphan guard; `scripting` fallback for armed tabs. | If styles fail on strict pages, add a `web_accessible_resources` stylesheet + `<link>` (10.4 would change); if neither fullscreen strategy shows the bar, use the panel preview. |
| K14 | The unpacked extension id derives from the folder path; moving the folder changes the id and drops `storage.local` (the key). | Manual 13.2 warns; no `key` field (that needs a keypair; no `.pem` ever). | Re-enter the key. |
| K15 | `storage.local.setAccessLevel` persistence across restarts is not stated. | Re-applied at every SW start and on install (6.1). | Keep the key in `storage.session` (asks for the key each browser start). |
| K16 | `Alt+Shift+Y` may conflict; Chrome then leaves it unassigned. | Suggested key only. | Rebind at `chrome://extensions/shortcuts`. |
| K17 | `minimum_chrome_version` enforcement for unpacked loads and the real side-panel width are unstated. | Feature use is limited to APIs present in 116; layout works from 320 px. | — |
| K18 | `connect-src` fallback for the default CSP is from MDN's rule, not Chrome's page. | Only used to justify "no host permission". | If the WebSocket is blocked by CSP, add the CSP of K10 with `connect-src` explicitly. |
| K19 | `runtime.sendMessage` fan-out delivers `host/lane-start` (with the key) to every extension page. | Trusted pages only; routers ignore non-target messages before reading fields; never content scripts (4.2). | Deliver the key through a port opened by the SW to the host if fan-out ever reaches an untrusted context. |
| K20 | Real stream-id TTL is unknown ("a few seconds"). | Mint last; the fake uses 5 s (A20). | none |
| K21 | Pre-existing web-app defect: two-way `languages` was dropped by `providers/router.js`. | FIXED in `540c7fc` (the router checks the pair's shape and forwards a copy; the adapter validates the values). The extension's two-way mode depends on it (D10 reversed, 14.4 change 3). | If the router ever drops the pair again a two-way lane would silently run one-way: `tests/extension-integration.test.mjs` reads the Live setup message, which would then lack the two-way instruction, so it fails. |
| K22 | A panel that is merely hidden (another side-panel entry) may or may not keep its port `[A21]`; `sidePanel.onClosed` also fires for "replaced". | Only port disconnect stops lanes, after a 3 s grace; the stop reason is recorded and shown on reopening; the UI says closing the panel stops interpretation. | If hiding drops the port, keep the notice, or move port ownership so a hidden panel does not stop the lanes (a design change, not v1). |
| K23 | The real gesture window of `sidePanel.open` is unspecified. | `open` is the first statement; the fake is stricter than Chrome. | — |
| K24 | `runtime.getContexts({documentUrls})` semantics are assumed from the docs. | Used only to find an existing offscreen document; a failure falls through to `createDocument` whose "single document" error is tolerated. | — |
| K25 | A SW restart loses the in-memory cancel flags and the lifecycle mutex. | Rebuilt empty; the host has its own per-run cancel token (5.6) and the SW re-sends a stop after a start answers; a Stop after a restart still forwards to the host. | none needed |
| K26 | Mic captions follow TAB events (activation, loading), not window focus: switching windows without switching tabs does not move them. | Documented v1 limitation; the panel preview always shows them. | Register `windows.onFocusChanged` as a tenth SW listener. |
| K27 | A start can be refused after the mint (host busy, key rejected): the minted id stays pending for its lifetime and blocks a re-mint ("Cannot capture a tab with an active stream."). | The SW waits out a `stopping` lane BEFORE the mint; the mint error recovery of 6.4 handles the rest (fresh ping, retry, close-recreate, `TAB_CAPTURE_BUSY`). | none needed |
| K28 | Two-way quality and safety are unmeasured: the instruction-driven model chooses the direction per utterance from the language it hears, may ANSWER instead of interpreting (a two-way tab lane loses the translation route's "cannot reply" property, 5.12), may mis-detect short or mixed-language utterances, and with the microphone and speakers its own output can come back as input and be interpreted again. | Two-way is opt-in per lane and off by default; the panel says which model a two-way lane uses (`ext.twoWay.modelNote`) and the route line names the model in use; the sim engine's reply detector is pair-aware; the echo warning and the global mute stay; captions label rows by script (A30). | 13.52-13.55. If the tab lane answers, keep the tab lane one-way; if the loop happens, headphones only (13.34), or add a microphone pause while the voice plays. |

### 14.2 Assumptions register (every inferred or unverified fact used above)

| A | Assumption | Basis | Verify by |
|---|---|---|---|
| A1 | Chrome 154 grants `kTabCaptureForTab` exactly as the Chromium main-branch source read by the scouts does (action click without popup/side-panel toggle, shortcut, menu; per tab; cleared on cross-origin navigation and tab close). | source reading; observed only with the allowlist switch | 13.4, 13.5 |
| A2 | An offscreen document reports `userActivation.isActive === false` and may report `visibilityState === 'hidden'`. | inference (never composited, cannot be focused) | 13.21 |
| A3 | `AudioContext` runs without user activation in extension frames (force-allow autoplay flag). | source reading | 13.5, 13.7, 13.21 |
| A4 | The raw tab track fires `ended` when the tab closes or capture is revoked, and the synthetic destination track never does. | docs + Web Audio semantics | 13.18 |
| A5 | Five `AudioContext`s in one document are allowed. | none | 13.5 with both lanes |
| A6 | Audio-only `getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',…}}})` works. | docs show audio+video; widespread practice | 13.5 |
| A7 | A capture started by `getMediaStreamId` either survives or ends on cross-origin navigation; both are handled. | docs for `capture()` only | 13.19 |
| A8 | Default models: tab = translation-only preview, mic = `gemini-3.8-live`. | reasoning from routes; not measured with real audio | 13.5, 13.9 |
| A9 | Google's concurrent-session limit surfaces as `SESSION_LIMIT` (structured `ConcurrentSessions`) or a 429-family code. | repo `errors.js` | 13.11 |
| A10 | `setAccessLevel('TRUSTED_CONTEXTS')` may not persist across restarts, so it is re-applied. | docs silent | 13.23 |
| A11 | `Alt+Shift+Y` is free. | none | 13.25 |
| A12 | A built-in key restricted to referrers may fail from `chrome-extension://`. | third-party report | 13.24 |
| A13 | The side panel is at least ~320 px wide. | none | 13.4 |
| A14 | The side panel and offscreen cannot show a microphone prompt; "Allow this time" may expire for an extension origin; the SAME three choices ("Allow while visiting the site", "Allow this time", "Never allow", as listed by Chrome's help for web pages) may or may not appear for an extension page. | official sample (offscreen) + third-party (panel) + Chrome help (labels for web pages) | 13.8 |
| A15 | Constructable stylesheets and `<style>` inside a shadow root apply under a strict page CSP, ALSO for a closed root. | scouts' measurement (open root only) vs one contrary report; closed mode reasoned, not measured | 13.13 |
| A16 | The overlay close button is acceptable at the end of the page's tab order. | design judgment | 13.12 |
| A17 | Strategy 1: re-parenting under a plain (non-media, no shadow root) fullscreen container keeps the overlay visible. | MDN top-layer facts, untested | 13.14 |
| A18 | The default extension CSP does not restrict `connect-src`. | MDN fallback rule | 13.5 |
| A19 | `minimum_chrome_version` is not enforced for unpacked loads. | docs silent | — |
| A20 | Stream-id TTL is about 5 s (the fake's stand-in). | docs: "a few seconds" | — |
| A21 | A side-panel document that is merely hidden by another side-panel entry KEEPS its `runtime.connect` port (so its lanes keep running). UNRESOLVED: cached-view source reading vs a third-party report that the port disconnects. The design works either way (3 s grace stop + `lastStop` notice). | contradicting sources | 13.17 |
| A22 | An already-open panel or overlay port to the offscreen document survives the SW idle stop (about 30 s), and the SW restarts on the next storage or message event. | overlay scout: open question (a SW restart was observed after a content script connected and sent a message, so ports may wake it) | 13.26 |
| A23 | `MessageSender.url` may be absent or unexpected for a message sent from an MV3 service worker. Chrome's runtime reference (fetched 2026-09-29, https://developer.chrome.com/docs/extensions/reference/api/runtime) describes `url` as "the URL of the page or frame", says `frameId` "will only be set when `tab` is set" and `documentId` is "a UUID of the document", and says nothing about service workers or offscreen documents. So `senderRole` (4.4) does not REQUIRE `url` for the SW role. | docs silent | 13.5 (a first Start must not fail with FORBIDDEN) |
| A24 | When listeners exist but none responds, `runtime.sendMessage` rejects with "The message port closed before a response was received." in real Chrome (secondary sources only; Chrome's docs are silent; the scouts saw only fan-out delivery). The protocol tolerates rejection, `undefined` and malformed responses alike. | secondary sources | 13.5 |
| A25 | After `setAccessLevel('TRUSTED_CONTEXTS')` a content context either has no `chrome.storage` or has one whose calls reject. | docs silent | 13.3, 13.23 |
| A26 | Strategy 2: a `popover="manual"` element shown with `showPopover()` (re-issued on each `fullscreenchange`) is stacked above a fullscreen element, including a bare `<video>`. | MDN top-layer facts, untested | 13.14 |
| A27 | A dedicated worker's timers are not throttled like the hidden offscreen document's page timers. | common practice, no measurement | 13.22 |
| A28 | A closed shadow root created by a content script is unreachable from the page's main world (`host.shadowRoot` is `null`, the closure variable lives in the isolated world), so the page cannot read the captions. | Chrome's isolated-world model, reasoned not measured | 13.28 |
| A29 | `chrome.commands.getAll()` can be called from the side-panel page (the reference example calls it from a service worker; extension pages normally reach the same APIs) and returns an empty `shortcut` for an unassigned command. | reference silent on other contexts | 13.25 |
| A30 | Two-way: the instruction-driven model renders each utterance into the OTHER language of the pair and decides the direction itself; the language of a caption row is therefore GUESSED from its script (Hangul -> `ko`, kana -> `ja`, Han alone -> `ja`, Latin -> `en`; a guess outside the pair, or a row with no letter, takes the lane's own language). | the two-way instruction text of the web app's Live setup (`app/providers/gemini/live-config.js`) and the engine's per-run pair handling; the script guess is this design's own; no real model output was observed | 13.52, 13.53, 13.56 |

### 14.3 Open questions carried from research

Exact stream-id TTL; whether `MediaStream.clone()` works on tab tracks; whether crbug 40926394 is Won't Fix (second-hand); whether side panel and SW/offscreen share a render process (irrelevant: only the SW mints);
`chrome://extensions` "Inspect views" behavior for offscreen documents in branded Chrome; whether `runtime.getContexts` returns the offscreen document promptly after `createDocument` resolves.
The next real-browser session (owner) settles A1-A7 in one sitting: 13.4, 13.5, 13.19, 13.21; the review-driven unknowns A21-A29 need 13.5, 13.8, 13.14, 13.17, 13.22, 13.25, 13.26, 13.28.

### 14.4 Proposed changes to decisions D1-D14 (for the orchestrator; NOT applied silently)

No review proved a decision unworkable. Two reviews proved parts of the wording of D5 and D6 wrong or unsafe; this document applies the smallest change to each and lists it here so the owner or orchestrator can overrule it. A third change is not a review finding but the owner's own reversal of half of D10 (after the first delivery).

| # | Decision | What D says | Smallest change applied | Evidence | To revert |
|---|---|---|---|---|---|
| 1 | D6 (overlay) | "open Shadow DOM host with all:initial" | `attachShadow({ mode: 'closed' })`, the root kept in the content script's closure; everything else in D6 unchanged (static top-frame IIFE, `all:initial`, closed-over port, `pointer-events:none`, textContent, fullscreen). | With an open root any page script (ads, analytics, extensions of the page) can read `host.shadowRoot` and the caption text, which for the mic lane is the user's own translated speech. The scouts exercised `open` only for CSS behavior; nothing in the evidence requires it. Closed mode is unmeasured for CSS (A15) and for reachability (A28); checklist 13.13 and 13.28. | change one word in 8.5.2 and the `mode:'closed'` assertions of `extension-overlay` / `extension-static`; then mic captions should be dropped from pages (kept in the panel) |
| 2 | D5 (mic permission page) | "UI tells the user to choose 'Allow on every visit'" | The page and copy tell the user what to AVOID ("do not choose Allow this time; choose the option that keeps the microphone allowed"); no Chrome label is quoted as the thing to pick. The permission page, the SW `tabs.create` flow and the panel's `PermissionStatus` watch are unchanged. | Chrome's help lists the choices as "Allow while visiting the site / Allow this time / Never allow" (https://support.google.com/chrome/answer/2693767, fetched 2026-09-29); "Allow on every visit" is not among them. A one-time choice expires and then failed with a generic denial. | none needed |
| 3 | D10 ("no two-way") | "ko/en/ja, 해요체; no two-way" | The "no two-way" half is REVERSED: two-way is offered per lane, off by default (`twoWay`, `partnerLanguage`, 7.1; `request.languages`, 4.2.1; the panel controls, 8.2.1). The ko/en/ja and 해요체 half is unchanged. | The owner's request of 2026-09-29 ("양방향 모드 넣어"). The defect that had made two-way impossible, K21, was fixed first in `540c7fc`. | Remove the two-way rows from the panel markup and their bindings from the controller: `laneRequestOf` adds a pair only when `twoWay` is true, so with no checkbox no pair is ever sent (a stored `twoWay: true` would still send one: also make `laneRequestOf` ignore it). The five `ext.twoWay.*` keys and the settings fields are then unused. |

Clarifications that are NOT changes: D6 says the overlay is "appended to document.fullscreenElement when fullscreen"; that stays the first strategy, but it now applies only to plain containers and always restores (an element that cannot render light-DOM children gets the top-layer `popover` strategy instead, 8.5.3). D7 says "SW is stateless (state in storage.session)". v1 keeps two in-memory items in the SW (the map of in-flight starts with cancel flags and the lifecycle mutex); both are rebuilt empty after a restart and the design is correct without them (K25). D4 says "real timers": the default is exactly that; the worker-timer seam is built but OFF (5.13). D2 is unchanged: the optional "start when the icon is clicked" behavior suggested by a reviewer is NOT built (it stays the K1 fallback (a)).

### 14.5 Sources fetched for this revision (2026-09-29)

- Gemini API Additional Terms of Service, https://ai.google.dev/gemini-api/terms: for "Unpaid Services" Google uses submitted content to improve and develop its products and machine-learning technologies, human reviewers may read and annotate inputs and outputs, and the page warns not to submit sensitive, confidential or personal information; for "Paid Services" it does not use prompts or responses to improve its products. Basis of `ext.privacy.freeTier`. The owner stays on the free tier (D12); confirm the exact terms before shipping (13.39).
- Chrome Help, site permission prompts, https://support.google.com/chrome/answer/2693767 (desktop, English): the prompt offers "Allow while visiting the site", "Allow this time" and "Never allow". Basis of the D5 change.
- Chrome extensions reference, runtime, https://developer.chrome.com/docs/extensions/reference/api/runtime: `MessageSender` property descriptions (A23).
- Chrome extensions reference, commands and tabs (https://developer.chrome.com/docs/extensions/reference/api/commands, https://developer.chrome.com/docs/extensions/reference/api/tabs): no permission for `commands.getAll` or for the `active`/`lastFocusedWindow` filters (10.4, A29).
- Not re-fetched by the architect (kept as `[verified-doc]` from the scouts' earlier reading): every Chromium source and Chrome-doc statement carried over from Revision 1.

---------------------------------------------------------------------------------------------------

## 15. Task breakdown: four implementation groups with disjoint file ownership (historical: delivered)

Historical: delivered. All four groups landed on 2026-09-29 (commits `2f6901a`, `43febec`, `7773fbc`; see the Status block at the top). This section is kept as it was written, because it records who owned which file, the interfaces between the groups and the command that proved each delivery; the numbers quoted in it (1011 tests, `files=<n>`) are design-time numbers, the delivered ones are in the Status block and in 11.1. The docs polish of 15.3 item 7 is done (see there).

### 15.0 Rules for every group

- Touch ONLY the files your group owns (below). Never reformat or "fix" another group's file; if you need a change in a file you do not own, write it in your report. Do NOT run `git add/commit/checkout/stash/reset/clean`
  (several engineers share one working tree; the orchestrator commits). Never `git push`, never publish, never delete a pre-existing file. Pre-existing untracked files (`docs/build/*.last.md`, `docs/build/tasks/*`, `.claude/`) are not yours.
- Style (match surrounding code): English comments and identifiers; a header comment on each file stating its design reference, `// New implementation of docs/extension.md §N; no legacy code is ported.` (do NOT port any code from the
  third-party "Interpretab" extension in the screenshot); comments explain WHY, not narration; dependency injection for every environment object; factories return `Object.freeze({...})`; exported lists are frozen; no import-time side effects
  outside the R10 entry files; the local `const attempt = (fn) => { try { return fn(); } catch { return undefined; } };` helper for best-effort observer calls; machine codes never raw messages; no logging of any kind; `textContent` and i18n
  keys only; no `innerHTML`; no key-shaped literals.
- Never put an API key in a file; never log one; runtime-assembled fake keys only in tests.
- Report honestly: say a test passed only after running it and seeing the output. Everything Chrome-specific that needs a real browser stays in section 13 (NOT TESTED BY CLAUDE).
- Silent regime: no browser, no `afplay`/`say`, no real `AudioContext`/`getUserMedia`/`tabCapture`, no `--use-fake-device-for-media-stream`.
- Syntax checks: `node --check` accepts ONE file (any further arguments are silently treated as script arguments and never parsed: verified with Node v24.18.0, `node --check ok.mjs bad.mjs` exits 0). Always use the loop form
  `for f in <files>; do node --check "$f" || exit 1; done`.
- A test file is either a FIXTURE test (passes when its owner and dependencies have landed) or a REAL-TREE test (M3 only); 11 says which, and the acceptance lists below follow it.

### 15.1 Cross-group interfaces (the contracts each group codes against)

| # | Interface | Provider -> consumers | Defined in | Exact names |
|---|---|---|---|---|
| I1 | Chrome adapter | C (`lib/chrome-adapter.js`) -> B (`host.js` gets `adapter.runtime` only), C, and D's fake-chrome must satisfy it | 3.4 | `ADAPTER_SURFACE` (nested, mirrors the adapter), `createChromeAdapter(chromeApi)` |
| I2 | Protocol and constants | B (`lib/constants.js`, `lib/protocol.js`) -> C (SW, panel, options, permission, host-link), D (overlay duplicates constants in `WIRE`; parity is asserted in A's `extension-tree`, not by D importing B), A (tests) | 3.5, 4 | `VOICE_GENDERS`, `TARGET_LANGUAGES`, `CAPTION_SIZE`, `STYLE_LIMITS`, `normalizeStyle`, `isValidStyle`; `PROTOCOL_VERSION`, `PORT_NAMES`, `LANES`, `TARGETS`, `STORAGE_KEYS`, `PATHS`, `LIMITS`, `makeMessage(type, payload)`, `validateMessage(message)`, `senderRole(sender, runtime)`, `createMessageRouter({runtime, target, handlers})`, catalog table |
| I3 | Settings module | B (`lib/settings.js`) -> C (SW, panel, options), A (tests) | 7.2 | `DEFAULT_SETTINGS`, `CAPTION_SIZE`, `createDefaultSettings`, `normalizeSettings`, `migrateSettings`, `hostSettingsOf`, `laneRequestOf`, `readSettings`, `writeSettings`, `updateSettings`, `readKey`, `writeKey`, `deleteKey`, `hasKey`, `resolveKey` |
| I4 | UI-state and caption frames | B (`lib/ui-state.js`, `lib/caption-frames.js`) -> C (`panel/view-model.js`, `panel/host-link.js`), A (`extension-tree`) | 4.6, 4.7 | `LANE_PHASES`, `QUOTA_CODES`, `KEY_FAILURE_CODES`, `EXTENSION_ERROR_CODES`, `OVERRIDDEN_ENGINE_CODES`, `TAB_CAPTURE_CODES`, `errorKeyFor(code, has, lane)`, `laneStateFromSnapshot`, `buildUiState`, `buildCaptionFrame`, `createFrameCoalescer` |
| I5 | Test fixtures | D (`tests/fixtures/fake-chrome.mjs`, `fake-audio.mjs`, `extension-dom.mjs`) -> B, C tests | 11.2, 11.3 | `createFakeBrowser` (options `noResponder`, `swSenderHasUrl`, `contentStorage`, `shortcut`), `GRANT_ERROR`, `ACTIVE_STREAM_ERROR`, `STREAM_ID_TTL_MS`, `createFakeAudioEnv`, `parseHtml`, `FakeElement`, `runClassicScript` |
| I6 | Page ids | D (`*.html`) <-> C (controllers) | 1.5, 7.3, 8.2.1, 8.3, 8.4 | element ids and `data-i18n*` attributes; live-region rule of 8.2.1; parity asserted by `extension-html` and each controller test |
| I7 | Dictionaries | D (`extension/i18n/*.json`) -> C (loader), A (tests) | 9.2 | 117 `ext.*` keys at first delivery, 122 with the two-way keys (the tables of 9.2 are machine-generated from the dictionaries: regenerate them, never edit them by hand) |
| I8 | Overlay wire | D (`overlay/overlay.js`) <-> C (SW sends `content/overlay-attach`) <-> B (`overlay-hub.js`, frames) | 4.2, 4.5, 4.6.3, 8.5 | port `interp-overlay/1`, frames `hello`, `style`, `captions`, `clear`, `status`, `bye`, message `content/overlay-attach`, the `WIRE` literal |
| I9 | Build inputs | A (`build-extension.mjs`) consumes every group's files | 3.1, 10 | file paths of 3.1; slot string of `extension/lib/builtin-key.js` |
| I10 | Manifest and `_locales` | A -> C (SW uses `getMessage('menuOpen')`), D (overlay `getMessage` names, 7 of the 12) | 9.3, 10.4 | message names of 9.3, `PATHS` values |
| I11 | Checker patch | A (`scripts/check-i18n.mjs`) -> D and everyone (source and HTML literals are validated) | 12.1 | `checkSource`/`validateDictionaries` options |
| I12 | Engine modules | existing `app/` -> B | 5.5 | `createAppConfig({isolated:true,...})`, `createSimEngine`, `createPlatform`, `liveVoicePreference`, `LIVE_MODELS`, `LIVE_VOICE_GENDERS` |
| I13 | Engine clock | B (`engine/worker-timers.js`, `TIMER_MODE`) -> B (`host.js`, lane engine, platform shim) | 5.13 | `createWorkerTimers`, `TIMER_MODE` |

### 15.2 Order, milestones and the real dependency graph

Review finding: the first draft said group A depends on nothing but gave acceptance checks (real-manifest lint, real-repo build, full suite) that need the other groups' files, and D depended on B (through an overlay test that pinned constants against `protocol.js`) while B depended on D (fixtures): a hidden cycle. The tests were split into fixture tests and real-tree tests (11), and the overlay/protocol parity moved to A's `extension-tree.test.mjs`. The graph is now acyclic:

```
A (M0)  ->  D (fixtures, dictionaries, HTML: M1)  ->  B (M2)  ->  C (M2)      D (overlay, CSS: M2, no B/C dependency)
                                                                    \____________ all four ____________/  ->  M3
```

- M0 (group A, first hour): apply the check-i18n patch (12.1), `.gitignore`, `package.json` script, `extension/lib/builtin-key.js`, `extension/manifest.json`, `_locales` (unblocks D's dictionary validation and gives everyone the final paths); A's FIXTURE tests can pass now.
- M1 (group D): `tests/fixtures/fake-chrome.mjs`, `fake-audio.mjs`, `extension-dom.mjs` and `extension/i18n/*.json`, HTML skeletons (unblocks B and C tests and C's controllers).
- M1 (group B, parallel with D's fixtures for the SOURCE files): `lib/constants.js`, `lib/protocol.js`, `lib/settings.js`, `lib/ui-state.js`, `lib/caption-frames.js` (unblocks C's source); B's tests need D's fixtures.
- M2: B engine modules (incl. `worker-timers.js`); C background/pages/controllers; D overlay and CSS (needs nothing from B or C); A build script.
- M3 (integration gate, run by the orchestrator after all four land): the commands of 15.7, including the REAL-TREE test files `extension-static`, `extension-tree`, `extension-integration`.

### 15.3 GROUP A: core tests, repo gates, build script, manifest, `_locales`, docs polish

Owned files (exactly):
`extension/manifest.json`, `extension/_locales/en/messages.json`, `extension/_locales/ko/messages.json`, `extension/_locales/ja/messages.json`, `extension/lib/builtin-key.js`,
`scripts/build-extension.mjs`, `scripts/check-i18n.mjs` (apply the patch), `scripts/stage-release.mjs` (optional one-word export), `.gitignore` (one line), `package.json` (one script),
`docs/extension.md` (polish only, after the others land),
`tests/session-isolated.test.mjs`, `tests/extension-i18n.test.mjs`, `tests/extension-manifest.test.mjs`, `tests/extension-build.test.mjs` (FIXTURE tests),
`tests/extension-static.test.mjs`, `tests/extension-tree.test.mjs` (REAL-TREE tests, M3 only).

Depends on: nothing (`dependsOn: []`). At A's own delivery only the FIXTURE tests can and must pass; every assertion that needs the real `extension/` tree lives in the two REAL-TREE files, which are run at M3.

Acceptance checks:
1. Save the diff of 12.1 to a scratch file; `git apply --check <that file>` succeeds, then after applying: `node scripts/check-i18n.mjs` prints one line `I18N_OK languages=3 keys=810 files=<n>` (n grows when `extension/` files exist) and `node --test tests/i18n.test.mjs` passes.
2. At A's delivery: `node --test tests/session-isolated.test.mjs tests/extension-i18n.test.mjs tests/extension-manifest.test.mjs tests/extension-build.test.mjs` pass (fixture roots, embedded fixtures, A's own `_locales`; independent of B/C/D).
3. `node --check scripts/build-extension.mjs` (a single file: the plain form is correct here).
4. M3 ONLY: `node --test tests/extension-static.test.mjs tests/extension-tree.test.mjs` pass (real manifest lint, real-repo build integration, real-tree i18n and static scans, WIRE parity).
5. M3 ONLY: `node scripts/build-extension.mjs` prints `EXTENSION_BUILT out=… files=… version=0.1.0`; a SECOND run of the same command and `npm run build:extension` print it too (no `--clean` needed, 10.1); `git status --short` afterwards shows no new tracked or untracked file outside the section 3.1 / 12 lists (`dist/` is ignored).
6. M3 ONLY: `node --test tests/*.test.mjs` passes in full (baseline before any new file: 1011 tests, 1011 pass).
7. Docs polish (last): reconcile `docs/extension.md` with the delivered code (names, ids, key counts); `node --test tests/privacy.test.mjs` still passes (the doc is scanned for key-shaped strings). DONE on 2026-09-29: the file list of 3.1, the exports named in 3.4-9.5, the message catalog of 4.2, the element ids of 1.5 and the skeleton of 8.2.1, the tables of 9.2 (0 differing cells), the manifest and `_locales` of 10.4 and 9.3 (JSON equal), the build API, codes and steps of 10, the test list of 11.1 and the patch of 12.1 were compared with the code by script; the differences are listed in the Status block. `node --test tests/privacy.test.mjs tests/extension-tree.test.mjs tests/extension-static.test.mjs` passes after the edit (81 tests).

### 15.4 GROUP B: offscreen engine host, lanes, platform shim, tab audio graph, protocol/settings/state modules

Owned files (exactly):
`extension/lib/constants.js`, `extension/lib/protocol.js`, `extension/lib/settings.js`, `extension/lib/ui-state.js`, `extension/lib/caption-frames.js`,
`extension/engine/host.html`, `extension/engine/host.js`, `extension/engine/lane-host.js`, `extension/engine/lane-engine.js`, `extension/engine/tab-lane.js`, `extension/engine/mic-lane.js`,
`extension/engine/audio-graph.js`, `extension/engine/platform-shim.js`, `extension/engine/overlay-hub.js`, `extension/engine/panel-hub.js`, `extension/engine/worker-timers.js`, `extension/engine/timer-worker.js`,
`tests/extension-protocol.test.mjs`, `tests/extension-settings.test.mjs`, `tests/extension-ui-state.test.mjs`, `tests/extension-audio-graph.test.mjs`, `tests/extension-timers.test.mjs`, `tests/extension-lanes.test.mjs`, `tests/extension-host.test.mjs`,
optional shared helper `tests/fixtures/extension-lanes.mjs` (B-owned new fixture for building a host over fakes; the D13 no-sound scan of 11.4 covers it).

Depends on: D for the test fixtures only (M1: `fake-chrome.mjs`, `fake-audio.mjs`); the source files depend on nothing but existing `app/` modules (`dependsOn: ["D"]`, fixtures only).

Constraints: no `chrome` identifier (R8), imports only per R4/R5 (`protocol.js` imports only `constants.js`), DI everywhere, no import-time side effects except `engine/host.js` and `engine/timer-worker.js`; the `host.html` skeleton has exactly one `<script type="module" src="./host.js"></script>`, an empty `<title></title>`, no other markup; the six-member `runtime` rule of 3.4 (nothing else is assumed to exist in the offscreen document); cancellation rules of 5.6 (every await followed by a `run.cancelled` check).

Acceptance checks:
1. `node --test tests/extension-protocol.test.mjs tests/extension-settings.test.mjs tests/extension-ui-state.test.mjs tests/extension-audio-graph.test.mjs tests/extension-timers.test.mjs tests/extension-lanes.test.mjs tests/extension-host.test.mjs` pass.
2. Syntax, loop form: `for f in extension/lib/constants.js extension/lib/protocol.js extension/lib/settings.js extension/lib/ui-state.js extension/lib/caption-frames.js extension/engine/*.js; do node --check "$f" || exit 1; done`.
3. M3: `node --test tests/extension-static.test.mjs` passes for the owned files (R1-R11) and `node scripts/check-i18n.mjs` reports no issue for the owned files (they contain no UI literals).
4. The host never references the key outside `host/lane-start` handling and the lane engine's `setPersonal` call (review + the integration delivery scan of C).
5. Report: the measured values of the two lane tests' concurrency (both `running`, retries 0), the cancellation tests that ran (stop during `getUserMedia`, the resume wait, the permission query), and the list of any deviation from sections 4-5.

### 15.5 GROUP C: service worker, page controllers, chrome adapter, message bus usage, i18n loader

Owned files (exactly):
`extension/lib/chrome-adapter.js`, `extension/lib/i18n.js`, `extension/lib/dom-i18n.js`, `extension/lib/links.js`,
`extension/background/service-worker.js`, `extension/background/sw-core.js`, `extension/background/arming.js`,
`extension/panel/panel.js`, `extension/panel/controller.js`, `extension/panel/view-model.js`, `extension/panel/host-link.js`,
`extension/options/options.js`, `extension/options/controller.js`,
`extension/permission/mic-permission.js`, `extension/permission/controller.js`,
`tests/extension-chrome-adapter.test.mjs`, `tests/extension-i18n-loader.test.mjs`, `tests/extension-arming.test.mjs`, `tests/extension-sw.test.mjs`, `tests/extension-panel.test.mjs`, `tests/extension-options.test.mjs`,
`tests/extension-permission.test.mjs`, `tests/extension-integration.test.mjs`.

Depends on: B (protocol, constants, settings, ui-state, caption-frames: source imports) and D (fixtures, HTML ids and the ext dictionaries) (`dependsOn: ["B", "D"]`).

Constraints: `chrome` appears only in `lib/chrome-adapter.js` (R8); the SW imports only `lib/**` and `background/**` (R2); the SW registers exactly the NINE listeners of 6.1 and NO `runtime.onConnect`; all page controllers take `document`,
`adapter`, `i18n` and timers by injection; `links.js` duplicates the two documentation URLs (the parity test lives in `tests/extension-options.test.mjs`); UI text only via i18n keys and `textContent`;
never render or log the key; the panel never sends `host/lane-start` or `host/lane-stop`; every response is read through `sendToHost`/`sendToSw` with `res?.ok === true` (6.3); the live-region rule of 8.2.1.

Acceptance checks:
1. `node --test tests/extension-chrome-adapter.test.mjs tests/extension-i18n-loader.test.mjs tests/extension-arming.test.mjs tests/extension-sw.test.mjs tests/extension-panel.test.mjs tests/extension-options.test.mjs tests/extension-permission.test.mjs` pass.
2. M3: `node --test tests/extension-integration.test.mjs` passes (needs B and D): includes the key/stream-id delivery scan, Start-then-Stop within one fake second, the mid-run captions toggle, the panel-close grace with `lastStop`, the tab-close case and the SW kill.
3. Syntax, loop form: `for f in extension/lib/chrome-adapter.js extension/lib/i18n.js extension/lib/dom-i18n.js extension/lib/links.js extension/background/*.js extension/panel/panel.js extension/panel/controller.js extension/panel/view-model.js extension/panel/host-link.js extension/options/*.js extension/permission/*.js; do node --check "$f" || exit 1; done`.
4. M3: `node --test tests/extension-static.test.mjs tests/extension-tree.test.mjs` pass for the owned files; `node scripts/check-i18n.mjs` reports no issue (every literal `ext.*` key used exists).
5. Report: the call log proving `sidePanel.open` is first in `onActionClicked` and the mint is last in `startLane`, and the log of the three cancellation cases (during `ensureOffscreen`, during the mint, between mint and send).

### 15.6 GROUP D: overlay, page HTML/CSS, ext dictionaries, fake-chrome and fake-DOM fixtures

Owned files (exactly):
`extension/overlay/overlay.js`, `extension/panel/panel.html`, `extension/panel/panel.css`, `extension/options/options.html`, `extension/permission/mic-permission.html`, `extension/pages.css`,
`extension/i18n/en.json`, `extension/i18n/ko.json`, `extension/i18n/ja.json`,
`tests/fixtures/fake-chrome.mjs`, `tests/fixtures/fake-audio.mjs`, `tests/fixtures/extension-dom.mjs`,
`tests/extension-fixtures.test.mjs`, `tests/extension-overlay.test.mjs`, `tests/extension-html.test.mjs`.

Depends on: A for the check-i18n patch and the `_locales` files (M0), needed only to run `node scripts/check-i18n.mjs` on the dictionaries and HTML (`dependsOn: ["A"]`); fixtures have no dependency and must land FIRST (M1) because B and C build on them. D does NOT depend on B: `extension-overlay` pins `WIRE` against literals in the test, and the match with `protocol.js` is A's M3 test.

Constraints: the dictionaries are copied from 9.2 exactly (the wording is machine-validated); HTML follows 8.2.1/8.3/8.4 and R12 with the four binder attributes only and the live-region rule (no `hidden`, no static text on the persistent regions); CSS uses only tokens or hex values present in `styles.css`, no `url()`/`@import`/`@font-face`, and every selector of the attribute table of 8.2.2;
`overlay.js` starts with an IIFE containing `'use strict'`, has no imports (`node --check` parses it as strict module code and `vm.Script` as a classic script: keep it valid for both), touches only the page properties listed in 8.5.1,
uses `textContent` and CSS-drawn glyphs only, creates a CLOSED shadow root, wraps every handler in `try`/`catch`, sets `chrome` access behind `chrome.runtime?.id` checks, and keeps its wire constants in the single `WIRE` literal.

Acceptance checks:
1. `node --test tests/extension-fixtures.test.mjs tests/extension-overlay.test.mjs tests/extension-html.test.mjs` pass (no dependency on B or C).
2. `node scripts/check-i18n.mjs` (after A's patch) prints `I18N_OK …` with the extension files counted, and `node --test tests/extension-i18n.test.mjs` passes.
3. Syntax, loop form (the plain `node --check a b c d` only parses the FIRST file, so the earlier draft's gate was green while three fixture files were never parsed): `for f in extension/overlay/overlay.js tests/fixtures/fake-chrome.mjs tests/fixtures/fake-audio.mjs tests/fixtures/extension-dom.mjs; do node --check "$f" || exit 1; done`.
4. Report: which fake behaviors are stricter than Chrome (the strict gesture model, the fixed stream-id TTL) and which are looser (no real process model, no layout), so B and C know what a green test does NOT prove.

### 15.7 Integration gate commands (orchestrator, after all four groups)

```
cd /Users/gai/work/interp-app
node --test tests/*.test.mjs                       # everything green: 1011 existing + all new tests (incl. the M3-only real-tree files)
node scripts/check-i18n.mjs                        # I18N_OK languages=3 keys=810 files=<n>
for f in $(git ls-files -o -c --exclude-standard -- 'extension/*.js' 'scripts/build-extension.mjs' 'tests/extension-*.test.mjs' 'tests/session-isolated.test.mjs' 'tests/fixtures/fake-*.mjs' 'tests/fixtures/extension-*.mjs'); do node --check "$f" || exit 1; done
node scripts/build-extension.mjs                   # EXTENSION_BUILT …; dist/ is gitignored
node scripts/build-extension.mjs                   # the SAME command again must also print EXTENSION_BUILT (rebuild idempotence)
git status --short                                 # only the files of 3.1 and 12 (plus the two app/ edits and the pre-existing untracked entries)
```
Then hand section 13 to the owner. Nothing in this gate touches a browser or audio.

---------------------------------------------------------------------------------------------------

## Appendix A: weakest points of this design (read before implementing)

1. The whole tab-capture path (A1, K1, K7) is source-reading, not observation. The design keeps the arming step explicit and the fallbacks cheap, but the first real click may reveal a different grant behavior.
2. Timer behavior of a never-composited offscreen document (K5) could degrade the engine's uplink exactly in the captions-only case (muted speech, original volume 0). The fix (worker timers) is BUILT but OFF, because that it helps is itself unmeasured (A27); the symptom is visible (gap line) and 13.22 tests the worst case.
3. The unmute path relies on autoplay being allowed in extension frames (A3); if not, the translated voice cannot be heard and only captions work (the panel now says so plainly instead of telling the user to press the button they just pressed).
4. The model defaults (A8) are a judgment; the tab-lane preview model is a preview.
5. Two concurrent sessions on one free key (K9) may be refused or exhaust the quota quickly; a refusal is retried three times by the unchanged engine and surfaces as "reopened three times" (5.9), so the copy compensates; the UI can only warn.
6. Overlay coverage over fullscreen video and strict-CSP pages (K13) is untested, for BOTH fullscreen strategies and for the closed shadow root (A15, A26, A28); the panel preview is the safety net. The privacy promise of the closed root (page scripts cannot read the captions) is reasoned, not measured.
7. Three lifecycle facts are unmeasured and shape the UX: whether a hidden panel keeps its port (A21), whether open ports survive a SW idle stop (A22), and what `sender.url` holds for the SW (A23). Each has a design that works either way and a checklist item that records which one is true.
8. The fake browser is stricter in places (gesture, the two no-responder modes, url-less SW) and looser in others (no real process model, no layout, no screen reader); a green suite proves protocol and state-machine correctness, not Chrome behavior.

---------------------------------------------------------------------------------------------------

## Appendix B: review ledger (issue -> resolution)

Three independent reviews (MV3 security `S`: 12 issues; testability/gates `T`: 16; UX/product `U`: 30) raised 58 issues, 26 major and 32 minor (counted from the reviewers' JSON). There was no blocker. Every major issue is resolved; issues marked REJECTED or PARTIAL carry the reason. Section numbers are those of this document. `S`, `T` and `U` numbers are the order in which each reviewer listed its issues.

| Id | Sev | Issue (short) | Resolution | Where |
|---|---|---|---|---|
| S1 | major | No stop honored while a start is in flight (host awaits, SW "no host = nothing to stop", late `ended` listener) | per-run cancel token checked after every await + abandon teardown; `sw/lane-stop` with in-flight cancel flags and "stop wins" re-send; `onEnded` registered before `attach`; tests and 13.27 | 5.3, 5.6, 5.7, 6.3, 6.11, 8.2.5, 11.1 |
| S2 | major | Captions checkbox cannot attach an overlay mid-run | `onStorageChanged` compares old/new, attaches on false->true (tab id from `host/ping`, mic = active tab); dismissal reset on `clear`; test and 13.36 | 6.6, 4.2, 8.5.3 |
| S3 | major | Mic captions on arbitrary/background pages, readable by page scripts, default on | closed shadow root (D6 change, 14.4), mic captions only to the active tab (`active` flag, `micActiveTabId`), default OFF, privacy sentence, 13.28 | 5.2, 5.6.3, 6.7, 7.1, 8.5.2, 9.2, 14.4 |
| S4 | major | Hidden-panel-keeps-port claim unverified; silent stops; no keep-open text | A21 + fallback + 13.17; `sw/host-idle {reason}`, `interp.lastStop.v1`, `#stop-note`, `sw/host-probe`; `ext.panel.closeStops`, `ext.howto.keepOpen` | 2.1, 4.10, 5.8, 6.9, 6.11, 8.2.7, 9.2, 14 |
| S5 | major | Throttling risk masked by 13.22 | 13.22 revised to the worst case; worker-timer seam built (OFF, decided now); visible gap line; K5 rewritten | 5.13, 13, 14.1 |
| S6 | minor | No SW lifecycle lock, zombie document | promise-chain mutex, `sw/host-idle` skips while starting, fresh ping, recreate once, resend once, host retries idle | 6.3, 6.3.1, 6.4, 6.9, 5.8 |
| S7 | minor | F1 and "dead SW does not stop a session" over-claimed | softened; A22 + 13.26 | 2.4, 2.5, 14.2 |
| S8 | minor | Start while `stopping` silently ignored | `LANE_STOPPING`; SW bounded wait BEFORE the mint; notice text; 13.37 | 5.2, 5.6, 6.3, 9.2 |
| S9 | minor | Overlay attach not idempotent, port replacement undefined | idempotent attach, `port === current` guards, hub replaces the old port and compares objects | 4.4, 8.5.1 |
| S10 | minor | `res.ok` on `undefined`; real no-responder behavior unknown | `sendToHost` helper, `res?.ok === true`, fake has both modes, A24 | 4, 6.3, 11.2 |
| S11 | minor | `onStartup` not registered; `setAccessLevel` failure silent | ninth listener `runtime.onStartup`; options page calls it before `writeKey` and refuses on rejection; A25 | 6.1, 7.4, 8.3 |
| S12 | minor | Fullscreen re-parent into arbitrary elements | only plain containers, restore always, popover second strategy, 13.14 records both | 8.5.3 |
| T1 | major | Dependency graph and acceptance contradict each other (real-tree tests in A, hidden D<->B cycle) | fixture vs real-tree split (`extension-static`, `extension-tree` M3), parity moved to A's tree test, acyclic graph | 11, 15.2-15.6 |
| T2 | major | `node --check a b c d` parses only the first file | verified with Node v24.18.0; loop form everywhere | 15.0, 15.4-15.7 |
| T3 | major | Build not idempotent; second run and rebuilds fail | own output replaced automatically; `--clean` only for half-written dirs in `dist/`; zip overwritten; Reload reminder in 13.1/13.2 | 10.1, 10.2, 10.7, 10.8, 12.3, 13 |
| T4 | major | Lane-blind error wording (tab failure shown as microphone) | `errorKeyFor(code, has, lane)`, `TAB_INPUT_LOST`, `TAB_CAPTURE_CODES`; PARTIAL: `TIMEOUT` not remapped (ambiguous: capture setup vs provider timeout, the generic text is right for both) | 4.6.2, 5.11, 9.2 |
| T5 | major | Host authorization depends on an unverified `sender.url` for the SW | url-less SW rule, A23, fake mode, 13.5 | 4.4, 11.2, 14.2 |
| T6 | minor | `protocol.js` imports nothing yet must validate settings-shaped data | `lib/constants.js` shared by `protocol.js` and `settings.js`; parity tests | 3.1, 3.3 R4, 4.2.1, 7.2 |
| T7 | minor | D13 scan flags its own file | tokens assembled at runtime; the scan excludes itself; R8 on identifiers only | 3.3 R8, 11, 11.4 |
| T8 | minor | CLI tests cannot use a fixture root | child-process tests limited to argument errors and a real-root temp-dir build; rest through `buildExtension()` | 11.1 |
| T9 | minor | Fake no-responder outcome hides a defect | both modes in the fake; callers tolerate all outcomes; A24 | 11.2, 6.3 |
| T10 | minor | Adapter contract under-specified (missing members, flat surface) | members skipped when absent; six-member offscreen `runtime`; nested `ADAPTER_SURFACE` | 3.4, 11.2 |
| T11 | minor | Reused app strings dead-end in the extension | `ext.error.MODEL_UNSUPPORTED`, `STORAGE_FAILED`, `IP_DENIED`, `CREDENTIAL_FORBIDDEN`; `{size}` parameter | 4.6.2, 7.3, 9.2 |
| T12 | minor | UI language does not reach `chrome.i18n` strings | PARTIAL: documented (options hint, 13.32); pushing strings REJECTED (cost above value, 8.5.1) | 7.3, 8.5.1 |
| T13 | minor | Attributes set by C are not styled | attribute table with required non-color CSS + test | 8.2.2, 11.1 |
| T14 | minor | Fake audio env lacks `fetch` | throwing `fetch` added | 11.3 |
| T15 | minor | Test artifacts unassigned or ephemeral | prototype embedded (Appendix C); `links.js` parity in `extension-options`; `extension-lanes.mjs` listed and scanned | 3.1, 11.1, 15.4 |
| T16 | minor | Mic captions silently absent on tabs open before install | overlay result for both lanes, mic notice with reload hint, 13.35 | 4.2, 6.7, 9.2 |
| U1 | major | Arming copy promises auto-start that does not exist | `ext.arm.needed` (idle) vs `ext.arm.waiting` (pending); TAB_ENDED/GONE say "then press Start"; test | 8.2.3, 9.2 |
| U2 | major | "Checking permissions" while waiting for a click; Stop label | `ext.status.awaitingArm`, Cancel label | 5.11, 8.2.3 |
| U3 | major | Icon/shortcut discovery | `ext.arm.pinHint`, real shortcut via `commands.getAll`, name in every string; the optional one-click setting NOT built (stays K1 fallback) | 3.4, 6.5, 8.2.3, 9.2 |
| U4 | major | Echo risk handled backwards | rewritten mute hint, `ext.sound.echoWarning`, `ext.sound.on/off`, how-to leak line | 8.2.3, 9.2 |
| U5 | major | How-to never says the voice is local / call usage | `ext.howto.step5`, `stepCall` | 9.2 |
| U6 | major | Primary controls below the fold | sticky button row, notes above it, static test, 13.29 | 8.2.1, 8.2.2 |
| U7 | major | Overlay clips the newest caption | flex-end overflow anchor, line-bounded max-height, top fade, test, 13.30 | 8.5.2 |
| U8 | major | Dismiss rule contradicts itself | one rule `epoch <= dismissed`, reset on `clear`, tests | 8.5.3 |
| U9 | major | Captions vanish with no reason | `status` frame, `ext.overlay.reconnecting/stopped`, `statusLingerMs` | 4.5, 5.6.3, 5.7, 8.5.3, 9.3 |
| U10 | major | Two-lane refusal shows the wrong advice | `BUDGET_EXHAUSTED` quota-suspect with both lanes, new text | 5.9, 5.11, 8.2.3 rule 12 |
| U11 | major | Quota family strings have no next step / say false things | four overrides + `ext.usage.quotaHint`, `(429)` dropped | 5.11, 9.2 |
| U12 | major | Blocked-output text tells the user to press the pressed button | `ext.output.blocked`, 13.7 records it | 5.6.4, 9.2 |
| U13 | major | Free-tier data use not disclosed | `ext.privacy.freeTier`, source fetched, 13.39 | 7.3, 9.2, 14.5 |
| U14 | major | Permission copy quotes a label Chrome does not show | avoid-"Allow this time" wording (D5 change, 14.4), `MICROPHONE_EXPIRED`, `#btn-mic-allow`, 13.8 records the labels | 8.4, 9.2, 14.4 |
| U15 | major | Closing the panel stops everything without saying so | `ext.panel.closeStops`, first how-to step, 13.16 | 5.8, 8.2.1, 9.2 |
| U16 | major | Hidden live regions may not announce | persistent regions, `role="alert"` for errors, key failure once, `aria-describedby`, 13.31 | 8.2.1, 8.2.6 |
| U17 | minor | Pill wording | `ext.status.failed/partial/reconnecting`, `sim.status.stopped` for tab end | 5.11, 8.2.3 |
| U18 | minor | Mute button names | `ext.sound.on/off` for `aria-label` and `title` | 1.5, 8.2.1 |
| U19 | minor | "screen-reader users use the panel" is untrue | claim replaced by the stated limitation | 8.2.6, 8.5.2 |
| U20 | minor | `data-attention`/`data-emphasis` unspecified | merged with T13 | 8.2.2 |
| U21 | minor | Fallback route text | `ext.route.fallback` | 5.11, 9.2 |
| U22 | minor | Two-session footnote hedges twice; untestable claim | shorter text; marker words asserted per language | 9.2, 11.4 |
| U23 | minor | Overlay strings follow Chrome's language | merged with T12 | 8.5.1 |
| U24 | minor | Sticky gap line, unexplained struck rows | 8 s gap line per transition, skipped rows hidden in the overlay | 8.5.3 |
| U25 | minor | Model options say "(default)" on the non-recommended model | REJECTED: hints now name the recommended model; relabelling needs a key family for three non-i18n names | 9.4, 9.2 |
| U26 | minor | Permission page closes before it can be read; icon-only button | 2 s close, text `Allow microphone` button | 1.5, 8.4 |
| U27 | minor | `TAB_AUDIO_BLOCKED` advice, hub wording of `IP_DENIED` | texts replaced, codes overridden | 9.2 |
| U28 | minor | Volume label and `#apply-next` placement | relabelled; per-lane `apply-next` in the card | 8.2.1, 9.2 |
| U29 | minor | Two buttons named "Options"; `aria-pressed` swap | `ext.key.enter`; no `aria-pressed` | 7.3, 8.2.1 |
| U30 | minor | No contrast test, missing checklist scenarios | WCAG helper test; 13.26-13.39 | 8.5.2, 11.1, 13 |

Rows T12 and U23 are the same finding (the UI-language split), as are T13 and U20 (attribute styling); the second of each pair points at the first. Nothing was left open: the only items not implemented as suggested are U25 (rejected), T12/U23 (documented instead of pushing strings), the optional one-click setting of U3 (not built), the `TIMEOUT` remap of T4 (not applied) and the worker timers of S5 (built but off).

Second round (after implementation, on the BUILT extension, three lenses: UX, security, contract). The ledger above is the first round, on the design. The second round found no blocker; its findings were fixed in code and tests and are the deviations listed in the Status block, the checklist rows 13.40-13.51 (13.42 and 13.51 are recorded as known and not fixed) and the tests of `7773fbc` (a mutation study of 191 hand-written mutants (187 applied) over the 12 MUST rules and the static guards: 160 were killed by the suite as first delivered, 27 survived, 13 of those exposed real test gaps, all closed by `7773fbc`, and the rest were equivalent or redundant mutants).

---------------------------------------------------------------------------------------------------

## Appendix C: prototype test for group A (`tests/extension-i18n.test.mjs`)

The architect wrote and ran this prototype against the patched checker of 12.1 on 2026-09-29 (3 tests). Group A starts from it (not from any scratch path) and adds the `_locales` assertions of 11.1. It builds fake dictionaries at runtime and contains no key-shaped literal.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { EXTENSION_KEY_PREFIX, checkI18n, checkSource, validateDictionaries } from '../scripts/check-i18n.mjs';

const app = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));
const ext = { en: { 'ext.a.one': 'One {n}', 'ext.a.two': 'Two' }, ko: { 'ext.a.one': '하나 {n}', 'ext.a.two': '둘' },
  ja: { 'ext.a.one': '一 {n}', 'ext.a.two': '二' } };
const options = { requireErrorKeys: false, keyPrefix: EXTENSION_KEY_PREFIX };

async function fixture(t, { extension = ext, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'interp-ext-i18n-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app/i18n'), { recursive: true });
  for (const language of SUPPORTED_LANGUAGES) await writeFile(join(root, `app/i18n/${language}.json`), JSON.stringify(app[language]));
  if (extension) {
    await mkdir(join(root, 'extension/i18n'), { recursive: true });
    for (const language of SUPPORTED_LANGUAGES) await writeFile(join(root, `extension/i18n/${language}.json`), JSON.stringify(extension[language]));
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const codes = (result) => result.issues.map((issue) => typeof issue === 'string' ? issue : issue.code);

test('extension dictionaries: parity, placeholders and the ext. prefix are enforced without the app error keys', () => {
  assert.deepEqual(validateDictionaries(ext, options), []);
  assert.ok(validateDictionaries(ext).includes('I18N_MISSING_ERROR'), 'default mode still demands the app error keys');
  const mutate = (fn) => { const d = structuredClone(ext); fn(d); return validateDictionaries(d, options); };
  assert.ok(mutate((d) => { delete d.ja['ext.a.two']; }).includes('I18N_KEY_MISMATCH'));
  assert.ok(mutate((d) => { d.ko['ext.a.one'] = '하나 {m}'; }).includes('I18N_PLACEHOLDER_MISMATCH'));
  assert.ok(mutate((d) => { for (const v of Object.values(d)) { v['plain.key'] = 'x'; } }).includes('I18N_KEY_PREFIX'));
});

test('checker skips a tree without extension/, and validates one that has it', async (t) => {
  assert.equal((await checkI18n({ root: await fixture(t, { extension: null }) })).ok, true);
  const root = await fixture(t, { files: { 'extension/sidepanel/panel.js': "el.textContent = i18n.t('ext.a.one'); bind.text(el, 'ext.a.two'); i18n.t('common.start');" } });
  const result = await checkI18n({ root });
  assert.deepEqual([result.ok, result.issues], [true, []]);
});

test('extension sources are checked against the union of app and extension keys; the app never sees ext keys', async (t) => {
  for (const [source, code] of [
    ["i18n.t('ext.a.missing')", 'I18N_UNKNOWN_UI_KEY'],
    ["bind.text(el, 'ext.a.typo')", 'I18N_UNKNOWN_UI_KEY'],
    ["i18n.t('sim.doesNotExist')", 'I18N_UNKNOWN_UI_KEY'],
    ["el.textContent = 'Start'", 'I18N_LITERAL_UI_TEXT'],
  ]) {
    const root = await fixture(t, { files: { 'extension/x.js': source } });
    assert.ok(codes(await checkI18n({ root })).includes(code), source);
  }
  const html = await fixture(t, { files: { 'extension/sidepanel/panel.html': '<button>Start</button>' } });
  assert.ok(codes(await checkI18n({ root: html })).includes('I18N_LITERAL_UI_TEXT'));
  const appUse = await fixture(t, { files: { 'app/ui/x.js': "i18n.t('ext.a.one')" } });
  assert.ok(codes(await checkI18n({ root: appUse })).includes('I18N_UNKNOWN_UI_KEY'), 'web app code may not use an extension key');
  const collide = structuredClone(ext);
  for (const language of SUPPORTED_LANGUAGES) collide[language]['ext.common.start'] = 'x';
  // a collision is only possible if an app key starts with ext.; simulate by adding one to the app dictionary
  const withApp = await fixture(t, { extension: ext });
  const en = JSON.parse(await readFile(join(withApp, 'app/i18n/en.json'), 'utf8'));
  for (const language of SUPPORTED_LANGUAGES) {
    const dictionary = JSON.parse(await readFile(join(withApp, `app/i18n/${language}.json`), 'utf8'));
    dictionary['ext.a.one'] = 'clash {n}';
    await writeFile(join(withApp, `app/i18n/${language}.json`), JSON.stringify(dictionary));
  }
  assert.ok(en && codes(await checkI18n({ root: withApp })).includes('I18N_KEY_COLLISION'));
  const badExt = structuredClone(ext); delete badExt.ja['ext.a.two'];
  assert.ok(codes(await checkI18n({ root: await fixture(t, { extension: badExt }) })).includes('I18N_KEY_MISMATCH'));
  assert.deepEqual(checkSource("t('ext.a.one')", { ...app.en, ...ext.en }, { literalPrefix: 'ext.' }), []);
  assert.deepEqual(checkSource("const s = `ext.status.${state}`;", { ...app.en }, { literalPrefix: 'ext.' }), [], 'dynamic keys are not literals');
});
```
