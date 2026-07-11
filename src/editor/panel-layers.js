// Layers panel rendering — extracted from editor.js (#30, panel-layers). A MIXIN
// (Object.assign(editor, layersMixin)): the panel's render + row builders + row
// interaction (click-select, inline rename, drag-reorder drop marks). The model
// operations these drive (setVisibility/toggleLock/rename/_reorderDrop/
// _reorderManyToRoot, the _ensureIds/_artworkNodes/_rasterSwatchThumb helpers)
// stay on editor.js and are reached via `this.` — so behaviour is identical.
import { toHexColor } from "../hv/index.js";
import { createPointerDrag } from "../ui/pointer-drag.js";

export const layersMixin = {
  _layerClick(id, e) {
    const order = this._visibleLayerOrder || this._artworkNodes().map((n) => n.getAttribute("data-hv-id")).reverse();   // flattened front-first, like the panel
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this._lastLayerId && order.includes(this._lastLayerId)) {
      const a = order.indexOf(this._lastLayerId), b = order.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!additive) this.selection = new Set();
      for (let i = lo; i <= hi; i++) {
        const nn = this.nodeById(order[i]);
        if (nn && nn.getAttribute("data-hv-locked") !== "1") this.selection.add(order[i]);
      }
    } else if (additive) {
      this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
      this._lastLayerId = id;
    } else {
      this.selection = new Set([id]);
      this._lastLayerId = id;
    }
    this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
  },

  _clearDropMarks() {
    document.querySelectorAll("#layers-list .drop-before, #layers-list .drop-after, #layers-list .drop-into, #layers-foot .drop-into, #layers-list.drop-root")
      .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into", "drop-root"));
  },

  _renderLayers() {
    const list = document.querySelector("#layers-list");
    if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    this._ensureIds();
    if (!this._collapsedGroups) this._collapsedGroups = new Set();
    this._visibleLayerOrder = [];   // flattened, front-first — drives shift-range selection
    const renderLevel = (parent, depth) => {
      const kids = [...parent.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id"));
      for (const n of kids.reverse()) {                       // top of the list = frontmost
        const id = n.getAttribute("data-hv-id");
        const isGroup = n.tagName.toLowerCase() === "g";
        const collapsed = this._collapsedGroups.has(id);
        this._visibleLayerOrder.push(id);
        list.appendChild(this._buildLayerRow(n, id, depth, isGroup, collapsed));
        if (isGroup && !collapsed) renderLevel(n, depth + 1);  // nested children, indented
      }
    };
    renderLevel(this.stage, 0);
    const lc = document.querySelector("#layers-count");
    if (lc) { const n = this._artworkNodes().length; lc.textContent = n ? String(n) : ""; }
    // Artboard row, pinned to the Layers chin (#layers-foot, below the scrolling list) so
    // it never scrolls away — a reliable click target for the canvas, and a drop target
    // that pulls a layer back out to the top level.
    const foot = document.querySelector("#layers-foot");
    if (foot) foot.innerHTML = "";
    const abRow = document.createElement("div");
    abRow.className = "layer-row artboard-row" + (this.artboardSelected ? " active" : "");
    const abSwatch = document.createElement("span");
    abSwatch.className = "layer-swatch";
    const ab = this.artboardEl();
    const abFill = ab && toHexColor(ab.getAttribute("fill"));
    if (abFill && ab.getAttribute("fill") !== "none") { abSwatch.style.background = abFill; abSwatch.style.backgroundImage = "none"; }
    abSwatch.title = (ab && ab.getAttribute("fill")) || "no background";
    const abName = document.createElement("span");
    abName.className = "layer-name"; abName.textContent = "Artboard";
    abName.title = "The canvas (Shift+O)";
    abRow.append(abSwatch, abName);
    abRow.addEventListener("click", () => this.selectArtboard());
    // Right-click the Artboard row → same artboard panel as right-clicking the canvas.
    abRow.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      this.selectArtboard();
      if (this.openContextPanel) this.openContextPanel(e.clientX, e.clientY, "canvas");
    });
    // Dropping layer(s) onto the Artboard row — or into the empty space below the list — pulls them
    // out to the top level. Both used to be their own HTML5 dragover/drop handlers; they're part of
    // the pointer-drag hit-test now (_layerDrag), so they keep working with a finger too.
    (foot || list).appendChild(abRow);
    // Orient the panel to the selection: scroll the (first) active row into view.
    const act = list.querySelector(".layer-row.active:not(.artboard-row)");
    if (act) act.scrollIntoView({ block: "nearest" });
  },
  _buildLayerRow(n, id, depth, isGroup, collapsed) {
    const row = document.createElement("div");
    row.className = "layer-row" + (this.selection.has(id) ? " active" : "") + (isGroup ? " is-group" : "");
    row.dataset.id = id;
    row.style.paddingLeft = (6 + depth * 14) + "px";

    // Touch reorders from this grip, and scrolls the list from anywhere else — a finger dragging a
    // row is otherwise indistinguishable from a finger scrolling the panel. A mouse can still drag
    // the whole row.
    const grip = document.createElement("span");
    grip.className = "layer-grip";
    grip.textContent = "⠿";
    grip.title = "Drag to reorder";
    grip.setAttribute("aria-hidden", "true");
    row.appendChild(grip);

    // group expand/collapse twisty (a hidden spacer keeps leaf rows aligned)
    const twist = document.createElement("button");
    twist.type = "button"; twist.className = "layer-twist" + (isGroup ? "" : " leaf");
    if (isGroup) {
      twist.textContent = collapsed ? "▸" : "▾";
      twist.title = collapsed ? "Expand group" : "Collapse group";
      twist.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._collapsedGroups.has(id)) this._collapsedGroups.delete(id); else this._collapsedGroups.add(id);
        this._renderLayers();
      });
    }

    const eye = document.createElement("button");
    eye.type = "button"; eye.className = "layer-btn";
    const hidden = n.getAttribute("display") === "none";
    eye.textContent = hidden ? "○" : "●"; eye.title = hidden ? "Show" : "Hide";
    eye.addEventListener("click", (e) => { e.stopPropagation(); this.setVisibility(id, hidden); });

    const swatch = document.createElement("span");
    swatch.className = "layer-swatch" + (isGroup ? " group" : "");
    if (isGroup) {
      const clipped = this._clipGroupOf && this._clipGroupOf(n) === n;
      const masked = this._maskGroupOf && this._maskGroupOf(n) === n;
      if (clipped) { swatch.textContent = "⛶"; swatch.title = "Clipping mask group"; }
      else if (masked) { swatch.textContent = "◑"; swatch.title = "Opacity mask group"; }
      else { swatch.textContent = "▤"; swatch.title = "Group"; }
    }
    else if (this.isRaster(n)) {
      // Rasters have no fill — show a small thumbnail of the image instead of a colour chip.
      const href = n.getAttribute("href") || n.getAttribute("xlink:href") || "";
      swatch.classList.add("raster");
      swatch.title = "Raster image";
      if (href) this._rasterSwatchThumb(n, swatch, href);
      else swatch.textContent = "🖼";
    }
    else {
      const fill = toHexColor(n.getAttribute("fill"));
      if (fill && n.getAttribute("fill") !== "none") { swatch.style.background = fill; swatch.style.backgroundImage = "none"; }
      swatch.title = n.getAttribute("fill") || "no fill";
    }

    const name = document.createElement("span");
    name.className = "layer-name"; name.textContent = this.nodeName(n);
    name.title = "Double-click to rename";

    const lock = document.createElement("button");
    lock.type = "button"; lock.className = "layer-btn";
    const locked = n.getAttribute("data-hv-locked") === "1";
    lock.textContent = locked ? "L" : "·"; lock.title = locked ? "Unlock" : "Lock"; lock.classList.toggle("on", locked);
    lock.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(id); });

    row.append(twist, eye, swatch, name, lock);
    row.addEventListener("click", (e) => { if (n.getAttribute("data-hv-locked") === "1") return; this._layerClick(id, e); });
    row.addEventListener("dblclick", (e) => { e.stopPropagation(); this._renameInline(n, name); });
    // Right-click a row → the same object context panel as right-clicking on canvas
    // (one consistent route for right-click actions).
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (n.getAttribute("data-hv-locked") === "1") return;
      if (!this.selection.has(id)) { this.selection = new Set([id]); this.artboardSelected = false; this._renderSelection(); this._renderInspector(); }
      if (this.openContextPanel) this.openContextPanel(e.clientX, e.clientY, "object");
    });
    this._layerDrag().arm(row);   // pointer-drag, not HTML5 DnD — see _layerDrag below
    return row;
  },
  // Reordering layers by dragging was built on HTML5 drag-and-drop, which NEVER fires from a
  // finger — so on a phone the layer list simply could not be reordered at all. Same helper the
  // toolbars use now. The hit-test below is the old dragover logic, unchanged: group rows have
  // three zones (before / nest-into / after) so the "crevices" decide whether you're dropping
  // INTO a group or BETWEEN rows; leaf rows just split in half.
  _layerDrag() {
    if (this._layerDragCtl) return this._layerDragCtl;
    const listEl = () => document.querySelector("#layers-list");
    const hit = (x, y) => (document.elementFromPoint(x, y) || null);
    const rowAt = (x, y) => {
      const el = hit(x, y);
      const row = el && el.closest ? el.closest("#layers-list .layer-row") : null;
      return row && !row.classList.contains("artboard-row") ? row : null;
    };
    // Dropping on the pinned Artboard row, or in the empty space below the rows, pulls the layer(s)
    // OUT to the top level. Those were separate HTML5 dragover/drop handlers on the row and the
    // list; they'd have died silently with the rest of DnD, so they're folded in here.
    const rootAt = (x, y) => {
      const el = hit(x, y);
      if (!el || !el.closest) return null;
      if (el.closest("#layers-foot .artboard-row")) return el.closest(".artboard-row");
      const list = listEl();
      if (list && el === list) return list;   // empty space below the rows
      return null;
    };
    const clearDrag = () => {
      this._clearDropMarks();
      document.querySelectorAll("#layers-list .layer-row.dragging").forEach((r) => r.classList.remove("dragging"));
      this._dragLayerIds = null; this._dropTarget = null;
    };
    this._layerDragCtl = createPointerDrag({
      ignoreFrom: "button, input, .layer-rename",   // the eye/twisty/rename are their own controls
      touchHandle: ".layer-grip",                   // touch: grip reorders, elsewhere scrolls the list
      ghostAxis: "y",                               // rows are full-width; tracking x would fling them sideways
      // A constant container, so onMove always runs and can decide between row / root / nothing.
      containerAt: (x, y) => ((rowAt(x, y) || rootAt(x, y)) ? listEl() : null),
      onStart: (row) => {
        const id = row.dataset.id;
        // grab the whole multi-selection together when the dragged row is part of it
        const ids = (this.selection.has(id) && this.selection.size > 1) ? [...this.selection] : [id];
        this._dragLayerIds = ids;
        ids.forEach((d) => { const r = document.querySelector(`#layers-list .layer-row[data-id="${CSS.escape(d)}"]`); if (r) r.classList.add("dragging"); });
      },
      onMove: (row, cont, x, y) => {
        this._clearDropMarks();
        this._dropTarget = null;
        const over = rowAt(x, y);
        if (over && over !== row) {
          const r = over.getBoundingClientRect(), dy = y - r.top;
          const isGroup = over.classList.contains("is-group");
          // where the drop lands ON SCREEN (drives the marker line)
          const vis = isGroup
            ? (dy < r.height * 0.3 ? "before" : dy > r.height * 0.7 ? "after" : "into")
            : (dy < r.height / 2 ? "before" : "after");
          over.classList.add(vis === "into" ? "drop-into" : vis === "before" ? "drop-before" : "drop-after");
          // ...and the DOM position that corresponds to it, which is the OPPOSITE. The list renders
          // front-first (kids.reverse()), so the row ABOVE another is LATER in the DOM, while
          // _reorderDrop's "before"/"after" are plain DOM-order insertBefore/insertAfter. Passing the
          // on-screen position straight through — as the old HTML5 drag handler did — meant dropping
          // a layer above another actually sent it below. A real bug, live for as long as the drag
          // has existed, and invisible because no test ever performed an actual drag.
          const pos = vis === "into" ? "into" : (vis === "before" ? "after" : "before");
          this._dropTarget = { id: over.dataset.id, pos };
          return;
        }
        const root = rootAt(x, y);
        if (root) {
          root.classList.add(root.classList.contains("artboard-row") ? "drop-into" : "drop-root");
          this._dropTarget = { root: true };
        }
      },
      onDrop: () => {
        const ids = this._dragLayerIds || [], t = this._dropTarget;
        clearDrag();
        if (!ids.length || !t) return;
        if (t.root) this._reorderManyToRoot(ids);
        else this._reorderDrop(ids, t.id, t.pos);
      },
      onCancel: clearDrag,
    });
    return this._layerDragCtl;
  },
  _renameInline(node, span) {
    const input = document.createElement("input");
    input.type = "text"; input.className = "layer-rename"; input.value = this.nodeName(node);
    const done = (commit) => {
      if (commit) this.rename(node.getAttribute("data-hv-id"), input.value.trim());
      else this._renderLayers();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
    span.replaceWith(input); input.focus(); input.select();
  },
};
