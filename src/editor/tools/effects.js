// Appearance — live effects (Epic E). A per-object stack of effects (drop shadow / blur /
// glow) rendered to a single chained <filter> in defs. Object.assign MIXIN — `this === editor`.
// The working spec lives in data-hv-effects JSON (stripped by serialize), but the filter is
// built from reconstructable primitives (feDropShadow / feGaussianBlur), so effectsOf() can
// rebuild the spec from the saved filter on reopen — effects round-trip EDITABLE, like gradients.
// Leans on the Epic 0 defs foundation: _mintDefId/_defs store it, _gcDefs reclaims orphan
// filters (RES_TAGS has "filter"), _reidRealIds deep-copies the filter on clone (independent).
import { SVG_NS, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";

const FX_DEFAULTS = {
  blur: { type: "blur", amount: 4 },
  shadow: { type: "shadow", dx: 6, dy: 6, blur: 4, color: "#000000", opacity: 0.45 },
  glow: { type: "glow", blur: 8, color: "#ffee66", opacity: 0.8 },
};
const FX_LABEL = { blur: "Blur", shadow: "Drop shadow", glow: "Glow" };

export const effectsMixin = {
  // The effect stack for a node: the live data-hv-effects JSON if present, else reconstructed
  // from the node's <filter> primitives (so a reopened doc's effects are editable again).
  effectsOf(node) {
    const raw = node && node.getAttribute && node.getAttribute("data-hv-effects");
    if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch {} }
    const fid = this._urlRefId(node, "filter");
    if (!fid) return [];
    const filt = this.stage.querySelector("#" + CSS.escape(fid));
    if (!filt) return [];
    const out = [];
    for (const p of filt.children) {
      const tag = p.tagName.toLowerCase();
      if (tag === "fegaussianblur") out.push({ type: "blur", amount: parseFloat(p.getAttribute("stdDeviation")) || 4 });
      else if (tag === "fedropshadow") {
        const dx = parseFloat(p.getAttribute("dx")) || 0, dy = parseFloat(p.getAttribute("dy")) || 0;
        const blur = parseFloat(p.getAttribute("stdDeviation")) || 4;
        const color = p.getAttribute("flood-color") || "#000000";
        const o = p.getAttribute("flood-opacity"); const opacity = o == null ? 0.5 : parseFloat(o);
        out.push(dx === 0 && dy === 0 ? { type: "glow", blur, color, opacity } : { type: "shadow", dx, dy, blur, color, opacity });
      }
    }
    return out;
  },
  // (Re)build the node's <filter> from `fx` (defaults to its current spec); chained so the
  // stack composes. Pass an explicit array so clearing to [] actually drops the filter (else
  // effectsOf would reconstruct from the filter we're trying to remove).
  _renderEffects(node, fx) {
    if (!fx) fx = this.effectsOf(node);
    const existing = this._urlRefId(node, "filter");
    const reuse = existing && existing.indexOf("hvfilt") === 0 ? existing : null;
    if (!fx.length) {
      node.removeAttribute("filter");
      if (reuse) { const old = this.stage.querySelector("#" + CSS.escape(reuse)); if (old) old.remove(); }
      return;
    }
    const id = reuse || this._mintDefId("hvfilt");
    const filt = document.createElementNS(SVG_NS, "filter");
    filt.setAttribute("id", id);
    // generous region so big shadows/blurs don't clip; sRGB keeps colours predictable
    filt.setAttribute("x", "-50%"); filt.setAttribute("y", "-50%");
    filt.setAttribute("width", "200%"); filt.setAttribute("height", "200%");
    filt.setAttribute("color-interpolation-filters", "sRGB");
    let prev = "SourceGraphic", k = 0;
    for (const e of fx) {
      k++; const result = "fx" + k;
      let prim;
      if (e.type === "blur") {
        prim = document.createElementNS(SVG_NS, "feGaussianBlur");
        prim.setAttribute("stdDeviation", nfmt(Math.max(0, e.amount || 0)));
      } else {   // shadow / glow → feDropShadow (glow = zero offset)
        prim = document.createElementNS(SVG_NS, "feDropShadow");
        prim.setAttribute("dx", nfmt(e.type === "glow" ? 0 : (e.dx || 0)));
        prim.setAttribute("dy", nfmt(e.type === "glow" ? 0 : (e.dy || 0)));
        prim.setAttribute("stdDeviation", nfmt(Math.max(0, e.blur || 0)));
        prim.setAttribute("flood-color", e.color || "#000000");
        prim.setAttribute("flood-opacity", nfmt(e.opacity == null ? 0.5 : e.opacity));
      }
      prim.setAttribute("in", prev);
      prim.setAttribute("result", result);
      filt.appendChild(prim);
      prev = result;
    }
    const defs = this._defs();
    const old = defs.querySelector("#" + CSS.escape(id));
    if (old) old.replaceWith(filt); else defs.appendChild(filt);
    node.setAttribute("filter", "url(#" + id + ")");
  },
  setEffects(node, arr) {
    arr = arr || [];
    if (!arr.length) node.removeAttribute("data-hv-effects");
    else node.setAttribute("data-hv-effects", JSON.stringify(arr));
    this._renderEffects(node, arr);
  },
  addEffect(type) {
    const def = FX_DEFAULTS[type]; if (!def) return;
    const nodes = this.selectedNodes(); if (!nodes.length) { setStatus("Select an object to add an effect.", 2500); return; }
    this.push("Add " + (FX_LABEL[type] || "effect").toLowerCase());
    for (const n of nodes) { const fx = this.effectsOf(n).slice(); fx.push({ ...def }); this.setEffects(n, fx); }
    this._renderInspector(); this._renderLayers();
    setStatus(`Added ${FX_LABEL[type] || "effect"}.`, 1800);
  },
  // Live param edit on a single node's effect i (coalesced for slider/drag).
  updateEffect(node, i, patch) {
    const fx = this.effectsOf(node).slice();
    if (!fx[i]) return;
    fx[i] = { ...fx[i], ...patch };
    node.setAttribute("data-hv-effects", JSON.stringify(fx));
    this._renderEffects(node, fx);
  },
  removeEffect(node, i) {
    const fx = this.effectsOf(node).slice();
    if (!fx[i]) return;
    this.push("Remove effect");
    fx.splice(i, 1);
    this.setEffects(node, fx);
    this._gcDefs();
    this._renderInspector(); this._renderLayers();
  },
};
