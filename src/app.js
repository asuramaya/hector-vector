// =========================================================================
// hector-vector — app shell. State, library/queue, viewports, modal + form
// primitives, the Process workspace, menus, document ops, keyboard, bootstrap.
// Consumes the hv library and the editor module; exposes a small service set to
// the editor and a window bridge for automation (both at the bottom of file).
// =========================================================================
import * as hv from "./hv/index.js";
import { shapeToAbsPath } from "./hv/index.js";
import { editor, ghostBtn } from "./editor.js";

const fileInputEl = document.querySelector("#file-input");
const outputPreviewEl = document.querySelector("#output-preview");
const statusTextEl = document.querySelector("#status-text");
const outputLabelEl = document.querySelector("#output-label");
const modalRootEl = document.querySelector("#modal-root");
const modalTitleEl = document.querySelector("#modal-title");
const modalBodyEl = document.querySelector("#modal-body");
const modalSearchEl = document.querySelector("#modal-search");
const appShellEl = document.querySelector(".app.editor");
const shortcutButtonEl = document.querySelector("#shortcut-button");

const SETTINGS_DEFAULTS = {
  model: "realesrgan-x4plus",
  scale: "4",
  trace_mode: "spline",
  filter_speckle: "6",
  corner_threshold: "85",
  segment_length: "4.5",
  splice_threshold: "45",
  path_precision: "2",
  color_precision: "6",
  // --- Pipeline stages (the strip). The 6 old "processes" are just stage subsets. ---
  stage_upscale: true,         // toggleable stages, default = the old "Production SVG"
  stage_removebg: true,
  stage_vectorize: true,
  removebg_method: "classical", // classical | ai (rembg) | green (chromakey) — folds in Greenscreen
  vectorize_method: "trace",    // trace (vtracer) | pixel (pixelvec) — folds in Pixel Art → SVG
  pipeline_order: "upscale,removebg,vectorize",   // visual block order (persisted); flow stays canonical
  trace_simplify: "medium",    // post-trace refit to minimal cubics: off/light/medium/strong
  trace_colormode: "bw",       // bw = mask trace (1-color); color = full-color trace of the image
  trace_color_style: "poster", // poster = flat limited palette · photo = smooth gradients
  trace_hierarchical: "stacked", // stacked = layered fills · cutout = non-overlapping
  target_max_dim: "",
  mask_threshold: "",
  trace_preset: "balanced",
  trace_advanced: false,
  cutout_backend: "classical",
  cutout_model: "u2net",
  alpha_matting: false,
  pv_grid: "",
  pv_mode: "merged",
  pv_sample: "mode",
  pv_quantize: "0",
  pv_key_corner: false,
};

const SETTINGS_STORAGE_KEY = "hector-vector:settings";
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

// General app preferences (distinct from the per-process pipeline `settings`).
const PREFS_KEY = "hector-vector:prefs";
// `startup`: what to show on launch — "blank" (a fresh canvas + the Process
// workspace, the default) or "resume" (reopen the last document). Migrates the
// old boolean `resume` pref for anyone who had set it.
const PREFS_DEFAULTS = { startup: "blank", smartGuides: true, rulers: false };
let prefs = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (stored.startup === undefined && typeof stored.resume === "boolean") stored.startup = stored.resume ? "resume" : "blank";
    delete stored.resume;
    return { ...PREFS_DEFAULTS, ...stored };
  } catch { return { ...PREFS_DEFAULTS }; }
})();
function persistPrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }
editor.smartGuides = prefs.smartGuides;   // apply the persisted preference
editor.loadGuides();   // restore persisted ruler guides before the first stage mounts

// Resume-to-last-document: remember whichever doc is on the canvas, restore it on launch.
const LAST_DOC_KEY = "hector-vector:last-doc";
// Snapshot the saved descriptor NOW, at module load — the boot auto-load mounts a
// default doc and rememberLastDoc() would overwrite the stored value before
// resumeLastDoc() gets to read it.
const _bootLastDoc = (() => { try { return JSON.parse(localStorage.getItem(LAST_DOC_KEY) || "null"); } catch { return null; } })();
function rememberLastDoc() {
  try {
    let d = null;
    if (editor.stage && selectedOutput) {
      // library output (reload via its work item) or a saved canvas/standalone file (reload from disk)
      d = { sel: (!editor.pinned && selectedName) || null, manual: manualOutputName || null,
            folder: selectedOutput.folder, name: selectedOutput.name, url: selectedOutput.url,
            canvas: selectedOutput.folder === "canvas" };
    } else if (editor.stage && !editor.pinned && selectedName) {
      d = { sel: selectedName };
    }
    if (d) localStorage.setItem(LAST_DOC_KEY, JSON.stringify(d));
  } catch {}
}
// Returns true if it actually restored a document (so the caller can fall back
// to a blank canvas when there is nothing to resume).
async function resumeLastDoc() {
  const d = _bootLastDoc;   // the value as it was at launch (see _bootLastDoc)
  if (!d) return false;
  try {
    if (d.sel && workItems.some((w) => w.name === d.sel)) {       // a library work item
      editor.pinned = false; selectedName = d.sel; manualOutputName = d.manual || null;
      refreshLibrary(); await renderPreviews(); return true;
    }
    if (d.url) {                                                   // a saved canvas / standalone vector on disk
      const out = d.canvas ? { name: d.name, folder: d.folder, url: d.url, kind: "svg", path: null } : null;
      await loadSvgToStage(d.url, d.name || "document.svg", out);
      return true;
    }
  } catch {}
  return false;
}

let workItems = [];
let outputs = [];
let projects = [];            // saved .hv projects (Canvas tab)
let libraryMode = "raster";   // canvas (.hv projects) | raster (input images) | vector (output SVGs)
let librarySortKey = "name";  // name | date
let librarySortDir = "asc";   // asc | desc
let librarySelectedUrl = null;  // visual selection for the V/C tabs (R uses selectedName)
let selectedName = null;
let selectedOutput = null;
let manualOutputName = null;
let workspace = null;
let statusHoldUntil = 0;
let outputsDir = "";

async function copyToClipboard(text, label) {
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

const viewports = {
  output: { el: outputPreviewEl, scale: 1, x: 0, y: 0, fitScale: 1, path: null, url: null, name: null, kind: null },
};

function applyBgMode(vpName) {
  const vp = viewports[vpName];
  if (!vp) return;
  const shell = vp.el.querySelector(".viewport-shell");
  if (!shell) return;
  for (const mode of BG_MODES) shell.classList.remove(`bg-${mode}`);
  shell.classList.add(`bg-${bgModes[vpName]}`);
}

function cycleBg(vpName) {
  const cur = bgModes[vpName] || "checker";
  const i = BG_MODES.indexOf(cur);
  bgModes[vpName] = BG_MODES[(i + 1) % BG_MODES.length];
  persistBgModes();
  applyBgMode(vpName);
  setStatus(`Background: ${bgModes[vpName]}`, 1200);
}

async function api(url, method = "GET", payload) {
  const res = await fetch(url, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      throw new Error("Unexpected server response.");
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function stem(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/@\d+x\d+$/, "")                        // group rendered "name@512x512.png"
    .replace(/(?:\.cutout|\.chromakey|\.edited)$/, "");  // …and edited SVGs under their source
}

function jobOutputUrl(job, rel) {
  // rel is relative to OUTPUTS_DIR, e.g. "pipeline-XYZ/bridge.svg"
  return "/outputs/" + rel.split("/").map(encodeURIComponent).join("/");
}

function jobOutputName(rel) {
  const parts = rel.split("/");
  return parts[parts.length - 1];
}

function jobOutputFolder(rel) {
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : "";
}

function jobOutputKind(name) {
  return name.toLowerCase().endsWith(".svg") ? "svg" : "png";
}

function chooseFinalOutput(job) {
  // Pick the "headline" output for a finished job.
  const outs = (job.outputs || []).filter((rel) => !jobOutputName(rel).includes(".mask."));
  if (!outs.length) return null;
  const byKind = (kind) => job.kind === kind;
  const find = (pred) => outs.find(pred);
  if (byKind("pipeline") || byKind("vectorize")) {
    return find((rel) => rel.endsWith(".svg")) || outs[outs.length - 1];
  }
  if (byKind("cutout")) {
    return find((rel) => jobOutputName(rel).includes(".cutout.")) || outs[0];
  }
  if (byKind("chromakey")) {
    return find((rel) => jobOutputName(rel).includes(".chromakey.")) || outs[0];
  }
  if (byKind("upscale")) {
    return find((rel) => rel.toLowerCase().endsWith(".png")) || outs[0];
  }
  return outs[outs.length - 1];
}

function setStatus(text, holdMs = 0, opts = {}) {
  statusTextEl.textContent = text;
  statusHoldUntil = holdMs ? Date.now() + holdMs : 0;
  statusTextEl.classList.toggle("status-error", !!opts.error);
  statusTextEl.classList.toggle("status-clickable", !!opts.onClick);
  statusTextEl.title = opts.title || "";
  statusTextEl.onclick = opts.onClick || null;
}

function canReplaceStatus() {
  return Date.now() >= statusHoldUntil;
}

function latestOutputsFor(name) {
  if (!name) return [];
  const targetStem = stem(name);
  const fromGlobal = outputs.filter((item) => stem(item.name) === targetStem);
  // Also surface every variant produced by recent jobs for this source.
  // /api/outputs dedupes by filename across folders so it can miss intermediates
  // (preview.png, mask.png, etc.). job.outputs[] keeps the full list per job.
  const known = new Set(fromGlobal.map((x) => `${x.folder}/${x.name}`));
  const extras = [];
  for (const job of jobsCache) {
    if (!job.source_name || stem(job.source_name) !== targetStem) continue;
    for (const rel of job.outputs || []) {
      const folder = jobOutputFolder(rel);
      const name = jobOutputName(rel);
      if (name.includes(".mask.")) continue;
      const key = `${folder}/${name}`;
      if (known.has(key)) continue;
      known.add(key);
      extras.push({ name, folder, url: jobOutputUrl(job, rel), kind: jobOutputKind(name), path: rel });
    }
  }
  return fromGlobal.concat(extras);
}

function jobsTouchingStem(targetStem) {
  return jobsCache.filter((j) => j.source_name && stem(j.source_name) === targetStem);
}

function preferredOutput(name) {
  const matches = latestOutputsFor(name);
  if (!matches.length) return null;
  if (manualOutputName) {
    const manual = matches.find((x) => x.name === manualOutputName);
    if (manual) return manual;
  }
  // If a recent terminal job for this source produced output, prefer its headline file
  const targetStem = stem(name);
  const recentJobs = jobsTouchingStem(targetStem).slice();
  // jobsCache is newest-first per /api/jobs ordering
  for (const job of recentJobs) {
    if (!TERMINAL_STATES.has(job.status)) continue;
    const rel = chooseFinalOutput(job);
    if (!rel) continue;
    const targetName = jobOutputName(rel);
    const targetFolder = jobOutputFolder(rel);
    const hit = matches.find((x) => x.name === targetName && x.folder === targetFolder)
      || matches.find((x) => x.name === targetName);
    if (hit) return hit;
  }
  const process = effectiveProcessKind();
  if (process === "cutout") return matches.find((x) => x.name.includes(".cutout.")) || matches[0];
  if (process === "chromakey") return matches.find((x) => x.name.includes(".chromakey.")) || matches[0];
  if (process === "upscale") return matches.find((x) => x.kind === "png" && !x.name.includes(".cutout.") && !x.name.includes(".chromakey.") && !x.name.includes(".preview.")) || matches[0];
  if (process === "vectorize") return matches.find((x) => x.kind === "svg") || matches[0];
  return matches.find((x) => x.kind === "svg") || matches.find((x) => x.name.includes(".cutout.")) || matches[0];
}

function makeViewportContent(kind, url, name) {
  return kind === "svg"
    ? `<div class="viewport-content svg-host" data-url="${url}" data-name="${name}"></div>`
    : `<div class="viewport-content"><img src="${url}" alt="${name}" draggable="false" /></div>`;
}

function readSvgViewBox(svg) {
  const attr = svg.getAttribute("viewBox");
  if (!attr) return null;
  const parts = attr.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { w: parts[2], h: parts[3] };
}

async function loadInlineSvg(host) {
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
function applyViewportState(vp) {
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
function drawRulers() {
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
function bindRulerGuides(rulersEl) {
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

function resetViewport(vp) {
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

function measureFit(vp) {
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

async function mountViewport(vp, kind, url, name, path) {
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

function clearViewport(vp, text) {
  vp.path = null;
  vp.url = null;
  vp.name = null;
  vp.kind = null;
  vp.el.className = "preview-frame empty-frame";
  vp.el.textContent = text;
}

function itemIsProcessed(name) {
  return latestOutputsFor(name).length > 0;
}

// Reconcile library state after work-items change: ensure selectedName still
// points at a real item (default to the first), then repaint the Library dock
// panel (self-guards if not mounted).
function refreshLibrary() {
  if (!workItems.length) selectedName = null;
  else if (!workItems.some((item) => item.name === selectedName)) selectedName = workItems[0].name;
  renderLibrary();   // dock panel (self-guards if not mounted)
  if (typeof renderProcessorPanel === "function") renderProcessorPanel();   // library selection drives the Processor target + contextual reveal/dim
  syncDockContext();
}

async function renderPreviews() {
  // editor.pinned = showing a blank/opened/Save-As'd doc that isn't tied to the
  // library; don't let a library-driven render clobber it. The selectedOutput
  // recompute lives inside this guard too: a pinned doc keeps the save target it
  // owns (null when unsaved, the canvas file after Save-As) instead of silently
  // adopting whatever preferredOutput(selectedName) resolves to.
  if (!editor.pinned) {
    selectedOutput = preferredOutput(selectedName);
    if (selectedOutput) {
      if (viewports.output.url !== selectedOutput.url) {
        try {
          await mountViewport(viewports.output, selectedOutput.kind, selectedOutput.url, selectedOutput.name, selectedOutput.path);
        } catch (error) {
          clearViewport(viewports.output, error.message);
        }
      }
    } else if (viewports.output.url !== null) {
      clearViewport(viewports.output, "Import or open a vector to start.");
    }
    if (outputLabelEl) {
      outputLabelEl.textContent = selectedOutput ? `Canvas — ${selectedOutput.name}` : "Canvas";
    }
    editor.sync();
    rememberLastDoc();
  }
}

async function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
  await refreshAll((data.files || []).at(-1) || null);
  setStatus(data.message, 2500);
}

async function fetchQueue() {
  return api("/api/work-items");
}

function applyQueueData(items, preferredSelection = null) {
  workItems = items;
  if (preferredSelection && workItems.some((item) => item.name === preferredSelection)) {
    selectedName = preferredSelection;
  }
  refreshLibrary();
}

async function fetchStatus() {
  return api("/api/status");
}

function applyStatusData(data) {
  workspace = data;
  outputsDir = workspace.outputs_dir || "";
}

async function fetchOutputs() {
  return api("/api/outputs");
}

function applyOutputsData(data) {
  outputs = data;
}

async function loadOutputs() {
  applyOutputsData(await fetchOutputs());
  refreshLibrary();
  await renderPreviews();
}

let lastBatchFailCount = -1;
let activityState = "idle"; // "idle" | "busy"
const knownJobStates = new Map();
const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
let jobsCache = [];

function stem_(n) { return n.replace(/\.[^.]+$/, ""); }

// Live progress in the chin: a bar that tracks the running job (determinate when
// the pipeline reports step/total, indeterminate otherwise), hidden when idle.
function updateFooterProgress(running, queuedCount) {
  const wrap = document.querySelector("#status-progress");
  const bar = document.querySelector("#status-progress-bar");
  const label = document.querySelector("#status-progress-label");
  if (!wrap || !bar || !label) return;
  if (!running) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const p = running.progress;
  const tail = queuedCount ? ` · ${queuedCount} queued` : "";
  if (p && p.total) {
    const pct = Math.max(0, Math.min(100, Math.round((p.step / p.total) * 100)));
    bar.style.width = pct + "%"; bar.classList.remove("indeterminate");
    label.textContent = `${p.step}/${p.total}${p.label ? " " + p.label : ""}${tail}`;
  } else {
    bar.style.width = "100%"; bar.classList.add("indeterminate");
    label.textContent = `working…${tail}`;
  }
}

async function fetchJobs() {
  return api("/api/jobs");
}

async function loadJobs() {
  return applyJobsData(await fetchJobs());
}

function applyJobsData(jobs) {
  jobsCache = jobs;
  let completionsHappened = false;
  const seen = new Set();
  const completedNow = [];
  for (const job of jobs) {
    seen.add(job.id);
    const prev = knownJobStates.get(job.id);
    if (prev !== job.status) {
      if (TERMINAL_STATES.has(job.status) && !TERMINAL_STATES.has(prev || "")) {
        completionsHappened = true;
        completedNow.push(job);
      }
      knownJobStates.set(job.id, job.status);
    }
  }
  for (const id of Array.from(knownJobStates.keys())) {
    if (!seen.has(id)) knownJobStates.delete(id);
  }

  renderJobsPanel();   // keep the dock Jobs panel live

  const running = jobs.find((job) => job.status === "running");
  updateFooterProgress(running, jobs.filter((j) => j.status === "queued").length);
  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const cancelledCount = jobs.filter((job) => job.status === "cancelled").length;
  activityState = running || queuedCount ? "busy" : "idle";

  if (running) {
    const line = (running.log_lines || []).slice(-1)[0] || running.status;
    const tail = queuedCount ? ` (${queuedCount} queued)` : "";
    const prog = running.progress && running.progress.total
      ? ` [${running.progress.step}/${running.progress.total}${running.progress.label ? " " + running.progress.label : ""}]`
      : "";
    setStatus(`${running.summary}${prog} | ${line}${tail}`);
    lastBatchFailCount = failedCount;
    return { completionsHappened, completedNow };
  }
  if (queuedCount) {
    setStatus(`${queuedCount} job(s) queued.`);
    lastBatchFailCount = failedCount;
    return { completionsHappened, completedNow };
  }
  if (!canReplaceStatus()) return { completionsHappened, completedNow };
  if (!jobs.length) {
    setStatus("Ready.");
    lastBatchFailCount = 0;
    return { completionsHappened, completedNow };
  }
  const latest = jobs[0];
  if (failedCount > 0 && failedCount !== lastBatchFailCount) {
    const note = cancelledCount ? `, ${cancelledCount} cancelled` : "";
    const failedJob = jobs.find((j) => j.status === "failed") || jobs[0];
    const stage = failedJob && failedJob.progress && failedJob.progress.label
      ? ` at ${failedJob.progress.label}`
      : "";
    const tail = ((failedJob && failedJob.log_lines) || []).slice(-1)[0] || "";
    const short = tail.length > 160 ? tail.slice(0, 157) + "…" : tail;
    setStatus(
      `Failed${stage}: ${short || `${failedCount} job(s) failed${note}.`} — click for Jobs.`,
      8000,
      { error: true, onClick: () => revealPanel("jobs"), title: tail }
    );
  } else if (failedCount === 0 && cancelledCount === 0) {
    setStatus(`Done. ${latest.summary}`);
  } else {
    setStatus(`${latest.summary} | ${latest.status}`);
  }
  lastBatchFailCount = failedCount;
  return { completionsHappened, completedNow };
}

async function refreshAll(preferredSelection = null) {
  const [statusData, queueData, outputsData, jobsData] = await Promise.all([
    fetchStatus(),
    fetchQueue(),
    fetchOutputs(),
    fetchJobs(),
  ]);
  applyStatusData(statusData);
  applyQueueData(queueData, preferredSelection);
  applyOutputsData(outputsData);
  applyJobsData(jobsData);
  refreshLibrary();
  await renderPreviews();
}

// Like refreshAll, but DOES NOT re-render the canvas preview. Background processing
// (a batch run, or any job starting) must never clear or replace the live editor
// document — the canvas only changes on explicit user action (open/load/place/view).
async function refreshExceptCanvas(preferredSelection = null) {
  const [statusData, queueData, outputsData, jobsData] = await Promise.all([
    fetchStatus(),
    fetchQueue(),
    fetchOutputs(),
    fetchJobs(),
  ]);
  applyStatusData(statusData);
  applyQueueData(queueData, preferredSelection);
  applyOutputsData(outputsData);
  applyJobsData(jobsData);
  refreshLibrary();
}

function bindViewportDragging(vp) {
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

Object.values(viewports).forEach(bindViewportDragging);

document.querySelectorAll("[data-vp]").forEach((button) => {
  button.addEventListener("click", () => {
    const vpName = button.dataset.vp;
    const vp = viewports[vpName];
    const action = button.dataset.action;
    if (action === "bg") { cycleBg(vpName); return; }
    if (!vp.el.querySelector(".viewport-content")) return;
    if (action === "zoom-in") vp.scale *= 1.2;
    if (action === "zoom-out") vp.scale /= 1.2;
    if (action === "fit") vp.scale = vp.fitScale || 1, vp.x = 0, vp.y = 0;
    if (action === "actual") vp.scale = 1, vp.x = 0, vp.y = 0;
    applyViewportState(vp);
    if (vp === viewports.output) editor.onViewportChanged();
  });
});

// A small floating text input that replaces window.prompt for in-app renames/saves
// (the browser prompt is ugly + blocking). Commits on Enter/blur, cancels on Escape.
function floatingInput({ value = "", placeholder = "", title = "", x, y, onCommit }) {
  document.querySelectorAll(".hv-float-input").forEach((e) => e.remove());
  const wrap = document.createElement("div"); wrap.className = "hv-float-input"; wrap.style.position = "fixed";
  wrap.style.left = Math.max(8, Math.min((x == null ? window.innerWidth / 2 - 130 : x), window.innerWidth - 268)) + "px";
  wrap.style.top = Math.max(8, (y == null ? Math.round(window.innerHeight / 3) : y)) + "px";
  if (title) { const t = document.createElement("div"); t.className = "hv-float-label"; t.textContent = title; wrap.appendChild(t); }
  const inp = document.createElement("input"); inp.type = "text"; inp.value = value; if (placeholder) inp.placeholder = placeholder;
  wrap.appendChild(inp); document.body.appendChild(wrap); inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => { if (done) return; done = true; const v = inp.value.trim(); wrap.remove(); if (commit && v) onCommit(v); };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
}

function openModal(title, narrow = false) {
  modalTitleEl.textContent = title;
  modalSearchEl.value = "";
  const win = modalRootEl.querySelector(".modal-window");
  if (win) win.classList.toggle("modal-narrow", !!narrow);
  modalRootEl.hidden = false;
  setTimeout(() => modalSearchEl.focus(), 0);
}

function closeModal() {
  modalRootEl.hidden = true;
  modalBodyEl.innerHTML = "";
  appSettingsOpen = false;
}

// A yes/no modal → resolves true (confirmed) or false (cancelled, incl. Esc / backdrop).
// Used where an action would otherwise degrade silently (e.g. a save falling back to
// non-portable linked refs) so the user actively chooses instead of being surprised.
function confirmDialog({ title = "Confirm", message = "", okLabel = "OK", cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const onKey = (e) => { if (e.key === "Escape" && !modalRootEl.hidden) finish(false); };
    function finish(val) {
      if (settled) return; settled = true;
      document.removeEventListener("keydown", onKey, true);
      closeModal(); resolve(val);
    }
    openModal(title, true);
    modalSearchEl.hidden = true;
    const root = document.createElement("div"); root.className = "form";
    const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.whiteSpace = "pre-line"; msg.textContent = message;
    root.appendChild(msg);
    const actions = document.createElement("div"); actions.className = "form-actions";
    const ok = ghostBtn(okLabel, () => finish(true)); ok.classList.add("primary-button");
    actions.appendChild(ghostBtn(cancelLabel, () => finish(false)));
    actions.appendChild(ok);
    root.appendChild(actions);
    modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
    // Capture-phase so this settles BEFORE the generic backdrop/Esc closers (which call
    // closeModal but wouldn't resolve the promise).
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => ok.focus(), 0);
  });
}

// The standalone Process VIEW was dissolved into dock panels (Library / Processor / Jobs)
// — the Edit canvas is the only view now. revealPanel un-collapses + scrolls a dock panel
// into view (used by the "click for Jobs" error toast).
function revealPanel(name) {
  const sec = document.querySelector(`.rail-section.${name}`);
  if (sec) { sec.classList.remove("collapsed"); sec.scrollIntoView({ block: "nearest" }); }
}

modalRootEl.addEventListener("click", (event) => {
  if (event.target.matches("[data-modal-close]") || event.target.closest("[data-modal-close]")) {
    closeModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalRootEl.hidden) closeModal();
});

// ---------- unified colour picker (Illustrator-style) ----------
// One modal for fill, stroke, artboard background and the toolstrip swatches.
// SV field + hue slider + alpha slider, with hex / RGB / HSB / A inputs and a
// new-vs-previous preview. Live-applies through onChange; OK commits, Cancel
// (or backdrop / Esc) reverts to the colour it opened with.
//   opts: { color, alpha=1, allowNone=false, title, onChange(hex|null, alpha), onCommit(hex|null, alpha) }
const CP_BASE_SWATCHES = ["#000000", "#ffffff", "#808080", "#e23b3b", "#f6a623", "#f8e71c", "#38b24a", "#2f7fe0", "#7d4fd0", "#e0529c"];
const CP_PIPETTE_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 1.8a1.7 1.7 0 0 1 2.4 2.4l-1.2 1.2 1 1-1.1 1.1-1-1-5 5L3 13l-1.8.6.6-1.8.5-1.6 5-5-1-1L7.4 4.2l1 1 1.1-1.1z" fill="currentColor"/></svg>`;
const CP_SWATCH_KEY = "hector-vector:swatches";
const CP_RECENT_KEY = "hector-vector:swatches-recent";
// Saved swatches can carry a name now; legacy entries are plain hex strings, so
// loadSwatches normalises both to { c, name? }. saveSwatches keeps the raw array.
function loadSwatches() { try { const a = JSON.parse(localStorage.getItem(CP_SWATCH_KEY)); return Array.isArray(a) ? a.map((x) => (typeof x === "string" ? { c: x } : x)).filter((x) => x && typeof x.c === "string") : []; } catch (_) { return []; } }
function saveSwatches(arr) { try { localStorage.setItem(CP_SWATCH_KEY, JSON.stringify(arr.slice(0, 24))); } catch (_) {} }
function loadRecent() { try { const a = JSON.parse(localStorage.getItem(CP_RECENT_KEY)); return Array.isArray(a) ? a.filter((c) => typeof c === "string") : []; } catch (_) { return []; } }
function pushRecent(hex) { try { const u = loadRecent().filter((x) => x.toLowerCase() !== hex.toLowerCase()); u.unshift(hex); localStorage.setItem(CP_RECENT_KEY, JSON.stringify(u.slice(0, 12))); } catch (_) {} }
let _activeColorPicker = null;
function openColorPicker(opts) {
  if (_activeColorPicker) _activeColorPicker.cancel();
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const startHex = hv.toHexColor(opts.color) || (opts.allowNone && (!opts.color || opts.color === "none") ? null : "#000000");
  const startAlpha = opts.alpha == null ? 1 : clamp01(opts.alpha);
  // working state in HSV (+ a) so dragging the field doesn't drift the hue at S/V=0
  const seed = hv.hexToRgb(startHex || "#000000") || { r: 0, g: 0, b: 0 };
  // Duo (Illustrator primary/secondary): when opened from the toolstrip swatches the
  // picker edits BOTH fill + stroke — the side shows the two targets, click or press X
  // to switch which one the field edits, Shift+X swaps them. Single-target callers
  // (artboard bg, etc.) omit `duo` and get a solo live preview.
  const duo = opts.duo || null;
  const mkState = (color, alpha) => {
    const hex0 = hv.toHexColor(color) || (color === "none" || color == null ? null : "#000000");
    const s = hv.hexToRgb(hex0 || "#000000") || { r: 0, g: 0, b: 0 };
    return Object.assign({ a: alpha == null ? 1 : clamp01(alpha), none: hex0 === null }, hv.rgbToHsv(s.r, s.g, s.b));
  };
  const targets = duo ? { fill: mkState(duo.fill.color, duo.fill.alpha), stroke: mkState(duo.stroke.color, duo.stroke.alpha) } : null;
  const orig = duo ? { fill: { color: duo.fill.color, alpha: duo.fill.alpha }, stroke: { color: duo.stroke.color, alpha: duo.stroke.alpha } } : null;
  let active = duo ? (duo.active === "stroke" ? "stroke" : "fill") : null;
  const st = duo ? Object.assign({}, targets[active]) : Object.assign({ a: startAlpha, none: startHex === null }, hv.rgbToHsv(seed.r, seed.g, seed.b));

  const back = document.createElement("div"); back.className = "cp-backdrop";
  const win = document.createElement("div"); win.className = "cp-window";
  back.appendChild(win);
  win.innerHTML = `
    <div class="cp-head"><span>${opts.title || "Colour"}</span></div>
    <div class="cp-body">
      <div class="cp-field" tabindex="-1"><div class="cp-field-sat"></div><div class="cp-field-val"></div><div class="cp-field-thumb"></div></div>
      <div class="cp-hue"><div class="cp-hue-thumb"></div></div>
      <div class="cp-side"></div>
    </div>
    <div class="cp-alpha"><div class="cp-alpha-track"></div><div class="cp-alpha-thumb"></div></div>
    <div class="cp-models">
      <div class="cp-tabs" role="tablist">
        <button type="button" class="cp-tab" data-m="rgb">RGB</button>
        <button type="button" class="cp-tab" data-m="hsl">HSL</button>
        <button type="button" class="cp-tab" data-m="hsb">HSB</button>
      </div>
      <div class="cp-fields">
        <label class="cp-inp cp-hex">#<input data-k="hex" maxlength="7" /></label>
        <div class="cp-triple"></div>
        <label class="cp-inp cp-alpha-num">A<input data-k="a" type="number" min="0" max="100" /></label>
      </div>
    </div>
    <div class="cp-swatches"></div>
    <div class="cp-actions">
      ${opts.allowNone ? `<button type="button" class="ghost-button cp-none">None</button>` : ""}
      <span class="cp-spacer"></span>
      ${opts.host ? "" : `<button type="button" class="ghost-button cp-cancel">Cancel</button><button type="button" class="ghost-button cp-ok">OK</button>`}
    </div>
    <div class="cp-recent cp-chin" hidden><div class="cp-recent-row"></div></div>`;
  // Embedded (host) mode = a live, persistent panel editor (no backdrop / OK / Cancel);
  // otherwise the classic transactional floating picker.
  const host = opts.host || null;
  if (host) { win.classList.add("cp-embedded"); host.innerHTML = ""; host.appendChild(win); }
  else document.body.appendChild(back);

  const $ = (s) => win.querySelector(s);
  const field = $(".cp-field"), fieldSat = $(".cp-field-sat"), fieldThumb = $(".cp-field-thumb");
  const hue = $(".cp-hue"), hueThumb = $(".cp-hue-thumb");
  const alphaEl = $(".cp-alpha"), alphaTrack = $(".cp-alpha-track"), alphaThumb = $(".cp-alpha-thumb");
  const side = $(".cp-side");
  const curHex = () => { const c = hv.hsvToRgb(st.h, st.s, st.v); return hv.rgbToHex(c.r, c.g, c.b); };
  const stHexOf = (t) => { const c = hv.hsvToRgb(t.h, t.s, t.v); return hv.rgbToHex(c.r, c.g, c.b); };
  const checker = "repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 50% / 12px 12px";

  // Colour-model tabs (RGB / HSL / HSB): the hex + alpha fields are persistent; the
  // middle triple is rebuilt per model. The working colour stays in HSV, so each model
  // just reads/writes that. The active model is remembered across pickers.
  const CP_MODEL_KEY = "hector-vector:cp-model";
  const MODELS = {
    rgb: { fields: [["r", "R", 255], ["g", "G", 255], ["b", "B", 255]],
      read: () => { const c = hv.hsvToRgb(st.h, st.s, st.v); return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }; },
      write: (v) => Object.assign(st, hv.rgbToHsv(v.r, v.g, v.b)) },
    hsl: { fields: [["h", "H", 360], ["s", "S", 100], ["l", "L", 100]],
      read: () => { const c = hv.hsvToRgb(st.h, st.s, st.v), x = hv.rgbToHsl(c.r, c.g, c.b); return { h: Math.round(x.h), s: Math.round(x.s), l: Math.round(x.l) }; },
      write: (v) => { const c = hv.hslToRgb(v.h, v.s, v.l); Object.assign(st, hv.rgbToHsv(c.r, c.g, c.b)); } },
    hsb: { fields: [["h", "H", 360], ["s", "S", 100], ["v", "B", 100]],
      read: () => ({ h: Math.round(st.h), s: Math.round(st.s), v: Math.round(st.v) }),
      write: (v) => { st.h = v.h; st.s = v.s; st.v = v.v; } },
  };
  let model = "rgb"; try { const m = localStorage.getItem(CP_MODEL_KEY); if (m && MODELS[m]) model = m; } catch {}
  const hexInput = $('.cp-fields input[data-k="hex"]'), aInput = $('.cp-fields input[data-k="a"]');
  const tripleBox = $(".cp-triple");
  let triple = {};   // current model's data-k → input element
  // Drag the field's letter label to scrub its value (an "invisible slider"); click the
  // input itself to type. Hex is never scrubbed.
  function bindScrubLabel(lab, input) {
    if (!lab || !input || input.dataset.k === "hex") return;
    lab.addEventListener("pointerdown", (e) => {
      if (e.target === input || e.button !== 0) return;
      e.preventDefault(); lab.setPointerCapture(e.pointerId);
      const sx = e.clientX, start = parseFloat(input.value) || 0; let moved = false;
      const mv = (ev) => { const dx = ev.clientX - sx; if (!moved && Math.abs(dx) < 3) return; moved = true;
        input.value = String(start + Math.round(dx / 4)); input.dispatchEvent(new Event("input", { bubbles: true })); };
      const up = () => { lab.removeEventListener("pointermove", mv); lab.removeEventListener("pointerup", up); };
      lab.addEventListener("pointermove", mv); lab.addEventListener("pointerup", up);
    });
  }
  function onTriple() {
    const m = MODELS[model], v = {};
    for (const [k, , max] of m.fields) v[k] = Math.max(0, Math.min(max, parseFloat(triple[k].value) || 0));
    m.write(v); changed();
  }
  function buildTriple() {
    tripleBox.innerHTML = ""; triple = {};
    for (const [k, lab, max] of MODELS[model].fields) {
      const l = document.createElement("label"); l.className = "cp-inp";
      const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.max = String(max); inp.dataset.k = k;
      l.append(document.createTextNode(lab), inp); tripleBox.appendChild(l); triple[k] = inp;
      inp.addEventListener("input", onTriple); bindScrubLabel(l, inp);
    }
    win.querySelectorAll(".cp-tab").forEach((t) => t.classList.toggle("active", t.dataset.m === model));
  }
  function paintFields() {
    hexInput.value = curHex().slice(1);
    aInput.value = Math.round(st.a * 100);
    const vals = MODELS[model].read();
    for (const [k] of MODELS[model].fields) if (triple[k]) triple[k].value = vals[k];
  }
  function paint() {
    const hex = curHex();
    const hueHex = (() => { const c = hv.hsvToRgb(st.h, 100, 100); return hv.rgbToHex(c.r, c.g, c.b); })();
    fieldSat.parentElement.style.background = hueHex;
    fieldThumb.style.left = st.s + "%"; fieldThumb.style.top = (100 - st.v) + "%";
    fieldThumb.style.background = hex;
    hueThumb.style.top = (st.h / 360 * 100) + "%";
    alphaTrack.style.background = `linear-gradient(to right, transparent, ${hex}), ${checker}`;
    alphaThumb.style.left = (st.a * 100) + "%";
    paintFields();
    win.classList.toggle("cp-is-none", st.none);
  }
  // --- fill/stroke side (duo) or a solo live preview (single) ---
  const chipBg = (none, hex, a) => {
    if (none) return checker;
    const rgb = hv.hexToRgb(hex);
    return a < 1 ? `linear-gradient(rgba(${rgb.r},${rgb.g},${rgb.b},${a}),rgba(${rgb.r},${rgb.g},${rgb.b},${a})), ${checker}` : hex;
  };
  let sideEls = null;
  function buildSide() {
    side.innerHTML = ""; side.classList.toggle("duo", !!duo);
    if (duo) {
      const mk = (which, label) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "cp-target"; b.dataset.which = which;
        b.title = `${label} — click or press X to edit${which === "fill" ? " · Shift+X swaps" : ""}`;
        const lab = document.createElement("span"); lab.className = "cp-target-lab"; lab.textContent = label; b.appendChild(lab);
        b.addEventListener("click", () => switchTo(which));
        return b;
      };
      const f = mk("fill", "Fill"), s = mk("stroke", "Stroke");
      side.append(f, s); sideEls = { fill: f, stroke: s };
    } else {
      const solo = document.createElement("div"); solo.className = "cp-target solo"; side.appendChild(solo); sideEls = { solo };
    }
  }
  function paintSide() {
    if (!sideEls) return;
    if (duo) {
      sideEls.fill.style.background = chipBg(targets.fill.none, stHexOf(targets.fill), targets.fill.a);
      sideEls.stroke.style.background = chipBg(targets.stroke.none, stHexOf(targets.stroke), targets.stroke.a);
      sideEls.fill.classList.toggle("active", active === "fill");
      sideEls.stroke.classList.toggle("active", active === "stroke");
    } else {
      sideEls.solo.style.background = chipBg(st.none, curHex(), st.a);
    }
  }
  function emit() {
    const hex = st.none ? null : curHex();
    if (duo) { targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v }; duo.apply(active, hex, st.a); }
    else if (opts.onChange) opts.onChange(hex, st.a);
    paintSide();
    if (typeof recordRecent === "function") recordRecent();   // settle the colour into recents (debounced)
  }
  function changed() { st.none = false; paint(); emit(); }
  // Switch which target the field edits — pure focus change, no colour applied (so it
  // never reads as an undo). Save the live edit back into the outgoing target first.
  function switchTo(which) {
    if (!duo || which === active) return;
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    active = which; Object.assign(st, targets[which]); paint(); paintSide();
  }
  function swapTargets() {
    if (!duo) return;
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    const f = targets.fill; targets.fill = targets.stroke; targets.stroke = f;
    Object.assign(st, targets[active]);
    duo.apply("fill", targets.fill.none ? null : stHexOf(targets.fill), targets.fill.a);
    duo.apply("stroke", targets.stroke.none ? null : stHexOf(targets.stroke), targets.stroke.a);
    paint(); paintSide();
  }
  buildSide();

  // --- drag helpers ---
  function bindDrag(el, onMove) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      const go = (ev) => onMove(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
      go(e);
      const mv = (ev) => go(ev);
      const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
    });
  }
  bindDrag(field, (x, y, w, h) => { st.s = clamp01(x / w) * 100; st.v = (1 - clamp01(y / h)) * 100; changed(); });
  bindDrag(hue, (x, y, w, h) => { st.h = clamp01(y / h) * 360; changed(); });
  bindDrag(alphaEl, (x, y, w) => { st.a = clamp01(x / w); paint(); emit(); });

  // --- hex + alpha inputs, model tabs (the per-model triple is wired in buildTriple) ---
  const setFromRgb = (r, g, b) => { Object.assign(st, hv.rgbToHsv(r, g, b)); };
  hexInput.addEventListener("input", () => { const rgb = hv.hexToRgb(hexInput.value); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } });
  aInput.addEventListener("input", () => { st.a = clamp01((+aInput.value || 0) / 100); paint(); emit(); });
  bindScrubLabel(aInput.closest(".cp-inp"), aInput);
  win.querySelectorAll(".cp-tab").forEach((t) => t.addEventListener("click", () => {
    model = t.dataset.m; try { localStorage.setItem(CP_MODEL_KEY, model); } catch {}
    buildTriple(); paintFields();
  }));
  buildTriple();

  // --- eyedropper + swatches row. Eyedropper (native EyeDropper API) is the first,
  // clearly-bordered item so it's unmistakable; it samples the screen into the active
  // target. Then the fixed base palette + a persistent user palette (localStorage):
  // click applies, "+" saves the current colour, right-click removes a saved one.
  const sw = $(".cp-swatches");
  const recentWrap = $(".cp-recent"), recentRow = $(".cp-recent-row");
  const applyHex = (c) => { const rgb = hv.hexToRgb(c); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } };
  const mkSw = (c, name) => { const b = document.createElement("button"); b.type = "button"; b.className = "cp-sw"; b.style.background = c; b.title = name ? `${name} (${c})` : c; b.addEventListener("click", () => applyHex(c)); return b; };
  // Recently-used colours (auto-tracked, separate from the saved palette).
  function renderRecent() {
    const rec = loadRecent(); recentWrap.hidden = rec.length === 0; recentRow.innerHTML = "";
    rec.forEach((c) => recentRow.appendChild(mkSw(c)));
  }
  // Eyedropper + base palette + saved (nameable) swatches. Right-click a saved swatch
  // for Rename / Remove; "+" saves the current colour.
  const renderSwatches = () => {
    sw.innerHTML = "";
    if (window.EyeDropper) {
      const eye = document.createElement("button");
      eye.type = "button"; eye.className = "cp-sw cp-eyedrop"; eye.innerHTML = CP_PIPETTE_SVG;
      eye.title = "Eyedropper — pick a colour from the screen"; eye.setAttribute("aria-label", "Eyedropper");
      eye.addEventListener("click", async () => {
        try { const res = await new window.EyeDropper().open(); const rgb = hv.hexToRgb(res.sRGBHex); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } }
        catch (_) { /* user pressed Esc — ignore */ }
      });
      sw.appendChild(eye);
    }
    CP_BASE_SWATCHES.forEach((c) => sw.appendChild(mkSw(c)));
    loadSwatches().forEach((it) => {
      const b = mkSw(it.c, it.name);
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Rename…", onClick: () => floatingInput({ title: "Swatch name", value: it.name || "", onCommit: (n) => { const arr = loadSwatches(); const m = arr.find((x) => x.c === it.c); if (m) { m.name = n || undefined; saveSwatches(arr); renderSwatches(); } } }) },
          { label: "Remove", onClick: () => { saveSwatches(loadSwatches().filter((x) => x.c !== it.c)); renderSwatches(); } },
        ]);
      });
      sw.appendChild(b);
    });
    const add = document.createElement("button"); add.type = "button"; add.className = "cp-sw cp-sw-add"; add.textContent = "+"; add.title = "Save current colour";
    add.addEventListener("click", () => { const hex = curHex(); const u = loadSwatches().filter((x) => x.c.toLowerCase() !== hex.toLowerCase()); u.unshift({ c: hex }); saveSwatches(u); renderSwatches(); });
    sw.appendChild(add);
  };
  renderSwatches(); renderRecent();
  // Record a settled colour into recents (debounced so live dragging doesn't spam it).
  let recentT = null;
  const recordRecent = () => { clearTimeout(recentT); recentT = setTimeout(() => { if (!st.none) { pushRecent(curHex()); renderRecent(); } }, 700); };

  // --- actions ---
  const close = () => { if (host) { win.remove(); } else { back.remove(); _activeColorPicker = null; } document.removeEventListener("keydown", onKey, true); };
  const ok = () => { if (opts.onCommit) opts.onCommit(st.none ? null : curHex(), st.a); close(); };
  const cancel = () => {
    if (duo) { duo.apply("fill", hv.toHexColor(orig.fill.color) || null, orig.fill.alpha); duo.apply("stroke", hv.toHexColor(orig.stroke.color) || null, orig.stroke.alpha); }
    else if (opts.onChange) opts.onChange(startHex, startAlpha);
    if (opts.onCancel) opts.onCancel(); close();
  };
  if ($(".cp-ok")) $(".cp-ok").addEventListener("click", ok);
  if ($(".cp-cancel")) $(".cp-cancel").addEventListener("click", cancel);
  if (opts.allowNone && $(".cp-none")) $(".cp-none").addEventListener("click", () => { st.none = true; paint(); emit(); });
  if (!host) {
    back.addEventListener("pointerdown", (e) => { if (e.target === back) cancel(); });
    // Movable picker: drag it by the header (the backdrop no longer dims the canvas).
    const head = $(".cp-head"); if (head) {
      head.style.cursor = "move"; head.style.touchAction = "none";
      head.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const r = win.getBoundingClientRect();
        win.style.position = "fixed"; win.style.margin = "0"; win.style.left = r.left + "px"; win.style.top = r.top + "px";
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        try { head.setPointerCapture(e.pointerId); } catch {}
        const mv = (ev) => { win.style.left = Math.max(2, Math.min(ev.clientX - ox, window.innerWidth - 60)) + "px"; win.style.top = Math.max(2, Math.min(ev.clientY - oy, window.innerHeight - 30)) + "px"; };
        const up = () => { head.removeEventListener("pointermove", mv); head.removeEventListener("pointerup", up); };
        head.addEventListener("pointermove", mv); head.addEventListener("pointerup", up);
      });
    }
  }
  const onKey = (e) => {
    // Panel mode: only claim X/Shift+X (duo target toggle/swap) — even when a field is
    // focused — and let everything else through (no Esc/Enter commit in a panel).
    if (host) { if (duo && (e.key === "x" || e.key === "X")) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) swapTargets(); else switchTo(active === "fill" ? "stroke" : "fill"); } return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
    // X toggles fill/stroke, Shift+X swaps — intercepted even while a field is focused
    // (x isn't a meaningful hex/number char, so it's safe to claim it for the toggle).
    else if (duo && (e.key === "x" || e.key === "X")) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) swapTargets(); else switchTo(active === "fill" ? "stroke" : "fill");
    }
  };
  document.addEventListener("keydown", onKey, true);
  if (!host) _activeColorPicker = { cancel };

  paint(); paintSide();
  if (!host) setTimeout(() => inputs.hex.focus(), 0);
  return { destroy: close, switchTo, swapTargets };   // controller (host/panel mode uses this)
}

