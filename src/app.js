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
const dropzoneEl = document.querySelector("#dropzone");
const queueEl = document.querySelector("#queue");
const workspaceTitleEl = document.querySelector("#workspace-title");
const workspacePathEl = document.querySelector("#workspace-path");
const processSelectEl = document.querySelector("#process-select");
const modeSelectEl = document.querySelector("#mode-select");
const settingsButtonEl = document.querySelector("#settings-button");
const outputPreviewEl = document.querySelector("#output-preview");
const statusTextEl = document.querySelector("#status-text");
const forceInputEl = document.querySelector("#force-input");
const runButtonEl = document.querySelector("#run-button");
const libraryHeaderEl = document.querySelector("#process-count");
const sourcePathEl = document.querySelector("#source-path");
const sourceEditEl = document.querySelector("#source-edit");
const sourceResetEl = document.querySelector("#source-reset");
const sourceRowEl = document.querySelector(".source-row");
const outputLabelEl = document.querySelector("#output-label");
const modalRootEl = document.querySelector("#modal-root");
const modalTitleEl = document.querySelector("#modal-title");
const modalBodyEl = document.querySelector("#modal-body");
const modalSearchEl = document.querySelector("#modal-search");
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

const TRACE_PRESETS = {
  draft:    { filter_speckle: "12", corner_threshold: "120", segment_length: "8",   splice_threshold: "80",  path_precision: "1" },
  balanced: { filter_speckle: "6",  corner_threshold: "85",  segment_length: "4.5", splice_threshold: "45",  path_precision: "2" },
  smooth:   { filter_speckle: "4",  corner_threshold: "150", segment_length: "9",   splice_threshold: "120", path_precision: "3" },
  sharp:    { filter_speckle: "2",  corner_threshold: "45",  segment_length: "3.5", splice_threshold: "20",  path_precision: "4" },
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
      renderQueue(); await renderPreviews(); return true;
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
let selectedName = null;
let selectedOutput = null;
let manualOutputName = null;
let workspace = null;
let statusHoldUntil = 0;
let sourceInfo = { source_dir: "", default_dir: "", is_default: true };
let outputsDir = "";

function joinAbsPath(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, "") : String(p).replace(/^\/+|\/+$/g, "")))
    .join("/");
}

function absInputPath(item) {
  if (!item) return "";
  if (item.path && item.path.startsWith("/")) return item.path;
  return joinAbsPath(sourceInfo.source_dir, item.name);
}

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
  const process = processSelectEl.value;
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

function updateLibraryHeader() {
  if (!libraryHeaderEl) return;
  libraryHeaderEl.textContent = workItems.length ? String(workItems.length) : "";   // corner badge on the Process icon
}

const LIBRARY_GROUPS_KEY = "hector-vector:library-groups";
let libraryGroupCollapsed = loadLibraryGroups();

function loadLibraryGroups() {
  try {
    const raw = localStorage.getItem(LIBRARY_GROUPS_KEY);
    if (!raw) return { unprocessed: false, processed: true };
    return { unprocessed: false, processed: true, ...JSON.parse(raw) };
  } catch {
    return { unprocessed: false, processed: true };
  }
}

function persistLibraryGroups() {
  try {
    localStorage.setItem(LIBRARY_GROUPS_KEY, JSON.stringify(libraryGroupCollapsed));
  } catch {}
}

function itemIsProcessed(name) {
  return latestOutputsFor(name).length > 0;
}

function renderQueue() {
  queueEl.innerHTML = "";
  updateLibraryHeader();
  if (!workItems.length) {
    queueEl.innerHTML = `<div class="queue-empty">Drop images here.</div>`;
    selectedName = null;
    return;
  }
  if (!workItems.some((item) => item.name === selectedName)) selectedName = workItems[0].name;

  const unprocessed = workItems.filter((it) => !itemIsProcessed(it.name));
  const processed = workItems.filter((it) => itemIsProcessed(it.name));

  renderQueueGroup("Unprocessed", unprocessed, "unprocessed");
  renderQueueGroup("Processed", processed, "processed");
}

function renderQueueGroup(label, items, groupKey) {
  if (!items.length) return;
  const collapsed = !!libraryGroupCollapsed[groupKey];
  const header = document.createElement("button");
  header.type = "button";
  header.className = "queue-group-header";
  header.innerHTML = `<span class="group-caret">${collapsed ? "▸" : "▾"}</span> ${label} <span class="group-count">(${items.length})</span>`;
  header.addEventListener("click", () => {
    libraryGroupCollapsed[groupKey] = !collapsed;
    persistLibraryGroups();
    renderQueue();
  });
  queueEl.appendChild(header);
  if (collapsed) return;

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `queue-item ${groupKey} ${item.name === selectedName ? "active" : ""}`;
    if (groupKey === "processed") {
      const dot = document.createElement("span");
      dot.className = "queue-dot";
      dot.textContent = "•";
      button.appendChild(dot);
    }
    const text = document.createElement("span");
    text.className = "queue-text";
    text.textContent = item.name;
    button.appendChild(text);
    button.title = item.name;
    button.addEventListener("click", () => {
      if (selectedName !== item.name) manualOutputName = null;
      selectedName = item.name;
      editor.pinned = false;
      selectedOutput = preferredOutput(selectedName);
      renderQueue();
      renderPreviews();
    });
    queueEl.appendChild(button);
  }
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
  renderQueue();
}

async function fetchStatus() {
  return api("/api/status");
}

function applyStatusData(data) {
  workspace = data;
  workspaceTitleEl.textContent = workspace.workspace_name || "Workspace";
  workspacePathEl.textContent = workspace.workspace_dir || "";
  outputsDir = workspace.outputs_dir || "";
  sourceInfo = {
    source_dir: workspace.source_dir || "",
    default_dir: workspace.default_source_dir || "",
    is_default: workspace.source_dir === workspace.default_source_dir,
  };
  renderSourceRow();
}

function renderSourceRow() {
  sourcePathEl.textContent = sourceInfo.source_dir || "(unset)";
  sourcePathEl.title = sourceInfo.source_dir;
  sourceResetEl.hidden = !!sourceInfo.is_default;
}

async function fetchOutputs() {
  return api("/api/outputs");
}

function applyOutputsData(data) {
  outputs = data;
}

async function loadOutputs() {
  applyOutputsData(await fetchOutputs());
  renderQueue();
  await renderPreviews();
}

let lastBatchFailCount = -1;
let activityState = "idle"; // "idle" | "busy"
const knownJobStates = new Map();
const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
let jobsCache = [];
let processModalOpen = false;
let settingsFormRerender = null;   // where buildSettingsForm re-renders to (Settings modal vs Process workspace)

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

  if (processModalOpen) renderProcessJobs();

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
      { error: true, onClick: () => openProcessModal(true), title: tail }
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
  renderQueue();
  await renderPreviews();
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
  const stop = () => { dragging = false; };
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

function beginSourceEdit() {
  if (sourceRowEl.querySelector(".source-edit-input")) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "source-edit-input";
  input.value = sourceInfo.source_dir || "";
  input.placeholder = "/absolute/path/to/folder";
  const submit = async () => {
    const next = input.value.trim();
    if (next === (sourceInfo.source_dir || "")) {
      cleanup();
      return;
    }
    try {
      const data = await api("/api/source", "POST", { path: next });
      setStatus(data.message || "Source updated.", 2500);
      sourceInfo = data;
      await refreshAll();
    } catch (error) {
      setStatus(error.message, 4000);
    } finally {
      cleanup();
    }
  };
  const cleanup = () => {
    input.replaceWith(sourcePathEl);
    sourceEditEl.hidden = false;
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") cleanup();
  });
  input.addEventListener("blur", cleanup);
  sourcePathEl.replaceWith(input);
  sourceEditEl.hidden = true;
  input.focus();
  input.select();
}

