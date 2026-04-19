// Live-rebuild of the correct-answer pickers on the per-widget editor
// (step 5 of the wizard). The server seeds the picker from `part_config`
// at GET time, so without this script the teacher has to Save/Continue
// and come back before the picker reflects edited options. With it, the
// picker rebuilds on every input event in the source textareas.
//
// Each widget editor's root marks itself with `data-widget-editor="<type>"`
// and exposes the source inputs the picker depends on. State (which
// boxes were ticked, which selects were chosen) is preserved across
// rebuilds by *value* (the option text, the row text), never by index —
// reordering options in the textarea must keep the right ticks attached
// to the right text.

(function () {
  'use strict';

  function lines(textarea) {
    if (!textarea) return [];
    return textarea.value
      .split(/\r?\n/)
      .map(function (l) {
        return l.trim();
      })
      .filter(function (l) {
        return l.length > 0;
      });
  }

  function uniq(arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) {
        seen[arr[i]] = true;
        out.push(arr[i]);
      }
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -------------------------------------------------------------------
  // multiple_choice + tick_box: textarea[name=options] -> checkbox list
  // -------------------------------------------------------------------

  function bindOptionsCheckboxList(root) {
    var optionsTa = root.querySelector('textarea[name="options"]');
    var picker = root.querySelector('[data-picker="correct-options"]');
    var emptyHint = root.querySelector('[data-picker-empty]');
    if (!optionsTa || !picker) return;

    function snapshotTicked() {
      var ticked = Object.create(null);
      var inputs = picker.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].checked) {
          var lbl = inputs[i].getAttribute('data-option-text');
          if (lbl) ticked[lbl] = true;
        }
      }
      return ticked;
    }

    function rebuild() {
      var opts = uniq(lines(optionsTa));
      var ticked = snapshotTicked();
      if (opts.length === 0) {
        picker.innerHTML = '';
        if (emptyHint) emptyHint.hidden = false;
        return;
      }
      if (emptyHint) emptyHint.hidden = true;
      var html = '';
      for (var i = 0; i < opts.length; i++) {
        var opt = opts[i];
        var checked = ticked[opt] ? ' checked' : '';
        html +=
          '<label class="form-checkbox">' +
          '<input type="checkbox" name="correct_' +
          i +
          '"' +
          ' data-option-text="' +
          escapeHtml(opt) +
          '"' +
          checked +
          ' />' +
          '<span>' +
          escapeHtml(opt) +
          '</span>' +
          '</label>';
      }
      picker.innerHTML = html;
    }

    optionsTa.addEventListener('input', rebuild);
    rebuild();
  }

  // -------------------------------------------------------------------
  // matrix_tick_single: rows + columns -> per-row radio column
  // -------------------------------------------------------------------

  function bindMatrixSingle(root) {
    var rowsTa = root.querySelector('textarea[name="rows"]');
    var colsTa = root.querySelector('textarea[name="columns"]');
    var picker = root.querySelector('[data-picker="matrix-single"]');
    var emptyHint = root.querySelector('[data-picker-empty]');
    if (!rowsTa || !colsTa || !picker) return;

    function snapshotPicks() {
      // (rowText) -> picked column text
      var picks = Object.create(null);
      var inputs = picker.querySelectorAll('input[type="radio"]:checked');
      for (var i = 0; i < inputs.length; i++) {
        var rowText = inputs[i].getAttribute('data-row-text');
        if (rowText) picks[rowText] = inputs[i].value;
      }
      return picks;
    }

    function rebuild() {
      var rows = uniq(lines(rowsTa));
      var cols = uniq(lines(colsTa));
      var picks = snapshotPicks();
      if (rows.length === 0 || cols.length === 0) {
        picker.innerHTML = '';
        if (emptyHint) emptyHint.hidden = false;
        return;
      }
      if (emptyHint) emptyHint.hidden = true;
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        html +=
          '<div class="matrix-correct__row">' +
          '<span class="matrix-correct__label">' +
          escapeHtml(row) +
          '</span>';
        for (var j = 0; j < cols.length; j++) {
          var col = cols[j];
          var checked = picks[row] === col ? ' checked' : '';
          html +=
            '<label class="matrix-correct__choice">' +
            '<input type="radio" name="correct_' +
            i +
            '"' +
            ' value="' +
            escapeHtml(col) +
            '"' +
            ' data-row-text="' +
            escapeHtml(row) +
            '"' +
            checked +
            ' />' +
            '<span>' +
            escapeHtml(col) +
            '</span>' +
            '</label>';
        }
        html += '</div>';
      }
      picker.innerHTML = html;
    }

    rowsTa.addEventListener('input', rebuild);
    colsTa.addEventListener('input', rebuild);
    rebuild();
  }

  // -------------------------------------------------------------------
  // matrix_tick_multi: rows + columns -> checkbox grid
  // -------------------------------------------------------------------

  function bindMatrixMulti(root) {
    var rowsTa = root.querySelector('textarea[name="rows"]');
    var colsTa = root.querySelector('textarea[name="columns"]');
    var picker = root.querySelector('[data-picker="matrix-multi"]');
    var emptyHint = root.querySelector('[data-picker-empty]');
    if (!rowsTa || !colsTa || !picker) return;

    function snapshotTicks() {
      // "rowText|colText" -> true
      var ticks = Object.create(null);
      var inputs = picker.querySelectorAll('input[type="checkbox"]:checked');
      for (var i = 0; i < inputs.length; i++) {
        var key = inputs[i].getAttribute('data-cell-key');
        if (key) ticks[key] = true;
      }
      return ticks;
    }

    function rebuild() {
      var rows = uniq(lines(rowsTa));
      var cols = uniq(lines(colsTa));
      var ticks = snapshotTicks();
      if (rows.length === 0 || cols.length === 0) {
        picker.innerHTML = '';
        if (emptyHint) emptyHint.hidden = false;
        return;
      }
      if (emptyHint) emptyHint.hidden = true;
      var html = '<table class="matrix-multi-editor__table"><thead><tr><th scope="col">Row</th>';
      for (var c = 0; c < cols.length; c++)
        html += '<th scope="col">' + escapeHtml(cols[c]) + '</th>';
      html += '</tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        html += '<tr><th scope="row">' + escapeHtml(row) + '</th>';
        for (var j = 0; j < cols.length; j++) {
          var col = cols[j];
          var key = row + '|' + col;
          var checked = ticks[key] ? ' checked' : '';
          html +=
            '<td>' +
            '<label class="visually-hidden" for="cell_' +
            i +
            '_' +
            j +
            '">' +
            escapeHtml(row) +
            ' &mdash; ' +
            escapeHtml(col) +
            '</label>' +
            '<input type="checkbox" id="cell_' +
            i +
            '_' +
            j +
            '" name="cell_' +
            i +
            '_' +
            j +
            '"' +
            ' data-cell-key="' +
            escapeHtml(key) +
            '"' +
            checked +
            ' />' +
            '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      picker.innerHTML = html;
    }

    rowsTa.addEventListener('input', rebuild);
    colsTa.addEventListener('input', rebuild);
    rebuild();
  }

  // -------------------------------------------------------------------
  // matching: left + right -> per-left select
  // -------------------------------------------------------------------

  function bindMatching(root) {
    var leftTa = root.querySelector('textarea[name="left"]');
    var rightTa = root.querySelector('textarea[name="right"]');
    var picker = root.querySelector('[data-picker="matching"]');
    var emptyHint = root.querySelector('[data-picker-empty]');
    if (!leftTa || !rightTa || !picker) return;

    function snapshotPicks() {
      // (leftText) -> picked right text
      var picks = Object.create(null);
      var selects = picker.querySelectorAll('select');
      for (var i = 0; i < selects.length; i++) {
        var lt = selects[i].getAttribute('data-left-text');
        var optText =
          selects[i].selectedOptions && selects[i].selectedOptions[0]
            ? selects[i].selectedOptions[0].getAttribute('data-right-text') || ''
            : '';
        if (lt && optText) picks[lt] = optText;
      }
      return picks;
    }

    function rebuild() {
      var left = uniq(lines(leftTa));
      var right = uniq(lines(rightTa));
      var picks = snapshotPicks();
      if (left.length === 0 || right.length === 0) {
        picker.innerHTML = '';
        if (emptyHint) emptyHint.hidden = false;
        return;
      }
      if (emptyHint) emptyHint.hidden = true;
      var html = '';
      for (var i = 0; i < left.length; i++) {
        var lbl = left[i];
        html +=
          '<div class="matching-pairs__row">' +
          '<label for="right_for_' +
          i +
          '">' +
          escapeHtml(lbl) +
          '</label>' +
          '<select id="right_for_' +
          i +
          '" name="right_for_' +
          i +
          '"' +
          ' data-left-text="' +
          escapeHtml(lbl) +
          '" required>' +
          '<option value="">&mdash; pick &mdash;</option>';
        for (var j = 0; j < right.length; j++) {
          var r = right[j];
          var sel = picks[lbl] === r ? ' selected' : '';
          html +=
            '<option value="' +
            j +
            '" data-right-text="' +
            escapeHtml(r) +
            '"' +
            sel +
            '>' +
            escapeHtml(r) +
            '</option>';
        }
        html += '</select></div>';
      }
      picker.innerHTML = html;
    }

    leftTa.addEventListener('input', rebuild);
    rightTa.addEventListener('input', rebuild);
    rebuild();
  }

  // -------------------------------------------------------------------
  // trace_table: columns + rows count -> per-cell editor grid
  // -------------------------------------------------------------------

  function bindTraceTable(root) {
    var colsTa = root.querySelector('textarea[name="columns"]');
    var rowsInput = root.querySelector('input[name="rows"]');
    var picker = root.querySelector('[data-picker="trace-grid"]');
    var emptyHint = root.querySelector('[data-picker-empty]');
    if (!colsTa || !rowsInput || !picker) return;

    function snapshot() {
      // key "rowIdx|colName" -> { mode, value }
      var snap = Object.create(null);
      var selects = picker.querySelectorAll('select[data-cell-key]');
      for (var i = 0; i < selects.length; i++) {
        var key = selects[i].getAttribute('data-cell-key');
        snap[key] = snap[key] || { mode: 'decorative', value: '' };
        snap[key].mode = selects[i].value;
      }
      var inputs = picker.querySelectorAll('input[data-cell-key]');
      for (var k = 0; k < inputs.length; k++) {
        var key2 = inputs[k].getAttribute('data-cell-key');
        snap[key2] = snap[key2] || { mode: 'decorative', value: '' };
        snap[key2].value = inputs[k].value;
      }
      return snap;
    }

    function rebuild() {
      var cols = uniq(lines(colsTa));
      var rows = parseInt(rowsInput.value, 10);
      if (!Number.isFinite(rows) || rows < 1) rows = 0;
      if (rows > 50) rows = 50;
      var snap = snapshot();
      if (cols.length === 0 || rows === 0) {
        picker.innerHTML = '';
        if (emptyHint) emptyHint.hidden = false;
        return;
      }
      if (emptyHint) emptyHint.hidden = true;
      var legend =
        '<ul class="trace-grid-editor__legend">' +
        '<li><span class="trace-grid-editor__swatch trace-grid-editor__swatch--prefill"></span> Pre-filled (read-only for pupils)</li>' +
        '<li><span class="trace-grid-editor__swatch trace-grid-editor__swatch--expected"></span> Expected (pupil must fill in)</li>' +
        '<li><span class="trace-grid-editor__swatch trace-grid-editor__swatch--decorative"></span> Decorative (left blank, not marked)</li>' +
        '</ul>';
      var html =
        legend + '<table class="trace-grid-editor__table"><thead><tr><th scope="col">Row</th>';
      for (var c = 0; c < cols.length; c++)
        html += '<th scope="col">' + escapeHtml(cols[c]) + '</th>';
      html += '</tr></thead><tbody>';
      for (var r = 0; r < rows; r++) {
        html += '<tr><th scope="row">' + (r + 1) + '</th>';
        for (var c2 = 0; c2 < cols.length; c2++) {
          var col = cols[c2];
          var key = r + '|' + col;
          var prev = snap[key] || { mode: 'decorative', value: '' };
          var modeId = 'mode_' + r + '_' + c2;
          var valId = 'value_' + r + '_' + c2;
          html +=
            '<td class="trace-grid-editor__cell trace-grid-editor__cell--' +
            prev.mode +
            '">' +
            '<label class="visually-hidden" for="' +
            modeId +
            '">Row ' +
            (r + 1) +
            ', ' +
            escapeHtml(col) +
            ' mode</label>' +
            '<select id="' +
            modeId +
            '" name="' +
            modeId +
            '" data-cell-key="' +
            escapeHtml(key) +
            '">' +
            '<option value="decorative"' +
            (prev.mode === 'decorative' ? ' selected' : '') +
            '>Decorative</option>' +
            '<option value="prefill"' +
            (prev.mode === 'prefill' ? ' selected' : '') +
            '>Pre-filled</option>' +
            '<option value="expected"' +
            (prev.mode === 'expected' ? ' selected' : '') +
            '>Expected</option>' +
            '</select>' +
            '<label class="visually-hidden" for="' +
            valId +
            '">Row ' +
            (r + 1) +
            ', ' +
            escapeHtml(col) +
            ' value</label>' +
            '<input id="' +
            valId +
            '" name="' +
            valId +
            '" type="text"' +
            ' value="' +
            escapeHtml(prev.value) +
            '" data-cell-key="' +
            escapeHtml(key) +
            '" />' +
            '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      picker.innerHTML = html;
    }

    colsTa.addEventListener('input', rebuild);
    rowsInput.addEventListener('input', rebuild);
    rebuild();
  }

  // -------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------

  var binders = {
    multiple_choice: bindOptionsCheckboxList,
    tick_box: bindOptionsCheckboxList,
    matrix_tick_single: bindMatrixSingle,
    matrix_tick_multi: bindMatrixMulti,
    matching: bindMatching,
    trace_table: bindTraceTable,
  };

  var roots = document.querySelectorAll('[data-widget-editor]');
  for (var i = 0; i < roots.length; i++) {
    var type = roots[i].getAttribute('data-widget-editor');
    var bind = binders[type];
    if (bind) bind(roots[i]);
  }
})();