// Compact icon action-row shared by both gallery grids (Open/Place modal and the
// Process workspace). Icons (not text) so five actions fit a ~130px cell without
// overflowing — the old text buttons widened the track and clipped on the right.
function galleryActionRow({ name, absPath, url, onInfo }) {
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
    mk("⊞", "Reveal in file manager", () => revealInFileManager(absPath));
  }
  if (url) mk("↗", "Open in a new tab", () => window.open(url, "_blank", "noopener"));
  return actions;
}

// Load a raster into the editor viewport as an <image> node (coexists with vectors).
// Reads natural pixel size first so the node fits + centres correctly.
async function loadRasterToCanvas(item) {
  if (!item) return;
  try {
    const dim = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => rej(new Error(`Couldn't load ${item.name}`));
      im.src = item.url;
    });
    editor.placeImage(item.url, item.name, dim.w, dim.h);
  } catch (e) { setStatus(e.message, 3000); }
}

function renderGalleryGrid(items, onPick) {
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
    thumb.innerHTML = `<div class="gallery-thumb"><img src="${item.url}" alt="${item.name}" loading="lazy" decoding="async" /></div>`;
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

async function revealInFileManager(absPath) {
  if (!absPath) return;
  try {
    const data = await api("/api/reveal", "POST", { path: absPath });
    setStatus(data.message || "Opened folder.", 1500);
  } catch (e) {
    setStatus(`Reveal failed: ${e.message}`, 3000);
  }
}

async function copySvgSource() {
  let text = editor.serialize() ||
    (viewports.output.url ? await (await fetch(viewports.output.url)).text() : "");
  if (!text) return;
  text = await inlineSvgImages(text);   // bake placed-raster hrefs → data URIs so the copy is self-contained
  await copyToClipboard(text, `SVG (${text.length} chars)`);
}

// Save bytes straight to the user's machine via a synthetic download link — the
// escape hatch from the server outputs folder (works on any canvas, saved or not).
function downloadBlob(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadCurrentSvg() {
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  let text = editor.serialize();
  if (!text) { setStatus("Nothing to download.", 2500); return; }
  text = await inlineSvgImages(text);   // bake placed-raster hrefs → data URIs so the .svg is portable off-machine
  const name = (defaultSaveName() || "untitled") + ".svg";
  downloadBlob(name, text, "image/svg+xml");
  setStatus(`Downloaded ${name}.`, 2000);
}

// Open an .svg straight from disk (browser file picker) — untracked, so Save → Save-As.
function openFromFile() {
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
      selectedName = null; manualOutputName = null;
      mountStageFromText(text, file.name);
      selectedOutput = null;            // disk-opened doc has no server target → Save = Save-As
      rememberLastDoc();
      setStatus(`Opened ${file.name}.`, 2000);
    };
    reader.onerror = () => setStatus("Could not read that file.", 3000);
    reader.readAsText(file);
  };
  inp.click();
}

function revealCurrentFile() {
  if (selectedOutput && selectedOutput.path) return revealInFileManager(selectedOutput.path);
  setStatus("Save the document first — only saved files can be revealed.", 3000);
}


// ---------- document menu actions ----------
function mountStageFromText(text, name) {
  hideContextMenu();  // drop any open style panel referencing the outgoing document
  editor.dispose();   // release the previous document (undo snapshots, listeners) before swapping
  const vp = viewports.output;
  vp.url = "mem:" + name; vp.name = name; vp.kind = "svg"; vp.path = null;
  vp.el.className = "preview-frame";
  vp.el.innerHTML = `<div class="checker viewport-shell"><div class="viewport-content svg-host"></div></div>`;
  applyBgMode("output");
  const host = vp.el.querySelector(".svg-host");
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = document.importNode(doc.documentElement, true);
  const vbAttr = svg.getAttribute("viewBox");
  if (vbAttr) { const p = vbAttr.trim().split(/[\s,]+/).map(Number); if (p.length === 4) { svg.setAttribute("width", p[2]); svg.setAttribute("height", p[3]); } }
  svg.classList.add("inline-svg");
  host.appendChild(svg);
  editor.pinned = true;
  if (outputLabelEl) outputLabelEl.textContent = `Canvas — ${name}`;
  requestAnimationFrame(() => { measureFit(vp); editor.sync(); });
}

// Mount a fresh white artboard with no save target (Save → Save-As).
function mountBlankCanvas(W = 512, H = 512) {
  selectedOutput = null; manualOutputName = null;
  const txt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect class="hv-artboard" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/></svg>`;
  mountStageFromText(txt, `untitled-${W}x${H}.svg`);
}

function newBlankDoc() {
  openModal("New canvas", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Artboard size"));
  const wInp = makeNumberRaw(512, () => {});
  const hInp = makeNumberRaw(512, () => {});
  root.appendChild(fieldRow("Width", wInp));
  root.appendChild(fieldRow("Height", hInp));
  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Create", () => {
    const W = Math.max(1, parseInt(wInp.value, 10) || 512), H = Math.max(1, parseInt(hInp.value, 10) || 512);
    closeModal();
    mountBlankCanvas(W, H);
    setStatus(`New ${W}×${H} canvas.`, 2000);
  }));
  root.appendChild(actions);
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
}

async function loadSvgToStage(url, name, output = null) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    selectedName = null; manualOutputName = null;
    mountStageFromText(text, name);   // pinned = true; the recompute guard then keeps selectedOutput as set below
    // A re-opened canvas file keeps its save target so Save overwrites it in place;
    // any other standalone vector opens untracked (Save → Save-As).
    selectedOutput = output;
    rememberLastDoc();
    setStatus(`Opened ${name}.`, 2000);
  } catch (e) { setStatus(`Open failed: ${e.message}`, 3000); }
}

function openOpenModal() {
  const svgs = outputs.filter((o) => o.kind === "svg");
  openModal(`Open — ${svgs.length} vector(s)`);
  const items = svgs.map((o) => ({ name: o.name, url: o.url, kind: "svg", folder: o.folder, path: o.path, active: false }));
  const apply = () => {
    const q = modalSearchEl.value.trim().toLowerCase();
    const vis = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    renderGalleryGrid(vis, (picked) => {
      closeModal();
      const wi = workItems.find((w) => stem(w.name) === stem(picked.name));
      if (wi) { editor.pinned = false; selectedName = wi.name; manualOutputName = picked.name; refreshLibrary(); refreshAll(); }
      else {
        const out = picked.folder === "canvas"
          ? { name: picked.name, folder: picked.folder, url: picked.url, kind: "svg", path: picked.path }
          : null;
        loadSvgToStage(picked.url, picked.name, out);
      }
    });
  };
  modalSearchEl.oninput = apply;
  apply();
}

async function placeFromUrl(url, name) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    editor.placeSvgMarkup(await res.text(), name);
  } catch (e) { setStatus(`Place failed: ${e.message}`, 3000); }
}

// Place / merge another vector into the current canvas (vs Open, which replaces).
function openPlaceModal() {
  if (!editor.stage) { setStatus("Open or create a canvas first, then place into it.", 3500); return; }
  const svgs = outputs.filter((o) => o.kind === "svg");
  openModal(`Place into canvas — ${svgs.length} vector(s)`);
  const items = svgs.map((o) => ({ name: o.name, url: o.url, kind: "svg", folder: o.folder, path: o.path, active: false }));
  const apply = () => {
    const q = modalSearchEl.value.trim().toLowerCase();
    const vis = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    renderGalleryGrid(vis, (picked) => { closeModal(); placeFromUrl(picked.url, picked.name); });
  };
  modalSearchEl.oninput = apply;
  apply();
}

// Save routing. Library docs (imported sources) save through editor.save(), which
// writes a sibling `.edited.svg`. New blank / opened / canvas docs have no source
// folder, so they go through Save-As → the `canvas/` outputs folder, after which
// re-saving overwrites that file in place.
async function saveDocument() {
  if (!editor.stage) return;
  if (selectedOutput && selectedOutput.folder === "canvas") return saveCanvasInPlace();
  if (selectedOutput) return editor.save();
  return saveAsDocument();
}

async function saveCanvasInPlace() {
  try {
    // Self-contained: bake raster hrefs → data URIs (the live editor keeps its server
    // hrefs — only the saved bytes are inlined; falls back to linked if too large).
    const svg = await serializeForSave(); if (!svg) return;
    const data = await api("/api/save-svg-as", "POST", { name: selectedOutput.name, svg, overwrite: true });
    applySavedCanvas(data);
    setStatus(data.message || "Saved.", 2500);
  } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
}

function defaultSaveName() {
  const n = viewports.output.name || (selectedOutput && selectedOutput.name) || "untitled.svg";
  return stem_(n).replace(/\.edited$/, "");
}

function saveAsDocument(onDone) {
  if (!editor.stage) { setStatus("Open or create a canvas first, then save it.", 3000); return; }
  openModal("Save as", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Save vector"));
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = defaultSaveName(); inp.placeholder = "filename";
  root.appendChild(fieldRow("Name", inp, "Saved as .svg in the canvas folder."));
  const doSave = async () => {
    const name = inp.value.trim(); if (!name) { inp.focus(); return; }
    closeModal();
    try {
      const svg = await serializeForSave(); if (!svg) return;   // self-contained .svg (bake rasters; linked fallback if too large)
      const data = await api("/api/save-svg-as", "POST", { name, svg });
      applySavedCanvas(data);
      setStatus(data.message || "Saved.", 2500);
      if (typeof onDone === "function") onDone();
    } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
  };
  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Save", doSave));
  root.appendChild(actions);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

// ---------- .hv projects (Canvas tab): full document = markup + undo/redo history ----------
function saveProject() {
  if (!editor.stage) { setStatus("Open or create a canvas first, then save the project.", 3000); return; }
  openModal("Save project", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Save project (.hv)"));
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = defaultSaveName().replace(/\.svg$/i, ""); inp.placeholder = "project name";
  root.appendChild(fieldRow("Name", inp, "Saves the canvas + undo history as .hv in the canvas folder."));
  const doSave = async () => {
    const name = inp.value.trim(); if (!name) { inp.focus(); return; }
    closeModal();
    // .hv is the in-app WORKING format (markup + full undo history) — kept linked to
    // /work-items|/outputs, not baked: it lives alongside them and stays small + lets the
    // rasters re-process trivially. The deliverable .svg (Download / Save) is the portable one.
    const svg = editor._historyMarkup ? editor._historyMarkup() : editor.serialize();
    if (!svg) return;
    try {
      const data = await api("/api/save-hv", "POST", { name, svg, history: editor.history || [], redo: editor.redo || [] });
      setStatus(data.message || "Project saved.", 2500);
      await loadProjects();
    } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
  };
  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Save", doSave));
  root.appendChild(actions);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

async function openProject(item) {
  let data;
  try { data = await (await fetch(item.url)).json(); }
  catch (e) { setStatus(`Couldn't open ${item.name}: ${e.message}`, 3500); return; }
  if (!data || typeof data.svg !== "string" || !/<svg[\s>]/i.test(data.svg)) { setStatus("That .hv project is invalid.", 3000); return; }
  selectedName = null; manualOutputName = null; selectedOutput = null;
  mountStageFromText(data.svg, item.name);
  // mountStageFromText syncs (→ editor.adopt, which RESETS history) inside a rAF; restore
  // the saved stacks on the following frame so they survive the adopt.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    editor.history = Array.isArray(data.history) ? data.history : [];
    editor.redo = Array.isArray(data.redo) ? data.redo : [];
    if (editor._renderHistory) editor._renderHistory();
    if (editor._updateButtons) editor._updateButtons();
  }));
  setStatus(`Opened project ${item.name}.`, 2000);
}

async function loadProjects() {
  try { projects = await api("/api/projects"); } catch { projects = []; }
  renderLibrary();
}

// A freshly Save-As'd canvas becomes a tracked-but-pinned doc: it owns a concrete
// selectedOutput (so Export + plain Save work) without being a library item, and
// stays mounted from memory (no disk remount that would drop the editor state).
function applySavedCanvas(data) {
  editor.pinned = true;
  selectedName = null; manualOutputName = null;
  selectedOutput = {
    name: data.name, folder: data.folder,
    url: `/outputs/${encodeURIComponent(data.folder)}/${encodeURIComponent(data.name)}`,
    kind: "svg", path: data.output,
  };
  viewports.output.name = data.name;
  if (outputLabelEl) outputLabelEl.textContent = `Canvas — ${data.name}`;
  rememberLastDoc();
  refreshAll();
}

function exportFlow() {
  // Export renders the LIVE canvas in the browser (no save/round-trip needed), so an
  // unsaved doc can export straight to a download. A save target is only needed to ALSO
  // drop the PNG in the library (offered as a secondary action in the result step).
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  openExportModal();
}

// PWA install prompt is captured lazily (beforeinstallprompt) and surfaced in the
// general Settings modal (with live install-availability detection).
let pwaInstallPrompt = null;
async function installPwa() {
  if (!pwaInstallPrompt) return;
  const p = pwaInstallPrompt; pwaInstallPrompt = null;
  p.prompt();
  try { await p.userChoice; } catch {}
  if (appSettingsOpen) openAppSettings();   // refresh the Install row
}
function isInstalledApp() {
  try {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || window.navigator.standalone === true
      || document.querySelector(".app.editor")?.classList.contains("app-window");
  } catch { return false; }
}

// Version comes from the server (/api/version, backed by the repo VERSION file) so
// there's a single source of truth shared with releases. Cached after first fetch.
let versionInfo = { version: "…", isGit: false, commit: "", branch: "", dirty: false };
async function loadVersion() {
  try { versionInfo = { ...versionInfo, ...(await api("/api/version")) }; } catch {}
  return versionInfo;
}
// General app settings: preferences that don't belong to the pipeline, plus the
// install affordance and an About section. (The per-process backend "Settings"
// form lives in the Process workspace.)
let appSettingsOpen = false;
function prefToggleRow(label, checked, onChange, hint) {
  const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return fieldRow(label, inp, hint);
}
// Point the library at a different source folder. Re-fetches the whole workspace
// (refreshAll → fetchStatus → applyStatusData updates `workspace`), so the Settings
// section and the gallery both reflect the new source.
async function setSourceDir(next) {
  next = (next || "").trim();
  try {
    const data = await api("/api/source", "POST", { path: next });
    setStatus(data.message || "Source updated.", 2500);
    await refreshAll();
  } catch (error) { setStatus(error.message, 4000); }
}

// Install / configuration is consolidated in Settings → "AI models & tools". Stages never
// install inline; they point here so install prompts don't pop up scattered around the UI.
function openToolsSettings() { openAppSettings({ focus: "tools" }); }
function installJobActive(kind) { return jobsCache.some((j) => j.kind === kind && (j.status === "running" || j.status === "queued")); }