async function setSourceDir(next) {
  next = (next || "").trim();
  try {
    const data = await api("/api/source", "POST", { path: next });
    setStatus(data.message || "Source updated.", 2500);
    sourceInfo = data;
    await refreshAll();
  } catch (error) { setStatus(error.message, 4000); }
}

// Change the image source folder (the inline rail editor moved into the header
// Import ▾ menu, so source-change now opens a small modal).
function openSourceModal() {
  openModal("Source folder", true);
  modalSearchEl.hidden = true;
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Library source"));
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = sourceInfo.source_dir || ""; inp.placeholder = "/absolute/path/to/folder";
  root.appendChild(fieldRow("Folder", inp, sourceInfo.is_default ? "Currently the default folder." : ""));
  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Set source", async () => { await setSourceDir(inp.value); closeModal(); }));
  if (!sourceInfo.is_default) actions.appendChild(ghostBtn("Reset to default", async () => { await setSourceDir(""); closeModal(); }));
  root.appendChild(actions);
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
  inp.focus();
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
  processModalOpen = false;
  appSettingsOpen = false;
  updateViewSwap();
}

// Reflect the active "view" on the Edit/Process swap (Ableton-style): Process is
// active only while its workspace is open; otherwise Edit (the canvas) is active.
function updateViewSwap() {
  const edit = document.querySelector("#view-edit");
  const proc = document.querySelector("#process-button");
  if (edit) edit.classList.toggle("active", !processModalOpen);
  if (proc) proc.classList.toggle("active", !!processModalOpen);
}

