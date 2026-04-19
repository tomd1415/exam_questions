// Click-to-place flowchart picker for the shapes-variant flowchart editor.
//
// Same progressive-enhancement contract as wizard_hotspot_picker.js: the
// shapes + arrows textareas are the source of truth. A visual stage is
// mounted above them; teacher clicks a tool in the palette, then clicks
// the canvas to drop a shape, drags to move, or chains two clicks to
// draw an arrow. Every change writes back to the textareas and dispatches
// 'input' so any other listeners stay in sync. Direct textarea edits also
// re-render the stage, so teachers can mix modes freely.
//
// Editor markup expected (inside a fieldset that also contains the
// canvas_width / canvas_height inputs and the shapes / arrows textareas):
//
//   <div data-widget-editor="flowchart" data-flowchart-picker>
//     <div data-flowchart-toolbar>
//       <button data-flowchart-tool="select" aria-pressed="true">Select</button>
//       <button data-flowchart-tool="add:terminator">+ Terminator</button>
//       <button data-flowchart-tool="add:process">+ Process</button>
//       <button data-flowchart-tool="add:decision">+ Decision</button>
//       <button data-flowchart-tool="add:io">+ Input/Output</button>
//       <button data-flowchart-tool="add:arrow">+ Arrow</button>
//       <span data-flowchart-hint></span>
//     </div>
//     <svg data-flowchart-stage></svg>
//     <aside data-flowchart-inspector hidden></aside>
//   </div>

