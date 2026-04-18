// Flowchart widget — pen + clear (Phase 2.5h MVP).
//
// Mirrors logic_diagram.js: each `.flowchart` widget owns a <canvas>
// and a hidden input (`<name>__image`) carrying a PNG data URL. The
// route aggregator stores it in `attempt_parts.raw_answer` as
// `image=<dataURL>`. On every stroke we re-export, write the data URL
// to the hidden input, and dispatch input/change so src/static/autosave.js
// flushes it.
//
// Tools: pen (default) and eraser. Clear wipes everything. Mouse and
// touch supported.

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
      // images so this should never happen in practice.
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
    var canvas = widget.querySelector('[data-flowchart-canvas]');
    var hidden = widget.querySelector('[data-flowchart-image]');
    var clearBtn = widget.querySelector('[data-flowchart-clear]');
    var toolBtns = widget.querySelectorAll('[data-flowchart-tool]');
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
        var on = btn.getAttribute('data-flowchart-tool') === next;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    for (var i = 0; i < toolBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.preventDefault();
          setTool(btn.getAttribute('data-flowchart-tool') || 'pen');
        });
      })(toolBtns[i]);
    }

    var drawing = false;
    var lastPos = null;

    function beginStroke(evt) {
      evt.preventDefault();
      drawing = true;
      lastPos = pointerPos(canvas, evt);
      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = ERASER_WIDTH;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = PEN_WIDTH;
        ctx.strokeStyle = PEN_COLOUR;
      }
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
    var widgets = document.querySelectorAll('.widget--flowchart');
    for (var i = 0; i < widgets.length; i++) init(widgets[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
