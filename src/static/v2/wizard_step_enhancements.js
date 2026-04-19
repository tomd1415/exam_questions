// Wizard v2 step-level enhancements.
//
// Shared glue for per-step niceties that don't deserve their own file:
//   • [data-wizard-char-counter="<id>"] on a textarea/input writes its
//     current length into `#<id> [data-char-count]` on every input event.
//   • [data-wizard-difficulty] couples a <input type="range"> with a
//     hidden <select> so the slider drives the form value while the
//     select remains as a no-JS fallback and a screen-reader equivalent.
//   • [data-wizard-hold-confirm] on a submit button prevents the default
//     submit until the user pointer-downs for the configured duration
//     (default 1200 ms). Cancels on pointer-up / pointer-leave / blur.
//     The button label rotates through three `data-hold-label-*`
//     attributes so the user sees Hold → Keep holding → Publishing.

(function () {
  'use strict';

  function initCharCounters() {
    const fields = document.querySelectorAll('[data-wizard-char-counter]');
    fields.forEach(function (field) {
      const id = field.getAttribute('data-wizard-char-counter');
      if (!id) return;
      const display = document.getElementById(id);
      if (!display) return;
      const counter = display.querySelector('[data-char-count]');
      if (!counter) return;
      const update = function () {
        counter.textContent = String((field.value || '').length);
      };
      field.addEventListener('input', update);
      update();
    });
  }

  function initDifficultySlider() {
    const root = document.querySelector('[data-wizard-difficulty]');
    if (!root) return;
    const range = root.querySelector('[data-wizard-difficulty-range]');
    const select = root.querySelector('[data-wizard-difficulty-select]');
    const label = root.querySelector('[data-wizard-difficulty-current]');
    if (!range || !select) return;
    // Reveal the range control to sighted users; the select stays in the
    // DOM for the no-JS path but is visually hidden when JS is live.
    select.setAttribute('aria-hidden', 'true');
    range.addEventListener('input', function () {
      select.value = range.value;
      if (label) label.textContent = range.value;
      if (typeof window.__wizardAutosavePulse === 'function') {
        window.__wizardAutosavePulse();
      }
    });
  }

  function initHoldConfirm() {
    const btns = document.querySelectorAll('[data-wizard-hold-confirm]');
    btns.forEach(function (btn) {
      const duration = parseInt(btn.getAttribute('data-hold-duration') || '1200', 10) || 1200;
      const idle = btn.getAttribute('data-hold-label-idle') || btn.textContent;
      const progress = btn.getAttribute('data-hold-label-progress') || 'Hold…';
      const done = btn.getAttribute('data-hold-label-done') || 'Submitting…';
      let timer = null;
      let confirmed = false;

      function reset() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!confirmed) {
          btn.innerHTML = idle;
          btn.removeAttribute('data-holding');
        }
      }

      btn.innerHTML = idle;
      btn.setAttribute('aria-describedby', btn.getAttribute('aria-describedby') || '');

      btn.addEventListener('click', function (e) {
        if (!confirmed) {
          e.preventDefault();
        }
      });
      btn.addEventListener('pointerdown', function () {
        if (confirmed) return;
        btn.setAttribute('data-holding', '');
        btn.innerHTML = progress;
        timer = window.setTimeout(function () {
          confirmed = true;
          btn.innerHTML = done;
          const form = btn.closest('form');
          if (form) form.submit();
        }, duration);
      });
      btn.addEventListener('pointerup', reset);
      btn.addEventListener('pointerleave', reset);
      btn.addEventListener('blur', reset);
      btn.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && !confirmed) {
          e.preventDefault();
        }
      });
    });
  }

  function init() {
    initCharCounters();
    initDifficultySlider();
    initHoldConfirm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