function openAppSettings(opts = {}) {
  openModal("Settings", true);
  modalSearchEl.hidden = true;
  appSettingsOpen = true;
  const root = document.createElement("div"); root.className = "form";

  root.appendChild(sectionTitle("General"));
  root.appendChild(fieldRow("On launch",
    makeSelectRaw(prefs.startup, [["blank", "Blank canvas"], ["resume", "Resume last document"]],
      (v) => { prefs.startup = v; persistPrefs(); }),
    "What to show when the app opens. Blank starts fresh with an empty canvas."));
  root.appendChild(prefToggleRow("Smart guides", editor.smartGuides,
    (v) => { editor.smartGuides = v; prefs.smartGuides = v; persistPrefs(); }, "Snap to other objects' edges/centres while moving."));

  // Where the library reads source images from (the backend /api/source endpoint).
  root.appendChild(sectionTitle("Library source"));
  const srcInput = document.createElement("input");
  srcInput.type = "text"; srcInput.value = (workspace && workspace.source_dir) || "";
  srcInput.placeholder = "/absolute/path/to/folder";
  const isDefaultSrc = !!(workspace && workspace.source_dir === workspace.default_source_dir);
  root.appendChild(fieldRow("Folder", srcInput,
    isDefaultSrc ? "Currently the default folder." : "The library scans this folder for source images."));
  const srcActions = document.createElement("div"); srcActions.className = "form-actions";
  srcActions.appendChild(ghostBtn("Set source", async () => { await setSourceDir(srcInput.value); if (appSettingsOpen) openAppSettings(); }));
  if (!isDefaultSrc) srcActions.appendChild(ghostBtn("Reset to default", async () => { await setSourceDir(""); if (appSettingsOpen) openAppSettings(); }));
  root.appendChild(srcActions);

  root.appendChild(sectionTitle("Install"));
  const installWrap = document.createElement("div"); installWrap.className = "form-row";
  const installLabel = document.createElement("span"); installLabel.className = "form-label"; installLabel.textContent = "Desktop app";
  installWrap.appendChild(installLabel);
  if (isInstalledApp()) {
    const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Installed — running as an app. ✓"; installWrap.appendChild(s);
  } else if (pwaInstallPrompt) {
    installWrap.appendChild(ghostBtn("Install…", () => installPwa()));
  } else {
    const b = ghostBtn("Install unavailable", () => {}); b.disabled = true; installWrap.appendChild(b);
    const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Your browser hasn't offered an install yet (or it's already installed)."; installWrap.appendChild(s);
  }
  root.appendChild(installWrap);

  // One place to see and install the optional heavy deps. Status + endpoints already
  // exist server-side (tool_status / /api/install/*); installs run as background jobs.
  const toolsTitle = sectionTitle("AI models & tools");
  root.appendChild(toolsTitle);
  const aiTools = [
    { key: "rembg_installed",     kind: "install-rembg",     name: "rembg (AI cutout)",      endpoint: "/api/install/rembg",     size: "~500MB",     note: "High-quality background removal.", ok: () => true },
    { key: "realesrgan_installed", kind: "install-realesrgan", name: "Real-ESRGAN (upscale)", endpoint: "/api/install/realesrgan", size: "~25MB",      note: "4× photo / anime upscaling.", ok: (w) => w && w.curl_available && w.unzip_available, need: "Needs curl + unzip." },
    { key: "vtracer_installed",   kind: "install-vtracer",   name: "VTracer (tracing)",      endpoint: "/api/install/vtracer",   size: "cargo build", note: "Raster → vector tracing engine.", ok: (w) => w && w.cargo_available, need: "Needs cargo (Rust toolchain)." },
  ];
  const reopenTools = () => { if (appSettingsOpen) openAppSettings({ focus: "tools" }); };
  const installTool = async (t, btn, reset) => {
    btn.disabled = true; btn.textContent = "Starting…";
    try { const data = await api(t.endpoint, "POST", {}); setStatus(data.message || "Install started.", 3000); await loadJobs(); reopenTools(); }
    catch (e) { setStatus(e.message, 3000); btn.disabled = false; btn.textContent = reset; }
  };
  for (const t of aiTools) {
    const row = document.createElement("div"); row.className = "form-row";
    const label = document.createElement("span"); label.className = "form-label"; label.textContent = t.name;
    row.appendChild(label);
    const box = document.createElement("div"); box.style.display = "flex"; box.style.flexDirection = "column"; box.style.gap = "6px";
    if (workspace && workspace[t.key]) {
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Installed ✓"; box.appendChild(s);
    } else if (installJobActive(t.kind)) {
      const b = ghostBtn("Installing…", () => {}); b.disabled = true; box.appendChild(b);
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Running in the background — watch Jobs."; box.appendChild(s);
    } else if (!t.ok(workspace)) {
      const b = ghostBtn("Install unavailable", () => {}); b.disabled = true; box.appendChild(b);
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = t.need; box.appendChild(s);
    } else {
      const reset = `Install (${t.size})`;
      const btn = ghostBtn(reset, () => installTool(t, btn, reset));
      box.appendChild(btn);
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = `${t.note} Runs in background — watch Jobs.`; box.appendChild(s);
    }
    row.appendChild(box);
    root.appendChild(row);
  }
  const refreshWrap = document.createElement("div"); refreshWrap.className = "form-actions";
  const missing = aiTools.filter((t) => !(workspace && workspace[t.key]) && t.ok(workspace) && !installJobActive(t.kind));
  if (missing.length >= 2) {
    const reset = `Install all missing (${missing.length})`;
    const allBtn = ghostBtn(reset, async () => {
      allBtn.disabled = true; allBtn.textContent = "Starting…";
      try { for (const m of missing) await api(m.endpoint, "POST", {}); setStatus(`Started ${missing.length} installs — watch Jobs.`, 3500); await loadJobs(); reopenTools(); }
      catch (e) { setStatus(e.message, 3000); allBtn.disabled = false; allBtn.textContent = reset; }
    });
    refreshWrap.appendChild(allBtn);
  }
  refreshWrap.appendChild(ghostBtn("Refresh status", async () => {
    try { applyStatusData(await fetchStatus()); reopenTools(); }
    catch (e) { setStatus(e.message, 2500); }
  }));
  root.appendChild(refreshWrap);

  root.appendChild(sectionTitle("Updates"));
  const updWrap = document.createElement("div"); updWrap.className = "form-row";
  const updLabel = document.createElement("span"); updLabel.className = "form-label"; updLabel.textContent = "Software update";
  updWrap.appendChild(updLabel);
  const updBox = document.createElement("div"); updBox.style.display = "flex"; updBox.style.flexDirection = "column"; updBox.style.gap = "6px";
  const updMsg = document.createElement("span"); updMsg.className = "form-hint";
  const checkBtn = ghostBtn("Check for updates", async () => {
    checkBtn.disabled = true; updMsg.textContent = "Checking…";
    try {
      const r = await api("/api/update/check", "POST", {});
      if (r.error) { updMsg.textContent = r.error; }
      else if (!r.latest) { updMsg.textContent = `On v${r.current}. No published releases yet.`; }
      else if (r.behind) {
        updMsg.textContent = `v${r.latest} is available (you're on v${r.current}).`;
        if (r.isGit && !r.dirty) updBox.appendChild(applyBtn);
        else updBox.appendChild(linkRow(r.url, r.dirty ? "Local changes present — update via git manually." : "Update via your package manager."));
      } else { updMsg.textContent = `Up to date — v${r.current}. ✓`; }
    } catch (e) { updMsg.textContent = `Check failed: ${e.message}`; }
    finally { checkBtn.disabled = false; }
  });
  const applyBtn = ghostBtn("Update & restart", async () => {
    applyBtn.disabled = true; updMsg.textContent = "Updating…";
    try {
      const r = await api("/api/update/apply", "POST", {});
      updMsg.textContent = (r.message || "Updating…") + " Restart hector-vector to finish.";
    } catch (e) { updMsg.textContent = `Update failed: ${e.message}`; applyBtn.disabled = false; }
  });
  const linkRow = (href, text) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.className = "form-hint"; a.textContent = text + " ↗"; return a; };
  updBox.appendChild(checkBtn); updBox.appendChild(updMsg);
  updWrap.appendChild(updBox);
  root.appendChild(updWrap);

  root.appendChild(sectionTitle("About"));
  const about = document.createElement("div"); about.className = "about-block";
  const verStr = versionInfo.commit ? `v${versionInfo.version} · ${versionInfo.commit}${versionInfo.branch ? " (" + versionInfo.branch + ")" : ""}` : `v${versionInfo.version}`;
  about.innerHTML =
    `<div class="about-name">hector-vector <span class="about-ver"></span></div>`
    + `<div class="about-line">A local, browser-based SVG vector editor + image→vector pipeline.</div>`
    + `<div class="about-line">Runs against your local server; works offline as an installed app.</div>`;
  about.querySelector(".about-ver").textContent = verStr;
  root.appendChild(about);
  loadVersion().then(() => { if (appSettingsOpen) { const el = about.querySelector(".about-ver"); if (el) el.textContent = versionInfo.commit ? `v${versionInfo.version} · ${versionInfo.commit}${versionInfo.branch ? " (" + versionInfo.branch + ")" : ""}` : `v${versionInfo.version}`; } });

  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Close", () => closeModal()));
  root.appendChild(actions);

  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
  // Deep-link: when opened from a stage that needs a missing tool, scroll to + briefly
  // highlight the tools section so the user lands exactly where they install it.
  if (opts.focus === "tools") {
    setTimeout(() => {
      try {
        toolsTitle.scrollIntoView({ block: "start", behavior: "smooth" });
        toolsTitle.classList.add("settings-focus");
        setTimeout(() => toolsTitle.classList.remove("settings-focus"), 1500);
      } catch {}
    }, 30);
  }
}

let layoutCtl = null;   // set by the layout-customize module; drives the header Layout dropdown
const MENU_ITEMS = {
  // Toolbar layout: toggle customize mode, switch/save profiles, reset to default.
  "layout": () => {
    if (!layoutCtl) return [{ label: "Customize layout", disabled: true, onClick: () => {} }];
    const active = layoutCtl.activeProfile();   // null = the unnamed "Default" working layout
    const dirty = layoutCtl.isDirty();          // live arrangement diverges from its baseline
    const items = [
      { label: "Customize layout", type: "toggle", checked: layoutCtl.isEditing(), onClick: () => layoutCtl.toggleEdit() },
      { type: "sep" },
      { label: "Default", checked: active === null, badge: (active === null && dirty) ? "edited" : null, onClick: () => layoutCtl.reset() },
    ];
    for (const name of layoutCtl.listProfiles()) items.push({
      label: name,
      checked: name === active,
      badge: (name === active && dirty) ? "edited" : null,
      onClick: () => layoutCtl.applyProfile(name),
      onRename: () => layoutCtl.renamePrompt(name),
      onDelete: () => layoutCtl.deleteProfile(name),
    });
    items.push({ type: "sep" });
    if (active && dirty) items.push({ label: `Update “${active}”`, onClick: () => layoutCtl.updateActive() });
    items.push({ label: "Save current as profile…", onClick: () => layoutCtl.saveProfilePrompt() });
    return items;
  },
  // Everything that used to be separate header buttons, rolled into one menu.
  "file": () => {
    const canReveal = !!(selectedOutput && selectedOutput.path);
    const items = [
      { label: "New blank canvas…", onClick: newBlankDoc },
      { type: "sep" },
      { label: "Open vector…", onClick: openOpenModal },
      { label: "Open from file…", onClick: openFromFile },
      { label: "Place into canvas…", onClick: openPlaceModal },
      { type: "sep" },
      { label: "Save (.svg)", onClick: saveDocument },
      { label: "Save as…", onClick: () => saveAsDocument() },
      { label: "Save project (.hv)…", onClick: saveProject },
      { label: "Download .svg", onClick: downloadCurrentSvg },
      { type: "sep" },
      { label: "Export PNG…", onClick: exportFlow },
      { label: "Reveal current file", onClick: revealCurrentFile, disabled: !canReveal },
      { label: "Copy SVG markup", onClick: copySvgSource },
      { type: "sep" },
      { label: "Settings…", onClick: openAppSettings },
    ];
    return items;
  },
};

// ---------- editor wiring: tools, header buttons, rail, keyboard ----------
document.querySelectorAll(".tool-button").forEach((b) => b.addEventListener("click", () => editor.setTool(b.dataset.tool)));
// ---------- fill (primary) / stroke (secondary) colour swatches ----------
{
  const fillSw = document.querySelector("#swatch-fill");
  const strokeSw = document.querySelector("#swatch-stroke");
  const swapBtn = document.querySelector("#swatch-swap");
  const firstSel = () => (editor.stage ? editor.selectedNodes()[0] : null);
  const cur = (which) => { const n = firstSel(); return n ? n.getAttribute(which) : editor.style[which]; };
  const curAlpha = (which) => { const n = firstSel(); const a = n ? n.getAttribute(which === "fill" ? "fill-opacity" : "stroke-opacity") : null; return a == null ? 1 : parseFloat(a); };
  const strokeW = () => { const n = firstSel(); const w = n ? parseFloat(n.getAttribute("stroke-width")) : editor.style.strokeWidth; return w > 0 ? w : 2; };
  const setSw = (el, color) => { const none = !color || color === "none"; if (el) { el.classList.toggle("none", none); el.style.background = none ? "#fff" : color; } };
  let active = "fill";   // which swatch the picker / shortcuts target (Illustrator's X focus)
  function refreshSwatches() {
    setSw(fillSw, cur("fill")); setSw(strokeSw, cur("stroke"));
    if (fillSw) fillSw.classList.toggle("active", active === "fill");
    if (strokeSw) strokeSw.classList.toggle("active", active === "stroke");
  }
  const applyPaint = (which, hex, alpha) => {
    if (which === "fill") { editor.applyFill(hex); editor.applyFillOpacity(alpha); }
    else { editor.applyStroke(hex || "none", hex ? strokeW() : 0); editor.applyStrokeOpacity(alpha); }
    refreshSwatches();
  };
  // The Colour panel is a DUO live editor (fill primary / stroke secondary), seeded from
  // the selection. It's a dockable panel now (same as Properties), so the toolstrip
  // swatch click just summons/focuses it; edits apply live and coalesce into one undo.
  let colorCtl = null, coalescing = false, commitT = null;
  const scheduleColorCommit = () => { clearTimeout(commitT); commitT = setTimeout(() => { if (coalescing) { editor.commitCoalesce("Colour"); coalescing = false; } }, 280); };
  const colApply = (w, hex, a) => { if (!coalescing) { editor.beginCoalesce(); coalescing = true; } applyPaint(w, hex, a); active = w; refreshSwatches(); scheduleColorCommit(); };
  // Build the live editor into a host element (the Colour panel body). Reused on each
  // selection change (the docks module gates rebuilds to actual selection-set changes).
  const colApplyBg = (hex) => { if (!coalescing) { editor.beginCoalesce(); coalescing = true; } editor.applyArtboardBg(hex); scheduleColorCommit(); };
  editor._renderColorPanel = (hostEl) => {
    if (colorCtl) { colorCtl.destroy(); colorCtl = null; }
    const sect = hostEl.closest && hostEl.closest(".rail-section");
    const ftitle = sect && sect.querySelector(".fp-title");
    // Nothing selected → an empty state, NOT the full (tall) duo picker. Rendering the
    // picker with no target made the panel overflow when expanded-but-empty.
    if (!editor.artboardSelected && (!editor.selection || editor.selection.size === 0)) {
      if (ftitle) ftitle.textContent = "Colour";
      hostEl.innerHTML = '<div class="insp-empty">Select an object to colour.</div>';
      return;
    }
    if (editor._selectionIsRaster()) {   // images carry no fill/stroke — the panel title says so, body blank
      if (ftitle) ftitle.textContent = "No Colour";
      hostEl.innerHTML = "";
      return;
    }
    if (ftitle) ftitle.textContent = "Colour";
    if (editor.artboardSelected) {     // the Colour panel edits the artboard background (solo)
      const ab = editor.artboardEl();
      colorCtl = openColorPicker({ title: "Background", allowNone: true, host: hostEl,
        color: ab ? ab.getAttribute("fill") : null, alpha: 1, onChange: (hex) => colApplyBg(hex) });
      return;
    }
    colorCtl = openColorPicker({
      title: "Colour", allowNone: true, host: hostEl,
      duo: {
        active,
        fill: { color: cur("fill"), alpha: curAlpha("fill") },
        stroke: { color: cur("stroke"), alpha: curAlpha("stroke") },
        apply: colApply,
      },
    });
  };
  editor._summonColor = () => { if (window.__docks) window.__docks.showColor(); };
  const pickFor = (which) => { active = which; refreshSwatches(); if (window.__docks) window.__docks.showColor(); };
  const doSwap = () => {
    const f = cur("fill"), s = cur("stroke");
    editor.push("Swap fill/stroke");
    editor.applyFill(s && s !== "none" ? hv.toHexColor(s) : null);
    const ns = f && f !== "none" ? hv.toHexColor(f) : "none";
    editor.applyStroke(ns, ns === "none" ? 0 : strokeW());
    refreshSwatches();
  };
  const setDefault = () => {   // Illustrator D: white fill, black 1px stroke
    editor.push("Default fill/stroke");
    editor.applyFill("#ffffff"); editor.applyFillOpacity(1);
    editor.applyStroke("#000000", 1); editor.applyStrokeOpacity(1);
    refreshSwatches();
  };
  const setNone = () => {   // Illustrator /: clear the active swatch
    editor.push("None");
    applyPaint(active, null, curAlpha(active));
  };
  if (fillSw) fillSw.addEventListener("click", () => pickFor("fill"));
  if (strokeSw) strokeSw.addEventListener("click", () => pickFor("stroke"));
  if (swapBtn) swapBtn.addEventListener("click", doSwap);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = (e.target?.tagName || "").toLowerCase();
    if (t === "input" || t === "textarea" || t === "select" || e.target?.isContentEditable || !modalRootEl.hidden || _activeColorPicker) return;
    if (e.key === "X" || e.key === "x") { e.preventDefault(); if (e.shiftKey) doSwap(); else { active = active === "fill" ? "stroke" : "fill"; refreshSwatches(); if (colorCtl) colorCtl.switchTo(active); } }
    else if (e.key === "d" || e.key === "D") { e.preventDefault(); setDefault(); }
    else if (e.key === "/") { e.preventDefault(); setNone(); }
  });
  editor.onInspect = refreshSwatches;   // editor pings this on every selection/structure change
  editor.pickColor = openColorPicker;   // single-target callers (artboard bg, object rows) reuse the same modal
  editor.pickPaint = pickFor;           // duo fill/stroke picker (the "main" colour picker + X)
  editor.openContextPanel = showContextPanel;   // layers-row right-click → same object panel as the canvas
  editor.rasterTools = buildRasterTools;         // raster panel: inline pipeline stages + live vectorize
  // Prefetch so the Process panels render without a flash. Deferred to a microtask:
  // this block runs during top-level module eval, but engineSchemas/rasterOpSchemas are
  // `let`s declared further down — calling now would hit their temporal dead zone (the
  // async fn swallows it as an unhandled rejection, leaving the cache null). The
  // microtask runs after module eval completes, when those bindings are initialised.
  queueMicrotask(() => { ensureEngineSchemas(); ensureRasterOpSchemas(); });
  refreshSwatches();
}

// ---------- raster panel: pipeline stages inline (upscale / remove-bg / vectorize) ----------
// A selected raster <image> docks the pipeline into its Properties panel. Upscale +
// Remove-BG run as async jobs and swap the result onto the canvas in place. Vectorize
// drives a LIVE, debounced trace that swaps the canvas to the vector (keep / revert) —
// packing the full vectorize settings into the panel. Server: input_url resolves the
// node's href to the source file; /api/trace-preview is a synchronous capped trace.
let rasterLive = false;          // live-vectorize preview active?
let rasterLiveNode = null;       // the <image> being previewed
let rasterLiveSvg = null;        // last previewed SVG (commit fallback)
let rasterLiveSeq = 0;           // guards out-of-order debounced traces
let rasterLiveTimer = null;
let rasterStageBusy = false;     // an upscale/bg job in flight (disables buttons)

function rasterHref(node) { return (node && (node.getAttribute("href") || node.getAttribute("xlink:href"))) || ""; }
function rasterName(node) { return (node && (node.getAttribute("data-hv-name") || "")).replace(/^Image:\s*/, "") || "trace"; }

// ---- engine schema (single source of truth: /api/vectorize/engines) -------------
// The vectorize panel is rendered PURELY from each engine's param schema, so a
// control is shown iff that engine actually consumes it (no phantom knobs) and every
// control is wired identically. Fetched once and cached; prefetched at startup.
let engineSchemas = null;
async function ensureEngineSchemas() {
  if (engineSchemas) return engineSchemas;
  try { const r = await api("/api/vectorize/engines"); if (Array.isArray(r)) engineSchemas = r; }
  catch { /* leave null so the next render retries — don't poison the cache */ }
  return engineSchemas || [];
}
// Which engine the current settings resolve to — mirrors server resolve_engine:
// explicit `engine` wins, else legacy-derive from method / colormode / style.
function currentEngineId() {
  if ((engineSchemas || []).some((e) => e.id === settings.engine && e.available !== false)) return settings.engine;
  if (settings.vectorize_method === "pixel") return "pixel";
  if (settings.trace_colormode === "color" && settings.trace_color_style === "clean") return "clean";
  return "vtracer";
}
// Pick an engine: set the explicit key AND keep the legacy fields coherent, so the
// Process workspace + the payload stay consistent and the server resolves the same.
function setEngine(id) {
  settings.engine = id;
  if (id === "pixel") settings.vectorize_method = "pixel";
  else {
    settings.vectorize_method = "trace";
    if (id === "clean") { settings.trace_colormode = "color"; settings.trace_color_style = "clean"; }
    else if (settings.trace_color_style === "clean") settings.trace_color_style = "poster";
  }
  persistSettings();
}
// A schema param's `when` guard: render only when every condition key matches.
function schemaWhenOk(param) {
  if (!param.when) return true;
  return Object.entries(param.when).every(([k, v]) => String(settings[k]) === String(v));
}
// Build ONE control from a schema param, wired to a debounced live re-trace. A param
// that other params' `when` depends on rebuilds the panel on change (to show/hide the
// dependents); every plain value control only kicks the trace — NO panel rebuild, so
// dragging a slider never destroys the thumb mid-drag (the old half-wired failure).
function schemaControl(param, whenKeys, liveKick, structural) {
  const k = param.key;
  if (settings[k] === undefined && param.default !== undefined && param.default !== null) settings[k] = param.default;
  const onChange = whenKeys.has(k) ? structural : liveKick;
  let control;
  if (param.type === "range") {
    control = makeRange(k, param.min, param.max, param.step || 1);
    control.addEventListener("input", liveKick);          // continuous → live only, never structural
  } else if (param.type === "checkbox") {
    control = document.createElement("input"); control.type = "checkbox"; control.checked = !!settings[k];
    control.addEventListener("change", () => { settings[k] = control.checked; persistSettings(); onChange(); });
  } else if (param.type === "number") {
    control = makeNumber(k, { min: param.min, max: param.max, step: param.step || 1, placeholder: param.placeholder || "" });
    control.addEventListener("input", liveKick);
  } else {
    control = makeSelect(k, param.options || []);          // [value, label] pairs from the schema
    control.addEventListener("change", onChange);
  }
  return fieldRow(param.label || k, control, param.hint);
}

// The settings payload the pipeline/preview endpoints read — the whole settings
// object (server picks the keys it knows) + the raster's source URL + overrides.
function stagePayload(node, overrides) {
  return Object.assign({}, settings, { input_url: rasterHref(node) }, overrides || {});
}

function rasterSourceUsable(node) {
  const href = rasterHref(node);
  if (!href) { setStatus("This image has no file source to process.", 3200); return false; }
  if (href.startsWith("data:")) { setStatus("Import this image to the library first, then process it.", 3800); return false; }
  return true;
}

// ---- raster-op schema (single source of truth: /api/raster-ops) ----------------
// Upscale + Remove-bg are rendered + live-wired from this, exactly like the vectorize
// engines — so all three pipeline stages share one schema-driven panel mechanism.
let rasterOpSchemas = null;
async function ensureRasterOpSchemas() {
  if (rasterOpSchemas) return rasterOpSchemas;
  try { const r = await api("/api/raster-ops"); if (Array.isArray(r)) rasterOpSchemas = r; }
  catch { /* leave null so the next render retries — don't poison the cache */ }
  return rasterOpSchemas || [];
}
function rasterOpById(id) { return (rasterOpSchemas || []).find((o) => o.id === id) || null; }

// ---- live raster ops (upscale / remove-bg): debounced transform → swap the canvas
// image href to the result (keep / revert). Same shape as live vectorize, but the
// preview is a transient href swap (raster→raster), not a vector overlay. ALWAYS
// re-runs from the ORIGINAL href so settings never compound on a prior preview. ----
let rasterOp = false;       // a raster-op live preview active?
let rasterOpNode = null;
let rasterOpName = null;    // "upscale" | "removebg"
let rasterOpOrig = null;    // original href — revert target AND the re-run source
let rasterOpSeq = 0;
let rasterOpTimer = null;
let rasterOpKicks = 0;      // test-observable: a control fired a re-run

function startRasterOpLive(node, op) {
  if (!rasterSourceUsable(node)) return;
  if (rasterLive) endRasterLive(true);     // one live preview at a time
  if (rasterOp) endRasterOpLive(true);
  rasterOp = true; rasterOpNode = node; rasterOpName = op; rasterOpOrig = rasterHref(node);
  editor._renderInspector();
  scheduleRasterOpLive(true);
}
function endRasterOpLive(revert) {
  if (revert && rasterOpNode && rasterOpOrig != null) rasterOpNode.setAttribute("href", rasterOpOrig);
  rasterOp = false; rasterOpNode = null; rasterOpName = null; rasterOpOrig = null;
  rasterOpSeq++;
  if (rasterOpTimer) { clearTimeout(rasterOpTimer); rasterOpTimer = null; }
}
function scheduleRasterOpLive(immediate) {
  if (!rasterOp || !rasterOpNode) return;
  rasterOpKicks++;
  if (rasterOpTimer) clearTimeout(rasterOpTimer);
  rasterOpTimer = setTimeout(doRasterOpLive, immediate ? 30 : 500);   // ops are heavier → longer debounce
}
async function doRasterOpLive() {
  if (!rasterOp || !rasterOpNode) return;
  const node = rasterOpNode, op = rasterOpName, seq = ++rasterOpSeq;
  setStatus(`${op === "upscale" ? "Upscaling" : "Removing background"}… (a few seconds)`, 0);
  try {
    // Re-run from the ORIGINAL source (not the current preview href) — no compounding.
    const res = await api("/api/raster-op", "POST", Object.assign({}, settings, { input_url: rasterOpOrig, op }));
    if (seq !== rasterOpSeq || !rasterOp) return;   // superseded or cancelled mid-flight
    if (!res.url) throw new Error(res.message || res.error || "No result produced.");
    node.setAttribute("href", res.url);
    setStatus(`Preview — ${op === "upscale" ? "upscaled" : "background removed"} (not saved).`, 1800);
  } catch (e) {
    if (seq !== rasterOpSeq) return;
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the raster-op endpoint is new."
                    : `${op === "upscale" ? "Upscale" : "Remove background"} failed: ${e.message}`, 5000);
  }
}
// Keep: the canvas IS the preview (href already points at the scratch result) — just
// push history. Revert: restore the original href.
function commitRasterOpLive() {
  const node = rasterOpNode;
  if (!node) return;
  if (rasterOpOrig != null && rasterHref(node) === rasterOpOrig) { setStatus("Adjust a setting to generate a preview first.", 2800); return; }
  rasterOp = false; rasterOpNode = null; rasterOpName = null; rasterOpOrig = null; rasterOpSeq++;
  if (rasterOpTimer) { clearTimeout(rasterOpTimer); rasterOpTimer = null; }
  editor.push("Process raster");
  editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
  setStatus("Applied on canvas (not saved to library).", 3000);
}

// The resolution at which BOTH the live preview and a focused on-canvas vectorize trace.
// It's the WYSIWYG number: what you preview is what you commit, so they must match. It is
// deliberately tighter than the server's batch overproduction ceiling (TRACE_MAX_DIM) —
// the focused/interactive path favours a clean, fast, preview-identical result. Mirrors
// the server's TRACE_PREVIEW_DIM (the server clamps the request to 64..2048 regardless).
const TRACE_PREVIEW_DIM = 1000;

// ---- live vectorize: debounced trace → swap the canvas to the vector ----
function startRasterLive(node) {
  if (!rasterSourceUsable(node)) return;
  rasterLive = true; rasterLiveNode = node; rasterLiveSvg = null;
  editor._renderInspector();
  scheduleRasterLive(true);
}
function endRasterLive(revert) {
  rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null;
  rasterLiveSeq++;
  if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  if (revert) editor.clearRasterPreview(true);
}
let rasterLiveKicks = 0;   // counts re-trace requests (a test-observable signal that a control is live-wired)
function scheduleRasterLive(immediate) {
  if (!rasterLive || !rasterLiveNode) return;
  rasterLiveKicks++;
  if (rasterLiveTimer) clearTimeout(rasterLiveTimer);
  // 250ms settle: traces are ~1.5s now (was 11s), so a short debounce feels live
  // without spamming — superseded in-flight traces are dropped by the seq guard.
  rasterLiveTimer = setTimeout(doRasterLiveTrace, immediate ? 30 : 250);
}
async function doRasterLiveTrace() {
  if (!rasterLive || !rasterLiveNode) return;
  const node = rasterLiveNode, seq = ++rasterLiveSeq;
  setStatus("Tracing preview…", 0);
  try {
    const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
    if (seq !== rasterLiveSeq || !rasterLive) return;   // superseded or cancelled mid-flight
    if (res.svg) { rasterLiveSvg = res.svg; editor.showRasterPreview(node, res.svg); setStatus(`Preview — ${res.nodes} nodes`, 1800); }
  } catch (e) {
    if (seq !== rasterLiveSeq) return;
    // 404 = a server predating the /api/trace-preview route → ask for a restart.
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the live-trace endpoint is new." : `Preview failed: ${e.message}`, 4500);
  }
}
// Commit: keep exactly what's previewed on the canvas — replace the raster with a
// real vector layer built from the live preview SVG (the canvas IS the preview, so
// the kept result matches it 1:1, and it's instant — no second trace round-trip).
function commitRasterLive() {
  const node = rasterLiveNode, svg = rasterLiveSvg;
  if (!node) return;
  if (!svg) { setStatus("Adjust a setting to generate a trace first.", 2800); return; }
  const name = rasterName(node);
  rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null; rasterLiveSeq++;
  if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  editor.commitRasterToVector(node, svg, name);
}

// Single source of truth for a focused vectorize: trace ONCE at the live-preview
// resolution and commit that exact SVG in place. If a live preview is already showing for
// this node, reuse its SVG (instant, and byte-identical to "Keep vector"); otherwise do a
// single synchronous /api/trace-preview at the same resolution. This is what the chin
// "Run → canvas" calls for a vectorize-only run, so previewing and committing can never
// disagree and no second job re-traces at the batch ceiling.
async function commitFocusedVectorize(node) {
  let svg = (rasterLive && rasterLiveNode === node && rasterLiveSvg) ? rasterLiveSvg : null;
  if (!svg) {
    setStatus("Tracing…", 0);
    const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
    if (!res.svg) throw new Error(res.message || res.error || "No vector produced.");
    svg = res.svg;
  }
  // Tear down any live-preview state for this node first, so its seq-guard / debounce
  // timer / Revert can't fire against the node we're about to replace.
  if (rasterLive && rasterLiveNode === node) {
    rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null; rasterLiveSeq++;
    if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  }
  const ok = editor.commitRasterToVector(node, svg, rasterName(node));
  if (!ok) setStatus("Couldn't place the traced vector.", 3500);
  return ok;
}

// T1 "Auto": ask the server to recommend vectorize settings from image stats,
// apply them to the panel, and (if live) re-trace so the canvas updates at once.
async function autoSuggestTrace(node) {
  if (!rasterSourceUsable(node)) return;
  setStatus("Analyzing image…", 0);
  try {
    const res = await api("/api/trace-suggest", "POST", { input_url: rasterHref(node) });
    // Apply the derived params, then the explicit engine — the panel now has an Engine
    // selector, so reflecting the suggestion there (instead of leaving it implicit) is
    // exactly what the user expects. setEngine keeps the legacy fields coherent too.
    for (const k of ["vectorize_method", "trace_colormode", "trace_color_style", "color_precision", "trace_simplify"]) {
      if (res[k] !== undefined) settings[k] = res[k];
    }
    if (res.engine && (engineSchemas || []).some((e) => e.id === res.engine)) setEngine(res.engine);
    persistSettings();
    editor._renderInspector();
    if (rasterLive) scheduleRasterLive(false);
    setStatus(res.reason || "Applied suggested settings.", 4500);
  } catch (e) {
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the auto-detect endpoint is new." : `Auto-detect failed: ${e.message}`, 4500);
  }
}