// Toggle between the two views. Process opens its workspace; Edit closes whatever
// modal is up and returns to the canvas.
function showProcessView() { if (!processModalOpen) openProcessModal(); }
function showEditView() { if (!modalRootEl.hidden) closeModal(); }
function toggleProcessView() { if (processModalOpen) showEditView(); else if (modalRootEl.hidden) showProcessView(); }

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
    <div class="cp-recent" hidden><span class="cp-strip-lab">Recent</span><div class="cp-recent-row"></div></div>
    <div class="cp-swatches"></div>
    <div class="cp-actions">
      ${opts.allowNone ? `<button type="button" class="ghost-button cp-none">None</button>` : ""}
      <span class="cp-spacer"></span>
      ${opts.host ? "" : `<button type="button" class="ghost-button cp-cancel">Cancel</button><button type="button" class="ghost-button cp-ok">OK</button>`}
    </div>`;
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
          { label: "Rename…", onClick: () => { const n = window.prompt("Swatch name:", it.name || ""); if (n == null) return; const arr = loadSwatches(); const m = arr.find((x) => x.c === it.c); if (m) { m.name = n.trim() || undefined; saveSwatches(arr); renderSwatches(); } } },
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

sourceEditEl.addEventListener("click", beginSourceEdit);
sourcePathEl.addEventListener("click", beginSourceEdit);
sourceResetEl.addEventListener("click", async () => {
  try {
    const data = await api("/api/source", "POST", { path: "" });
    setStatus(data.message || "Source reset.", 2000);
    sourceInfo = data;
    await refreshAll();
  } catch (error) {
    setStatus(error.message, 3000);
  }
});

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
  const text = editor.serialize() ||
    (viewports.output.url ? await (await fetch(viewports.output.url)).text() : "");
  if (!text) return;
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

function downloadCurrentSvg() {
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  const text = editor.serialize();
  if (!text) { setStatus("Nothing to download.", 2500); return; }
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
      if (wi) { editor.pinned = false; selectedName = wi.name; manualOutputName = picked.name; renderQueue(); refreshAll(); }
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
  const svg = editor.serialize(); if (!svg) return;
  try {
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
    const svg = editor.serialize(); if (!svg) return;
    try {
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

async function exportFlow() {
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  // No save target yet → route through Save-As, then continue to Export (no dead end).
  if (!selectedOutput) { saveAsDocument(() => openExportModal()); return; }
  if (editor.dirty) await saveDocument();
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
function openAppSettings() {
  openModal("Settings", true);
  modalSearchEl.hidden = true;
  appSettingsOpen = true;
  const root = document.createElement("div"); root.className = "form";

  root.appendChild(sectionTitle("General"));
  root.appendChild(fieldRow("On launch",
    makeSelectRaw(prefs.startup, [["blank", "Blank canvas + Process"], ["resume", "Resume last document"]],
      (v) => { prefs.startup = v; persistPrefs(); }),
    "What to show when the app opens. Blank starts fresh and opens the Process workspace."));
  root.appendChild(prefToggleRow("Smart guides", editor.smartGuides,
    (v) => { editor.smartGuides = v; prefs.smartGuides = v; persistPrefs(); }, "Snap to other objects' edges/centres while moving."));

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
  root.appendChild(sectionTitle("AI models & tools"));
  const aiTools = [
    { key: "rembg_installed",     name: "rembg (AI cutout)",      endpoint: "/api/install/rembg",     size: "~500MB",     note: "High-quality background removal.", ok: () => true },
    { key: "realesrgan_installed", name: "Real-ESRGAN (upscale)", endpoint: "/api/install/realesrgan", size: "~25MB",      note: "4× photo / anime upscaling.", ok: (w) => w && w.curl_available && w.unzip_available, need: "Needs curl + unzip." },
    { key: "vtracer_installed",   name: "VTracer (tracing)",      endpoint: "/api/install/vtracer",   size: "cargo build", note: "Raster → vector tracing engine.", ok: (w) => w && w.cargo_available, need: "Needs cargo (Rust toolchain)." },
  ];
  for (const t of aiTools) {
    const row = document.createElement("div"); row.className = "form-row";
    const label = document.createElement("span"); label.className = "form-label"; label.textContent = t.name;
    row.appendChild(label);
    const box = document.createElement("div"); box.style.display = "flex"; box.style.flexDirection = "column"; box.style.gap = "6px";
    if (workspace && workspace[t.key]) {
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Installed ✓"; box.appendChild(s);
    } else if (!t.ok(workspace)) {
      const b = ghostBtn("Install unavailable", () => {}); b.disabled = true; box.appendChild(b);
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = t.need; box.appendChild(s);
    } else {
      const reset = `Install (${t.size})`;
      const btn = ghostBtn(reset, async () => {
        btn.disabled = true; btn.textContent = "Installing…";
        try {
          const data = await api(t.endpoint, "POST", {});
          setStatus(data.message || "Install started.", 3000);
          await loadJobs();
        } catch (e) { setStatus(e.message, 3000); btn.disabled = false; btn.textContent = reset; }
      });
      box.appendChild(btn);
      const s = document.createElement("span"); s.className = "form-hint"; s.textContent = `${t.note} Runs in background — watch Jobs.`; box.appendChild(s);
    }
    row.appendChild(box);
    root.appendChild(row);
  }
  const refreshWrap = document.createElement("div"); refreshWrap.className = "form-actions";
  refreshWrap.appendChild(ghostBtn("Refresh status", async () => {
    try { applyStatusData(await fetchStatus()); if (appSettingsOpen) openAppSettings(); }
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
  const pickFor = (which) => { active = which; refreshSwatches(); if (window.__docks) window.__docks.showColor(which); };
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
  refreshSwatches();
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
  wire("#act-invert", () => editor.invertSpace());
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
    // rotate/flip/invert act on the selection, or on the artboard itself when it's selected;
    // grey when nothing is selected (no objects, no artboard)
    const canXform = hasSel || (has && editor.artboardSelected);
    ["#act-rotate-cw", "#act-rotate-ccw", "#act-flip-h", "#act-flip-v", "#act-invert"].forEach((id) => set(id, canXform));
    // Layers header: reorder/group/ungroup/rename/delete (selection-gated) + cleanup/merge (whole doc)
    ["#layer-front", "#layer-forward", "#layer-backward", "#layer-back", "#layer-delete"].forEach((id) => set(id, hasSel));
    set("#layer-group", n >= 2); set("#layer-ungroup", hasGroup); set("#layer-rename", n === 1);
    set("#layer-cleanup", has); set("#layer-merge", has);
  };
  const prevOnInspect = editor.onInspect;
  editor.onInspect = () => { if (prevOnInspect) prevOnInspect(); refreshActionButtons(); renderFloatPanel(); updateSelLabel(); };
  refreshActionButtons();
}
{
  const procBtn = document.querySelector("#process-button"); if (procBtn) procBtn.addEventListener("click", () => showProcessView());
  const editBtn = document.querySelector("#view-edit"); if (editBtn) editBtn.addEventListener("click", () => showEditView());
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
    const HDR_TILE_CAP = 3;   // panel headers stay sane at min width — at most 3 action tiles
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
      saveProfilePrompt: () => {
        const n = window.prompt("Save current layout as a profile:", activeProfile || "");
        if (n == null) return; const nm = n.trim(); if (!nm) return;
        if ((nm in loadProfiles()) && !window.confirm(`A profile named "${nm}" exists. Overwrite it?`)) return;
        if (saveProfile(nm)) setStatus(`Saved layout profile "${nm}".`, 1800);
      },
      renamePrompt: (name) => { const n = window.prompt("Rename layout profile:", name); if (n == null) return; if (!renameProfile(name, n) && n.trim() && n.trim() !== name) setStatus(`A profile named "${n.trim()}" already exists.`, 2400); },
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
      if (window.__docks) window.__docks.relayout();   // docked: recompute the height split
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
    const ORDER = ["history", "layers", "properties", "color"];   // home identity order
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
    let propsSection = null, colorSection = null;
    function ensureProps() { if (!propsSection) propsSection = mkPanel("properties", "Properties", "context-panel"); return propsSection; }
    function ensureColor() { if (!colorSection) colorSection = mkPanel("color", "Colour"); return colorSection; }
    const sectionEl = (name) => name === "properties" ? propsSection : name === "color" ? colorSection : document.querySelector(`.rail-section[data-section="${name}"]`);
    const isFloat = (name) => { const s = sectionEl(name); return !!(s && s.closest(".dock-window")); };
    const curLoc = (name) => { const s = sectionEl(name); if (!s || !s.parentElement) return null; if (s.closest(".dock-window")) return "float"; return s.parentElement === leftDock ? "left" : "right"; };

    const DEFAULT_LOC = { history: "right", layers: "right", properties: "right", color: "right" };
    let state = {};
    ORDER.forEach((n, i) => state[n] = { loc: DEFAULT_LOC[n], order: i, rect: null, visible: false });
    try { const s = JSON.parse(localStorage.getItem(DOCKS_KEY) || "null"); if (s) for (const n of ORDER) if (s[n]) state[n] = { ...state[n], ...s[n] }; } catch {}
    // Properties + Colour are permanent panel items now — a previously CLOSED one (float +
    // invisible) returns to its dock so panels can never go missing.
    for (const n of ["properties", "color"]) if (state[n].loc === "float" && !state[n].visible) state[n].loc = DEFAULT_LOC[n] || "right";
    const persist = () => { try { localStorage.setItem(DOCKS_KEY, JSON.stringify(state)); localStorage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch {} };
    const isShown = (name) => state[name].loc !== "float" || state[name].visible;
    const propsVisible = () => isShown("properties");

    function renderProps() {
      if (!propsSection || !propsSection.parentElement || !propsVisible()) return;
      const title = propsSection.querySelector(".fp-title"), body = propsSection.querySelector(".fp-body");
      if (!body) return; body.innerHTML = "";
      // Bottom chin: the align-to-artboard bar (null unless a non-artboard object is selected).
      const foot = propsSection.querySelector(".insp-foot");
      if (foot) { foot.innerHTML = ""; const bar = editor._alignBar && editor._alignBar(); if (bar) foot.appendChild(bar); }
      if (!editor.stage) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">No canvas.</div>`; return; }
      if (editor.artboardSelected) { title.textContent = "Artboard"; body.appendChild(editor._artboardPanel()); return; }
      let nodes = editor._effectiveLeaves(); if (!nodes.length) nodes = editor.selectedNodes();
      if (!nodes.length) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">Select an object, or right-click the canvas for the artboard.</div>`; return; }
      title.textContent = nodes.length === 1 ? "Object" : `${nodes.length} objects`;
      body.appendChild(editor._objectPanel(nodes));
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
    function renderPanels() { renderProps(); renderColor(); }

    function detachFromWindow(name) {
      const s = sectionEl(name); if (!s) return;
      const w = s.closest(".dock-window");
      if (w) { if (w._ro) w._ro.disconnect(); s.remove(); w.remove(); }
      else if (s.parentElement) s.remove();
    }
    const SUMMONED = new Set(["properties", "color"]);   // built on demand, summon/close-able
    function ensureSection(name) { return name === "properties" ? ensureProps() : name === "color" ? ensureColor() : sectionEl(name); }
    function ensureFloatWin(name, atX, atY) {
      const s = ensureSection(name); if (!s) return null;
      let w = s.closest(".dock-window"); if (w) return w;
      const r = s.getBoundingClientRect(), prev = state[name].rect, detaching = atX != null;
      // Keep the panel's current size when it's dragged out of a dock; otherwise reuse the
      // last float size (or a sensible default).
      const ww = (detaching && r.width > 40) ? r.width : (prev?.w || Math.max(220, r.width || 260));
      const wh = (detaching && r.height > 40) ? r.height : (prev?.h || Math.max(200, r.height || 320));
      const x = atX != null ? atX : (prev?.x ?? Math.max(8, Math.min((r.left || innerWidth - ww - 12), innerWidth - ww - 8)));
      const y = atY != null ? atY : (prev?.y ?? Math.max(64, r.top || 80));
      w = document.createElement("div");
      w.className = "dock-window" + (SUMMONED.has(name) ? " float-panel" : "");
      w.dataset.dockWindow = name;
      w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = ww + "px"; w.style.height = wh + "px";
      document.body.appendChild(w); w.appendChild(s);
      s.style.flex = "";   // shed the docked flex (inline 0 0 Npx) so the section fills the float window instead of staying fixed-height
      s.classList.remove("collapsed");
      w._ro = new ResizeObserver(() => { const b = w.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); });
      w._ro.observe(w);
      return w;
    }

    // Reconcile the DOM from `state` (placement + ordering + dock visibility + grid).
    function reconcile() {
      for (const name of ORDER) {
        const st = state[name];
        if (SUMMONED.has(name) && st.loc === "float" && !st.visible) { detachFromWindow(name); continue; }
        if (st.loc === "float") ensureFloatWin(name);
      }
      for (const side of ["left", "right"]) {
        const dock = dockElFor(side);
        const items = ORDER.filter((n) => state[n].loc === side && !isFloatWanted(n)).sort((a, b) => (state[a].order || 0) - (state[b].order || 0));
        for (const n of items) { const s = ensureSection(n); if (!s) continue; detachWinKeepSection(n); s.style.flex = ""; dock.appendChild(s); }
      }
      syncChrome();
      renderPanels();   // (re)fill Properties / Colour bodies for their current state
    }
    const isFloatWanted = (n) => state[n].loc === "float";
    function detachWinKeepSection(name) { const s = sectionEl(name); const w = s && s.closest(".dock-window"); if (w) { if (w._ro) w._ro.disconnect(); w.remove(); document.body.appendChild(s); } }

    // Resize between stacked docked panels: every section but the last in a dock gets an
    // explicit height + a drag handle below it; the last fills the remainder.
    function relayoutDock(side) {
      const dock = dockElFor(side);
      dock.querySelectorAll(".dock-vsep").forEach((s) => s.remove());
      const secs = [...dock.querySelectorAll(":scope > .rail-section")];
      secs.forEach((sec, i) => {
        const name = sec.dataset.section, collapsed = sec.classList.contains("collapsed");
        if (i < secs.length - 1 && !collapsed) {
          sec.style.flex = "0 0 " + (state[name].h || Math.max(120, Math.round((dock.getBoundingClientRect().height || 600) / secs.length))) + "px";
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

    function setLoc(name, loc, beforeName) {
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
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".panel-actions") || e.button !== 0) return;
        const name = section.dataset.section;
        const sx = e.clientX, sy = e.clientY;
        let moved = false, win = section.closest(".dock-window"), offX = 24, offY = 12;
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
          showDrop(dropTarget(ev.clientX, ev.clientY));
        };
        const onUp = (ev) => {
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          hideDrop(); if (win) win.classList.remove("dragging");
          if (moved) {
            const t = dropTarget(ev.clientX, ev.clientY);
            if (t) setLoc(name, t.side, t.before);
            else { state[name].loc = "float"; if (win) { const b = win.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; } reconcile(); persist(); }
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
      if (state[name].loc === "float") {
        state[name].visible = true;
        if (!sectionEl(name).closest(".dock-window")) ensureFloatWin(name, (x != null ? x + 6 : null), (y != null ? y + 6 : null));
      }
      const sec = sectionEl(name);
      if (sec) { sec.classList.remove("collapsed"); try { localStorage.setItem("hv-sec-" + name, "0"); } catch {} }   // focusing a panel expands it
      syncChrome();
      if (name === "color") { lastColorKey = null; renderColor(); } else renderProps();
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "nearest" });
    }
    // The × on a floating panel re-docks it (panels are permanent items — never orphaned).
    function close(name) { setLoc(name, "right"); }
    const summonProps = (x, y) => show("properties", x, y);
    const hideProps = () => {};   // panels are permanent now; Esc no longer dismisses them
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

    reconcile();
    window.__docks = {
      float: (n) => setLoc(n, "float"), dock: (n, side, before) => setLoc(n, side || "right", before),
      loc: curLoc, isFolded: () => folded, toggleFold: () => { folded = !folded; reconcile(); persist(); },
      summonProps, hideProps, showColor, close, renderProps, renderPanels, renderColor, propsVisible,
      relayout: () => { relayoutDock("left"); relayoutDock("right"); },
      state: () => state,
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
  if (event.key === "Tab" || event.key === "q" || event.key === "Q") {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    toggleProcessView();
    return;
  }
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
// Redesigned object/canvas context: a persistent panel holding the style editors
// (fill/stroke/opacity, or artboard size/background) plus all the actions in one
// place. Style edits are live; actions execute and rebuild the panel in place
// (closing if the selection empties). Dismiss with Esc or a click on the canvas.
// ---------- floating Properties panel (persistent, summoned on right-click) ----------
// One reusable window: a draggable titlebar (context title + close ×) over a live body
// that mirrors the selection (object style / artboard / empty). It PERSISTS — no
// click-away dismiss — and re-renders on every selection change, so it doubles as a
// floating Properties/Appearance palette. Summon with right-click; close with ×.
// The Properties panel is now a fully dockable object owned by the Dockable-panels
// module (window.__docks). These remain as the names the rest of the app calls.
function renderFloatPanel() { if (window.__docks) window.__docks.renderPanels(); }
function hideFloatPanel() { if (window.__docks) window.__docks.hideProps(); }
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
function showContextPanel(x, y, _kind) {
  hideContextMenu();
  if (window.__docks) window.__docks.summonProps(x, y);
}
function toggleFloatPanel() {
  if (!window.__docks) return;
  if (window.__docks.propsVisible()) window.__docks.hideProps();
  else window.__docks.summonProps(window.innerWidth - 270, 96);
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideContextMenu(); hideFloatPanel(); } });
window.addEventListener("blur", hideContextMenu);
window.addEventListener("pagehide", () => { rememberLastDoc(); editor.dispose(); });   // remember the doc, then free its state on close
// Pen tool: hold Ctrl/Cmd to temporarily act as Direct-Select (move anchors/handles).
document.addEventListener("keydown", (e) => { if ((e.key === "Control" || e.key === "Meta") && editor.tool === "pen") editor.enterPenTempSelect(); });
document.addEventListener("keyup", (e) => { if (e.key === "Control" || e.key === "Meta") editor.exitPenTempSelect(); });
window.addEventListener("blur", () => editor.exitPenTempSelect());

