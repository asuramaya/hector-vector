// The output viewport — extracted from app.js (#28, the info/library/viewport
// subsystem). Owns the `viewports` state object + the background-mode machinery,
// and everything that mounts/measures/transforms content inside the canvas frame:
// inline-SVG loading, fit/zoom/pan, the Illustrator-style rulers + draggable
// guides. Pure viewport mechanics — it never fetches or picks outputs (that's
// datasync), so it imports only editor + the context-menu helper and takes a
// setStatus seam. docio/gallery/docks import viewports/measureFit/applyBgMode
// from here.
import { editor } from "../editor.js";
import { showContextMenu } from "./menus.js";

let setStatus;
export function configureViewport(deps) { ({ setStatus } = deps); }

// ---------- background modes ----------
const BG_MODES = ["checker", "white", "black", "dark"];
const BG_STORAGE_KEY = "hector-vector:viewport-bg";
function loadBgModes() {
  try {
    const raw = localStorage.getItem(BG_STORAGE_KEY);
    if (!raw) return { output: "checker" };
    return { output: "checker", ...JSON.parse(raw) };
  } catch {
    return { output: "checker" };
  }
}
const bgModes = loadBgModes();
function persistBgModes() {
  try { localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(bgModes)); } catch {}
}

// The single output viewport. The element is static in the page, so query it at
// module-eval (ES modules are deferred → DOM is ready). Mutated in place, never
// reassigned — imported by reference everywhere.
const outputPreviewEl = document.querySelector("#output-preview");
export const viewports = {
  output: { el: outputPreviewEl, scale: 1, x: 0, y: 0, fitScale: 1, path: null, url: null, name: null, kind: null },
};

export function applyBgMode(vpName) {
  const vp = viewports[vpName];
  if (!vp) return;
  const shell = vp.el.querySelector(".viewport-shell");
  if (!shell) return;
  for (const mode of BG_MODES) shell.classList.remove(`bg-${mode}`);
  shell.classList.add(`bg-${bgModes[vpName]}`);
}

export function cycleBg(vpName) {
  const cur = bgModes[vpName] || "checker";
  const i = BG_MODES.indexOf(cur);
  bgModes[vpName] = BG_MODES[(i + 1) % BG_MODES.length];
  persistBgModes();
  applyBgMode(vpName);
  setStatus(`Background: ${bgModes[vpName]}`, 1200);
}

// ---------- content + fit ----------
export function makeViewportContent(kind, url, name) {
  return kind === "svg"
    ? `<div class="viewport-content svg-host" data-url="${url}" data-name="${name}"></div>`
    : `<div class="viewport-content"><img src="${url}" alt="${name}" draggable="false" /></div>`;
}

export function readSvgViewBox(svg) {
  const attr = svg.getAttribute("viewBox");
  if (!attr) return null;
  const parts = attr.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { w: parts[2], h: parts[3] };
}