// ---- Schema-driven pipeline stage renderers (shared) ----------------------------
// These render ONE stage's settings + live-preview controls into `body`, targeting
// raster `node` (null = no live target, e.g. batch config). They live at module level
// so the Processor dock panel hosts them; `rerender` rebuilds the host panel and
// re-kicks whichever live preview is active. (The pipeline used to be crammed into the
// raster Properties panel via buildRasterTools — now it's the Processor panel.)
function rasterReRender() { editor._renderInspector(); if (rasterLive) scheduleRasterLive(false); if (rasterOp) scheduleRasterOpLive(false); }
function rasterActionRow(label, onClick, primary = true) {
  const row = document.createElement("div"); row.className = "rt-actions";
  const b = document.createElement("button"); b.type = "button";
  b.className = primary ? "primary-button" : "ghost-button"; b.textContent = label;
  b.disabled = rasterStageBusy; b.addEventListener("click", onClick);
  row.appendChild(b); return row;
}
// A stage whose tool isn't installed points at Settings (one install hub) instead of
// installing inline — message explains what's needed, the button opens Settings → tools.
function toolSetupNote(message, ctaLabel = "Set up in Settings") {
  const wrap = document.createElement("div"); wrap.className = "rt-actions rt-tool-setup";
  const note = document.createElement("div"); note.className = "form-hint"; note.textContent = message;
  const b = document.createElement("button"); b.type = "button"; b.className = "ghost-button"; b.textContent = "⚙ " + ctaLabel;
  b.addEventListener("click", () => openToolsSettings());
  wrap.appendChild(note); wrap.appendChild(b); return wrap;
}
// A raster-op stage (upscale / remove-bg): schema controls + a live preview that swaps
// the canvas image to the result (Keep / Revert). Mirrors the Vectorize stage.
function renderRasterOpStage(body, opId, node, rerender = rasterReRender) {
  if (!rasterOpSchemas) {
    const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Loading…";
    body.appendChild(h); ensureRasterOpSchemas().then(rerender); return;
  }
  const op = rasterOpById(opId); if (!op) return;
  const live = rasterOp && rasterOpName === opId;
  const liveKick = () => { if (rasterOp && rasterOpName === opId) scheduleRasterOpLive(false); };
  const whenKeys = new Set();
  for (const p of op.schema) if (p.when) Object.keys(p.when).forEach((kk) => whenKeys.add(kk));
  for (const p of op.schema) { if (!schemaWhenOk(p)) continue; body.appendChild(schemaControl(p, whenKeys, liveKick, rerender)); }
  // AI cutout needs rembg — point at the one install hub (Settings), don't install inline.
  if (opId === "removebg" && settings.removebg_method === "ai" && !op.rembg_installed) {
    body.appendChild(toolSetupNote("AI cutout needs rembg (~500MB).", "Install rembg in Settings"));
  }
  if (live) {
    const row = document.createElement("div"); row.className = "rt-actions";
    const keep = document.createElement("button"); keep.type = "button"; keep.className = "primary-button"; keep.textContent = "Keep result";
    keep.addEventListener("click", () => commitRasterOpLive());
    const revert = document.createElement("button"); revert.type = "button"; revert.className = "ghost-button"; revert.textContent = "Revert";
    revert.addEventListener("click", () => { endRasterOpLive(true); rerender(); });
    row.appendChild(keep); row.appendChild(revert); body.appendChild(row);
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = "Live — adjust settings to update the canvas.";
    body.appendChild(hint);
  } else if (op.available === false) {
    // Tool missing (e.g. Upscale needs Real-ESRGAN) → route to Settings instead of a dead button.
    const tool = opId === "upscale" ? "Real-ESRGAN" : "the required tool";
    body.appendChild(toolSetupNote(`${op.label || "This stage"} needs ${tool}.`, `Install ${tool} in Settings`));
  } else if (node) {
    body.appendChild(rasterActionRow("Live preview ▸", () => startRasterOpLive(node, opId)));
  }
}
// The Vectorize stage: engine selector + auto-detect + the engine's own param schema
// (basic inline, advanced behind a toggle) + live trace preview (Keep / Revert).
function renderVectorizeStage(body, node, rerender = rasterReRender) {
  if (!engineSchemas) {
    const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Loading engines…";
    body.appendChild(h); ensureEngineSchemas().then(rerender); return;
  }
  const liveKick = () => { if (rasterLive) scheduleRasterLive(false); };   // value change → retrace, NO rebuild
  const structural = rerender;                                            // rebuild panel + retrace
  const engId = currentEngineId();
  const eng = engineSchemas.find((e) => e.id === engId) || engineSchemas[0];
  const engSel = makeSelectRaw(engId,
    engineSchemas.map((e) => [e.id, e.available === false ? `${e.label} (unavailable)` : e.label]),
    (val) => { const t = engineSchemas.find((e) => e.id === val); if (t && t.available === false) return; setEngine(val); structural(); });
  body.appendChild(fieldRow("Engine", engSel, eng && eng.caps && eng.caps.planar ? "Planar — keeps holes/counters, no halos." : undefined));

  // Selected engine's tool is missing → route to Settings (and stop: its params/preview are
  // moot until it's installed). The selector above still lets you switch to an available engine.
  if (eng && eng.available === false) {
    const tool = (eng.caps && eng.caps.needs && eng.caps.needs.includes("vtracer")) ? "VTracer" : "the required tool";
    body.appendChild(toolSetupNote(`The “${eng.label}” engine needs ${tool}.`, `Install ${tool} in Settings`));
    return;
  }

  const autoRow = document.createElement("div"); autoRow.className = "rt-actions";
  const auto = document.createElement("button");
  auto.type = "button"; auto.className = "ghost-button"; auto.textContent = "✨ Auto-detect settings";
  auto.title = node ? "Inspect the image and pick sensible vectorize settings" : "Select a raster to auto-detect";
  auto.disabled = rasterStageBusy || !node;
  auto.addEventListener("click", () => autoSuggestTrace(node));
  autoRow.appendChild(auto); body.appendChild(autoRow);

  const schema = (eng && eng.schema) || [];
  const whenKeys = new Set();
  for (const p of schema) if (p.when) Object.keys(p.when).forEach((kk) => whenKeys.add(kk));
  const advanced = [];
  for (const p of schema) {
    if (!schemaWhenOk(p)) continue;
    if (p.advanced) { advanced.push(p); continue; }
    body.appendChild(schemaControl(p, whenKeys, liveKick, structural));
  }
  if (advanced.length) {
    const advToggle = document.createElement("input");
    advToggle.type = "checkbox"; advToggle.checked = !!settings.trace_advanced;
    advToggle.addEventListener("change", () => { settings.trace_advanced = advToggle.checked; persistSettings(); structural(); });
    body.appendChild(fieldRow("Advanced", advToggle));
    if (settings.trace_advanced) for (const p of advanced) if (schemaWhenOk(p)) body.appendChild(schemaControl(p, whenKeys, liveKick, structural));
  }
  if (rasterLive) {
    const row = document.createElement("div"); row.className = "rt-actions";
    const keep = document.createElement("button"); keep.type = "button"; keep.className = "primary-button"; keep.textContent = "Keep vector";
    keep.addEventListener("click", () => commitRasterLive());
    const revert = document.createElement("button"); revert.type = "button"; revert.className = "ghost-button"; revert.textContent = "Revert to raster";
    revert.addEventListener("click", () => { endRasterLive(true); rerender(); });
    row.appendChild(keep); row.appendChild(revert); body.appendChild(row);
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = "Live — drag any control to update the trace on canvas.";
    body.appendChild(hint);
  } else if (node) {
    body.appendChild(rasterActionRow("Live preview ▸", () => startRasterLive(node)));
  }
}
// Render one stage's settings (dispatch by id). Used by the Processor panel cards.
function renderStageSettings(body, id, node, rerender = rasterReRender) {
  if (id === "vectorize") renderVectorizeStage(body, node, rerender);
  else renderRasterOpStage(body, id, node, rerender);
}

