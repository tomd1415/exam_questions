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

  componentSel.addEventListener('change', refresh);
  topicSel.addEventListener('change', function () {
    applyFilter(subtopicSel, 'data-topic', topicSel.value);
  });
  refresh();
})();