let exportState = { mode: "scale", scale: 16, longest: 1024, width: 0, height: 0, background: "transparent" };

async function svgNativeSize(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    const vb = text.match(/viewBox\s*=\s*"\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/);
    if (vb) return [Math.round(+vb[1]), Math.round(+vb[2])];
    const w = text.match(/\bwidth\s*=\s*"([\d.]+)"/);
    const h = text.match(/\bheight\s*=\s*"([\d.]+)"/);
    if (w && h) return [Math.round(+w[1]), Math.round(+h[1])];
  } catch {}
  return null;
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

async function openExportModal() {
  if (!selectedOutput || viewports.output.kind !== "svg") return;
  openModal("Export PNG", true);
  modalSearchEl.hidden = true;
  const native = await svgNativeSize(selectedOutput.url);
  const root = document.createElement("div");
  root.className = "form";

  const sizeOut = document.createElement("div");
  sizeOut.className = "form-hint";

  const refreshSizeOut = () => {
    const [w, h] = targetSizeFor(native);
    sizeOut.textContent = native
      ? `Native ${native[0]}×${native[1]} → output ${w}×${h} px`
      : `Output ${w}×${h} px`;
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
    root.appendChild(fieldRow("Scale", sel, "Pixel-exact — each native pixel becomes an N×N block."));
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
  go.type = "button";
  go.textContent = "Export PNG";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Rendering…";
    const [w, h] = targetSizeFor(native);
    const payload = { folder: selectedOutput.folder, name: selectedOutput.name, background: exportState.background };
    if (exportState.mode === "scale") payload.scale = exportState.scale;
    else if (exportState.mode === "longest") {
      if (native && native[0] >= native[1]) payload.width = w; else payload.height = h;
      if (!native) payload.width = exportState.longest;
    } else { payload.width = w; payload.height = h; }
    try {
      const data = await api("/api/render", "POST", payload);
      manualOutputName = data.name;
      await refreshAll();
      setStatus(data.message || "Rendered.", 3000);
      showExportResult(data);   // success step: Download PNG / Reveal / Done — not a dead end
    } catch (e) {
      go.disabled = false;
      go.textContent = "Export PNG";
      const hint = document.createElement("div");
      hint.className = "form-hint status-error";
      hint.textContent = e.message;
      actions.appendChild(hint);
    }
  });
  actions.appendChild(go);
  root.appendChild(actions);

  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}

