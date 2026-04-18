(function () {
  'use strict';

  function updateFieldsetCounter(fieldset) {
    var counter = fieldset.querySelector('[data-tick-counter]');
    if (!counter) return;
    var current = counter.querySelector('[data-current]');
    if (!current) return;
    var ticked = fieldset.querySelectorAll('input[type="checkbox"]:checked').length;
    current.textContent = String(ticked);
    var target = parseInt(counter.getAttribute('data-target') || '0', 10);
    counter.classList.toggle('is-met', target > 0 && ticked === target);
    counter.classList.toggle('is-over', target > 0 && ticked > target);
  }

  function updateRowCounter(rowCounter, table) {
    var rowField = rowCounter.getAttribute('data-row-field') || '';
    if (!rowField) return;
    var current = rowCounter.querySelector('[data-current]');
    if (!current) return;
    var inputs = table.querySelectorAll(
      'input[type="checkbox"][name="' + rowField.replace(/"/g, '\\"') + '"]:checked',
    );
    var ticked = inputs.length;
    current.textContent = String(ticked);
    var target = parseInt(rowCounter.getAttribute('data-target') || '0', 10);
    rowCounter.classList.toggle('is-met', target > 0 && ticked === target);
    rowCounter.classList.toggle('is-over', target > 0 && ticked > target);
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'checkbox') return;

    var fieldset = target.closest('fieldset.widget--tick-exactly');
    if (fieldset) updateFieldsetCounter(fieldset);

    var table = target.closest('table.matrix-tick-multi');
    if (table) {
      var rowCounters = table.querySelectorAll('[data-tick-counter-row]');
      for (var i = 0; i < rowCounters.length; i++) {
        updateRowCounter(rowCounters[i], table);
      }
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    var fieldsets = document.querySelectorAll('fieldset.widget--tick-exactly');
    for (var i = 0; i < fieldsets.length; i++) updateFieldsetCounter(fieldsets[i]);
    var tables = document.querySelectorAll('table.matrix-tick-multi');
    for (var j = 0; j < tables.length; j++) {
      var rowCounters = tables[j].querySelectorAll('[data-tick-counter-row]');
      for (var k = 0; k < rowCounters.length; k++) {
        updateRowCounter(rowCounters[k], tables[j]);
      }
    }
  });
})();
