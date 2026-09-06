// First-paint appearance boot (design-p3 §1.10, DESIGN.md §10, architecture.md
// "표시 설정"). New implementation; nothing is ported from interp-web or jp-patch.
//
// This is a classic, synchronous script (not an ES module) that index.html and
// admin/index.html load in <head> before the stylesheet, so the saved display
// settings reach <html> before the first paint and nothing flashes. Because it
// runs before app/main.js it cannot import anything: the accepted values below
// duplicate REGISTERED_SETTINGS['ui.*'] of app/policy/schema.js and the storage
// keys of app/preferences.js; tests/appearance-boot.test.mjs keeps them equal.
//
// Contract:
// - Reads only the three saved display keys. No network, no provider key, no
//   policy access, no other storage key.
// - Corrupt or missing values and any storage exception (cookies blocked,
//   private mode, quota) fall back to system/navy/m.
// - Writes only the data-mode/data-tone/data-text attributes of <html>;
//   data-mode is removed for "system" so prefers-color-scheme applies.
// - Leaves no global: everything lives inside the IIFE and nothing is thrown.
// - A newer policy (defaults, forced values) is applied later by the runtime
//   (app/ui/appearance.js, P3-14); this script only restores the personal choice.
(function () {
  'use strict';
  var STORAGE_PREFIX = 'interp-app.ui.v1.';
  var SETTINGS = [
    { key: 'mode', attribute: 'data-mode', values: ['system', 'light', 'dark'], fallback: 'system', unset: 'system' },
    { key: 'tone', attribute: 'data-tone', values: ['navy', 'warm', 'forest', 'mono'], fallback: 'navy', unset: null },
    { key: 'text', attribute: 'data-text', values: ['s', 'm', 'l', 'xl'], fallback: 'm', unset: null }
  ];

  function read(key) {
    // localStorage itself may throw on access (SecurityError) or on getItem.
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + key);
      return typeof raw === 'string' ? raw : null;
    } catch (error) {
      return null;
    }
  }

  function accept(setting, raw) {
    return raw !== null && setting.values.indexOf(raw) >= 0 ? raw : setting.fallback;
  }

  function apply(root, setting, value) {
    try {
      if (value === setting.unset) root.removeAttribute(setting.attribute);
      else root.setAttribute(setting.attribute, value);
    } catch (error) {
      // A read-only or detached root must not break page load.
    }
  }

  var root;
  try { root = document.documentElement; } catch (error) { root = null; }
  if (!root || typeof root.setAttribute !== 'function' || typeof root.removeAttribute !== 'function') return;
  for (var index = 0; index < SETTINGS.length; index += 1) {
    var setting = SETTINGS[index];
    apply(root, setting, accept(setting, read(setting.key)));
  }
})();