// After a render, give the PNG a real exit: download it to disk, reveal it in the
// file manager, or close. (Before, the modal just closed and the file was stranded
// in the outputs folder.)
function showExportResult(data) {
  const url = `/outputs/${encodeURIComponent(data.folder)}/${encodeURIComponent(data.name)}`;
  modalTitleEl.textContent = "Exported";
  const root = document.createElement("div"); root.className = "form";
  root.appendChild(sectionTitle("Rendered"));
  const info = document.createElement("div"); info.className = "form-hint";
  info.textContent = `${data.name} — ${data.size[0]}×${data.size[1]} px (${data.backend}).`;
  root.appendChild(info);
  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Download PNG", async () => {
    try {
      const blob = await (await fetch(url)).blob();
      downloadBlob(data.name, blob, "image/png");
      setStatus(`Downloaded ${data.name}.`, 2000);
    } catch (e) { setStatus(`Download failed: ${e.message}`, 3000); }
  }));
  if (data.output) actions.appendChild(ghostBtn("Reveal", () => revealInFileManager(data.output)));
  actions.appendChild(ghostBtn("Open", () => window.open(url, "_blank", "noopener")));
  actions.appendChild(ghostBtn("Done", () => closeModal()));
  root.appendChild(actions);
  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
}

dropzoneEl.addEventListener("click", () => fileInputEl.click());

let dragDepth = 0;
function clearDragState() {
  dragDepth = 0;
  dropzoneEl.classList.remove("drag");
}
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  dropzoneEl.classList.add("drag");
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

processSelectEl.addEventListener("change", () => {
  renderPreviews().catch((error) => setStatus(error.message, 2500));
});

const FORCE_KEY = "hector-vector:force";
if (forceInputEl) {
  forceInputEl.checked = localStorage.getItem(FORCE_KEY) === "1";
  forceInputEl.addEventListener("change", () => {
    try { localStorage.setItem(FORCE_KEY, forceInputEl.checked ? "1" : "0"); } catch {}
  });
}

// True when the selected source already has an output for the chosen process.
// Single-mode runs send an explicit input, which the server processes
// unconditionally — so without this guard, re-running a done image silently
// redoes the whole pipeline (incl. the expensive upscale) into a fresh folder.
function alreadyProcessed(name, process) {
  const matches = latestOutputsFor(name);
  if (!matches.length) return false;
  if (process === "cutout") return matches.some((x) => x.name.includes(".cutout."));
  if (process === "chromakey") return matches.some((x) => x.name.includes(".chromakey."));
  if (process === "upscale") {
    return matches.some((x) => x.kind === "png"
      && !/\.(cutout|chromakey|preview|mask)\./.test(x.name));
  }
  return matches.some((x) => x.kind === "svg" && !x.name.includes(".edited."));   // vectorize / pixelvec / pipeline
}

async function runProcess() {
  if (runButtonEl.disabled) return;
  runButtonEl.disabled = true;
  const originalLabel = runButtonEl.textContent;
  runButtonEl.textContent = "Starting…";
  try {
    const payload = { ...settings };
    const proc = processSelectEl.value;
    const force = !!(forceInputEl && forceInputEl.checked);
    if (modeSelectEl.value === "single" && selectedName) {
      payload.inputs = [selectedName];
      if (!force && alreadyProcessed(selectedName, proc)) {
        setStatus(`“${selectedName}” is already processed — turn on Force to re-run.`, 4000);
        return;   // finally{} restores the button; no wasteful re-run
      }
    }
    if (force) payload.force = true;
    const data = await api(`/api/run/${proc}`, "POST", payload);
    lastBatchFailCount = 0;
    const hold = data.started === 0 ? 4000 : 1800;
    setStatus(data.message || "Started.", hold);
    await refreshAll();
  } catch (error) {
    setStatus(error.message, 3000);
  } finally {
    runButtonEl.disabled = false;
    runButtonEl.textContent = originalLabel;
  }
}
runButtonEl.addEventListener("click", runProcess);

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
  return actions;
}

