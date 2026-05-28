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
  libraryHeaderEl.textContent = workItems.length ? ` (${workItems.length})` : "";
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
let _activeColorPicker = null;
function openColorPicker(opts) {
  if (_activeColorPicker) _activeColorPicker.cancel();
  const startHex = hv.toHexColor(opts.color) || (opts.allowNone && (!opts.color || opts.color === "none") ? null : "#000000");
  const startAlpha = opts.alpha == null ? 1 : Math.max(0, Math.min(1, opts.alpha));
  // working state in HSV (+ a) so dragging the field doesn't drift the hue at S/V=0
  const seed = hv.hexToRgb(startHex || "#000000") || { r: 0, g: 0, b: 0 };
  const st = Object.assign({ a: startAlpha, none: startHex === null }, hv.rgbToHsv(seed.r, seed.g, seed.b));

  const back = document.createElement("div"); back.className = "cp-backdrop";
  const win = document.createElement("div"); win.className = "cp-window";
  back.appendChild(win);
  win.innerHTML = `
    <div class="cp-head">${opts.title || "Colour"}</div>
    <div class="cp-body">
      <div class="cp-field" tabindex="-1"><div class="cp-field-sat"></div><div class="cp-field-val"></div><div class="cp-field-thumb"></div></div>
      <div class="cp-hue"><div class="cp-hue-thumb"></div></div>
      <div class="cp-preview"><div class="cp-prev-new"></div><div class="cp-prev-old"></div></div>
    </div>
    <div class="cp-alpha"><div class="cp-alpha-track"></div><div class="cp-alpha-thumb"></div></div>
    <div class="cp-fields">
      <label class="cp-inp cp-hex">#<input data-k="hex" maxlength="7" /></label>
      <label class="cp-inp">R<input data-k="r" type="number" min="0" max="255" /></label>
      <label class="cp-inp">G<input data-k="g" type="number" min="0" max="255" /></label>
      <label class="cp-inp">B<input data-k="b" type="number" min="0" max="255" /></label>
      <label class="cp-inp">H<input data-k="h" type="number" min="0" max="360" /></label>
      <label class="cp-inp">S<input data-k="s" type="number" min="0" max="100" /></label>
      <label class="cp-inp">Bv<input data-k="v" type="number" min="0" max="100" /></label>
      <label class="cp-inp">A%<input data-k="a" type="number" min="0" max="100" /></label>
    </div>
    <div class="cp-swatches"></div>
    <div class="cp-actions">
      ${opts.allowNone ? `<button type="button" class="ghost-button cp-none">None</button>` : ""}
      <span class="cp-spacer"></span>
      <button type="button" class="ghost-button cp-cancel">Cancel</button>
      <button type="button" class="ghost-button cp-ok">OK</button>
    </div>`;
  document.body.appendChild(back);

  const $ = (s) => win.querySelector(s);
  const field = $(".cp-field"), fieldSat = $(".cp-field-sat"), fieldThumb = $(".cp-field-thumb");
  const hue = $(".cp-hue"), hueThumb = $(".cp-hue-thumb");
  const alphaEl = $(".cp-alpha"), alphaTrack = $(".cp-alpha-track"), alphaThumb = $(".cp-alpha-thumb");
  const prevNew = $(".cp-prev-new"), prevOld = $(".cp-prev-old");
  const inputs = {}; win.querySelectorAll(".cp-fields input").forEach((i) => (inputs[i.dataset.k] = i));

  const curHex = () => { const c = hv.hsvToRgb(st.h, st.s, st.v); return hv.rgbToHex(c.r, c.g, c.b); };
  const checker = "repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 50% / 12px 12px";
  prevOld.style.background = startHex ? startHex : checker;

  function paint() {
    const hex = curHex(); const rgb = hv.hexToRgb(hex);
    const hueHex = (() => { const c = hv.hsvToRgb(st.h, 100, 100); return hv.rgbToHex(c.r, c.g, c.b); })();
    fieldSat.parentElement.style.background = hueHex;
    fieldThumb.style.left = st.s + "%"; fieldThumb.style.top = (100 - st.v) + "%";
    fieldThumb.style.background = hex;
    hueThumb.style.top = (st.h / 360 * 100) + "%";
    alphaTrack.style.background = `linear-gradient(to right, transparent, ${hex}), ${checker}`;
    alphaThumb.style.left = (st.a * 100) + "%";
    prevNew.style.background = st.none ? checker : hex;
    prevNew.style.opacity = st.none ? 1 : st.a;
    inputs.hex.value = hex.slice(1); inputs.r.value = rgb.r; inputs.g.value = rgb.g; inputs.b.value = rgb.b;
    inputs.h.value = Math.round(st.h); inputs.s.value = Math.round(st.s); inputs.v.value = Math.round(st.v);
    inputs.a.value = Math.round(st.a * 100);
    win.classList.toggle("cp-is-none", st.none);
  }
  function emit() { if (opts.onChange) opts.onChange(st.none ? null : curHex(), st.a); }
  function changed() { st.none = false; paint(); emit(); }

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
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  bindDrag(field, (x, y, w, h) => { st.s = clamp01(x / w) * 100; st.v = (1 - clamp01(y / h)) * 100; changed(); });
  bindDrag(hue, (x, y, w, h) => { st.h = clamp01(y / h) * 360; changed(); });
  bindDrag(alphaEl, (x, y, w) => { st.a = clamp01(x / w); paint(); emit(); });

  // --- numeric / hex inputs ---
  const setFromRgb = (r, g, b) => { Object.assign(st, hv.rgbToHsv(r, g, b)); };
  inputs.hex.addEventListener("input", () => { const rgb = hv.hexToRgb(inputs.hex.value); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } });
  ["r", "g", "b"].forEach((k) => inputs[k].addEventListener("input", () => {
    const r = +inputs.r.value || 0, g = +inputs.g.value || 0, b = +inputs.b.value || 0; setFromRgb(r, g, b); changed();
  }));
  inputs.h.addEventListener("input", () => { st.h = Math.max(0, Math.min(360, +inputs.h.value || 0)); changed(); });
  inputs.s.addEventListener("input", () => { st.s = Math.max(0, Math.min(100, +inputs.s.value || 0)); changed(); });
  inputs.v.addEventListener("input", () => { st.v = Math.max(0, Math.min(100, +inputs.v.value || 0)); changed(); });
  inputs.a.addEventListener("input", () => { st.a = clamp01((+inputs.a.value || 0) / 100); paint(); emit(); });

  // --- quick swatches ---
  const sw = $(".cp-swatches");
  ["#000000", "#ffffff", "#808080", "#e23b3b", "#f6a623", "#f8e71c", "#38b24a", "#2f7fe0", "#7d4fd0", "#e0529c"]
    .forEach((c) => { const b = document.createElement("button"); b.type = "button"; b.className = "cp-sw"; b.style.background = c;
      b.title = c; b.addEventListener("click", () => { const rgb = hv.hexToRgb(c); setFromRgb(rgb.r, rgb.g, rgb.b); changed(); }); sw.appendChild(b); });

  // --- actions ---
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); _activeColorPicker = null; };
  const ok = () => { if (opts.onCommit) opts.onCommit(st.none ? null : curHex(), st.a); close(); };
  const cancel = () => { if (opts.onChange) opts.onChange(startHex, startAlpha); if (opts.onCancel) opts.onCancel(); close(); };
  $(".cp-ok").addEventListener("click", ok);
  $(".cp-cancel").addEventListener("click", cancel);
  if (opts.allowNone) $(".cp-none").addEventListener("click", () => { st.none = true; paint(); emit(); });
  back.addEventListener("pointerdown", (e) => { if (e.target === back) cancel(); });
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
  };
  document.addEventListener("keydown", onKey, true);
  _activeColorPicker = { cancel };

  paint();
  setTimeout(() => inputs.hex.focus(), 0);
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

    const actions = document.createElement("div");
    actions.className = "gallery-actions";
    const absPath = item.absPath || item.path || "";
    const mkBtn = (label, title, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost-button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
      return b;
    };
    actions.appendChild(mkBtn("Copy", `Copy filename: ${item.name}`, () => copyToClipboard(item.name)));
    if (absPath) {
      actions.appendChild(mkBtn("Path", `Copy absolute path: ${absPath}`, () => copyToClipboard(absPath)));
      actions.appendChild(mkBtn("Reveal", `Open containing folder`, () => revealInFileManager(absPath)));
    }
    actions.appendChild(mkBtn("Open", "Open in new tab", () => window.open(item.url, "_blank", "noopener")));
    cell.appendChild(actions);

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
    selectedOutput = null; manualOutputName = null;
    const txt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect class="hv-artboard" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/></svg>`;
    mountStageFromText(txt, `untitled-${W}x${H}.svg`);
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

function saveAsDocument() {
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
  refreshAll();
}

async function exportFlow() {
  if (!editor.stage) return;
  if (!selectedOutput) { setStatus("Export needs a saved document — use Save first.", 3500); return; }
  if (editor.dirty) await saveDocument();
  openExportModal();
}

// PWA install prompt is captured lazily (beforeinstallprompt) and surfaced as a
// File-menu item only when the browser offers it.
let pwaInstallPrompt = null;
async function installPwa() {
  if (!pwaInstallPrompt) return;
  const p = pwaInstallPrompt; pwaInstallPrompt = null;
  p.prompt();
  try { await p.userChoice; } catch {}
}

const MENU_ITEMS = {
  // Everything that used to be separate header buttons, rolled into one menu.
  "file": () => {
    const items = [
      { label: "New blank canvas…", onClick: newBlankDoc },
      { type: "sep" },
      { label: "Open vector…", onClick: openOpenModal },
      { label: "Place into canvas…", onClick: openPlaceModal },
      { label: "Save (.svg)", onClick: saveDocument },
      { label: "Save as…", onClick: saveAsDocument },
      { type: "sep" },
      { label: "Export PNG…", onClick: exportFlow },
      { label: "Copy SVG markup", onClick: copySvgSource },
    ];
    if (pwaInstallPrompt) items.push({ type: "sep" }, { label: "Install as desktop app…", onClick: installPwa });
    return items;
  },
  "layers": () => {
    const sel = editor.selectedNodes();
    const hasGroup = sel.some((n) => n.tagName.toLowerCase() === "g");
    return [
      { label: "Group", disabled: sel.length < 2, onClick: () => editor.group() },
      { label: "Ungroup", disabled: !hasGroup, onClick: () => editor.ungroup() },
      { type: "sep" },
      { label: "Clean up ghost layers", onClick: () => editor.cleanupLayers() },
      { label: "Merge same-colour layers", onClick: () => editor.consolidateByColor() },
    ];
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
  const pickFor = (which) => {
    active = which; refreshSwatches();
    editor.beginCoalesce();
    openColorPicker({
      title: which === "fill" ? "Fill colour" : "Stroke colour",
      color: cur(which), alpha: curAlpha(which), allowNone: true,
      onChange: (hex, a) => applyPaint(which, hex, a),
      onCommit: () => editor.commitCoalesce(which === "fill" ? "Fill" : "Stroke"),
      onCancel: () => editor.cancelCoalesce(),
    });
  };
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
    if (e.key === "X" || e.key === "x") { e.preventDefault(); if (e.shiftKey) doSwap(); else { active = active === "fill" ? "stroke" : "fill"; refreshSwatches(); } }
    else if (e.key === "d" || e.key === "D") { e.preventDefault(); setDefault(); }
    else if (e.key === "/") { e.preventDefault(); setNone(); }
  });
  editor.onInspect = refreshSwatches;   // editor pings this on every selection/structure change
  editor.pickColor = openColorPicker;   // the inspector reuses the same modal
  refreshSwatches();
}
{
  const procBtn = document.querySelector("#process-button"); if (procBtn) procBtn.addEventListener("click", () => openProcessModal());
  const undoBtn = document.querySelector("#undo-button"); if (undoBtn) undoBtn.addEventListener("click", () => editor.undo());
  const redoBtn = document.querySelector("#redo-button"); if (redoBtn) redoBtn.addEventListener("click", () => editor.redoAction());
  const railToggle = document.querySelector("#rail-toggle");
  const RAIL_KEY = "hector-vector:rail-collapsed";
  const appEl = document.querySelector(".app.editor");
  if (appEl && localStorage.getItem(RAIL_KEY) === "1") appEl.classList.add("rail-collapsed");
  if (railToggle && appEl) {
    railToggle.addEventListener("click", () => {
      const c = appEl.classList.toggle("rail-collapsed");
      try { localStorage.setItem(RAIL_KEY, c ? "1" : "0"); } catch {}
      requestAnimationFrame(() => measureFit(viewports.output));
    });
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
  // Vertical resizer between the History and Layers dock sections.
  {
    const hist = document.querySelector(".rail-section.history");
    const vhandle = document.querySelector("#dock-vresizer");
    const HKEY = "hector-vector:hist-h";
    const savedH = parseInt(localStorage.getItem(HKEY) || "", 10);
    if (hist && savedH >= 60) hist.style.height = savedH + "px";
    if (hist && vhandle) {
      vhandle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = hist.getBoundingClientRect().height;
        const dockH = document.querySelector("#rightdock").getBoundingClientRect().height;
        vhandle.setPointerCapture(e.pointerId);
        const move = (ev) => { hist.style.height = Math.max(60, Math.min(dockH - 120, startH + (ev.clientY - startY))) + "px"; };
        const up = () => {
          vhandle.removeEventListener("pointermove", move);
          vhandle.removeEventListener("pointerup", up);
          try { localStorage.setItem(HKEY, String(Math.round(hist.getBoundingClientRect().height))); } catch {}
        };
        vhandle.addEventListener("pointermove", move);
        vhandle.addEventListener("pointerup", up);
      });
    }
  }
  // Collapsible rail sections (Photopea/Illustrator-style accordion), persisted.
  document.querySelectorAll(".rail-section[data-section] .section-head").forEach((head) => {
    const section = head.closest(".rail-section");
    const key = "hv-sec-" + section.dataset.section;
    if (localStorage.getItem(key) === "1") section.classList.add("collapsed");
    head.addEventListener("click", (e) => {
      if (e.target.closest(".panel-actions")) return;   // kebab/menu clicks don't collapse
      const c = section.classList.toggle("collapsed");
      try { localStorage.setItem(key, c ? "1" : "0"); } catch {}
    });
  });

  // ---- PWA install (surfaced as a File-menu item; one-click path to WCO) ----
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); pwaInstallPrompt = e; });
  window.addEventListener("appinstalled", () => { pwaInstallPrompt = null; });

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
  if (editor._curv) {    // curvature construction owns Enter/Escape too
    if (e.key === "Enter") { e.preventDefault(); editor._curvFinish(true); return; }
    if (e.key === "Escape") { e.preventDefault(); editor._curvFinish(false); return; }
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (editor.tool === "node" && editor._nodeSel && editor._nodeSel.size) { e.preventDefault(); editor.deleteNodeSelection(); return; }
    if (editor.selection.size) { e.preventDefault(); editor.deleteSelection(); }
    return;
  }
  if (e.key === "v" || e.key === "V") { editor.setTool("select"); return; }
  if (e.key === "m" || e.key === "M") { editor.setTool("marquee"); return; }
  if (e.key === "t" || e.key === "T") { editor.setTool("transform"); return; }
  if (e.key === "a" || e.key === "A") { editor.setTool("node"); return; }
  if (e.key === "p" || e.key === "P") { editor.setTool("pen"); return; }
  if (e.key === "c" || e.key === "C") { editor.setTool("curvature"); return; }
  if (e.key === "r" || e.key === "R") { editor.setTool("rect"); return; }
  if (e.key === "e" || e.key === "E") { editor.setTool("ellipse"); return; }
  if (e.key === "l" || e.key === "L") { editor.setTool("line"); return; }
  if (e.key === "Escape" && editor.stage) { editor.selection = new Set(); editor.artboardSelected = false; editor._renderSelection(); editor._renderInspector(); }
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
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (item.type === "toggle" ? " menu-toggle" : "") + (item.checked ? " checked" : "");
    btn.disabled = !!item.disabled;
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<span class="menu-check">${item.checked ? "✓" : ""}</span><span class="menu-label"></span>`;
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
// Square icon-button grid for the context-panel actions (icons over text, native
// tooltips like the toolstrip). Separators span the row as a thin divider.
function appendActionGrid(container, items, afterClick) {
  for (const item of items) {
    if (item.type === "sep") { const s = document.createElement("div"); s.className = "grid-sep"; container.appendChild(s); continue; }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "grid-item"; btn.disabled = !!item.disabled;
    btn.title = item.label;
    if (item.icon) btn.textContent = item.icon; else { btn.textContent = item.label; btn.classList.add("text"); }
    btn.addEventListener("click", () => {
      try { item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); }
      if (afterClick) afterClick(); else hideContextMenu();
    });
    container.appendChild(btn);
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
function showContextPanel(x, y, kind) {
  hideContextMenu();
  const panel = document.createElement("div");
  panel.className = "context-menu context-panel";
  const build = () => {
    panel.innerHTML = "";
    const head = document.createElement("div"); head.className = "ctx-head";
    const style = document.createElement("div"); style.className = "ctx-style";
    if (kind === "object") {
      const nodes = editor.selectedNodes();
      head.textContent = nodes.length === 1 ? "Object" : `${nodes.length} objects`;
      style.appendChild(editor._objectPanel(nodes));
    } else {
      head.textContent = "Artboard";
      style.appendChild(editor._artboardPanel());
    }
    panel.appendChild(head); panel.appendChild(style);
    const acts = document.createElement("div"); acts.className = "ctx-actions";
    appendActionGrid(acts, kind === "object" ? objectMenuItems() : canvasMenuItems(), () => {
      if (kind === "object" && !editor.selectedNodes().length) { hideContextMenu(); return; }
      build();
    });
    panel.appendChild(acts);
  };
  build();
  document.body.appendChild(panel);
  placeAt(panel, x, y);
  ctxMenuEl = panel;
}
function objectMenuItems() {
  const sel = editor.selectedNodes();
  const fillable = sel.filter((n) => shapeToAbsPath(n)).length >= 2;
  const hasGroup = sel.some((n) => n.tagName.toLowerCase() === "g");
  const items = [
    { icon: "✂", label: "Cut", onClick: () => editor.cut() },
    { icon: "⧉", label: "Copy", onClick: () => editor.copy() },
    { icon: "❏", label: "Paste", disabled: !editor.clipboard.length, onClick: () => editor.paste() },
    { icon: "⧉⁺", label: "Duplicate", onClick: () => editor.duplicate() },
    { icon: "✎", label: "Rename…", disabled: sel.length !== 1, onClick: () => editor.beginRename(sel[0].getAttribute("data-hv-id")) },
    { icon: "✕", label: "Delete", onClick: () => editor.deleteSelection() },
    { type: "sep" },
    { icon: "⤒", label: "Bring to Front", onClick: () => editor.reorder("front") },
    { icon: "↑", label: "Bring Forward", onClick: () => editor.reorder("forward") },
    { icon: "↓", label: "Send Backward", onClick: () => editor.reorder("backward") },
    { icon: "⤓", label: "Send to Back", onClick: () => editor.reorder("back") },
    { type: "sep" },
    { icon: "⊞", label: "Group", disabled: sel.length < 2, onClick: () => editor.group() },
    { icon: "⊟", label: "Ungroup", disabled: !hasGroup, onClick: () => editor.ungroup() },
  ];
  if (fillable) items.push({ type: "sep" },
    { icon: "∪", label: "Unite", onClick: () => editor.booleanOp("union") },
    { icon: "−", label: "Subtract", onClick: () => editor.booleanOp("subtract") },
    { icon: "∩", label: "Intersect", onClick: () => editor.booleanOp("intersect") });
  items.push({ type: "sep" },
    { icon: "⊠", label: "Invert space", onClick: () => editor.invertSpace() },
    { icon: "↻", label: "Rotate 90° CW", onClick: () => editor.transform("rotateCW") },
    { icon: "↺", label: "Rotate 90° CCW", onClick: () => editor.transform("rotateCCW") },
    { icon: "⇄", label: "Flip Horizontal", onClick: () => editor.transform("flipH") },
    { icon: "⇅", label: "Flip Vertical", onClick: () => editor.transform("flipV") });
  return items;
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
function canvasMenuItems() {
  return [
    { icon: "❏", label: "Paste", disabled: !editor.clipboard.length, onClick: () => editor.paste() },
    { icon: "▦", label: "Select All", onClick: () => editor.selectAll() },
    { type: "sep" },
    { icon: editor.smartGuides ? "⊹✓" : "⊹", label: "Smart guides", onClick: () => { editor.smartGuides = !editor.smartGuides; setStatus(`Smart guides ${editor.smartGuides ? "on" : "off"}.`, 1500); } },
    { icon: "⊠", label: "Invert space", onClick: () => editor.invertSpace() },
    { icon: "⊘", label: "Clean up ghost layers", onClick: () => editor.cleanupLayers() },
    { icon: "⧉", label: "Merge same-colour layers", onClick: () => editor.consolidateByColor() },
    { type: "sep" },
    { icon: "↻", label: "Rotate artboard 90° CW", onClick: () => editor.transform("rotateCW") },
    { icon: "↺", label: "Rotate artboard 90° CCW", onClick: () => editor.transform("rotateCCW") },
    { icon: "⇄", label: "Flip artboard H", onClick: () => editor.transform("flipH") },
    { icon: "⇅", label: "Flip artboard V", onClick: () => editor.transform("flipV") },
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
document.addEventListener("pointerdown", (e) => { if (ctxMenuEl && !e.target.closest(".context-menu")) hideContextMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });
window.addEventListener("blur", hideContextMenu);
window.addEventListener("pagehide", () => editor.dispose());   // free document state when the app closes
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
      closeModal();
      manualOutputName = data.name;
      await refreshAll();
      setStatus(data.message || "Rendered.", 3000);
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
  renderProcessGallery();
  renderProcessJobs();
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

  const mkBtn = (label, t, onClick) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ghost-button"; b.textContent = label; b.title = t;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  };

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

    const actions = document.createElement("div"); actions.className = "gallery-actions";
    actions.appendChild(mkBtn("Info", "Dimensions, EXIF, in-place transforms", () => openInfoModal(item.name)));
    actions.appendChild(mkBtn("Copy", `Copy filename: ${item.name}`, () => copyToClipboard(item.name)));
    if (abs) {
      actions.appendChild(mkBtn("Path", `Copy absolute path: ${abs}`, () => copyToClipboard(abs)));
      actions.appendChild(mkBtn("Reveal", "Open containing folder", () => revealInFileManager(abs)));
    }
    actions.appendChild(mkBtn("Open", "Open in new tab", () => window.open(item.url, "_blank", "noopener")));
    cell.appendChild(actions);

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

api("/api/bootstrap", "POST")
  .then(() => refreshAll())
  .catch((error) => setStatus(error.message, 3000));

window.addEventListener("resize", () => {
  Object.values(viewports).forEach((vp) => {
    if (vp.el.querySelector(".viewport-content")) measureFit(vp);
  });
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
    root.appendChild(sectionTitle("Mask"));
    root.appendChild(fieldRow("Target max dim", makeNumber("target_max_dim", { min: 0, max: 16384, step: 64, placeholder: "auto (no resize)" }), "Resize the longest side before tracing. Smaller = simpler SVG."));
    root.appendChild(fieldRow("Black threshold", makeNumber("mask_threshold", { min: 16, max: 240, step: 1, placeholder: "auto (otsu)" }), "0–255 gray cutoff. Higher = more pixels treated as foreground."));
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
    ["V", "Select / move (Shift = 45°, Alt-drag = copy)"],
    ["M", "Drag-select (Alt = lasso)"],
    ["T", "Transform / scale"],
    ["A", "Edit points (direct select)"],
    ["P", "Pen"],
    ["C", "Curvature (auto-smooth; dbl-click = corner)"],
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
    ["q", "Open the Process workspace"],
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
    case "q": event.preventDefault(); openProcessModal(true); break;
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
// Mutable selection state goes through accessors (ESM module bindings can't be
// reassigned by name from outside the module).
window.app = {
  viewports, applyViewportState, measureFit, mountStageFromText,
  get selectedName() { return selectedName; }, set selectedName(v) { selectedName = v; },
  get selectedOutput() { return selectedOutput; }, set selectedOutput(v) { selectedOutput = v; },
  get manualOutputName() { return manualOutputName; }, set manualOutputName(v) { manualOutputName = v; },
};
