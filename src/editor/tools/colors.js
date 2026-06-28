// Colour systems (Epic C): Pattern fills + Recolor Artwork. Both build on the existing
// defs foundation (_defs / _mintDefId / _gcDefs covers `pattern`; _reidRealIds keeps clones
// independent) and the colour helpers in hv/color.js. Object.assign MIXIN — `this===editor`.
//
// (Global colours — C.1 — are deferred: SVG has no native named-colour primitive, so an
//  edit-once-update-all swatch needs a colour-panel re-architecture out of scope here.)
import { SVG_NS, nfmt, toHexColor, hexToRgb, rgbToHex, rgbToHsl, hslToRgb } from "../../hv/index.js";
import { setStatus } from "../../app.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// solid colour → {h,s,l} (0..360 / 0..100 / 0..100); null for none/url()/unparseable.
function toHSL(c) {
  if (!c || c === "none" || /url\(/.test(c)) return null;
  const hex = toHexColor(c); const rgb = hex && hexToRgb(hex); if (!rgb) return null;
  return rgbToHsl(rgb.r, rgb.g, rgb.b);
}
function fromHSL(h, s, l) { const r = hslToRgb(((h % 360) + 360) % 360, clamp(s, 0, 100), clamp(l, 0, 100)); return rgbToHex(r.r, r.g, r.b); }

export const colorsMixin = {
  // ---------------- Pattern fills (C.3) ----------------
  // The TOP selected object is the tile motif; it's baked into a <pattern> in defs and applied
  // as the fill of the remaining selected objects (the clip-mask idiom — top defines, rest use).
  _patternOf(n) {
    const m = /url\(["']?#([^"')]+)["']?\)/.exec((n && n.getAttribute && n.getAttribute("fill")) || "");
    if (!m || !this.stage) return null;
    const el = this.stage.querySelector("#" + CSS.escape(m[1]));
    return el && el.tagName.toLowerCase() === "pattern" ? el : null;
  },
  fillWithPattern() {
    if (!this.stage) return;
    const sel = this._topSelection(this.selectedNodes()).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id"));
    if (sel.length < 2) { setStatus("Select the tile motif on top of the shape(s) to fill with it.", 3500); return; }
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const tile = sel[sel.length - 1], targets = sel.slice(0, -1);
    let tbb; try { tbb = this._nodeBBoxUser(tile); } catch { tbb = null; }
    if (!tbb || tbb.x1 <= tbb.x0) { setStatus("The tile has no area.", 2800); return; }
    this.push("Pattern fill");
    const id = this._mintDefId("hvpat");
    const pat = document.createElementNS(SVG_NS, "pattern");
    pat.setAttribute("id", id); pat.setAttribute("patternUnits", "userSpaceOnUse");
    pat.setAttribute("width", nfmt(tbb.x1 - tbb.x0)); pat.setAttribute("height", nfmt(tbb.y1 - tbb.y0));
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", `translate(${nfmt(-tbb.x0)} ${nfmt(-tbb.y0)})`);
    const clone = tile.cloneNode(true);
    clone.querySelectorAll("[data-hv-id],[data-hv-shape]").forEach((c) => { for (const a of [...c.attributes]) if (a.name.startsWith("data-hv-")) c.removeAttribute(a.name); });
    for (const a of [...clone.attributes]) if (a.name.startsWith("data-hv-")) clone.removeAttribute(a.name);
    g.appendChild(clone); pat.appendChild(g); this._defs().appendChild(pat);
    targets.forEach((n) => { n.setAttribute("fill", "url(#" + id + ")"); n.removeAttribute("fill-opacity"); });
    tile.remove();
    this._gcDefs();
    this.selection = new Set(targets.map((n) => n.getAttribute("data-hv-id"))); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Filled ${targets.length} shape${targets.length > 1 ? "s" : ""} with the pattern.`, 2200);
  },
  _patternXform(pat) {
    const t = pat.getAttribute("patternTransform") || "";
    const r = /rotate\(\s*(-?[\d.]+)/.exec(t), s = /scale\(\s*(-?[\d.]+)/.exec(t);
    return { rotate: r ? +r[1] : 0, scale: s ? +s[1] : 1 };
  },
  setPatternParam(n, key, value) {
    const pat = this._patternOf(n); if (!pat) return;
    const cur = this._patternXform(pat); cur[key] = value;
    const s = cur.scale || 1, deg = cur.rotate || 0;
    if (s === 1 && deg === 0) pat.removeAttribute("patternTransform");
    else pat.setAttribute("patternTransform", `rotate(${nfmt(deg)}) scale(${nfmt(s)})`);
    this._renderSelection();
  },

  // ---------------- Recolor Artwork (C.2) ----------------
  // Harvest the distinct solid fill/stroke colours used by the leaves of `nodes`.
  _harvestColors(nodes) {
    const map = new Map();   // hex → [{el, attr}]
    const leaves = this._effectiveLeaves(nodes);
    for (const n of leaves) {
      if (this.isRaster(n)) continue;
      for (const attr of ["fill", "stroke"]) {
        const v = (n.getAttribute(attr) || "").trim();
        if (!v || v === "none" || /url\(/.test(v)) continue;
        const hex = toHexColor(v); if (!hex) continue;
        if (!map.has(hex)) map.set(hex, []);
        map.get(hex).push({ el: n, attr });
      }
    }
    return map;
  },
  // Remap every use of one exact colour to a new one (one undo). targets captured by the caller.
  recolorApply(targets, hex) { for (const t of targets) t.el.setAttribute(t.attr, hex); },
  // Edit a harvested colour through the CONTEXTUAL dock Colour panel (not a popup modal):
  // set a transient recolor target, summon the panel, and render it in "Recolor" mode (a solo
  // picker that live-applies via recolorApply). The target is cleared on selection change
  // (docks.renderColor) or via the panel's Done button. Falls back to the modal if no dock panel.
  _recolorEditViaPanel(hex, targets) {
    this.push("Recolor"); this._recolorClearBase();
    // Summon FIRST: showing the panel runs docks.renderColor, which would clear a freshly-set
    // target on its first key change. Set the target AFTER, then render directly (renderColor
    // then same-key early-returns and leaves us in Recolor mode until selection change / Done).
    if (this._summonColor) this._summonColor();
    const body = document.querySelector(".rail-section.color .section-body");
    if (body && typeof this._renderColorPanel === "function") {
      this._recolorTarget = { hex, targets };
      this._renderColorPanel(body);
      return;
    }
    this.pickColor({ title: "Recolor " + hex, color: hex, allowNone: false, onChange: (h) => this.recolorApply(targets, h || hex) });
  },
  // H/S/L shift over ALL harvested colours, re-applied from a base snapshot each scrub so the
  // slider is absolute (coalesced into one undo). `kind` ∈ "h"|"s"|"l".
  _recolorEnsureBase() {
    if (this._recolorBase) return;
    const base = [];
    for (const [, list] of this._harvestColors(this.selectedNodes())) for (const t of list) { const hsl = toHSL(t.el.getAttribute(t.attr)); if (hsl) base.push({ el: t.el, attr: t.attr, h: hsl.h, s: hsl.s, l: hsl.l }); }
    this._recolorBase = base;
  },
  recolorShift(dh, ds, dl) {
    this._recolorEnsureBase();
    for (const b of this._recolorBase) b.el.setAttribute(b.attr, fromHSL(b.h + dh, b.s + ds, b.l + dl));
  },
  _recolorClearBase() { this._recolorBase = null; },
};
