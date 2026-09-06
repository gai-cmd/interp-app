// P3-38 fixtures: combinations of the P3 features over the P1-20 fake browser.
// Nothing here renders anything at a real size — the mock DOM cannot decide a
// layout, so this file deliberately offers no viewport helper and the suite
// makes no claim about 430/768/1280px. Those stay manual (p3-verification V01).
import { boot, tick, until } from './scenarios.mjs';

/** Boot with the P3 surfaces reachable, and helpers for the combinations. */
export async function bootP3(options = {}) {
  const b = await boot(options);
  const el = (name) => b.el(name);
  const handle = {
    ...b,
    /** Open a sheet the way a person does, through its header button. */
    openSheet(name) {
      const button = el(`shell-${name}-button`) ?? el(`${name}-button`);
      button?.dispatch('click');
      return button;
    },
    /** Which sheet the shell reports as open, or null. */
    openSheetId() {
      const app = b.app.shell;
      return app.settingsOpen ? 'settings' : app.displayOpen ? 'display' : app.shareOpen ? 'share' : null;
    },
    /** Every element the background marks inert while a sheet is open. */
    inertCount: () => b.app.shell.elements.header.hasAttribute('inert'),
    async settleWork() { await until(() => !b.app.activity.occupied); },
  };
  return handle;
}

/** A policy the loader will refuse, for the first-run failure path. */
export const brokenPolicy = () => ({ schemaVersion: 1, revision: 'nope' });
export { tick, until };
