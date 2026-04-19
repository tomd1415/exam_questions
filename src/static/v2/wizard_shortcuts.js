// Wizard v2 keyboard shortcuts.
//
// Ignores keystrokes inside inputs/textareas/contenteditable unless the
// shortcut is Alt-modified or a form-submit accelerator (Ctrl/Cmd+Enter,
// Ctrl/Cmd+S). Opens the [data-wizard-shortcut-help] dialog on `?`.

(function () {
  'use strict';

  function isTypingContext(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isModSubmit(e) {
    return (e.ctrlKey || e.metaKey) && e.key === 'Enter';
  }

  function isModSave(e) {
    return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
  }

  function firstRailLinkMatching(predicate) {
    const items = document.querySelectorAll('[data-wizard-rail] [data-step]');
    for (let i = 0; i < items.length; i++) {
      if (predicate(items[i])) return items[i].querySelector('a[href]');
    }
    return null;
  }

  function currentStep() {
    const shell = document.querySelector('[data-wizard-shell]');
    if (!shell) return null;
    const n = parseInt(shell.getAttribute('data-step') || '', 10);
    return Number.isFinite(n) ? n : null;
  }

  function navigateTo(step) {
    const a = firstRailLinkMatching(function (li) {
      return parseInt(li.getAttribute('data-step') || '', 10) === step;
    });
    if (a) window.location.assign(a.getAttribute('href'));
  }

  function openHelpDialog() {
    const dlg = document.querySelector('[data-wizard-shortcut-help]');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    if (!dlg.open) dlg.showModal();
  }

  function focusNearestSearch() {
    const search =
      document.querySelector('[data-wizard-editor] input[type="search"]') ||
      document.querySelector('[data-wizard-editor] input[role="combobox"]') ||
      document.querySelector('[data-wizard-editor] input[type="text"]');
    if (search) {
      search.focus();
      if (typeof search.select === 'function') search.select();
    }
  }

  function focusFirstError() {
    const summary = document.querySelector('[data-wizard-error-summary]');
    if (!summary) return;
    const firstField = document.querySelector('[data-wizard-editor] [aria-invalid="true"]');
    if (firstField) {
      firstField.focus();
      return;
    }
    // Fallback: focus the error summary itself.
    summary.setAttribute('tabindex', '-1');
    summary.focus();
  }

  function submitStep() {
    const form = document.getElementById('wizard-step-form');
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }
  }

  function onKey(e) {
    const typing = isTypingContext(document.activeElement);

    // Form-submit accelerators work even while typing.
    if (isModSubmit(e)) {
      e.preventDefault();
      submitStep();
      return;
    }
    if (isModSave(e)) {
      e.preventDefault();
      if (typeof window.__wizardAutosavePulse === 'function') {
        window.__wizardAutosavePulse();
      }
      return;
    }

    // The dialog handles its own Esc close (method="dialog"), and we
    // want Esc in an input to blur, not navigate.
    if (e.key === 'Escape') {
      if (typing) return;
      const dlg = document.querySelector('[data-wizard-shortcut-help]');
      if (dlg && dlg.open) return;
      window.location.assign('/admin/questions/wizard');
      return;
    }

    if (typing && !e.altKey) return;

    switch (e.key) {
      case '?': {
        e.preventDefault();
        openHelpDialog();
        break;
      }
      case '/': {
        e.preventDefault();
        focusNearestSearch();
        break;
      }
      case '.': {
        e.preventDefault();
        focusFirstError();
        break;
      }
      case '[': {
        e.preventDefault();
        const n = currentStep();
        if (n && n > 1) navigateTo(n - 1);
        break;
      }
      case ']': {
        e.preventDefault();
        const n = currentStep();
        if (n && n < 9) navigateTo(n + 1);
        break;
      }
      default:
        break;
    }
  }

  function init() {
    if (!document.querySelector('[data-wizard-shell]')) return;
    document.addEventListener('keydown', onKey);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
