(function () {
  'use strict';

  const INPUT_DEBOUNCE_MS = 5000;

  function findCsrfToken(root) {
    const el = root.querySelector('input[name="_csrf"]');
    return el ? el.value : null;
  }

  function findAttemptId(root) {
    const form = root.querySelector('form.question-form');
    if (!form) return null;
    const action = form.getAttribute('action') || '';
    const m = /\/attempts\/(\d+)\b/.exec(action);
    return m ? m[1] : null;
  }

  function findStatusElement() {
    return document.getElementById('autosave-status');
  }

  function setStatus(state, when) {
    const el = findStatusElement();
    if (!el) return;
    el.dataset.state = state;
    if (state === 'saved' && when) {
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      el.textContent = 'Saved ' + hh + ':' + mm;
    } else if (state === 'saving') {
      el.textContent = 'Saving…';
    } else if (state === 'error') {
      el.textContent = 'Autosave paused';
    } else {
      el.textContent = '';
    }
  }

  function readWidgetValue(widget) {
    if (widget.tagName === 'FIELDSET') {
      const radios = widget.querySelectorAll('input[type="radio"]:checked');
      if (radios.length > 0) return radios[0].value;
      const boxes = widget.querySelectorAll('input[type="checkbox"]:checked');
      if (boxes.length > 0) {
        return Array.from(boxes)
          .map(function (b) {
            return b.value;
          })
          .join('\n');
      }
      return '';
    }
    return widget.value || '';
  }

  function attachWidget(widget, ctx) {
    const partId = widget.getAttribute('data-autosave-part-id');
    if (!partId) return;

    let lastSentValue = readWidgetValue(widget);
    let inFlight = false;
    let pendingValue = null;
    let debounceTimer = null;

    async function send(value) {
      if (inFlight) {
        pendingValue = value;
        return;
      }
      if (value === lastSentValue) return;
      inFlight = true;
      setStatus('saving');
      try {
        const res = await fetch('/attempts/' + ctx.attemptId + '/parts/' + partId + '/autosave', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': ctx.csrfToken,
          },
          body: JSON.stringify({ raw_answer: value }),
        });
        if (!res.ok) {
          setStatus('error');
        } else {
          lastSentValue = value;
          setStatus('saved', new Date());
        }
      } catch (_err) {
        setStatus('error');
      } finally {
        inFlight = false;
        if (pendingValue !== null && pendingValue !== lastSentValue) {
          const next = pendingValue;
          pendingValue = null;
          send(next);
        } else {
          pendingValue = null;
        }
      }
    }

    function schedule() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        send(readWidgetValue(widget));
      }, INPUT_DEBOUNCE_MS);
    }

    function flushNow() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      send(readWidgetValue(widget));
    }

    const inputs =
      widget.tagName === 'FIELDSET'
        ? widget.querySelectorAll('input[type="radio"], input[type="checkbox"]')
        : [widget];

    inputs.forEach(function (el) {
      el.addEventListener('input', schedule);
      el.addEventListener('change', schedule);
      el.addEventListener('blur', flushNow);
    });

    ctx.flushers.push(flushNow);
  }

  function init() {
    const root = document;
    const csrfToken = findCsrfToken(root);
    const attemptId = findAttemptId(root);
    if (!csrfToken || !attemptId) return;

    const ctx = { csrfToken: csrfToken, attemptId: attemptId, flushers: [] };
    const widgets = root.querySelectorAll('[data-autosave-part-id]');
    if (widgets.length === 0) return;

    widgets.forEach(function (w) {
      attachWidget(w, ctx);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        ctx.flushers.forEach(function (fn) {
          fn();
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
