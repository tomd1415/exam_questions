// Click-to-place hotspot picker for the diagram_labels widget editor.
//
// The hotspots textarea is the source of truth. The picker mounts an
// <img> overlaid with absolutely-positioned rectangles, one per line in
// the textarea. Drag on the image to draw a new hotspot (auto-id h1,
// h2, ...). Click an existing hotspot to select it; Delete/Backspace
// removes it. Every change writes back to the textarea (and dispatches
// 'input') so any other listeners stay in sync.
//
// Editor markup expected:
//   <fieldset data-widget-editor="diagram_labels">
//     <input id="imageUrl" />
//     <input id="width" /> <input id="height" />
//     <div data-picker="hotspot-stage" hidden>
//       <div data-picker-stage>
//         <img data-picker-image hidden />
//         <div data-picker-overlay></div>
//       </div>
//     </div>
//     <textarea id="hotspots" name="hotspots"></textarea>
//   </fieldset>

(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseHotspots(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var parts = line.split('|');
      if (parts.length < 5) continue;
      var x = parseInt(parts[1], 10);
      var y = parseInt(parts[2], 10);
      var w = parseInt(parts[3], 10);
      var h = parseInt(parts[4], 10);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      out.push({
        id: parts[0].trim(),
        x: x,
        y: y,
        width: w,
        height: h,
        accept: (parts.slice(5).join('|') || '').trim(),
      });
    }
    return out;
  }

  function formatHotspots(list) {
    return list
      .map(function (h) {
        return [h.id, h.x, h.y, h.width, h.height, h.accept || ''].join('|');
      })
      .join('\n');
  }

  function nextId(list) {
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      var m = /^h(\d+)$/.exec(list[i].id);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return 'h' + (max + 1);
  }

  function bind(root) {
    var stageWrap = root.querySelector('[data-picker="hotspot-stage"]');
    var stage = root.querySelector('[data-picker-stage]');
    var img = root.querySelector('[data-picker-image]');
    var overlay = root.querySelector('[data-picker-overlay]');
    var textarea = root.querySelector('textarea[name="hotspots"]');
    var imageUrl = root.querySelector('#imageUrl');
    var widthInput = root.querySelector('#width');
    var heightInput = root.querySelector('#height');
    if (!stageWrap || !stage || !img || !overlay || !textarea || !imageUrl) return;

    var selectedId = null;

    function naturalSize() {
      var w = parseInt(widthInput && widthInput.value, 10);
      var h = parseInt(heightInput && heightInput.value, 10);
      return {
        w: Number.isFinite(w) && w > 0 ? w : img.naturalWidth || 0,
        h: Number.isFinite(h) && h > 0 ? h : img.naturalHeight || 0,
      };
    }

    function scale() {
      var size = naturalSize();
      if (!size.w || !size.h) return 1;
      var rect = img.getBoundingClientRect();
      return rect.width / size.w;
    }

    function refreshImage() {
      var url = String(imageUrl.value || '').trim();
      if (!url) {
        img.hidden = true;
        stageWrap.hidden = true;
        return;
      }
      stageWrap.hidden = false;
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      img.hidden = false;
    }

    function render() {
      var hotspots = parseHotspots(textarea.value);
      var s = scale();
      var html = '';
      for (var i = 0; i < hotspots.length; i++) {
        var h = hotspots[i];
        var isSel = h.id === selectedId;
        html +=
          '<button type="button" class="diagram-hotspot-editor__hotspot' +
          (isSel ? ' is-selected' : '') +
          '" data-hotspot-id="' +
          escapeHtml(h.id) +
          '" style="left:' +
          h.x * s +
          'px;top:' +
          h.y * s +
          'px;width:' +
          h.width * s +
          'px;height:' +
          h.height * s +
          'px;">' +
          '<span class="diagram-hotspot-editor__hotspot-label">' +
          escapeHtml(h.id) +
          '</span>' +
          '</button>';
      }
      overlay.innerHTML = html;
    }

    function writeBack(list) {
      textarea.value = formatHotspots(list);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      render();
    }

    overlay.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-hotspot-id]');
      if (!btn) return;
      ev.preventDefault();
      selectedId = btn.getAttribute('data-hotspot-id');
      render();
    });

    document.addEventListener('keydown', function (ev) {
      if (!selectedId) return;
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      ev.preventDefault();
      var list = parseHotspots(textarea.value).filter(function (h) {
        return h.id !== selectedId;
      });
      selectedId = null;
      writeBack(list);
    });

    var dragStart = null;
    var dragGhost = null;

    function pointToImage(ev) {
      var rect = img.getBoundingClientRect();
      var s = scale() || 1;
      return {
        x: Math.max(0, Math.round((ev.clientX - rect.left) / s)),
        y: Math.max(0, Math.round((ev.clientY - rect.top) / s)),
      };
    }

    img.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      dragStart = pointToImage(ev);
      dragGhost = document.createElement('div');
      dragGhost.className = 'diagram-hotspot-editor__ghost';
      overlay.appendChild(dragGhost);
    });

    document.addEventListener('mousemove', function (ev) {
      if (!dragStart || !dragGhost) return;
      var p = pointToImage(ev);
      var s = scale();
      var x = Math.min(dragStart.x, p.x);
      var y = Math.min(dragStart.y, p.y);
      var w = Math.abs(p.x - dragStart.x);
      var h = Math.abs(p.y - dragStart.y);
      dragGhost.style.left = x * s + 'px';
      dragGhost.style.top = y * s + 'px';
      dragGhost.style.width = w * s + 'px';
      dragGhost.style.height = h * s + 'px';
    });

    document.addEventListener('mouseup', function (ev) {
      if (!dragStart) return;
      var start = dragStart;
      dragStart = null;
      if (dragGhost && dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
      dragGhost = null;
      var p = pointToImage(ev);
      var x = Math.min(start.x, p.x);
      var y = Math.min(start.y, p.y);
      var w = Math.abs(p.x - start.x);
      var h = Math.abs(p.y - start.y);
      if (w < 10 || h < 10) {
        w = Math.max(w, 80);
        h = Math.max(h, 30);
      }
      var list = parseHotspots(textarea.value);
      var id = nextId(list);
      list.push({ id: id, x: x, y: y, width: w, height: h, accept: '' });
      selectedId = id;
      writeBack(list);
    });

    img.addEventListener('load', render);
    window.addEventListener('resize', render);
    textarea.addEventListener('input', render);
    imageUrl.addEventListener('input', refreshImage);
    if (widthInput) widthInput.addEventListener('input', render);
    if (heightInput) heightInput.addEventListener('input', render);

    refreshImage();
    render();
  }

  var roots = document.querySelectorAll('[data-widget-editor="diagram_labels"]');
  for (var i = 0; i < roots.length; i++) bind(roots[i]);
})();
