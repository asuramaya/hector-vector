// Serialize + rasterize + export the canvas — extracted from app.js (#28).
// Three jobs that all start from editor.serialize(): (1) bake placed-raster hrefs to
// data URIs (inlineSvgImages) so a saved/exported file is self-contained; (2) the save
// serializer with the server byte-cap guard (serializeForSave); (3) the PNG export modal
// that rasterizes the live canvas in the browser (no cairosvg). The shell injects its
// modal/status/refresh seams + a getter/setter for the shared doc-selection state.
import { editor, ghostBtn } from "../editor.js";
import { api } from "./api.js";
import { sectionTitle, makeSelectRaw, makeNumberRaw, fieldRow, fmtBytes } from "./widgets.js";

let setStatus, confirmDialog, openModal, closeModal,
    modalBodyEl, modalSearchEl, modalTitleEl,
    defaultSaveName, downloadBlob, refreshAll, getSelectedOutput, setManualOutputName;
export function configureExport(deps) {
  ({ setStatus, confirmDialog, openModal, closeModal,
     modalBodyEl, modalSearchEl, modalTitleEl,
     defaultSaveName, downloadBlob, refreshAll, getSelectedOutput, setManualOutputName } = deps);
}
// Test seam (window.app.setSaveByteCap): force/clear the cap without a giant raster.
export function setSaveByteCap(n) { _saveByteCap = n; }

let exportState = { mode: "scale", scale: 16, longest: 1024, width: 0, height: 0, background: "transparent" };
let lastExport = null;   // { blob, url, name, w, h } — the most recent client render, reused by the result actions

// The SVG to export + its native size + an optional library save target. Prefer the
// LIVE canvas (exports exactly what's shown, including unsaved edits) over the saved
// file, and fall back to the on-disk output when there's no editor stage.
function currentExportSource() {
  if (editor && editor.stage) {
    const vb = editor.stage.viewBox && editor.stage.viewBox.baseVal;
    const native = vb && vb.width > 0 ? [Math.round(vb.width), Math.round(vb.height)] : null;
    return { svg: editor.serialize(), native, target: getSelectedOutput() || null };
  }
  return null;
}

// Inline same-origin <image> hrefs as data URIs. An SVG loaded into an <img> renders
// in "secure static mode" — external references (our /outputs, /work-items rasters)
// are BLOCKED and would vanish from the PNG — so bake them in first.
export async function inlineSvgImages(svgText) {
  if (!/<image\b/i.test(svgText)) return svgText;
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  await Promise.all([...doc.querySelectorAll("image")].map(async (im) => {
    const href = im.getAttribute("href") || im.getAttribute("xlink:href") || "";
    if (!href || href.startsWith("data:")) return;
    try {
      const blob = await (await fetch(href)).blob();
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      im.setAttribute("href", dataUrl); im.removeAttribute("xlink:href");
    } catch { /* leave the href; worst case that one raster is missing */ }
  }));
  return new XMLSerializer().serializeToString(doc);
}

// The save byte cap is the SERVER's guard, fetched once via /api/limits (so the client
// mirror can't drift). Falls back to the historical value if the server predates the route.
const FALLBACK_SAVE_BYTE_CAP = 16_000_000;
let _saveByteCap = null;
async function saveByteCap() {
  if (_saveByteCap != null) return _saveByteCap;
  try { const r = await api("/api/limits"); if (r && Number.isFinite(r.max_svg_bytes)) _saveByteCap = r.max_svg_bytes; }
  catch { /* older server: use the fallback (and don't poison the cache) */ }
  return _saveByteCap || FALLBACK_SAVE_BYTE_CAP;
}

// Serialize the canvas for PERSISTENCE: bake placed-raster hrefs → data URIs so the saved
// .svg is self-contained (portable off-machine, robust if a source work-item is deleted).
// Embedding big rasters can exceed the server's save cap. Rather than SILENTLY downgrade to
// a non-portable linked file (the user would think they got a portable one), ask: the
// fallback only happens if they confirm it. Returns null to abort the save (caller bails).
export async function serializeForSave() {
  const raw = editor.serialize();
  if (!raw) return raw;
  let baked = raw;
  try { baked = await inlineSvgImages(raw); } catch { baked = raw; }
  baked = await withEmbeddedFonts(baked);   // embed used web fonts so the .svg renders off-machine (T13)
  const cap = await saveByteCap();
  if (baked.length <= cap) return baked;
  if (raw.length > cap) {
    // Even linked, it's over the cap — the server would reject it either way; say so plainly.
    setStatus(`This document is ${fmtBytes(raw.length)}, over the ${fmtBytes(cap)} save limit. Simplify it and try again.`, 6000);
    return null;
  }
  const ok = await confirmDialog({
    title: "Rasters too large to embed",
    message: `Embedding this document's images would make the file ${fmtBytes(baked.length)}, over the ${fmtBytes(cap)} save limit.\n\n`
      + "Save with LINKED image references instead? The file stays small but is NOT portable off this machine — it points at local /work-items and /outputs files.",
    okLabel: "Save linked", cancelLabel: "Cancel",
  });
  if (!ok) { setStatus("Save cancelled.", 2500); return null; }
  setStatus("Saved with linked image references (not portable off-machine).", 4500);
  return raw;
}

