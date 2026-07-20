// Text styles (Epic P.1): named, whole-object font bundles — font-family/size/weight/
// style/text-anchor/letter-spacing/line-height — that live-update every text object
// tagged with them, mirroring Epic C.1's global colours (name a resource, apply it to
// several objects, edit any instance and the rest follow). SCOPED DOWN from "character/
// paragraph styles applied to runs": hector-vector's text model has no per-character or
// per-run formatting today (a <text> node's font attributes apply uniformly to every
// tspan inside it — see _applyTextStyleAttrs / _writeAreaContent / _writeTextContent in
// text.js), so a "style" here applies to a WHOLE text object, not a highlighted range
// within one. Paint (fill/stroke) is deliberately NOT part of the bundle — that's Global
// Colours' job (Epic C.1), kept separate on purpose.
//
// Both the per-node data-hv-text-style-id tag AND the registry itself (this.textStylesList —
// plain in-memory, no DOM presence at all, unlike every other parametric feature here) survive
// save/reopen via editor.js's PERSIST_ATTRS/_captureLiveBlob mechanism, which special-cases
// textStyles as a top-level blob field precisely because there's no per-node spec to walk for
// the registry entries themselves. Object.assign MIXIN — `this === editor`.
import { setStatus } from "../../app.js";
import { DEFAULT_TEXT } from "./text.js";

