// Masks & clipping (Epic M). Illustrator-style clipping masks (<clipPath>) + opacity
// masks (<mask>, luminance). Object.assign MIXIN — methods run with `this === editor`.
// Leans on the Epic 0 defs foundation: _mintDefId / _defs() store the resource, _gcDefs
// reclaims orphans (RES_TAGS already covers clippath+mask), and _reidRealIds deep-copies
// the clipPath/mask on clone/duplicate so copies are independent. Detection is by id PREFIX
// ("hvclip…" / "hvmask…") so it survives serialize() (real ids round-trip; data-hv-* don't),
// which also keeps these distinct from the stroke-align "hvsa-*" clips on leaf nodes.
import { SVG_NS } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const masksMixin = {
  _urlRefId(node, attr) {
    const v = node && node.getAttribute && node.getAttribute(attr);
    if (!v) return null;
    const m = /url\(["']?#([^"')]+)["']?\)/.exec(v);
    return m ? m[1] : null;
  },
  // The clip/opacity-mask GROUP a node belongs to (the node itself or any ancestor <g>
  // carrying clip-path="url(#hvclip…)" / mask="url(#hvmask…)"). Null if unmasked.
  _clipGroupOf(node) {
    for (let n = node; n && n !== this.stage && n.tagName; n = n.parentNode) {
      if (n.tagName.toLowerCase() === "g") {
        const id = this._urlRefId(n, "clip-path");
        if (id && id.indexOf("hvclip") === 0) return n;
      }
    }
    return null;
  },
  _maskGroupOf(node) {
    for (let n = node; n && n !== this.stage && n.tagName; n = n.parentNode) {
      if (n.tagName.toLowerCase() === "g") {
        const id = this._urlRefId(n, "mask");
        if (id && id.indexOf("hvmask") === 0) return n;
      }
    }
    return null;
  },
  // Wrap the content objects (everything but the frontmost) in one group, preserving
  // z-order + insertion point, and return the group. Shared by both mask kinds.
  _groupForMask(content) {
    const ov = this._overlayEl();
    const front = content[content.length - 1];
    const parent = front.parentNode, anchor = front.nextSibling;
    const g = document.createElementNS(SVG_NS, "g");
    const gid = "n" + (++this.idSeq); g.setAttribute("data-hv-id", gid);
    content.forEach((n) => g.appendChild(n));   // children keep their data-hv-id (layers can address them)
    if (anchor && anchor.parentNode === parent && anchor !== ov) parent.insertBefore(g, anchor);
    else if (parent === this.stage && ov && ov.parentNode === this.stage) this.stage.insertBefore(g, ov);
    else parent.appendChild(g);
    return g;
  },
  // The selected top-objects, back→front in z-order, that carry a data-hv-id. The
  // frontmost becomes the mask; ≥2 required. Returns null (after a status) if invalid.
  _maskOperands() {
    const sel = this._topSelection(this.selectedNodes()).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id"));
    if (sel.length < 2) return null;
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));   // z-order, back → front
    return sel;
  },
  makeClipMask() {
    const sel = this._maskOperands();
    if (!sel) { setStatus("Select 2 or more objects — the top one becomes the clipping shape.", 3200); return; }
    const clip = sel[sel.length - 1];                        // frontmost = mask geometry
    if (this.isRaster(clip)) { setStatus("The clipping shape must be a vector object, not an image.", 3500); return; }
    const content = sel.slice(0, -1);
    this.push("Make clipping mask");
    const g = this._groupForMask(content);
    const cid = this._mintDefId("hvclip");
    const cp = document.createElementNS(SVG_NS, "clipPath");
    cp.setAttribute("id", cid); cp.setAttribute("clipPathUnits", "userSpaceOnUse");
    clip.removeAttribute("data-hv-id");   // lives in defs now, no longer stage artwork
    cp.appendChild(clip);
    this._defs().appendChild(cp);
    g.setAttribute("clip-path", "url(#" + cid + ")");
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Clipping mask applied to ${content.length} object${content.length > 1 ? "s" : ""}.`, 2000);
  },
  makeOpacityMask() {
    const sel = this._maskOperands();
    if (!sel) { setStatus("Select 2 or more objects — the top one becomes the opacity mask.", 3200); return; }
    const maskShape = sel[sel.length - 1];                   // frontmost = mask (luminance modulates alpha)
    const content = sel.slice(0, -1);
    this.push("Make opacity mask");
    const g = this._groupForMask(content);
    const mid = this._mintDefId("hvmask");
    const mk = document.createElementNS(SVG_NS, "mask");
    mk.setAttribute("id", mid);
    // luminance is the SVG default (white = opaque, black = clear); maskContentUnits
    // defaults to userSpaceOnUse so the shape's absolute coords line up with the content.
    maskShape.removeAttribute("data-hv-id");
    mk.appendChild(maskShape);
    this._defs().appendChild(mk);
    g.setAttribute("mask", "url(#" + mid + ")");
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Opacity mask applied to ${content.length} object${content.length > 1 ? "s" : ""}.`, 2000);
  },
  // Release clip AND/OR opacity masks on the selection: the mask shape(s) come back as
  // normal objects at the top of the group (keeping their original fill), the def is
  // dropped, and the group survives as a plain group. Works post-reopen (DOM-only).
  releaseMask() {
    const groups = [];
    for (const n of this.selectedNodes()) {
      const c = this._clipGroupOf(n), m = this._maskGroupOf(n);
      if (c && !groups.includes(c)) groups.push(c);
      if (m && !groups.includes(m)) groups.push(m);
    }
    if (!groups.length) { setStatus("Select a clipped or masked group to release.", 2800); return; }
    this.push("Release mask");
    const restored = [];
    for (const g of groups) {
      for (const attr of ["clip-path", "mask"]) {
        const defId = this._urlRefId(g, attr);
        if (!defId || (defId.indexOf("hvclip") !== 0 && defId.indexOf("hvmask") !== 0)) continue;
        const def = this.stage.querySelector("#" + CSS.escape(defId));
        if (def) {
          for (const s of [...def.children]) {
            s.setAttribute("data-hv-id", "n" + (++this.idSeq));   // fresh — original id was dropped / stripped on save
            s.removeAttribute("id");
            g.appendChild(s);                                     // back on top, inside the (now plain) group
            restored.push(s.getAttribute("data-hv-id"));
          }
          def.remove();
        }
        g.removeAttribute(attr);
      }
    }
    this._gcDefs();
    const keep = [...groups.map((g) => g.getAttribute("data-hv-id")), ...restored].filter(Boolean);
    this.selection = new Set(keep); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Released ${groups.length} mask${groups.length > 1 ? "s" : ""}.`, 2000);
  },
};