function viewJobOutput(job) {
  const rel = chooseFinalOutput(job);
  if (job.source_name) selectedName = job.source_name;
  manualOutputName = rel ? jobOutputName(rel) : null;
  closeModal();
  renderQueue();
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
function buildJobsPanel() {
  const wrap = document.createElement("div");
  wrap.className = "jobs-panel";

  const toolbar = document.createElement("div");
  toolbar.className = "jobs-toolbar";
  const cancelAllBtn = document.createElement("button");
  cancelAllBtn.type = "button";
  cancelAllBtn.className = "ghost-button";
  cancelAllBtn.textContent = "Cancel all queued";
  cancelAllBtn.addEventListener("click", async () => {
    const queued = jobsCache.filter((j) => j.status === "queued");
    for (const j of queued) {
      try { await api("/api/jobs/cancel", "POST", { id: j.id }); } catch {}
    }
    await loadJobs();
  });
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ghost-button";
  clearBtn.textContent = "Clear finished";
  clearBtn.addEventListener("click", async () => {
    try {
      await api("/api/jobs/clear", "POST", {});
      await loadJobs();
    } catch (e) { setStatus(e.message, 3000); }
  });
  toolbar.appendChild(cancelAllBtn);
  toolbar.appendChild(clearBtn);
  wrap.appendChild(toolbar);

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
const PROCESS_OPTIONS = [
  ["pipeline", "Production SVG"], ["vectorize", "SVG Trace"], ["pixelvec", "Pixel Art → SVG"],
  ["cutout", "Cutout PNG"], ["upscale", "Upscale PNG"], ["chromakey", "Greenscreen Cutout"],
];

// The key backend choices for the selected pipeline, surfaced inline (first-class)
// instead of buried in Advanced. These bind straight to `settings`, so they drive
// runProcess directly; the pipeline combines several backends, so it shows all of
// them. Changing one that gates others (cutout backend) re-renders the workspace.
function processKeyOptions(proc) {
  const wrap = document.createElement("div"); wrap.className = "process-opts";
  const add = (label, control) => {
    const l = document.createElement("label"); l.className = "process-opt";
    const s = document.createElement("span"); s.textContent = label;
    l.appendChild(s); l.appendChild(control); wrap.appendChild(l);
  };
  if (proc === "upscale" || proc === "pipeline") {
    add("Model", makeSelect("model", [["realesrgan-x4plus", "ESRGAN x4+ (photo)"], ["realesrnet-x4plus", "ESRNet x4+ (clean)"], ["realesr-animevideov3", "Anime / line-art"]]));
    add("Scale", makeSelect("scale", [["2", "2×"], ["3", "3×"], ["4", "4×"]]));
  }
  if (proc === "vectorize" || proc === "pipeline") {
    const out = makeSelect("trace_colormode", [["bw", "B&W"], ["color", "Color"]]);
    out.addEventListener("change", () => renderProcessWorkspace());
    add("Output", out);
    if (settings.trace_colormode === "color") {
      add("Style", makeSelect("trace_color_style", [["poster", "Poster"], ["photo", "Photo"]]));
    }
    const preset = makeSelect("trace_preset", [["draft", "Draft"], ["balanced", "Balanced"], ["smooth", "Smooth"], ["sharp", "Sharp"], ["custom", "Custom"]]);
    preset.addEventListener("change", () => { const pre = TRACE_PRESETS[preset.value]; if (pre) { Object.assign(settings, pre); persistSettings(); } });
    add("Trace", preset);
    add("Curves", makeSelect("trace_mode", [["spline", "Spline"], ["polygon", "Polygon"], ["pixel", "Pixel"]]));
  }
  if (proc === "cutout" || proc === "pipeline") {
    const backend = makeSelect("cutout_backend", [["classical", "Classical (fast)"], ["ai", "AI (rembg)"]]);
    backend.addEventListener("change", () => renderProcessWorkspace());
    add("Cutout", backend);
    if (settings.cutout_backend === "ai") {
      add("AI model", makeSelect("cutout_model", [["u2net", "u2net"], ["isnet-general-use", "ISNet"], ["birefnet-general", "BiRefNet"], ["u2netp", "u2netp (fast)"], ["silueta", "silueta"]]));
    }
  }
  if (proc === "pixelvec") {
    add("Sample", makeSelect("pv_sample", [["mode", "Mode"], ["mean", "Mean"], ["median", "Median"]]));
  }
  return wrap;
}

function openProcessModal(focusJobs = false) {
  processModalOpen = true;
  openModal("Process — batch images to vectors");
  modalSearchEl.hidden = true;
  updateViewSwap();
  renderProcessWorkspace();
  if (focusJobs) { const j = document.querySelector("#process-jobs"); if (j) j.scrollIntoView({ block: "nearest" }); }
  loadJobs().catch(() => {});
}

function renderProcessWorkspace() {
  if (!processModalOpen) return;
  modalTitleEl.textContent = `Process — ${workItems.length} image(s)`;
  modalBodyEl.innerHTML = "";
  const root = document.createElement("div");
  root.className = "process-workspace";

  // --- controls bar ---
  const bar = document.createElement("div");
  bar.className = "process-controls";
  const procSel = makeSelectRaw(processSelectEl.value, PROCESS_OPTIONS, (v) => { processSelectEl.value = v; processSelectEl.dispatchEvent(new Event("change")); renderProcessWorkspace(); });
  procSel.title = "Pipeline to run";
  const modeSel = makeSelectRaw(modeSelectEl.value, [["batch", "Batch — whole library"], ["single", "Single — selected image"]], (v) => { modeSelectEl.value = v; modeSelectEl.dispatchEvent(new Event("change")); });
  const force = document.createElement("label"); force.className = "process-force";
  const forceBox = document.createElement("input"); forceBox.type = "checkbox"; forceBox.checked = forceInputEl.checked;
  forceBox.addEventListener("change", () => { forceInputEl.checked = forceBox.checked; });
  force.appendChild(forceBox); force.appendChild(document.createTextNode(" Force re-run"));
  const runBtn = document.createElement("button"); runBtn.type = "button"; runBtn.className = "primary-button"; runBtn.textContent = "Run → canvas";
  runBtn.addEventListener("click", () => runProcess());
  bar.appendChild(procSel);
  bar.appendChild(modeSel);
  bar.appendChild(force);
  bar.appendChild(ghostBtn("Add images", () => fileInputEl.click()));
  bar.appendChild(ghostBtn("Source…", openSourceModal));
  bar.appendChild(runBtn);
  root.appendChild(bar);

  // --- key backend options for this pipeline, inline (first-class) ---
  root.appendChild(processKeyOptions(processSelectEl.value));

  // --- advanced settings (collapsible, inline so it stays in one place) ---
  const adv = document.createElement("details");
  adv.className = "process-advanced";
  const sum = document.createElement("summary"); sum.textContent = "Advanced settings"; adv.appendChild(sum);
  settingsFormRerender = renderProcessWorkspace;   // keep changes inside the workspace, not the Settings modal
  adv.appendChild(buildSettingsForm(processSelectEl.value));
  root.appendChild(adv);

  // --- gallery (left) + jobs (right) ---
  const panes = document.createElement("div");
  panes.className = "process-panes";
  const gallery = document.createElement("div"); gallery.id = "process-gallery"; gallery.className = "process-gallery";
  const jobs = document.createElement("div"); jobs.id = "process-jobs"; jobs.className = "process-jobs";
  panes.appendChild(gallery);
  panes.appendChild(jobs);
  root.appendChild(panes);

  modalBodyEl.appendChild(root);
  // The gallery builds a thumbnail cell (image + action buttons + listeners) for
  // every library image — O(n) synchronous DOM that stalls the modal's first paint
  // on big libraries. Defer it one frame so the chrome shows instantly, then fill in.
  gallery.innerHTML = '<div class="gallery-empty">Loading library…</div>';
  requestAnimationFrame(() => {
    if (!processModalOpen) return;
    renderProcessGallery();
    renderProcessJobs();
  });
}

let processGalleryFilter = "";

// Library gallery for the Process workspace. Folds in the old Browse modal's
// filter + per-item actions (Copy / Path / Reveal / Open) and is the home for the
// rescued Image-Info panel — right-click a thumbnail, or hit its Info button.
function renderProcessGallery() {
  const host = document.querySelector("#process-gallery"); if (!host) return;
  host.innerHTML = "";
  const q = processGalleryFilter.trim().toLowerCase();
  const items = q ? workItems.filter((it) => it.name.toLowerCase().includes(q)) : workItems;

  const head = document.createElement("div"); head.className = "process-pane-head";
  const title = document.createElement("span");
  title.textContent = q ? `Library (${items.length}/${workItems.length})` : `Library (${workItems.length})`;
  head.appendChild(title);
  const filter = document.createElement("input");
  filter.type = "search"; filter.className = "modal-search process-filter"; filter.placeholder = "Filter…";
  filter.value = processGalleryFilter;
  filter.addEventListener("input", () => { processGalleryFilter = filter.value; renderProcessGallery(); });
  head.appendChild(filter);
  host.appendChild(head);

  if (!workItems.length) {
    const empty = document.createElement("div"); empty.className = "gallery-empty"; empty.textContent = "No images yet — drop files here or use Add images.";
    host.appendChild(empty); return;
  }
  if (!items.length) {
    const empty = document.createElement("div"); empty.className = "gallery-empty"; empty.textContent = `No images match “${processGalleryFilter}”.`;
    host.appendChild(empty); return;
  }

  const grid = document.createElement("div"); grid.className = "gallery-grid";
  for (const item of items) {
    const abs = absInputPath(item);
    const cell = document.createElement("div");
    cell.className = "gallery-cell" + (item.name === selectedName ? " active" : "") + (itemIsProcessed(item.name) ? " processed" : "");
    const thumb = document.createElement("button");
    thumb.type = "button"; thumb.className = "gallery-thumb-button"; thumb.title = `Select ${item.name} (right-click for info)`;
    thumb.innerHTML = `<div class="gallery-thumb"><img src="${item.url}" alt="${item.name}" loading="lazy" /></div>`;
    thumb.addEventListener("click", () => {
      selectedName = item.name; manualOutputName = null; editor.pinned = false;
      renderQueue(); renderProcessGallery();
      renderPreviews().catch((e) => setStatus(e.message, 2500));
    });
    thumb.addEventListener("contextmenu", (e) => { e.preventDefault(); openInfoModal(item.name); });   // rescued Info panel
    cell.appendChild(thumb);

    const cap = document.createElement("div"); cap.className = "gallery-caption"; cap.title = item.name;
    cap.textContent = item.name + (itemIsProcessed(item.name) ? " ✓" : "");
    cell.appendChild(cap);

    cell.appendChild(galleryActionRow({ name: item.name, absPath: abs, url: item.url, onInfo: () => openInfoModal(item.name) }));

    grid.appendChild(cell);
  }
  host.appendChild(grid);
}

function renderProcessJobs() {
  const host = document.querySelector("#process-jobs"); if (!host) return;
  host.innerHTML = "";
  const head = document.createElement("div"); head.className = "process-pane-head"; head.textContent = `Jobs (${jobsCache.length})`;
  host.appendChild(head);
  host.appendChild(buildJobsPanel());
}

loadVersion();   // cache the version early so the About panel shows it instantly
api("/api/bootstrap", "POST")
  .then(() => refreshAll())
  .then(async () => {
    // Startup: resume the last document only if the user opted in AND there is
    // one to restore; otherwise fall back to the default — a blank canvas with
    // the Process workspace open.
    if (prefs.startup === "resume" && (await resumeLastDoc())) return;
    mountBlankCanvas();
    openProcessModal();
  })
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

function buildSettingsForm(process) {
  const root = document.createElement("div");
  root.className = "form";
  const rerender = () => (settingsFormRerender || openSettingsModal)();   // host-aware re-render
  if (process === "upscale" || process === "pipeline") {
    root.appendChild(sectionTitle("Upscale model"));
    root.appendChild(fieldRow("Model", makeSelect("model", [
      ["realesrgan-x4plus", "ESRGAN x4+ (photo)"],
      ["realesrnet-x4plus", "ESRNet x4+ (cleaner)"],
      ["realesr-animevideov3", "Anime / line-art"],
    ])));
    root.appendChild(fieldRow("Scale", makeSelect("scale", [["2","2x"],["3","3x"],["4","4x"]])));
  }
  if (process === "vectorize" || process === "pipeline") {
    root.appendChild(sectionTitle("Output"));
    const colorSel = makeSelect("trace_colormode", [
      ["bw", "Black & white — silhouette mask"],
      ["color", "Color — full palette"],
    ]);
    colorSel.addEventListener("change", () => rerender());
    root.appendChild(fieldRow("Trace", colorSel, "B&W traces a 1-color silhouette; Color traces the image's real colors."));
    const isColor = settings.trace_colormode === "color";
    if (isColor) {
      root.appendChild(fieldRow("Style", makeSelect("trace_color_style", [
        ["poster", "Poster — flat, limited palette"],
        ["photo", "Photo — smooth gradients"],
      ]), "Poster suits logos/illustration; Photo follows gradients (bigger SVG)."));
      root.appendChild(fieldRow("Colors", makeRange("color_precision", 1, 8, 1), "Higher = more colours. Poster uses this as the palette size (lower = cleaner, flatter shapes); Photo as gradient precision."));
      root.appendChild(fieldRow("Layers", makeSelect("trace_hierarchical", [
        ["stacked", "Stacked — layered fills"],
        ["cutout", "Cutout — non-overlapping shapes"],
      ]), "Stacked paints back-to-front; Cutout makes each color its own shape."));
    }
    root.appendChild(sectionTitle(isColor ? "Image" : "Mask"));
    root.appendChild(fieldRow("Target max dim", makeNumber("target_max_dim", { min: 0, max: 16384, step: 64, placeholder: "auto (no resize)" }), "Resize the longest side before tracing. Smaller = simpler SVG."));
    if (!isColor) root.appendChild(fieldRow("Black threshold", makeNumber("mask_threshold", { min: 16, max: 240, step: 1, placeholder: "auto (otsu)" }), "0–255 gray cutoff. Higher = more pixels treated as foreground."));
    root.appendChild(sectionTitle("Trace (VTracer)"));
    const presetSel = makeSelect("trace_preset", [
      ["draft", "Draft — fewest points, fastest"],
      ["balanced", "Balanced — default"],
      ["smooth", "Smooth — curvier, fewer corners"],
      ["sharp", "Sharp — preserve detail/corners"],
      ["custom", "Custom — use sliders below"],
    ]);
    presetSel.addEventListener("change", () => {
      const pre = TRACE_PRESETS[presetSel.value];
      if (pre) {
        Object.assign(settings, pre);
        persistSettings();
      }
      rerender();
    });
    root.appendChild(fieldRow("Preset", presetSel, "Tunes the sliders below as a group."));
    root.appendChild(fieldRow("Mode", makeSelect("trace_mode", [["spline","Spline (curves)"],["polygon","Polygon"],["pixel","Pixel (no smoothing)"]])));
    const advToggle = document.createElement("input");
    advToggle.type = "checkbox";
    advToggle.checked = !!settings.trace_advanced;
    advToggle.addEventListener("change", () => { settings.trace_advanced = advToggle.checked; persistSettings(); rerender(); });
    root.appendChild(fieldRow("Show advanced", advToggle, "Show individual VTracer sliders."));
    if (settings.trace_advanced) {
      const onSliderChange = () => { settings.trace_preset = "custom"; persistSettings(); };
      const wrapWithCustomFlag = (row) => {
        row.querySelectorAll("input").forEach((el) => el.addEventListener("input", onSliderChange));
        return row;
      };
      root.appendChild(wrapWithCustomFlag(fieldRow("Smooth (segment_length)", makeRange("segment_length", 3.5, 10, 0.5), "Higher = smoother curves, fewer points.")));
      root.appendChild(wrapWithCustomFlag(fieldRow("Filter speckle", makeRange("filter_speckle", 0, 16, 1), "Drop blobs smaller than this many pixels.")));
      root.appendChild(wrapWithCustomFlag(fieldRow("Corner threshold", makeRange("corner_threshold", 30, 180, 5), "Higher = fewer sharp corners.")));
      root.appendChild(wrapWithCustomFlag(fieldRow("Splice threshold", makeRange("splice_threshold", 0, 180, 5))));
      root.appendChild(wrapWithCustomFlag(fieldRow("Path precision", makeRange("path_precision", 0, 10, 1))));
    }
  }
  if (process === "cutout" || process === "pipeline") {
    root.appendChild(sectionTitle(process === "pipeline" ? "Cutout (within pipeline)" : "Cutout"));
    const backendSel = makeSelect("cutout_backend", [
      ["classical", "Classical (numpy auto-bg, fast)"],
      ["ai", "AI (rembg / BiRefNet)"],
    ]);
    backendSel.addEventListener("change", () => rerender());
    root.appendChild(fieldRow("Backend", backendSel, "AI quality is far higher on complex backgrounds. Requires one-time ~500MB install."));
    if (settings.cutout_backend === "ai") {
      root.appendChild(fieldRow("Model", makeSelect("cutout_model", [
        ["u2net", "u2net — default, general (175MB)"],
        ["u2netp", "u2netp — fast/light (5MB)"],
        ["u2net_human_seg", "u2net_human_seg — humans"],
        ["isnet-general-use", "ISNet — sharper general (~170MB)"],
        ["isnet-anime", "ISNet anime"],
        ["birefnet-general", "BiRefNet general — OSS SOTA (~440MB)"],
        ["birefnet-general-lite", "BiRefNet lite"],
        ["birefnet-portrait", "BiRefNet portrait"],
        ["silueta", "silueta — quantized U²-Net (~40MB)"],
      ]), "First run of each model downloads weights to ~/.u2net/"));
      const am = document.createElement("input");
      am.type = "checkbox";
      am.checked = !!settings.alpha_matting;
      am.addEventListener("change", () => { settings.alpha_matting = am.checked; persistSettings(); });
      root.appendChild(fieldRow("Alpha matting", am, "Refines edges (hair). Slower."));
      if (workspace && !workspace.rembg_installed) {
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "ghost-button";
        cta.textContent = "Install rembg (one-time, ~500MB)";
        cta.addEventListener("click", async () => {
          cta.disabled = true;
          cta.textContent = "Installing rembg…";
          try {
            const data = await api("/api/install/rembg", "POST", {});
            setStatus(data.message || "Install started.", 3000);
            await loadJobs();
          } catch (e) {
            setStatus(e.message, 3000);
            cta.disabled = false;
            cta.textContent = "Install rembg (one-time, ~500MB)";
          }
        });
        const wrap = document.createElement("div");
        wrap.className = "form-actions";
        wrap.appendChild(cta);
        root.appendChild(wrap);
        const hint = document.createElement("div");
        hint.className = "form-hint";
        hint.textContent = "Runs in background. Watch progress under Jobs.";
        root.appendChild(hint);
      }
    }
  }
  if (process === "pixelvec") {
    root.appendChild(sectionTitle("Pixel grid"));
    const gridInput = makeNumber("pv_grid", { min: 0, max: 4096, step: 1, placeholder: "auto-detect" });
    root.appendChild(fieldRow("Native size (cells)", gridInput, "Blank = auto-detect the original pixel grid. Set a number (e.g. 16) to force it — best for heavily resampled / blurry art the detector can't lock onto."));
    root.appendChild(fieldRow("Cell color", makeSelect("pv_sample", [
      ["mode", "Mode — most common (best for clean art)"],
      ["median", "Median — robust to noise/AA"],
      ["center", "Center pixel — fastest"],
    ]), "How each native cell's single color is chosen."));
    root.appendChild(sectionTitle("Palette"));
    root.appendChild(fieldRow("Quantize colors", makeNumber("pv_quantize", { min: 0, max: 256, step: 1, placeholder: "keep all" }), "Snap to an N-color palette (e.g. 16). Blank/0 keeps every color."));
    const keyCb = document.createElement("input");
    keyCb.type = "checkbox";
    keyCb.checked = !!settings.pv_key_corner;
    keyCb.addEventListener("change", () => { settings.pv_key_corner = keyCb.checked; persistSettings(); });
    root.appendChild(fieldRow("Key out corner", keyCb, "Make the dominant corner color transparent (drop a flat background)."));
    root.appendChild(sectionTitle("Output"));
    root.appendChild(fieldRow("Shape mode", makeSelect("pv_mode", [
      ["merged", "Merged rects — compact, default"],
      ["path", "Per-color paths — fewest nodes"],
      ["pixels", "One rect per pixel — exact, largest"],
    ]), "All modes are pixel-exact; they differ only in SVG size. Coordinates are native pixel units (crispEdges), so output scales perfectly."));
    const note = document.createElement("div");
    note.className = "form-hint";
    note.textContent = "Unlike SVG Trace, this never smooths — it recovers the pixel grid and emits squares. No upscale/cutout stages run.";
    root.appendChild(note);
  }
  if (process === "chromakey") {
    const note = document.createElement("div");
    note.className = "form-section";
    note.textContent = "Greenscreen uses a fixed green-dominance threshold.";
    root.appendChild(note);
  }
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost-button";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    settings = { ...SETTINGS_DEFAULTS };
    persistSettings();
    rerender();
  });
  actions.appendChild(reset);
  root.appendChild(actions);
  return root;
}

