// Isolation mode (Epic I). Double-click a group to "enter" it: everything outside is dimmed
// + non-interactive, selection / marquee / new objects scope to the group's children, and a
// breadcrumb (or Esc, or a double-click outside) exits. NESTED: double-clicking a group INSIDE
// an isolation enters a level deeper, building a breadcrumb STACK — Esc / the back button pops
// one level at a time (matching Illustrator), any earlier crumb jumps straight to that depth,
// and double-clicking outside the deepest level pops back to whichever ancestor level (or the
// stage) actually contains the click. Object.assign MIXIN — `this===editor`.
//
// State is a STACK of the isolated groups' data-hv-ids (NOT elements — ids survive history
// restore, which re-parses the DOM). The dim is a `.hv-iso` class on the stage + `.hv-iso-keep`
// on EVERY group along the chain (not just the deepest — style.css dims the unmarked direct
// children of each `.hv-iso-keep` node, so the dimming recurses to arbitrary depth automatically
// once every level of the chain carries the class), applied via CSS — kept OUT of
// history/serialize (stripped there) and re-synced from the stack after any undo/redo via
// _reconcileIsolation().
import { setStatus } from "../../app.js";

export const isolationMixin = {
  _isoStack: [],
  isIsolated() { return !!(this._isoStack && this._isoStack.length && this.stage && this.nodeById(this._isoStack[this._isoStack.length - 1])); },
  // The current parent for selection scope + new artwork: the DEEPEST isolated group, else the stage.
  _artRoot() {
    const stack = this._isoStack;
    const id = stack && stack.length ? stack[stack.length - 1] : null;
    const g = id && this.stage ? this.nodeById(id) : null;
    return g || this.stage;
  },
  _artScope() { const r = this._artRoot(); return r ? [...r.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")) : []; },
  // Where freshly-created artwork lands (so it isn't dimmed/orphaned outside the isolation).
  _artHome() { return this._artRoot(); },
  _artBefore() { return this.isIsolated() ? null : this._overlayEl(); },

  // Enter one level deeper. `g` must nest inside the CURRENT deepest level (or be any group at
  // all, if nothing is isolated yet) — entering an unrelated group would silently orphan the
  // stack levels already above it.
  enterIsolation(g) {
    if (!g || !g.hasAttribute || !g.hasAttribute("data-hv-id") || g.tagName.toLowerCase() !== "g" || g.getAttribute("data-hv-locked") === "1") return;
    const deepest = this.isIsolated() ? this.nodeById(this._isoStack[this._isoStack.length - 1]) : null;
    if (deepest && !deepest.contains(g)) return;
    this._isoStack = (this._isoStack || []).concat([g.getAttribute("data-hv-id")]);
    this.selection = new Set(); this.artboardSelected = false;
    this._applyIsoClasses(); this._renderBreadcrumb();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    const depth = this._isoStack.length;
    setStatus(depth > 1 ? `Isolation mode (${depth} levels deep) — Esc backs out one level, double-click outside exits.`
                         : "Isolation mode — editing inside the group. Esc or double-click outside to exit.", 3500);
  },
  // Back out ONE level (Esc, or the breadcrumb's own "◀ Exit" button — always the LAST crumb).
  exitIsolation() {
    if (!this._isoStack || !this._isoStack.length) return;
    const wasId = this._isoStack.pop();
    this._applyIsoClasses(); this._renderBreadcrumb();
    if (this._symEdit) { this._symFinishEdit(); return; }   // a symbol edit returns the master to <defs> + selects the instance (Epic Y)
    if (wasId && this.nodeById(wasId)) { this.selection = new Set([wasId]); this.artboardSelected = false; }
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  // Jump straight to a specific depth (clicking an EARLIER breadcrumb) — pops everything after it.
  exitIsolationToDepth(depth) {
    if (!this._isoStack || depth >= this._isoStack.length || depth < 0) return;
    this._isoStack = this._isoStack.slice(0, depth);
    this.selection = new Set(); this.artboardSelected = false;
    this._applyIsoClasses(); this._renderBreadcrumb();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  // Pop back to whichever ancestor level (or the stage, i.e. fully out) actually contains `hit` —
  // used for "double-click outside the deepest isolation" so it lands at the RIGHT level instead
  // of always exiting everything.
  _exitIsolationToContaining(hit) {
    let stack = this._isoStack || [];
    while (stack.length) {
      const root = this.nodeById(stack[stack.length - 1]);
      if (root && hit && (root.contains(hit) || hit === root)) break;
      stack = stack.slice(0, -1);
    }
    this._isoStack = stack;
    this.selection = new Set(); this.artboardSelected = false;
    this._applyIsoClasses(); this._renderBreadcrumb();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  _applyIsoClasses() {
    if (!this.stage) return;
    this.stage.classList.remove("hv-iso");
    this.stage.querySelectorAll(".hv-iso-keep").forEach((n) => { n.classList.remove("hv-iso-keep", "hv-iso-active"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    if (!this._isoStack || !this._isoStack.length) return;
    this.stage.classList.add("hv-iso");
    // Every level gets .hv-iso-keep (so style.css can dim non-path siblings all the way down),
    // but only the DEEPEST level also gets .hv-iso-active — that one's own children are the
    // active editing scope and must stay fully lit/interactive; only INTERMEDIATE levels'
    // off-path children (siblings of the next level in) get dimmed.
    this._isoStack.forEach((id, i) => {
      const g = this.nodeById(id); if (!g) return;
      g.classList.add("hv-iso-keep");
      if (i === this._isoStack.length - 1) g.classList.add("hv-iso-active");
    });
  },
  // Re-sync isolation to the live document after a mount / undo / redo (the old elements are
  // gone). Walks the stack from the OUTERMOST level in, truncating at the first id that no
  // longer resolves to a live descendant of the level above it (deleted, reparented elsewhere,
  // or a different doc loaded entirely).
  _reconcileIsolation() {
    const stack = this._isoStack || [];
    let prev = this.stage, i = 0;
    if (prev) for (; i < stack.length; i++) {
      const g = this.nodeById(stack[i]);
      if (!g || !prev.contains(g)) break;
      prev = g;
    } else i = 0;
    this._isoStack = stack.slice(0, i);
    this._applyIsoClasses(); this._renderBreadcrumb();
  },
  _renderBreadcrumb() {
    const wrap = this.stage && this.stage.closest && this.stage.closest(".stage-wrap");
    let bar = wrap && wrap.querySelector(".hv-iso-crumb");
    if (!this.isIsolated()) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.className = "hv-iso-crumb"; wrap.appendChild(bar); }
    bar.innerHTML = "";
    const back = document.createElement("button"); back.type = "button"; back.className = "hv-iso-back"; back.textContent = "◀ Exit";
    back.title = "Back out one level (Esc)"; back.addEventListener("click", () => this.exitIsolation());
    bar.appendChild(back);
    // One clickable crumb per level — an earlier crumb jumps straight to that depth. The LAST
    // (current) crumb isn't a link, matching how the back button already covers "leave here".
    this._isoStack.forEach((id, depth) => {
      const sep = document.createElement("span"); sep.className = "hv-iso-sep"; sep.textContent = "›";
      bar.appendChild(sep);
      const g = this.nodeById(id);
      const label = (g && this.nodeName && this.nodeName(g)) || "Group";
      if (depth < this._isoStack.length - 1) {
        const crumb = document.createElement("button"); crumb.type = "button"; crumb.className = "hv-iso-name hv-iso-link"; crumb.textContent = label;
        crumb.title = `Jump back to “${label}”`;
        crumb.addEventListener("click", () => this.exitIsolationToDepth(depth + 1));
        bar.appendChild(crumb);
      } else {
        const lbl = document.createElement("span"); lbl.className = "hv-iso-name"; lbl.textContent = label;
        bar.appendChild(lbl);
      }
    });
  },
  // Double-click routing (called from _onDblClick when it isn't a text edit).
  _isoDblClick(e) {
    const hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (this.isIsolated()) {
      const root = this.nodeById(this._isoStack[this._isoStack.length - 1]);
      if (!hit || (!root.contains(hit) && hit !== root)) { e.stopPropagation(); this._exitIsolationToContaining(hit); return; }
      // Inside the current level: double-clicking a GROUP enters it a level deeper (nested).
      let top = hit; while (top.parentNode && top.parentNode !== root) top = top.parentNode;
      if (top && top.nodeType === 1 && top.tagName.toLowerCase() === "g" && top.hasAttribute("data-hv-id") && top.getAttribute("data-hv-locked") !== "1") {
        e.stopPropagation(); e.preventDefault(); this.enterIsolation(top);
      }
      return;
    }
    if (!hit) return;
    let top = hit; while (top.parentNode && top.parentNode !== this.stage) top = top.parentNode;
    if (!top || top.nodeType !== 1 || top.getAttribute("data-hv-locked") === "1") return;
    const tag = top.tagName.toLowerCase();
    if (tag === "use" && this.isSymbolInstance && this.isSymbolInstance(top)) { e.stopPropagation(); e.preventDefault(); this.editSymbol(top); return; }   // edit the symbol master (Epic Y)
    if (tag === "g" && top.hasAttribute("data-hv-id")) { e.stopPropagation(); e.preventDefault(); this.enterIsolation(top); }
  },
};