// The raster Properties panel no longer crams the pipeline — it points at the Processor
// dock panel (the pipeline's home). A selected raster still shows a compact card so you
// know where to process it; if a live preview is mid-flight, Keep/Revert stay reachable.
// The raster Properties panel no longer carries a "Process / Open Processor" pointer —
// the Processor panel is contextual now (it auto-reveals when a raster is the subject), so
// the pointer was redundant. The only thing kept here is committing an in-progress live
// preview (the canvas IS the preview), shown only while one is running.
function buildRasterTools(node) {
  if (!(rasterLive && rasterLiveNode === node)) return null;
  const root = document.createElement("div"); root.className = "raster-tools raster-tools-compact";
  const row = document.createElement("div"); row.className = "rt-actions";
  const keep = document.createElement("button"); keep.type = "button"; keep.className = "primary-button"; keep.textContent = "Keep vector";
  keep.addEventListener("click", () => commitRasterLive());
  const revert = document.createElement("button"); revert.type = "button"; revert.className = "ghost-button"; revert.textContent = "Revert to raster";
  revert.addEventListener("click", () => { endRasterLive(true); editor._renderInspector(); });
  row.appendChild(keep); row.appendChild(revert); root.appendChild(row);
  return root;
}
// ---------- object action bar (right) + Layers-header structure controls ----------
// The clipboard/boolean/transform actions and the reorder/group controls moved out of
// the right-click panel into always-visible toolbars; enable-state tracks the
// selection (refreshed via editor.onInspect + after each action).
{
  const wire = (id, fn) => {
    const b = document.querySelector(id);
    if (b) b.addEventListener("click", () => { try { fn(); } catch (e) { setStatus(e.message || String(e), 3000); } refreshActionButtons(); });
  };
  wire("#act-cut", () => editor.cut());
  wire("#act-copy", () => editor.copy());
  wire("#act-paste", () => editor.paste());
  wire("#act-duplicate", () => editor.duplicate());
  wire("#act-union", () => editor.booleanOp("union"));
  wire("#act-subtract", () => editor.booleanOp("subtract"));
  wire("#act-intersect", () => editor.booleanOp("intersect"));
  wire("#act-rotate-cw", () => editor.transform("rotateCW"));
  wire("#act-rotate-ccw", () => editor.transform("rotateCCW"));
  wire("#act-flip-h", () => editor.transform("flipH"));
  wire("#act-flip-v", () => editor.transform("flipV"));
  wire("#layer-front", () => editor.reorder("front"));
  wire("#layer-forward", () => editor.reorder("forward"));
  wire("#layer-backward", () => editor.reorder("backward"));
  wire("#layer-back", () => editor.reorder("back"));
  wire("#layer-group", () => editor.group());
  wire("#layer-ungroup", () => editor.ungroup());
  wire("#layer-rename", () => { const s = editor.selectedNodes(); if (s.length === 1) editor.beginRename(s[0].getAttribute("data-hv-id")); });
  wire("#layer-delete", () => editor.deleteSelection());
  wire("#layer-cleanup", () => editor.cleanupLayers());
  wire("#layer-merge", () => editor.consolidateByColor());

  const set = (id, on) => { const b = document.querySelector(id); if (b) b.disabled = !on; };
  const refreshActionButtons = function () {
    const has = !!editor.stage;
    const sel = has ? editor.selectedNodes() : [];
    const n = sel.length, hasSel = n > 0;
    const fillable = (hasSel ? editor._effectiveLeaves() : []).filter((s) => shapeToAbsPath(s)).length >= 2;
    const hasGroup = sel.some((s) => s.tagName.toLowerCase() === "g");
    const hasClip = !!(editor.clipboard && editor.clipboard.length);
    set("#act-cut", hasSel); set("#act-copy", hasSel); set("#act-duplicate", hasSel);
    set("#act-paste", has && hasClip);
    set("#act-union", fillable); set("#act-subtract", fillable); set("#act-intersect", fillable);
    // rotate/flip act on the selection, or on the artboard itself when it's selected;
    // grey when nothing is selected (no objects, no artboard).
    const isRaster = hasSel && editor._selectionIsRaster();
    const canXform = hasSel || (has && editor.artboardSelected);
    ["#act-rotate-cw", "#act-rotate-ccw", "#act-flip-h", "#act-flip-v"].forEach((id) => set(id, canXform));
    // Invert-space (fill the gaps) is a VECTOR op — meaningless on a raster. Gates the
    // Object-panel-header ⊠ tile (the single, movable home of invert).
    const canInvert = (hasSel && !isRaster) || (has && editor.artboardSelected);
    set("#hdr-invert", canInvert);
    // Layers header: reorder/group/ungroup/rename/delete (selection-gated) + cleanup/merge (whole doc)
    ["#layer-front", "#layer-forward", "#layer-backward", "#layer-back", "#layer-delete"].forEach((id) => set(id, hasSel));
    set("#layer-group", n >= 2); set("#layer-ungroup", hasGroup); set("#layer-rename", n === 1);
    set("#layer-cleanup", has); set("#layer-merge", has);
  };
  const prevOnInspect = editor.onInspect;
  editor.onInspect = () => {
    if (prevOnInspect) prevOnInspect();
    // Tear down a live preview (vectorize OR raster-op) if its raster is no longer the sole selection.
    if (rasterLive && !(editor.selection.size === 1 && rasterLiveNode && editor.selection.has(rasterLiveNode.getAttribute("data-hv-id")))) endRasterLive(true);
    if (rasterOp && !(editor.selection.size === 1 && rasterOpNode && editor.selection.has(rasterOpNode.getAttribute("data-hv-id")))) endRasterOpLive(true);
    refreshActionButtons(); renderFloatPanel(); updateSelLabel();
    renderProcessorPanel();   // keep the Processor target + contextual reveal/dim in sync with the canvas selection
    syncDockContext();        // park/return contextual panels (Processor, Colour) for the new selection
  };
  refreshActionButtons();
}
{
  const undoBtn = document.querySelector("#undo-button"); if (undoBtn) undoBtn.addEventListener("click", () => editor.undo());
  const redoBtn = document.querySelector("#redo-button"); if (redoBtn) redoBtn.addEventListener("click", () => editor.redoAction());
  // Canvas-level controls in the bottom viewport bar (moved off the artboard right-click).
  const selAllBtn = document.querySelector("#vp-selectall"); if (selAllBtn) selAllBtn.addEventListener("click", () => editor.selectAll());
  const guidesBtn = document.querySelector("#vp-guides");
  if (guidesBtn) {
    const syncGuides = () => { guidesBtn.classList.toggle("on", !!editor.smartGuides); guidesBtn.setAttribute("aria-pressed", editor.smartGuides ? "true" : "false"); };
    syncGuides();
    guidesBtn.addEventListener("click", () => { editor.smartGuides = !editor.smartGuides; prefs.smartGuides = editor.smartGuides; persistPrefs(); syncGuides(); setStatus(`Smart guides ${editor.smartGuides ? "on" : "off"}.`, 1500); });
  }
  const rulersBtn = document.querySelector("#vp-rulers");
  if (rulersBtn) {
    const rulersEl = document.querySelector("#rulers");
    // Rulers + guide marks share ONE visibility (Ctrl+R / this button): on → both shown,
    // off → both hidden. Editing guides is gated separately by the lock (default locked,
    // so you can't accidentally drag them — unlock via the ruler right-click menu).
    const syncRulers = () => { const on = !!prefs.rulers; if (rulersEl) rulersEl.hidden = !on; rulersBtn.classList.toggle("on", on); rulersBtn.setAttribute("aria-pressed", on ? "true" : "false"); editor.guidesHidden = !on; editor.renderGuides(); if (on) drawRulers(); };
    syncRulers();
    rulersBtn.addEventListener("click", () => { prefs.rulers = !prefs.rulers; persistPrefs(); syncRulers(); setStatus(`Rulers ${prefs.rulers ? "on" : "off"}.`, 1500); });
    bindRulerGuides(rulersEl);
  }
  const appEl = document.querySelector(".app.editor");
  // (#rail-toggle now folds BOTH side docks — owned by the Dockable-panels module below.)
  // ---- Customizable picture-frame layout: drag toolbar tiles between bars; Default / Save / Reset ----
  {
    const LAYOUT_KEY = "hector-vector:layout";
    const SEP = "|";
    // each frame bar is a drop zone (swatches now live on the canvas, not the toolstrip).
    const BARS = [
      { name: "tools",       sel: ".toolstrip",         tail: null },
      { name: "arrange",     sel: ".stage-toolbar",     tail: null },
      { name: "actions",     sel: ".actionbar",         tail: null },
      { name: "viewport",    sel: ".viewport-controls", tail: null },
      { name: "hdr-history", sel: ".rail-section.history .panel-actions", tail: null },
      { name: "hdr-layers",  sel: ".rail-section.layers .panel-actions",  tail: null },
    ];
    const barOf = (b) => b.el || document.querySelector(b.sel);   // bars are sel- OR element-based (panel headers)
    const isTile = (el) => !!(el && el.classList && el.classList.contains("tool-button") && !el.classList.contains("panel-x"));   // the × isn't a movable tile
    const isSep = (el) => !!(el && el.classList && (el.classList.contains("tool-sep") || el.classList.contains("tool-vsep") || el.classList.contains("vp-sep")));
    const tileKey = (b) => b.id ? "#" + b.id : b.dataset.tool ? "tool:" + b.dataset.tool : (b.dataset.vp && b.dataset.action) ? "vp:" + b.dataset.action : "t:" + (b.textContent || "").trim();
    const slotKey = (el) => isSep(el) ? SEP : tileKey(el);
    const tailEl = (cont, bar) => bar.tail ? cont.querySelector(bar.tail) : null;
    const axisY = (cont) => cont.classList.contains("toolstrip") || cont.classList.contains("actionbar");
    // movable children of a bar (tiles + separators that sit before the pinned tail)
    function movable(bar) {
      const cont = barOf(bar); if (!cont) return [];
      const tail = tailEl(cont, bar), out = [];
      for (const ch of cont.children) { if (tail && ch === tail) break; if (isTile(ch) || isSep(ch)) out.push(ch); }
      return out;
    }
    const capture = () => { const m = {}; for (const b of BARS) m[b.name] = movable(b).map(slotKey); return m; };
    // A fresh divider of the right kind for a bar: a thin rule between vertical-stack
    // bars (toolstrip/actionbar), a vertical rule between horizontal bars; viewport
    // keeps its own .vp-sep style.
    const sepClassFor = (bar) => bar.name === "viewport" ? "vp-sep" : (axisY(barOf(bar)) ? "tool-sep" : "tool-vsep");
    function makeSep(bar) { const s = document.createElement("span"); s.className = sepClassFor(bar); s.setAttribute("aria-hidden", "true"); return s; }
    const DEFAULT = capture();   // authored DOM order — taken before applying any saved layout

    // every tile by key, wherever it currently sits (across all registered bars)
    function collectTiles() {
      const m = new Map();
      for (const b of BARS) { const c = barOf(b); if (c) for (const t of c.querySelectorAll(".tool-button")) if (isTile(t)) m.set(tileKey(t), t); }
      return m;
    }
    function applyBar(bar, list, tiles) {
      const cont = barOf(bar); if (!cont) return;
      tiles = tiles || collectTiles();
      const tail = tailEl(cont, bar);
      const pool = [...cont.children].filter(isSep);   // reuse existing separators, create more on demand
      let pi = 0;
      for (const key of (list || [])) {
        const el = key === SEP ? (pool[pi++] || makeSep(bar)) : tiles.get(key);
        if (el) cont.insertBefore(el, tail);   // insertBefore(el, null) appends
      }
      for (; pi < pool.length; pi++) pool[pi].remove();   // drop separators the layout no longer wants
    }
    function apply(layout) {
      if (!layout) return;
      const tiles = collectTiles();
      for (const b of BARS) applyBar(b, layout[b.name], tiles);
      // tiles a saved layout doesn't mention (e.g. added in a newer build) keep their place
    }
    const PROFILES_KEY = "hector-vector:layout-profiles";
    const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); } catch { return null; } };
    const persist = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(capture())); } catch {} };   // auto-save
    const loadProfiles = () => { try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || "{}") || {}; } catch { return {}; } };
    const saveProfiles = (p) => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); } catch {} };
    apply(loadSaved());   // restore the auto-saved arrangement at boot

    // ---- drag tiles between bars (only while customizing) ----
    let editing = false, dragEl = null;
    const layoutMenu = document.querySelector('.menu[data-menu="layout"]');
    const layoutTrigger = layoutMenu && layoutMenu.querySelector(".menu-trigger");
    const barFor = (cont) => BARS.find((b) => barOf(b) === cont);
    function insertionRef(cont, x, y, bar) {
      const tail = tailEl(cont, bar), useY = axisY(cont);
      for (const ch of cont.children) {
        if (tail && ch === tail) break;
        if ((!isTile(ch) && !isSep(ch)) || ch === dragEl) continue;
        const r = ch.getBoundingClientRect();
        if ((useY ? y : x) < (useY ? r.top + r.height / 2 : r.left + r.width / 2)) return ch;
      }
      return tail;   // before the pinned tail, or null => append
    }
    const onDragStart = (e) => { dragEl = e.currentTarget; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", ""); } catch {} dragEl.classList.add("dragging"); };
    const onDragEnd = () => { if (dragEl) dragEl.classList.remove("dragging"); dragEl = null; };
    const HDR_TILE_CAP = 8;   // headers scroll on overflow now (tile-scroll), so allow more tiles
    const onBarOver = (e) => {
      if (!dragEl) return;
      const cont = e.currentTarget, bar = barFor(cont);
      // Cap incoming tiles on panel headers (reordering within a full header is still fine).
      if (bar && bar.name.startsWith("hdr-") && dragEl.parentElement !== cont
          && movable(bar).filter(isTile).length >= HDR_TILE_CAP) { e.dataTransfer.dropEffect = "none"; return; }
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const ref = insertionRef(cont, e.clientX, e.clientY, bar);
      if (ref !== dragEl) cont.insertBefore(dragEl, ref);   // live reflow while dragging
    };
    const onBarDrop = (e) => { e.preventDefault(); persist(); };   // DOM already reflects the move → auto-save it
    const blockClick = (e) => { e.preventDefault(); e.stopPropagation(); };
    // Both tiles AND dividers are draggable while customizing; dividers can also be
    // added/removed via the bar's right-click menu.
    function frameMovables() { const out = []; for (const b of BARS) for (const m of movable(b)) out.push(m); return out; }
    function wireMovable(el, on) {
      el.draggable = on;
      if (on) {
        if (isTile(el)) { el.disabled = false; el.addEventListener("click", blockClick, true); }   // disabled buttons can't be dragged
        el.addEventListener("dragstart", onDragStart);
        el.addEventListener("dragend", onDragEnd);
      } else {
        if (isTile(el)) el.removeEventListener("click", blockClick, true);
        el.removeEventListener("dragstart", onDragStart);
        el.removeEventListener("dragend", onDragEnd);
      }
    }
    const sepUnder = (t) => isSep(t) ? t : (t && t.closest ? t.closest(".tool-sep, .tool-vsep, .vp-sep") : null);
    const onBarContext = (e) => {
      if (!editing) return;
      e.preventDefault(); e.stopPropagation();
      const cont = e.currentTarget, bar = barFor(cont), onSep = sepUnder(e.target);
      const items = [{ label: "Add divider here", onClick: () => {
        const ref = insertionRef(cont, e.clientX, e.clientY, bar);
        const s = makeSep(bar); cont.insertBefore(s, ref === dragEl ? null : ref); wireMovable(s, true); persist();
      } }];
      if (onSep) items.push({ label: "Remove divider", onClick: () => { wireMovable(onSep, false); onSep.remove(); persist(); } });
      showContextMenu(e.clientX, e.clientY, items);
    };

    function wireBar(bar, on) {
      const cont = barOf(bar); if (!cont) return;
      for (const m of movable(bar)) wireMovable(m, on);
      if (on) { cont.addEventListener("dragover", onBarOver); cont.addEventListener("drop", onBarDrop); cont.addEventListener("contextmenu", onBarContext); }
      else { cont.removeEventListener("dragover", onBarOver); cont.removeEventListener("drop", onBarDrop); cont.removeEventListener("contextmenu", onBarContext); }
    }
    // Register a panel header's action area as a customize-layout bar (drop receiver). The
    // panel headers are built dynamically (after this module), so they opt in on creation.
    function registerBar(name, el) {
      if (!el || BARS.some((b) => b.name === name)) return;
      const bar = { name, el, tail: el.querySelector(".panel-x") ? ".panel-x" : null };   // drops land before the × (Dock-to-rail) button
      BARS.push(bar);
      if (!(name in DEFAULT)) DEFAULT[name] = movable(bar).map(slotKey);   // authored default (for Reset)
      const saved = loadSaved();
      if (saved && saved[name]) applyBar(bar, saved[name]);   // restore this bar's saved arrangement
      if (editing) wireBar(bar, true);
      el.classList.add("layout-bar");   // CSS hook for the customize drop outline
    }
    function setEditing(on) {
      editing = on;
      appEl.classList.toggle("customizing", on);
      if (layoutTrigger) layoutTrigger.classList.toggle("active", on);
      BARS.forEach((b) => wireBar(b, on));
      if (!on && editor.onInspect) editor.onInspect();   // restore the correct disabled states (onInspect runs refreshActionButtons)
      setStatus(on ? "Customize layout: drag buttons between bars (incl. panel headers) — changes save automatically." : "Ready.", on ? 6000 : 1500);
    }
    // ---- active-profile state (the source of truth for "which profile is selected") ----
    // null = the unnamed working layout ("Default"). The live arrangement can DIVERGE from
    // its baseline (a profile snapshot, or the authored DEFAULT) — that's the "edited" state.
    const ACTIVE_KEY = "hector-vector:layout-active";
    let activeProfile = null;
    try { activeProfile = localStorage.getItem(ACTIVE_KEY) || null; } catch {}
    if (activeProfile && !(activeProfile in loadProfiles())) activeProfile = null;   // pruned/renamed away
    const setActive = (name) => { activeProfile = name || null; try { activeProfile ? localStorage.setItem(ACTIVE_KEY, activeProfile) : localStorage.removeItem(ACTIVE_KEY); } catch {} };
    // Dirty = the live arrangement diverges from its baseline. Compare only the bars the
    // baseline actually records, so a profile saved before a newer panel existed doesn't
    // read as "edited" the instant it's applied (its missing bars simply aren't compared).
    const sameAs = (base) => { if (!base) return false; const now = capture(); return Object.keys(base).every((k) => JSON.stringify(base[k]) === JSON.stringify(now[k])); };
    const isDirty = () => activeProfile ? !sameAs(loadProfiles()[activeProfile]) : !sameAs(DEFAULT);

    function reset() { try { localStorage.removeItem(LAYOUT_KEY); } catch {} apply(DEFAULT); setActive(null); setStatus("Layout reset to default.", 1500); }
    function applyProfile(name) { const p = loadProfiles()[name]; if (!p) return; apply(p); persist(); setActive(name); setStatus(`Layout: ${name}.`, 1500); }
    function saveProfile(name) { const nm = (name || "").trim(); if (!nm) return false; const p = loadProfiles(); p[nm] = capture(); saveProfiles(p); setActive(nm); return true; }
    function updateActive() { if (!activeProfile) return false; const p = loadProfiles(); if (!(activeProfile in p)) return false; p[activeProfile] = capture(); saveProfiles(p); setStatus(`Updated profile "${activeProfile}".`, 1600); return true; }
    function deleteProfile(name) { const p = loadProfiles(); if (!(name in p)) return; delete p[name]; saveProfiles(p); if (activeProfile === name) setActive(null); }
    function renameProfile(oldName, newName) { const nm = (newName || "").trim(); if (!nm || nm === oldName) return false; const p = loadProfiles(); if (!(oldName in p) || nm in p) return false; p[nm] = p[oldName]; delete p[oldName]; saveProfiles(p); if (activeProfile === oldName) setActive(nm); return true; }

    // Exposed for the header Layout dropdown (MENU_ITEMS.layout) + E2E.
    layoutCtl = {
      isEditing: () => editing,
      toggleEdit: () => setEditing(!editing),
      registerBar,
      reset, applyProfile, deleteProfile, renameProfile, save: persist,
      saveProfile, updateActive,
      activeProfile: () => activeProfile,
      isDirty,
      saveProfilePrompt: () => floatingInput({ title: "Save layout as profile", value: activeProfile || "", placeholder: "profile name", onCommit: (nm) => { if (saveProfile(nm)) setStatus(`Saved layout profile "${nm}".`, 1800); } }),
      renamePrompt: (name) => floatingInput({ title: "Rename profile", value: name, onCommit: (n) => { if (!renameProfile(name, n) && n !== name) setStatus(`A profile named "${n}" already exists.`, 2400); } }),
      listProfiles: () => Object.keys(loadProfiles()),
    };
    window.__layout = layoutCtl;
  }
  // Right dock is resizable — drag the handle on its left edge (width persisted).
  {
    const dock = document.querySelector("#rightdock");
    const handle = document.querySelector("#dock-resizer");
    const DOCK_KEY = "hector-vector:dock-w";
    const saved = parseInt(localStorage.getItem(DOCK_KEY) || "", 10);
    if (dock && saved >= 200 && saved <= 560) dock.style.width = saved + "px";
    if (dock && handle) {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = dock.getBoundingClientRect().width;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => { dock.style.width = Math.max(200, Math.min(560, startW + (startX - ev.clientX))) + "px"; };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          try { localStorage.setItem(DOCK_KEY, String(Math.round(dock.getBoundingClientRect().width))); } catch {}
          requestAnimationFrame(() => measureFit(viewports.output));
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }
  }
  // (The History/Layers vertical resizer is gone — docked panels share the column
  // height equally now that they're freely reorderable.)
  // Collapsible rail sections (Photopea/Illustrator-style accordion), persisted. Shared so
  // dynamically-built panels (Properties, Colour) get a working caret too.
  function wireSectionCollapse(section) {
    const head = section.querySelector(".section-head"); if (!head || head._collapseWired) return;
    head._collapseWired = true;
    const key = "hv-sec-" + section.dataset.section;
    if (localStorage.getItem(key) === "1") section.classList.add("collapsed");
    head.addEventListener("click", (e) => {
      // action clicks or a just-finished drag don't collapse — but a plain click does,
      // whether the panel is docked OR floating (a drag sets head._docking to opt out).
      if (e.target.closest(".panel-actions") || head._docking) return;
      const c = section.classList.toggle("collapsed");
      try { localStorage.setItem(key, c ? "1" : "0"); } catch {}
      const win = head.closest(".dock-window");
      if (win) win.style.height = c ? "auto" : "";   // floating: shrink to the header when collapsed
      if (window.__docks) { window.__docks.relayout(); window.__docks.reflowGroups(); }   // docks split + grouped (snapped) members hug
    });
  }
  document.querySelectorAll(".rail-section[data-section]").forEach(wireSectionCollapse);

  // ---- Dockable panels: drag a panel's header to detach/float, drop on a dock to attach;
  //      panels reorder within a dock; History/Layers/Properties are all the same object;
  //      one toggle folds BOTH side docks; empty docks auto-close, fill auto-opens. ----
  {
    const leftDock = document.querySelector("#leftdock");
    const rightDock = document.querySelector("#rightdock");
    const grid = document.querySelector(".editor-grid");
    const railToggle = document.querySelector("#rail-toggle");
    const DOCKS_KEY = "hector-vector:docks", FOLD_KEY = "hector-vector:sides-folded";
    const ORDER = ["history", "layers", "library", "processor", "properties", "color", "info", "jobs"];   // home identity order
    const dockElFor = (side) => (side === "left" ? leftDock : rightDock);
    let folded = localStorage.getItem(FOLD_KEY) === "1";

    // Properties + Colour aren't in the HTML — build their sections once (same chrome as
    // History/Layers: caret-collapsible, drag header to detach/dock, × only while floating).
    // Default header action tile: Colour → cycle-background, Object → invert-space. The
    // header's action area is a customize-layout RECEIVER (drag toolbar tiles into it),
    // so the remaining width is a blank slot you can drop another tool into.
    const HDR_SLOTS = {
      color: { id: "hdr-bg", g: "◧", t: "Cycle background (b)", fn: () => cycleBg("output") },
      properties: { id: "hdr-invert", g: "⊠", t: "Invert space — fill the gaps", fn: () => editor.invertSpace() },
    };
    const mkPanel = (name, label, extraClass) => {
      const s = document.createElement("div");
      s.className = "rail-section " + name + (extraClass ? " " + extraClass : ""); s.dataset.section = name;
      s.innerHTML = `<div class="panel-head section-head"><span class="caret">▾</span>`
        + `<span class="sec-label fp-title">${label}</span><span class="sec-count"></span>`
        + `<div class="panel-actions hdr-slots"></div></div>`
        + `<div class="section-body fp-body"></div>`
        + (name === "properties" ? `<div class="insp-foot"></div>` : "");   // pinned chin: align-to-artboard bar
      const actions = s.querySelector(".panel-actions");
      const slot = HDR_SLOTS[name];
      if (slot) { const b = document.createElement("button"); b.type = "button"; b.id = slot.id; b.className = "tool-button"; b.title = slot.t; b.textContent = slot.g; b.addEventListener("click", (e) => { e.stopPropagation(); slot.fn(); }); actions.appendChild(b); }
      const x = document.createElement("button"); x.type = "button"; x.className = "tool-button fp-close panel-x"; x.title = "Dock to rail"; x.textContent = "×";
      x.addEventListener("click", (e) => { e.stopPropagation(); close(name); });
      actions.appendChild(x);
      bindHeaderDrag(s); wireSectionCollapse(s);
      if (window.__layout && window.__layout.registerBar) window.__layout.registerBar("hdr-" + name, actions);
      return s;
    };
    let propsSection = null, colorSection = null, infoSection = null;
    function ensureProps() { if (!propsSection) propsSection = mkPanel("properties", "Properties", "context-panel"); return propsSection; }
    function ensureColor() { if (!colorSection) colorSection = mkPanel("color", "Colour"); return colorSection; }
    function ensureInfo() { if (!infoSection) infoSection = mkPanel("info", "Info"); return infoSection; }   // a standard panel object (no ghostly context-panel chrome)
    const sectionEl = (name) => name === "properties" ? propsSection : name === "color" ? colorSection : name === "info" ? infoSection : document.querySelector(`.rail-section[data-section="${name}"]`);
    const isFloat = (name) => { const s = sectionEl(name); return !!(s && s.closest(".dock-window")); };
    const curLoc = (name) => { if (state[name] && state[name].loc === "shelf") return "shelf"; if (groupOf(name)) return "float"; const s = sectionEl(name); if (!s || !s.parentElement) return null; if (s.closest(".dock-window")) return "float"; return s.parentElement === leftDock ? "left" : "right"; };

    const DEFAULT_LOC = { history: "right", layers: "right", library: "right", processor: "right", properties: "right", color: "right", info: "shelf", jobs: "right" };
    // Shelf squares: a glyph + label per panel (parked/unused panels show as these).
    const SHELF_GLYPH = { history: "⟲", layers: "▤", library: "⊞", processor: "▸", properties: "☰", color: "◧", info: "ⓘ", jobs: "☷" };
    const PANEL_LABEL = { history: "History", layers: "Layers", library: "Library", processor: "Processor", properties: "Properties", color: "Colour", info: "Info", jobs: "Jobs" };
    let state = {};
    ORDER.forEach((n, i) => state[n] = { loc: DEFAULT_LOC[n], order: i, rect: null, visible: false });
    try { const s = JSON.parse(localStorage.getItem(DOCKS_KEY) || "null"); if (s) for (const n of ORDER) if (s[n]) state[n] = { ...state[n], ...s[n] }; } catch {}
    // Properties + Colour are permanent panel items now — a previously CLOSED one (float +
    // invisible) returns to its dock so panels can never go missing.
    for (const n of ["properties", "color"]) if (state[n].loc === "float" && !state[n].visible) state[n].loc = DEFAULT_LOC[n] || "right";
    // Locking-bezel groups: snapped floating panels tiled in one container (one axis).
    //   gid -> { axis:"row"|"col", members:[name…], rect:{x,y,w,h}, frac:[n…] (sums to 1) }
    const GROUPS_KEY = "hector-vector:dock-groups";
    let groups = {};
    try { const g = JSON.parse(localStorage.getItem(GROUPS_KEY) || "null"); if (g && typeof g === "object") groups = g; } catch {}
    // Drop members that no longer exist / empties / singletons (a group needs ≥2 panels).
    for (const gid of Object.keys(groups)) {
      const gp = groups[gid];
      if (!gp || !Array.isArray(gp.members)) { delete groups[gid]; continue; }
      gp.members = gp.members.filter((n) => ORDER.includes(n));
      if (gp.members.length < 2) delete groups[gid];
    }
    const groupOf = (name) => Object.keys(groups).find((gid) => groups[gid].members.includes(name)) || null;
    let gidSeq = 0;
    const persist = () => { try { localStorage.setItem(DOCKS_KEY, JSON.stringify(state)); localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); localStorage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch {} };
    const isShown = (name) => { const l = state[name].loc; if (l === "left" || l === "right") return true; if (l === "float") return state[name].visible; return false; };   // "shelf" / anything else → not shown
    const propsVisible = () => isShown("properties");

    function renderProps() {
      if (!propsSection || !propsSection.parentElement || !propsVisible()) return;
      const title = propsSection.querySelector(".fp-title"), body = propsSection.querySelector(".fp-body");
      if (!body) return;
      // Preserve scroll across the rebuild. The raster Process stages live in this
      // body, and toggling live-preview / changing a stage setting re-renders the
      // whole panel — without this, scrollTop snaps to 0 and the content jumps out
      // from under the cursor (the reported "pressing buttons jumps the scroll" bug).
      const keepScroll = body.scrollTop;
      body.innerHTML = "";
      // Bottom chin: the align-to-artboard bar (null unless a non-artboard object is selected).
      const foot = propsSection.querySelector(".insp-foot");
      if (foot) { foot.innerHTML = ""; const bar = editor._alignBar && editor._alignBar(); if (bar) foot.appendChild(bar); }
      if (!editor.stage) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">No canvas.</div>`; return; }
      if (editor.artboardSelected) { title.textContent = "Artboard"; body.appendChild(editor._artboardPanel()); body.scrollTop = keepScroll; return; }
      let nodes = editor._effectiveLeaves(); if (!nodes.length) nodes = editor.selectedNodes();
      if (!nodes.length) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">Select an object, or right-click the canvas for the artboard.</div>`; return; }
      title.textContent = editor._selectionIsRaster()
        ? (nodes.length === 1 ? "Raster" : `${nodes.length} rasters`)
        : (nodes.length === 1 ? "Object" : `${nodes.length} objects`);
      body.appendChild(editor._objectPanel(nodes));
      body.scrollTop = keepScroll;
    }
    // Colour panel hosts the live duo editor (built by the swatch block). Only rebuild on a
    // real selection-SET change — colour edits don't change the set, so the editor isn't
    // torn down mid-interaction.
    let lastColorKey = null;
    function renderColor() {
      if (!colorSection || !colorSection.parentElement || !isShown("color") || typeof editor._renderColorPanel !== "function") return;
      const body = colorSection.querySelector(".section-body"); if (!body) return;
      const key = [...(editor.selection || [])].sort().join(",") + "|" + !!editor.artboardSelected;
      if (key === lastColorKey && body.querySelector(".cp-window")) return;
      lastColorKey = key; editor._renderColorPanel(body);
    }
    function renderPanels() { renderProps(); renderColor(); if (typeof renderLibrary === "function") renderLibrary(); if (typeof renderJobsPanel === "function") renderJobsPanel(); if (typeof renderProcessorPanel === "function") renderProcessorPanel(); }

    // Hidden holding area for parked (shelved / contextually-hidden) sections. They stay
    // in the DOM here (display:none) so HTML panels remain querySelector-able and can be
    // re-homed later — removing them outright orphans them (the disappearing-panel class).
    let attic = null;
    const theAttic = () => { if (!attic) { attic = document.createElement("div"); attic.id = "dock-attic"; attic.style.display = "none"; document.body.appendChild(attic); } return attic; };
    function detachFromWindow(name) {
      const s = sectionEl(name); if (!s) return;
      const w = s.closest(".dock-window");
      theAttic().appendChild(s);   // park (keeps it in the DOM) instead of removing
      if (w) { if (w._ro) w._ro.disconnect(); w.remove(); }
    }
    const SUMMONED = new Set(["properties", "color", "info"]);   // built on demand, summon/close-able
    function ensureSection(name) { return name === "properties" ? ensureProps() : name === "color" ? ensureColor() : name === "info" ? ensureInfo() : sectionEl(name); }
    // Preferred height to FIT the panel's content (header + full body + chin), so a panel
    // dragged out of a dock floats at a size that matches its content rather than whatever
    // slice of the rail it happened to occupy. Falls back to a sane default when collapsed.
    function contentHeight(s) {
      const head = s.querySelector(".panel-head, .section-head");
      const body = s.querySelector(".section-body, .fp-body");
      const chin = s.querySelector(".library-chin, .insp-foot, .layers-foot, .processor-chin");
      let h = 10;
      if (head) h += head.offsetHeight;
      h += (body && body.scrollHeight > 20) ? body.scrollHeight : 280;
      if (chin && chin.offsetHeight) h += chin.offsetHeight;
      return h;
    }
    // Footprints of every currently-floating panel/group (to place new floats clear of them).
    function floatingRects() {
      const out = [];
      document.querySelectorAll(".dock-window, .dock-group").forEach((el) => { const r = el.getBoundingClientRect(); out.push({ x: r.left, y: r.top, w: r.width, h: r.height }); });
      return out;
    }
    const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    // An ideal spot for a fresh float: start right-of-centre (clear of the canvas + left
    // tools), cascade down-right until it doesn't overlap an existing float, clamp on-screen.
    function idealFloatPlacement(w, h) {
      const existing = floatingRects();
      const baseX = Math.max(8, Math.round((innerWidth - w) * 0.6));
      const baseY = 72, step = 30;
      let fallback = null;
      for (let i = 0; i < 8; i++) {
        const x = Math.min(baseX + i * step, Math.max(8, innerWidth - w - 8));
        const y = Math.min(baseY + i * step, Math.max(8, innerHeight - h - 8));
        if (!fallback) fallback = { x, y };
        if (!existing.some((e) => rectsOverlap({ x, y, w, h }, e))) return { x, y };
      }
      return fallback || { x: baseX, y: baseY };
    }
    function ensureFloatWin(name, atX, atY) {
      const s = ensureSection(name); if (!s) return null;
      let w = s.closest(".dock-window"); if (w) return w;
      const r = s.getBoundingClientRect(), prev = state[name].rect, detaching = atX != null;
      // SIZE — remembered float size wins (memory); otherwise fit the content: a sane panel
      // width + the content's natural height. Always clamp to the viewport so a tall panel
      // (e.g. the Library) opens on-screen and scrolls inside instead of running off.
      const naturalW = r.width > 40 ? r.width : 280;
      const ww = Math.min((detaching ? Math.max(240, naturalW) : (prev?.w || Math.max(240, naturalW))), innerWidth - 16);
      const wh = Math.min((detaching ? Math.max(180, contentHeight(s)) : (prev?.h || Math.max(180, contentHeight(s)))), innerHeight - 16);
      // POSITION — an explicit drop point wins, then remembered position (memory), then an
      // algorithmically ideal slot: right-of-centre, cascading to avoid overlapping panels.
      let x, y;
      if (atX != null) { x = atX; y = atY; }
      else if (prev) { x = prev.x; y = prev.y; }
      else { const p = idealFloatPlacement(ww, wh); x = p.x; y = p.y; }
      x = Math.max(0, Math.min(x, innerWidth - ww));   // keep fully on-screen
      y = Math.max(0, Math.min(y, innerHeight - wh));
      w = document.createElement("div");
      w.className = "dock-window" + (SUMMONED.has(name) ? " float-panel" : "");
      w.dataset.dockWindow = name;
      w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = ww + "px"; w.style.height = wh + "px";
      document.body.appendChild(w); w.appendChild(s);
      s.style.flex = "";   // shed the docked flex (inline 0 0 Npx) so the section fills the float window instead of staying fixed-height
      s.classList.remove("collapsed");
      addResizeHandles(w, name);
      w._ro = new ResizeObserver(() => { const b = w.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); });
      w._ro.observe(w);
      return w;
    }
    // 8-way resize: thin edge + corner handles adjust left/top/width/height, clamped to
    // min size and the viewport, then persist the rect.
    function addResizeHandles(win, name) {
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        const h = document.createElement("div");
        h.className = "dock-rs dock-rs-" + dir;
        h.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const r = win.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY, x0 = r.left, y0 = r.top, w0 = r.width, h0 = r.height;
          const MINW = 190, MINH = 120;
          const mv = (ev) => {
            let x = x0, y = y0, ww = w0, wh = h0;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (dir.includes("e")) ww = Math.max(MINW, w0 + dx);
            if (dir.includes("s")) wh = Math.max(MINH, h0 + dy);
            if (dir.includes("w")) { ww = Math.max(MINW, w0 - dx); x = x0 + (w0 - ww); }
            if (dir.includes("n")) { wh = Math.max(MINH, h0 - dy); y = y0 + (h0 - wh); }
            ww = Math.min(ww, innerWidth - 8); wh = Math.min(wh, innerHeight - 8);
            x = Math.max(0, Math.min(x, innerWidth - ww)); y = Math.max(0, Math.min(y, innerHeight - wh));
            win.style.left = x + "px"; win.style.top = y + "px"; win.style.width = ww + "px"; win.style.height = wh + "px";
          };
          const up = () => {
            window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
            const b = win.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist();
          };
          window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
        });
        win.appendChild(h);
      }
    }

    // ====================== Locking-bezel groups (floating only) ======================
    const SNAP = 16;   // px proximity to snap a dragged panel flush to another's edge
    const normFrac = (gp) => { const s = gp.frac.reduce((a, b) => a + b, 0) || 1; gp.frac = gp.frac.map((f) => f / s); };

    // The seam between two adjacent members: drag to redistribute, double-click to split.
    function mkBezel(gid, i) {
      const bz = document.createElement("div");
      bz.className = "dock-bezel";
      bz.title = "Drag to resize · double-click to detach";
      bz.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); splitGroup(gid, i); });
      bz.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const gp = groups[gid]; if (!gp) return;
        const cont = bezelContainer(gid); if (!cont) return;
        const row = gp.axis === "row";
        const total = row ? cont.getBoundingClientRect().width : cont.getBoundingClientRect().height;
        const f0 = gp.frac[i - 1], f1 = gp.frac[i], sum = f0 + f1;
        const start = row ? e.clientX : e.clientY;
        const mv = (ev) => {
          const d = ((row ? ev.clientX : ev.clientY) - start) / Math.max(1, total);
          const lo = 0.12 * sum;   // keep both members usefully sized
          const a = Math.max(lo, Math.min(sum - lo, f0 + d));
          gp.frac[i - 1] = a; gp.frac[i] = sum - a; applyFracs(gid);
        };
        const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); persist(); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
      return bz;
    }
    const bezelContainer = (gid) => document.querySelector(`.dock-group[data-group="${gid}"]`);
    // Collapsed members hug their header (flex 0 0 auto) so they don't reserve a blank
    // slot; expanded members share the space by fraction. With ALL members collapsed the
    // container folds to the stacked headers (height auto), else it keeps its rect height.
    function applyFracs(gid) {
      const gp = groups[gid], cont = bezelContainer(gid); if (!gp || !cont) return;
      let allCollapsed = true;
      gp.members.forEach((name, i) => {
        const s = sectionEl(name); if (!s) return;
        const col = s.classList.contains("collapsed");
        if (!col) allCollapsed = false;
        s.style.flex = col ? "0 0 auto" : (gp.frac[i] * gp.members.length).toFixed(4) + " 1 0%";
      });
      cont.style.height = allCollapsed ? "auto" : ((gp.rect && gp.rect.h) ? gp.rect.h + "px" : "");
    }

    // 8-way resize of the whole group container — flex children scale together.
    function addGroupResize(cont, gid) {
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        const h = document.createElement("div"); h.className = "dock-rs dock-rs-" + dir;
        h.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
          const r = cont.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY, x0 = r.left, y0 = r.top, w0 = r.width, h0 = r.height;
          const MINW = 220, MINH = 140;
          const mv = (ev) => {
            let x = x0, y = y0, ww = w0, wh = h0; const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (dir.includes("e")) ww = Math.max(MINW, w0 + dx);
            if (dir.includes("s")) wh = Math.max(MINH, h0 + dy);
            if (dir.includes("w")) { ww = Math.max(MINW, w0 - dx); x = x0 + (w0 - ww); }
            if (dir.includes("n")) { wh = Math.max(MINH, h0 - dy); y = y0 + (h0 - wh); }
            ww = Math.min(ww, innerWidth - 8); wh = Math.min(wh, innerHeight - 8);
            x = Math.max(0, Math.min(x, innerWidth - ww)); y = Math.max(0, Math.min(y, innerHeight - wh));
            cont.style.left = x + "px"; cont.style.top = y + "px"; cont.style.width = ww + "px"; cont.style.height = wh + "px";
          };
          const up = () => {
            window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
            const b = cont.getBoundingClientRect(); if (groups[gid]) { groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); }
          };
          window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
        });
        cont.appendChild(h);
      }
    }

    // Drag any member's header to MOVE the whole group (bound once per container).
    function bindGroupMove(cont, gid) {
      cont.addEventListener("pointerdown", (e) => {
        const head = e.target.closest(".section-head"); if (!head || e.button !== 0) return;
        if (e.target.closest(".panel-actions")) return;   // × / header tiles keep their own handlers
        const gp = groups[gid]; if (!gp) return;
        const r = cont.getBoundingClientRect(); const offX = e.clientX - r.left, offY = e.clientY - r.top;
        const sx = e.clientX, sy = e.clientY; let moved = false;
        const mv = (ev) => {
          if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          moved = true; cont.classList.add("dragging"); head._docking = true;
          const x = Math.max(0, Math.min(ev.clientX - offX, innerWidth - 60));
          const y = Math.max(0, Math.min(ev.clientY - offY, innerHeight - 30));
          cont.style.left = x + "px"; cont.style.top = y + "px";
        };
        const up = () => {
          window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
          cont.classList.remove("dragging");
          if (moved && groups[gid]) { const b = cont.getBoundingClientRect(); groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); setTimeout(() => { head._docking = false; }, 0); }
        };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
    }

    // (Re)build every group container from `groups`: tile the member sections along the
    // group axis with a draggable bezel between each pair; scale via flex.
    function renderGroups() {
      // Build/populate live group containers FIRST — moving member sections into them
      // while they're still in the DOM — THEN remove stale containers. (HTML panels are
      // located by querySelector, so a stale container removed first would take its child
      // sections with it and orphan them — the disappearing-panel bug.)
      for (const gid of Object.keys(groups)) {
        const gp = groups[gid];
        if (!gp.frac || gp.frac.length !== gp.members.length) gp.frac = gp.members.map(() => 1 / gp.members.length);
        normFrac(gp);
        let cont = bezelContainer(gid);
        if (!cont) {
          cont = document.createElement("div"); cont.className = "dock-group"; cont.dataset.group = gid;
          document.body.appendChild(cont); addGroupResize(cont, gid); bindGroupMove(cont, gid);
          cont._ro = new ResizeObserver(() => { const b = cont.getBoundingClientRect(); if (groups[gid]) { groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; } });
          cont._ro.observe(cont);
        }
        cont.classList.toggle("col", gp.axis === "col");
        const rc = gp.rect || { x: 80, y: 80, w: 520, h: 320 };
        cont.style.left = rc.x + "px"; cont.style.top = rc.y + "px"; cont.style.width = rc.w + "px"; cont.style.height = rc.h + "px";
        // Re-order children: section, bezel, section, … (appendChild moves existing nodes).
        cont.querySelectorAll(":scope > .dock-bezel").forEach((b) => b.remove());
        const handles = [...cont.querySelectorAll(":scope > .dock-rs")];
        gp.members.forEach((name, i) => {
          const s = ensureSection(name); if (!s) return;
          const w = s.closest(".dock-window"); if (w && w !== cont) { if (w._ro) w._ro.disconnect(); w.remove(); }
          if (i > 0) cont.appendChild(mkBezel(gid, i));
          cont.appendChild(s);
        });
        handles.forEach((h) => cont.appendChild(h));   // keep resize handles on top
        applyFracs(gid);   // size members by fraction (collapsed ones hug their header)
      }
      // now-empty stale containers (their sections were re-homed above or floated by reconcile)
      document.querySelectorAll(".dock-group").forEach((c) => { if (!groups[c.dataset.group]) { if (c._ro) c._ro.disconnect(); c.remove(); } });
    }

    // Pull a floating panel (or a whole group) into a group with `target` on `side`.
    // target: a panel name (standalone float) OR a gid (string starting "g:"). side:
    // "left"|"right" → row, "top"|"bottom" → col.
    function joinGroup(dragName, target, side) {
      const axis = (side === "left" || side === "right") ? "row" : "col";
      const before = (side === "left" || side === "top");
      const dragRect = winRect(dragName);
      const along = axis === "row" ? "w" : "h";
      let gid = (typeof target === "string" && groups[target]) ? target : null;
      if (gid) {
        const gp = groups[gid]; if (gp.axis !== axis) return false;
        const share = Math.max(0.12, Math.min(0.6, (dragRect[along]) / (gp.rect[along] + dragRect[along])));
        gp.frac = gp.frac.map((f) => f * (1 - share));
        if (before) { gp.members.unshift(dragName); gp.frac.unshift(share); }
        else { gp.members.push(dragName); gp.frac.push(share); }
        if (axis === "row") gp.rect.w += dragRect.w; else gp.rect.h += dragRect.h;
      } else {
        // target is a standalone panel → make a new 2-member group
        const tname = target; const tRect = winRect(tname);
        gid = "g:" + (++gidSeq) + ":" + Date.now().toString(36);
        const members = before ? [dragName, tname] : [tname, dragName];
        const fa = dragRect[along], fb = tRect[along], sum = fa + fb || 1;
        const frac = before ? [fa / sum, fb / sum] : [fb / sum, fa / sum];
        const rect = axis === "row"
          ? { x: Math.min(dragRect.x, tRect.x), y: tRect.y, w: dragRect.w + tRect.w, h: Math.max(dragRect.h, tRect.h) }
          : { x: tRect.x, y: Math.min(dragRect.y, tRect.y), w: Math.max(dragRect.w, tRect.w), h: dragRect.h + tRect.h };
        groups[gid] = { axis, members, frac, rect };
      }
      // both panels are now grouped → mark float + drop their standalone windows
      for (const n of [dragName, target].filter((n) => state[n])) { state[n].loc = "float"; if (SUMMONED.has(n)) state[n].visible = true; }
      reconcile(); persist();
      return true;
    }
    const winRect = (name) => { const s = sectionEl(name); const w = s && s.closest(".dock-window"); const r = (w || s)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 80, y: 80, w: 260, h: 300 }; };

    // Split a group at member index `i`: members [0..i) stay, [i..) leave. A side that
    // ends up with a single member becomes a standalone floating window again.
    function splitGroup(gid, i) {
      const gp = groups[gid]; if (!gp || i <= 0 || i >= gp.members.length) return;
      const leftNames = gp.members.slice(0, i), rightNames = gp.members.slice(i);
      const rc = gp.rect, row = gp.axis === "row";
      const cont = bezelContainer(gid);
      const total = cont ? (row ? cont.getBoundingClientRect().width : cont.getBoundingClientRect().height) : (row ? rc.w : rc.h);
      const leftFrac = gp.frac.slice(0, i).reduce((a, b) => a + b, 0);
      const sizeL = Math.round(total * leftFrac), sizeR = (row ? rc.w : rc.h) - sizeL;
      delete groups[gid];
      const mkSide = (names, offset, size) => {
        if (names.length === 1) {
          const n = names[0];
          state[n].rect = row ? { x: rc.x + offset, y: rc.y, w: size, h: rc.h } : { x: rc.x, y: rc.y + offset, w: rc.w, h: size };
          state[n].loc = "float"; if (SUMMONED.has(n)) state[n].visible = true;
        } else {
          const ngid = "g:" + (++gidSeq) + ":" + Date.now().toString(36);
          const fr = names.map((n) => gp.frac[gp.members.indexOf(n)]);
          const rect = row ? { x: rc.x + offset, y: rc.y, w: size, h: rc.h } : { x: rc.x, y: rc.y + offset, w: rc.w, h: size };
          groups[ngid] = { axis: gp.axis, members: names, frac: fr, rect };
          normFrac(groups[ngid]);
        }
      };
      mkSide(leftNames, 0, sizeL);
      mkSide(rightNames, sizeL + 8, sizeR - 8);
      reconcile(); persist();
    }

    // While dragging window `rect` (excluding `self`), find a flush-snap target: the
    // nearest standalone-float panel or group whose opposite edge is within SNAP and
    // overlaps on the perpendicular axis. Returns { target, side } or null.
    function snapTarget(rect, self) {
      const cands = [];
      document.querySelectorAll(".dock-window").forEach((w) => {
        const s = w.querySelector(".rail-section"); const n = s && s.dataset.section;
        if (n && n !== self && !groupOf(n)) cands.push({ kind: "panel", id: n, r: w.getBoundingClientRect() });
      });
      for (const gid of Object.keys(groups)) { const c = bezelContainer(gid); if (c) cands.push({ kind: "group", id: gid, axis: groups[gid].axis, r: c.getBoundingClientRect() }); }
      let best = null;
      const overlapY = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const overlapX = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const R = { left: rect.x, right: rect.x + rect.w, top: rect.y, bottom: rect.y + rect.h };
      for (const c of cands) {
        const cr = c.r;
        // horizontal adjacency (row): drag's right↔target left, or drag's left↔target right
        if (overlapY(R, cr) > 24) {
          if (Math.abs(R.right - cr.left) <= SNAP) best = pick(best, { target: c.id, side: "left", d: Math.abs(R.right - cr.left), kind: c.kind, axis: c.axis });
          if (Math.abs(R.left - cr.right) <= SNAP) best = pick(best, { target: c.id, side: "right", d: Math.abs(R.left - cr.right), kind: c.kind, axis: c.axis });
        }
        if (overlapX(R, cr) > 24) {
          if (Math.abs(R.bottom - cr.top) <= SNAP) best = pick(best, { target: c.id, side: "top", d: Math.abs(R.bottom - cr.top), kind: c.kind, axis: c.axis });
          if (Math.abs(R.top - cr.bottom) <= SNAP) best = pick(best, { target: c.id, side: "bottom", d: Math.abs(R.top - cr.bottom), kind: c.kind, axis: c.axis });
        }
      }
      if (best && best.kind === "group") { const want = (best.side === "left" || best.side === "right") ? "row" : "col"; if (best.axis !== want) return null; }
      return best;
    }
    const pick = (a, b) => (!a || b.d < a.d) ? b : a;
    let snapEl = null;
    const snapInd = () => { if (!snapEl) { snapEl = document.createElement("div"); snapEl.className = "dock-snapline hidden"; document.body.appendChild(snapEl); } return snapEl; };
    function showSnap(t, rect) {
      if (!t) { if (snapEl) snapEl.classList.add("hidden"); return; }
      const tr = t.kind === "group" ? bezelContainer(t.target).getBoundingClientRect() : (sectionEl(t.target).closest(".dock-window")).getBoundingClientRect();
      const ind = snapInd(); ind.classList.remove("hidden");
      const vert = (t.side === "left" || t.side === "right");
      const x = t.side === "left" ? tr.left : t.side === "right" ? tr.right : tr.left;
      const y = t.side === "top" ? tr.top : t.side === "bottom" ? tr.bottom : tr.top;
      ind.style.left = (vert ? x - 2 : tr.left) + "px";
      ind.style.top = (vert ? tr.top : y - 2) + "px";
      ind.style.width = (vert ? "4px" : tr.width + "px");
      ind.style.height = (vert ? tr.height + "px" : "4px");
    }

    // Reconcile the DOM from `state` (placement + ordering + dock visibility + grid).
    function reconcile() {
      for (const name of ORDER) {
        const st = state[name];
        if (st.loc === "shelf") { detachFromWindow(name); continue; }   // parked on the shelf
        if (groupOf(name)) continue;   // grouped members are placed by renderGroups()
        if (SUMMONED.has(name) && st.loc === "float" && !st.visible) { detachFromWindow(name); continue; }
        if (st.loc === "float") ensureFloatWin(name);
      }
      for (const side of ["left", "right"]) {
        const dock = dockElFor(side);
        const items = ORDER.filter((n) => state[n].loc === side && !isFloatWanted(n) && !groupOf(n)).sort((a, b) => (state[a].order || 0) - (state[b].order || 0));
        for (const n of items) { const s = ensureSection(n); if (!s) continue; detachWinKeepSection(n); s.style.flex = ""; dock.appendChild(s); }
      }
      renderGroups();
      renderShelf();
      syncChrome();
      renderPanels();   // (re)fill Properties / Colour bodies for their current state
      // Re-clamp on ANY layout change (boot/state-restore, fold, dock/float/shelve), not just
      // window resize — a persisted rect saved on a bigger screen, or a programmatic move, can
      // strand a float/group off-screen. In a normally-sized window this only repositions
      // (width/height are kept unless the element genuinely overflows), so group internals
      // and split fractions stay pristine.
      clampFloatsOnResize();
    }
    const isFloatWanted = (n) => state[n].loc === "float";
    function detachWinKeepSection(name) { const s = sectionEl(name); const w = s && s.closest(".dock-window"); if (w) { if (w._ro) w._ro.disconnect(); w.remove(); document.body.appendChild(s); } }

    // Resize between stacked docked panels: every section but the last in a dock gets an
    // explicit height + a drag handle below it; the last fills the remainder.
    function relayoutDock(side) {
      const dock = dockElFor(side);
      dock.querySelectorAll(".dock-vsep").forEach((s) => s.remove());
      const secs = [...dock.querySelectorAll(":scope > .rail-section")];
      const dockH = dock.getBoundingClientRect().height || 600;
      const even = Math.round(dockH / Math.max(1, secs.length));
      secs.forEach((sec, i) => {
        const name = sec.dataset.section, collapsed = sec.classList.contains("collapsed");
        if (i < secs.length - 1 && !collapsed) {
          // A user-resized panel keeps its explicit height; an untouched one opens at its
          // CONTENT height (so a small panel shrinks to fit instead of claiming a full even
          // slice of empty space), capped at the even share so the stack never overflows.
          const h = state[name].h != null ? state[name].h : Math.max(110, Math.min(even, contentHeight(sec)));
          sec.style.flex = "0 0 " + h + "px";
          const sep = document.createElement("div"); sep.className = "dock-vsep"; sep.title = "Drag to resize";
          bindVSep(sep, sec, name); sec.after(sep);
        } else { sec.style.flex = collapsed ? "0 0 auto" : "1 1 auto"; }
      });
    }
    function bindVSep(sep, sec, name) {
      sep.addEventListener("pointerdown", (e) => {
        e.preventDefault(); sep.setPointerCapture(e.pointerId);
        const startY = e.clientY, startH = sec.getBoundingClientRect().height;
        const mv = (ev) => { const h = Math.max(80, startH + (ev.clientY - startY)); sec.style.flex = "0 0 " + h + "px"; state[name].h = h; };
        const up = () => { sep.removeEventListener("pointermove", mv); sep.removeEventListener("pointerup", up); persist(); };
        sep.addEventListener("pointermove", mv); sep.addEventListener("pointerup", up);
      });
    }

    function syncChrome() {
      const leftHas = !!leftDock.querySelector(".rail-section"), rightHas = !!rightDock.querySelector(".rail-section");
      const leftShown = leftHas && !folded, rightShown = rightHas && !folded;
      leftDock.style.display = leftShown ? "flex" : "none";
      rightDock.style.display = rightShown ? "flex" : "none";
      const cols = [];
      if (leftShown) cols.push("auto");
      cols.push("auto", "minmax(0, 1fr)", "auto");
      if (rightShown) cols.push("auto");
      grid.style.gridTemplateColumns = cols.join(" ");
      relayoutDock("left"); relayoutDock("right");
      if (railToggle) { railToggle.classList.toggle("on", folded); railToggle.title = folded ? "Show side panels" : "Hide side panels"; }
      requestAnimationFrame(() => measureFit(viewports.output));
    }

    // Pull a panel out of its group (if any). A group left with one member dissolves —
    // that member becomes a standalone floating window at the group's current footprint.
    function removeFromGroup(name) {
      const gid = groupOf(name); if (!gid) return;
      const gp = groups[gid], i = gp.members.indexOf(name);
      gp.members.splice(i, 1); gp.frac.splice(i, 1);
      if (gp.members.length < 2) {
        const last = gp.members[0];
        if (last) { const r = (bezelContainer(gid) || {}).getBoundingClientRect ? bezelContainer(gid).getBoundingClientRect() : null; state[last].rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : gp.rect; state[last].loc = "float"; if (SUMMONED.has(last)) state[last].visible = true; }
        delete groups[gid];
      } else { normFrac(gp); }
    }

    function setLoc(name, loc, beforeName) {
      removeFromGroup(name);
      if (loc === "float") { state[name].loc = "float"; if (SUMMONED.has(name)) state[name].visible = true; }
      else {
        // insert into `side`, ordered: before `beforeName` (or at the end)
        const others = ORDER.filter((n) => n !== name && state[n].loc === loc).sort((a, b) => (state[a].order || 0) - (state[b].order || 0));
        const idx = beforeName ? others.indexOf(beforeName) : others.length;
        others.splice(idx < 0 ? others.length : idx, 0, name);
        others.forEach((n, i) => state[n].order = i);
        state[name].loc = loc; if (SUMMONED.has(name)) state[name].visible = true;
      }
      reconcile(); persist();
    }

    // ---- drop targeting + indicator ----
    let dropEl = null;
    const dropInd = () => { if (!dropEl) { dropEl = document.createElement("div"); dropEl.className = "dock-droplines hidden"; document.body.appendChild(dropEl); } return dropEl; };
    const hideDrop = () => { if (dropEl) dropEl.classList.add("hidden"); };
    function dropTarget(x, y) {
      for (const side of ["left", "right"]) {
        const dock = dockElFor(side), r = dock.getBoundingClientRect();
        const shown = dock.style.display !== "none" && r.width > 4;
        const inEdge = side === "left" ? x < Math.max(r.right, 64) : x > Math.min(shown ? r.left : innerWidth, innerWidth - 64);
        if (!inEdge || y < 8 || y > innerHeight - 36) continue;
        const secs = shown ? [...dock.querySelectorAll(":scope > .rail-section")] : [];
        let before = null, lineY = null;
        for (const sec of secs) { const sr = sec.getBoundingClientRect(); if (y < sr.top + sr.height / 2) { before = sec.dataset.section; lineY = sr.top; break; } }
        if (before == null && secs.length) lineY = secs[secs.length - 1].getBoundingClientRect().bottom;   // append → line at the bottom edge
        return { side, before, rect: r, shown, lineY, empty: secs.length === 0 };
      }
      return null;
    }
    function showDrop(t) {
      if (!t) { hideDrop(); return; }
      const ind = dropInd(); ind.classList.remove("hidden");
      const w = t.shown && t.rect.width > 8 ? t.rect.width : 270;
      const left = t.side === "left" ? 0 : innerWidth - w;
      if (t.lineY != null) {   // insertion line between / below existing panels
        ind.classList.add("line"); ind.style.left = left + "px"; ind.style.top = (t.lineY - 2) + "px"; ind.style.width = w + "px"; ind.style.height = "4px";
      } else {                 // empty (or hidden) dock → outline the whole drop zone
        ind.classList.remove("line"); ind.style.left = left + "px"; ind.style.top = (t.shown ? t.rect.top : 56) + "px"; ind.style.width = w + "px"; ind.style.height = (t.shown ? t.rect.height : innerHeight - 120) + "px";
      }
    }

    // ---- unified header drag: works whether the panel is docked or already floating ----
    function bindHeaderDrag(section) {
      const head = section.querySelector(".section-head"); if (!head || head._dragBound) return;
      head._dragBound = true;
      // Right-click a panel header → close it to the shelf (contextual close).
      head.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); shelve(section.dataset.section); });
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".panel-actions") || e.button !== 0) return;
        const name = section.dataset.section;
        if (groupOf(name)) return;   // grouped → the container's bindGroupMove drives the move
        const sx = e.clientX, sy = e.clientY;
        let moved = false, win = section.closest(".dock-window"), offX = 24, offY = 12, snap = null;
        if (win) { const r = win.getBoundingClientRect(); offX = sx - r.left; offY = sy - r.top; }
        const onMove = (ev) => {
          if (!moved) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
            moved = true; head._docking = true;
            if (!win) { win = ensureFloatWin(name, ev.clientX - offX, ev.clientY - offY); state[name].loc = "float"; if (SUMMONED.has(name)) state[name].visible = true; syncChrome(); }
            if (win) win.classList.add("dragging");
          }
          if (!win) return;
          win.style.left = Math.max(0, Math.min(ev.clientX - offX, innerWidth - 60)) + "px";
          win.style.top = Math.max(0, Math.min(ev.clientY - offY, innerHeight - 30)) + "px";
          // Prefer snapping to a floating panel/group edge; fall back to the dock drop zones.
          const r = win.getBoundingClientRect();
          snap = snapTarget({ x: r.left, y: r.top, w: r.width, h: r.height }, name);
          if (snap) { hideDrop(); showSnap(snap, r); }
          else { showSnap(null); showDrop(dropTarget(ev.clientX, ev.clientY)); }
        };
        const onUp = (ev) => {
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          hideDrop(); showSnap(null); if (win) win.classList.remove("dragging");
          if (moved) {
            state[name].pinned = true;   // user placed it by hand → exempt from contextual auto-shelving
            if (snap && joinGroup(name, snap.target, snap.side)) { /* grouped */ }
            else {
              const t = dropTarget(ev.clientX, ev.clientY);
              if (t) setLoc(name, t.side, t.before);
              else { state[name].loc = "float"; if (win) { const b = win.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; } reconcile(); persist(); }
            }
            setTimeout(() => { head._docking = false; }, 0);
          }
        };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
      });
    }
    document.querySelectorAll(".rail-section[data-section]").forEach(bindHeaderDrag);

    // Summon / close a summoned panel (Properties, Colour). Show makes it visible (floating
    // it at x,y if it has no home); close fully hides it (undocking if needed).
    function show(name, x, y) {
      ensureSection(name);
      if (state[name].loc === "shelf") { unshelve(name); }   // bring it off the shelf to a dock
      else if (state[name].loc === "float") {
        state[name].visible = true;
        if (!sectionEl(name).closest(".dock-window")) ensureFloatWin(name, (x != null ? x + 6 : null), (y != null ? y + 6 : null));
      }
      const sec = sectionEl(name);
      if (sec) { sec.classList.remove("collapsed"); try { localStorage.setItem("hv-sec-" + name, "0"); } catch {} }   // focusing a panel expands it
      syncChrome();
      if (name === "color") { lastColorKey = null; renderColor(); }
      else if (name === "info") { /* content set by showInfo */ }
      else renderProps();
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "nearest" });
    }
    // Closing ANY panel parks it on the shelf (as a square). Reopen by clicking the square
    // or summoning it (e.g. ⓘ for Info, the swatch for Colour). Remembers its dock side.
    function close(name) { shelve(name); }
    // shelve(name, auto): a MANUAL close (auto falsy) is sticky — it clears the pin and
    // won't auto-return. An AUTO shelve (the contextual sync parking an unused panel) sets
    // autoShelved so it pops back the moment it's relevant again.
    function shelve(name, auto) {
      removeFromGroup(name);
      const cur = state[name].loc;
      // Remember the FULL prior placement (dock side OR float) so reopening restores it
      // exactly — float panels keep their remembered rect (state.rect) too.
      if (cur === "left" || cur === "right" || cur === "float") state[name].lastLoc = cur;
      state[name].loc = "shelf";
      state[name].autoShelved = !!auto;
      if (!auto) state[name].pinned = false;   // manual close → no longer user-pinned
      if (SUMMONED.has(name)) state[name].visible = false;
      reconcile(); persist();
    }
    function unshelve(name) {
      state[name].autoShelved = false;   // it's shown now; back under contextual management
      const last = state[name].lastLoc;
      if (last === "float") {   // restore it floating (ensureFloatWin uses the remembered rect)
        state[name].loc = "float";
        if (SUMMONED.has(name)) state[name].visible = true;
        reconcile(); persist();
        return;
      }
      const back = (last === "left" || last === "right") ? last
        : ((DEFAULT_LOC[name] === "left" || DEFAULT_LOC[name] === "right") ? DEFAULT_LOC[name] : "right");
      setLoc(name, back);   // setLoc clears the group + reconciles + persists
    }
    // Contextual auto-shelving. A contextual panel parks itself into a shelf square when
    // there's nothing for it to act on, and pops back when it's relevant again — but only
    // the ones the SYSTEM parked (autoShelved) return automatically, and a panel the user
    // explicitly dragged into place (pinned) is never auto-parked (it stays put / dims).
    const CTX_RELEVANT = {
      processor: () => (typeof processorRelevant === "function" ? processorRelevant() : true),
      color: () => !!(editor && (editor.artboardSelected || (editor.selection && editor.selection.size > 0))),
    };
    let syncingCtx = false;
    function syncContextual() {
      if (syncingCtx) return;   // shelve()/unshelve() reconcile → guard against re-entry
      syncingCtx = true;
      try {
        for (const name of Object.keys(CTX_RELEVANT)) {
          if (!state[name]) continue;
          const relevant = !!CTX_RELEVANT[name]();
          if (relevant) {
            if (state[name].loc === "shelf" && state[name].autoShelved) unshelve(name);
          } else if (isShown(name) && !state[name].pinned) {
            shelve(name, true);
          }
        }
      } finally { syncingCtx = false; }
    }
    // Bring a panel off the shelf. Info is special: its body is content-driven, so we
    // refill it with the current context (last-inspected item, else a help state) rather
    // than reopening whatever stale element it last held.
    function openFromShelf(name) { unshelve(name); unshelveInfoCtx(name); }
    function unshelveInfoCtx(name) { if (name === "info" && typeof window.refillInfoContext === "function") window.refillInfoContext(); }
    // Render the shelf squares (one per shelved panel) into the header tray. A shelved
    // contextual panel that isn't currently relevant reads as dimmed.
    function renderShelf() {
      const shelf = document.querySelector("#panel-shelf"); if (!shelf) return;
      shelf.innerHTML = "";
      for (const name of ORDER) {
        if (state[name].loc !== "shelf") continue;
        const b = document.createElement("button"); b.type = "button";
        b.className = "shelf-sq" + (state[name].autoShelved ? " auto" : "");   // auto = parked-by-context (idle), reads muted
        b.dataset.shelf = name;
        b.textContent = SHELF_GLYPH[name] || (PANEL_LABEL[name] || name)[0];
        const label = PANEL_LABEL[name] || name;
        b.title = `${label}${state[name].autoShelved ? " (idle — nothing to act on)" : ""} — click to open, right-click for options`;
        b.addEventListener("click", () => openFromShelf(name));
        // Right-click → choose where it opens (restore / float / dock either side).
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: `Open ${label}`, onClick: () => openFromShelf(name) },
            { label: "Open floating", onClick: () => { state[name].lastLoc = "float"; state[name].rect = null; openFromShelf(name); } },
            { type: "sep" },
            { label: "Dock left", onClick: () => { unshelveInfoCtx(name); setLoc(name, "left"); state[name].pinned = true; } },
            { label: "Dock right", onClick: () => { unshelveInfoCtx(name); setLoc(name, "right"); state[name].pinned = true; } },
          ]);
        });
        shelf.appendChild(b);
      }
    }
    // Fill the Info panel with a built content element and summon it (floating by default).
    function showInfo(title, el) {
      ensureInfo();
      const t = infoSection.querySelector(".fp-title"); if (t) t.textContent = title || "Info";
      const body = infoSection.querySelector(".fp-body"); if (body) { body.innerHTML = ""; if (el) body.appendChild(el); }
      show("info");
    }
    const summonProps = (x, y) => show("properties", x, y);
    const showColor = () => show("color");

    // Fold BOTH side docks in/out with one control.
    if (railToggle) railToggle.addEventListener("click", () => { folded = !folded; reconcile(); persist(); });
    // Left dock width resizer (mirrors the right one).
    {
      const lh = document.querySelector("#leftdock-resizer");
      if (lh) lh.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startX = e.clientX, startW = leftDock.getBoundingClientRect().width;
        lh.setPointerCapture(e.pointerId);
        const mv = (ev) => { leftDock.style.width = Math.max(200, Math.min(560, startW + (ev.clientX - startX))) + "px"; };
        const up = () => { lh.removeEventListener("pointermove", mv); lh.removeEventListener("pointerup", up); requestAnimationFrame(() => measureFit(viewports.output)); };
        lh.addEventListener("pointermove", mv); lh.addEventListener("pointerup", up);
      });
    }

    // Floating panels + groups carry absolute pixel rects. The window can SHRINK below
    // those coords (e.g. moving a 4K layout onto a 1080p screen, or just narrowing the
    // window), which would strand a float off-screen — and off-screen means its drag
    // handle is gone too, so it's unreachable. On resize, clamp every float/group back
    // into the viewport (and re-store its rect so the position sticks + persists).
    function clampFloatsOnResize() {
      let changed = false;
      const fit = (el, store) => {
        const r = el.getBoundingClientRect();
        const w = Math.min(r.width, innerWidth - 8);
        const h = Math.min(r.height, innerHeight - 8);
        const x = Math.max(0, Math.min(r.left, innerWidth - w));
        const y = Math.max(0, Math.min(r.top, innerHeight - h));
        if (x === r.left && y === r.top && w === r.width && h === r.height) return;
        el.style.left = x + "px"; el.style.top = y + "px";
        el.style.width = w + "px"; el.style.height = h + "px";
        if (store) store({ x, y, w, h });
        changed = true;
      };
      document.querySelectorAll(".dock-window").forEach((el) => {
        const name = el.dataset.dockWindow;
        fit(el, (rect) => { if (state[name]) state[name].rect = rect; });
      });
      document.querySelectorAll(".dock-group").forEach((el) => {
        const gid = el.dataset.group;
        fit(el, (rect) => { if (groups[gid]) groups[gid].rect = rect; });
      });
      if (changed) persist();
    }
    let _clampRAF = 0;
    window.addEventListener("resize", () => {
      if (_clampRAF) return;
      _clampRAF = requestAnimationFrame(() => { _clampRAF = 0; clampFloatsOnResize(); });
    });

    reconcile();
    window.__docks = {
      float: (n) => setLoc(n, "float"), dock: (n, side, before) => setLoc(n, side || "right", before),
      clampFloats: clampFloatsOnResize,
      loc: curLoc, isFolded: () => folded, toggleFold: () => { folded = !folded; reconcile(); persist(); },
      summonProps, showColor, showInfo, close, shelve, unshelve, syncContextual, renderProps, renderPanels, renderColor, propsVisible,
      relayout: () => { relayoutDock("left"); relayoutDock("right"); },
      reflowGroups: () => { for (const gid of Object.keys(groups)) applyFracs(gid); },
      state: () => state,
      // Locking-bezel groups (floating panels). join/split are also driven by drag + the
      // bezel; these expose the same operations for scripting + E2E.
      groups: () => groups,
      groupOf,
      joinGroup: (drag, target, side) => joinGroup(drag, target, side),
      splitGroup: (gid, i) => splitGroup(gid, i),
    };
  }

  // ---- PWA install (surfaced as a File-menu item; one-click path to WCO) ----
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); pwaInstallPrompt = e; if (appSettingsOpen) openAppSettings(); });
  window.addEventListener("appinstalled", () => { pwaInstallPrompt = null; if (appSettingsOpen) openAppSettings(); });

  // ---- App-window mode (standalone Chromium window launched via launch.sh) ----
  // Adds .app-window so the header acts as the draggable titlebar under the
  // Window-Controls-Overlay, and keeps that header clear of the native control
  // corner. Window min/max/close are left entirely to the native window manager
  // (custom titlebar buttons were removed — they duplicated the OS controls).
  (() => {
    if (!appEl) return;
    const wco = navigator.windowControlsOverlay || null;
    const appMode =
      new URLSearchParams(location.search).has("app") ||
      window.navigator.standalone === true ||
      (wco && wco.visible) ||
      matchMedia("(display-mode: standalone)").matches ||
      matchMedia("(display-mode: window-controls-overlay)").matches;
    if (!appMode) return;
    appEl.classList.add("app-window");
    const sync = () => {
      const wcoOn = !!(wco && wco.visible);
      appEl.classList.toggle("wco", wcoOn);
      if (wcoOn) {
        const r = wco.getTitlebarAreaRect();
        appEl.style.setProperty("--wco-left-inset", Math.max(0, r.x) + "px");
        appEl.style.setProperty("--wco-right-inset", Math.max(0, window.innerWidth - (r.x + r.width)) + "px");
      } else {
        appEl.style.removeProperty("--wco-left-inset");
        appEl.style.removeProperty("--wco-right-inset");
      }
    };
    if (wco) wco.addEventListener("geometrychange", sync);
    window.addEventListener("resize", sync);
    sync();
  })();
}
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); if (modalRootEl.hidden) { if (e.shiftKey) saveAsDocument(); else saveDocument(); } return; }
  if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) editor.redoAction(); else editor.undo(); return; }
  if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); editor.redoAction(); return; }
  if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); editor.duplicate(); return; }
  if (mod && (e.key === "g" || e.key === "G")) { e.preventDefault(); if (e.shiftKey) editor.ungroup(); else editor.group(); return; }
  if (mod && (e.key === "j" || e.key === "J")) { e.preventDefault(); editor.joinNodes(); return; }
  if (mod && e.key === "]") { e.preventDefault(); editor.reorder(e.shiftKey ? "front" : "forward"); return; }
  if (mod && e.key === "[") { e.preventDefault(); editor.reorder(e.shiftKey ? "back" : "backward"); return; }
  if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); editor.copy(); return; }
  if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); editor.cut(); return; }
  if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); editor.paste(); return; }
  if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); editor.selectAll(); return; }
  if (mod && (e.key === "t" || e.key === "T")) { e.preventDefault(); editor.enterTransform("scale"); return; }   // Ctrl/Cmd+T — scale mode
  if (mod && (e.key === "r" || e.key === "R")) { e.preventDefault(); const rb = document.querySelector("#vp-rulers"); if (rb) rb.click(); return; }  // Ctrl/Cmd+R — show/hide rulers + guide marks together
  if (mod) return;
  if (!modalRootEl.hidden) return;
  if (e.key.startsWith("Arrow")) {       // nudge selection (Shift = ×10)
    if (!editor.selection.size) return;
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
    if (d) editor.nudge(d[0], d[1]);
    return;
  }
  if (editor._pen) {     // pen construction owns Enter/Escape while a path is open
    if (e.key === "Enter") { e.preventDefault(); editor._finishPen(true); return; }
    if (e.key === "Escape") { e.preventDefault(); editor._finishPen(false); return; }
  }
  if (editor._curv) {    // curvature construction owns Enter/Escape/Backspace too
    if (e.key === "Enter") { e.preventDefault(); editor._curvFinish(true); return; }
    if (e.key === "Escape") { e.preventDefault(); editor._curvFinish(false); return; }
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); editor._curvBack(); return; }
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (editor.tool === "node" && editor._nodeSel && editor._nodeSel.size) { e.preventDefault(); editor.deleteNodeSelection(); return; }
    if (editor.selection.size) { e.preventDefault(); editor.deleteSelection(); }
    return;
  }
  if (e.key === "v" || e.key === "V") { editor.setTool("select"); editor.clearXform(); return; }
  if (e.key === "a" || e.key === "A") { editor.setTool("node"); return; }
  if (e.key === "p" || e.key === "P") { editor.setTool("pen"); return; }
  if (e.key === "c" || e.key === "C") { editor.setTool("curvature"); return; }
  if (e.key === "r" || e.key === "R") { editor.setTool("rect"); return; }
  if (e.key === "e" || e.key === "E") { editor.setTool("ellipse"); return; }
  if (e.key === "l" || e.key === "L") { editor.setTool("line"); return; }
  if (e.key === "Escape" && editor.stage) {
    if (editor._xformMode) { editor.clearXform(); return; }   // first Esc exits scale/rotate
    editor.selection = new Set(); editor.artboardSelected = false; editor._renderSelection(); editor._renderInspector(); editor._showHint();
  }
});


