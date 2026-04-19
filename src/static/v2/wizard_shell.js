// Wizard v2 shell — responsive collapse behaviours.
//
// Progressive enhancement: without JS the three panes stack vertically (rail,
// editor, preview, actions) and every pane is reachable. With JS we add:
//
//   - A "Preview" toggle that slides the preview pane in/out below 1024 px.
//   - An Escape-to-close handler for the preview drawer.
//   - Storage of the teacher's preview preference per session so it doesn't
//     pop open again after every step navigation.
//
// The rail below 720 px is already a pure-CSS horizontal strip; no JS needed.

(function () {
  'use strict';

  const STORAGE_KEY = 'wizardV2.previewOpen';

  function readStoredOpen() {
    try {
      return sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  function writeStoredOpen(open) {
    try {
      sessionStorage.setItem(STORAGE_KEY, open ? '1' : '0');
    } catch (_e) {
      /* sessionStorage may be unavailable in private modes */
    }
  }

  function isNarrow() {
    return window.matchMedia('(max-width: 1023.98px)').matches;
  }

  function initShell() {
    const shell = document.querySelector('[data-wizard-shell]');
    if (!shell) return;
    const toggle = shell.querySelector('[data-wizard-preview-toggle]');
    const pane = shell.querySelector('[data-wizard-preview-pane]');
    if (!toggle || !pane) return;

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      pane.classList.toggle('is-open', open);
      writeStoredOpen(open);
    }

    toggle.addEventListener('click', function () {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!isNarrow()) return;
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      setOpen(false);
      toggle.focus();
    });

    // Restore previous open/closed state on load, but only when narrow —
    // on ≥1024 the preview is always visible and the toggle button is
    // hidden by CSS, so the stored value is moot.
    if (isNarrow()) {
      setOpen(readStoredOpen());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShell);
  } else {
    initShell();
  }
})();