// Bake the used web fonts into the SVG as base64 @font-face (T13/T14). An <img>-rendered
// SVG (both the save file off-machine AND the export canvas) is an ISOLATED document — it
// can't see document.fonts, so the faces must live inside the markup or text falls back to a
// system font. Returns the SVG unchanged when no web fonts are in play.
export async function withEmbeddedFonts(svgText) {
  try {
    const css = window.__fonts ? await window.__fonts.embedFontFaceCSS(svgText) : "";
    if (!css) return svgText;
    const m = svgText.match(/<svg\b[^>]*>/i);
    if (!m) return svgText;
    const at = m.index + m[0].length;
    return svgText.slice(0, at) + css + svgText.slice(at);
  } catch { return svgText; }
}

// Rasterise an SVG string to a PNG Blob on a canvas — the browser's own SVG renderer,
// so curves/strokes/gradients all work without cairosvg or any system tool.
export function renderSvgToPngBlob(svgText, w, h, background) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
        const ctx = c.getContext("2d");
        if (background && background !== "transparent") { ctx.fillStyle = background === "black" ? "#000000" : "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => b ? resolve(b) : reject(new Error("The canvas produced no image.")), "image/png");
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The browser couldn't load this SVG to rasterise it.")); };
    img.src = url;
  });
}

function targetSizeFor(native) {
  const [nw, nh] = native || [0, 0];
  if (exportState.mode === "scale") {
    return [Math.max(1, Math.round(nw * exportState.scale)), Math.max(1, Math.round(nh * exportState.scale))];
  }
  if (exportState.mode === "longest") {
    if (!nw || !nh) return [exportState.longest, exportState.longest];
    const r = exportState.longest / Math.max(nw, nh);
    return [Math.max(1, Math.round(nw * r)), Math.max(1, Math.round(nh * r))];
  }
  return [exportState.width || nw, exportState.height || nh];
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read the rendered image.")); r.readAsDataURL(blob); });
}

// Epic A1 — "render -> png", headless-callable. Same pipeline the Export modal drives
// (inline placed rasters, embed used web fonts, rasterise on the browser's OWN SVG
// renderer), but parameterized instead of reading/writing the modal's shared exportState,
// and returning a data URL instead of opening a dialog. This is the seam a script driving a
// headless browser (tools/render_png.py) calls to get real EYES on the live canvas — the
// same rendering a user would see, not a second, different renderer (see tools/svg_render.py's
// own docstring: it's a narrow Pillow/cairosvg tool for axis-aligned pixel-art SVGs, and would
// silently mis-render gradients, masks, filters, live shapes, symbols, text-on-path...).
export async function renderCurrentPngDataUrl({ scale = 1, width = 0, height = 0, background = "transparent" } = {}) {
  const src = currentExportSource();
  if (!src) throw new Error("No document is open.");
  const [nw, nh] = src.native || [0, 0];
  const w = width || Math.max(1, Math.round((nw || 512) * scale));
  const h = height || Math.max(1, Math.round((nh || 512) * scale));
  if (window.__fonts) await window.__fonts.fontsReady();
  let svgText = await inlineSvgImages(src.svg);
  svgText = await withEmbeddedFonts(svgText);
  const blob = await renderSvgToPngBlob(svgText, w, h, background);
  return { dataUrl: await blobToDataUrl(blob), w, h };
}

