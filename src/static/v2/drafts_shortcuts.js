(function () {
  'use strict';
  // Keyboard shortcuts on the drafts list. Kept deliberately small in
  // chunk 2.5o; the full wizard shortcut set lands in chunk 2.5q.
  //   N  — start a new draft (submit the hero CTA form)
  //   F  — focus the filter search input
  //   J / K — move selection down / up (one card at a time)
  //   Enter — resume the selected draft
  const root = document.querySelector('[data-drafts-root]');
  if (!root) return;

  const newBtn = root.querySelector('[data-new-draft]');
  const q = root.querySelector('[data-drafts-q]');
  const grid = root.querySelector('[data-drafts-grid]');

  let selected = -1;
  function cards() {
    if (!grid) return [];
    return Array.from(grid.querySelectorAll('[data-draft-card]')).filter(function (c) {
      return !c.hidden;
    });
  }
  function setSelected(i) {
    const list = cards();
    if (list.length === 0) {
      selected = -1;
      return;
    }
    if (i < 0) i = 0;
    if (i >= list.length) i = list.length - 1;
    list.forEach(function (c, idx) {
      if (idx === i) {
        c.classList.add('is-selected');
        const link = c.querySelector('a');
        if (link && typeof link.focus === 'function') link.focus();
      } else {
        c.classList.remove('is-selected');
      }
    });
    selected = i;
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', function (ev) {
    // Never hijack keystrokes inside an input; but allow F/N/? to escape
    // on Alt so power users can still fire them from the search box.
    if (isTypingTarget(ev.target) && !ev.altKey) return;
    if (ev.ctrlKey || ev.metaKey) return;
    const k = ev.key;
    if (k === 'n' || k === 'N') {
      if (newBtn) {
        ev.preventDefault();
        newBtn.click();
      }
    } else if (k === 'f' || k === 'F') {
      if (q) {
        ev.preventDefault();
        q.focus();
        q.select();
      }
    } else if (k === 'j' || k === 'J' || k === 'ArrowDown') {
      ev.preventDefault();
      setSelected(selected + 1);
    } else if (k === 'k' || k === 'K' || k === 'ArrowUp') {
      ev.preventDefault();
      setSelected(selected - 1);
    } else if (k === 'Enter' && selected >= 0) {
      const list = cards();
      if (list[selected]) {
        const link = list[selected].querySelector('a');
        if (link) link.click();
      }
    }
  });
})();
