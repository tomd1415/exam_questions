// "Select-to-gap" affordance for the three cloze editors (free / bank / code).
//
// Same progressive-enhancement contract as the other wizard pickers: the
// `text` and `gaps` textareas stay the source of truth, the server-side
// parser remains the only validator, and teachers without JavaScript still
// author by typing {{id}} markers and gaps lines by hand. This file just
// removes the duplication of "edit the passage, then re-type the same id
// into the gaps textarea."
//
// Editor markup expected (inside a fieldset that contains the `text` and
// `gaps` textareas):
//
//   <div data-widget-editor="cloze" data-cloze-picker>
//     <div data-cloze-toolbar>
//       <button type="button" data-cloze-tool="make-gap">Make gap</button>
//       <span data-cloze-hint></span>
//     </div>
//   </div>

(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  function slugify(raw) {
    var s = String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s.length > 0 ? s.slice(0, 24) : '';
  }

  function collectExistingIds(textEl, gapsEl) {
    var ids = Object.create(null);
    var re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
    var m;
    var txt = textEl ? textEl.value : '';
    while ((m = re.exec(txt)) !== null) ids[m[1]] = true;
    if (gapsEl) {
      var lines = (gapsEl.value || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var first = lines[i].split('|')[0].trim();
        if (first.length > 0) ids[first] = true;
      }
    }
    return ids;
  }

  function uniqueId(base, taken) {
    var candidate = base || 'gap';
    if (!taken[candidate]) return candidate;
    for (var i = 2; i < 1000; i++) {
      var suffix = candidate + '_' + i;
      if (!taken[suffix]) return suffix;
    }
    return candidate + '_' + Date.now();
  }

  function fireInput(el) {
    var ev;
    try {
      ev = new Event('input', { bubbles: true });
    } catch (_) {
      ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
    }
    el.dispatchEvent(ev);
  }

  function appendGapLine(gapsEl, id, answer) {
    var existing = (gapsEl.value || '').split('\n');
    for (var i = 0; i < existing.length; i++) {
      var firstField = existing[i].split('|')[0].trim();
      if (firstField === id) return false;
    }
    var tail = gapsEl.value && !/\n$/.test(gapsEl.value) ? '\n' : '';
    gapsEl.value = gapsEl.value + tail + id + '|' + answer;
    return true;
  }

  function setHint(hintEl, message) {
    if (!hintEl) return;
    hintEl.textContent = message;
    if (message) {
      window.clearTimeout(hintEl.__clozeHintTimer);
      hintEl.__clozeHintTimer = window.setTimeout(function () {
        hintEl.textContent = '';
      }, 4000);
    }
  }

  function makeGap(textEl, gapsEl, hintEl) {
    if (!textEl) return;
    var start = typeof textEl.selectionStart === 'number' ? textEl.selectionStart : 0;
    var end = typeof textEl.selectionEnd === 'number' ? textEl.selectionEnd : start;
    var value = textEl.value || '';
    var selection = value.slice(start, end);
    var taken = collectExistingIds(textEl, gapsEl);
    var baseId = selection ? slugify(selection) : 'gap';
    if (!baseId) baseId = 'gap';
    var id = uniqueId(baseId, taken);
    var marker = '{{' + id + '}}';
    var answer = selection.trim();

    textEl.value = value.slice(0, start) + marker + value.slice(end);
    var caret = start + marker.length;
    try {
      textEl.focus();
      textEl.setSelectionRange(caret, caret);
    } catch (_) {
      // some browsers dislike setSelectionRange on unfocused elements
    }
    fireInput(textEl);

    if (gapsEl) {
      var added = appendGapLine(gapsEl, id, answer);
      if (added) fireInput(gapsEl);
    }

    setHint(
      hintEl,
      selection
        ? 'Gapped "' + selection + '" as {{' + id + '}}.'
        : 'Inserted {{' + id + '}} — fill the accept list in the gaps box.',
    );
  }

  function mount(root) {
    var fieldset = root.closest('fieldset');
    if (!fieldset) return;
    var textEl = fieldset.querySelector('textarea[name="text"]');
    var gapsEl = fieldset.querySelector('textarea[name="gaps"]');
    if (!textEl || !gapsEl) return;
    var toolbar = root.querySelector('[data-cloze-toolbar]');
    if (!toolbar) return;
    var hintEl = root.querySelector('[data-cloze-hint]');

    toolbar.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-cloze-tool]');
      if (!btn) return;
      evt.preventDefault();
      var tool = btn.getAttribute('data-cloze-tool');
      if (tool === 'make-gap') makeGap(textEl, gapsEl, hintEl);
    });
  }

  var roots = document.querySelectorAll('[data-widget-editor="cloze"][data-cloze-picker]');
  for (var i = 0; i < roots.length; i++) mount(roots[i]);
})();
