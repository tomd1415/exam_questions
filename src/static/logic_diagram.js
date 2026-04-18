// Logic-diagram widget — pen + clear (Phase 2.5f MVP).
//
// Each `.logic-diagram` widget owns a <canvas> and a hidden input
// (`<name>__image`). The hidden input carries a PNG data URL, which the
// route aggregator stores in `attempt_parts.raw_answer` as
// `image=<dataURL>`. On every stroke we re-export the canvas, write the
// data URL to the hidden input, and dispatch `input`/`change` so the
// existing autosave layer (src/static/autosave.js) flushes it.
//
// Tools: pen (default) and eraser. Clear wipes everything. Both mouse
// and touch are supported. Pointer Events would be neater but plain
// mouse + touch handlers reach a wider browser baseline with no
// behavioural cost on the small surfaces this widget targets.
//
// Pure JS, no dependencies. If this file fails to load, the widget
// falls back to the <noscript> message — pupils on JS-less browsers
// cannot draw, which is documented in HUMAN_TEST_GUIDE §2.5.f.

(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  var PEN_COLOUR = '#111';
  var PEN_WIDTH = 2;
  var ERASER_WIDTH = 18;

  function paintPriorImage(canvas, ctx, dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) return;
    var img = new Image();
    img.onload = function () {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    // Failure to decode (e.g. malformed payload) leaves the canvas blank,
    // which is the right "fail safe" behaviour: the pupil sees the missing
    // drawing and can re-attempt rather than hitting an error.
    img.src = dataUrl;
  }

  function exportImage(canvas, hidden) {
    try {
      var dataUrl = canvas.toDataURL('image/png');
      if (hidden.value === dataUrl) return;
      hidden.value = dataUrl;
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      // toDataURL throws on tainted canvases; we never load cross-origin
      // images so this should never happen in practice. Swallow rather
      // than crash the widget for everyone else on the page.
    }
  }

  function pointerPos(canvas, evt) {
    var rect = canvas.getBoundingClientRect();
    var clientX, clientY;
    if (evt.touches && evt.touches.length > 0) {
      clientX = evt.touches[0].clientX;
      clientY = evt.touches[0].clientY;
    } else {
      clientX = evt.clientX;
      clientY = evt.clientY;
    }
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function init(widget) {
    var canvas = widget.querySelector('[data-logic-diagram-canvas]');
    var hidden = widget.querySelector('[data-logic-diagram-image]');
    var clearBtn = widget.querySelector('[data-logic-diagram-clear]');
    var toolBtns = widget.querySelectorAll('[data-logic-diagram-tool]');
    if (!canvas || !canvas.getContext || !hidden) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PEN_COLOUR;
    ctx.lineWidth = PEN_WIDTH;

    paintPriorImage(canvas, ctx, hidden.value);

    var tool = 'pen';
    function setTool(next) {
      tool = next;
      for (var i = 0; i < toolBtns.length; i++) {
        var btn = toolBtns[i];
        var on = btn.getAttribute('data-logic-diagram-tool') === next;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    for (var i = 0; i < toolBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.preventDefault();
          setTool(btn.getAttribute('data-logic-diagram-tool') || 'pen');
        });
      })(toolBtns[i]);
    }

    var drawing = false;
    var lastPos = null;

    function beginStroke(evt) {
      evt.preventDefault();
      drawing = true;
      lastPos = pointerPos(canvas, evt);
      // Apply the tool settings at stroke-start so a mid-stroke tool change
      // does not retroactively repaint earlier segments.
      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = ERASER_WIDTH;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = PEN_WIDTH;
        ctx.strokeStyle = PEN_COLOUR;
      }
      // A single tap should leave a visible dot, not nothing.
      ctx.beginPath();
      ctx.arc(lastPos.x, lastPos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : PEN_COLOUR;
      ctx.fill();
    }

    function continueStroke(evt) {
      if (!drawing || !lastPos) return;
      evt.preventDefault();
      var pos = pointerPos(canvas, evt);
      ctx.beginPath();
      ctx.moveTo(lastPos.x, lastPos.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastPos = pos;
    }

    function endStroke(evt) {
      if (!drawing) return;
      if (evt && evt.preventDefault) evt.preventDefault();
      drawing = false;
      lastPos = null;
      exportImage(canvas, hidden);
    }

    canvas.addEventListener('mousedown', beginStroke);
    canvas.addEventListener('mousemove', continueStroke);
    window.addEventListener('mouseup', endStroke);
    canvas.addEventListener('mouseleave', function () {
      // Lifting off the canvas mid-stroke commits what we have; the next
      // mousedown will start a fresh stroke. This matches what most paint
      // apps do and keeps the hidden input in sync.
      if (drawing) endStroke();
    });

    canvas.addEventListener('touchstart', beginStroke, { passive: false });
    canvas.addEventListener('touchmove', continueStroke, { passive: false });
    canvas.addEventListener('touchend', endStroke, { passive: false });
    canvas.addEventListener('touchcancel', endStroke, { passive: false });

    if (clearBtn) {
      clearBtn.addEventListener('click', function (evt) {
        evt.preventDefault();
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        exportImage(canvas, hidden);
      });
    }
  }

  function initAll() {
    var widgets = document.querySelectorAll('.widget--logic-diagram');
    for (var i = 0; i < widgets.length; i++) init(widgets[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