let openMenuEl = null;
function closeMenus() {
  if (!openMenuEl) return;
  const list = openMenuEl.querySelector(".menu-list");
  const trigger = openMenuEl.querySelector(".menu-trigger");
  if (list) list.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  openMenuEl.classList.remove("open");
  openMenuEl = null;
}
function openMenu(menuEl) {
  closeMenus();
  const itemsFn = MENU_ITEMS[menuEl.dataset.menu];
  const list = menuEl.querySelector(".menu-list");
  if (!itemsFn || !list) return;
  list.innerHTML = "";
  for (const item of itemsFn()) {
    if (item.type === "sep") { const sep = document.createElement("div"); sep.className = "menu-sep"; list.appendChild(sep); continue; }
    // a manageable row: a label that activates the item + inline rename / delete buttons
    // (used by the Layout profiles). Re-open the menu after a mutation so the list refreshes.
    const badgeHTML = item.badge ? `<span class="menu-badge">${item.badge}</span>` : "";
    if (item.onRename || item.onDelete) {
      const row = document.createElement("div"); row.className = "menu-item menu-row" + (item.checked ? " checked" : "");
      const lab = document.createElement("button"); lab.type = "button"; lab.className = "menu-rowlabel" + (item.checked ? " checked" : ""); lab.setAttribute("role", "menuitemradio"); lab.setAttribute("aria-checked", item.checked ? "true" : "false");
      lab.innerHTML = `<span class="menu-check">${item.checked ? "✓" : ""}</span><span class="menu-label"></span>${badgeHTML}`;
      lab.querySelector(".menu-label").textContent = item.label;
      lab.addEventListener("click", async () => { closeMenus(); try { await item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); } });
      row.appendChild(lab);
      const reopen = (mut) => { const m = openMenuEl; try { mut(); } catch (e) { setStatus(e.message || String(e), 3000); } closeMenus(); if (m) openMenu(m); };
      if (item.onRename) { const r = document.createElement("button"); r.type = "button"; r.className = "menu-rowbtn"; r.textContent = "✎"; r.title = "Rename"; r.addEventListener("click", (e) => { e.stopPropagation(); reopen(item.onRename); }); row.appendChild(r); }
      if (item.onDelete) { const d = document.createElement("button"); d.type = "button"; d.className = "menu-rowbtn"; d.textContent = "✕"; d.title = "Delete"; d.addEventListener("click", (e) => { e.stopPropagation(); reopen(item.onDelete); }); row.appendChild(d); }
      list.appendChild(row); continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (item.type === "toggle" ? " menu-toggle" : "") + (item.checked ? " checked" : "");
    btn.disabled = !!item.disabled;
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<span class="menu-check">${item.checked ? "✓" : ""}</span><span class="menu-label"></span>${badgeHTML}`;
    btn.querySelector(".menu-label").textContent = item.label;
    btn.addEventListener("click", async () => {
      closeMenus();
      try { await item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); }
    });
    list.appendChild(btn);
  }
  list.hidden = false;
  const trigger = menuEl.querySelector(".menu-trigger");
  if (trigger) trigger.setAttribute("aria-expanded", "true");
  menuEl.classList.add("open");
  openMenuEl = menuEl;
}
document.querySelectorAll(".menu .menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const menuEl = trigger.closest(".menu");
    if (openMenuEl === menuEl) closeMenus(); else openMenu(menuEl);
  });
});
document.addEventListener("click", (event) => {
  if (openMenuEl && !event.target.closest(".menu")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenuEl) closeMenus();
});

// Header shortcuts: Q / Tab swap Edit ⇄ Process (Ableton-style); Shift+F opens the
// File menu. Kept here (not in the view/nav handler, which bails while a modal is
// open) so the swap works *out of* the Process workspace too.
document.addEventListener("keydown", (event) => {
  const tag = (event.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) return;
  if (document.querySelector(".cp-window:not(.cp-embedded)")) return;   // pause keys only for the MODAL picker, not the docked Colour panel
  if ((event.key === "f" || event.key === "F") && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!modalRootEl.hidden) return;        // don't pop the File menu over a modal
    event.preventDefault();
    const m = document.querySelector('.menu[data-menu="file"]');
    if (m) (openMenuEl === m ? closeMenus() : openMenu(m));
  }
});

// ---------- right-click context menu (canvas + objects) ----------
let ctxMenuEl = null;
function hideContextMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
function appendMenuItems(menu, items, afterClick) {
  for (const item of items) {
    if (item.type === "sep") { const s = document.createElement("div"); s.className = "menu-sep"; menu.appendChild(s); continue; }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "menu-item"; btn.disabled = !!item.disabled; btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<span class="menu-check"></span><span class="menu-label"></span>`;
    btn.querySelector(".menu-label").textContent = item.label;
    btn.addEventListener("click", () => {
      try { item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); }
      if (afterClick) afterClick(); else hideContextMenu();
    });
    menu.appendChild(btn);
  }
}
function placeAt(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + "px";
  el.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + "px";
}
function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu menu-list";
  menu.setAttribute("role", "menu");
  appendMenuItems(menu, items, null);
  document.body.appendChild(menu);
  placeAt(menu, x, y);
  ctxMenuEl = menu;
}
// Properties is a fully dockable, permanent panel owned by the Dockable-panels module
// (window.__docks): it lives in a dock (or float/shelf), and its body mirrors the current
// selection (object style / artboard / empty). Right-click the canvas summons it (brings
// it back from the shelf + scrolls it into view); it's never a transient palette. These
// thin wrappers keep the names the rest of the app calls.
function renderFloatPanel() { if (window.__docks) window.__docks.renderPanels(); }
// Tuck a *floating* Properties panel back into its dock so it can't sit over the canvas.
// No-op when it's already docked/shelved (the common case) — Properties never auto-floats.
function hideFloatPanel() { if (window.__docks && window.__docks.loc("properties") === "float") window.__docks.dock("properties"); }
// Header middle indicator: append the current selection after the document name
// ("untitled.svg · Path" / "· 3 objects" / "· Artboard").
function updateSelLabel() {
  const el = document.querySelector("#sel-label"); if (!el) return;
  if (!editor.stage) { el.textContent = ""; return; }
  if (editor.artboardSelected) { el.textContent = " · Artboard"; return; }
  const sel = editor.selectedNodes();
  if (!sel.length) { el.textContent = ""; return; }
  el.textContent = " · " + (sel.length === 1 ? editor.nodeName(sel[0]) : `${sel.length} objects`);
}
function showContextPanel(x, y) {
  hideContextMenu();
  if (window.__docks) window.__docks.summonProps(x, y);
}
function pointMenuItems() {
  const n = editor._nodeSel.size;
  return [
    { label: "Smooth / round", onClick: () => editor.setSelectedAnchorsType("smooth") },
    { label: "Corner / sharpen", onClick: () => editor.setSelectedAnchorsType("corner") },
    { type: "sep" },
    { label: n === 2 ? "Join / close" : "Join (select 2 ends)", disabled: n !== 2, onClick: () => editor.joinNodes() },
    { label: n > 1 ? `Delete ${n} points` : "Delete point", onClick: () => editor.deleteNodeSelection() },
  ];
}
{
  const wrap = document.querySelector(".stage-wrap");
  if (wrap) wrap.addEventListener("contextmenu", (e) => {
    if (!editor.stage) return;
    e.preventDefault();
    if (editor.tool === "node") {                 // right-click an anchor → point menu
      const a = editor.anchorAt(e.clientX, e.clientY);
      if (a) {
        if (!editor._nodeSel.has(a.key)) { editor._nodeSel = new Set([a.key]); editor.mountNodeHandles(); }
        showContextMenu(e.clientX, e.clientY, pointMenuItems());
        return;
      }
    }
    let hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;
    if (hit && editor.stage.contains(hit)) {
      const id = hit.getAttribute("data-hv-id");
      if (!editor.selection.has(id)) {
        editor.selection = new Set([id]); editor.artboardSelected = false;
        editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
      }
      showContextPanel(e.clientX, e.clientY, "object");
    } else {
      editor.selection = new Set(); editor.artboardSelected = true;
      editor._renderSelection(); editor._renderInspector();
      showContextPanel(e.clientX, e.clientY, "canvas");
    }
  });
}
// Click-away closes the context panel — but NOT when the click lands in the colour
// picker it spawned (the picker's backdrop lives outside .context-menu).
document.addEventListener("pointerdown", (e) => {
  if (ctxMenuEl && !e.target.closest(".context-menu") && !e.target.closest(".cp-backdrop")) hideContextMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });   // panels are permanent; Esc only dismisses the transient menu/picker
window.addEventListener("blur", hideContextMenu);
window.addEventListener("pagehide", () => { rememberLastDoc(); editor.dispose(); });   // remember the doc, then free its state on close
// Pen tool: hold Ctrl/Cmd to temporarily act as Direct-Select (move anchors/handles).
document.addEventListener("keydown", (e) => { if ((e.key === "Control" || e.key === "Meta") && editor.tool === "pen") editor.enterPenTempSelect(); });
document.addEventListener("keyup", (e) => { if (e.key === "Control" || e.key === "Meta") editor.exitPenTempSelect(); });
window.addEventListener("blur", () => editor.exitPenTempSelect());

let exportState = { mode: "scale", scale: 16, longest: 1024, width: 0, height: 0, background: "transparent" };
let lastExport = null;   // { blob, url, name, w, h } — the most recent client render, reused by the result actions

// The SVG to export + its native size + an optional library save target. Prefer the
// LIVE canvas (exports exactly what's shown, including unsaved edits) over the saved
// file, and fall back to the on-disk output when there's no editor stage.
function currentExportSource() {
  if (editor && editor.stage) {
    const vb = editor.stage.viewBox && editor.stage.viewBox.baseVal;
    const native = vb && vb.width > 0 ? [Math.round(vb.width), Math.round(vb.height)] : null;
    return { svg: editor.serialize(), native, target: selectedOutput || null };
  }
  return null;
}