function openSettingsModal() {
  const proc = processSelectEl.value;
  const label = processSelectEl.options[processSelectEl.selectedIndex]?.text || proc;
  openModal(`Settings — ${label}`, true);
  modalSearchEl.hidden = true;
  modalBodyEl.innerHTML = "";
  settingsFormRerender = openSettingsModal;   // standalone Settings modal re-renders itself
  modalBodyEl.appendChild(buildSettingsForm(proc));
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function openInfoModal(name = selectedName) {
  if (!name) {
    setStatus("Select an image first.", 2000);
    return;
  }
  openModal(`Info — ${name}`, true);
  modalSearchEl.hidden = true;
  modalBodyEl.innerHTML = `<div class="form-section">Loading…</div>`;
  let info;
  try {
    info = await api(`/api/work-items/info?name=${encodeURIComponent(name)}`);
  } catch (error) {
    modalBodyEl.innerHTML = `<div class="form-section">${error.message}</div>`;
    return;
  }
  renderInfoModal(info);
}

function renderInfoModal(info) {
  const root = document.createElement("div");
  root.className = "form";
  root.appendChild(sectionTitle("Image"));
  const grid = document.createElement("div");
  grid.className = "info-grid";
  const entries = [
    ["Name", info.name],
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
    const dt = document.createElement("div");
    dt.className = "info-key";
    dt.textContent = k;
    const dd = document.createElement("div");
    dd.className = "info-val";
    dd.textContent = v;
    grid.appendChild(dt);
    grid.appendChild(dd);
  }
  root.appendChild(grid);

  if (info.exif && Object.keys(info.exif).length) {
    root.appendChild(sectionTitle("EXIF"));
    const exifGrid = document.createElement("div");
    exifGrid.className = "info-grid";
    for (const [k, v] of Object.entries(info.exif)) {
      const dt = document.createElement("div");
      dt.className = "info-key";
      dt.textContent = k;
      const dd = document.createElement("div");
      dd.className = "info-val";
      dd.textContent = v;
      exifGrid.appendChild(dt);
      exifGrid.appendChild(dd);
    }
    root.appendChild(exifGrid);
  } else {
    root.appendChild(sectionTitle("EXIF"));
    const none = document.createElement("div");
    none.className = "form-hint";
    none.textContent = "No EXIF metadata.";
    root.appendChild(none);
  }

  root.appendChild(sectionTitle("Transform (in-place)"));
  const ops = document.createElement("div");
  ops.className = "form-actions";
  const buttons = [
    ["Rotate −90°", "rotate270"],
    ["Rotate 180°", "rotate180"],
    ["Rotate +90°", "rotate90"],
    ["Flip H", "flip-h"],
    ["Flip V", "flip-v"],
    ["Auto-Orient", "auto-orient"],
    ["Strip Metadata", "strip-metadata"],
  ];
  for (const [label, op] of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost-button";
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const updated = await api("/api/work-items/transform", "POST", { name: info.name, op });
        setStatus(updated.message || "Applied.", 1500);
        // In-place raster edit: the Info panel re-renders with the new metadata
        // (dimensions swap on rotate); refreshAll re-reads the library so the
        // Process gallery thumbnail reflects it next time the workspace opens.
        renderInfoModal(updated);
        refreshAll(info.name).catch((e) => setStatus(e.message, 3000));
      } catch (error) {
        setStatus(error.message, 3000);
      } finally {
        btn.disabled = false;
      }
    });
    ops.appendChild(btn);
  }
  root.appendChild(ops);
  const warn = document.createElement("div");
  warn.className = "form-hint";
  warn.textContent = "Transforms overwrite the source file. There is no undo.";
  root.appendChild(warn);

  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
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

