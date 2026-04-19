// Wizard v2 step-1 curriculum filter.
//
// Narrows every <option> inside [data-wizard-curriculum] based on the
// text typed into [data-wizard-curriculum-filter]. Works alongside
// wizard_curriculum_chain.js (which enforces parent/child cascade); this
// script only toggles a `.is-filtered` style-hook and the option's
// `hidden` attribute so the native <select> skips it with the keyboard.
//
// With JS disabled the filter input is visible but inert; the three
// selects remain fully functional.

(function () {
  'use strict';

  function filterOptions(root, needle) {
    const n = needle.trim().toLowerCase();
    const selects = root.querySelectorAll('select[data-curriculum-level]');
    selects.forEach(function (select) {
      const options = select.querySelectorAll('option');
      options.forEach(function (opt) {
        if (!opt.value) return; // leave the placeholder alone
        const text = (opt.textContent || '').toLowerCase();
        const match = n === '' || text.indexOf(n) !== -1;
        opt.hidden = !match;
      });
      // Hide optgroups whose children are all hidden.
      const groups = select.querySelectorAll('optgroup');
      groups.forEach(function (g) {
        const kids = g.querySelectorAll('option');
        let anyVisible = false;
        kids.forEach(function (o) {
          if (!o.hidden) anyVisible = true;
        });
        g.hidden = !anyVisible;
      });
    });
  }

  function init() {
    const root = document.querySelector('[data-wizard-curriculum]');
    if (!root) return;
    const input = root.querySelector('[data-wizard-curriculum-filter]');
    if (!input) return;
    input.addEventListener('input', function () {
      filterOptions(root, input.value || '');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
