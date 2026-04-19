// Click-to-place logic-diagram picker for the gate_in_box variant.
//
// Same progressive-enhancement contract as wizard_flowchart_picker.js and
// wizard_hotspot_picker.js: the gates / terminals / wires textareas are
// the source of truth, and this file mounts a visual stage above them.
// Palette tools drop AND/OR/NOT gates, blank (pupil-fill) boxes, or
// labelled INPUT/OUTPUT terminals. The wire tool chains two clicks
// (source node → target node) to add a decorative connecting line. Every
// change re-serialises back to the three textareas and dispatches
// 'input' so any other listeners stay in sync. Direct textarea edits
// also re-render the stage, so no-JS teachers and copy-from-worked-
// example flows still work.
//
// Editor markup expected (inside a fieldset that also contains the
// canvas_width / canvas_height inputs and the three textareas):
//
//   <div data-widget-editor="logic_diagram" data-logic-picker>
//     <div data-logic-toolbar> ... buttons ... </div>
//     <svg data-logic-stage></svg>
//     <aside data-logic-inspector hidden></aside>
//   </div>

(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  var GATE_TYPES = ['AND', 'OR', 'NOT'];
  var DEFAULT_GATE = { w: 80, h: 50 };
  var DEFAULT_BLANK = { w: 80, h: 50 };
  var MIN_W = 40;
  var MIN_H = 30;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseGateLine(line) {
    var parts = line.split('|').map(function (s) {
      return s.trim();
    });
    if (parts.length < 7) return null;
    var id = parts[0];
    var x = parseInt(parts[1], 10);
    var y = parseInt(parts[2], 10);
    var w = parseInt(parts[3], 10);
    var h = parseInt(parts[4], 10);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    var kind = (parts[5] || '').toUpperCase();
    var body = parts.slice(6).join('|').trim();
    var gate = { id: id, x: x, y: y, width: w, height: h };
    if (kind === 'GATE') {
      if (GATE_TYPES.indexOf(body.toUpperCase()) === -1) return null;
      gate.type = body.toUpperCase();
    } else if (kind === 'BLANK') {
      gate.accept = body
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(function (s) {
          return s.length > 0;
        });
    } else {
      return null;
    }
    return gate;
  }

  function parseTerminalLine(line) {
    var parts = line.split('|').map(function (s) {
      return s.trim();
    });
    if (parts.length < 5) return null;
    var kind = (parts[1] || '').toUpperCase();
    if (kind !== 'INPUT' && kind !== 'OUTPUT') return null;
    var x = parseInt(parts[3], 10);
    var y = parseInt(parts[4], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { id: parts[0], kind: kind.toLowerCase(), label: parts[2], x: x, y: y };
  }

  function parseWireLine(line) {
    var parts = line.split('|').map(function (s) {
      return s.trim();
    });
    if (parts.length !== 2) return null;
    if (!parts[0] || !parts[1]) return null;
    return { from: parts[0], to: parts[1] };
  }

  function parseLines(text, fn) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;
      var item = fn(raw);
      if (item) out.push(item);
    }
    return out;
  }

  function formatGates(list) {
    return list
      .map(function (g) {
        var tail = Array.isArray(g.accept)
          ? 'BLANK|' + g.accept.join(', ')
          : 'GATE|' + (g.type || 'AND');
        return [g.id, g.x, g.y, g.width, g.height, tail].join('|');
      })
      .join('\n');
  }

  function formatTerminals(list) {
    return list
      .map(function (t) {
        return [t.id, t.kind === 'output' ? 'OUTPUT' : 'INPUT', t.label, t.x, t.y].join('|');
      })
      .join('\n');
  }

  function formatWires(list) {
    return list
      .map(function (w) {
        return w.from + '|' + w.to;
      })
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

  function nextTerminalLabel(existing, kind) {
    var used = new Set();
    for (var i = 0; i < existing.length; i++)
      if (existing[i].kind === kind) used.add(existing[i].label);
    if (kind === 'input') {
      for (var c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
        var L = String.fromCharCode(c);
        if (!used.has(L)) return L;
      }
      return 'X';
    }
    // outputs: P, Q, R, ...
    for (var c2 = 'P'.charCodeAt(0); c2 <= 'Z'.charCodeAt(0); c2++) {
      var L2 = String.fromCharCode(c2);
      if (!used.has(L2)) return L2;
    }
    return 'Y';
  }

  function gatePath(g) {
    var pad = 4;
    var x = g.x + pad,
      y = g.y + pad;
    var w = g.width - 2 * pad,
      h = g.height - 2 * pad;
    if (g.type === 'AND') {
      var r = h / 2;
      return (
        'M ' +
        x +
        ' ' +
        y +
        ' L ' +
        (x + w - r) +
        ' ' +
        y +
        ' A ' +
        r +
        ' ' +
        r +
        ' 0 0 1 ' +
        (x + w - r) +
        ' ' +
        (y + h) +
        ' L ' +
        x +
        ' ' +
        (y + h) +
        ' Z'
      );
    }
    if (g.type === 'OR') {
      var cp = w * 0.25;
      return (
        'M ' +
        x +
        ' ' +
        y +
        ' Q ' +
        (x + cp) +
        ' ' +
        (y + h / 2) +
        ' ' +
        x +
        ' ' +
        (y + h) +
        ' Q ' +
        (x + w * 0.6) +
        ' ' +
        (y + h) +
        ' ' +
        (x + w) +
        ' ' +
        (y + h / 2) +
        ' Q ' +
        (x + w * 0.6) +
        ' ' +
        y +
        ' ' +
        x +
        ' ' +
        y +
        ' Z'
      );
    }
    return (
      'M ' +
      x +
      ' ' +
      y +
      ' L ' +
      (x + w * 0.8) +
      ' ' +
      (y + h / 2) +
      ' L ' +
      x +
      ' ' +
      (y + h) +
      ' Z'
    );
  }

  function gateCentre(g) {
    return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  }

  function bind(root) {
    var fieldset = root.closest('fieldset') || root.parentNode;
    var widthInput = fieldset.querySelector('#canvas_width');
    var heightInput = fieldset.querySelector('#canvas_height');
    var gatesArea = fieldset.querySelector('#gates');
    // In the gate_in_box section the terminals textarea has id=terminals_gib.
    var terminalsArea =
      fieldset.querySelector('#terminals_gib') ||
      fieldset.querySelector('textarea[name="terminals"]');
    var wiresArea = fieldset.querySelector('#wires');
    var stage = root.querySelector('[data-logic-stage]');
    var inspector = root.querySelector('[data-logic-inspector]');
    var hint = root.querySelector('[data-logic-hint]');
    var toolbar = root.querySelector('[data-logic-toolbar]');
    if (!stage || !inspector || !gatesArea || !terminalsArea || !wiresArea || !toolbar) return;

    var state = {
      tool: 'select',
      selected: null, // { kind: 'gate'|'terminal'|'wire', index: number }
      wirePending: null, // node id when drawing a wire
      drag: null,
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
      return {
        gates: parseLines(gatesArea.value, parseGateLine),
        terminals: parseLines(terminalsArea.value, parseTerminalLine),
        wires: parseLines(wiresArea.value, parseWireLine),
      };
    }

    function writeModel(model) {
      gatesArea.value = formatGates(model.gates);
      terminalsArea.value = formatTerminals(model.terminals);
      wiresArea.value = formatWires(model.wires);
      gatesArea.dispatchEvent(new Event('input', { bubbles: true }));
      terminalsArea.dispatchEvent(new Event('input', { bubbles: true }));
      wiresArea.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }

    function setTool(tool) {
      state.tool = tool;
      state.wirePending = null;
      var btns = toolbar.querySelectorAll('[data-logic-tool]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        b.setAttribute(
          'aria-pressed',
          b.getAttribute('data-logic-tool') === tool ? 'true' : 'false',
        );
      }
      if (hint) {
        if (tool === 'select')
          hint.textContent =
            'Click a gate, terminal, or wire to select. Drag gates to move; drag the SE handle to resize.';
        else if (tool === 'add:wire')
          hint.textContent = 'Click the source node (gate or terminal), then the target node.';
        else if (tool === 'add:blank')
          hint.textContent =
            'Click the canvas to drop a pupil-fill blank. Set the accept list in the inspector.';
        else if (tool === 'add:input')
          hint.textContent = 'Click the canvas to place an input terminal.';
        else if (tool === 'add:output')
          hint.textContent = 'Click the canvas to place an output terminal.';
        else if (tool && tool.indexOf('add:') === 0)
          hint.textContent = 'Click the canvas to drop a ' + tool.slice(4) + ' gate.';
      }
    }

    function clientToCanvas(evt) {
      var size = canvasSize();
      var rect = stage.getBoundingClientRect();
      return {
        x: Math.round((evt.clientX - rect.left) * (size.w / rect.width)),
        y: Math.round((evt.clientY - rect.top) * (size.h / rect.height)),
      };
    }

    function placeGate(kind, point) {
      // kind is 'AND'|'OR'|'NOT'|'blank'.
      var size = canvasSize();
      var dim = kind === 'blank' ? DEFAULT_BLANK : DEFAULT_GATE;
      var w = Math.min(dim.w, size.w),
        h = Math.min(dim.h, size.h);
      var x = Math.max(0, Math.min(size.w - w, point.x - w / 2));
      var y = Math.max(0, Math.min(size.h - h, point.y - h / 2));
      var model = readModel();
      var id = nextId(model.gates, 'g');
      var gate = { id: id, x: Math.round(x), y: Math.round(y), width: w, height: h };
      if (kind === 'blank') gate.accept = [];
      else gate.type = kind;
      model.gates.push(gate);
      writeModel(model);
      state.selected = { kind: 'gate', index: model.gates.length - 1 };
      setTool('select');
      render();
    }

    function placeTerminal(kind, point) {
      var size = canvasSize();
      var x = Math.max(0, Math.min(size.w, point.x));
      var y = Math.max(0, Math.min(size.h, point.y));
      var model = readModel();
      var prefix = kind === 'input' ? 'i' : 'o';
      var id = nextId(model.terminals, prefix);
      var label = nextTerminalLabel(model.terminals, kind);
      model.terminals.push({
        id: id,
        kind: kind,
        label: label,
        x: Math.round(x),
        y: Math.round(y),
      });
      writeModel(model);
      state.selected = { kind: 'terminal', index: model.terminals.length - 1 };
      setTool('select');
      render();
    }

    function findNode(model, id) {
      for (var i = 0; i < model.gates.length; i++)
        if (model.gates[i].id === id) return { kind: 'gate', index: i };
      for (var j = 0; j < model.terminals.length; j++)
        if (model.terminals[j].id === id) return { kind: 'terminal', index: j };
      return null;
    }

    function beginDrag(evt, id, mode) {
      evt.preventDefault();
      evt.stopPropagation();
      var model = readModel();
      var ref = findNode(model, id);
      if (!ref) return;
      var p = clientToCanvas(evt);
      var anchor =
        ref.kind === 'gate'
          ? { x: model.gates[ref.index].x, y: model.gates[ref.index].y }
          : { x: model.terminals[ref.index].x, y: model.terminals[ref.index].y };
      state.drag = {
        kind: mode,
        ref: ref,
        id: id,
        offsetX: p.x - anchor.x,
        offsetY: p.y - anchor.y,
      };
      if (mode === 'resize' && ref.kind === 'gate') {
        var g = model.gates[ref.index];
        state.drag.startW = g.width;
        state.drag.startH = g.height;
      }
    }

    function onDocMove(evt) {
      if (!state.drag) return;
      evt.preventDefault();
      var model = readModel();
      var ref = state.drag.ref;
      if (ref.kind === 'gate') {
        var g = model.gates[ref.index];
        if (!g) return;
        var p = clientToCanvas(evt);
        var size = canvasSize();
        if (state.drag.kind === 'move') {
          g.x = Math.max(0, Math.min(size.w - g.width, p.x - state.drag.offsetX));
          g.y = Math.max(0, Math.min(size.h - g.height, p.y - state.drag.offsetY));
        } else {
          g.width = Math.max(MIN_W, Math.min(size.w - g.x, p.x - g.x));
          g.height = Math.max(MIN_H, Math.min(size.h - g.y, p.y - g.y));
        }
      } else if (ref.kind === 'terminal') {
        var t = model.terminals[ref.index];
        if (!t) return;
        var p2 = clientToCanvas(evt);
        var sz = canvasSize();
        t.x = Math.max(0, Math.min(sz.w, p2.x - state.drag.offsetX));
        t.y = Math.max(0, Math.min(sz.h, p2.y - state.drag.offsetY));
      }
      writeModel(model);
    }

    function onDocUp() {
      if (!state.drag) return;
      state.drag = null;
    }

    function onNodeClick(evt, id) {
      evt.stopPropagation();
      var model = readModel();
      var ref = findNode(model, id);
      if (!ref) return;
      if (state.tool === 'add:wire') {
        if (!state.wirePending) {
          state.wirePending = id;
          if (hint) hint.textContent = 'Now click the target node.';
          render();
        } else if (state.wirePending !== id) {
          model.wires.push({ from: state.wirePending, to: id });
          state.wirePending = null;
          writeModel(model);
          state.selected = { kind: 'wire', index: model.wires.length - 1 };
          setTool('select');
          render();
        } else {
          state.wirePending = null;
          render();
        }
        return;
      }
      state.selected = ref;
      render();
    }

    function onWireClick(evt, index) {
      evt.stopPropagation();
      if (state.tool !== 'select') return;
      state.selected = { kind: 'wire', index: index };
      render();
    }

    function onStageClick(evt) {
      if (state.drag) return;
      var p = clientToCanvas(evt);
      if (state.tool === 'add:AND' || state.tool === 'add:OR' || state.tool === 'add:NOT') {
        placeGate(state.tool.slice(4), p);
        return;
      }
      if (state.tool === 'add:blank') {
        placeGate('blank', p);
        return;
      }
      if (state.tool === 'add:input' || state.tool === 'add:output') {
        placeTerminal(state.tool.slice(4), p);
        return;
      }
      var target = evt.target.closest('[data-logic-node],[data-wire-index],[data-logic-resize]');
      if (!target) {
        state.selected = null;
        state.wirePending = null;
        render();
      }
    }

    function renderInspector(model) {
      if (!state.selected) {
        inspector.hidden = true;
        inspector.innerHTML = '';
        return;
      }
      inspector.hidden = false;
      var html = '';
      if (state.selected.kind === 'gate') {
        var g = model.gates[state.selected.index];
        if (!g) {
          inspector.hidden = true;
          return;
        }
        var isBlank = Array.isArray(g.accept);
        html =
          '<h3 class="wizard-logic-editor__inspector-title">Gate</h3>' +
          '<label>Id<input type="text" data-inspect="id" value="' +
          escapeHtml(g.id) +
          '" /></label>' +
          '<label>Mode<select data-inspect="mode">' +
          '<option value="GATE"' +
          (isBlank ? '' : ' selected') +
          '>Prefilled gate</option>' +
          '<option value="BLANK"' +
          (isBlank ? ' selected' : '') +
          '>Pupil-fill blank</option>' +
          '</select></label>';
        if (isBlank) {
          html +=
            '<label>Accepted answers (comma-separated)' +
            '<textarea data-inspect="accept" rows="2">' +
            escapeHtml((g.accept || []).join(', ')) +
            '</textarea></label>';
        } else {
          html +=
            '<label>Type<select data-inspect="type">' +
            GATE_TYPES.map(function (t) {
              return (
                '<option value="' +
                t +
                '"' +
                (t === g.type ? ' selected' : '') +
                '>' +
                t +
                '</option>'
              );
            }).join('') +
            '</select></label>';
        }
        html +=
          '<button type="button" data-inspect-action="delete" class="btn btn--danger btn--sm">Delete gate</button>';
      } else if (state.selected.kind === 'terminal') {
        var t = model.terminals[state.selected.index];
        if (!t) {
          inspector.hidden = true;
          return;
        }
        html =
          '<h3 class="wizard-logic-editor__inspector-title">Terminal</h3>' +
          '<label>Id<input type="text" data-inspect="id" value="' +
          escapeHtml(t.id) +
          '" /></label>' +
          '<label>Kind<select data-inspect="kind">' +
          '<option value="input"' +
          (t.kind === 'input' ? ' selected' : '') +
          '>Input</option>' +
          '<option value="output"' +
          (t.kind === 'output' ? ' selected' : '') +
          '>Output</option>' +
          '</select></label>' +
          '<label>Label<input type="text" data-inspect="label" value="' +
          escapeHtml(t.label || '') +
          '" maxlength="8" /></label>' +
          '<button type="button" data-inspect-action="delete" class="btn btn--danger btn--sm">Delete terminal</button>';
      } else {
        var w = model.wires[state.selected.index];
        if (!w) {
          inspector.hidden = true;
          return;
        }
        html =
          '<h3 class="wizard-logic-editor__inspector-title">Wire</h3>' +
          '<p class="wizard-logic-editor__inspector-meta">' +
          escapeHtml(w.from) +
          ' → ' +
          escapeHtml(w.to) +
          '</p>' +
          '<button type="button" data-inspect-action="delete" class="btn btn--danger btn--sm">Delete wire</button>';
      }
      inspector.innerHTML = html;
    }

    function renderStage(model) {
      var size = canvasSize();
      stage.setAttribute('viewBox', '0 0 ' + size.w + ' ' + size.h);
      stage.setAttribute('width', String(size.w));
      stage.setAttribute('height', String(size.h));

      var svg = '';

      // Wires under gates/terminals.
      for (var wi = 0; wi < model.wires.length; wi++) {
        var w = model.wires[wi];
        var p1 = null,
          p2 = null;
        var fromRef = findNode(model, w.from);
        var toRef = findNode(model, w.to);
        if (!fromRef || !toRef) continue;
        p1 =
          fromRef.kind === 'gate'
            ? gateCentre(model.gates[fromRef.index])
            : model.terminals[fromRef.index];
        p2 =
          toRef.kind === 'gate'
            ? gateCentre(model.gates[toRef.index])
            : model.terminals[toRef.index];
        var sel = state.selected && state.selected.kind === 'wire' && state.selected.index === wi;
        svg +=
          '<line class="wizard-logic-editor__wire' +
          (sel ? ' is-selected' : '') +
          '" ' +
          'data-wire-index="' +
          wi +
          '" ' +
          'x1="' +
          p1.x +
          '" y1="' +
          p1.y +
          '" x2="' +
          p2.x +
          '" y2="' +
          p2.y +
          '" />';
      }

      // Gates.
      for (var gi = 0; gi < model.gates.length; gi++) {
        var g = model.gates[gi];
        var blank = Array.isArray(g.accept);
        var selG = state.selected && state.selected.kind === 'gate' && state.selected.index === gi;
        var pending = state.wirePending === g.id;
        var classes =
          'wizard-logic-editor__gate' +
          (blank ? ' is-blank' : '') +
          (selG ? ' is-selected' : '') +
          (pending ? ' is-wire-pending' : '');
        svg += '<g class="wizard-logic-editor__node" data-logic-node="' + escapeHtml(g.id) + '">';
        if (blank) {
          svg +=
            '<rect class="' +
            classes +
            '" x="' +
            g.x +
            '" y="' +
            g.y +
            '" width="' +
            g.width +
            '" height="' +
            g.height +
            '" />' +
            '<text class="wizard-logic-editor__gate-label" x="' +
            (g.x + g.width / 2) +
            '" y="' +
            (g.y + g.height / 2) +
            '" text-anchor="middle" dominant-baseline="middle">[' +
            escapeHtml(g.id) +
            ']</text>';
        } else {
          svg += '<path class="' + classes + '" d="' + gatePath(g) + '" />';
          if (g.type === 'NOT') {
            var r = 4;
            var bx = g.x + g.width - r * 2 - 2;
            var by = g.y + g.height / 2;
            svg +=
              '<circle class="wizard-logic-editor__bubble" cx="' +
              (bx + r) +
              '" cy="' +
              by +
              '" r="' +
              r +
              '" />';
          }
          svg +=
            '<text class="wizard-logic-editor__gate-label" x="' +
            (g.x + g.width / 2) +
            '" y="' +
            (g.y + g.height / 2) +
            '" text-anchor="middle" dominant-baseline="middle">' +
            escapeHtml(g.type) +
            '</text>';
        }
        if (selG) {
          svg +=
            '<rect class="wizard-logic-editor__selection" x="' +
            g.x +
            '" y="' +
            g.y +
            '" width="' +
            g.width +
            '" height="' +
            g.height +
            '" />' +
            '<rect class="wizard-logic-editor__resize" data-logic-resize="' +
            escapeHtml(g.id) +
            '" x="' +
            (g.x + g.width - 6) +
            '" y="' +
            (g.y + g.height - 6) +
            '" width="12" height="12" />';
        }
        svg += '</g>';
      }

      // Terminals.
      for (var ti = 0; ti < model.terminals.length; ti++) {
        var t = model.terminals[ti];
        var selT =
          state.selected && state.selected.kind === 'terminal' && state.selected.index === ti;
        var pendingT = state.wirePending === t.id;
        var labelDx = t.kind === 'input' ? -10 : 10;
        var anchor = t.kind === 'input' ? 'end' : 'start';
        svg +=
          '<g class="wizard-logic-editor__node" data-logic-node="' +
          escapeHtml(t.id) +
          '">' +
          '<circle class="wizard-logic-editor__terminal is-' +
          t.kind +
          (selT ? ' is-selected' : '') +
          (pendingT ? ' is-wire-pending' : '') +
          '" cx="' +
          t.x +
          '" cy="' +
          t.y +
          '" r="6" />' +
          '<text class="wizard-logic-editor__terminal-label" x="' +
          (t.x + labelDx) +
          '" y="' +
          t.y +
          '" text-anchor="' +
          anchor +
          '" dominant-baseline="middle">' +
          escapeHtml(t.label || '') +
          '</text>' +
          '</g>';
      }

      stage.innerHTML = svg;
    }

    function render() {
      var model = readModel();
      renderStage(model);
      renderInspector(model);
    }

    toolbar.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-logic-tool]');
      if (!btn) return;
      evt.preventDefault();
      setTool(btn.getAttribute('data-logic-tool'));
      render();
    });

    stage.addEventListener('mousedown', function (evt) {
      var resize = evt.target.closest('[data-logic-resize]');
      if (resize) {
        beginDrag(evt, resize.getAttribute('data-logic-resize'), 'resize');
        return;
      }
      var node = evt.target.closest('[data-logic-node]');
      if (node && state.tool === 'select') {
        onNodeClick(evt, node.getAttribute('data-logic-node'));
        beginDrag(evt, node.getAttribute('data-logic-node'), 'move');
      }
    });

    stage.addEventListener('click', function (evt) {
      if (evt.target.closest('[data-logic-resize]')) return;
      var node = evt.target.closest('[data-logic-node]');
      if (node) {
        onNodeClick(evt, node.getAttribute('data-logic-node'));
        return;
      }
      var wire = evt.target.closest('[data-wire-index]');
      if (wire) {
        onWireClick(evt, parseInt(wire.getAttribute('data-wire-index'), 10));
        return;
      }
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
      if (state.selected.kind === 'gate') {
        var g = model.gates[state.selected.index];
        if (!g) return;
        if (name === 'id') {
          var newId = field.value.trim();
          if (!newId || newId === g.id) return;
          if (
            model.gates.some(function (x) {
              return x.id === newId;
            })
          )
            return;
          if (
            model.terminals.some(function (x) {
              return x.id === newId;
            })
          )
            return;
          for (var i = 0; i < model.wires.length; i++) {
            if (model.wires[i].from === g.id) model.wires[i].from = newId;
            if (model.wires[i].to === g.id) model.wires[i].to = newId;
          }
          g.id = newId;
        } else if (name === 'accept') {
          delete g.type;
          g.accept = field.value
            .split(',')
            .map(function (s) {
              return s.trim();
            })
            .filter(function (s) {
              return s.length > 0;
            });
        }
      } else if (state.selected.kind === 'terminal') {
        var t = model.terminals[state.selected.index];
        if (!t) return;
        if (name === 'id') {
          var nid = field.value.trim();
          if (!nid || nid === t.id) return;
          if (
            model.gates.some(function (x) {
              return x.id === nid;
            })
          )
            return;
          if (
            model.terminals.some(function (x) {
              return x.id === nid;
            })
          )
            return;
          for (var j = 0; j < model.wires.length; j++) {
            if (model.wires[j].from === t.id) model.wires[j].from = nid;
            if (model.wires[j].to === t.id) model.wires[j].to = nid;
          }
          t.id = nid;
        } else if (name === 'label') {
          t.label = field.value.slice(0, 8);
        }
      }
      writeModel(model);
    });

    inspector.addEventListener('change', function (evt) {
      var field = evt.target.closest('[data-inspect]');
      if (!field) return;
      var name = field.getAttribute('data-inspect');
      var model = readModel();
      if (!state.selected) return;
      if (state.selected.kind === 'gate') {
        var g = model.gates[state.selected.index];
        if (!g) return;
        if (name === 'type') {
          if (GATE_TYPES.indexOf(field.value) !== -1) g.type = field.value;
        } else if (name === 'mode') {
          if (field.value === 'BLANK' && !Array.isArray(g.accept)) {
            delete g.type;
            g.accept = [];
          } else if (field.value === 'GATE' && Array.isArray(g.accept)) {
            delete g.accept;
            g.type = 'AND';
          }
        }
        writeModel(model);
      } else if (state.selected.kind === 'terminal') {
        var t = model.terminals[state.selected.index];
        if (!t) return;
        if (name === 'kind') {
          t.kind = field.value === 'output' ? 'output' : 'input';
          writeModel(model);
        }
      }
    });

    inspector.addEventListener('click', function (evt) {
      var btn = evt.target.closest('[data-inspect-action="delete"]');
      if (!btn) return;
      evt.preventDefault();
      if (!state.selected) return;
      var model = readModel();
      if (state.selected.kind === 'gate') {
        var removed = model.gates.splice(state.selected.index, 1)[0];
        if (removed)
          model.wires = model.wires.filter(function (x) {
            return x.from !== removed.id && x.to !== removed.id;
          });
      } else if (state.selected.kind === 'terminal') {
        var r = model.terminals.splice(state.selected.index, 1)[0];
        if (r)
          model.wires = model.wires.filter(function (x) {
            return x.from !== r.id && x.to !== r.id;
          });
      } else {
        model.wires.splice(state.selected.index, 1);
      }
      state.selected = null;
      writeModel(model);
    });

    document.addEventListener('keydown', function (evt) {
      if (!state.selected) return;
      if (evt.key !== 'Delete' && evt.key !== 'Backspace' && evt.key !== 'Escape') return;
      var active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
      )
        return;
      evt.preventDefault();
      if (evt.key === 'Escape') {
        state.selected = null;
        state.wirePending = null;
        render();
        return;
      }
      var btn = inspector.querySelector('[data-inspect-action="delete"]');
      if (btn) btn.click();
    });

    gatesArea.addEventListener('input', render);
    terminalsArea.addEventListener('input', render);
    wiresArea.addEventListener('input', render);
    if (widthInput) widthInput.addEventListener('input', render);
    if (heightInput) heightInput.addEventListener('input', render);

    setTool('select');
    render();
  }

  var roots = document.querySelectorAll('[data-widget-editor="logic_diagram"][data-logic-picker]');
  for (var i = 0; i < roots.length; i++) bind(roots[i]);
})();