settingsButtonEl.addEventListener("click", openSettingsModal);
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
        await loadOutputs();
        if (processModalOpen) renderProcessGallery();   // refresh processed badges
      }
      if (completionsHappened) {
        const stem = selectedName ? stem_(selectedName) : null;
        const touchesSelection = stem && completedNow.some(
          (j) => j.source_name && stem_(j.source_name) === stem
        );
        renderQueue();
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
export { setStatus, api, refreshAll, viewports, measureFit, outputPreviewEl, selectedOutput };

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
window.renderProcessWorkspace = renderProcessWorkspace;
window.zoomVp = zoomVp;
window.fitVp = fitVp;
window.processSelectEl = processSelectEl;
window.settings = settings;
window.hideFloatPanel = hideFloatPanel;
window.toggleFloatPanel = toggleFloatPanel;
// Mutable selection state goes through accessors (ESM module bindings can't be
// reassigned by name from outside the module).
window.app = {
  viewports, applyViewportState, measureFit, mountStageFromText,
  openFromFile, downloadCurrentSvg, exportFlow, loadVersion,
  get selectedName() { return selectedName; }, set selectedName(v) { selectedName = v; },
  get selectedOutput() { return selectedOutput; }, set selectedOutput(v) { selectedOutput = v; },
  get manualOutputName() { return manualOutputName; }, set manualOutputName(v) { manualOutputName = v; },
  get versionInfo() { return versionInfo; },
};
