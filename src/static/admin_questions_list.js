(function () {
  'use strict';

  const root = document.querySelector('[data-admin-questions]');
  if (!root) return;

  const searchInput = root.querySelector('[data-questions-search]');
  const emptyState = root.querySelector('[data-questions-empty]');
  const visibleNote = root.querySelector('[data-questions-visible-note]');
  const visibleCount = root.querySelector('[data-questions-visible]');
  const expandBtn = root.querySelector('[data-questions-expand]');
  const collapseBtn = root.querySelector('[data-questions-collapse]');

  const topicGroups = Array.from(root.querySelectorAll('[data-topic-group]'));
  const subtopicGroups = Array.from(root.querySelectorAll('[data-subtopic-group]'));
  const rows = Array.from(root.querySelectorAll('[data-question-row]'));

  // Remember the user's open/closed state before filtering so we can restore
  // it when the query clears.
  const defaultTopicOpen = new Map(topicGroups.map((el) => [el, el.open]));
  const defaultSubtopicOpen = new Map(subtopicGroups.map((el) => [el, el.open]));

  function normalise(s) {
    return String(s || '')
      .toLowerCase()
      .trim();
  }

  function applyFilter(queryRaw) {
    const q = normalise(queryRaw);
    const active = q.length > 0;

    let shownRows = 0;
    const subtopicShown = new Map();
    const topicShown = new Map();

    for (const row of rows) {
      const hay = row.getAttribute('data-search') || '';
      const match = !active || hay.indexOf(q) !== -1;
      row.hidden = !match;
      if (match) shownRows += 1;
      const sub = row.closest('[data-subtopic-group]');
      if (sub) subtopicShown.set(sub, (subtopicShown.get(sub) || 0) + (match ? 1 : 0));
    }

    for (const sub of subtopicGroups) {
      const shown = subtopicShown.get(sub) || 0;
      sub.hidden = active && shown === 0;
      if (active) {
        sub.open = shown > 0;
      } else {
        sub.open = defaultSubtopicOpen.get(sub) !== false;
      }
      const badge = sub.querySelector('[data-subtopic-count]');
      if (badge) {
        badge.textContent = active ? shown + ' / ' + badge.dataset.total : badge.dataset.total;
      }
      const topic = sub.closest('[data-topic-group]');
      if (topic) topicShown.set(topic, (topicShown.get(topic) || 0) + shown);
    }

    for (const topic of topicGroups) {
      const shown = topicShown.get(topic) || 0;
      topic.hidden = active && shown === 0;
      if (active) {
        topic.open = shown > 0;
      } else {
        topic.open = defaultTopicOpen.get(topic) !== false;
      }
      const badge = topic.querySelector('[data-topic-count]');
      if (badge) {
        badge.textContent = active ? shown + ' / ' + badge.dataset.total : badge.dataset.total;
      }
    }

    if (emptyState) emptyState.hidden = !(active && shownRows === 0);
    if (visibleNote) visibleNote.hidden = !active;
    if (visibleCount) visibleCount.textContent = String(shownRows);
  }

  // Snapshot the initial badge values so toggling filters doesn't lose the
  // original totals.
  for (const sub of subtopicGroups) {
    const badge = sub.querySelector('[data-subtopic-count]');
    if (badge) badge.dataset.total = badge.textContent || '0';
  }
  for (const topic of topicGroups) {
    const badge = topic.querySelector('[data-topic-count]');
    if (badge) badge.dataset.total = badge.textContent || '0';
  }

  if (searchInput) {
    let timer = null;
    searchInput.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        applyFilter(searchInput.value);
      }, 60);
    });
    // Esc clears the search.
    searchInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && searchInput.value) {
        searchInput.value = '';
        applyFilter('');
      }
    });
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', function () {
      for (const t of topicGroups) t.open = true;
      for (const s of subtopicGroups) s.open = true;
    });
  }
  if (collapseBtn) {
    collapseBtn.addEventListener('click', function () {
      for (const t of topicGroups) t.open = false;
      for (const s of subtopicGroups) s.open = false;
    });
  }
})();
