(function () {
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var submitter = event.submitter;
    var message = null;
    if (submitter && submitter.hasAttribute('data-confirm')) {
      message = submitter.getAttribute('data-confirm');
    } else if (form.hasAttribute('data-confirm')) {
      message = form.getAttribute('data-confirm');
    }
    if (!message) return;
    if (!window.confirm(message)) {
      event.preventDefault();
    }
  });
})();
