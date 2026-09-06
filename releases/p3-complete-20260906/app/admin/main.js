// P3-32/33/34: the administrator console's browser entry (design-p3 §1.7).
//
// It boots in the three app languages from the same dictionaries, uses the same
// design tokens, and applies the P3-13 appearance boot before the stylesheet —
// there is no second theme and no second string table.
//
// What it must never do, and does not:
//   - apply an edited policy to the running app (nothing here writes the app's
//     storage or its policy runtime);
//   - deploy (there is no network call at all beyond loading the deployed
//     policy to compare against);
//   - carry a credential in the policy draft or its export (the shared-key tool
//     is separate and keeps its key in memory only).
import { SUPPORTED_LANGUAGES, createI18n } from '../i18n/index.js';
import { createPolicyEditor } from './policy-editor.js';
import { createPolicyExport, PUBLISH_STEP_KEYS } from './export.js';
import { createSharedPayloadTool } from './shared-payload.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
function element(doc, tag, { className, attributes = {}, text } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Screen order of §1.7; each is a section with a dictionary title. */
export const ADMIN_SECTIONS = Object.freeze(['current', 'control', 'settings', 'events', 'pricing',
  'validation', 'export', 'payload']);

/**
 * mountAdmin({ root, i18n, editor, exporter, payload, document })
 * Renders the console and returns frozen { element, render, setLanguage, destroy }.
 */
export function mountAdmin({ root, i18n, editor, exporter = null, payload = null,
  document: doc = root?.ownerDocument } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof editor?.snapshot !== 'function') throw new Error('INVALID_REQUEST');
  const removers = [];
  const bindings = [];
  const bind = (node, key) => { bindings.push(() => { node.textContent = i18n.t(key); }); return node; };
  const listen = (node, type, fn) => { node.addEventListener(type, fn); removers.push(() => node.removeEventListener(type, fn)); };

  const container = element(doc, 'main', { className: 'admin' });
  bind(element(doc, 'h1', { className: 'admin-title' }), 'admin.title');
  const title = element(doc, 'h1', { className: 'admin-title' });
  bind(title, 'admin.title');
  container.append(title);

  const sections = {};
  for (const name of ADMIN_SECTIONS) {
    const node = element(doc, 'section', { className: `admin-section admin-${name}`, attributes: { 'data-section': name } });
    const heading = element(doc, 'h2', { className: 'admin-section-title' });
    bind(heading, `admin.section.${name}`);
    node.append(heading);
    container.append(node);
    sections[name] = node;
  }

  // 1. Current deployed policy.
  const currentLine = element(doc, 'p', { className: 'admin-current-line', attributes: { role: 'status' } });
  sections.current.append(currentLine);

  // 6. Validation and change preview.
  const validation = element(doc, 'ul', { className: 'admin-issues' });
  const preview = element(doc, 'ul', { className: 'admin-preview' });
  const previewTitle = element(doc, 'h3', { className: 'admin-preview-title' });
  bind(previewTitle, 'admin.preview.title');
  sections.validation.append(validation, previewTitle, preview);

  // 7. Export and publish steps. A download is not a publication.
  const exportRow = element(doc, 'div', { className: 'admin-actions' });
  const downloadButton = element(doc, 'button', { className: 'btn btn-primary admin-download', attributes: { type: 'button' } });
  bind(downloadButton, 'admin.action.download');
  const copyButton = element(doc, 'button', { className: 'btn btn-secondary admin-copy', attributes: { type: 'button' } });
  bind(copyButton, 'admin.action.copy');
  exportRow.append(downloadButton, copyButton);
  const exportStatus = element(doc, 'p', { className: 'admin-export-status', attributes: { role: 'status' } });
  const manual = element(doc, 'textarea', { className: 'admin-manual', attributes: { readonly: '', rows: '6' } });
  manual.hidden = true;
  const notPublished = element(doc, 'p', { className: 'admin-not-published' });
  bind(notPublished, 'admin.export.notPublished');
  const publishTitle = element(doc, 'h3');
  bind(publishTitle, 'admin.publish.title');
  const steps = element(doc, 'ol', { className: 'admin-publish-steps' });
  for (const key of PUBLISH_STEP_KEYS) {
    const item = element(doc, 'li');
    bind(item, key);
    steps.append(item);
  }
  for (const key of ['admin.publish.noConfirmation', 'admin.publish.propagation', 'admin.publish.rollback',
    'admin.publish.keyRevoke']) {
    const note = element(doc, 'p', { className: 'admin-note' });
    bind(note, key);
    steps.append(note);
  }
  sections.export.append(exportRow, exportStatus, manual, notPublished, publishTitle, steps);

  listen(downloadButton, 'click', async () => {
    const result = await attempt(() => exporter?.download()) ?? { result: 'failed' };
    showExport(result);
  });
  listen(copyButton, 'click', async () => {
    const result = await attempt(() => exporter?.copy()) ?? { result: 'failed' };
    showExport(result);
  });
  function showExport(result) {
    const key = result.result === 'downloaded' ? 'admin.export.downloaded'
      : result.result === 'copied' ? 'admin.export.copied'
      : result.result === 'manual' ? 'admin.export.manual'
      : result.result === 'blocked' ? 'admin.export.blocked' : 'admin.export.copyFailed';
    exportStatus.textContent = i18n.t(key);
    manual.hidden = result.result !== 'manual';
    if (result.result === 'manual') manual.value = result.text ?? '';
  }

  // 8. Shared key payload, separate from the draft.
  const payloadNotes = element(doc, 'div', { className: 'admin-payload' });
  for (const key of ['admin.payload.separate', 'admin.payload.memoryOnly', 'admin.payload.version',
    'admin.payload.noQr', 'admin.payload.noAutoNavigate']) {
    const note = element(doc, 'p', { className: 'admin-note' });
    bind(note, key);
    payloadNotes.append(note);
  }
  const payloadStatus = element(doc, 'p', { className: 'admin-payload-status', attributes: { role: 'status' } });
  payloadNotes.append(payloadStatus);
  sections.payload.append(payloadNotes);

  root.append(container);

  function render() {
    const state = editor.snapshot();
    const deployed = state.deployed;
    currentLine.textContent = deployed
      ? `${i18n.t('admin.current.loadedRevision')}: ${deployed.revision}`
      : i18n.t('admin.current.status.notLoaded');

    for (const item of Array.from(validation.childNodes)) item.remove();
    for (const issue of state.issues) {
      // The field path and the code, both readable; no raw value is echoed.
      validation.append(element(doc, 'li', { className: 'admin-issue',
        text: `${issue.path || '/'} · ${issue.code}` }));
    }
    for (const item of Array.from(preview.childNodes)) item.remove();
    for (const change of state.review.changes.slice(0, 200)) {
      preview.append(element(doc, 'li', { className: 'admin-change', text: change.path }));
    }
    // An invalid draft cannot be exported at all (§1.7).
    const blocked = exporter ? exporter.blocker() : null;
    downloadButton.disabled = blocked !== null;
    copyButton.disabled = blocked !== null;
    if (payload) {
      const events = attempt(() => payload.events()) ?? [];
      payloadStatus.textContent = events.length ? '' : i18n.t('admin.payload.noActiveEvent');
    }
    for (const apply of bindings) apply();
  }
  render();

  return Object.freeze({
    element: container,
    elements: Object.freeze({ sections, validation, preview, downloadButton, copyButton, exportStatus, manual,
      currentLine, payloadStatus }),
    render,
    setLanguage(language) {
      if (!SUPPORTED_LANGUAGES.includes(language)) return false;
      attempt(() => i18n.setLanguage(language));
      attempt(() => doc.documentElement?.setAttribute('lang', language));
      render();
      return true;
    },
    destroy() {
      for (const off of removers) attempt(() => off());
      attempt(() => payload?.close());
      container.remove();
    },
  });
}