export async function loadInlineSvg(host) {
  const url = host.dataset.url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${host.dataset.name || "SVG"}.`);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  const widthAttr = svg.getAttribute("width");
  const heightAttr = svg.getAttribute("height");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  const vb = readSvgViewBox(svg);
  const natW = vb?.w ?? parseFloat(widthAttr ?? "") ?? 0;
  const natH = vb?.h ?? parseFloat(heightAttr ?? "") ?? 0;
  if (natW > 0 && natH > 0) {
    svg.setAttribute("width", String(natW));
    svg.setAttribute("height", String(natH));
  }
  svg.classList.add("inline-svg");
  host.innerHTML = "";
  host.appendChild(svg);
}

let _willChangeTimer = null;
export function applyViewportState(vp) {
  const content = vp.el.querySelector(".viewport-content");
  if (!content) return;
  content.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;
  // Promote to a GPU layer only WHILE actively panning/zooming, then drop the
  // hint so the resting frame re-rasterizes the SVG at the displayed scale. A
  // permanent will-change caches a bitmap at the artwork's intrinsic size, so a
  // zoomed-in vector renders blurry/rastery (it's a stretched texture, not redrawn).
  content.style.willChange = "transform";
  clearTimeout(_willChangeTimer);
  _willChangeTimer = setTimeout(() => { content.style.willChange = "auto"; }, 220);
  if (vp === viewports.output) drawRulers();   // keep the rulers in sync with zoom/pan
}

// Illustrator-style rulers: canvas-drawn ticks + labels in document units, mapped via
// the stage's screen CTM so they track zoom/pan exactly. No-op while hidden.
export function drawRulers() {
  const cont = document.querySelector("#rulers");
  if (!cont || cont.hidden || !editor.stage) return;
  const ctm = editor.stage.getScreenCTM(); if (!ctm) return;
  const sx = ctm.a || 1, sy = ctm.d || 1;            // screen px per doc unit (no canvas rotation)
  const dpr = window.devicePixelRatio || 1;
  const INK = "#9a9aa0", LINE = "#c8c8cc";
  const niceStep = (per) => { const raw = 64 / Math.abs(per || 1); const p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].map((m) => m * p).find((s) => s * Math.abs(per) >= 44) || 10 * p; };
  const fmt = (v) => { const r = Math.round(v * 100) / 100; return String(Math.abs(r) < 1e-9 ? 0 : r); };
  const prep = (cv, w, h) => { cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); g.font = "9px ui-sans-serif, system-ui, sans-serif"; return g; };
  const hC = cont.querySelector(".ruler-h"), vC = cont.querySelector(".ruler-v");
  const hr = hC.getBoundingClientRect(), vr = vC.getBoundingClientRect();
  if (hr.width > 1) {
    const w = hr.width, h = hr.height, g = prep(hC, w, h), step = niceStep(sx);
    const at = (lx) => (hr.left + lx - ctm.e) / sx, lo = Math.min(at(0), at(w)), hi = Math.max(at(0), at(w));
    g.strokeStyle = LINE; g.fillStyle = INK; g.beginPath();
    for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
      const lx = Math.round(sx * d + ctm.e - hr.left) + 0.5;
      g.moveTo(lx, h); g.lineTo(lx, h - 7); g.fillText(fmt(d), lx + 2, 8);
    }
    g.stroke();
  }
  if (vr.height > 1) {
    const w = vr.width, h = vr.height, g = prep(vC, w, h), step = niceStep(sy);
    const at = (ly) => (vr.top + ly - ctm.f) / sy, lo = Math.min(at(0), at(h)), hi = Math.max(at(0), at(h));
    g.strokeStyle = LINE; g.fillStyle = INK; g.beginPath();
    for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
      const ly = Math.round(sy * d + ctm.f - vr.top) + 0.5;
      g.moveTo(w, ly); g.lineTo(w - 7, ly);
      g.save(); g.translate(8, ly - 2); g.rotate(-Math.PI / 2); g.fillText(fmt(d), 0, 0); g.restore();
    }
    g.stroke();
  }
}

// Drag a guide out of a ruler (Illustrator-style): pointerdown on the horizontal ruler
// pulls a horizontal guide down into the canvas; the vertical ruler pulls a vertical one
// in. Release back over a ruler discards it. Right-click a ruler for guide settings.
export function bindRulerGuides(rulersEl) {
  if (!rulersEl || rulersEl._hvGuidesBound) return;
  rulersEl._hvGuidesBound = true;
  const toDoc = (cx, cy) => { const m = editor.stage && editor.stage.getScreenCTM(); return m ? new DOMPoint(cx, cy).matrixTransform(m.inverse()) : null; };
  const startCreate = (axis) => (e) => {
    if (!editor.stage || editor.guidesLocked || e.button !== 0) return;
    e.preventDefault();
    const p0 = toDoc(e.clientX, e.clientY); if (!p0) return;
    const gd = { axis, pos: axis === "v" ? p0.x : p0.y };
    editor.guides.push(gd); editor.renderGuides();
    const move = (ev) => { const p = toDoc(ev.clientX, ev.clientY); if (!p) return; gd.pos = editor._snapGuide(axis, axis === "v" ? p.x : p.y, ev.shiftKey); editor.renderGuides(); };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (editor._guideOverRuler(ev)) { const i = editor.guides.indexOf(gd); if (i >= 0) editor.guides.splice(i, 1); editor.renderGuides(); }
      else editor._persistGuides();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const hC = rulersEl.querySelector(".ruler-h"), vC = rulersEl.querySelector(".ruler-v");
  if (hC) hC.addEventListener("pointerdown", startCreate("h"));
  if (vC) vC.addEventListener("pointerdown", startCreate("v"));
  rulersEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: editor.guidesLocked ? "Unlock guides — add / edit" : "Lock guides (visible, can't move)", onClick: () => editor.toggleGuidesLock() },
      { label: `Clear guides (${editor.guides.length})`, disabled: !editor.guides.length, onClick: () => editor.clearGuides() },
    ]);
  });
}

export function resetViewport(vp) {
  vp.x = 0;
  vp.y = 0;
  vp.scale = vp.fitScale || 1;
  applyViewportState(vp);
}

function mediaNaturalSize(media) {
  if (media.tagName.toLowerCase() === "svg") {
    const w = parseFloat(media.getAttribute("width") || "") || media.viewBox?.baseVal?.width || 0;
    const h = parseFloat(media.getAttribute("height") || "") || media.viewBox?.baseVal?.height || 0;
    if (w > 0 && h > 0) return { w, h };
  }
  if (media.naturalWidth && media.naturalHeight) {
    return { w: media.naturalWidth, h: media.naturalHeight };
  }
  return { w: media.clientWidth || 1, h: media.clientHeight || 1 };
}

export function measureFit(vp) {
  const frame = vp.el;
  const media = frame.querySelector("img, svg");
  if (!media) return;
  const cs = getComputedStyle(frame);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const fw = Math.max(0, frame.clientWidth - padX);
  const fh = Math.max(0, frame.clientHeight - padY);
  const { w: mw, h: mh } = mediaNaturalSize(media);
  if (mw <= 0 || mh <= 0 || fw <= 0 || fh <= 0) {
    vp.fitScale = 1;
    resetViewport(vp);
    return;
  }
  // Fit fills the frame (with a small margin) — zooming IN for small artboards as
  // well as down for big ones, so "Fit" is distinct from "1:1" (actual size).
  vp.fitScale = Math.min(fw / mw, fh / mh) * 0.95;
  if (!Number.isFinite(vp.fitScale) || vp.fitScale <= 0) vp.fitScale = 1;
  resetViewport(vp);
}

export async function mountViewport(vp, kind, url, name, path) {
  vp.path = path;
  vp.url = url;
  vp.name = name;
  vp.kind = kind;
  vp.el.className = "preview-frame";
  vp.el.innerHTML = `<div class="checker viewport-shell">${makeViewportContent(kind, url, name)}</div>`;
  applyBgMode("output");
  const svgHost = vp.el.querySelector(".svg-host");
  if (svgHost) await loadInlineSvg(svgHost);
  const img = vp.el.querySelector("img");
  if (img && !img.complete) {
    await new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  measureFit(vp);
}

export function clearViewport(vp, text) {
  vp.path = null;
  vp.url = null;
  vp.name = null;
  vp.kind = null;
  vp.el.className = "preview-frame empty-frame";
  vp.el.textContent = text;
}

// ---------- zoom / pan ----------
export function zoomVp(vp, factor) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = Math.max(0.02, Math.min(40, vp.scale * factor));
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}
export function fitVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = vp.fitScale || 1;
  vp.x = 0; vp.y = 0;
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}
export function actualVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = 1; vp.x = 0; vp.y = 0;
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}

export function bindViewportDragging(vp) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  vp.el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;   // right/middle: leave for the context menu (capturing would retarget it)
    if (!vp.el.querySelector(".viewport-content")) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    vp.el.setPointerCapture(event.pointerId);
  });
  vp.el.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    vp.x += event.clientX - lastX;
    vp.y += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    applyViewportState(vp);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    // Pan moved the view → re-cull node handles to the new region (LOD virtualization).
    // On pan-end only (not per-frame): handles ride the content transform while dragging.
    if (vp === viewports.output) editor.onViewportChanged();
  };
  vp.el.addEventListener("pointerup", stop);
  vp.el.addEventListener("pointercancel", stop);
}

// Trackpad / wheel zoom, centred on the frame (clamped via zoomVp).
export function bindViewportZoom(vp) {
  vp.el.addEventListener("wheel", (event) => {
    if (!vp.el.querySelector(".viewport-content")) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomVp(vp, factor);
  }, { passive: false });
}