export function openExportModal() {
  const src = currentExportSource();
  if (!src) { setStatus("Open or create a canvas first.", 2500); return; }
  const native = src.native;
  openModal("Export PNG", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div");
  root.className = "form";

  // Preview of what's being exported (the live canvas), on a checker so transparency reads.
  const preview = document.createElement("div"); preview.className = "export-preview";
  const pimg = document.createElement("img"); pimg.alt = "Export preview";
  preview.appendChild(pimg); root.appendChild(preview);
  const showPreview = (svg) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    pimg.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    pimg.src = url;
  };
  showPreview(src.svg);   // show the plain SVG instantly…
  // …then upgrade to the font-embedded SVG the export actually renders, so the preview matches
  // the PNG. The <img> render is isolated from the document, so un-embedded web fonts would
  // otherwise fall back to a system face in the preview only.
  (async () => {
    try { if (window.__fonts) await window.__fonts.fontsReady(); showPreview(await withEmbeddedFonts(src.svg)); }
    catch { /* keep the plain preview */ }
  })();

  const sizeOut = document.createElement("div");
  sizeOut.className = "form-hint";
  const refreshSizeOut = () => {
    const [w, h] = targetSizeFor(native);
    sizeOut.textContent = native ? `Native ${native[0]}×${native[1]} → output ${w}×${h} px` : `Output ${w}×${h} px`;
  };

  root.appendChild(sectionTitle("Size"));
  const modeSel = makeSelectRaw(exportState.mode, [
    ["scale", "Multiply native (×N)"],
    ["longest", "Longest side (px)"],
    ["custom", "Custom width × height"],
  ], (v) => { exportState.mode = v; openExportModal(); });
  root.appendChild(fieldRow("Mode", modeSel));

  if (exportState.mode === "scale") {
    const presets = [2, 4, 8, 16, 32, 64];
    const sel = makeSelectRaw(String(exportState.scale), presets.map((n) => [String(n), `×${n}`]), (v) => { exportState.scale = +v; refreshSizeOut(); });
    root.appendChild(fieldRow("Scale", sel, "Each native unit becomes an N×N block."));
  } else if (exportState.mode === "longest") {
    const presets = [256, 512, 1024, 2048, 4096];
    const sel = makeSelectRaw(String(exportState.longest), presets.map((n) => [String(n), `${n} px`]), (v) => { exportState.longest = +v; refreshSizeOut(); });
    root.appendChild(fieldRow("Longest side", sel, "Aspect ratio is preserved."));
  } else {
    const wInp = makeNumberRaw(exportState.width || (native ? native[0] : 0), (v) => { exportState.width = v; refreshSizeOut(); });
    const hInp = makeNumberRaw(exportState.height || (native ? native[1] : 0), (v) => { exportState.height = v; refreshSizeOut(); });
    root.appendChild(fieldRow("Width", wInp));
    root.appendChild(fieldRow("Height", hInp));
  }

  root.appendChild(sectionTitle("Background"));
  const bgSel = makeSelectRaw(exportState.background, [
    ["transparent", "Transparent"],
    ["white", "White"],
    ["black", "Black"],
  ], (v) => { exportState.background = v; });
  root.appendChild(fieldRow("Fill", bgSel));

  refreshSizeOut();
  root.appendChild(sizeOut);

  const actions = document.createElement("div");
  actions.className = "form-actions";
  const go = document.createElement("button");
  go.type = "button"; go.className = "primary-button";
  go.textContent = "Render PNG";
  go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Rendering…";
    const [w, h] = targetSizeFor(native);
    try {
      // Browser-side rasterise (no cairosvg). Inline rasters + embed web fonts first so
      // neither drops out of the isolated <img> render.
      if (window.__fonts) await window.__fonts.fontsReady();
      let svgText = await inlineSvgImages(src.svg);
      svgText = await withEmbeddedFonts(svgText);
      const blob = await renderSvgToPngBlob(svgText, w, h, exportState.background);
      if (lastExport && lastExport.url) URL.revokeObjectURL(lastExport.url);
      const base = src.target ? src.target.name.replace(/\.svg$/i, "") : (defaultSaveName() || "export");
      lastExport = { blob, url: URL.createObjectURL(blob), name: `${base}@${w}x${h}.png`, w, h, target: src.target };
      showExportResult();
    } catch (e) {
      go.disabled = false; go.textContent = "Render PNG";
      const hint = document.createElement("div"); hint.className = "form-hint status-error"; hint.textContent = e.message; actions.appendChild(hint);
    }
  });
  actions.appendChild(go);
  root.appendChild(actions);

  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}

// Success step: the PNG is already in-hand (a client-rendered blob). Download it, drop
// it in the library (if there's an SVG to sit beside), open it, or close — no dead end,
// and nothing is stranded on disk unless the user asks for it.
function showExportResult() {
  const ex = lastExport;
  if (!ex) return;
  modalTitleEl.textContent = "Exported";
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Rendered"));
  const preview = document.createElement("div"); preview.className = "export-preview";
  const im = document.createElement("img"); im.src = ex.url; im.alt = ex.name; preview.appendChild(im); root.appendChild(preview);
  const info = document.createElement("div"); info.className = "form-hint";
  info.textContent = `${ex.name} — ${ex.w}×${ex.h} px · ${fmtBytes(ex.blob.size)}`;
  root.appendChild(info);

  const actions = document.createElement("div"); actions.className = "form-actions";
  const dl = document.createElement("button"); dl.type = "button"; dl.className = "primary-button"; dl.textContent = "Download PNG";
  dl.addEventListener("click", () => { downloadBlob(ex.name, ex.blob, "image/png"); setStatus(`Downloaded ${ex.name}.`, 2000); });
  actions.appendChild(dl);
  if (ex.target) {
    const saveBtn = ghostBtn("Save to library", async () => {
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        const data = await api("/api/save-render", "POST", {
          folder: ex.target.folder, name: ex.target.name, png_base64: await blobToDataUrl(ex.blob), width: ex.w, height: ex.h,
        });
        setManualOutputName(data.name); await refreshAll();
        saveBtn.textContent = "Saved ✓"; setStatus(data.message || "Saved to library.", 2500);
      } catch (e) { saveBtn.disabled = false; saveBtn.textContent = "Save to library"; setStatus(`Save failed: ${e.message}`, 3500); }
    });
    actions.appendChild(saveBtn);
  }
  actions.appendChild(ghostBtn("Open", () => window.open(ex.url, "_blank", "noopener")));
  actions.appendChild(ghostBtn("Back", () => openExportModal()));
  actions.appendChild(ghostBtn("Done", () => closeModal()));
  root.appendChild(actions);
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
}
