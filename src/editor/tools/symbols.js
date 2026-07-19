// Symbols & instances (Epic Y). A symbol is a reusable master — a `<g class="hv-symbol">`
// living in <defs> — and each instance on the stage is a `<use href="#sym">`. Because <use>
// is a live reference, editing the master updates EVERY instance for free (SVG-native). All
// standard SVG, so symbols + instances round-trip through save/reopen untouched. Editing the
// master reuses Isolation mode (Epic I): the master is surfaced onto the stage, isolated for
// editing, and returned to <defs> on exit — instances update live the whole time.
// Object.assign MIXIN — `this === editor`.
import { SVG_NS, nfmt } from "../../hv/index.js";
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
    // Only block the POINTLESS case — re-wrapping a single lone instance in another symbol.
    // A multi-object selection that happens to INCLUDE an instance is exactly how nested
    // symbols get built (symbol B's content contains a <use> of symbol A) — SVG's own
    // <use>-inside-<defs> model already supports this natively, nothing here needs it blocked.
    if (sel.length === 1 && this.isSymbolInstance(sel[0])) { setStatus("That's already a symbol instance.", 2500); return; }
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
  //
  // NESTED symbols: a master's own content can contain a <use> of ANOTHER symbol (makeSymbol
  // allows bundling an instance into a new symbol now — see its own comment). Editing that
  // inner instance while the outer one is already surfaced pushes a SECOND edit session onto
  // _symEditStack rather than refusing — isolation.js's own stack (Epic I) already nests
  // correctly; the one thing that needed fixing here was this mixin ONLY ever tracking a single
  // in-progress edit, which silently no-op'd a second editSymbol() call.
  editSymbol(use) {
    use = use || this.selectedNodes().find((n) => this.isSymbolInstance(n));
    const sym = this._symbolMasterOf(use); if (!sym) return;
    const t = use.getAttribute("transform");
    if (t) sym.setAttribute("transform", t); else sym.removeAttribute("transform");
    sym.setAttribute("data-hv-id", sym.getAttribute("id"));   // temp: make it isolatable
    this.stage.insertBefore(sym, this._overlayEl());          // defs → stage (instances still reference it by id)
    this._ensureIds();                                        // re-tag the master's content so its children are editable
    this.enterIsolation(sym, true);   // force: a nested symbol's master isn't a DOM descendant of the outer one — see enterIsolation's own comment
    // Record the ISOLATION DEPTH this edit was entered at, so exitIsolation (which pops one
    // isolation level at a time) only finishes THIS edit when that specific level is the one
    // being popped — an intervening PLAIN (non-symbol) nested isolation inside this master's
    // content must be able to exit without prematurely ending the symbol edit underneath it.
    this._symEditStack = this._symEditStack || [];
    this._symEditStack.push({ symId: sym.getAttribute("id"), prevTransform: sym.getAttribute("transform"), useId: use.getAttribute("data-hv-id"), isoDepth: this._isoStack.length });
    const depth = this._symEditStack.length;
    setStatus(depth > 1 ? "Editing a nested symbol — changes apply to every instance of IT. Esc finishes this one first."
                         : "Editing the symbol — changes apply to every instance. Esc to finish.", 4000);
  },
  // Return the surfaced master to <defs> — called by exitIsolation ONLY when the isolation level
  // it's popping matches the depth the innermost edit session was entered at (see editSymbol).
  _symFinishEdit() {
    const stack = this._symEditStack; if (!stack || !stack.length) return;
    const e = stack.pop();
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

  // ---------------- Symbols panel (Epic Y): browse + place ----------------
  // Place a NEW <use> instance of an existing symbol master — distinct from duplicate(), which
  // copies an EXISTING instance. (x, y) is the instance's own centre in user-space; omitted,
  // it centres on the document's own viewBox — a reasonable default regardless of the current
  // pan/zoom (the panel's drag-to-place path always supplies a real drop point instead).
  placeSymbolInstance(symId, x, y) {
    if (!this.stage) return;
    const sym = this.stage.querySelector("#" + CSS.escape(symId));
    if (!sym || !sym.classList.contains("hv-symbol")) return;
    let bb; try { bb = sym.getBBox(); } catch { bb = { x: 0, y: 0, width: 0, height: 0 }; }
    const vb = this.stage.viewBox.baseVal;
    const cx = x != null ? x : vb.x + vb.width / 2, cy = y != null ? y : vb.y + vb.height / 2;
    this.push("Place symbol");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("data-hv-id", "n" + (++this.idSeq)); use.setAttribute("href", "#" + symId);
    use.setAttribute("transform", `translate(${nfmt(cx - bb.x - bb.width / 2)} ${nfmt(cy - bb.y - bb.height / 2)})`);
    this._artHome().insertBefore(use, this._artBefore());
    this.selection = new Set([use.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Placed a new instance.", 1800);
  },
  _symbolName(sym) { return sym.getAttribute("data-hv-name") || "Symbol"; },
  // A tile per symbol master: a live <use>-based thumbnail (updates automatically as the
  // master is edited — no cache, no rasterization, it's real geometry in the same document)
  // plus click-to-place / drag-to-place. Called from _renderLayers() (panel-layers.js) — any
  // document mutation that could change the symbol set already routes through there.
  _renderSymbols() {
    const list = document.querySelector("#symbols-list");
    if (!list) return;
    list.innerHTML = "";
    const count = document.querySelector("#symbols-count");
    if (!this.stage) { if (count) count.textContent = ""; return; }
    const syms = [...this._defs().querySelectorAll(":scope > .hv-symbol")];
    if (count) count.textContent = syms.length ? String(syms.length) : "";
    if (!syms.length) {
      const empty = document.createElement("div"); empty.className = "symbols-empty";
      empty.textContent = "No symbols yet — select artwork, then ⊕ (or F8) to make one.";
      list.appendChild(empty);
      return;
    }
    syms.forEach((sym, i) => {
      const id = sym.getAttribute("id");
      const row = document.createElement("div"); row.className = "symbol-row"; row.title = "Click to place a new instance — drag it onto the canvas to place it exactly there";
      let bb; try { bb = sym.getBBox(); } catch { bb = { x: 0, y: 0, width: 10, height: 10 }; }
      const pad = Math.max(bb.width, bb.height) * 0.08 || 1;
      const thumb = document.createElementNS(SVG_NS, "svg"); thumb.setAttribute("class", "symbol-thumb");
      thumb.setAttribute("viewBox", `${nfmt(bb.x - pad)} ${nfmt(bb.y - pad)} ${nfmt(bb.width + pad * 2)} ${nfmt(bb.height + pad * 2)}`);
      thumb.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const use = document.createElementNS(SVG_NS, "use"); use.setAttribute("href", "#" + id); thumb.appendChild(use);
      const name = document.createElement("span"); name.className = "symbol-name"; name.textContent = this._symbolName(sym) + (syms.length > 1 ? " " + (i + 1) : "");
      row.append(thumb, name);
      this._bindSymbolDrag(row, id);
      list.appendChild(row);
    });
  },
  // pointerdown+move+up, no library dependency (mirrors the coordinate-transform pattern
  // _artboardDown/K.3 handles already use). A plain tap/click (no real movement) places at the
  // document centre; a real drag that ends over the canvas places exactly at the drop point;
  // a drag that ends elsewhere (cancelled) places nothing.
  _bindSymbolDrag(row, symId) {
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      let ghost = null, moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
          moved = true;
          ghost = document.createElement("div"); ghost.className = "symbol-drag-ghost"; ghost.textContent = "Drop to place";
          document.body.appendChild(ghost);
        }
        if (ghost) { ghost.style.left = (ev.clientX + 12) + "px"; ghost.style.top = (ev.clientY + 12) + "px"; }
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        if (ghost) ghost.remove();
        if (!moved) { this.placeSymbolInstance(symId); return; }
        const stageBody = document.querySelector(".stage-body");
        const r = stageBody && stageBody.getBoundingClientRect();
        if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          const m = this.stageCTM(); if (!m) return;
          const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
          this.placeSymbolInstance(symId, p.x, p.y);
        }
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  },
};