/** Browser entry: guarded so importing the module in Node does nothing. */
export async function startAdmin({ window: win = globalThis } = {}) {
  const doc = win.document;
  if (!doc?.body) return null;
  const dictionaries = {};
  for (const language of SUPPORTED_LANGUAGES) {
    const response = await win.fetch(new URL(`../i18n/${language}.json`, import.meta.url));
    dictionaries[language] = await response.json();
  }
  const language = SUPPORTED_LANGUAGES.find((value) => (win.navigator?.languages ?? []).some(
    (tag) => String(tag).toLowerCase().startsWith(value))) ?? 'ko';
  const i18n = createI18n({ dictionaries, language });
  // The deployed policy is fetched to compare against, never applied here.
  let deployed = null;
  try {
    // Relative to the PAGE, not the module: in a release the module lives under
    // releases/<id>/app/admin/, while the policy stays at the deployment root.
    const response = await win.fetch(new URL('../policy.json', win.location.href));
    if (response.ok) deployed = await response.json();
  } catch { deployed = null; }
  const editor = createPolicyEditor({ deployed });
  const exporter = createPolicyExport({ editor, document: doc, navigator: win.navigator,
    URL: win.URL, Blob: win.Blob });
  const payload = createSharedPayloadTool({ policy: deployed, navigator: win.navigator });
  return mountAdmin({ root: doc.body, i18n, editor, exporter, payload, document: doc });
}