// Inline same-origin <image> hrefs as data URIs. An SVG loaded into an <img> renders
// in "secure static mode" — external references (our /outputs, /work-items rasters)
// are BLOCKED and would vanish from the PNG — so bake them in first.
async function inlineSvgImages(svgText) {
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
async function serializeForSave() {
  const raw = editor.serialize();
  if (!raw) return raw;
  let baked = raw;
  try { baked = await inlineSvgImages(raw); } catch { baked = raw; }
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

// Rasterise an SVG string to a PNG Blob on a canvas — the browser's own SVG renderer,
// so curves/strokes/gradients all work without cairosvg or any system tool.
function renderSvgToPngBlob(svgText, w, h, background) {
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

function openExportModal() {
  const src = currentExportSource();
  if (!src) { setStatus("Open or create a canvas first.", 2500); return; }
  const native = src.native;
  openModal("Export PNG", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div");
  root.className = "form";

  // Preview of what's being exported (the live canvas), on a checker so transparency reads.
  const preview = document.createElement("div"); preview.className = "export-preview";
  const pimg = document.createElement("img");
  const previewUrl = URL.createObjectURL(new Blob([src.svg], { type: "image/svg+xml;charset=utf-8" }));
  pimg.src = previewUrl; pimg.alt = "Export preview";
  pimg.addEventListener("load", () => URL.revokeObjectURL(previewUrl), { once: true });
  preview.appendChild(pimg); root.appendChild(preview);

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
      // Browser-side rasterise (no cairosvg). Inline rasters first so they don't drop out.
      const svgText = await inlineSvgImages(src.svg);
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
        manualOutputName = data.name; await refreshAll();
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

let dragDepth = 0;
function clearDragState() {
  dragDepth = 0;
}
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
});
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget) return;
  clearDragState();
});
window.addEventListener("drop", async (event) => {
  // A library drag carries our custom type and is handled on #output-preview; never
  // treat it as a file import here (that's what duplicated dragged lib items).
  if (event.dataTransfer?.types?.includes("application/x-hv-lib")) { clearDragState(); return; }
  if (!event.dataTransfer?.files?.length) {
    clearDragState();
    return;
  }
  event.preventDefault();
  clearDragState();
  try {
    setStatus(`Uploading ${event.dataTransfer.files.length} file(s)…`);
    await uploadFiles(event.dataTransfer.files);
  } catch (error) {
    setStatus(error.message, 4000);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearDragState();
});
fileInputEl.addEventListener("change", async () => {
  const count = fileInputEl.files.length;
  if (!count) return;
  try {
    setStatus(`Uploading ${count} file(s)…`);
    await uploadFiles(fileInputEl.files);
  } catch (error) {
    setStatus(error.message, 4000);
  } finally {
    fileInputEl.value = "";
  }
});
// ⊕ in the Library dock panel header → same add-images gesture as the Process view.
document.querySelector("#library-add")?.addEventListener("click", (e) => { e.stopPropagation(); fileInputEl.click(); });
// Jobs header actions (square tool-buttons): cancel all queued / clear finished.
document.querySelector("#jobs-cancel-all")?.addEventListener("click", (e) => { e.stopPropagation(); cancelAllQueuedJobs(); });
document.querySelector("#jobs-clear")?.addEventListener("click", (e) => { e.stopPropagation(); clearFinishedJobs(); });
// ▸ in the Processor header → run the pipeline (single if a raster is selected, else batch).
document.querySelector("#processor-run")?.addEventListener("click", (e) => {
  e.stopPropagation();
  runProcess(e.currentTarget);
});

// Drop a library cell (raster / vector / project) onto the canvas to load it. Listener
// lives on the persistent #output-preview frame (its children get replaced on mount, but
// the frame element — and this handler — survive). Internal drags carry a custom type,
// so they don't trip the window-level file-upload drop handler (which keys off `Files`).
{
  const dropHost = document.querySelector("#output-preview");
  if (dropHost) {
    const isLib = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("application/x-hv-lib");
    dropHost.addEventListener("dragover", (e) => { if (!isLib(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropHost.classList.add("lib-drop-over"); });
    dropHost.addEventListener("dragleave", (e) => { if (e.target === dropHost) dropHost.classList.remove("lib-drop-over"); });
    dropHost.addEventListener("drop", (e) => {
      if (!isLib(e)) return;
      // Stop here — don't let the drop bubble to the window file-import handler (the
      // native <img> drag can carry a file fallback, which re-imported the item).
      e.preventDefault(); e.stopPropagation(); dropHost.classList.remove("lib-drop-over");
      let d; try { d = JSON.parse(e.dataTransfer.getData("application/x-hv-lib")); } catch { return; }
      if (d.mode === "raster") loadRasterToCanvas({ name: d.name, url: d.url });
      else if (d.mode === "vector") { placeFromUrl(d.url, d.name).catch((er) => setStatus(er.message, 3000)); }
      else if (d.mode === "canvas") openProject({ name: d.name, url: d.url });
    });
  }
}

// Process run scope + force (module state, not hidden DOM). Force persists.
const FORCE_KEY = "hector-vector:force";
let processBatch = false;     // explicit "Whole library" mode — OFF by default (single focus)
let processForce = false;
try { processForce = localStorage.getItem(FORCE_KEY) === "1"; } catch {}

// Resolve what the Processor acts on. Default focus is the selected raster — the
// canvas <image> (which also drives live preview) or, if none is on the canvas, the
// library-selected raster (run target only; load it to preview). Batch is OPT-IN
// (processBatch), never a silent fallback.
//   node  — canvas <image> for live preview (null if not on the canvas)
//   name  — server run input (the library file, with extension) = selectedName
//   label — what the target row shows
//   live  — live preview is available (a canvas node exists)
//   canRun— single run is possible (we have a library file name to send)
function processTarget() {
  if (processBatch) return { batch: true, label: "Whole library (batch)", canRun: true };
  const node = currentRasterTarget();
  const name = selectedName || null;
  return {
    batch: false, node, name,
    label: node ? rasterName(node) : (name || "No raster selected"),
    // Runnable when there's a canvas raster (process its href in place) OR a library
    // selection (background job). `live` = the raster is on the canvas right now.
    live: !!node, canRun: !!(node || name),
  };
}

async function runProcess(btn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Starting…";
  try {
    if (!anyStageEnabled()) {
      setStatus("Enable at least one pipeline stage to run.", 3000);
      return;
    }
    // The stage strip always drives the generalized pipeline route; the enabled
    // stage flags travel in the payload (via {...settings}).
    const payload = { ...settings };
    const force = processForce;
    const t = processTarget();
    // Resolve the FOCUSED target node — the raster whose result lands on the canvas in
    // place. The pipeline dissolves into the editor for BOTH cases:
    //   • on-canvas raster  → process its href directly
    //   • library raster     → auto-load it onto the canvas first, then process it
    // so a single-raster run is always symmetric (input is the canvas image, output
    // replaces it). Only batch ("Whole library") stays a headless library job.
    let returnNode = (!t.batch && t.node && editor.isRaster(t.node)) ? t.node : null;
    if (!t.batch && !returnNode && t.name) {
      const wi = workItems.find((i) => i.name === t.name);
      if (!wi) { setStatus(`Couldn't find “${t.name}” in the library.`, 3500); return; }
      await loadRasterToCanvas({ name: wi.name, url: wi.url });   // places + selects the <image>
      returnNode = currentRasterTarget();
      if (!returnNode) { setStatus("Couldn't load the raster onto the canvas.", 3500); return; }
    }
    // WYSIWYG fast path: a focused, vectorize-ONLY run commits exactly the live-preview
    // trace (same engine + resolution) in place — identical to "Keep vector" — instead of
    // kicking a second job that would re-trace at the batch ceiling. This collapses the two
    // commit paths into one. Multi-stage / raster-op runs (which can't be previewed as a
    // single SVG) still take the job path below.
    if (returnNode && stageOn("vectorize") && !stageOn("upscale") && !stageOn("removebg")) {
      await commitFocusedVectorize(returnNode);
      return;   // finally{} restores the button
    }
    if (returnNode) {
      payload.input_url = rasterHref(returnNode);
      payload.input_name = rasterName(returnNode);   // friendly output stem; the result lands on the canvas (hidden dir)
    } else if (!t.batch) {
      // No raster resolved (canRun guards the button, so this is a safety net).
      setStatus("Select a raster to process, or switch to Whole library (batch).", 3500);
      return;
    }
    if (force) payload.force = true;
    const data = await api("/api/run/pipeline", "POST", payload);
    lastBatchFailCount = 0;
    const hold = data.started === 0 ? 4000 : 1800;
    setStatus(data.message || "Started.", hold);
    await refreshExceptCanvas();   // queue background work without disturbing the canvas
    // A focused on-canvas run returns its single job's output onto the raster (SVG →
    // editable vector in place; PNG → new href, same box). Do NOT block the Run button on
    // it — the job runs in the background (visible + cancellable in the Jobs panel), and the
    // result lands on the canvas when ready. A heavy trace could take many seconds; freezing
    // the button that whole time made the panel feel hung.
    if (returnNode && Array.isArray(data.jobs) && data.jobs.length === 1 && data.started === 1) {
      awaitAndPlaceOnNode(data.jobs[0], returnNode).catch((e) => setStatus(e.message, 3000));
    }
  } catch (error) {
    setStatus(error.message, 3000);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// Poll a single job to a terminal state (the shared job-poller also runs on its own timer;
// this lets a focused run await *its* job before auto-placing the result). No 3-minute cliff:
// a genuinely heavy trace can run for many minutes, so poll up to a generous safety cap with
// back-off, and distinguish the outcomes for an honest hand-off:
//   terminal job  → the job object
//   { gone:true } → the job left the list (cleared/cancelled out from under us)
//   null          → still running past the cap (keep going in the background; manual Place)
async function awaitJob(id, { capMs = 1800000 } = {}) {
  const start = Date.now();
  let interval = 500;
  while (Date.now() - start < capMs) {
    let jobs = null;
    try { jobs = await fetchJobs(); } catch { /* transient — retry */ }
    if (jobs) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return { gone: true };
      if (TERMINAL_STATES.has(job.status)) return job;
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(2000, interval + 250);   // back off so a long job doesn't spam the poll
  }
  return null;
}

async function awaitAndPlaceOnNode(jobId, node) {
  setStatus("Processing on canvas… (the raster is replaced when it finishes)", 0);
  const job = await awaitJob(jobId);
  await loadJobs();   // reflect the terminal state in the Jobs panel
  if (!job) { setStatus("Still processing — it keeps running in the background; use Place in the Jobs panel when it finishes.", 6000); return; }
  if (job.gone) { setStatus("Processing was cancelled.", 3000); return; }
  if (job.status !== "done") { setStatus(`Processing ${job.status}. See the Jobs panel.`, 4500); return; }
  // The result lands async — the user may have edited/selected elsewhere while it ran. We
  // place onto the ORIGINAL node by reference (not the current selection), and only if it's
  // still a live raster — so a vanished/already-converted node is a clean no-op hand-off
  // rather than a surprise edit on the wrong object.
  if (!node.isConnected || !editor.isRaster(node)) {
    setStatus("Processed — the canvas raster changed meanwhile; use Place in the Jobs panel.", 5000); return;
  }
  await placeJobResultOnNode(job, node);
}

// Swap a finished focused-run output onto its source raster, in place:
//   SVG  → replace the raster with an editable vector fit to its box (commitRasterToVector)
//   PNG  → swap the raster href to the result, keeping the same box (upscale / remove-bg only)
async function placeJobResultOnNode(job, node) {
  const rel = chooseFinalOutput(job);
  if (!rel) { setStatus("The job produced no placeable output.", 3500); return false; }
  const url = jobOutputUrl(job, rel), name = jobOutputName(rel);
  const label = rasterName(node);
  // Each branch is exactly ONE undo step (commitRasterToVector / a single push), so if this
  // lands after the user moved on, a single Undo cleanly reverses it. Status names the raster
  // so an async canvas change reads clearly rather than appearing out of nowhere.
  try {
    if (jobOutputKind(name) === "svg") {
      const text = await (await fetch(url)).text();
      const ok = editor.commitRasterToVector(node, text, label);
      if (!ok) setStatus("Couldn't place the traced vector.", 3500);
      return ok;
    }
    node.setAttribute("href", url);
    editor.push("Process raster");
    editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
    setStatus(`Replaced “${label}” on the canvas with the processed result.`, 3200);
    return true;
  } catch (e) { setStatus(`Couldn't place the result: ${e.message}`, 4000); return false; }
}

function jobLastLine(job) {
  const lines = job.log_lines || [];
  return lines.length ? lines[lines.length - 1] : "";
}

function jobActions(job) {
  const actions = [];
  if (job.status === "queued" || job.status === "running") {
    actions.push({ label: "Cancel", kind: "cancel" });
  }
  if (TERMINAL_STATES.has(job.status)) {
    actions.push({ label: "Retry", kind: "retry" });
  }
  if ((job.outputs || []).length && job.source_name) {
    actions.push({ label: "View", kind: "view" });
  }
  // "Place" adds the finished vector to the current canvas as a layer (vs View,
  // which replaces it). Only when there's a canvas to place into and an SVG to place.
  if (editor.stage && TERMINAL_STATES.has(job.status)) {
    const rel = chooseFinalOutput(job);
    if (rel && jobOutputName(rel).toLowerCase().endsWith(".svg")) {
      actions.push({ label: "Place", kind: "place" });
    }
  }
  return actions;
}

function viewJobOutput(job) {
  const rel = chooseFinalOutput(job);
  if (job.source_name) selectedName = job.source_name;
  manualOutputName = rel ? jobOutputName(rel) : null;
  refreshLibrary();
  renderPreviews().catch((e) => setStatus(e.message, 2500));
}

function progressBarHtml(progress) {
  if (!progress || !progress.total) return "";
  const pct = Math.max(0, Math.min(100, Math.round((progress.step / progress.total) * 100)));
  const label = progress.label ? `${progress.step}/${progress.total} ${progress.label}` : `${progress.step}/${progress.total}`;
  return `<div class="job-progress"><div class="job-progress-bar" style="width:${pct}%"></div><span class="job-progress-label">${label}</span></div>`;
}

// Job queue (toolbar + rows) for the Process workspace's jobs pane.
// Returns the .jobs-panel node.
// Cancel-all-queued / clear-finished moved OUT of the panel body into the Jobs
// section header (square tool-buttons), so the scrollable body is just the queue
// — pressing them no longer lives inside the list that re-renders under the cursor.
async function cancelAllQueuedJobs() {
  const queued = jobsCache.filter((j) => j.status === "queued");
  for (const j of queued) { try { await api("/api/jobs/cancel", "POST", { id: j.id }); } catch {} }
  await loadJobs();
}
async function clearFinishedJobs() {
  try { await api("/api/jobs/clear", "POST", {}); await loadJobs(); }
  catch (e) { setStatus(e.message, 3000); }
}

function buildJobsPanel() {
  const wrap = document.createElement("div");
  wrap.className = "jobs-panel";

  if (!jobsCache.length) {
    const empty = document.createElement("div");
    empty.className = "jobs-empty";
    empty.textContent = "No jobs yet.";
    wrap.appendChild(empty);
    return wrap;
  }

  for (const job of jobsCache) {
    const row = document.createElement("div");
    row.className = `job-row ${job.status}`;
    const status = document.createElement("div");
    status.className = "job-status";
    status.textContent = job.status;
    const meta = document.createElement("div");
    meta.className = "job-meta";
    const summary = document.createElement("div");
    summary.className = "job-summary";
    summary.textContent = job.summary || job.kind;
    summary.title = job.summary || job.kind;
    meta.appendChild(summary);
    if (job.status === "running" && job.progress) {
      const progress = document.createElement("div");
      progress.innerHTML = progressBarHtml(job.progress);
      meta.appendChild(progress.firstChild);
    }
    const log = document.createElement("div");
    log.className = "job-log";
    log.textContent = jobLastLine(job);
    log.title = (job.log_lines || []).slice(-6).join("\n");
    meta.appendChild(log);
    if ((job.outputs || []).length) {
      const outs = document.createElement("div");
      outs.className = "job-outputs";
      outs.textContent = `${job.outputs.length} file(s) produced`;
      outs.title = job.outputs.join("\n");
      meta.appendChild(outs);
    }
    const actions = document.createElement("div");
    actions.className = "job-actions";
    for (const action of jobActions(job)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-button";
      btn.textContent = action.label;
      btn.addEventListener("click", async () => {
        if (action.kind === "view") {
          viewJobOutput(job);
          return;
        }
        if (action.kind === "place") {
          const rel = chooseFinalOutput(job);
          if (rel) {
            await placeFromUrl(jobOutputUrl(job, rel), jobOutputName(rel));
          }
          return;
        }
        btn.disabled = true;
        try {
          if (action.kind === "cancel") {
            await api("/api/jobs/cancel", "POST", { id: job.id });
          } else {
            await api("/api/jobs/retry", "POST", { id: job.id });
          }
          await loadJobs();
        } catch (e) {
          setStatus(e.message, 3000);
          btn.disabled = false;
        }
      });
      actions.appendChild(btn);
    }
    row.appendChild(status);
    row.appendChild(meta);
    row.appendChild(actions);
    wrap.appendChild(row);
  }
  return wrap;
}

// ---------- Process workspace: gallery + processing controls + live jobs ----------
// First-class home for the image→vector pipeline. Opened on demand (header
// "Process…" / footer Jobs / `q`), so it never eats editor canvas space.
// ===== Pipeline stage strip =====================================================
// The image→vector pipeline is three composable stages — Upscale → Remove BG →
// Vectorize — each independently toggleable. The 6 old flat "processes" are just
// stage subsets (Greenscreen folds into Remove-BG's method; Pixel Art folds into
// Vectorize's method). One generalized `/api/run/pipeline` honors the flags; the
// strip drives it. Drag to reorder the blocks (shares the customize-layout drag
// CSS); data flow stays canonical (you always upscale before tracing).
// `var` (hoisted, NOT a TDZ const) so renderProcessorPanel can guard on it: the docks
// IIFE calls renderPanels() at module-eval time — BEFORE these pipeline consts below
// initialize — so the Processor panel must no-op on that first call and fill once ready.
var pipelineConstsReady = false;
const PIPELINE_STAGES = [
  { id: "upscale",   key: "stage_upscale",   label: "Upscale",   note: "Enlarge with Real-ESRGAN" },
  { id: "removebg",  key: "stage_removebg",  label: "Remove BG", note: "Isolate the subject" },
  { id: "vectorize", key: "stage_vectorize", label: "Vectorize", note: "Raster → SVG" },
];
const STAGE_BY_ID = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, s]));
const CANON_ORDER = PIPELINE_STAGES.map((s) => s.id);
// Per-stage body expand/collapse state (survives re-render; Vectorize open first).
const stageExpanded = { upscale: false, removebg: false, vectorize: true };

// Visual block order from settings.pipeline_order, sanitized to the known stages.
function stageOrder() {
  const want = String(settings.pipeline_order || "").split(",").map((s) => s.trim()).filter((s) => STAGE_BY_ID[s]);
  const seen = new Set(want);
  return [...want, ...CANON_ORDER.filter((id) => !seen.has(id))];
}
const stageOn = (id) => !!settings[STAGE_BY_ID[id].key];
const anyStageEnabled = () => CANON_ORDER.some(stageOn);
// All pipeline consts + helpers above are initialized → the Processor panel may now
// render. (The docks IIFE called renderPanels() during module eval, before this point;
// the guard in renderProcessorPanel made that first call a no-op. Boot's onInspect →
// renderPanels fills the panel for real once the canvas mounts.)
pipelineConstsReady = true;

// The legacy process kind the current stage-set is equivalent to — used only to
// keep previews / skip-detection / the Settings-modal label working unchanged.
// (runProcess always POSTs the generalized /api/run/pipeline with stage flags.)
function effectiveProcessKind() {
  if (!anyStageEnabled()) return null;
  if (stageOn("vectorize")) {
    // the classic all-three trace is "Production SVG" (pipeline); narrower sets
    // are the granular svg kinds. All produce an SVG, so preview/skip stay correct.
    if (stageOn("upscale") && stageOn("removebg") && settings.vectorize_method !== "pixel") return "pipeline";
    return settings.vectorize_method === "pixel" ? "pixelvec" : "vectorize";
  }
  if (stageOn("removebg")) return "cutout";   // pipeline writes {stem}.cutout.png for every method
  return "upscale";   // upscale-only
}

// What the pipeline emits: SVG if Vectorize is on, else a PNG, else nothing.
function outputChipInfo() {
  if (!anyStageEnabled()) return null;
  if (stageOn("vectorize")) return { kind: "SVG", label: "SVG" };
  return { kind: "PNG", label: "PNG" };
}

// The terminal file the current stage-set emits for `sourceStem` — Vectorize wins
// (SVG), else Remove-BG's cutout PNG, else the Upscale PNG. Mirrors the server's
// pipeline_expected_output(); null when nothing is enabled.
function pipelineExpectedOutput(sourceStem) {
  if (stageOn("vectorize")) return `${sourceStem}.svg`;
  if (stageOn("removebg")) return `${sourceStem}.cutout.png`;
  if (stageOn("upscale")) return `${sourceStem}.png`;
  return null;
}

// True when the current stage-set's terminal output already exists in a pipeline-*
// folder for this source. The client mirror of the server's is_pipeline_processed,
// so the single-mode guard and the server's batch skip agree on "already done" —
// no more false "already processed" when the stage-set has changed since last run.
function pipelineProcessed(name) {
  const want = pipelineExpectedOutput(stem(name));
  if (!want) return false;
  return latestOutputsFor(name).some(
    (x) => x.name === want && /^pipeline-/.test(x.folder || ""),
  );
}

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
function renderLibrary() {
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

// Toggle `.is-overflowing` on a tile-scroll bar so the edge-fade hint shows ONLY when
// its tiles actually overflow (no fade — and no clipped tiles — when they fit).
function observeOverflow(el, axis) {
  if (!el || el._ovObserved) return; el._ovObserved = true;
  const check = () => {
    const over = axis === "y" ? (el.scrollHeight > el.clientHeight + 1) : (el.scrollWidth > el.clientWidth + 1);
    el.classList.toggle("is-overflowing", over);
  };
  try { new ResizeObserver(check).observe(el); } catch {}
  try { new MutationObserver(check).observe(el, { childList: true }); } catch {}
  requestAnimationFrame(check);
}
// Apply the invisible-scroll-with-hint to the viewport strips (vertical tool/action
// rails + the horizontal arrange/zoom bars) so they degrade gracefully when crowded.
for (const [sel, axis] of [[".toolstrip", "y"], [".actionbar", "y"], [".stage-toolbar", "x"], [".viewport-controls", "x"]]) {
  document.querySelectorAll(sel).forEach((el) => { el.classList.add(axis === "y" ? "tile-scroll-y" : "tile-scroll-x"); observeOverflow(el, axis); });
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
      badge: itemIsProcessed(item.name) ? " ✓" : "", title: `${item.name} — click to select, drag to the canvas, right-click for info`,
      onClick: () => { selectedName = item.name; manualOutputName = null; refreshLibrary(); },
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

// Jobs dock panel (right rail) — the batch queue, visible in the Edit view alongside the
// canvas so jobs stay watchable after leaving Q. Same content as the Process view's pane
// (one `buildJobsPanel`); the header count shows running+queued. Step toward dissolving Q.
function renderJobsPanel() {
  const host = document.querySelector("#jobs-list"); if (!host) return;
  const keepScroll = host.scrollTop;   // preserve scroll across the queue rebuild (poll/cancel/clear)
  host.innerHTML = "";
  host.appendChild(buildJobsPanel());
  host.scrollTop = keepScroll;
  const count = document.querySelector("#jobs-count");
  const active = jobsCache.filter((j) => j.status === "running" || j.status === "queued").length;
  if (count) count.textContent = active ? String(active) : "";
  // Header actions enable only when they'd do something.
  const queued = jobsCache.some((j) => j.status === "queued");
  const finished = jobsCache.some((j) => TERMINAL_STATES.has(j.status));
  const cancelBtn = document.querySelector("#jobs-cancel-all"); if (cancelBtn) cancelBtn.disabled = !queued;
  const clearBtn = document.querySelector("#jobs-clear"); if (clearBtn) clearBtn.disabled = !finished;
}

// ---------- Processor panel: the image→vector pipeline as a vertical flow rail ----------
// Upscale → Remove BG → Vectorize as stacked, toggleable, reorderable stage cards with
// flow connectors; click a card to expand its settings (shared schema renderers). When a
// single raster is the target you can live-preview it on the canvas; Run drives the same
// generalized pipeline as the (legacy) Process view. Lifts the pipeline out of the
// cramped raster Properties panel into its own composable dock (the user-requested home).
let procDragId = null;
// The single selected raster <image> the panel targets (live preview + single-run), or null.
function currentRasterTarget() {
  if (!editor.stage) return null;
  const ns = editor.selectedNodes();
  return (ns.length === 1 && editor.isRaster(ns[0])) ? ns[0] : null;
}
function procInsertBefore(list, y) {
  for (const card of list.querySelectorAll(".proc-stage:not(.dragging)")) {
    const r = card.getBoundingClientRect();
    if (y < r.top + r.height / 2) return card;
  }
  return null;
}
// Rebuild the Processor panel + re-kick whichever live preview is active (the structural
// callback for the schema-driven stage controls hosted in the cards).
function procRerender() { renderProcessorPanel(); if (rasterLive) scheduleRasterLive(false); if (rasterOp) scheduleRasterOpLive(false); }
function buildProcStageCard(id, target) {
  const def = STAGE_BY_ID[id];
  const on = stageOn(id), open = !!stageExpanded[id];
  const card = document.createElement("div");
  card.className = "proc-stage" + (on ? "" : " off") + (open ? " expanded" : "");
  card.dataset.stage = id; card.draggable = true;
  card.addEventListener("dragstart", (e) => { procDragId = id; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch {} card.classList.add("dragging"); });
  card.addEventListener("dragend", () => { card.classList.remove("dragging"); procDragId = null; });

  const head = document.createElement("div"); head.className = "proc-stage-head";
  const grip = document.createElement("span"); grip.className = "proc-grip"; grip.textContent = "⠿"; grip.title = "Drag to reorder";
  const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.className = "stage-toggle"; toggle.checked = on;
  toggle.title = on ? `${def.label} on` : `${def.label} off`;
  toggle.addEventListener("change", () => { settings[def.key] = toggle.checked; persistSettings(); procRerender(); });
  const title = document.createElement("button"); title.type = "button"; title.className = "proc-stage-title";
  const nm = document.createElement("span"); nm.className = "stage-name"; nm.textContent = def.label;
  const nt = document.createElement("span"); nt.className = "stage-note"; nt.textContent = def.note;
  title.appendChild(nm); title.appendChild(nt);
  title.title = open ? "Hide settings" : "Show settings";
  title.addEventListener("click", () => { stageExpanded[id] = !stageExpanded[id]; renderProcessorPanel(); });
  head.appendChild(grip); head.appendChild(toggle); head.appendChild(title);
  const caret = document.createElement("span"); caret.className = "stage-caret"; caret.setAttribute("aria-hidden", "true"); caret.textContent = open ? "▾" : "▸";
  head.appendChild(caret);
  card.appendChild(head);
  // Expanded body = the SCHEMA-DRIVEN stage settings + per-stage live preview (the
  // controls that used to be crammed into the raster Properties panel), targeting the
  // selected raster. Engine/method selectors live in the body now (not a head pill).
  if (open) {
    const sbody = document.createElement("div"); sbody.className = "pipeline-detail-body form";
    renderStageSettings(sbody, id, target, procRerender);
    card.appendChild(sbody);
  }
  return card;
}
function buildProcessorRail() {
  const rail = document.createElement("div"); rail.className = "proc-rail";
  const t = processTarget();

  // Target row: the focused raster (default) or the whole library (explicit batch).
  // The ▦/🖼 button on the right is the EXPLICIT batch toggle — batch is never silent.
  const tgt = document.createElement("div"); tgt.className = "proc-target" + (t.batch ? " batch" : "");
  const ic = document.createElement("span"); ic.className = "proc-target-ic"; ic.textContent = t.batch ? "▦" : "🖼";
  const nm = document.createElement("span"); nm.className = "proc-target-name"; nm.textContent = t.label;
  const swap = document.createElement("button");
  swap.type = "button"; swap.className = "proc-target-swap tool-button" + (t.batch ? " on" : "");
  swap.textContent = t.batch ? "🖼" : "▦";
  swap.title = t.batch ? "Switch to the selected raster" : "Switch to the whole library (batch)";
  swap.addEventListener("click", (e) => { e.stopPropagation(); processBatch = !processBatch; renderProcessorPanel(); syncDockContext(); });
  tgt.appendChild(ic); tgt.appendChild(nm); tgt.appendChild(swap); rail.appendChild(tgt);

  // Stage cards in saved order, vertical flow, drag to reorder.
  const list = document.createElement("div"); list.className = "proc-stages";
  list.addEventListener("dragover", (e) => {
    if (!procDragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move";
    const el = list.querySelector(`.proc-stage[data-stage="${procDragId}"]`); if (!el) return;
    const ref = procInsertBefore(list, e.clientY); if (ref !== el) list.insertBefore(el, ref);
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const order = [...list.querySelectorAll(".proc-stage")].map((c) => c.dataset.stage);
    if (order.length === CANON_ORDER.length) { settings.pipeline_order = order.join(","); persistSettings(); }
    renderProcessorPanel();
  });
  // Live preview needs the raster ON the canvas; pass the node (null in batch / library-only).
  const previewNode = t.batch ? null : (t.node || null);
  stageOrder().forEach((id) => list.appendChild(buildProcStageCard(id, previewNode)));
  rail.appendChild(list);
  return rail;
}
// The pinned chin (standard ink-top-bordered footer): the Run action, plus a compact
// "Load to preview" affordance when the target raster isn't on the canvas yet. The name
// isn't repeated here — it already shows in the target row above.
function buildProcessorChin(t) {
  const chin = document.createElement("div"); chin.className = "processor-chin";
  if (!t.batch && !t.live && t.name) {
    const wi = workItems.find((i) => i.name === t.name);
    const load = document.createElement("button"); load.type = "button"; load.className = "proc-foot-load";
    load.textContent = "↓ Load to preview"; load.title = `Load “${t.name}” onto the canvas to tune a live preview first (Run loads it automatically)`;
    load.addEventListener("click", () => { if (wi) loadRasterToCanvas({ name: wi.name, url: wi.url }); });
    chin.appendChild(load);
  } else if (!t.batch && !t.name) {
    const hint = document.createElement("span"); hint.className = "proc-foot-hint";
    hint.textContent = "Select a raster, or switch to batch";
    chin.appendChild(hint);
  }
  const run = document.createElement("button"); run.type = "button"; run.className = "primary-button proc-run";
  // A single-raster run always lands on the canvas — an on-canvas raster is processed in
  // place; a library raster is auto-loaded onto the canvas first. Only batch runs the
  // whole library headlessly. ("Load to preview" above is now just an optional pre-load
  // for live tuning before running.)
  run.textContent = t.batch ? "Run library" : "Run → canvas";
  run.disabled = !anyStageEnabled() || (!t.batch && !t.canRun);
  if (!anyStageEnabled()) run.title = "Enable at least one stage";
  else if (!t.batch && !t.canRun) run.title = "Select a raster to run";
  run.addEventListener("click", () => runProcess(run));
  chin.appendChild(run);
  return chin;
}
function renderProcessorPanel() {
  if (!pipelineConstsReady) return;   // called by renderPanels before the pipeline consts init (module eval) → no-op until ready
  const host = document.querySelector("#processor-body"); if (!host) return;
  const keepScroll = host.scrollTop;
  host.innerHTML = "";
  host.appendChild(buildProcessorRail());
  host.scrollTop = keepScroll;
  const chinHost = document.querySelector("#processor-chin");
  if (chinHost) { chinHost.innerHTML = ""; chinHost.appendChild(buildProcessorChin(processTarget())); }
  const out = outputChipInfo();
  const outEl = document.querySelector("#processor-out"); if (outEl) outEl.textContent = out ? out.label : "";
  const runBtn = document.querySelector("#processor-run");
  if (runBtn) { runBtn.disabled = !anyStageEnabled(); runBtn.title = anyStageEnabled() ? "Run the pipeline → canvas" : "Enable at least one stage"; }
  syncProcessorContext();
}

// The Processor is contextual: relevant when there's a raster to act on. The CANVAS
// selection wins — if you've selected something on the canvas, the Processor is relevant
// only when that something is a raster <image> (so selecting a VECTOR dims it, instead of
// staying lit because the library happens to have a raster selected). With nothing
// selected on the canvas, fall back to the library's raster selection. Batch always lit.
function processorRelevant() {
  if (processBatch) return true;
  const sel = editor.selection ? editor.selection.size : 0;
  if (sel > 0 || editor.artboardSelected) return !!currentRasterTarget();   // canvas selection decides
  return libraryMode === "raster" && !!selectedName;                        // else defer to the library
}
let lastProcRelevant = null;
// Auto-REVEAL the Processor the moment a raster becomes the subject (un-collapse + bring
// into view — never moves/hides a panel the user placed), and DIM it when there's nothing
// to process. Like Properties, it stays put and just reflects the current context.
function syncProcessorContext() {
  const sec = document.querySelector(".rail-section.processor"); if (!sec) return;
  const rel = processorRelevant();
  sec.classList.toggle("dimmed", !rel);
  if (rel && lastProcRelevant === false) {
    sec.classList.remove("collapsed"); try { localStorage.setItem("hv-sec-processor", "0"); } catch {}
    if (sec.scrollIntoView) sec.scrollIntoView({ block: "nearest" });
  }
  lastProcRelevant = rel;
}
// Run the dock's contextual auto-shelve pass (parks unused panels into shelf squares,
// pops relevant ones back). Called on every selection / library-context change.
function syncDockContext() { if (window.__docks && window.__docks.syncContextual) window.__docks.syncContextual(); }

// The Info panel's body is content-driven, so the shelf square remembers the LAST thing
// that was inspected and re-renders it when reopened. Falls back to the current library
// selection, then a help state. Each open*Info builder records its reopen thunk here.
let lastInfoContext = null;
function infoForCurrentContext() {
  if (typeof lastInfoContext === "function") { lastInfoContext(); return; }
  if (selectedName && libraryMode === "raster") { openInfoModal(selectedName); return; }
  const help = document.createElement("div"); help.className = "insp-empty";
  help.textContent = "Right-click an item in the Library — or an object on the canvas — to inspect it here.";
  showInfoPanel("Info", help);
}
window.refillInfoContext = infoForCurrentContext;

loadVersion();   // cache the version early so the About panel shows it instantly
// Boot does NOT auto-install heavy deps anymore — that used to kick a Real-ESRGAN download +
// a cargo build on every cold start with tools missing. Installs are deliberate now, from
// Settings → "AI models & tools". refreshAll() still fetches tool status so the UI knows
// what's available and the stage panels can route to Settings when something's missing.
refreshAll()
  .then(async () => {
    // Startup: resume the last document only if the user opted in AND there is
    // one to restore; otherwise fall back to a blank canvas. (The Process view is
    // gone — the pipeline lives in the Processor dock panel, visible alongside.)
    if (prefs.startup === "resume" && (await resumeLastDoc())) return;
    mountBlankCanvas();
  })
  .then(() => syncDockContext())   // initial park: shelve contextual panels with nothing selected yet
  .catch((error) => setStatus(error.message, 3000));

window.addEventListener("resize", () => {
  Object.values(viewports).forEach((vp) => {
    if (vp.el.querySelector(".viewport-content")) measureFit(vp);
  });
  drawRulers();
});

function fieldRow(label, control, hint) {
  const row = document.createElement("label");
  row.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(control);
  if (hint) {
    const h = document.createElement("span");
    h.className = "form-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  return row;
}

function makeSelect(key, options) {
  const sel = document.createElement("select");
  for (const [value, label] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (String(settings[key]) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => { settings[key] = sel.value; persistSettings(); });
  return sel;
}

function makeSelectRaw(value, options, onChange) {
  const sel = document.createElement("select");
  for (const [val, label] of options) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    if (String(value) === String(val)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function makeNumberRaw(value, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-input";
  input.min = "1";
  input.max = "16384";
  input.value = String(value || "");
  input.addEventListener("input", () => onChange(parseInt(input.value, 10) || 0));
  return input;
}

function makeRange(key, min, max, step) {
  const wrap = document.createElement("div");
  wrap.className = "form-range";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(settings[key]);
  const out = document.createElement("output");
  out.textContent = input.value;
  input.addEventListener("input", () => {
    out.textContent = input.value;
    settings[key] = input.value;
    persistSettings();
  });
  wrap.appendChild(input);
  wrap.appendChild(out);
  return wrap;
}

function makeNumber(key, { min, max, step = 1, placeholder = "" } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-input";
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = String(step);
  input.placeholder = placeholder;
  input.value = String(settings[key] ?? "");
  input.addEventListener("input", () => {
    settings[key] = input.value;
    persistSettings();
  });
  return input;
}

function sectionTitle(text) {
  const h = document.createElement("div");
  h.className = "form-section";
  h.textContent = text;
  return h;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Trigger a browser download of a URL under a chosen filename.
function downloadUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url; a.download = filename || "";
  document.body.appendChild(a); a.click(); a.remove();
}

// Shared Rename / Download / Delete wiring for the C/R/V detail modals. `cfg`:
//   kind     "raster" | "vector" | "project"  (label + endpoint selection)
//   item     the library item — re-opened after a rename so the view stays live
//   url      file URL (download source + outputs rename/remove key)
//   nameBtn  the .info-name button — anchors the floating rename input
//   reopen   (newItem) => void — re-renders the detail view after a rename
//   refresh  async () => void — reloads the relevant library list after a change
// Appends buttons via the modal's own `act(label, title, fn, primary)` builder.
function wireDetailActions(act, cfg) {
  const { kind, item, url, nameBtn } = cfg;
  const isRaster = kind === "raster";
  const renameEndpoint = isRaster ? "/api/work-items/rename" : "/api/outputs/rename";
  const removeEndpoint = isRaster ? "/api/work-items/remove" : "/api/outputs/remove";
  const keyPayload = isRaster ? { name: item.name } : { url: item.url };

  const doRename = () => {
    const r = (nameBtn || document.body).getBoundingClientRect();
    floatingInput({
      value: item.name,
      placeholder: "New name",
      title: `Rename ${kind}`,
      x: r.left, y: r.bottom + 4,
      onCommit: async (next) => {
        const trimmed = (next || "").trim();
        if (!trimmed || trimmed === item.name) return;
        try {
          const res = await api(renameEndpoint, "POST", { ...keyPayload, new_name: trimmed });
          await cfg.refresh();
          setStatus(res.message || "Renamed.", 2500);
          // Re-open the detail view on the renamed file so it stays in sync.
          const nextItem = { ...item, name: res.name, url: res.url, path: undefined };
          if (cfg.reopen) cfg.reopen(nextItem);
        } catch (e) { setStatus(e.message, 3500); }
      },
    });
  };

  let armed = false;
  const doDelete = (btn) => {
    if (!armed) {            // first click arms; second within the modal confirms
      armed = true;
      btn.classList.add("danger-armed");
      btn.textContent = "Confirm delete?";
      btn.title = "Click again to delete permanently";
      return;
    }
    btn.disabled = true;
    api(removeEndpoint, "POST", keyPayload)
      .then(async (res) => { await cfg.refresh(); lastInfoContext = null; hideInfoPanel(); setStatus(res.message || "Deleted.", 2500); })
      .catch((e) => { btn.disabled = false; setStatus(e.message, 3500); });
  };

  act("Rename", `Rename this ${kind}`, doRename);
  act("Download", "Download a copy", () => downloadUrl(url, item.name));
  const del = document.createElement("button");
  del.type = "button"; del.className = "ghost-button danger-button"; del.textContent = "Delete";
  del.title = `Delete this ${kind} permanently`;
  del.addEventListener("click", () => doDelete(del));
  // The modal's action rows are built by `act`, but Delete needs its own ref for
  // the arm/confirm toggle — caller appends `cfg._deleteBtn` into the row.
  cfg._deleteBtn = del;
}

// Info is a dock PANEL now (not a modal): the builders below render their content
// element into the summoned Info panel via these helpers.
function showInfoPanel(title, el) { if (window.__docks && window.__docks.showInfo) window.__docks.showInfo(title, el); }
function hideInfoPanel() { if (window.__docks && window.__docks.close) window.__docks.close("info"); }
function infoLoadingEl(text) { const d = document.createElement("div"); d.className = "form-section"; d.textContent = text; return d; }

async function openInfoModal(name = selectedName) {
  if (!name) {
    setStatus("Select an image first.", 2000);
    return;
  }
  lastInfoContext = () => openInfoModal(name);
  showInfoPanel(`Info — ${name}`, infoLoadingEl("Loading…"));
  let info;
  try {
    info = await api(`/api/work-items/info?name=${encodeURIComponent(name)}`);
  } catch (error) {
    showInfoPanel(`Info — ${name}`, infoLoadingEl(error.message));
    return;
  }
  renderInfoModal(info);
}

// Info panel for an output VECTOR — mirrors the raster Info (preview + name + Load/
// Open), reading dimensions/size client-side (there's no server info endpoint for SVGs).
async function openVectorInfoModal(item) {
  lastInfoContext = () => openVectorInfoModal(item);
  showInfoPanel(`Info — ${item.name}`, infoLoadingEl("Loading…"));
  let dims = "—", size = "—", elements = "—", colors = "—", viewBox = "—";
  try {
    const blob = await (await fetch(item.url)).blob(); size = fmtBytes(blob.size);
    const svg = new DOMParser().parseFromString(await blob.text(), "image/svg+xml").documentElement;
    const vbRaw = (svg.getAttribute("viewBox") || "").trim();
    const vb = vbRaw.split(/[\s,]+/).map(Number);
    const w = parseFloat(svg.getAttribute("width")) || (vb.length === 4 ? vb[2] : 0);
    const h = parseFloat(svg.getAttribute("height")) || (vb.length === 4 ? vb[3] : 0);
    if (w && h) dims = `${Math.round(w)} × ${Math.round(h)}`;
    if (vbRaw) viewBox = vbRaw;
    const shapes = svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon");
    elements = String(shapes.length);
    const fills = new Set();
    shapes.forEach((s) => { const f = (s.getAttribute("fill") || "").trim().toLowerCase(); if (f && f !== "none") fills.add(f); });
    colors = fills.size ? String(fills.size) : "—";
  } catch { /* leave dashes */ }

  const root = document.createElement("div"); root.className = "form info-modal";
  const head = document.createElement("div"); head.className = "info-head";
  const prev = document.createElement("div"); prev.className = "info-preview";
  prev.innerHTML = `<img src="${item.url}" alt="${item.name}" decoding="async" />`;
  head.appendChild(prev);
  const meta = document.createElement("div"); meta.className = "info-headmeta";
  const nm = document.createElement("button"); nm.type = "button"; nm.className = "info-name info-copy"; nm.textContent = item.name;
  nm.title = `Click to copy filename: ${item.name}`; nm.addEventListener("click", () => copyToClipboard(item.name, "filename"));
  const sub = document.createElement("div"); sub.className = "info-sub"; sub.textContent = `Vector · ${dims} · ${size}`;
  meta.appendChild(nm); meta.appendChild(sub);
  const actions = document.createElement("div"); actions.className = "info-actions";
  const act = (label, title, fn, primary) => { const b = document.createElement("button"); b.type = "button"; b.className = primary ? "primary-button" : "ghost-button"; b.textContent = label; b.title = title; b.addEventListener("click", fn); actions.appendChild(b); };
  act("⤓ Load into canvas", "Place this vector into the editor viewport", () => { placeFromUrl(item.url, item.name).catch((e) => setStatus(e.message, 3000)); }, true);
  const abs = item.path || "";
  if (abs) act("Reveal", "Reveal in the file manager", () => revealInFileManager(abs));
  act("Open ↗", "Open the vector in a new tab", () => window.open(item.url, "_blank", "noopener"));
  const vectorCfg = {
    kind: "vector", item, url: item.url, nameBtn: nm,
    reopen: (it) => openVectorInfoModal(it),
    refresh: () => loadOutputs(),
  };
  wireDetailActions(act, vectorCfg);
  actions.appendChild(vectorCfg._deleteBtn);
  meta.appendChild(actions); head.appendChild(meta); root.appendChild(head);

  // Core details — at parity with the raster Info (Path is click-to-copy).
  root.appendChild(sectionTitle("Vector"));
  const grid = document.createElement("div"); grid.className = "info-grid";
  const entries = [
    ["Path", abs || item.url],
    ["Format", "SVG"],
    ["Dimensions", dims],
    ["viewBox", viewBox],
    ["Size", size],
    ["Elements", elements],
    ["Fill colours", colors],
  ];
  for (const [k, v] of entries) {
    const dt = document.createElement("div"); dt.className = "info-key"; dt.textContent = k;
    let dd;
    if (k === "Path" && v) {
      dd = document.createElement("button"); dd.type = "button"; dd.className = "info-val info-copy"; dd.textContent = v;
      dd.title = "Click to copy path"; dd.addEventListener("click", () => copyToClipboard(v, "path"));
    } else { dd = document.createElement("div"); dd.className = "info-val"; dd.textContent = v; }
    grid.appendChild(dt); grid.appendChild(dd);
  }
  root.appendChild(grid);
  showInfoPanel(`Info — ${item.name}`, root);
}

// Project (.hv) detail — Open + Download + Rename + Delete (full parity with R/V).
function openProjectInfo(item) {
  lastInfoContext = () => openProjectInfo(item);
  const root = document.createElement("div"); root.className = "form info-modal";
  const head = document.createElement("div"); head.className = "info-head";
  const prev = document.createElement("div"); prev.className = "info-preview info-preview-proj"; prev.textContent = "⛋";
  head.appendChild(prev);
  const meta = document.createElement("div"); meta.className = "info-headmeta";
  const nm = document.createElement("button"); nm.type = "button"; nm.className = "info-name info-copy"; nm.textContent = item.name;
  nm.title = `Click to copy: ${item.name}`; nm.addEventListener("click", () => copyToClipboard(item.name, "filename"));
  const sub = document.createElement("div"); sub.className = "info-sub";
  sub.textContent = item.modified_at ? `Project · ${new Date(item.modified_at * 1000).toLocaleString()}` : "Project (.hv)";
  meta.appendChild(nm); meta.appendChild(sub);
  const actions = document.createElement("div"); actions.className = "info-actions";
  const act = (label, title, fn, primary) => { const b = document.createElement("button"); b.type = "button"; b.className = primary ? "primary-button" : "ghost-button"; b.textContent = label; b.title = title; b.addEventListener("click", fn); actions.appendChild(b); };
  act("⤓ Open project", "Open this project (restores layers + history)", () => { openProject(item); }, true);
  const projCfg = {
    kind: "project", item, url: item.url, nameBtn: nm,
    reopen: (it) => openProjectInfo(it),
    refresh: () => loadProjects(),
  };
  wireDetailActions(act, projCfg);
  actions.appendChild(projCfg._deleteBtn);
  meta.appendChild(actions); head.appendChild(meta); root.appendChild(head);
  showInfoPanel(`Project — ${item.name}`, root);
}

function renderInfoModal(info) {
  const url = `/work-items/${encodeURIComponent(info.name)}`;
  const absPath = info.path || "";
  const root = document.createElement("div");
  root.className = "form info-modal";

  // ---- header: preview + name/summary + the primary actions (Load) and the
  //      secondary file actions (copy name / copy path / reveal / open) that used
  //      to crowd the gallery thumbnail. Transforms are gone — handled on the
  //      canvas once an object exists, not in-place on the source file.
  const head = document.createElement("div");
  head.className = "info-head";
  const prev = document.createElement("div");
  prev.className = "info-preview";
  prev.innerHTML = `<img src="${url}?w=320" alt="${info.name}" decoding="async" />`;
  head.appendChild(prev);

  const meta = document.createElement("div");
  meta.className = "info-headmeta";
  // The name is click-to-copy (replaces the old "Copy name" button).
  const nm = document.createElement("button");
  nm.type = "button"; nm.className = "info-name info-copy"; nm.textContent = info.name;
  nm.title = `Click to copy filename: ${info.name}`;
  nm.addEventListener("click", () => copyToClipboard(info.name, "filename"));
  const sub = document.createElement("div"); sub.className = "info-sub";
  sub.textContent = `${info.width} × ${info.height} · ${info.format} · ${fmtBytes(info.size_bytes)}`;
  meta.appendChild(nm); meta.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "info-actions";
  const act = (label, title, fn, primary) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = primary ? "primary-button" : "ghost-button";
    b.textContent = label; b.title = title;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  act("⤓ Load into canvas", "Place this image into the editor viewport", () => { loadRasterToCanvas({ name: info.name, url }); }, true);
  if (absPath) act("Reveal", "Reveal in the file manager", () => revealInFileManager(absPath));
  act("Open ↗", "Open the full image in a new tab", () => window.open(url, "_blank", "noopener"));
  const rasterCfg = {
    kind: "raster", item: { name: info.name, url, path: absPath }, url, nameBtn: nm,
    reopen: (it) => openInfoModal(it.name),
    refresh: () => refreshAll(),
  };
  wireDetailActions(act, rasterCfg);
  actions.appendChild(rasterCfg._deleteBtn);
  meta.appendChild(actions);
  head.appendChild(meta);
  root.appendChild(head);

  // ---- IMAGE details (Name/dims/size live in the header now) ----
  root.appendChild(sectionTitle("Image"));
  const grid = document.createElement("div");
  grid.className = "info-grid";
  const entries = [
    ["Path", info.path],
    ["Dimensions", `${info.width} × ${info.height}`],
    ["Mode", info.mode],
    ["Format", info.format],
    ["Size", fmtBytes(info.size_bytes)],
    ["Alpha", info.has_alpha ? "yes" : "no"],
    ["DPI", info.dpi || "—"],
    ["ICC Profile", info.icc_profile || "—"],
    ["EXIF Orient", info.orientation ? String(info.orientation) : "—"],
    ["Modified", info.modified_at ? new Date(info.modified_at * 1000).toLocaleString() : "—"],
  ];
  for (const [k, v] of entries) {
    const dt = document.createElement("div"); dt.className = "info-key"; dt.textContent = k;
    let dd;
    if (k === "Path" && v) {   // Path is click-to-copy (replaces the old "Copy path" button)
      dd = document.createElement("button");
      dd.type = "button"; dd.className = "info-val info-copy"; dd.textContent = v;
      dd.title = "Click to copy path";
      dd.addEventListener("click", () => copyToClipboard(v, "path"));
    } else {
      dd = document.createElement("div"); dd.className = "info-val"; dd.textContent = v;
    }
    grid.appendChild(dt); grid.appendChild(dd);
  }
  root.appendChild(grid);

  // ---- EXIF ----
  root.appendChild(sectionTitle("EXIF"));
  if (info.exif && Object.keys(info.exif).length) {
    const exifGrid = document.createElement("div"); exifGrid.className = "info-grid";
    for (const [k, v] of Object.entries(info.exif)) {
      const dt = document.createElement("div"); dt.className = "info-key"; dt.textContent = k;
      const dd = document.createElement("div"); dd.className = "info-val"; dd.textContent = v;
      exifGrid.appendChild(dt); exifGrid.appendChild(dd);
    }
    root.appendChild(exifGrid);
  } else {
    const none = document.createElement("div"); none.className = "form-hint"; none.textContent = "No EXIF metadata.";
    root.appendChild(none);
  }

  showInfoPanel(`Info — ${info.name}`, root);
}

function openShortcutsModal() {
  openModal("Keyboard shortcuts");
  modalSearchEl.hidden = true;
  const mod = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  // Mirrors the live keymap in app.js (editor keymap + view/nav keymap + space-pan).
  const rows = [
    ["§", "Tools"],
    ["V", "Select / move (drag empty = marquee, Alt = lasso; Shift = 45°, Alt-drag = copy)"],
    [`${mod} + T / ${mod} + R`, "Scale / rotate the selection (within Select)"],
    ["A", "Edit points (direct select)"],
    ["P", "Pen"],
    ["C", "Curvature (Alt = corner, Shift = 45°, drag = move point, ⌫ = remove last)"],
    ["R / E / L", "Rectangle / Ellipse / Line"],
    ["Shift + O", "Select the artboard"],
    ["§", "Edit"],
    [`${mod} + Z`, "Undo"],
    [`${mod} + Shift + Z`, "Redo"],
    [`${mod} + C / X / V`, "Copy / Cut / Paste"],
    [`${mod} + D`, "Duplicate"],
    [`${mod} + A`, "Select all"],
    ["Delete / Backspace", "Delete selection"],
    ["← ↑ ↓ →", "Nudge (Shift = ×10)"],
    ["Esc", "Deselect / cancel"],
    ["§", "Arrange"],
    [`${mod} + G`, "Group"],
    [`${mod} + Shift + G`, "Ungroup"],
    [`${mod} + ] / [`, "Bring forward / send backward"],
    [`${mod} + Shift + ] / [`, "Bring to front / send to back"],
    ["§", "Pen"],
    ["Click / drag", "Corner point / smooth curve"],
    ["Alt + drag", "Break handle (cusp)"],
    ["Shift", "Constrain to 45°"],
    ["Click path / anchor", "Add (+) / remove (−) a point"],
    ["Click an endpoint", "Continue an open path"],
    [`${mod} (hold)`, "Temporarily edit points (Direct-Select)"],
    ["Enter", "Finish path"],
    ["Esc", "Cancel path"],
    ["§", "Node tool"],
    ["Click / Shift-click", "Select anchor / multi-select"],
    ["Drag empty canvas", "Marquee-select anchors (Shift adds)"],
    ["Drag a segment", "Reshape it (curve bends, line moves)"],
    ["Drag square", "Move selected anchors (Shift = 45°)"],
    ["Drag round dot", "Reshape curve (Alt = break)"],
    ["Alt-click anchor", "Smooth → corner"],
    ["Alt-drag anchor", "Corner → smooth"],
    [`${mod} + J`, "Join two selected endpoints"],
    ["Right-click a point", "Smooth / sharpen / join / delete"],
    ["Delete / Backspace", "Remove selected anchors"],
    ["§", "View & navigation"],
    ["Space (hold)", "Pan; or reposition a shape/point while creating"],
    ["+ / −", "Zoom in / out"],
    ["0", "Actual size (1:1)"],
    ["f", "Fit canvas to window"],
    ["b", "Cycle background"],
    ["Q / Tab", "Swap Edit ⇄ Process workspace"],
    ["Shift + F", "Open the File menu"],
    ["?", "This help"],
  ];
  const root = document.createElement("div");
  root.className = "form";
  const grid = document.createElement("div");
  grid.className = "info-grid shortcut-grid";
  for (const [keys, desc] of rows) {
    if (keys === "§") {
      const h = document.createElement("div");
      h.className = "shortcut-section";
      h.textContent = desc;
      grid.appendChild(h);
      continue;
    }
    const k = document.createElement("div");
    k.className = "info-key";
    k.textContent = keys;
    const d = document.createElement("div");
    d.className = "info-val";
    d.textContent = desc;
    grid.appendChild(k);
    grid.appendChild(d);
  }
  root.appendChild(grid);
  const note = document.createElement("p");
  note.className = "form-hint";
  note.textContent = "Tip: right-click an object for its style + actions (fill, stroke, rotate, flip…), or empty canvas for artboard actions.";
  root.appendChild(note);
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}

shortcutButtonEl.addEventListener("click", openShortcutsModal);

function zoomVp(vp, factor) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = Math.max(0.02, Math.min(40, vp.scale * factor));
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}
function fitVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = vp.fitScale || 1;
  vp.x = 0; vp.y = 0;
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}
function actualVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = 1; vp.x = 0; vp.y = 0;
  applyViewportState(vp);
  if (vp === viewports.output) editor.onViewportChanged();
}

for (const vp of Object.values(viewports)) {
  vp.el.addEventListener("wheel", (event) => {
    if (!vp.el.querySelector(".viewport-content")) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomVp(vp, factor);
  }, { passive: false });
}


// View / navigation keys. The editor's editing + tool keymap lives above; this
// handler is single-key and Illustrator-flavoured, and — unlike the old image-tool
// keymap it replaces — nothing here triggers processing or moves the library
// selection (that used to fire pipeline runs on stray Enter / arrow presses).
document.addEventListener("keydown", (event) => {
  const tag = (event.target?.tagName || "").toLowerCase();
  const isEditing = tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable;
  if (isEditing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!modalRootEl.hidden) return;

  switch (event.key) {
    case "+": case "=": event.preventDefault(); zoomVp(viewports.output, 1.2); break;
    case "-": case "_": event.preventDefault(); zoomVp(viewports.output, 1 / 1.2); break;
    case "0": event.preventDefault(); actualVp(viewports.output); break;
    case "f": event.preventDefault(); fitVp(viewports.output); break;
    case "b": event.preventDefault(); cycleBg("output"); break;
    case "?": event.preventDefault(); openShortcutsModal(); break;
    case "O": event.preventDefault(); editor.selectArtboard(); break;   // Shift+O — Illustrator's Artboard tool
  }
});

// Spacebar = temporary Hand tool (Illustrator): hold space and drag to pan, even
// when artwork covers the whole canvas. editor._onPointerDown bails while it's
// held so the viewport's own pan handler (bindViewportDragging) takes the drag.
{
  const stageWrap = document.querySelector(".stage-wrap");
  const release = () => { editor._spacePan = false; if (stageWrap) stageWrap.classList.remove("space-pan"); };
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || editor._spacePan) return;
    const t = (e.target?.tagName || "").toLowerCase();
    if (t === "input" || t === "textarea" || t === "select" || t === "button" || e.target?.isContentEditable) return;
    if (!modalRootEl.hidden) return;
    editor._spacePan = true;
    if (stageWrap) stageWrap.classList.add("space-pan");
    e.preventDefault();   // don't scroll the page
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") release(); });
  window.addEventListener("blur", release);   // never let the grab cursor stick
}

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = activityState === "busy" ? 1500 : 8000;
  pollTimer = setTimeout(async () => {
    const wasBusy = activityState === "busy";
    try {
      const { completionsHappened, completedNow } = await loadJobs();
      if (wasBusy || activityState === "busy" || completionsHappened) {
        // refresh outputs + library, but NOT the canvas — auto-landing the result is
        // handled below, and only for the item the user is actually viewing.
        applyOutputsData(await fetchOutputs());
        refreshLibrary();
      }
      if (completionsHappened) {
        const stem = selectedName ? stem_(selectedName) : null;
        const touchesSelection = stem && completedNow.some(
          (j) => j.source_name && stem_(j.source_name) === stem
        );
        refreshLibrary();
        if (touchesSelection) {
          // Force fresh mount so the new artifact lands on the canvas automatically.
          manualOutputName = null;
          editor.pinned = false;
          if (viewports.output) {
            viewports.output.url = null;
            viewports.output.path = null;
            viewports.output.name = null;
          }
          await renderPreviews();
        }
      }
    } catch {}
    schedulePoll();
  }, delay);
}
schedulePoll();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) schedulePoll();
});

// =========================================================================
// Service exports for the editor module. Live bindings (so editor reads the
// current selectedOutput); writes route through a setter since ESM imports
// are read-only.
// =========================================================================
export function setManualOutputName(v) { manualOutputName = v; }
export { setStatus, api, refreshAll, viewports, measureFit, outputPreviewEl, selectedOutput, inlineSvgImages, serializeForSave };

// =========================================================================
// Window bridge — exposes the library, the editor, and a small mutable app
// surface for in-browser automation and the E2E suite (which both read and
// write selectedName / selectedOutput / manualOutputName).
// =========================================================================
window.hv = hv;
window.editor = editor;
// Handles exposed directly so in-browser automation / the E2E suite can drive
// the app by bare name (module scope is otherwise private).
window.viewports = viewports;
window.applyViewportState = applyViewportState;
window.measureFit = measureFit;
window.mountStageFromText = mountStageFromText;
window.closeModal = closeModal;
window.newBlankDoc = newBlankDoc;
window.openOpenModal = openOpenModal;
window.renderProcessorPanel = renderProcessorPanel;
window.effectiveProcessKind = effectiveProcessKind;
window.zoomVp = zoomVp;
window.fitVp = fitVp;
window.settings = settings;
window.hideFloatPanel = hideFloatPanel;
// Detail (Info) views — exposed for the gallery cells' right-click and for tests.
window.openInfoModal = openInfoModal;
window.openVectorInfoModal = openVectorInfoModal;
window.openProjectInfo = openProjectInfo;
// Mutable selection state goes through accessors (ESM module bindings can't be
// reassigned by name from outside the module).
window.app = {
  viewports, applyViewportState, measureFit, mountStageFromText,
  openFromFile, downloadCurrentSvg, exportFlow, loadVersion,
  get selectedName() { return selectedName; }, set selectedName(v) { selectedName = v; },
  get selectedOutput() { return selectedOutput; }, set selectedOutput(v) { selectedOutput = v; },
  get manualOutputName() { return manualOutputName; }, set manualOutputName(v) { manualOutputName = v; },
  get versionInfo() { return versionInfo; },
  // Live-vectorize introspection / test harness (no network): arm the live state so a
  // control's change handler exercises the real wiring, then read the re-trace counter.
  inlineSvgImages,   // exposed for the E2E: bake <image> hrefs → data URIs (self-contained export)
  serializeForSave,  // self-contained save serializer (bake, or linked with explicit consent) — for the E2E
  setSaveByteCap(n) { _saveByteCap = n; },   // test seam: force/clear the save cap without a giant raster
  get workItems() { return workItems; },     // exposed for the E2E (library auto-load-on-run test)
  openToolsSettings,                          // deep-link to Settings → AI models & tools (install hub)
  get engineSchemas() { return engineSchemas; },
  get rasterOpSchemas() { return rasterOpSchemas; },
  get rasterLiveKicks() { return rasterLiveKicks; },
  get rasterOpKicks() { return rasterOpKicks; },
  armRasterLive(id) { rasterLive = true; rasterLiveNode = editor.nodeById(id); },
  disarmRasterLive() { endRasterLive(false); },
  armRasterOp(id, op) { rasterOp = true; rasterOpNode = editor.nodeById(id); rasterOpName = op; rasterOpOrig = rasterHref(rasterOpNode); },
  disarmRasterOp() { endRasterOpLive(false); },
};
