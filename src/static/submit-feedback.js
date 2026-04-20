(function () {
  'use strict';

  // Gives the pupil instant visual feedback after clicking a submit
  // button on a question form. Before this existed, the page looked
  // frozen between click and redirect, and pupils reported that
  // "nothing happened". See my_notes.md, pupil feedback 20/4/2026.

  function onSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.classList.contains('question-form')) return;

    var submitter = event.submitter;
    if (!submitter || submitter.tagName !== 'BUTTON') return;
    if (submitter.getAttribute('type') !== 'submit') return;

    // Flag prevents double-submits if the pupil hits the button again.
    if (form.dataset.submitting === '1') {
      event.preventDefault();
      return;
    }
    form.dataset.submitting = '1';

    var original = submitter.textContent;
    submitter.disabled = true;
    submitter.setAttribute('aria-busy', 'true');
    submitter.textContent = 'Submitting…';

    var pill = document.createElement('span');
    pill.className = 'submit-progress';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.textContent = 'Saving your answer and marking…';
    submitter.insertAdjacentElement('afterend', pill);

    // Safety net: if the redirect never lands (network error, server
    // 500), undo the lock after 15s so the pupil can retry. The normal
    // flow navigates away well before this fires.
    setTimeout(function () {
      if (form.dataset.submitting !== '1') return;
      form.dataset.submitting = '';
      submitter.disabled = false;
      submitter.removeAttribute('aria-busy');
      submitter.textContent = original;
      if (pill.parentNode) pill.parentNode.removeChild(pill);
    }, 15000);
  }

  document.addEventListener('submit', onSubmit);
})();
