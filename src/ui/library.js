// Library dock panel — extracted from app.js (#28, the last of the info/library/
// viewport subsystem). The three-tab gallery (R input rasters / V output vectors /
// C saved .hv projects): the mode+sort+filter chin, the scroll-preserving grid
// renderers, and the client-side SVG-thumbnail cache. Owns its own view state
// (libraryMode/sort/selection). Reads library data from docstate, output-resolution
// from datasync, and calls INTO info (right-click detail) + docio (open project).
// renderLibrary stays INJECTED into datasync/docio/docks by app.js, so this module
// is a one-directional consumer (no cycle despite the mutual reference).
import { itemIsProcessed, refreshLibrary } from "./datasync.js";
import { openInfoModal, openVectorInfoModal, openProjectInfo } from "./info.js";
import { loadProjects } from "./docio.js";
import {
  workItems, outputs, projects, selectedName,
  setSelectedName, setManualOutputName,
} from "./docstate.js";

let renderProcessorPanel, syncDockContext, observeOverflow;
export function configureLibrary(deps) {
  ({ renderProcessorPanel, syncDockContext, observeOverflow } = deps);
}

// View state — which tab is showing, how it's sorted, and the V/C visual cursor.
// libraryMode is the only one read outside this module (app.js imports it).
export let libraryMode = "raster";   // canvas (.hv projects) | raster (input images) | vector (output SVGs)
let librarySortKey = "name";  // name | date
let librarySortDir = "asc";   // asc | desc
let librarySelectedUrl = null;  // visual selection for the V/C tabs (R uses selectedName)

function libraryFilterValue() { const f = document.querySelector("#library-filter"); return ((f && f.value) || "").trim().toLowerCase(); }
function syncLibModeButtons() { document.querySelectorAll(".lib-mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === libraryMode)); }
function syncLibSortButtons() {
  document.querySelectorAll(".lib-sort-dir").forEach((b) => b.classList.toggle("active", b.dataset.dir === librarySortDir));
  const k = document.querySelector("#library-sortkey"); if (k) k.textContent = librarySortKey === "date" ? "D" : "N";
}
// Sort a list of {name, modified_at} by the active key + direction.
function librarySort(items) {
  const dir = librarySortDir === "desc" ? -1 : 1;
  const val = librarySortKey === "date" ? ((it) => it.modified_at || 0) : ((it) => (it.name || "").toLowerCase());
  return [...items].sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir; });
}
function wireLibraryChin() {
  const filter = document.querySelector("#library-filter");
  if (filter && !filter._wired) { filter._wired = true; filter.addEventListener("input", renderLibrary); }
  document.querySelectorAll(".lib-mode").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", () => { libraryMode = b.dataset.mode; syncLibModeButtons(); if (libraryMode === "canvas") loadProjects(); else renderLibrary(); if (typeof renderProcessorPanel === "function") renderProcessorPanel(); syncDockContext(); });
  });
  document.querySelectorAll(".lib-sort-dir").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", () => { librarySortDir = b.dataset.dir; syncLibSortButtons(); renderLibrary(); });
  });
  const keyBtn = document.querySelector("#library-sortkey");
  if (keyBtn && !keyBtn._wired) { keyBtn._wired = true; keyBtn.addEventListener("click", () => { librarySortKey = librarySortKey === "name" ? "date" : "name"; syncLibSortButtons(); renderLibrary(); }); }
  // Make the library header a customizable tile bar like the other panels (drop receiver
  // in Layout-customize mode); the overflow-scroll lets it hold more than a couple tiles.
  if (window.__layout && window.__layout.registerBar) {
    const acts = document.querySelector(".rail-section.library .panel-actions");
    if (acts && !acts._tileScroll) { acts._tileScroll = true; acts.classList.add("tile-scroll-x"); observeOverflow(acts, "x"); window.__layout.registerBar("hdr-library", acts); }
  }
  syncLibModeButtons(); syncLibSortButtons();
}