export const textStylesMixin = {
  _textStyles() { return (this.textStylesList = this.textStylesList || []); },
  _textStyleDef(id) { return this._textStyles().find((s) => s.id === id); },
  _styleIdOf(node) { return (node && node.getAttribute && node.getAttribute("data-hv-text-style-id")) || null; },
  // Read a text node's current font attributes into the plain shape a style def holds.
  _readStyleAttrs(node) {
    return {
      fontFamily: node.getAttribute("font-family") || DEFAULT_TEXT.fontFamily,
      fontSize: parseFloat(node.getAttribute("font-size")) || DEFAULT_TEXT.fontSize,
      fontWeight: node.getAttribute("font-weight") || "400",
      fontStyle: node.getAttribute("font-style") || "normal",
      textAnchor: node.getAttribute("text-anchor") || "start",
      letterSpacing: parseFloat(node.getAttribute("letter-spacing")) || 0,
      lineHeight: this._lineHeightOf(node),
    };
  },
  // Stamp a style def's attributes onto a text node. Doesn't reflow — batch callers reflow
  // once per node after every attribute lands.
  _applyStyleAttrsToNode(node, def) {
    node.setAttribute("font-family", def.fontFamily);
    node.setAttribute("font-size", String(def.fontSize));
    if (def.fontWeight && def.fontWeight !== "400") node.setAttribute("font-weight", def.fontWeight); else node.removeAttribute("font-weight");
    if (def.fontStyle && def.fontStyle !== "normal") node.setAttribute("font-style", def.fontStyle); else node.removeAttribute("font-style");
    if (def.textAnchor && def.textAnchor !== "start") node.setAttribute("text-anchor", def.textAnchor); else node.removeAttribute("text-anchor");
    if (def.letterSpacing) node.setAttribute("letter-spacing", String(def.letterSpacing)); else node.removeAttribute("letter-spacing");
    node.setAttribute("data-hv-line-height", String(def.lineHeight || DEFAULT_TEXT.lineHeight));
  },
  // Name a NEW style from the first selected text's current look, and tag+apply it to
  // EVERY selected text object — "save as style" doubles as "apply to what's selected".
  makeTextStyle(name) {
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    if (!texts.length) { setStatus("Select one or more text objects first.", 3000); return null; }
    const nm = (name || "").trim(); if (!nm) return null;
    const id = "ts" + (++this.idSeq);
    const def = Object.assign({ id, name: nm }, this._readStyleAttrs(texts[0]));
    this.push("Save text style");
    this._textStyles().push(def);
    for (const n of texts) { n.setAttribute("data-hv-text-style-id", id); this._applyStyleAttrsToNode(n, def); this._reflowText(n); }
    this._renderSelection(); this._renderInspector();
    setStatus(`Saved “${nm}” and applied it to ${texts.length} text object${texts.length > 1 ? "s" : ""}.`, 2600);
    return id;
  },
  // Apply an EXISTING style to the selected text objects.
  applyTextStyle(id) {
    const def = this._textStyleDef(id); if (!def) return;
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    if (!texts.length) return;
    this.push("Apply text style");
    for (const n of texts) { n.setAttribute("data-hv-text-style-id", id); this._applyStyleAttrsToNode(n, def); this._reflowText(n); }
    this._renderSelection(); this._renderInspector();
    setStatus(`Applied “${def.name}”.`, 2000);
  },
  // Detach: the text keeps its current look, it just stops following the style.
  detachTextStyle(node) {
    node = node || this.selectedNodes().find((n) => n.tagName.toLowerCase() === "text" && this._styleIdOf(n));
    if (!node) return;
    this.push("Detach text style");
    node.removeAttribute("data-hv-text-style-id");
    this._renderSelection(); this._renderInspector();
    setStatus("Detached from its text style.", 2000);
  },
  renameTextStyle(id, name) {
    const def = this._textStyleDef(id); if (!def) return;
    const nm = (name || "").trim(); if (!nm) return;
    this.push("Rename text style");
    def.name = nm;
    this._renderInspector();
  },
  // Delete: unlink every user (they keep their current attributes, just lose the tag) —
  // never silently changes anyone's actual look, same "ungroup, don't destroy" precedent
  // as Global Colours' delete and the swatch-folder "Remove folder".
  deleteTextStyle(id) {
    const list = this._textStyles();
    const i = list.findIndex((s) => s.id === id); if (i < 0) return;
    this.push("Delete text style");
    list.splice(i, 1);
    if (this.stage) for (const n of this.stage.querySelectorAll(`[data-hv-text-style-id="${CSS.escape(id)}"]`)) n.removeAttribute("data-hv-text-style-id");
    this._renderInspector();
    setStatus("Style deleted (its text keeps its current look).", 2200);
  },
  // Live-edit propagation: after ANY font-attribute change on a node carrying a style
  // marker, fold that change back into the shared def and cascade it to every OTHER node
  // wearing the same style — the "edit one instance, everyone follows" behaviour Global
  // Colours already established for paint, now for type.
  _syncTextStyleFrom(node) {
    const id = this._styleIdOf(node); if (!id) return;
    const def = this._textStyleDef(id); if (!def) return;
    Object.assign(def, this._readStyleAttrs(node));
    if (!this.stage) return;
    for (const n of this.stage.querySelectorAll(`[data-hv-text-style-id="${CSS.escape(id)}"]`)) {
      if (n === node) continue;
      this._applyStyleAttrsToNode(n, def);
      this._reflowText(n);
    }
  },
  // A small floating name-prompt input, positioned near the viewport centre — mirrors
  // editor.js's own _renameFloating rather than importing modal.js's floatingInput (that
  // would cycle back through editor.js, which text.js/textstyles.js are mixed into).
  _promptTextStyleName(title, initial, onCommit) {
    document.querySelectorAll(".hv-rename-pop").forEach((e) => e.remove());
    const wrap = document.createElement("div"); wrap.className = "hv-float-input";
    wrap.style.position = "fixed"; wrap.style.left = "50%"; wrap.style.top = "30%"; wrap.style.transform = "translateX(-50%)";
    const lab = document.createElement("div"); lab.className = "hv-float-label"; lab.textContent = title; wrap.appendChild(lab);
    const inp = document.createElement("input"); inp.type = "text"; inp.value = initial || "";
    wrap.appendChild(inp); document.body.appendChild(wrap); inp.focus(); inp.select();
    let done = false;
    const finish = (commit) => { if (done) return; done = true; const v = inp.value.trim(); wrap.remove(); if (commit && v) onCommit(v); };
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
    inp.addEventListener("blur", () => finish(true));
  },
};
