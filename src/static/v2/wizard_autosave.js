// Wizard v2 loud autosave.
//
// Binds to the step form's [data-autosave-url]. Debounced 800ms on `input`
// and immediate on `change`/`blur`. Updates [data-autosave-chip] data-state
// so the sticky action bar communicates save status (Saved / Saving… /
// Offline — will retry / Save failed). Offline handling: failed requests
// are re-tried on the `online` event with exponential backoff.
//
// Also captures the pre-autosave form state and exposes a 10-second
// "Revert last change" button inside the chip area. Clicking it re-POSTs
// the captured prior state to the same autosave endpoint.

(function () {
  'use strict';

  const DEBOUNCE_MS = 800;
  const REVERT_WINDOW_MS = 10000;
  const MAX_BACKOFF_MS = 30000;

  function throttleId(form) {
    return form.getAttribute('data-autosave-url') || '';
  }

  function getChip() {
    return document.querySelector('[data-autosave-chip]');
  }

  function setState(state, label) {
    const chip = getChip();
    if (!chip) return;
    chip.setAttribute('data-state', state);
    const l = chip.querySelector('.wizard__autosave-label');
    if (l) l.textContent = label;
  }

  function serialiseForm(form) {
    const fd = new FormData(form);
    return new URLSearchParams(fd).toString();
  }

  function initAutosave() {
    const form = document.querySelector('[data-wizard-editor][data-autosave-url]');
    if (!form) return;
    const url = form.getAttribute('data-autosave-url');
    if (!url) return;

    let pending = null;
    let inflight = false;
    let lastSavedSerialised = serialiseForm(form);
    let priorSnapshot = lastSavedSerialised;
    let revertTimer = null;

    function scheduleSend() {
      if (pending) clearTimeout(pending);
      pending = window.setTimeout(send, DEBOUNCE_MS);
    }

    async function send(retryAttempt) {
      if (inflight) {
        scheduleSend();
        return;
      }
      const attempt = typeof retryAttempt === 'number' ? retryAttempt : 0;
      const body = serialiseForm(form);
      if (body === lastSavedSerialised) {
        return;
      }
      inflight = true;
      setState('saving', 'Saving\u2026');
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body,
        });
        if (res.status === 204) {
          priorSnapshot = lastSavedSerialised;
          lastSavedSerialised = body;
          setState('saved', 'Saved');
          showRevert();
        } else if (res.status === 422) {
          setState('error', 'Check the highlighted fields');
        } else {
          throw new Error('autosave failed: ' + res.status);
        }
      } catch (_e) {
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt));
        setState(
          navigator.onLine ? 'error' : 'offline',
          navigator.onLine ? 'Save failed \u2014 retrying' : 'Offline \u2014 will retry',
        );
        window.setTimeout(function () {
          send(attempt + 1);
        }, backoff);
      } finally {
        inflight = false;
      }
    }

    function showRevert() {
      const chip = getChip();
      if (!chip) return;
      let btn = chip.querySelector('[data-wizard-revert]');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wizard__revert-btn';
        btn.setAttribute('data-wizard-revert', '');
        btn.textContent = 'Revert last change';
        btn.addEventListener('click', onRevertClick);
        chip.appendChild(btn);
      }
      btn.hidden = false;
      if (revertTimer) clearTimeout(revertTimer);
      revertTimer = window.setTimeout(function () {
        if (btn) btn.hidden = true;
      }, REVERT_WINDOW_MS);
    }

    function onRevertClick() {
      const target = priorSnapshot;
      if (!target || target === lastSavedSerialised) return;
      setState('saving', 'Reverting\u2026');
      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: target,
      })
        .then(function (res) {
          if (res.status === 204) {
            lastSavedSerialised = target;
            setState('saved', 'Reverted');
            restoreFormFromSerialised(target);
          } else {
            setState('error', 'Could not revert');
          }
        })
        .catch(function () {
          setState('error', 'Could not revert');
        });
    }

    function restoreFormFromSerialised(serialised) {
      const params = new URLSearchParams(serialised);
      const seen = {};
      params.forEach(function (_v, k) {
        seen[k] = true;
      });
      // Overwrite form field values. Checkboxes + radios rebuild from
      // the values in params; unchecked ones are left alone.
      params.forEach(function (value, name) {
        const fields = form.querySelectorAll('[name="' + CSS.escape(name) + '"]');
        fields.forEach(function (f) {
          if (f.type === 'checkbox' || f.type === 'radio') {
            f.checked = f.value === value;
          } else {
            f.value = value;
          }
        });
      });
    }

    form.addEventListener('input', scheduleSend);
    form.addEventListener('change', function (e) {
      const t = e.target;
      if (t && (t.type === 'checkbox' || t.type === 'radio' || t.tagName === 'SELECT')) {
        send();
      }
    });
    form.addEventListener(
      'blur',
      function () {
        send();
      },
      true,
    );
    window.addEventListener('online', function () {
      if (serialiseForm(form) !== lastSavedSerialised) send();
    });

    // Expose a window-scoped helper so wizard_shortcuts.js can pulse
    // a save without re-reading the form DOM.
    window.__wizardAutosavePulse = function () {
      send();
    };

    // Namespaces ensures two wizard pages on the same tab don't clobber
    // each other's state (admin pages open in new tabs typically but
    // iframe preview pages could in principle share).
    form.setAttribute('data-autosave-key', throttleId(form));
    setState('saved', 'Saved');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutosave);
  } else {
    initAutosave();
  }
})();
