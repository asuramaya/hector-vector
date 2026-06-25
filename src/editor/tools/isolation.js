// Isolation mode (Epic I). Double-click a group to "enter" it: everything outside is dimmed
// + non-interactive, selection / marquee / new objects scope to the group's children, and a
// breadcrumb (or Esc, or a double-click outside) exits. Object.assign MIXIN — `this===editor`.
//
// State is the isolated group's data-hv-id (NOT the element) so it survives history restore
// (which re-parses the DOM). The dim is a `.hv-iso` class on the stage + `.hv-iso-keep` on the
// isolated root, applied via CSS — kept OUT of history/serialize (stripped there) and re-synced
// from the id after any undo/redo via _reconcileIsolation(). v1 isolates TOP-LEVEL groups
// (nested entry deferred); editing a clip group's geometry (M.5) builds on this later.
import { setStatus } from "../../app.js";

export const isolationMixin = {
  _isolatedId: null,
  isIsolated() { return !!(this._isolatedId && this.stage && this.nodeById(this._isolatedId)); },
  // The current parent for selection scope + new artwork: the isolated group, else the stage.
  _artRoot() { const g = this._isolatedId && this.stage ? this.nodeById(this._isolatedId) : null; return g || this.stage; },
  _artScope() { const r = this._artRoot(); return r ? [...r.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")) : []; },
  // Where freshly-created artwork lands (so it isn't dimmed/orphaned outside the isolation).
  _artHome() { return this._artRoot(); },
  _artBefore() { return this.isIsolated() ? null : this._overlayEl(); },

  enterIsolation(g) {
    if (!g || !g.hasAttribute || !g.hasAttribute("data-hv-id") || g.tagName.toLowerCase() !== "g" || g.getAttribute("data-hv-locked") === "1") return;
    this._isolatedId = g.getAttribute("data-hv-id");
    this.selection = new Set(); this.artboardSelected = false;
    this._applyIsoClasses(); this._renderBreadcrumb();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Isolation mode — editing inside the group. Esc or double-click outside to exit.", 3500);
  },
  exitIsolation() {
    const wasId = this._isolatedId; this._isolatedId = null;
    this._applyIsoClasses(); this._renderBreadcrumb();
    if (wasId && this.nodeById(wasId)) { this.selection = new Set([wasId]); this.artboardSelected = false; }
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  _applyIsoClasses() {
    if (!this.stage) return;
    this.stage.classList.remove("hv-iso");
    this.stage.querySelectorAll(".hv-iso-keep").forEach((n) => { n.classList.remove("hv-iso-keep"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    const g = this._isolatedId ? this.nodeById(this._isolatedId) : null;
    if (g) { this.stage.classList.add("hv-iso"); g.classList.add("hv-iso-keep"); }
  },
  // Re-sync isolation to the live document after a mount / undo / redo (the old element is gone).
  // If the isolated group no longer exists (deleted, or a different doc loaded), drop isolation.
  _reconcileIsolation() {
    if (this._isolatedId && (!this.stage || !this.nodeById(this._isolatedId))) this._isolatedId = null;
    this._applyIsoClasses(); this._renderBreadcrumb();
  },
  _renderBreadcrumb() {
    const wrap = this.stage && this.stage.closest && this.stage.closest(".stage-wrap");
    let bar = wrap && wrap.querySelector(".hv-iso-crumb");
    if (!this.isIsolated()) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.className = "hv-iso-crumb"; wrap.appendChild(bar); }
    bar.innerHTML = "";
    const back = document.createElement("button"); back.type = "button"; back.className = "hv-iso-back"; back.textContent = "◀ Exit";
    back.title = "Exit isolation (Esc)"; back.addEventListener("click", () => this.exitIsolation());
    const lbl = document.createElement("span"); lbl.className = "hv-iso-name"; lbl.textContent = "Isolated group";
    bar.appendChild(back); bar.appendChild(lbl);
  },
  // Double-click routing (called from _onDblClick when it isn't a text edit).
  _isoDblClick(e) {
    const hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (this.isIsolated()) {
      const root = this.nodeById(this._isolatedId);
      if (!hit || (!root.contains(hit) && hit !== root)) { e.stopPropagation(); this.exitIsolation(); }
      return;   // nested entry (double-click a group inside) deferred
    }
    if (!hit) return;
    let top = hit; while (top.parentNode && top.parentNode !== this.stage) top = top.parentNode;
    if (top && top.nodeType === 1 && top.tagName.toLowerCase() === "g" && top.hasAttribute("data-hv-id") && top.getAttribute("data-hv-locked") !== "1") { e.stopPropagation(); e.preventDefault(); this.enterIsolation(top); }
  },
};