// Library dock panel — the same gallery as a first-class panel object (drag/float/
// dock like History & Layers). Renders into #library-list whenever the panel is in
// the DOM; self-guards (no-ops if the panel isn't mounted). Clicking a thumbnail is
// SELECT-ONLY — it sets the pipeline target without swapping the edit canvas.
export function renderLibrary() {
  const host = document.querySelector("#library-list"); if (!host) return;
  wireLibraryChin();
  // Preserve scroll across the rebuild — placing/opening an item or a finishing job
  // re-renders the whole grid; an innerHTML reset would snap the gallery back to the
  // top under the user's cursor (the "pressing a button jumps the scroll" bug).
  const keepScroll = host.scrollTop;
  host.innerHTML = "";
  const q = libraryFilterValue();
  if (libraryMode === "vector") renderLibraryVectors(host, q);
  else if (libraryMode === "canvas") renderLibraryCanvases(host, q);
  else renderLibraryRasters(host, q);
  host.scrollTop = keepScroll;
}
// A brief highlight pulse on a dock panel — the visible half of "clicking a Library
// tile updates Info + Processor". Without it the update is real (new content lands in both
// panels) but silent: nothing on screen draws the eye there, so a click can easily read as
// having done nothing — worth more now that Info/Processor are permanently docked rather
// than opened into a dedicated grid. Restart-safe (classList.remove + reflow + re-add) so
// clicking a second tile before the first pulse finishes still flashes again instead of
// no-op'ing. Matches by section (docked, floated, or grouped — wherever it currently lives).
function bringAttention(sectionName) {
  const s = document.querySelector(`.rail-section.${sectionName}`);
  if (!s) return;
  s.classList.remove("hv-attn");
  void s.offsetWidth;
  s.classList.add("hv-attn");
}
function libSetCount(n) { const c = document.querySelector("#library-count"); if (c) c.textContent = n ? String(n) : ""; }
function libEmpty(host, msg) { const e = document.createElement("div"); e.className = "gallery-empty"; e.textContent = msg; host.appendChild(e); }
function libGrid(host) { const g = document.createElement("div"); g.className = "gallery-grid"; host.appendChild(g); return g; }

// Client-side SVG thumbnails: load each vector ONCE, draw it to a small cached canvas,
// then drop the full SVG. Bounds memory (a few in-flight at a time) so a big V/C tab
// doesn't keep dozens of full traced SVGs live in the DOM (the crash risk). cairosvg
// isn't installed, so server-side rasterising of curved vectors isn't available — this
// is the reliable path.
const TRANSPARENT_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const _svgThumbCache = new Map();
const _svgThumbQueue = [];
let _svgThumbActive = 0;
const SVG_THUMB_MAX = 3, SVG_THUMB_SIZE = 192;
function svgThumb(url, onReady) {
  if (_svgThumbCache.has(url)) { onReady(_svgThumbCache.get(url)); return; }
  _svgThumbQueue.push([url, onReady]); _pumpSvgThumbs();
}
function _pumpSvgThumbs() {
  while (_svgThumbActive < SVG_THUMB_MAX && _svgThumbQueue.length) {
    const [url, onReady] = _svgThumbQueue.shift(); _svgThumbActive++;
    const img = new Image();
    const finish = (data) => { _svgThumbActive--; if (data) _svgThumbCache.set(url, data); onReady(data); _pumpSvgThumbs(); };
    img.onload = () => {
      try {
        const S = SVG_THUMB_SIZE, c = document.createElement("canvas"); c.width = S; c.height = S;
        const ctx = c.getContext("2d");
        const iw = img.naturalWidth || S, ih = img.naturalHeight || S, k = Math.min(S / iw, S / ih);
        const w = Math.max(1, iw * k), h = Math.max(1, ih * k);
        ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        finish(c.toDataURL("image/png"));
      } catch { finish(null); }
    };
    img.onerror = () => finish(null);
    img.src = url;
  }
}

function libCell(grid, { url, name, active, processed, badge, title, onClick, onContext, svg, drag }) {
  const cell = document.createElement("div");
  cell.className = "gallery-cell" + (active ? " active" : "") + (processed ? " processed" : "");
  const thumb = document.createElement("button");
  thumb.type = "button"; thumb.className = "gallery-thumb-button"; thumb.title = title || name;
  const initial = svg ? TRANSPARENT_PX : url;   // SVGs defer to a canvas thumbnail (no full load in-DOM)
  thumb.innerHTML = `<div class="gallery-thumb${svg ? " gallery-thumb-loading" : ""}"><img src="${initial}" alt="${name}" loading="lazy" decoding="async" /></div>`;
  if (onClick) thumb.addEventListener("click", onClick);
  if (onContext) thumb.addEventListener("contextmenu", (e) => { e.preventDefault(); onContext(); });
  if (drag) {   // drag a cell onto the canvas to load it (raster/vector/project)
    thumb.draggable = true;
    thumb.addEventListener("dragstart", (e) => { try { e.dataTransfer.setData("application/x-hv-lib", JSON.stringify(drag)); e.dataTransfer.effectAllowed = "copy"; } catch {} });
  }
  cell.appendChild(thumb);
  const cap = document.createElement("div"); cap.className = "gallery-caption"; cap.title = name;
  cap.textContent = name + (badge || "");
  cell.appendChild(cap);
  grid.appendChild(cell);
  if (svg) svgThumb(url, (data) => { const im = cell.querySelector(".gallery-thumb img"); if (im && data) { im.src = data; im.parentElement.classList.remove("gallery-thumb-loading"); } });
  return cell;
}

