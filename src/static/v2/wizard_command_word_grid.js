// Wizard v2 step-2 command-word chip grid.
//
// The chips are native <input type="radio"> wrapped in <label>; no JS
// is required for selection to work. This script only adds:
//   • an `is-selected` class toggle so the :has(:checked) CSS styling
//     still works in browsers that predate :has() (very small cohort).
//   • an autosave pulse when the chip changes, so the chip-style UI
//     feels instant (the debounce on `input` waits 800ms for text;
//     chips are an immediate intent).

(function () {
  'use strict';

  function init() {
    const grid = document.querySelector('[data-wizard-chip-grid]');
    if (!grid) return;
    const radios = grid.querySelectorAll('input[type="radio"]');
    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        const labels = grid.querySelectorAll('.wizard__chip');
        labels.forEach(function (l) {
          l.classList.remove('is-selected');
        });
        const parent = r.closest('.wizard__chip');
        if (parent) parent.classList.add('is-selected');
        if (typeof window.__wizardAutosavePulse === 'function') {
          window.__wizardAutosavePulse();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
