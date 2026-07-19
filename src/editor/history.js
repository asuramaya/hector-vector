// Undo/redo + the History panel — extracted from the editor object literal (#30).
// A MIXIN: editor.js does `Object.assign(editor, historyMixin)`, so every method
// here runs with `this === editor` (reaching this.stage/history/redo/selection +
// the editor's own methods like _install/_renderSelection/_finishPen). The only
// non-`this` deps are measureFit/viewports (used at call time in _restore), so the
// editor↔app import cycle stays benign.
import { measureFit, viewports } from "../app.js";

export const historyMixin = {
  _historyMarkup() {
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay, g.hv-guideslayer, g.hv-preview").forEach((g) => g.remove());
    c.querySelectorAll(".hv-raster-hidden").forEach((n) => { n.classList.remove("hv-raster-hidden"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    c.querySelectorAll(".hv-iso-keep").forEach((n) => { n.classList.remove("hv-iso-keep"); if (!n.getAttribute("class")) n.removeAttribute("class"); });   // isolation is view-state, not history (Epic I)
    c.classList.remove("hv-pickable", "hv-iso");
    return c.outerHTML;
  },

  // ---------- history ----------
  // Each state carries the label of the action that PRODUCED it; the live document's
  // label is `_curLabel`. push()/commitCoalesce stash the pre-action state (with its
  // existing label) and set _curLabel to the new action's name, so the History panel
  // reads as a chronological list: [...history, current, ...redo-reversed].
  push(label) {
    if (!this.stage) return;
    this.commitCoalesce();                 // flush any in-progress live edit first
    this.history.push(this._state());
    this._trimHistory();
    this.redo = [];
    this._curLabel = label || "Edit";
    this._updateButtons(); this._renderHistory();
  },
  // Cap undo memory by BYTES, not just count: each snapshot is the full document
  // markup, so a multi-MB traced doc at 100 deep would hold hundreds of MB and the
  // tab would balloon. Keep the newest entries within a budget (fewer undo steps on
  // huge docs is the right trade vs. lingering memory), and never exceed 100.
  _trimHistory() {
    let budget = 64 * 1024 * 1024;         // ~64 MB of snapshots (chars ≈ 2 bytes)
    for (let i = this.history.length - 1; i >= 0; i--) {
      budget -= (this.history[i].svg.length || 0) * 2;
      if (budget < 0) {
        // Drop everything older than i — but ALWAYS keep at least the newest entry, so
        // a single snapshot larger than the whole budget doesn't wipe the entry we just
        // pushed (which silently left undo broken on huge traced docs).
        const cut = Math.min(i + 1, this.history.length - 1);
        if (cut > 0) this.history.splice(0, cut);
        return;
      }
    }
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  },
  // A run of continuous live edits (dragging a colour picker, typing a number)
  // collapses into ONE undo entry: snapshot once on begin, push it on commit.
  beginCoalesce() { if (!this._coalescing) { this._coalesceState = this._state(); this._coalescing = true; } },
  commitCoalesce(label) {
    if (!this._coalescing) return;
    this.history.push(this._coalesceState);
    this._trimHistory();
    this.redo = []; this._coalescing = false; this._coalesceState = null;
    if (label) this._curLabel = label;
    this._updateButtons(); this._renderHistory();
  },
  cancelCoalesce() { this._coalescing = false; this._coalesceState = null; },
  _state() { return { svg: this._historyMarkup(), sel: [...this.selection], ab: this.artboardSelected, abi: this._abSel, label: this._curLabel || "Edit" }; },
  undo() {
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    if (!this.history.length) return;
    this.redo.push(this._state()); const s = this.history.pop(); this._curLabel = s.label; this._restore(s); this._renderHistory();
  },
  redoAction() {
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    if (!this.redo.length) return;
    this.history.push(this._state()); const s = this.redo.pop(); this._curLabel = s.label; this._restore(s); this._renderHistory();
  },
  // Jump straight to any step in the History panel (one restore, not N steps).
  jumpTo(i) {
    if (!this.stage) return;
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    const all = [...this.history, this._state(), ...this.redo.slice().reverse()];
    if (i < 0 || i >= all.length || i === this.history.length) return;
    const target = all[i];
    this.history = all.slice(0, i);
    this.redo = all.slice(i + 1).reverse();
    this._curLabel = target.label;
    this._restore(target);
    this._renderHistory();
  },
  _renderHistory() {
    const list = document.querySelector("#history-list"); if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    const all = [...this.history, this._state(), ...this.redo.slice().reverse()];
    const cur = this.history.length;
    const hc = document.querySelector("#history-count"); if (hc) hc.textContent = this.history.length ? String(this.history.length) : "";
    all.forEach((s, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "history-row" + (i === cur ? " current" : "") + (i > cur ? " future" : "");
      row.textContent = s.label || "Edit";
      row.addEventListener("click", () => this.jumpTo(i));
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  },
  _restore(state) {
    const host = this.stage.parentElement; if (!host) return;
    const doc = new DOMParser().parseFromString(state.svg, "image/svg+xml");
    const fresh = document.importNode(doc.documentElement, true);
    fresh.classList.add("inline-svg");
    host.replaceChild(fresh, this.stage);
    this._install(fresh);   // _install -> _loadArtboards resets _abSel to null as a safe default
    this.selection = new Set(state.sel.filter((id) => this.nodeById(id)));
    this.artboardSelected = !!state.ab;
    // Restore WHICH extra artboard (if any) was selected, so undoing a K.3 move/resize doesn't
    // silently drop its on-canvas handles back to the primary's — but only if that index still
    // exists post-restore (an artboard the redo direction hasn't recreated yet, etc).
    this._abSel = (state.abi != null && this.artboards && this.artboards[state.abi]) ? state.abi : null;
    this._renderSelection();
    this._renderInspector();
    this._updateButtons();
    measureFit(viewports.output);
  },
  _updateButtons() {
    const u = document.querySelector("#undo-button"), r = document.querySelector("#redo-button");
    if (u) u.disabled = !this.history.length;
    if (r) r.disabled = !this.redo.length;
  },
};
