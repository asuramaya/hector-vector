// Shared gallery + file-action primitives — extracted from app.js (#28, the
// info/library/viewport subsystem leaf). These are the bits that the Open/Place
// modals (docio), the library panel, and the C/R/V info modals all reach for:
// the thumbnail grid renderer + its per-cell icon action row, the raster→canvas
// loader, and the small clipboard/download/reveal file actions. State lives in
// docstate; the shell injects its status/modal/viewport/doc seams via
// configureGallery — so this module imports only stable leaves (editor/api/export/
// docstate) and stays one-directional (docio imports renderGalleryGrid from here).
import { editor } from "../editor.js";
import { api } from "./api.js";
import { inlineSvgImages } from "./export.js";
import { viewports } from "./viewport.js";
import { selectedOutput, setSelectedName, setManualOutputName, setSelectedOutput } from "./docstate.js";

let setStatus, modalBodyEl, mountBlankCanvas, mountStageFromText, rememberLastDoc, defaultSaveName;
export function configureGallery(deps) {
  ({ setStatus, modalBodyEl, mountBlankCanvas, mountStageFromText, rememberLastDoc, defaultSaveName } = deps);
}

export async function copyToClipboard(text, label) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${label || text}`, 1800);
    return true;
  } catch (e) {
    setStatus(`Copy failed: ${e.message}`, 2500);
    return false;
  }
}

// Compact icon action-row shared by both gallery grids (Open/Place modal and the
// Process workspace). Icons (not text) so five actions fit a ~130px cell without
// overflowing — the old text buttons widened the track and clipped on the right.
export function galleryActionRow({ name, absPath, url, onInfo }) {
  const actions = document.createElement("div");
  actions.className = "gallery-actions";
  const mk = (glyph, title, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "gallery-act"; b.textContent = glyph;
    b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    actions.appendChild(b);
  };
  if (onInfo) mk("ⓘ", "Info — dimensions, EXIF, in-place transforms", onInfo);
  if (name) mk("⧉", `Copy filename: ${name}`, () => copyToClipboard(name));
  if (absPath) {
    mk("⌖", `Copy path: ${absPath}`, () => copyToClipboard(absPath));
    mk("⌂", "Reveal in file manager", () => revealInFileManager(absPath));
  }
  if (url) mk("↗", "Open in a new tab", () => window.open(url, "_blank", "noopener"));
  return actions;
}

// Load a raster into the editor viewport as an <image> node (coexists with vectors).
// Reads natural pixel size first so the node fits + centres correctly.
export async function loadRasterToCanvas(item) {
  if (!item) return;
  try {
    const dim = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => rej(new Error(`Couldn't load ${item.name}`));
      im.src = item.url;
    });
    // Don't dead-end on "create a canvas first." With no canvas — or only an
    // untouched blank artboard (e.g. the default one from startup) — mint a canvas
    // sized to the image, so loading just works and the image isn't crammed into
    // the default 512 box. An existing canvas WITH content is left alone (place in).
    if (canvasIsEmpty() && dim.w > 0 && dim.h > 0) mountBlankCanvas(Math.round(dim.w), Math.round(dim.h));
    editor.placeImage(item.url, item.name, dim.w, dim.h);
  } catch (e) { setStatus(e.message, 3000); }
}
// True when there's no stage, or the stage holds only the artboard/overlay chrome
// (no placed content) — i.e. a fresh editor that should accept a load by minting
// a canvas rather than refusing or cramming into the default blank.
export function canvasIsEmpty() {
  return !editor.stage || editor.stage.querySelectorAll("[data-hv-id]").length === 0;
}

// Place a dropped/opened image FILE straight onto the canvas (read as a data URL →
// <image> node), minting a canvas sized to it when the editor is empty. The File twin
// of loadRasterToCanvas, so a drag-drop lands where you're working instead of being
// imported into the library. Returns true on success.
export async function loadFileToCanvas(file) {
  if (!file) return false;
  try {
    const url = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error(`Couldn't read ${file.name}`));
      r.readAsDataURL(file);
    });
    const dim = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => rej(new Error(`Couldn't load ${file.name}`));
      im.src = url;
    });
    if (canvasIsEmpty() && dim.w > 0 && dim.h > 0) mountBlankCanvas(Math.round(dim.w), Math.round(dim.h));
    editor.placeImage(url, file.name, dim.w, dim.h);
    return true;
  } catch (e) { setStatus(e.message, 3000); return false; }
}

