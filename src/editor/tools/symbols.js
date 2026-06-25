// Symbols & instances (Epic Y). A symbol is a reusable master — a `<g class="hv-symbol">`
// living in <defs> — and each instance on the stage is a `<use href="#sym">`. Because <use>
// is a live reference, editing the master updates EVERY instance for free (SVG-native). All
// standard SVG, so symbols + instances round-trip through save/reopen untouched. Editing the
// master reuses Isolation mode (Epic I): the master is surfaced onto the stage, isolated for
// editing, and returned to <defs> on exit — instances update live the whole time.
// Object.assign MIXIN — `this === editor`.
import { SVG_NS } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const symbolsMixin = {
  isSymbolInstance(n) { return !!(n && n.tagName && n.tagName.toLowerCase() === "use" && n.hasAttribute("data-hv-id")); },
  _symbolMasterOf(use) {
    if (!use || !this.stage) return null;
    const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
    const m = /#(.+)$/.exec(href.trim()); if (!m) return null;
    const el = this.stage.querySelector("#" + CSS.escape(m[1]));
    return el && el.classList && el.classList.contains("hv-symbol") ? el : null;
  },
  // Make a symbol from the selection: move the artwork into a <g class="hv-symbol"> in defs and
  // drop a <use> instance where it was (rendered in place since the content keeps its coords).
  makeSymbol() {
    if (!this.stage) return;
    const sel = this._topSelection(this.selectedNodes()).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id"));
    if (!sel.length) { setStatus("Select artwork to turn into a symbol.", 3000); return; }
    if (sel.some((n) => this.isSymbolInstance(n))) { setStatus("That's already a symbol instance.", 2500); return; }
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    this.push("Make symbol");
    const symId = this._mintDefId("hvsym");
    const sym = document.createElementNS(SVG_NS, "g"); sym.setAttribute("id", symId); sym.setAttribute("class", "hv-symbol");
    const front = sel[sel.length - 1], parent = front.parentNode, anchor = front.nextSibling, ov = this._overlayEl();
    sel.forEach((n) => sym.appendChild(n));
    sym.querySelectorAll("[data-hv-id]").forEach((n) => n.removeAttribute("data-hv-id"));   // master content is defs-only — no stage ids (re-tagged on edit)
    this._defs().appendChild(sym);
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("data-hv-id", "n" + (++this.idSeq)); use.setAttribute("href", "#" + symId);
    if (anchor && anchor.parentNode === parent && anchor !== ov) parent.insertBefore(use, anchor); else parent.appendChild(use);
    this.selection = new Set([use.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Made a symbol. Double-click an instance to edit the master · duplicate for more instances.", 4000);
  },
  // Break the link: replace the instance with an independent concrete copy of the master content.
  breakSymbolLink(use) {
    use = use || this.selectedNodes().find((n) => this.isSymbolInstance(n));
    const sym = this._symbolMasterOf(use); if (!sym) return;
    this.push("Break symbol link");
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    const t = use.getAttribute("transform"); if (t) g.setAttribute("transform", t);
    const x = parseFloat(use.getAttribute("x")), y = parseFloat(use.getAttribute("y"));
    if ((x || y) && !t) g.setAttribute("transform", `translate(${x || 0} ${y || 0})`);
    for (const c of [...sym.children]) g.appendChild(c.cloneNode(true));
    this._reidSubtree(g); this._reidRealIds([g]);   // fresh ids + independent resource copies
    use.parentNode.insertBefore(g, use); use.remove();
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Broke the link — now an independent group.", 2200);
  },
  // Edit the master: surface it onto the stage (at the instance's place), isolate it for editing;
  // every instance references it live, so they update as you edit. Exiting isolation returns it
  // to <defs> (see _symFinishEdit, called from exitIsolation).
  editSymbol(use) {
    use = use || this.selectedNodes().find((n) => this.isSymbolInstance(n));
    const sym = this._symbolMasterOf(use); if (!sym || this._symEdit) return;
    this._symEdit = { symId: sym.getAttribute("id"), prevTransform: sym.getAttribute("transform"), useId: use.getAttribute("data-hv-id") };
    const t = use.getAttribute("transform");
    if (t) sym.setAttribute("transform", t); else sym.removeAttribute("transform");
    sym.setAttribute("data-hv-id", sym.getAttribute("id"));   // temp: make it isolatable
    this.stage.insertBefore(sym, this._overlayEl());          // defs → stage (instances still reference it by id)
    this._ensureIds();                                        // re-tag the master's content so its children are editable
    this.enterIsolation(sym);
    setStatus("Editing the symbol — changes apply to every instance. Esc to finish.", 4000);
  },
  // Return the surfaced master to <defs> (called by exitIsolation when a symbol edit is active).
  _symFinishEdit() {
    const e = this._symEdit; if (!e) return; this._symEdit = null;
    const sym = this.stage && (this.stage.querySelector("#" + CSS.escape(e.symId)));
    if (sym) {
      if (e.prevTransform) sym.setAttribute("transform", e.prevTransform); else sym.removeAttribute("transform");
      sym.removeAttribute("data-hv-id");
      sym.querySelectorAll("[data-hv-id]").forEach((n) => n.removeAttribute("data-hv-id"));   // content back to defs-only
      this._defs().appendChild(sym);
    }
    if (e.useId && this.nodeById(e.useId)) this.selection = new Set([e.useId]);
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
};