(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  var SHAPE_TYPES = ['terminator', 'process', 'decision', 'io'];
  var DEFAULT_SIZES = {
    terminator: { w: 160, h: 50 },
    process: { w: 180, h: 60 },
    decision: { w: 200, h: 80 },
    io: { w: 180, h: 60 },
  };
  var MIN_W = 40;
  var MIN_H = 30;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseShapeLine(line) {
    var parts = line.split('|').map(function (s) { return s.trim(); });
    if (parts.length < 8) return null;
    var id = parts[0];
    var type = parts[1];
    if (SHAPE_TYPES.indexOf(type) === -1) return null;
    var x = parseInt(parts[2], 10);
    var y = parseInt(parts[3], 10);
    var w = parseInt(parts[4], 10);
    var h = parseInt(parts[5], 10);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    var kind = (parts[6] || '').toUpperCase();
    var body = parts.slice(7).join('|').trim();
    var shape = { id: id, type: type, x: x, y: y, width: w, height: h };
    if (kind === 'TEXT') {
      shape.text = body;
    } else if (kind === 'EXPECTED') {
      shape.accept = body
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
    } else {
      return null;
    }
    return shape;
  }

  function parseShapes(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var shape = parseShapeLine(line);
      if (shape) out.push(shape);
    }
    return out;
  }

  function parseArrows(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var parts = line.split('|').map(function (s) { return s.trim(); });
      if (parts.length < 2 || parts.length > 3) continue;
      var a = { from: parts[0], to: parts[1] };
      if (parts[2]) a.label = parts[2];
      out.push(a);
    }
    return out;
  }

  function formatShapes(list) {
    return list
      .map(function (s) {
        var tail = Array.isArray(s.accept)
          ? 'EXPECTED|' + s.accept.join(', ')
          : 'TEXT|' + (s.text || '');
        return [s.id, s.type, s.x, s.y, s.width, s.height, tail].join('|');
      })
      .join('\n');
  }

  function formatArrows(list) {
    return list
      .map(function (a) { return a.label ? a.from + '|' + a.to + '|' + a.label : a.from + '|' + a.to; })
      .join('\n');
  }

  function nextId(existing, prefix) {
    var max = 0;
    var re = new RegExp('^' + prefix + '(\\d+)$');
    for (var i = 0; i < existing.length; i++) {
      var m = re.exec(existing[i].id);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return prefix + (max + 1);
  }

  function shapePath(s) {
    var x = s.x, y = s.y, w = s.width, h = s.height;
    if (s.type === 'terminator') {
      var r = Math.min(w, h) / 2;
      return 'M ' + (x + r) + ' ' + y +
        ' H ' + (x + w - r) +
        ' A ' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + h) +
        ' H ' + (x + r) +
        ' A ' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y + ' Z';
    }
    if (s.type === 'decision') {
      var mx = x + w / 2, my = y + h / 2;
      return 'M ' + mx + ' ' + y +
        ' L ' + (x + w) + ' ' + my +
        ' L ' + mx + ' ' + (y + h) +
        ' L ' + x + ' ' + my + ' Z';
    }
    if (s.type === 'io') {
      var skew = Math.min(20, w / 6);
      return 'M ' + (x + skew) + ' ' + y +
        ' L ' + (x + w) + ' ' + y +
        ' L ' + (x + w - skew) + ' ' + (y + h) +
        ' L ' + x + ' ' + (y + h) + ' Z';
    }
    return 'M ' + x + ' ' + y +
      ' H ' + (x + w) +
      ' V ' + (y + h) +
      ' H ' + x + ' Z';
  }

  function shapeCentre(s) {
    return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
  }

  function bind(root) {
    var fieldset = root.closest('fieldset') || root.parentNode;
    var widthInput = fieldset.querySelector('#canvas_width');
    var heightInput = fieldset.querySelector('#canvas_height');
    var shapesArea = fieldset.querySelector('textarea[name="shapes"]');
    var arrowsArea = fieldset.querySelector('textarea[name="arrows"]');
    var stage = root.querySelector('[data-flowchart-stage]');
    var inspector = root.querySelector('[data-flowchart-inspector]');
    var hint = root.querySelector('[data-flowchart-hint]');
    var toolbar = root.querySelector('[data-flowchart-toolbar]');
    if (!stage || !inspector || !shapesArea || !arrowsArea) return;

    var state = {
      tool: 'select',
      selected: null, // { kind: 'shape'|'arrow', index: number }
      arrowPending: null, // id of first-clicked shape when drawing an arrow
      drag: null, // { kind: 'move'|'resize', id, offsetX, offsetY, startW, startH }
    };

    function canvasSize() {
      var w = parseInt(widthInput && widthInput.value, 10);
      var h = parseInt(heightInput && heightInput.value, 10);
      return {
        w: Number.isFinite(w) && w >= 100 ? w : 600,
        h: Number.isFinite(h) && h >= 100 ? h : 400,
      };
    }

    function readModel() {
      return { shapes: parseShapes(shapesArea.value), arrows: parseArrows(arrowsArea.value) };
    }

    function writeModel(model) {
      shapesArea.value = formatShapes(model.shapes);
      arrowsArea.value = formatArrows(model.arrows);
      shapesArea.dispatchEvent(new Event('input', { bubbles: true }));
      arrowsArea.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }

    function setTool(tool) {
      state.tool = tool;
      state.arrowPending = null;
      var btns = toolbar.querySelectorAll('[data-flowchart-tool]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        b.setAttribute(
          'aria-pressed',
          b.getAttribute('data-flowchart-tool') === tool ? 'true' : 'false',
        );
      }
      if (hint) {
        if (tool === 'select') hint.textContent = 'Click a shape to select; drag to move; drag SE corner to resize.';
        else if (tool === 'add:arrow') hint.textContent = 'Click the source shape, then the target shape.';
        else if (tool && tool.indexOf('add:') === 0) hint.textContent = 'Click the canvas to drop a ' + tool.slice(4) + '. Edit its text/accept list in the inspector.';
        else hint.textContent = '';
      }
    }

    function clientToCanvas(evt) {
      var size = canvasSize();
      var rect = stage.getBoundingClientRect();
      var scaleX = size.w / rect.width;
      var scaleY = size.h / rect.height;
      return {
        x: Math.round((evt.clientX - rect.left) * scaleX),
        y: Math.round((evt.clientY - rect.top) * scaleY),
      };
    }

    function selectShape(index) {
      state.selected = index >= 0 ? { kind: 'shape', index: index } : null;
      render();
    }
    function selectArrow(index) {
      state.selected = index >= 0 ? { kind: 'arrow', index: index } : null;
      render();
    }

    function placeShape(type, point) {
      var size = canvasSize();
      var dim = DEFAULT_SIZES[type] || DEFAULT_SIZES.process;
      var w = Math.min(dim.w, size.w);
      var h = Math.min(dim.h, size.h);
      var x = Math.max(0, Math.min(size.w - w, point.x - w / 2));
      var y = Math.max(0, Math.min(size.h - h, point.y - h / 2));
      var model = readModel();
      var id = nextId(model.shapes, 's');
      var shape = {
        id: id,
        type: type,
        x: Math.round(x),
        y: Math.round(y),
        width: w,
        height: h,
        text: type === 'terminator' ? 'Start' : 'Step',
      };
      model.shapes.push(shape);
      writeModel(model);
      state.selected = { kind: 'shape', index: model.shapes.length - 1 };
      setTool('select');
      render();
    }

    function onStageClick(evt) {
      if (state.drag) return; // drag handlers deal with this
      var p = clientToCanvas(evt);
      if (state.tool && state.tool.indexOf('add:') === 0 && state.tool !== 'add:arrow') {
        placeShape(state.tool.slice(4), p);
        return;
      }
      // click on empty space → deselect
      var target = evt.target.closest('[data-shape-id],[data-arrow-index]');
      if (!target) {
        state.selected = null;
        state.arrowPending = null;
        render();
      }
    }

    function onShapeClick(evt, id) {
      evt.stopPropagation();
      var model = readModel();
      var idx = -1;
      for (var i = 0; i < model.shapes.length; i++) if (model.shapes[i].id === id) { idx = i; break; }
      if (idx < 0) return;
      if (state.tool === 'add:arrow') {
        if (!state.arrowPending) {
          state.arrowPending = id;
          if (hint) hint.textContent = 'Now click the target shape.';
          render();
        } else if (state.arrowPending !== id) {
          model.arrows.push({ from: state.arrowPending, to: id });
          state.arrowPending = null;
          writeModel(model);
          state.selected = { kind: 'arrow', index: model.arrows.length - 1 };
          setTool('select');
          render();
        } else {
          state.arrowPending = null;
          render();
        }
        return;
      }
      selectShape(idx);
    }

    function onArrowClick(evt, index) {
      evt.stopPropagation();
      if (state.tool !== 'select') return;
      selectArrow(index);
    }

    function beginDrag(evt, id, mode) {
      evt.preventDefault();
      evt.stopPropagation();
      var model = readModel();
      var shape = null;
      for (var i = 0; i < model.shapes.length; i++) if (model.shapes[i].id === id) { shape = model.shapes[i]; break; }
      if (!shape) return;
      var p = clientToCanvas(evt);
      state.drag = {
        kind: mode,
        id: id,
        offsetX: p.x - shape.x,
        offsetY: p.y - shape.y,
        startW: shape.width,
        startH: shape.height,
        startX: shape.x,
        startY: shape.y,
      };
    }

    function onDocMove(evt) {
      if (!state.drag) return;
      evt.preventDefault();
      var model = readModel();
      var shape = null;
      for (var i = 0; i < model.shapes.length; i++) if (model.shapes[i].id === state.drag.id) { shape = model.shapes[i]; break; }
      if (!shape) return;
      var p = clientToCanvas(evt);
      var size = canvasSize();
      if (state.drag.kind === 'move') {
        shape.x = Math.max(0, Math.min(size.w - shape.width, p.x - state.drag.offsetX));
        shape.y = Math.max(0, Math.min(size.h - shape.height, p.y - state.drag.offsetY));
      } else {
        shape.width = Math.max(MIN_W, Math.min(size.w - shape.x, p.x - shape.x));
        shape.height = Math.max(MIN_H, Math.min(size.h - shape.y, p.y - shape.y));
      }
      writeModel(model);
    }

    function onDocUp() {
      if (!state.drag) return;
      state.drag = null;
    }

    function renderInspector(model) {
      if (!state.selected) {
        inspector.hidden = true;
        inspector.innerHTML = '';
        return;
      }
      inspector.hidden = false;
      if (state.selected.kind === 'shape') {
        var shape = model.shapes[state.selected.index];
        if (!shape) { inspector.hidden = true; return; }
        var isExpected = Array.isArray(shape.accept);
        var html =
          '<h3 class="wizard-flowchart-editor__inspector-title">Shape</h3>' +
          '<label>Id<input type="text" data-inspect="id" value="' + escapeHtml(shape.id) + '" /></label>' +
          '<label>Type<select data-inspect="type">' +
          SHAPE_TYPES.map(function (t) {
            return '<option value="' + t + '"' + (t === shape.type ? ' selected' : '') + '>' + t + '</option>';
          }).join('') +
          '</select></label>' +
          '<label>Mode<select data-inspect="mode">' +
          '<option value="TEXT"' + (isExpected ? '' : ' selected') + '>Prefilled text</option>' +
          '<option value="EXPECTED"' + (isExpected ? ' selected' : '') + '>Pupil-fill blank</option>' +
          '</select></label>';
        if (isExpected) {
          html +=
            '<label>Accepted answers (comma-separated)<textarea data-inspect="accept" rows="2">' +
            escapeHtml((shape.accept || []).join(', ')) +
            '</textarea></label>';
        } else {
          html +=
            '<label>Text<input type="text" data-inspect="text" value="' +
            escapeHtml(shape.text || '') +
            '" /></label>';
        }
        html += '<button type="button" data-inspect-action="delete" class="btn btn--danger btn--sm">Delete shape</button>';
        inspector.innerHTML = html;
      } else {
        var arrow = model.arrows[state.selected.index];
        if (!arrow) { inspector.hidden = true; return; }
        inspector.innerHTML =
          '<h3 class="wizard-flowchart-editor__inspector-title">Arrow</h3>' +
          '<p class="wizard-flowchart-editor__inspector-meta">' +
          escapeHtml(arrow.from) + ' → ' + escapeHtml(arrow.to) +
          '</p>' +
          '<label>Label (optional)<input type="text" data-inspect="label" value="' + escapeHtml(arrow.label || '') + '" /></label>' +
          '<button type="button" data-inspect-action="delete" class="btn btn--danger btn--sm">Delete arrow</button>';
      }
    }

    function renderStage(model) {
      var size = canvasSize();
      stage.setAttribute('viewBox', '0 0 ' + size.w + ' ' + size.h);
      stage.setAttribute('width', String(size.w));
      stage.setAttribute('height', String(size.h));

      var defs = '<defs><marker id="wf-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" ' +
        'markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
        '<path d="M 0 0 L 10 5 L 0 10 Z" fill="currentColor" /></marker></defs>';

      // Arrows first (under shapes).
      var arrowSvg = '';
      for (var ai = 0; ai < model.arrows.length; ai++) {
        var a = model.arrows[ai];
        var from = null, to = null;
        for (var k = 0; k < model.shapes.length; k++) {
          if (model.shapes[k].id === a.from) from = model.shapes[k];
          if (model.shapes[k].id === a.to) to = model.shapes[k];
        }
        if (!from || !to) continue;
        var p1 = shapeCentre(from), p2 = shapeCentre(to);
        var sel = state.selected && state.selected.kind === 'arrow' && state.selected.index === ai;
        arrowSvg +=
          '<line class="wizard-flowchart-editor__arrow' + (sel ? ' is-selected' : '') + '" ' +
          'data-arrow-index="' + ai + '" ' +
          'x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '" ' +
          'marker-end="url(#wf-arrowhead)" />';
        if (a.label) {
          arrowSvg +=
            '<text class="wizard-flowchart-editor__arrow-label" ' +
            'x="' + ((p1.x + p2.x) / 2) + '" y="' + ((p1.y + p2.y) / 2) + '" ' +
            'text-anchor="middle" dy="-4">' + escapeHtml(a.label) + '</text>';
        }
      }

      var shapeSvg = '';
      for (var si = 0; si < model.shapes.length; si++) {
        var s = model.shapes[si];
        var isExpected = Array.isArray(s.accept);
        var selShape = state.selected && state.selected.kind === 'shape' && state.selected.index === si;
        var pending = state.arrowPending === s.id;
        var cls = 'wizard-flowchart-editor__shape' +
          (isExpected ? ' is-expected' : '') +
          (selShape ? ' is-selected' : '') +
          (pending ? ' is-arrow-pending' : '');
        shapeSvg +=
          '<g class="wizard-flowchart-editor__shape-group" data-shape-id="' + escapeHtml(s.id) + '">' +
          '<path class="' + cls + '" d="' + shapePath(s) + '" />' +
          '<text class="wizard-flowchart-editor__shape-label" x="' + (s.x + s.width / 2) +
          '" y="' + (s.y + s.height / 2) + '" text-anchor="middle" dominant-baseline="middle">' +
          escapeHtml(isExpected ? '[' + s.id + ']' : (s.text || '')) +
          '</text>' +
          (selShape
            ? '<rect class="wizard-flowchart-editor__selection" x="' + s.x + '" y="' + s.y + '" width="' + s.width + '" height="' + s.height + '" />' +
              '<rect class="wizard-flowchart-editor__resize" data-resize-id="' + escapeHtml(s.id) + '" x="' + (s.x + s.width - 6) + '" y="' + (s.y + s.height - 6) + '" width="12" height="12" />'
            : '') +
          '</g>';
      }

      stage.innerHTML = defs + arrowSvg + shapeSvg;
    }

    function render() {
      var model = readModel();
      renderStage(model);
      renderInspector(model);
    }

    // --- Events ----------------------------------------------------------

    toolbar.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-flowchart-tool]');
      if (!btn) return;
      evt.preventDefault();
      setTool(btn.getAttribute('data-flowchart-tool'));
      render();
    });

    stage.addEventListener('mousedown', function (evt) {
      var resize = evt.target.closest('[data-resize-id]');
      if (resize) { beginDrag(evt, resize.getAttribute('data-resize-id'), 'resize'); return; }
      var shape = evt.target.closest('[data-shape-id]');
      if (shape && state.tool === 'select') {
        // Select first so the selection box appears before dragging.
        onShapeClick(evt, shape.getAttribute('data-shape-id'));
        beginDrag(evt, shape.getAttribute('data-shape-id'), 'move');
      }
    });

    stage.addEventListener('click', function (evt) {
      var resize = evt.target.closest('[data-resize-id]');
      if (resize) return;
      var shape = evt.target.closest('[data-shape-id]');
      if (shape) { onShapeClick(evt, shape.getAttribute('data-shape-id')); return; }
      var arrow = evt.target.closest('[data-arrow-index]');
      if (arrow) { onArrowClick(evt, parseInt(arrow.getAttribute('data-arrow-index'), 10)); return; }
      onStageClick(evt);
    });

    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);

    inspector.addEventListener('input', function (evt) {
      if (!state.selected) return;
      var field = evt.target.closest('[data-inspect]');
      if (!field) return;
      var name = field.getAttribute('data-inspect');
      var model = readModel();
      if (state.selected.kind === 'shape') {
        var shape = model.shapes[state.selected.index];
        if (!shape) return;
        if (name === 'id') {
          var newId = field.value.trim();
          if (!newId || newId === shape.id) return;
          if (model.shapes.some(function (x) { return x.id === newId; })) return;
          for (var i = 0; i < model.arrows.length; i++) {
            if (model.arrows[i].from === shape.id) model.arrows[i].from = newId;
            if (model.arrows[i].to === shape.id) model.arrows[i].to = newId;
          }
          shape.id = newId;
        } else if (name === 'type') {
          if (SHAPE_TYPES.indexOf(field.value) !== -1) shape.type = field.value;
        } else if (name === 'text') {
          delete shape.accept;
          shape.text = field.value;
        } else if (name === 'accept') {
          delete shape.text;
          shape.accept = field.value
            .split(',')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
        }
      } else if (state.selected.kind === 'arrow') {
        var arrow = model.arrows[state.selected.index];
        if (!arrow) return;
        if (name === 'label') {
          var lab = field.value.trim();
          if (lab) arrow.label = lab;
          else delete arrow.label;
        }
      }
      writeModel(model);
    });

    inspector.addEventListener('change', function (evt) {
      if (!state.selected) return;
      var field = evt.target.closest('[data-inspect]');
      if (!field) return;
      if (field.getAttribute('data-inspect') !== 'mode') return;
      var model = readModel();
      if (state.selected.kind !== 'shape') return;
      var shape = model.shapes[state.selected.index];
      if (!shape) return;
      if (field.value === 'EXPECTED' && !Array.isArray(shape.accept)) {
        var existing = typeof shape.text === 'string' ? shape.text : '';
        delete shape.text;
        shape.accept = existing ? [existing] : [];
      } else if (field.value === 'TEXT' && Array.isArray(shape.accept)) {
        var acc = shape.accept;
        delete shape.accept;
        shape.text = acc.length ? acc[0] : '';
      }
      writeModel(model);
    });

    inspector.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-inspect-action="delete"]');
      if (!btn) return;
      evt.preventDefault();
      if (!state.selected) return;
      var model = readModel();
      if (state.selected.kind === 'shape') {
        var removed = model.shapes.splice(state.selected.index, 1)[0];
        if (removed) {
          model.arrows = model.arrows.filter(function (a) {
            return a.from !== removed.id && a.to !== removed.id;
          });
        }
      } else {
        model.arrows.splice(state.selected.index, 1);
      }
      state.selected = null;
      writeModel(model);
    });

    document.addEventListener('keydown', function (evt) {
      if (!state.selected) return;
      if (evt.key !== 'Delete' && evt.key !== 'Backspace' && evt.key !== 'Escape') return;
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      evt.preventDefault();
      if (evt.key === 'Escape') { state.selected = null; state.arrowPending = null; render(); return; }
      var btn = inspector.querySelector('[data-inspect-action="delete"]');
      if (btn) btn.click();
    });

    // Direct textarea edits should re-render the stage.
    shapesArea.addEventListener('input', render);
    arrowsArea.addEventListener('input', render);
    if (widthInput) widthInput.addEventListener('input', render);
    if (heightInput) heightInput.addEventListener('input', render);

    setTool('select');
    render();
  }

  var roots = document.querySelectorAll('[data-widget-editor="flowchart"][data-flowchart-picker]');
  for (var i = 0; i < roots.length; i++) bind(roots[i]);
})();
