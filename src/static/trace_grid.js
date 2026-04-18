// Last-cell undo for the trace-grid widget (Phase 2.5i Option B MVP).
// Pupils get one level of undo: Ctrl/Cmd-Z reverts the most recent
// cell edit (across the whole grid). This is deliberately not a
// per-cell history stack — that would be a larger UX change and is
// in Option A's deferred follow-up.
//
// Wiring: every editable cell is a `<input data-trace-cell="r,c">`
// inside a `.trace-grid` table. We capture the value on focus, push
// it to a single-slot undo register on blur if it changed, and pop
// the register on Ctrl/Cmd-Z.
(function () {
  var lastBaseline = null;
  var lastFocusCell = null;
  var lastFocusValue = '';

  function isTraceCell(el) {
    return el instanceof HTMLInputElement && el.hasAttribute('data-trace-cell');
  }

  document.addEventListener('focusin', function (event) {
    var t = event.target;
    if (!isTraceCell(t)) return;
    lastFocusCell = t;
    lastFocusValue = t.value;
  });

  document.addEventListener('focusout', function (event) {
    var t = event.target;
    if (!isTraceCell(t)) return;
    if (t === lastFocusCell && t.value !== lastFocusValue) {
      lastBaseline = { cell: t, value: lastFocusValue };
    }
    lastFocusCell = null;
    lastFocusValue = '';
  });

  document.addEventListener('keydown', function (event) {
    var isUndo =
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      (event.key === 'z' || event.key === 'Z');
    if (!isUndo) return;
    var active = document.activeElement;
    // Ctrl-Z is only handled when the focused element is a trace cell;
    // every other field's native undo is left intact.
    if (!isTraceCell(active)) return;
    if (lastBaseline === null) return;
    event.preventDefault();
    lastBaseline.cell.value = lastBaseline.value;
    lastBaseline.cell.dispatchEvent(new Event('input', { bubbles: true }));
    lastBaseline.cell.dispatchEvent(new Event('change', { bubbles: true }));
    lastBaseline.cell.focus();
    lastBaseline = null;
  });
})();
