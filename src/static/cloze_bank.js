// Cloze word-bank tap-to-fill behaviour.
//
// When a pupil clicks/taps a bank term, copy its text into the most
// recently focused cloze gap on the same widget. Falls back to the
// first empty gap if nothing has been focused yet. Pure JS, no deps;
// progressive enhancement — without it the gaps are still typeable.

(function () {
  'use strict';

  var lastFocused = new WeakMap();

  document.addEventListener('focusin', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('cloze-gap')) return;
    var widget = target.closest('.cloze');
    if (widget) lastFocused.set(widget, target);
  });

  function pickTarget(widget) {
    var focused = lastFocused.get(widget);
    if (focused && widget.contains(focused)) return focused;
    var gaps = widget.querySelectorAll('input.cloze-gap');
    for (var i = 0; i < gaps.length; i++) {
      if (gaps[i].value.length === 0) return gaps[i];
    }
    return gaps.length > 0 ? gaps[0] : null;
  }

  function refreshUsage(widget) {
    var values = {};
    var gaps = widget.querySelectorAll('input.cloze-gap');
    for (var i = 0; i < gaps.length; i++) {
      var v = gaps[i].value;
      if (v.length > 0) values[v] = true;
    }
    var buttons = widget.querySelectorAll('[data-cloze-bank-term]');
    for (var j = 0; j < buttons.length; j++) {
      var term = buttons[j].getAttribute('data-cloze-bank-term') || '';
      if (values[term]) {
        buttons[j].setAttribute('data-cloze-bank-used', 'true');
      } else {
        buttons[j].removeAttribute('data-cloze-bank-used');
      }
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    var btn = target.closest('[data-cloze-bank-term]');
    if (!btn) return;
    event.preventDefault();
    var widget = btn.closest('.cloze');
    if (!widget) return;
    var gap = pickTarget(widget);
    if (!gap) return;
    gap.value = btn.getAttribute('data-cloze-bank-term') || '';
    gap.dispatchEvent(new Event('input', { bubbles: true }));
    gap.dispatchEvent(new Event('change', { bubbles: true }));
    gap.focus();
    refreshUsage(widget);
  });

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('cloze-gap')) return;
    var widget = target.closest('.cloze');
    if (widget) refreshUsage(widget);
  });

  document.addEventListener('DOMContentLoaded', function () {
    var widgets = document.querySelectorAll('.cloze--with-bank');
    for (var i = 0; i < widgets.length; i++) refreshUsage(widgets[i]);
  });
})();