export function renderGalleryGrid(items, onPick) {
  if (!items.length) {
    modalBodyEl.innerHTML = `<div class="gallery-empty">Nothing to show.</div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  for (const item of items) {
    const cell = document.createElement("div");
    cell.className = `gallery-cell ${item.active ? "active" : ""}`;

    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "gallery-thumb-button";
    thumb.title = `Select ${item.name}`;
    // Render SVG thumbs as <img> (not <object>): browsers cap concurrent nested
    // <object> document loads and ignore lazy-loading, so a gallery of many
    // vectors leaves most cells blank. <img> paints reliably and lazily — the
    // Process gallery already does this.
    // item.icon (a glyph, not a URL) opts a cell out of the <img> thumb entirely — for
    // non-image resources like a .hv project's JSON, an <img src> would just 404 into a
    // broken-image icon; same glyph-tile convention as the Library sidebar's own project
    // cells (renderLibraryCanvases's "⛋").
    thumb.innerHTML = item.icon
      ? `<div class="gallery-thumb gallery-thumb-proj">${item.icon}</div>`
      : `<div class="gallery-thumb"><img src="${item.url}" alt="${item.name}" loading="lazy" decoding="async" /></div>`;
    thumb.addEventListener("click", () => onPick(item));
    cell.appendChild(thumb);

    const caption = document.createElement("div");
    caption.className = "gallery-caption";
    caption.title = item.name;
    caption.textContent = item.name;
    cell.appendChild(caption);

    const absPath = item.absPath || item.path || "";
    cell.appendChild(galleryActionRow({ name: item.name, absPath, url: item.url }));

    grid.appendChild(cell);
  }
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(grid);
}

// --- File/locate actions (used by the gallery cell actions) ---

export async function revealInFileManager(absPath) {
  if (!absPath) return;
  try {
    const data = await api("/api/reveal", "POST", { path: absPath });
    setStatus(data.message || "Opened folder.", 1500);
  } catch (e) {
    setStatus(`Reveal failed: ${e.message}`, 3000);
  }
}

export async function copySvgSource() {
  let text = editor.serialize() ||
    (viewports.output.url ? await (await fetch(viewports.output.url)).text() : "");
  if (!text) return;
  text = await inlineSvgImages(text);   // bake placed-raster hrefs → data URIs so the copy is self-contained
  await copyToClipboard(text, `SVG (${text.length} chars)`);
}

// Save bytes straight to the user's machine via a synthetic download link — the
// escape hatch from the server outputs folder (works on any canvas, saved or not).
export function downloadBlob(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadCurrentSvg() {
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  let text = editor.serialize();
  if (!text) { setStatus("Nothing to download.", 2500); return; }
  text = await inlineSvgImages(text);   // bake placed-raster hrefs → data URIs so the .svg is portable off-machine
  const name = (defaultSaveName() || "untitled") + ".svg";
  downloadBlob(name, text, "image/svg+xml");
  setStatus(`Downloaded ${name}.`, 2000);
}

// Open an .svg straight from disk (browser file picker) — untracked, so Save → Save-As.
export function openFromFile() {
  const inp = document.querySelector("#open-file-input");
  if (!inp) return;
  inp.value = "";
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      if (!/<svg[\s>]/i.test(text)) { setStatus("That doesn't look like an SVG file.", 3000); return; }
      setSelectedName(null); setManualOutputName(null);
      mountStageFromText(text, file.name);
      setSelectedOutput(null);            // disk-opened doc has no server target → Save = Save-As
      rememberLastDoc();
      setStatus(`Opened ${file.name}.`, 2000);
    };
    reader.onerror = () => setStatus("Could not read that file.", 3000);
    reader.readAsText(file);
  };
  inp.click();
}

export function revealCurrentFile() {
  if (selectedOutput && selectedOutput.path) return revealInFileManager(selectedOutput.path);
  setStatus("Save the document first — only saved files can be revealed.", 3000);
}

// Trigger a browser download of a URL under a chosen filename.
export function downloadUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url; a.download = filename || "";
  document.body.appendChild(a); a.click(); a.remove();
}
