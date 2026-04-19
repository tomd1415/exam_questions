(function () {
  'use strict';
  // Progressive-enhancement client-side narrowing of the drafts grid.
  // Server already applied the filters on the initial GET; this just makes
  // keystrokes feel instant. No query-string rewriting — submit on
  // chip-change so bookmarkable/shareable URLs stay accurate.
  const root = document.querySelector('[data-drafts-root]');
  if (!root) return;
  const form = root.querySelector('[data-drafts-filter]');
  const q = root.querySelector('[data-drafts-q]');
  const grid = root.querySelector('[data-drafts-grid]');
  const empty = root.querySelector('[data-drafts-empty]');
  if (!form || !grid) return;

  function apply() {
    const needle = (q && q.value ? q.value : '').trim().toLowerCase();
    const widgetInput = form.querySelector('[data-filter-group="widget"] input:checked');
    const staleInput = form.querySelector('[data-filter-group="stale"] input:checked');
    const widget = widgetInput ? widgetInput.value : '';
    const stale = staleInput ? staleInput.value : 'all';
    let visible = 0;
    const cards = grid.querySelectorAll('[data-draft-card]');
    cards.forEach(function (card) {
      let show = true;
      if (needle) {
        const hay = card.getAttribute('data-search') || '';
        if (hay.indexOf(needle) === -1) show = false;
      }
      if (show && widget && card.getAttribute('data-widget') !== widget) show = false;
      if (show && stale !== 'all' && card.getAttribute('data-stale') !== stale) show = false;
      card.hidden = !show;
      if (show) visible += 1;
    });
    if (empty) {
      // Only toggle the inline "no results" message if the server didn't
      // already render the empty state (i.e. there's a grid to hide).
      const noneMessage = root.querySelector('[data-drafts-none]');
      if (visible === 0 && cards.length > 0) {
        if (!noneMessage) {
          const p = document.createElement('p');
          p.className = 'v2-drafts__none';
          p.setAttribute('data-drafts-none', '');
          p.setAttribute('role', 'status');
          p.textContent =
            'Nothing matches those filters. Try removing a chip or clearing the search.';
          grid.parentNode.insertBefore(p, grid.nextSibling);
        }
        grid.hidden = true;
      } else {
        if (noneMessage) noneMessage.remove();
        grid.hidden = false;
      }
    }
  }

  // Live filter on keystroke; debounced so long lists stay responsive.
  let t = 0;
  if (q) {
    q.addEventListener('input', function () {
      window.clearTimeout(t);
      t = window.setTimeout(apply, 80);
    });
  }
  // Chip changes — radios, so apply immediately.
  form.querySelectorAll('input[type="radio"]').forEach(function (r) {
    r.addEventListener('change', apply);
  });

  // Prevent the form from navigating on Enter in the search box: the user
  // is filtering, not submitting.
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    apply();
  });

  apply();
})();
