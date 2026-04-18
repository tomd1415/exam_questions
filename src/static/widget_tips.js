// Progressive enhancement for the first-encounter widget-tip panel.
// Without JS, "Got it" submits the inline form, the page reloads, and
// the tip stops being rendered (server reads users.widget_tips_dismissed).
// With JS, we POST in the background and hide the panel in place so the
// pupil keeps their place on the question.
(function () {
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.hasAttribute('data-widget-tip-form')) return;
    event.preventDefault();
    var panel = form.closest('[data-widget-tip]');
    var keyInput = form.querySelector('input[name="key"]');
    var csrfInput = form.querySelector('input[name="_csrf"]');
    if (!panel || !keyInput || !csrfInput) return;
    var key = keyInput.value;
    var body = new URLSearchParams();
    body.set('_csrf', csrfInput.value);
    body.set('key', key);
    // Optimistically hide so the pupil sees an immediate response.
    panel.setAttribute('hidden', '');
    fetch('/me/widget-tips/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: body.toString(),
    }).catch(function () {
      // If the request failed, restore the panel so the pupil can retry.
      panel.removeAttribute('hidden');
    });
  });
})();
