// Layers panel rendering — extracted from editor.js (#30, panel-layers). A MIXIN
// (Object.assign(editor, layersMixin)): the panel's render + row builders + row
// interaction (click-select, inline rename, drag-reorder drop marks). The model
// operations these drive (setVisibility/toggleLock/rename/_reorderDrop/
// _reorderManyToRoot, the _ensureIds/_artworkNodes/_rasterSwatchThumb helpers)
// stay on editor.js and are reached via `this.` — so behaviour is identical.
import { toHexColor } from "../hv/index.js";

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
    // Drop layer(s) onto the Artboard row → move them out to the top level (out of any group).
    const rootDrop = (e) => {
      e.preventDefault(); this._clearDropMarks();
      const ids = (this._dragLayerIds && this._dragLayerIds.length) ? this._dragLayerIds : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
      if (ids.length) this._reorderManyToRoot(ids);
    };
    abRow.addEventListener("dragover", (e) => { e.preventDefault(); this._clearDropMarks(); abRow.classList.add("drop-into"); });
    abRow.addEventListener("dragleave", () => abRow.classList.remove("drop-into"));
    abRow.addEventListener("drop", rootDrop);
    (foot || list).appendChild(abRow);
    // Drop in the empty space of the list (below all rows) → also pull out to the top level.
    if (!list._dropWired) {
      list.addEventListener("dragover", (e) => { if (e.target !== list) return; e.preventDefault(); this._clearDropMarks(); list.classList.add("drop-root"); });
      list.addEventListener("drop", (e) => { if (e.target !== list) return; rootDrop(e); });
      list._dropWired = true;
    }
    // Orient the panel to the selection: scroll the (first) active row into view.
    const act = list.querySelector(".layer-row.active:not(.artboard-row)");
    if (act) act.scrollIntoView({ block: "nearest" });
  },
  _buildLayerRow(n, id, depth, isGroup, collapsed) {
    const row = document.createElement("div");
    row.className = "layer-row" + (this.selection.has(id) ? " active" : "") + (isGroup ? " is-group" : "");
    row.draggable = true; row.dataset.id = id;
    row.style.paddingLeft = (6 + depth * 14) + "px";

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
    row.addEventListener("dragstart", (e) => {
      // grab the whole multi-selection together when the dragged row is part of it
      const ids = (this.selection.has(id) && this.selection.size > 1) ? [...this.selection] : [id];
      this._dragLayerIds = ids;
      e.dataTransfer.setData("text/plain", ids.join(",")); e.dataTransfer.effectAllowed = "move";
      ids.forEach((d) => { const r = document.querySelector(`#layers-list .layer-row[data-id="${CSS.escape(d)}"]`); if (r) r.classList.add("dragging"); });
    });
    row.addEventListener("dragend", () => { this._dragLayerIds = null; this._dropPos = null; document.querySelectorAll("#layers-list .layer-row.dragging").forEach((r) => r.classList.remove("dragging")); this._clearDropMarks(); });
    row.addEventListener("dragover", (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect(), y = e.clientY - r.top;
      // group rows have 3 zones (before / nest-into / after) — the "crevices" decide
      // whether you're adding INTO the group or BETWEEN rows; leaf rows split in half.
      const pos = isGroup ? (y < r.height * 0.3 ? "before" : y > r.height * 0.7 ? "after" : "into") : (y < r.height / 2 ? "before" : "after");
      this._clearDropMarks();
      row.classList.add(pos === "into" ? "drop-into" : pos === "before" ? "drop-before" : "drop-after");
      this._dropPos = pos;
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const ids = (this._dragLayerIds && this._dragLayerIds.length) ? this._dragLayerIds : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
      const pos = this._dropPos || "after";
      this._clearDropMarks();
      if (ids.length) this._reorderDrop(ids, id, pos);
    });
    return row;
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
