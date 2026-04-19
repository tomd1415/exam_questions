// Step-1 wizard enhancement: filter the topic <select> by the chosen
// component and the subtopic <select> by the chosen topic. Server-side
// validation is the safety net (parseStep1 rejects mismatches); this just
// stops teachers picking a 4.3.1 subtopic under a 1.1 topic in the first
// place.
(function () {
  'use strict';
  var componentSel = document.querySelector('select[name="component_code"]');
  var topicSel = document.querySelector('select[name="topic_code"]');
  var subtopicSel = document.querySelector('select[name="subtopic_code"]');
  if (!componentSel || !topicSel || !subtopicSel) return;

  function applyFilter(child, attrName, parentValue) {
    var keepCurrent = false;
    var options = child.querySelectorAll('option');
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (opt.value === '') {
        opt.hidden = false;
        continue;
      }
      var matches = parentValue === '' || opt.getAttribute(attrName) === parentValue;
      opt.hidden = !matches;
      if (matches && child.value === opt.value) keepCurrent = true;
    }
    var groups = child.querySelectorAll('optgroup');
    for (var j = 0; j < groups.length; j++) {
      var grp = groups[j];
      var anyVisible = false;
      var grpOpts = grp.querySelectorAll('option');
      for (var k = 0; k < grpOpts.length; k++) {
        if (!grpOpts[k].hidden) {
          anyVisible = true;
          break;
        }
      }
      grp.hidden = !anyVisible;
    }
    if (!keepCurrent) child.value = '';
  }

  function refresh() {
    applyFilter(topicSel, 'data-component', componentSel.value);
    applyFilter(subtopicSel, 'data-topic', topicSel.value);
  }

  // Given an <option value>, find its parent on the sibling select. Used to
  // walk the subtopic → topic → component chain when the teacher picks a
  // subtopic first (the most natural path, because subtopic codes like
  // "1.1.1" fully determine their ancestors).
  function parentOf(child, attrName, childValue) {
    if (!childValue) return '';
    var opt = child.querySelector('option[value="' + childValue + '"]');
    return opt ? opt.getAttribute(attrName) || '' : '';
  }

  componentSel.addEventListener('change', refresh);
  topicSel.addEventListener('change', function () {
    // Auto-fill component if the teacher jumped straight to a topic.
    var comp = parentOf(topicSel, 'data-component', topicSel.value);
    if (comp && componentSel.value !== comp) componentSel.value = comp;
    applyFilter(subtopicSel, 'data-topic', topicSel.value);
  });
  subtopicSel.addEventListener('change', function () {
    // Subtopic → topic → component: set ancestors, then re-apply filters
    // so the other dropdowns reflect the newly-chosen scope.
    var topic = parentOf(subtopicSel, 'data-topic', subtopicSel.value);
    if (topic && topicSel.value !== topic) topicSel.value = topic;
    var comp = parentOf(topicSel, 'data-component', topicSel.value);
    if (comp && componentSel.value !== comp) componentSel.value = comp;
    refresh();
  });
  refresh();
})();
