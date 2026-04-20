// Matching-widget desktop enhancement.
//
// The baseline UI (always rendered) is one native <select> per left row,
// listing every right option plus a blank default. That is what the form
// POSTs and is the authoritative source of pupil state. Keyboard-only
// and screen-reader users interact with the <select>s directly.
//
// This script progressively enhances the same markup on devices with a
// fine pointer and a viewport >= 720px: it hides the <select>s, reveals
// clickable endpoints on the left, and draws SVG lines from each paired
// endpoint to its chosen right target. Clicking an endpoint arms a
// "pending" line that follows the cursor; clicking a right target
// commits the pair by setting the associated <select>'s value and
// dispatching `input`/`change` so autosave picks it up.
//
// Pure JS, no dependencies. If this script fails to load, every pupil
// still has a usable matching UI via the <select>s.

(function () {
  'use strict';

  var MIN_WIDTH = 720;

  function isEnhanceable() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (window.innerWidth < MIN_WIDTH) return false;
    // Coarse pointer (touch-first) devices keep the <select> UI — it's
    // easier to target than an SVG endpoint on a finger.
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false;
    return true;
  }

  function setSelectValue(select, value) {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function enhance(widget) {
    widget.classList.add('matching--enhanced');
    var overlay = widget.querySelector('[data-matching-overlay]');
    if (!overlay) return;

    var endpoints = Array.prototype.slice.call(widget.querySelectorAll('[data-matching-endpoint]'));
    var targets = Array.prototype.slice.call(widget.querySelectorAll('[data-matching-right]'));
    endpoints.forEach(function (ep) {
      ep.removeAttribute('aria-hidden');
      ep.setAttribute('tabindex', '0');
      ep.setAttribute('role', 'button');
    });
    targets.forEach(function (tg) {
      tg.setAttribute('tabindex', '0');
      tg.setAttribute('role', 'button');
    });

    var armed = null;

    function svgNS(name) {
      return document.createElementNS('http://www.w3.org/2000/svg', name);
    }

    function boxCentre(el, containerRect) {
      var r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - containerRect.left,
        y: r.top + r.height / 2 - containerRect.top,
      };
    }

    function redraw() {
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      // Compute positions relative to the overlay's own rect, not the
      // widget's — the overlay is inset by the widget's padding (and,
      // in grid-enhanced mode, bounded by its grid area), so using the
      // widget rect would shift every line by that padding amount.
      var overlayRect = overlay.getBoundingClientRect();
      overlay.setAttribute('width', String(overlayRect.width));
      overlay.setAttribute('height', String(overlayRect.height));
      overlay.setAttribute('viewBox', '0 0 ' + overlayRect.width + ' ' + overlayRect.height);
      endpoints.forEach(function (ep) {
        var selectId = ep.getAttribute('data-matching-for');
        if (!selectId) return;
        var select = document.getElementById(selectId);
        if (!select || !select.value) return;
        var target = widget.querySelector('[data-matching-right="' + select.value + '"]');
        if (!target) return;
        var a = boxCentre(ep, overlayRect);
        var b = boxCentre(target, overlayRect);
        var line = svgNS('line');
        line.setAttribute('x1', String(a.x));
        line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x));
        line.setAttribute('y2', String(b.y));
        line.setAttribute('class', 'matching__line');
        overlay.appendChild(line);
      });
    }

    function disarm() {
      if (armed) {
        armed.classList.remove('matching__endpoint--armed');
        armed = null;
      }
    }

    function commit(rightIdx) {
      if (!armed) return;
      var selectId = armed.getAttribute('data-matching-for');
      var select = selectId ? document.getElementById(selectId) : null;
      if (select) setSelectValue(select, String(rightIdx));
      disarm();
      redraw();
    }

    endpoints.forEach(function (ep) {
      ep.addEventListener('click', function (event) {
        event.preventDefault();
        if (armed === ep) {
          disarm();
          return;
        }
        disarm();
        armed = ep;
        ep.classList.add('matching__endpoint--armed');
      });
      ep.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ep.click();
        } else if (event.key === 'Escape') {
          disarm();
        }
      });
    });

    targets.forEach(function (tg) {
      var idx = tg.getAttribute('data-matching-right');
      if (!idx) return;
      tg.addEventListener('click', function (event) {
        if (!armed) return;
        event.preventDefault();
        commit(idx);
      });
      tg.addEventListener('keydown', function (event) {
        if (!armed) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          commit(idx);
        } else if (event.key === 'Escape') {
          disarm();
        }
      });
    });

    widget.addEventListener('change', function (event) {
      if (event.target && event.target.matches && event.target.matches('[data-matching-select]')) {
        redraw();
      }
    });

    window.addEventListener('resize', redraw);
    redraw();
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!isEnhanceable()) return;
    var widgets = document.querySelectorAll('.matching');
    for (var i = 0; i < widgets.length; i++) enhance(widgets[i]);
  });
})();
