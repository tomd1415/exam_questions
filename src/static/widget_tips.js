// Progressive enhancement for the first-encounter widget-tip panel.
// Clicking "Got it" POSTs to /me/widget-tips/dismiss in the background and
// hides the panel in place so the pupil keeps their place on the question.
//
// This must NOT wrap its button in a <form> — the pupil-answer form already
// wraps the whole paper, and nested forms break the outer form's
// submit/save buttons.
(function () {
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var btn = target.closest('[data-widget-tip-dismiss]');
    if (!btn) return;
    event.preventDefault();
    var panel = btn.closest('[data-widget-tip]');
    if (!panel) return;
    var key = panel.getAttribute('data-widget-tip-key');
    var csrf = panel.getAttribute('data-widget-tip-csrf');
    if (!key || !csrf) return;
    var body = new URLSearchParams();
    body.set('_csrf', csrf);
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
