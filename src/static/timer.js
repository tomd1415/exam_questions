(function () {
  'use strict';

  function init() {
    const timerEl = document.getElementById('paper-timer');
    if (!timerEl) return;
    const minutes = Number(timerEl.getAttribute('data-timer-minutes'));
    const startedAtRaw = timerEl.getAttribute('data-timer-started-at');
    if (!Number.isFinite(minutes) || minutes <= 0 || !startedAtRaw) return;
    const startedAt = Date.parse(startedAtRaw);
    if (Number.isNaN(startedAt)) return;
    const totalSeconds = minutes * 60;

    function currentElapsed() {
      return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    }

    function format(secs) {
      const mm = Math.floor(secs / 60);
      const ss = secs % 60;
      return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }

    function render() {
      const elapsed = currentElapsed();
      const remaining = Math.max(0, totalSeconds - elapsed);
      timerEl.textContent = format(remaining);
      timerEl.classList.remove('paper-timer--warn', 'paper-timer--critical', 'paper-timer--over');
      if (remaining === 0) {
        timerEl.classList.add('paper-timer--over');
      } else if (remaining <= 60) {
        timerEl.classList.add('paper-timer--critical');
      } else if (remaining <= 600) {
        timerEl.classList.add('paper-timer--warn');
      }
    }

    function writeElapsedOnSubmit(form) {
      const input = form.querySelector('input[data-elapsed-input]');
      if (!input) return;
      input.value = String(currentElapsed());
    }

    render();
    const tick = setInterval(render, 1000);

    document.querySelectorAll('form.question-form').forEach(function (form) {
      form.addEventListener('submit', function () {
        writeElapsedOnSubmit(form);
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') render();
    });

    window.addEventListener('beforeunload', function () {
      clearInterval(tick);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