// R — input images (pipeline sources). Click = select-only; Info + Load actions.
function renderLibraryRasters(host, q) {
  libSetCount(workItems.length);
  if (!workItems.length) return libEmpty(host, "No images yet — drop files here or use ⊕.");
  const sorted = librarySort(workItems);
  const items = q ? sorted.filter((it) => it.name.toLowerCase().includes(q)) : sorted;
  if (!items.length) return libEmpty(host, `No images match “${q}”.`);
  const grid = libGrid(host);
  for (const item of items) {
    libCell(grid, {
      url: `${item.url}?w=256`, name: item.name,
      active: item.name === selectedName, processed: itemIsProcessed(item.name),
      badge: itemIsProcessed(item.name) ? " ✓" : "", title: `${item.name} — click to select + inspect, drag to the canvas`,
      // Selecting a library raster makes it the Processor's target when the canvas is empty,
      // so re-render the Processor (target row + auto-routing banner) + run the contextual
      // reveal — otherwise picking an image in the Library never surfaces its plan (a raster
      // already on the canvas still wins the target, so this is then a no-op).
      onClick: () => {
        setSelectedName(item.name); setManualOutputName(null); refreshLibrary();
        if (typeof renderProcessorPanel === "function") renderProcessorPanel();
        if (typeof syncDockContext === "function") syncDockContext();
        openInfoModal(item.name);
        bringAttention("info"); bringAttention("processor");
      },
      onContext: () => openInfoModal(item.name),
      drag: { mode: "raster", url: item.url, name: item.name },
    });
  }
}

// V — output vectors. Click = place the SVG into the canvas (as a layer); ↗ opens raw.
function renderLibraryVectors(host, q) {
  const svgs = (outputs || []).filter((o) => (o.name || "").toLowerCase().endsWith(".svg"));
  libSetCount(svgs.length);
  if (!svgs.length) return libEmpty(host, "No output vectors yet — run a pipeline with Vectorize on.");
  const sorted = librarySort(svgs);
  const items = q ? sorted.filter((o) => o.name.toLowerCase().includes(q)) : sorted;
  if (!items.length) return libEmpty(host, `No vectors match “${q}”.`);
  const grid = libGrid(host);
  for (const o of items) {
    libCell(grid, {
      url: o.url, name: o.name, active: o.url === librarySelectedUrl, svg: true,
      title: `${o.name} — click to select, drag to the canvas, right-click for info`,
      onClick: () => { librarySelectedUrl = o.url; renderLibrary(); },
      onContext: () => openVectorInfoModal(o),
      drag: { mode: "vector", url: o.url, name: o.name },
    });
  }
}

// C — saved .hv projects (canvas markup + undo history). Click/⤓ opens the project,
// restoring layers AND history.
function renderLibraryCanvases(host, q) {
  libSetCount(projects.length);
  if (!projects.length) return libEmpty(host, "No saved projects yet — File ▸ Save project.");
  const sorted = librarySort(projects);
  const items = q ? sorted.filter((p) => p.name.toLowerCase().includes(q)) : sorted;
  if (!items.length) return libEmpty(host, `No projects match “${q}”.`);
  const grid = libGrid(host);
  for (const proj of items) {
    const cell = document.createElement("div"); cell.className = "gallery-cell" + (proj.url === librarySelectedUrl ? " active" : "");
    const thumb = document.createElement("button");
    thumb.type = "button"; thumb.className = "gallery-thumb-button"; thumb.draggable = true;
    thumb.title = `${proj.name} — click to select, drag to the canvas, right-click for info`;
    thumb.innerHTML = `<div class="gallery-thumb gallery-thumb-proj">⛋</div>`;
    thumb.addEventListener("click", () => { librarySelectedUrl = proj.url; renderLibrary(); });
    thumb.addEventListener("contextmenu", (e) => { e.preventDefault(); openProjectInfo(proj); });
    thumb.addEventListener("dragstart", (e) => { try { e.dataTransfer.setData("application/x-hv-lib", JSON.stringify({ mode: "canvas", url: proj.url, name: proj.name })); e.dataTransfer.effectAllowed = "copy"; } catch {} });
    cell.appendChild(thumb);
    const cap = document.createElement("div"); cap.className = "gallery-caption"; cap.title = proj.name; cap.textContent = proj.name;
    cell.appendChild(cap);
    grid.appendChild(cell);
  }
}
