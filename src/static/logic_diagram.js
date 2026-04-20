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
  // Cap the undo stack so extended drawing sessions don't accumulate
  // unbounded PNG dataURLs. Thirty strokes covers ordinary use and keeps
  // memory bounded on low-end pupil devices.
  var MAX_UNDO = 30;

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
    var undoBtn = widget.querySelector('[data-logic-diagram-undo]');
    var toolBtns = widget.querySelectorAll('[data-logic-diagram-tool]');
    if (!canvas || !canvas.getContext || !hidden) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PEN_COLOUR;
    ctx.lineWidth = PEN_WIDTH;

    paintPriorImage(canvas, ctx, hidden.value);

    var history = [];
    function refreshUndoBtn() {
      if (!undoBtn) return;
      if (history.length === 0) undoBtn.setAttribute('disabled', '');
      else undoBtn.removeAttribute('disabled');
    }
    function snapshot() {
      try {
        history.push(canvas.toDataURL('image/png'));
        if (history.length > MAX_UNDO) history.shift();
      } catch (_err) {
        // Tainted canvases can't export; skip the snapshot. We never
        // load cross-origin images so this should never fire.
      }
      refreshUndoBtn();
    }
    function undo() {
      if (history.length === 0) return;
      var prev = history.pop();
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      if (typeof prev === 'string' && prev.length > 0) {
        var img = new Image();
        img.onload = function () {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          exportImage(canvas, hidden);
        };
        img.src = prev;
      } else {
        exportImage(canvas, hidden);
      }
      refreshUndoBtn();
    }
    refreshUndoBtn();

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
      // Snapshot before mutating the canvas so undo rolls back the
      // whole stroke atomically.
      snapshot();
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
        // Clear is undoable — accidental taps should recover with Undo.
        snapshot();
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        exportImage(canvas, hidden);
      });
    }

    if (undoBtn) {
      undoBtn.addEventListener('click', function (evt) {
        evt.preventDefault();
        undo();
      });
    }

    widget.addEventListener('keydown', function (evt) {
      if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && evt.key === 'z') {
        evt.preventDefault();
        undo();
      }
    });
  }

  // ---- boolean_expression: quick-insert palette --------------------------

  function initBoolean(widget) {
    var textarea = widget.querySelector('[data-logic-boolean-input]');
    var ops = widget.querySelectorAll('[data-logic-boolean-op]');
    if (!textarea || ops.length === 0) return;
    for (var i = 0; i < ops.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.preventDefault();
          var token = btn.getAttribute('data-logic-boolean-op') || '';
          var start = textarea.selectionStart || 0;
          var end = textarea.selectionEnd || 0;
          var before = textarea.value.slice(0, start);
          var after = textarea.value.slice(end);
          var pad = token === '(' || token === ')' ? '' : ' ';
          var inserted = pad + token + pad;
          textarea.value = before + inserted + after;
          var caret = start + inserted.length;
          textarea.selectionStart = textarea.selectionEnd = caret;
          textarea.focus();
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        });
      })(ops[i]);
    }
  }

  // ---- gate_palette: click-to-place + click-to-wire ----------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function initPalette(widget) {
    var stage = widget.querySelector('[data-logic-palette-stage]');
    var hidden = widget.querySelector('[data-logic-palette-circuit]');
    var gateBtns = widget.querySelectorAll('[data-logic-palette-gate]');
    var toolBtns = widget.querySelectorAll('[data-logic-palette-tool]');
    var clearBtn = widget.querySelector('[data-logic-palette-clear]');
    var undoBtn = widget.querySelector('[data-logic-palette-undo]');
    if (!stage || !hidden) return;

    var maxGates = parseInt(widget.getAttribute('data-logic-palette-max-gates'), 10) || 8;
    var state = { gates: [], wires: [] };
    try {
      if (hidden.value) {
        var parsed = JSON.parse(hidden.value);
        if (parsed && Array.isArray(parsed.gates)) state.gates = parsed.gates;
        if (parsed && Array.isArray(parsed.wires)) state.wires = parsed.wires;
      }
    } catch (err) {
      // Malformed — start fresh.
    }

    var tool = 'place'; // place | wire | delete
    var pendingGateType = null;
    var wireSource = null;
    var nextGateSeq = 1;
    for (var g = 0; g < state.gates.length; g++) {
      var m = /^g(\d+)$/.exec(state.gates[g].id || '');
      if (m) nextGateSeq = Math.max(nextGateSeq, parseInt(m[1], 10) + 1);
    }

    var paletteHistory = [];
    function refreshUndoBtn() {
      if (!undoBtn) return;
      if (paletteHistory.length === 0) undoBtn.setAttribute('disabled', '');
      else undoBtn.removeAttribute('disabled');
    }
    function snapshotState() {
      try {
        paletteHistory.push(
          JSON.stringify({ gates: state.gates, wires: state.wires, nextGateSeq: nextGateSeq }),
        );
        if (paletteHistory.length > MAX_UNDO) paletteHistory.shift();
      } catch (_err) {
        // JSON.stringify only fails on circular refs; our state is flat
        // arrays of plain objects so this shouldn't happen.
      }
      refreshUndoBtn();
    }
    function undoPalette() {
      if (paletteHistory.length === 0) return;
      var raw = paletteHistory.pop();
      try {
        var prev = JSON.parse(raw);
        state.gates = Array.isArray(prev.gates) ? prev.gates : [];
        state.wires = Array.isArray(prev.wires) ? prev.wires : [];
        nextGateSeq = typeof prev.nextGateSeq === 'number' ? prev.nextGateSeq : 1;
      } catch (_err) {
        state.gates = [];
        state.wires = [];
      }
      resetPending();
      sync();
      redraw();
      refreshUndoBtn();
    }

    function sync() {
      try {
        hidden.value = JSON.stringify({ gates: state.gates, wires: state.wires });
      } catch (err) {
        hidden.value = '';
      }
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function terminalFor(id) {
      return widget.querySelector('[data-logic-palette-terminal-id="' + CSS.escape(id) + '"]');
    }
    function gateEl(id) {
      return stage.querySelector('[data-logic-palette-gate-id="' + CSS.escape(id) + '"]');
    }
    function coord(id) {
      var gate = findGate(id);
      if (gate) return { x: gate.x + 30, y: gate.y + 20 };
      var term = terminalFor(id);
      if (term)
        return { x: parseFloat(term.getAttribute('cx')), y: parseFloat(term.getAttribute('cy')) };
      return null;
    }
    function findGate(id) {
      for (var i = 0; i < state.gates.length; i++) {
        if (state.gates[i].id === id) return state.gates[i];
      }
      return null;
    }

    function redraw() {
      // Clear only gate + wire nodes; keep terminals.
      var dynamic = stage.querySelectorAll('[data-logic-palette-dynamic]');
      for (var d = 0; d < dynamic.length; d++) dynamic[d].parentNode.removeChild(dynamic[d]);
      for (var w = 0; w < state.wires.length; w++) {
        var wire = state.wires[w];
        var a = coord(wire.from);
        var b = coord(wire.to);
        if (!a || !b) continue;
        var line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('data-logic-palette-dynamic', 'wire');
        line.setAttribute('data-logic-palette-wire-index', String(w));
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.y);
        line.setAttribute('stroke', '#1a4f8a');
        line.setAttribute('stroke-width', '2');
        line.style.cursor = tool === 'delete' ? 'pointer' : 'default';
        stage.insertBefore(line, stage.firstChild);
      }
      for (var i = 0; i < state.gates.length; i++) {
        var gate = state.gates[i];
        var group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('data-logic-palette-dynamic', 'gate');
        group.setAttribute('data-logic-palette-gate-id', gate.id);
        group.setAttribute('transform', 'translate(' + gate.x + ',' + gate.y + ')');
        group.style.cursor = 'pointer';
        var rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('width', '60');
        rect.setAttribute('height', '40');
        rect.setAttribute('fill', '#fff');
        rect.setAttribute('stroke', '#1a4f8a');
        rect.setAttribute('stroke-width', '1.5');
        group.appendChild(rect);
        var label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', '30');
        label.setAttribute('y', '25');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-family', 'ui-monospace, monospace');
        label.setAttribute('font-size', '14');
        label.textContent = gate.type;
        group.appendChild(label);
        stage.appendChild(group);
      }
    }

    function highlightTools() {
      for (var t = 0; t < toolBtns.length; t++) {
        var on = toolBtns[t].getAttribute('data-logic-palette-tool') === tool;
        toolBtns[t].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      for (var g = 0; g < gateBtns.length; g++) {
        var onG =
          tool === 'place' &&
          pendingGateType === gateBtns[g].getAttribute('data-logic-palette-gate');
        gateBtns[g].setAttribute('aria-pressed', onG ? 'true' : 'false');
      }
    }

    function resetPending() {
      wireSource = null;
    }

    function placeGate(evt) {
      if (!pendingGateType) return;
      if (state.gates.length >= maxGates) return;
      var pt = stage.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      var loc = pt.matrixTransform(stage.getScreenCTM().inverse());
      // Snapshot before mutating so undo reverts the whole placement.
      snapshotState();
      var gate = {
        id: 'g' + nextGateSeq++,
        type: pendingGateType,
        x: Math.max(0, Math.round(loc.x - 30)),
        y: Math.max(0, Math.round(loc.y - 20)),
      };
      state.gates.push(gate);
      redraw();
      sync();
    }

    function handleStageClick(evt) {
      var target = evt.target;
      if (tool === 'place' && target === stage) {
        placeGate(evt);
        return;
      }
      if (tool === 'wire') {
        var gateGroup = target.closest('[data-logic-palette-gate-id]');
        var term = target.closest('[data-logic-palette-terminal-id]');
        var nodeId = gateGroup
          ? gateGroup.getAttribute('data-logic-palette-gate-id')
          : term
            ? term.getAttribute('data-logic-palette-terminal-id')
            : null;
        if (!nodeId) return;
        if (!wireSource) {
          wireSource = nodeId;
          return;
        }
        if (wireSource !== nodeId) {
          // Snapshot before adding a wire so undo removes it as one step.
          snapshotState();
          state.wires.push({ from: wireSource, to: nodeId });
          sync();
          redraw();
        }
        wireSource = null;
        return;
      }
      if (tool === 'delete') {
        var g = target.closest('[data-logic-palette-gate-id]');
        if (g) {
          var id = g.getAttribute('data-logic-palette-gate-id');
          // Snapshot before removing — deleting a gate also removes its
          // connected wires, so undo must restore both together.
          snapshotState();
          state.gates = state.gates.filter(function (x) {
            return x.id !== id;
          });
          state.wires = state.wires.filter(function (w) {
            return w.from !== id && w.to !== id;
          });
          sync();
          redraw();
          return;
        }
        var wireLine = target.closest('[data-logic-palette-wire-index]');
        if (wireLine) {
          var idx = parseInt(wireLine.getAttribute('data-logic-palette-wire-index'), 10);
          snapshotState();
          state.wires.splice(idx, 1);
          sync();
          redraw();
        }
      }
    }

    for (var gb = 0; gb < gateBtns.length; gb++) {
      (function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.preventDefault();
          tool = 'place';
          pendingGateType = btn.getAttribute('data-logic-palette-gate');
          resetPending();
          highlightTools();
        });
      })(gateBtns[gb]);
    }
    for (var tb = 0; tb < toolBtns.length; tb++) {
      (function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.preventDefault();
          tool = btn.getAttribute('data-logic-palette-tool') || 'place';
          pendingGateType = null;
          resetPending();
          highlightTools();
          redraw();
        });
      })(toolBtns[tb]);
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function (evt) {
        evt.preventDefault();
        // Clear is undoable — pupils sometimes hit it by accident mid-build.
        snapshotState();
        state.gates = [];
        state.wires = [];
        resetPending();
        sync();
        redraw();
      });
    }
    if (undoBtn) {
      undoBtn.addEventListener('click', function (evt) {
        evt.preventDefault();
        undoPalette();
      });
    }
    widget.addEventListener('keydown', function (evt) {
      if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && evt.key === 'z') {
        evt.preventDefault();
        undoPalette();
      }
    });
    stage.addEventListener('click', handleStageClick);
    redraw();
    highlightTools();
    refreshUndoBtn();
  }

  function initAll() {
    var widgets = document.querySelectorAll('.widget--logic-diagram');
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      init(w);
      if (w.classList.contains('widget--logic-diagram-boolean')) initBoolean(w);
      if (w.classList.contains('widget--logic-diagram-palette')) initPalette(w);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
