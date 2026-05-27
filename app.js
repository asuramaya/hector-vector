const fileInputEl = document.querySelector("#file-input");
const dropzoneEl = document.querySelector("#dropzone");
const queueEl = document.querySelector("#queue");
const workspaceTitleEl = document.querySelector("#workspace-title");
const workspacePathEl = document.querySelector("#workspace-path");
const processSelectEl = document.querySelector("#process-select");
const modeSelectEl = document.querySelector("#mode-select");
const settingsButtonEl = document.querySelector("#settings-button");
const inputPreviewEl = document.querySelector("#input-preview");
const outputPreviewEl = document.querySelector("#output-preview");
const statusTextEl = document.querySelector("#status-text");
const removeSelectedEl = document.querySelector("#remove-selected");
const clearJobsEl = document.querySelector("#clear-jobs");
const jobsButtonEl = document.querySelector("#jobs-button");
const jobsCountEl = document.querySelector("#jobs-count");
const forceInputEl = document.querySelector("#force-input");
const runButtonEl = document.querySelector("#run-button");
const libraryHeaderEl = document.querySelector(".library .sec-label");
const sourcePathEl = document.querySelector("#source-path");
const sourceEditEl = document.querySelector("#source-edit");
const sourceResetEl = document.querySelector("#source-reset");
const sourceRowEl = document.querySelector(".source-row");
const browseButtonEl = document.querySelector("#browse-button");
const cleanDerivativesEl = document.querySelector("#clean-derivatives");
const infoButtonEl = document.querySelector("#info-button");
const outputPickerEl = document.querySelector("#output-picker");
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

function absOutputPath(item) {
  if (!item) return "";
  if (item.path && item.path.startsWith("/")) return item.path;
  return joinAbsPath(outputsDir, item.folder, item.name);
}

function parentDir(absPath) {
  if (!absPath) return "";
  const i = absPath.lastIndexOf("/");
  return i <= 0 ? absPath : absPath.slice(0, i);
}

function stripBust(url) {
  if (!url) return url;
  return url.replace(/[?&]v=\d+/g, "").replace(/\?$/, "");
}

function bustUrl(url, stamp) {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${stamp || Date.now()}`;
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
    if (!raw) return { input: "checker", output: "checker" };
    return { input: "checker", output: "checker", ...JSON.parse(raw) };
  } catch {
    return { input: "checker", output: "checker" };
  }
}
const bgModes = loadBgModes();
function persistBgModes() {
  try { localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(bgModes)); } catch {}
}

const viewports = {
  input: { el: inputPreviewEl, scale: 1, x: 0, y: 0, fitScale: 1, path: null, url: null, name: null, kind: null },
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
  setStatus(`${vpName === "input" ? "Input" : "Output"} BG: ${bgModes[vpName]}`, 1200);
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

function selectedItem() {
  return workItems.find((item) => item.name === selectedName) || null;
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

function variantLabel(name) {
  const render = name.match(/@(\d+)x(\d+)\.png$/i);
  if (render) return `PNG ${render[1]}×${render[2]}`;
  if (name.includes(".edited.")) return "Edited";
  if (name.includes(".cutout.")) return "Cutout";
  if (name.includes(".chromakey.")) return "Chromakey";
  if (name.includes(".preview.")) return "Preview";
  if (name.includes(".mask.")) return "Mask";
  if (name.endsWith(".svg")) return "SVG";
  return "Upscale";
}

const VARIANT_ORDER = ["Upscale", "Preview", "Cutout", "Chromakey", "Mask", "SVG", "Edited"];

function renderOutputPicker() {
  if (!outputPickerEl) return;
  const matches = latestOutputsFor(selectedName);
  if (!matches.length) {
    outputPickerEl.hidden = true;
    outputPickerEl.innerHTML = "";
    return;
  }
  outputPickerEl.hidden = false;
  outputPickerEl.innerHTML = "";
  const activeKey = selectedOutput ? `${selectedOutput.folder}/${selectedOutput.name}` : null;
  // Dedup by variant label, keeping the newest (matches is ordered newest-folder first)
  const seenLabel = new Set();
  const ordered = [];
  for (const item of matches) {
    const lab = variantLabel(item.name);
    if (seenLabel.has(lab)) continue;
    seenLabel.add(lab);
    ordered.push({ ...item, label: lab });
  }
  ordered.sort((a, b) => VARIANT_ORDER.indexOf(a.label) - VARIANT_ORDER.indexOf(b.label));
  for (const item of ordered) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = `${item.folder}/${item.name}` === activeKey;
    btn.className = `output-pick ${isActive ? "active" : ""}`;
    btn.textContent = item.label;
    btn.title = `${item.name}\n${item.folder || ""}`;
    btn.addEventListener("click", () => {
      manualOutputName = item.name;
      renderPreviews().catch((error) => setStatus(error.message, 2500));
    });
    outputPickerEl.appendChild(btn);
  }
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

function applyViewportState(vp) {
  const content = vp.el.querySelector(".viewport-content");
  if (!content) return;
  content.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;
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
  vp.fitScale = Math.min(fw / mw, fh / mh, 1);
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
  const vpName = vp === viewports.input ? "input" : "output";
  applyBgMode(vpName);
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

function updateActionState() {
  // The Remove action now lives in the Library panel menu; its disabled state
  // is computed when that menu opens (see MENU_ITEMS["library"]).
}

function updateLibraryHeader() {
  if (!libraryHeaderEl) return;
  libraryHeaderEl.textContent = workItems.length ? `Library (${workItems.length})` : "Library";
}

const LIBRARY_GROUPS_KEY = "hector-vector:library-groups";
let libraryGroupCollapsed = loadLibraryGroups();
let visibleLibraryItems = [];

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
  visibleLibraryItems = [];
  if (!workItems.length) {
    queueEl.innerHTML = `<div class="queue-empty">Drop images here.</div>`;
    selectedName = null;
    updateActionState();
    return;
  }
  if (!workItems.some((item) => item.name === selectedName)) selectedName = workItems[0].name;

  const unprocessed = workItems.filter((it) => !itemIsProcessed(it.name));
  const processed = workItems.filter((it) => itemIsProcessed(it.name));

  renderQueueGroup("Unprocessed", unprocessed, "unprocessed");
  renderQueueGroup("Processed", processed, "processed");
  updateActionState();
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
    visibleLibraryItems.push(item);
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
  const input = selectedItem();
  selectedOutput = preferredOutput(selectedName);

  if (input) {
    if (viewports.input.url !== input.url) {
      try {
        await mountViewport(viewports.input, "png", input.url, input.name, input.path);
      } catch (error) {
        clearViewport(viewports.input, error.message);
      }
    }
  } else if (viewports.input.url !== null) {
    clearViewport(viewports.input, "No image selected.");
  }

  // editor.pinned = showing a blank/opened doc that isn't tied to the library;
  // don't let a library-driven render clobber it.
  if (!editor.pinned) {
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
      outputLabelEl.textContent = selectedOutput ? `Canvas — ${variantLabel(selectedOutput.name)}` : "Canvas";
    }
    editor.sync();
  }
  renderOutputPicker();
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

async function loadQueue(preferredSelection = null) {
  applyQueueData(await fetchQueue(), preferredSelection);
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

async function loadStatus() {
  applyStatusData(await fetchStatus());
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
const ACTIVE_STATES = new Set(["queued", "running"]);
let jobsCache = [];
let jobsModalOpen = false;

function jobsForSource(name) {
  if (!name) return [];
  const stem = stem_(name);
  return jobsCache.filter((j) => j.source_name && stem_(j.source_name) === stem);
}

function stem_(n) { return n.replace(/\.[^.]+$/, ""); }

function updateJobsButton() {
  if (!jobsButtonEl) return;
  const total = jobsCache.length;
  const active = jobsCache.filter((j) => ACTIVE_STATES.has(j.status)).length;
  const failed = jobsCache.filter((j) => j.status === "failed").length;
  if (!total) {
    jobsCountEl.hidden = true;
    jobsCountEl.className = "badge";
    return;
  }
  jobsCountEl.hidden = false;
  jobsCountEl.textContent = active ? `${active}/${total}` : String(total);
  jobsCountEl.className = "badge" + (active ? " badge-busy" : failed ? " badge-fail" : "");
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

  updateJobsButton();
  if (jobsModalOpen) renderJobsModal();

  const running = jobs.find((job) => job.status === "running");
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
      { error: true, onClick: () => openJobsModal && openJobsModal(), title: tail }
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
  jobsModalOpen = false;
}

modalRootEl.addEventListener("click", (event) => {
  if (event.target.matches("[data-modal-close]") || event.target.closest("[data-modal-close]")) {
    closeModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalRootEl.hidden) closeModal();
});

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
    thumb.innerHTML = `<div class="gallery-thumb">${
      item.kind === "svg"
        ? `<object type="image/svg+xml" data="${item.url}"></object>`
        : `<img src="${item.url}" alt="${item.name}" loading="lazy" />`
    }</div>`;
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

function openBrowseModal() {
  openModal(`Browse — ${workItems.length} image(s)`);
  const items = workItems.map((item) => ({
    name: item.name,
    url: item.url,
    kind: "png",
    active: item.name === selectedName,
    absPath: absInputPath(item),
  }));
  const applyFilter = () => {
    const q = modalSearchEl.value.trim().toLowerCase();
    const visible = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
    renderGalleryGrid(visible, (picked) => {
      selectedName = picked.name;
      manualOutputName = null;
      editor.pinned = false;
      closeModal();
      renderQueue();
      renderPreviews().catch((error) => setStatus(error.message, 2500));
    });
  };
  modalSearchEl.oninput = applyFilter;
  applyFilter();
}

async function cleanDerivatives() {
  if (!confirm("Delete all .cutout/.mask/.preview/.chromakey files from the current source folder?")) return;
  try {
    const data = await api("/api/work-items/clean-derivatives", "POST", {});
    setStatus(data.message || "Cleaned.", 2500);
    await refreshAll();
  } catch (error) {
    setStatus(error.message, 3000);
  }
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

// --- File/locate actions (invoked from the panel-head menus) ---

function inputAbs() {
  const item = selectedItem();
  return item ? absInputPath(item) : viewports.input.path;
}
function outputAbs() {
  return selectedOutput ? absOutputPath(selectedOutput) : viewports.output.path;
}

async function copyInputPath() {
  const abs = inputAbs();
  if (abs) await copyToClipboard(abs);
}
async function copyOutputPath() {
  const abs = outputAbs();
  if (abs) await copyToClipboard(abs);
}
async function copyInputFolder() {
  const dir = parentDir(inputAbs());
  if (dir) await copyToClipboard(dir);
}
async function copyOutputFolder() {
  const dir = parentDir(outputAbs());
  if (dir) await copyToClipboard(dir);
}

async function revealInFileManager(absPath) {
  if (!absPath) return;
  try {
    const data = await api("/api/reveal", "POST", { path: absPath });
    setStatus(data.message || "Opened folder.", 1500);
  } catch (e) {
    setStatus(`Reveal failed: ${e.message}`, 3000);
  }
}
function revealInput() { revealInFileManager(inputAbs()); }
function revealOutput() { revealInFileManager(outputAbs()); }
function openInput() { if (viewports.input.url) window.open(viewports.input.url, "_blank", "noopener"); }
function openOutput() { if (viewports.output.url) window.open(viewports.output.url, "_blank", "noopener"); }

async function copySvgSource() {
  const text = editor.serialize() ||
    (viewports.output.url ? await (await fetch(viewports.output.url)).text() : "");
  if (!text) return;
  await copyToClipboard(text, `SVG (${text.length} chars)`);
}

// =========================================================================
// SVG editor — invert / stroke / in-viewport point editing of the output SVG.
// Operates directly on the live inline <svg> mounted in the output viewport
// (single source of truth). pristine markup is kept only for Reset.
// =========================================================================

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_HANDLES = 1500;

function editorSvgEl() {
  return outputPreviewEl.querySelector("svg.inline-svg");
}

// --- colour helpers (canvas normalises any CSS colour to #rrggbb / rgba()) ---
const _colorCtx = document.createElement("canvas").getContext("2d");
function normalizeColor(c) {
  if (c == null) return null;
  c = String(c).trim();
  if (!c || c === "none" || c === "transparent" || c === "currentColor" || c.startsWith("url(")) return null;
  _colorCtx.fillStyle = "#000000"; _colorCtx.fillStyle = c; const a = _colorCtx.fillStyle;
  _colorCtx.fillStyle = "#ffffff"; _colorCtx.fillStyle = c; const b = _colorCtx.fillStyle;
  return a === b ? a : null;   // invalid colours don't change the seed → reject
}
function invertColor(c) {
  const norm = normalizeColor(c);
  if (!norm) return null;
  if (norm[0] === "#") {
    const v = parseInt(norm.slice(1), 16);
    const r = 255 - ((v >> 16) & 255), g = 255 - ((v >> 8) & 255), b = 255 - (v & 255);
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  const m = norm.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(",").map((s) => s.trim());
    const r = 255 - (+p[0] || 0), g = 255 - (+p[1] || 0), b = 255 - (+p[2] || 0);
    return p.length > 3 ? `rgba(${r}, ${g}, ${b}, ${p[3]})` : `rgb(${r}, ${g}, ${b})`;
  }
  return null;
}

const COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];
const STYLE_COLOR_PROPS = ["fill", "stroke", "stopColor", "floodColor", "lightingColor"];
function applyInvert(svg) {                       // involutive: calling twice restores
  const els = [svg, ...svg.querySelectorAll("*")];
  for (const el of els) {
    if (el.closest && el.closest(".hv-handles")) continue;
    for (const attr of COLOR_ATTRS) {
      if (el.hasAttribute && el.hasAttribute(attr)) {
        const inv = invertColor(el.getAttribute(attr));
        if (inv) el.setAttribute(attr, inv);
      }
    }
    if (el.style) {
      for (const prop of STYLE_COLOR_PROPS) {
        const v = el.style[prop];
        if (v) { const inv = invertColor(v); if (inv) el.style[prop] = inv; }
      }
    }
  }
}

const STROKE_SHAPES = "path, rect, circle, ellipse, line, polygon, polyline";
function applyStroke(svg, { color, width }) {
  svg.querySelectorAll(STROKE_SHAPES).forEach((el) => {
    if (el.closest(".hv-handles")) return;
    if (!el.hasAttribute("data-hv-stroke")) {
      el.setAttribute("data-hv-ostroke", el.getAttribute("stroke") ?? "");
      el.setAttribute("data-hv-ostroke-w", el.getAttribute("stroke-width") ?? "");
      el.setAttribute("data-hv-stroke", "1");
    }
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", String(width));
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("vector-effect", "non-scaling-stroke");
  });
}
function removeStroke(svg) {
  svg.querySelectorAll("[data-hv-stroke]").forEach((el) => {
    const os = el.getAttribute("data-hv-ostroke"), ow = el.getAttribute("data-hv-ostroke-w");
    if (os) el.setAttribute("stroke", os); else el.removeAttribute("stroke");
    if (ow) el.setAttribute("stroke-width", ow); else el.removeAttribute("stroke-width");
    ["vector-effect", "stroke-linejoin", "stroke-linecap", "data-hv-stroke", "data-hv-ostroke", "data-hv-ostroke-w"]
      .forEach((a) => el.removeAttribute(a));
  });
}

// --- path d parsing → absolute, normalised to M/L/C/Q/A/Z ---
function parsePath(d) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  const toks = []; let mm;
  while ((mm = re.exec(d))) toks.push(mm[1] || mm[2]);
  let i = 0; const num = () => parseFloat(toks[i++]);
  const segs = []; let cx = 0, cy = 0, sx = 0, sy = 0, prevCtrl = null, cmd = "", last = "";
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === "M") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      cx = x; cy = y; sx = x; sy = y; segs.push({ t: "M", end: { x, y } });
      last = "M"; prevCtrl = null; cmd = rel ? "l" : "L";
    } else if (C === "L") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      cx = x; cy = y; segs.push({ t: "L", end: { x, y } }); last = "L"; prevCtrl = null;
    } else if (C === "H") {
      let x = num(); if (rel) x += cx; cx = x; segs.push({ t: "L", end: { x, y: cy } }); last = "L"; prevCtrl = null;
    } else if (C === "V") {
      let y = num(); if (rel) y += cy; cy = y; segs.push({ t: "L", end: { x: cx, y } }); last = "L"; prevCtrl = null;
    } else if (C === "C") {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      segs.push({ t: "C", c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, end: { x, y } });
      prevCtrl = { x: x2, y: y2 }; cx = x; cy = y; last = "C";
    } else if (C === "S") {
      let x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
      const refl = (last === "C" || last === "S") && prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : { x: cx, y: cy };
      segs.push({ t: "C", c1: refl, c2: { x: x2, y: y2 }, end: { x, y } });
      prevCtrl = { x: x2, y: y2 }; cx = x; cy = y; last = "S";
    } else if (C === "Q") {
      let x1 = num(), y1 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
      segs.push({ t: "Q", c1: { x: x1, y: y1 }, end: { x, y } });
      prevCtrl = { x: x1, y: y1 }; cx = x; cy = y; last = "Q";
    } else if (C === "T") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      const refl = (last === "Q" || last === "T") && prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : { x: cx, y: cy };
      segs.push({ t: "Q", c1: refl, end: { x, y } });
      prevCtrl = refl; cx = x; cy = y; last = "T";
    } else if (C === "A") {
      let rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      segs.push({ t: "A", rx, ry, rot, laf, sf, end: { x, y } });
      cx = x; cy = y; last = "A"; prevCtrl = null;
    } else if (C === "Z") {
      segs.push({ t: "Z" }); cx = sx; cy = sy; last = "Z"; prevCtrl = null;
    } else { i++; }
  }
  return segs;
}
function nfmt(v) { return (Math.round(v * 1000) / 1000).toString(); }
function serializeSegs(segs) {
  return segs.map((s) => {
    if (s.t === "M") return `M${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "L") return `L${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "C") return `C${nfmt(s.c1.x)} ${nfmt(s.c1.y)} ${nfmt(s.c2.x)} ${nfmt(s.c2.y)} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "Q") return `Q${nfmt(s.c1.x)} ${nfmt(s.c1.y)} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "A") return `A${nfmt(s.rx)} ${nfmt(s.ry)} ${nfmt(s.rot)} ${s.laf} ${s.sf} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "Z") return "Z";
    return "";
  }).join(" ");
}

// Gather draggable anchors across the SVG's shapes. Each anchor knows its
// current position and how to write a new position back to the element.
function collectAnchors(svg) {
  const out = [];
  const skip = (el) => el.closest(".hv-handles") || el.closest(".hv-overlay") || el.classList.contains("hv-artboard");
  svg.querySelectorAll("path").forEach((el) => {
    if (skip(el)) return;
    const segs = parsePath(el.getAttribute("d") || "");
    el._hvSegs = segs;
    segs.forEach((s) => {
      if (!s.end) return;
      out.push({ x: s.end.x, y: s.end.y, set: (nx, ny) => { s.end.x = nx; s.end.y = ny; el.setAttribute("d", serializeSegs(el._hvSegs)); } });
    });
  });
  svg.querySelectorAll("rect").forEach((el) => {
    if (skip(el)) return;
    const get = () => ({ x: +el.getAttribute("x") || 0, y: +el.getAttribute("y") || 0, w: +el.getAttribute("width") || 0, h: +el.getAttribute("height") || 0 });
    const corner = (xMin, yMin) => {
      const r = get();
      return {
        x: xMin ? r.x : r.x + r.w, y: yMin ? r.y : r.y + r.h,
        set: (nx, ny) => {
          const c = get();
          const ox = xMin ? c.x + c.w : c.x, oy = yMin ? c.y + c.h : c.y;
          const x0 = Math.min(nx, ox), x1 = Math.max(nx, ox), y0 = Math.min(ny, oy), y1 = Math.max(ny, oy);
          el.setAttribute("x", nfmt(x0)); el.setAttribute("y", nfmt(y0));
          el.setAttribute("width", nfmt(x1 - x0)); el.setAttribute("height", nfmt(y1 - y0));
        },
      };
    };
    out.push(corner(true, true), corner(false, true), corner(true, false), corner(false, false));
  });
  svg.querySelectorAll("polygon, polyline").forEach((el) => {
    if (skip(el)) return;
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));
    el._hvPts = pts;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const idx = k;
      out.push({ x: pts[idx], y: pts[idx + 1], set: (nx, ny) => { el._hvPts[idx] = nx; el._hvPts[idx + 1] = ny; el.setAttribute("points", el._hvPts.map(nfmt).join(" ")); } });
    }
  });
  svg.querySelectorAll("circle, ellipse").forEach((el) => {
    if (skip(el)) return;
    out.push({ x: +el.getAttribute("cx") || 0, y: +el.getAttribute("cy") || 0, set: (nx, ny) => { el.setAttribute("cx", nfmt(nx)); el.setAttribute("cy", nfmt(ny)); } });
  });
  svg.querySelectorAll("line").forEach((el) => {
    if (skip(el)) return;
    out.push({ x: +el.getAttribute("x1") || 0, y: +el.getAttribute("y1") || 0, set: (nx, ny) => { el.setAttribute("x1", nfmt(nx)); el.setAttribute("y1", nfmt(ny)); } });
    out.push({ x: +el.getAttribute("x2") || 0, y: +el.getAttribute("y2") || 0, set: (nx, ny) => { el.setAttribute("x2", nfmt(nx)); el.setAttribute("y2", nfmt(ny)); } });
  });
  return out;
}

// =========================================================================
// Vector editor — the document IS the live stage <svg> (single source of
// truth). Undo/redo via markup snapshots; selection by data-hv-id. Replaces
// the v0 global invert/stroke/point-edit toggles with a selection model.
// =========================================================================

const SKIP_TAGS = new Set(["defs", "style", "title", "metadata", "desc"]);

function toHexColor(c) {
  const n = normalizeColor(c);
  if (!n) return null;
  if (n[0] === "#") return n;
  const m = n.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const [r, g, b] = m[1].split(",").map((s) => parseInt(s, 10) || 0);
  return "#" + [r, g, b].map((v) => (v & 255).toString(16).padStart(2, "0")).join("");
}
function currentTranslate(n) {
  const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(n.getAttribute("transform") || "");
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}
function setTranslate(n, x, y) { n.setAttribute("transform", `translate(${nfmt(x)} ${nfmt(y)})`); }

const SHAPE_TOOLS = new Set(["rect", "ellipse", "line"]);

const editor = {
  stage: null,
  selection: new Set(),
  artboardSelected: false,
  tool: "select",
  history: [],
  redo: [],
  idSeq: 0,
  pinned: false,        // true when showing a blank/opened doc (skip library remount)
  _strokeWidthInput: null,
  // last-used appearance — newly drawn shapes inherit it (updated by applyFill/applyStroke)
  style: { fill: "#808080", stroke: "none", strokeWidth: 0 },

  get dirty() { return this.history.length > 0; },

  // ---------- lifecycle ----------
  sync() {
    const el = editorSvgEl();
    if (el === this.stage) return;
    if (!el) { this.stage = null; this._renderInspector(); this._updateButtons(); return; }
    this.adopt(el);
  },
  adopt(svgEl) {
    this.selection = new Set();
    this.artboardSelected = false;
    this.history = [];
    this.redo = [];
    this._install(svgEl);
    this._renderSelection();
    this._renderInspector();
    this._updateButtons();
  },
  _install(svgEl) {
    this.stage = svgEl;
    this._ensureStructure(svgEl);
    svgEl.classList.add("hv-pickable");
    if (!svgEl._hvBound) {
      svgEl.addEventListener("pointerdown", (e) => this._onPointerDown(e));
      svgEl._hvBound = true;
    }
  },
  _ensureStructure(svg) {
    let vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) {
      const w = parseFloat(svg.getAttribute("width")) || 100;
      const h = parseFloat(svg.getAttribute("height")) || 100;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      vb = svg.viewBox.baseVal;
    }
    let ab = svg.querySelector("rect.hv-artboard");
    if (!ab) {
      ab = document.createElementNS(SVG_NS, "rect");
      ab.setAttribute("class", "hv-artboard");
      ab.setAttribute("fill", "none");
      svg.insertBefore(ab, svg.firstChild);
    }
    ab.setAttribute("x", nfmt(vb.x)); ab.setAttribute("y", nfmt(vb.y));
    ab.setAttribute("width", nfmt(vb.width)); ab.setAttribute("height", nfmt(vb.height));
    this._flattenWrapper(svg);    // layered extraction: unwrap a single wrapper <g> on import
    let max = 0;
    svg.querySelectorAll("[data-hv-id]").forEach((n) => {
      const m = +(/\d+/.exec(n.getAttribute("data-hv-id")) || [0])[0];
      if (m > max) max = m;
    });
    this.idSeq = max;
    for (const child of Array.from(svg.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay")) continue;
      if (!child.hasAttribute("data-hv-id")) child.setAttribute("data-hv-id", "n" + (++this.idSeq));
    }
    let ov = svg.querySelector("g.hv-overlay");
    if (!ov) { ov = document.createElementNS(SVG_NS, "g"); ov.setAttribute("class", "hv-overlay"); }
    svg.appendChild(ov);   // keep overlay last
  },
  // If the whole graphic is one un-tagged wrapper <g> (common in exported/traced
  // SVGs), unwrap it so each colour/shape becomes its own editable layer.
  _flattenWrapper(svg) {
    const art = [...svg.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return !SKIP_TAGS.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay");
    });
    if (art.length !== 1) return;
    const g = art[0];
    if (g.tagName.toLowerCase() !== "g" || g.hasAttribute("data-hv-id")) return;
    const kids = [...g.children].filter((k) => !SKIP_TAGS.has(k.tagName.toLowerCase()));
    if (kids.length < 2) return;
    const gt = currentTranslate(g);
    for (const k of [...g.children]) {
      if (gt.x || gt.y) { const kt = currentTranslate(k); setTranslate(k, kt.x + gt.x, kt.y + gt.y); }
      svg.insertBefore(k, g);
    }
    g.remove();
  },
  _overlayEl() { return this.stage && this.stage.querySelector("g.hv-overlay"); },
  artboardEl() { return this.stage && this.stage.querySelector("rect.hv-artboard"); },

  // ---------- serialization ----------
  _historyMarkup() {
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay").forEach((g) => g.remove());
    c.classList.remove("hv-pickable");
    return c.outerHTML;
  },
  serialize() {
    if (!this.stage) return "";
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay").forEach((g) => g.remove());
    c.classList.remove("hv-pickable");
    c.querySelectorAll("[data-hv-id]").forEach((n) => {
      ["data-hv-id", "data-hv-name", "data-hv-locked"].forEach((a) => n.removeAttribute(a));
    });
    const ab = c.querySelector("rect.hv-artboard");
    if (ab) {
      const f = ab.getAttribute("fill");
      if (!f || f === "none") ab.remove();      // drop the invisible artboard from saved output
      else ab.removeAttribute("class");
    }
    return c.outerHTML;
  },

  // ---------- history ----------
  push() {
    if (!this.stage) return;
    this.commitCoalesce();                 // flush any in-progress live edit first
    this.history.push(this._state());
    if (this.history.length > 100) this.history.shift();
    this.redo = [];
    this._updateButtons();
  },
  // A run of continuous live edits (dragging a colour picker, typing a number)
  // collapses into ONE undo entry: snapshot once on begin, push it on commit.
  beginCoalesce() { if (!this._coalescing) { this._coalesceState = this._state(); this._coalescing = true; } },
  commitCoalesce() {
    if (!this._coalescing) return;
    this.history.push(this._coalesceState);
    if (this.history.length > 100) this.history.shift();
    this.redo = []; this._coalescing = false; this._coalesceState = null;
    this._updateButtons();
  },
  cancelCoalesce() { this._coalescing = false; this._coalesceState = null; },
  _state() { return { svg: this._historyMarkup(), sel: [...this.selection], ab: this.artboardSelected }; },
  undo() { this.commitCoalesce(); if (!this.history.length) return; this.redo.push(this._state()); this._restore(this.history.pop()); },
  redoAction() { this.commitCoalesce(); if (!this.redo.length) return; this.history.push(this._state()); this._restore(this.redo.pop()); },
  _restore(state) {
    const host = this.stage.parentElement; if (!host) return;
    const doc = new DOMParser().parseFromString(state.svg, "image/svg+xml");
    const fresh = document.importNode(doc.documentElement, true);
    fresh.classList.add("inline-svg");
    host.replaceChild(fresh, this.stage);
    this._install(fresh);
    this.selection = new Set(state.sel.filter((id) => this.nodeById(id)));
    this.artboardSelected = !!state.ab;
    this._renderSelection();
    this._renderInspector();
    this._updateButtons();
    measureFit(viewports.output);
  },
  _updateButtons() {
    const u = document.querySelector("#undo-button"), r = document.querySelector("#redo-button");
    if (u) u.disabled = !this.history.length;
    if (r) r.disabled = !this.redo.length;
  },

  // ---------- selection ----------
  nodeById(id) { return this.stage && this.stage.querySelector(`[data-hv-id="${CSS.escape(id)}"]`); },
  selectedNodes() { return [...this.selection].map((id) => this.nodeById(id)).filter(Boolean); },
  _onPointerDown(e) {
    if (SHAPE_TOOLS.has(this.tool)) {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();   // draw, don't pan
      this._beginDraw(e);
      return;
    }
    if (this.tool !== "select") return;
    let hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;   // locked → not selectable
    if (hit && this.stage.contains(hit)) {
      e.stopPropagation();
      const id = hit.getAttribute("data-hv-id");
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else if (!this.selection.has(id)) { this.selection = new Set([id]); }
      this.artboardSelected = false;
      this._renderSelection(); this._renderInspector();
      if (this.selection.size) this._beginMove(e);
    } else {
      this.selection = new Set();      // empty space → select the artboard, let the frame pan
      this.artboardSelected = true;
      this._renderSelection(); this._renderInspector();
    }
  },
  _beginMove(startEvent) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    const bases = nodes.map((n) => currentTranslate(n));
    let pushed = false;
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!pushed && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) { this.push(); pushed = true; }
      nodes.forEach((n, i) => setTranslate(n, bases[i].x + dx, bases[i].y + dy));
      this._renderSelection();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  // Shape tools: click-drag on the canvas to create a primitive. The whole gesture
  // is one undo step — beginCoalesce snapshots the pre-draw doc, commitCoalesce
  // commits it once the shape is large enough to keep (a bare click creates nothing).
  _beginDraw(startEvent) {
    const tool = this.tool;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    this.beginCoalesce();                         // snapshot the document before the shape exists
    this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
    const ov = this._overlayEl();
    const node = makeShapeNode(tool, start, this.style);
    this.stage.insertBefore(node, ov);
    let moved = false;
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      sizeShape(tool, node, start, p, ev.shiftKey);
      moved = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved || !shapeMeaningful(tool, node)) { node.remove(); this.cancelCoalesce(); return; }
      const id = "n" + (++this.idSeq);
      node.setAttribute("data-hv-id", id);
      this.commitCoalesce();                      // one undo entry for the whole draw
      this.selection = new Set([id]); this.artboardSelected = false;
      this._renderSelection(); this._renderInspector(); this._renderLayers();
      setStatus(`Added ${this.nodeName(node).toLowerCase()}.`, 1500);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  deleteSelection() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push();
    nodes.forEach((n) => n.remove());
    this.selection = new Set();
    this._renderSelection(); this._renderInspector();
  },
  _renderSelection() {
    const ov = this._overlayEl(); if (!ov) return;
    ov.innerHTML = "";
    const targets = this.artboardSelected
      ? [this.artboardEl()].filter(Boolean)
      : this.selectedNodes();
    const ctm = this.stage.getScreenCTM();
    if (ctm) {
      const inv = ctm.inverse();
      for (const n of targets) {
        let r; try { r = n.getBoundingClientRect(); } catch { continue; }
        if (!r.width && !r.height) continue;
        const a = new DOMPoint(r.left, r.top).matrixTransform(inv);
        const b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("class", "hv-sel-box");
        box.setAttribute("x", nfmt(Math.min(a.x, b.x))); box.setAttribute("y", nfmt(Math.min(a.y, b.y)));
        box.setAttribute("width", nfmt(Math.abs(b.x - a.x))); box.setAttribute("height", nfmt(Math.abs(b.y - a.y)));
        ov.appendChild(box);
      }
    }
    if (this.tool === "node") this.mountNodeHandles();
  },

  // ---------- tools ----------
  setTool(t) {
    if (t !== "select" && t !== "node" && !SHAPE_TOOLS.has(t)) return;
    this.tool = t;
    document.querySelectorAll(".tool-button").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    if (t === "node") this.mountNodeHandles(); else this.unmountNodeHandles();
    const msg = {
      select: "Select tool. (A = nodes)",
      node: "Node tool — drag anchors. (V = select)",
      rect: "Rectangle — drag on the canvas. (V = select)",
      ellipse: "Ellipse — drag on the canvas. Shift = circle.",
      line: "Line — drag on the canvas. Shift = 45°.",
    };
    setStatus(msg[t] || "", 1500);
  },
  unmountNodeHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-handles").forEach((g) => g.remove()); },
  onViewportChanged() { if (this.tool === "node" && this.stage) this.mountNodeHandles(); },
  mountNodeHandles() {
    this.unmountNodeHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    const anchors = collectAnchors(this.stage);
    if (!anchors.length) return;
    if (anchors.length > MAX_HANDLES) { setStatus(`Too many anchors (${anchors.length}) to edit. Works best on traced paths.`, 4000); return; }
    // constant ~5px on screen regardless of zoom (CTM.a = screen px per user unit)
    const m = this.stage.getScreenCTM();
    const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 5 / k;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "hv-handles");
    for (const a of anchors) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "hv-handle");
      c.setAttribute("cx", a.x); c.setAttribute("cy", a.y); c.setAttribute("r", r);
      this._bindNodeHandle(c, a);
      g.appendChild(c);
    }
    ov.appendChild(g);
  },
  _bindNodeHandle(c, a) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      c.setPointerCapture(e.pointerId); c.classList.add("dragging");
      let pushed = false;
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        if (!pushed) { this.push(); pushed = true; }
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
        a.set(p.x, p.y);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging");
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        this.mountNodeHandles();
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },

  // ---------- property edits — apply* do NOT push; wrap with beginCoalesce/commitCoalesce ----------
  _eachSel(fn) { this.selectedNodes().forEach(fn); this._renderSelection(); },
  applyFill(color) { this.style.fill = color || "none"; this._eachSel((n) => n.setAttribute("fill", color || "none")); },
  applyStroke(color, width) {
    this.style.stroke = width > 0 ? color : "none"; this.style.strokeWidth = width > 0 ? width : 0;
    this._eachSel((n) => {
      if (width > 0) {
        n.setAttribute("stroke", color); n.setAttribute("stroke-width", nfmt(width));
        n.setAttribute("vector-effect", "non-scaling-stroke");
        n.setAttribute("stroke-linejoin", "round"); n.setAttribute("stroke-linecap", "round");
      } else {
        ["stroke", "stroke-width", "vector-effect", "stroke-linejoin", "stroke-linecap"].forEach((x) => n.removeAttribute(x));
      }
    });
  },
  applyOpacity(v) { this._eachSel((n) => { if (v >= 1) n.removeAttribute("opacity"); else n.setAttribute("opacity", nfmt(v)); }); },
  applyArtboardBg(color) { const ab = this.artboardEl(); if (ab) ab.setAttribute("fill", color || "none"); },
  applyArtboardSize(w, h) {
    const ab = this.artboardEl(); if (!ab || !this.stage) return;
    this.stage.setAttribute("viewBox", `0 0 ${nfmt(w)} ${nfmt(h)}`);
    this.stage.setAttribute("width", nfmt(w)); this.stage.setAttribute("height", nfmt(h));
    ab.setAttribute("x", 0); ab.setAttribute("y", 0); ab.setAttribute("width", nfmt(w)); ab.setAttribute("height", nfmt(h));
    this._renderSelection(); measureFit(viewports.output);
  },

  // ---------- Phase 2 object ops (each is one undo step) ----------
  _artworkNodes() { return [...this.stage.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")); },
  duplicate() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push();
    const ov = this._overlayEl(); const ids = [];
    for (const n of nodes) {
      const c = n.cloneNode(true);
      const id = "n" + (++this.idSeq); c.setAttribute("data-hv-id", id);
      const t = currentTranslate(c); setTranslate(c, t.x + 12, t.y + 12);
      this.stage.insertBefore(c, ov);
      ids.push(id);
    }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus(`Duplicated ${ids.length} object${ids.length > 1 ? "s" : ""}.`, 1500);
  },
  reorder(mode) {
    const nodes = this.selectedNodes(); if (!nodes.length || !this.stage) return;
    this.push();
    const ov = this._overlayEl();
    if (mode === "front") { for (const n of nodes) this.stage.insertBefore(n, ov); }
    else if (mode === "back") { const first = this._artworkNodes()[0]; for (const n of nodes.slice().reverse()) this.stage.insertBefore(n, first); }
    else if (mode === "forward") { for (const n of nodes.slice().reverse()) { const nx = n.nextElementSibling; if (nx && nx !== ov && nx.hasAttribute("data-hv-id")) this.stage.insertBefore(nx, n); } }
    else if (mode === "backward") { for (const n of nodes) { const pv = n.previousElementSibling; if (pv && pv.hasAttribute("data-hv-id")) this.stage.insertBefore(n, pv); } }
    this._renderSelection(); this._renderLayers();
  },
  invertSpace() {
    const nodes = this.selectedNodes().length ? this.selectedNodes() : this._artworkNodes();
    if (!nodes.length || !this.stage) return;
    this.push();
    const vb = this.stage.viewBox.baseVal;
    const x0 = vb.x, y0 = vb.y, x1 = vb.x + vb.width, y1 = vb.y + vb.height;
    // outer ring = artboard; inner rings = the graphic; even-odd punches holes
    let d = `M${nfmt(x0)} ${nfmt(y0)} H${nfmt(x1)} V${nfmt(y1)} H${nfmt(x0)} Z`;
    let color = "#000000";
    for (const n of nodes) {
      const f = n.getAttribute("fill");
      if (f && f !== "none" && color === "#000000") color = f;
      const sp = shapeToAbsPath(n); if (sp) d += " " + sp;
    }
    const ov = this._overlayEl();
    const path = document.createElementNS(SVG_NS, "path");
    const id = "n" + (++this.idSeq);
    path.setAttribute("data-hv-id", id);
    path.setAttribute("d", d);
    path.setAttribute("fill", color);
    path.setAttribute("fill-rule", "evenodd");
    nodes.forEach((n) => n.remove());
    this.stage.insertBefore(path, ov);
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Inverted space — negative bounded by the artboard.", 2500);
  },

  // ---------- layers ----------
  nodeName(n) {
    const custom = n.getAttribute("data-hv-name"); if (custom) return custom;
    const map = { path: "Path", rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", polygon: "Polygon", polyline: "Polyline", line: "Line", g: "Group", image: "Image", text: "Text" };
    return map[n.tagName.toLowerCase()] || n.tagName.toLowerCase();
  },
  setVisibility(id, visible) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (visible) n.removeAttribute("display"); else n.setAttribute("display", "none");
    this._renderLayers(); this._renderSelection();
  },
  toggleLock(id) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (n.getAttribute("data-hv-locked") === "1") n.removeAttribute("data-hv-locked");
    else { n.setAttribute("data-hv-locked", "1"); this.selection.delete(id); }
    this._renderSelection(); this._renderInspector();
  },
  rename(id, name) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (name) n.setAttribute("data-hv-name", name); else n.removeAttribute("data-hv-name");
    this._renderLayers();
  },
  reorderTo(srcId, tgtId) {
    const src = this.nodeById(srcId), tgt = this.nodeById(tgtId);
    if (!src || !tgt || src === tgt) return;
    this.push();
    this.stage.insertBefore(src, tgt.nextSibling);   // src lands just in front of tgt
    this._renderSelection(); this._renderLayers();
  },
  group() {
    const ordered = this._artworkNodes().filter((n) => this.selection.has(n.getAttribute("data-hv-id")));
    if (ordered.length < 2) { setStatus("Select 2 or more objects to group.", 2500); return; }
    this.push();
    const ov = this._overlayEl();
    const g = document.createElementNS(SVG_NS, "g");
    const id = "n" + (++this.idSeq); g.setAttribute("data-hv-id", id);
    const anchor = ordered[ordered.length - 1].nextSibling;
    ordered.forEach((n) => { n.removeAttribute("data-hv-id"); g.appendChild(n); });
    this.stage.insertBefore(g, anchor && anchor !== ov ? anchor : ov);
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus(`Grouped ${ordered.length} objects.`, 1500);
  },
  ungroup() {
    const groups = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "g");
    if (!groups.length) { setStatus("Select a group to ungroup.", 2500); return; }
    this.push();
    const ids = [];
    for (const g of groups) {
      const gt = currentTranslate(g);
      for (const k of [...g.children]) {
        if (gt.x || gt.y) { const kt = currentTranslate(k); setTranslate(k, kt.x + gt.x, kt.y + gt.y); }
        const id = "n" + (++this.idSeq); k.setAttribute("data-hv-id", id); ids.push(id);
        this.stage.insertBefore(k, g);
      }
      g.remove();
    }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Ungrouped.", 1500);
  },
  _renderLayers() {
    const list = document.querySelector("#layers-list");
    if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    const nodes = this._artworkNodes().slice().reverse();   // top of list = frontmost
    for (const n of nodes) {
      const id = n.getAttribute("data-hv-id");
      const row = document.createElement("div");
      row.className = "layer-row" + (this.selection.has(id) ? " active" : "");
      row.draggable = true; row.dataset.id = id;

      const eye = document.createElement("button");
      eye.type = "button"; eye.className = "layer-btn";
      const hidden = n.getAttribute("display") === "none";
      eye.textContent = hidden ? "○" : "●"; eye.title = hidden ? "Show" : "Hide";
      eye.addEventListener("click", (e) => { e.stopPropagation(); this.setVisibility(id, hidden); });

      const swatch = document.createElement("span");
      swatch.className = "layer-swatch";
      const fill = toHexColor(n.getAttribute("fill"));
      if (fill && n.getAttribute("fill") !== "none") { swatch.style.background = fill; swatch.style.backgroundImage = "none"; }
      swatch.title = n.getAttribute("fill") || "no fill";

      const name = document.createElement("span");
      name.className = "layer-name"; name.textContent = this.nodeName(n);
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", (e) => { e.stopPropagation(); this._renameInline(n, name); });

      const lock = document.createElement("button");
      lock.type = "button"; lock.className = "layer-btn";
      const locked = n.getAttribute("data-hv-locked") === "1";
      lock.textContent = locked ? "L" : "·"; lock.title = locked ? "Unlock" : "Lock"; lock.classList.toggle("on", locked);
      lock.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(id); });

      row.append(eye, swatch, name, lock);
      row.addEventListener("click", () => {
        if (n.getAttribute("data-hv-locked") === "1") return;
        this.selection = new Set([id]); this.artboardSelected = false;
        this._renderSelection(); this._renderInspector();
      });
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => { e.preventDefault(); });
      row.addEventListener("drop", (e) => { e.preventDefault(); const src = e.dataTransfer.getData("text/plain"); if (src && src !== id) this.reorderTo(src, id); });
      list.appendChild(row);
    }
  },
  _renameInline(node, span) {
    const input = document.createElement("input");
    input.type = "text"; input.className = "layer-rename"; input.value = this.nodeName(node);
    const done = (commit) => {
      if (commit) this.rename(node.getAttribute("data-hv-id"), input.value.trim());
      else this._renderLayers();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
    span.replaceWith(input); input.focus(); input.select();
  },

  // ---------- inspector ----------
  _renderInspector() {
    this._renderLayers();   // keep the layers panel in sync with structure/selection
    const body = document.querySelector("#inspector-body");
    const title = document.querySelector("#inspector-title");
    if (!body) return;
    body.innerHTML = "";
    if (!this.stage) { if (title) title.textContent = "No canvas"; body.innerHTML = `<div class="insp-empty">Import or open a vector.</div>`; return; }
    if (this.artboardSelected) { if (title) title.textContent = "Artboard"; body.appendChild(this._artboardPanel()); return; }
    const nodes = this.selectedNodes();
    if (!nodes.length) { if (title) title.textContent = "Nothing selected"; body.innerHTML = `<div class="insp-empty">Click a shape to select it, or click empty canvas for the artboard.</div>`; return; }
    if (title) title.textContent = nodes.length === 1 ? "Object" : `${nodes.length} objects`;
    body.appendChild(this._objectPanel(nodes));
  },
  _objectPanel(nodes) {
    const first = nodes[0];
    const wrap = document.createElement("div");
    const commit = () => this.commitCoalesce();
    const fillHex = toHexColor(first.getAttribute("fill")) || "#000000";
    const fillNone = first.getAttribute("fill") === "none";
    wrap.appendChild(inspGroup("Fill", [
      colorRow("Colour", fillHex, (v) => { this.beginCoalesce(); this.applyFill(v); }, commit),
      checkRow("No fill", fillNone, (on) => { this.push(); this.applyFill(on ? null : (toHexColor(first.getAttribute("fill")) || "#000000")); }),
    ]));
    const strokeHex = toHexColor(first.getAttribute("stroke")) || "#000000";
    const strokeW = parseFloat(first.getAttribute("stroke-width")) || 0;
    this._strokeWidthInput = null;
    const curW = () => Math.max(parseFloat(this._strokeWidthInput && this._strokeWidthInput.value) || strokeW || 1, 0.01);
    const curC = () => toHexColor(first.getAttribute("stroke")) || strokeHex;
    wrap.appendChild(inspGroup("Stroke", [
      colorRow("Colour", strokeHex, (v) => { this.beginCoalesce(); this.applyStroke(v, curW()); }, commit),
      numRow("Width", strokeW, 0, 0.5, (v) => { this.beginCoalesce(); this.applyStroke(curC(), v); }, (inp) => { this._strokeWidthInput = inp; }, commit),
    ]));
    const op = first.hasAttribute("opacity") ? parseFloat(first.getAttribute("opacity")) : 1;
    wrap.appendChild(inspGroup("Opacity", [
      numRow("Alpha", op, 0, 0.05, (v) => { this.beginCoalesce(); this.applyOpacity(Math.max(0, Math.min(1, v))); }, null, commit),
    ]));
    const act = document.createElement("div"); act.className = "insp-actions";
    act.appendChild(ghostBtn("Duplicate", () => this.duplicate()));
    act.appendChild(ghostBtn("Invert space", () => this.invertSpace()));
    act.appendChild(ghostBtn("Delete", () => this.deleteSelection()));
    wrap.appendChild(act);
    const z = document.createElement("div"); z.className = "insp-actions";
    z.appendChild(ghostBtn("Front", () => this.reorder("front")));
    z.appendChild(ghostBtn("Fwd", () => this.reorder("forward")));
    z.appendChild(ghostBtn("Bwd", () => this.reorder("backward")));
    z.appendChild(ghostBtn("Back", () => this.reorder("back")));
    wrap.appendChild(z);
    return wrap;
  },
  _artboardPanel() {
    const ab = this.artboardEl();
    const vb = this.stage.viewBox.baseVal;
    const wrap = document.createElement("div");
    const commit = () => this.commitCoalesce();
    const bgHex = toHexColor(ab.getAttribute("fill")) || "#ffffff";
    const bgNone = !ab.getAttribute("fill") || ab.getAttribute("fill") === "none";
    let wInp, hInp;
    const liveSize = () => { this.beginCoalesce(); this.applyArtboardSize(parseFloat(wInp.value) || vb.width, parseFloat(hInp.value) || vb.height); };
    wrap.appendChild(inspGroup("Size", [
      numRow("Width", Math.round(vb.width), 1, 1, liveSize, (i) => { wInp = i; }, commit),
      numRow("Height", Math.round(vb.height), 1, 1, liveSize, (i) => { hInp = i; }, commit),
    ]));
    wrap.appendChild(inspGroup("Background", [
      colorRow("Colour", bgHex, (v) => { this.beginCoalesce(); this.applyArtboardBg(v); }, commit),
      checkRow("Transparent", bgNone, (on) => { this.push(); this.applyArtboardBg(on ? null : (toHexColor(ab.getAttribute("fill")) || "#ffffff")); }),
    ]));
    return wrap;
  },

  // ---------- save ----------
  async save() {
    if (!this.stage) return;
    if (!selectedOutput) { setStatus("Save needs an imported or opened document for now.", 3500); return; }
    const svgText = this.serialize(); if (!svgText) return;
    try {
      const data = await api("/api/save-svg", "POST", { folder: selectedOutput.folder, name: selectedOutput.name, svg: svgText });
      manualOutputName = data.name;
      this.pinned = false;
      await refreshAll();
      setStatus(data.message || "Saved.", 2500);
    } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
  },
};

// ---------- inspector control builders ----------
function inspGroup(title, rows) {
  const g = document.createElement("div"); g.className = "insp-group";
  const t = document.createElement("div"); t.className = "insp-title"; t.textContent = title; g.appendChild(t);
  rows.forEach((r) => g.appendChild(r));
  return g;
}
function inspRow(label, control) {
  const row = document.createElement("div"); row.className = "insp-row";
  const s = document.createElement("span"); s.textContent = label;
  row.appendChild(s); row.appendChild(control); return row;
}
function colorRow(label, value, onLive, onCommit) {
  const inp = document.createElement("input"); inp.type = "color"; inp.value = value || "#000000";
  inp.addEventListener("input", () => onLive(inp.value));
  inp.addEventListener("change", () => { onLive(inp.value); if (onCommit) onCommit(); });
  return inspRow(label, inp);
}
function numRow(label, value, min, step, onLive, capture, onCommit) {
  const inp = document.createElement("input"); inp.type = "number"; inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
  inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
  if (capture) capture(inp);
  return inspRow(label, inp);
}
function checkRow(label, checked, onChange) {
  const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return inspRow(label, inp);
}

// Convert a shape element to an absolute path `d` (baking in any translate),
// used to build the even-odd compound for invert-space.
function shapeToAbsPath(el) {
  const t = currentTranslate(el);
  const off = (x, y) => `${nfmt(x + t.x)} ${nfmt(y + t.y)}`;
  const num = (a) => parseFloat(el.getAttribute(a)) || 0;
  const tag = el.tagName.toLowerCase();
  if (tag === "path") {
    const segs = parsePath(el.getAttribute("d") || "");
    if (t.x || t.y) segs.forEach((s) => {
      if (s.end) { s.end.x += t.x; s.end.y += t.y; }
      if (s.c1) { s.c1.x += t.x; s.c1.y += t.y; }
      if (s.c2) { s.c2.x += t.x; s.c2.y += t.y; }
    });
    return serializeSegs(segs);
  }
  if (tag === "rect") {
    const x = num("x"), y = num("y"), w = num("width"), h = num("height");
    return `M${off(x, y)} L${off(x + w, y)} L${off(x + w, y + h)} L${off(x, y + h)} Z`;
  }
  if (tag === "polygon" || tag === "polyline") {
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    if (pts.length < 4) return "";
    let s = `M${off(pts[0], pts[1])}`;
    for (let i = 2; i + 1 < pts.length; i += 2) s += ` L${off(pts[i], pts[i + 1])}`;
    return s + " Z";
  }
  if (tag === "circle") {
    const cx = num("cx"), cy = num("cy"), r = num("r");
    return `M${off(cx - r, cy)} A${nfmt(r)} ${nfmt(r)} 0 1 0 ${off(cx + r, cy)} A${nfmt(r)} ${nfmt(r)} 0 1 0 ${off(cx - r, cy)} Z`;
  }
  if (tag === "ellipse") {
    const cx = num("cx"), cy = num("cy"), rx = num("rx"), ry = num("ry");
    return `M${off(cx - rx, cy)} A${nfmt(rx)} ${nfmt(ry)} 0 1 0 ${off(cx + rx, cy)} A${nfmt(rx)} ${nfmt(ry)} 0 1 0 ${off(cx - rx, cy)} Z`;
  }
  return "";
}
// ---------- shape-tool geometry (pure) ----------
function applyShapeStyle(n, style, isLine) {
  if (isLine) {
    n.setAttribute("fill", "none");
    const col = style.stroke && style.stroke !== "none" ? style.stroke : "#1d1d1f";
    const w = style.strokeWidth > 0 ? style.strokeWidth : 2;
    n.setAttribute("stroke", col); n.setAttribute("stroke-width", nfmt(w));
    n.setAttribute("vector-effect", "non-scaling-stroke");
    n.setAttribute("stroke-linecap", "round");
    return;
  }
  n.setAttribute("fill", style.fill || "#808080");
  if (style.stroke && style.stroke !== "none" && style.strokeWidth > 0) {
    n.setAttribute("stroke", style.stroke); n.setAttribute("stroke-width", nfmt(style.strokeWidth));
    n.setAttribute("vector-effect", "non-scaling-stroke");
    n.setAttribute("stroke-linejoin", "round"); n.setAttribute("stroke-linecap", "round");
  }
}
function makeShapeNode(tool, p, style) {
  if (tool === "line") {
    const n = document.createElementNS(SVG_NS, "line");
    n.setAttribute("x1", nfmt(p.x)); n.setAttribute("y1", nfmt(p.y));
    n.setAttribute("x2", nfmt(p.x)); n.setAttribute("y2", nfmt(p.y));
    applyShapeStyle(n, style, true);
    return n;
  }
  if (tool === "ellipse") {
    const n = document.createElementNS(SVG_NS, "ellipse");
    n.setAttribute("cx", nfmt(p.x)); n.setAttribute("cy", nfmt(p.y));
    n.setAttribute("rx", 0); n.setAttribute("ry", 0);
    applyShapeStyle(n, style, false);
    return n;
  }
  const n = document.createElementNS(SVG_NS, "rect");
  n.setAttribute("x", nfmt(p.x)); n.setAttribute("y", nfmt(p.y));
  n.setAttribute("width", 0); n.setAttribute("height", 0);
  applyShapeStyle(n, style, false);
  return n;
}
function sizeShape(tool, n, a, b, constrain) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (tool === "line") {
    let x2 = b.x, y2 = b.y;
    if (constrain) {                 // snap to 0 / 45 / 90°
      const len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x2 = a.x + Math.cos(ang) * len; y2 = a.y + Math.sin(ang) * len;
    }
    n.setAttribute("x2", nfmt(x2)); n.setAttribute("y2", nfmt(y2));
    return;
  }
  if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = (dx < 0 ? -1 : 1) * m; dy = (dy < 0 ? -1 : 1) * m; }
  const x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy), w = Math.abs(dx), h = Math.abs(dy);
  if (tool === "rect") {
    n.setAttribute("x", nfmt(x)); n.setAttribute("y", nfmt(y));
    n.setAttribute("width", nfmt(w)); n.setAttribute("height", nfmt(h));
  } else {
    n.setAttribute("cx", nfmt(x + w / 2)); n.setAttribute("cy", nfmt(y + h / 2));
    n.setAttribute("rx", nfmt(w / 2)); n.setAttribute("ry", nfmt(h / 2));
  }
}
function shapeMeaningful(tool, n) {
  if (tool === "line") {
    const dx = (+n.getAttribute("x2")) - (+n.getAttribute("x1"));
    const dy = (+n.getAttribute("y2")) - (+n.getAttribute("y1"));
    return Math.hypot(dx, dy) > 0.5;
  }
  if (tool === "rect") return (+n.getAttribute("width")) > 0.5 && (+n.getAttribute("height")) > 0.5;
  return (+n.getAttribute("rx")) > 0.25 && (+n.getAttribute("ry")) > 0.25;
}
function ghostBtn(label, onClick) {
  const b = document.createElement("button"); b.type = "button"; b.className = "ghost-button"; b.textContent = label;
  b.addEventListener("click", onClick); return b;
}

// ---------- document menu actions ----------
function mountStageFromText(text, name) {
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

function importRun(process) {
  processSelectEl.value = process;
  processSelectEl.dispatchEvent(new Event("change"));
  runProcess();
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

async function loadSvgToStage(url, name) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    selectedOutput = null; manualOutputName = null;
    mountStageFromText(text, name);
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
      else { loadSvgToStage(picked.url, picked.name); }
    });
  };
  modalSearchEl.oninput = apply;
  apply();
}

async function exportFlow() {
  if (!editor.stage) return;
  if (editor.dirty && selectedOutput) await editor.save();
  if (!selectedOutput) { setStatus("Export needs a saved document — use Save first.", 3500); return; }
  openExportModal();
}

const MENU_ITEMS = {
  "doc-new": () => [
    { label: "Blank canvas…", onClick: newBlankDoc },
  ],
  "doc-import": () => [
    { label: "Production SVG", onClick: () => importRun("pipeline") },
    { label: "SVG Trace", onClick: () => importRun("vectorize") },
    { label: "Pixel Art → SVG", onClick: () => importRun("pixelvec") },
    { type: "sep" },
    { label: "Cutout PNG", onClick: () => importRun("cutout") },
    { label: "Upscale PNG", onClick: () => importRun("upscale") },
    { label: "Greenscreen Cutout", onClick: () => importRun("chromakey") },
  ],
  "doc-export": () => [
    { label: "Export PNG…", onClick: exportFlow },
    { label: "Copy SVG markup", onClick: copySvgSource },
  ],
  "library": () => {
    const item = selectedItem();
    return [
      { label: "Image info…", onClick: openInfoModal },
      { label: "Browse…", onClick: openBrowseModal },
      { type: "sep" },
      { label: "Clean derivatives", onClick: cleanDerivatives },
      { label: "Remove selected", disabled: !(item && item.removable), onClick: removeSelected },
    ];
  },
  "layers": () => {
    const sel = editor.selectedNodes();
    const hasGroup = sel.some((n) => n.tagName.toLowerCase() === "g");
    return [
      { label: "Group", disabled: sel.length < 2, onClick: () => editor.group() },
      { label: "Ungroup", disabled: !hasGroup, onClick: () => editor.ungroup() },
    ];
  },
};

// ---------- editor wiring: tools, header buttons, rail, keyboard ----------
document.querySelectorAll(".tool-button").forEach((b) => b.addEventListener("click", () => editor.setTool(b.dataset.tool)));
{
  const openBtn = document.querySelector("#open-button"); if (openBtn) openBtn.addEventListener("click", openOpenModal);
  const saveBtn = document.querySelector("#save-button"); if (saveBtn) saveBtn.addEventListener("click", () => editor.save());
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
}
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) editor.redoAction(); else editor.undo(); return; }
  if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); editor.redoAction(); return; }
  if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); editor.duplicate(); return; }
  if (mod && (e.key === "g" || e.key === "G")) { e.preventDefault(); if (e.shiftKey) editor.ungroup(); else editor.group(); return; }
  if (mod && e.key === "]") { e.preventDefault(); editor.reorder(e.shiftKey ? "front" : "forward"); return; }
  if (mod && e.key === "[") { e.preventDefault(); editor.reorder(e.shiftKey ? "back" : "backward"); return; }
  if (mod) return;
  if (!modalRootEl.hidden) return;
  if (e.key === "Delete" || e.key === "Backspace") { if (editor.selection.size) { e.preventDefault(); editor.deleteSelection(); } return; }
  if (e.key === "v" || e.key === "V") { editor.setTool("select"); return; }
  if (e.key === "a" || e.key === "A") { editor.setTool("node"); return; }
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
function setMenuHidden(name, hidden) {
  const el = document.querySelector(`.menu[data-menu="${name}"]`);
  if (!el) return;
  el.hidden = !!hidden;
  if (hidden && openMenuEl === el) closeMenus();
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

async function runProcess() {
  if (runButtonEl.disabled) return;
  runButtonEl.disabled = true;
  const originalLabel = runButtonEl.textContent;
  runButtonEl.textContent = "Starting…";
  try {
    const payload = { ...settings };
    if (modeSelectEl.value === "single" && selectedName) payload.inputs = [selectedName];
    if (forceInputEl && forceInputEl.checked) payload.force = true;
    const data = await api(`/api/run/${processSelectEl.value}`, "POST", payload);
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

async function removeSelected() {
  if (!selectedName) return;
  try {
    const data = await api("/api/work-items/remove", "POST", { name: selectedName });
    const nextSelection = selectedName;
    await refreshAll();
    if (selectedName === nextSelection && workItems.length) {
      selectedName = workItems[0].name;
      renderQueue();
      await renderPreviews();
    }
    setStatus(data.message, 2500);
  } catch (error) {
    setStatus(error.message, 3000);
  }
}

clearJobsEl.addEventListener("click", async () => {
  try {
    const data = await api("/api/jobs/clear", "POST", {});
    setStatus(data.message, 2000);
    await loadJobs();
  } catch (error) {
    setStatus(error.message, 3000);
  }
});

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

function renderJobsModal() {
  if (!jobsModalOpen) return;
  modalTitleEl.textContent = `Jobs — ${jobsCache.length}`;
  modalBodyEl.innerHTML = "";
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
    modalBodyEl.appendChild(wrap);
    return;
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
  modalBodyEl.appendChild(wrap);
}

function openJobsModal() {
  jobsModalOpen = true;
  openModal(`Jobs — ${jobsCache.length}`);
  modalSearchEl.hidden = true;
  renderJobsModal();
  // Refresh immediately so the panel reflects current state without waiting for the next poll tick.
  loadJobs().catch(() => {});
}

if (jobsButtonEl) jobsButtonEl.addEventListener("click", openJobsModal);

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
      openSettingsModal();
    });
    root.appendChild(fieldRow("Preset", presetSel, "Tunes the sliders below as a group."));
    root.appendChild(fieldRow("Mode", makeSelect("trace_mode", [["spline","Spline (curves)"],["polygon","Polygon"],["pixel","Pixel (no smoothing)"]])));
    const advToggle = document.createElement("input");
    advToggle.type = "checkbox";
    advToggle.checked = !!settings.trace_advanced;
    advToggle.addEventListener("change", () => { settings.trace_advanced = advToggle.checked; persistSettings(); openSettingsModal(); });
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
    backendSel.addEventListener("change", () => openSettingsModal());
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
    openSettingsModal();
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
  modalBodyEl.appendChild(buildSettingsForm(proc));
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function openInfoModal() {
  if (!selectedName) {
    setStatus("Select an image first.", 2000);
    return;
  }
  openModal(`Info — ${selectedName}`, true);
  modalSearchEl.hidden = true;
  modalBodyEl.innerHTML = `<div class="form-section">Loading…</div>`;
  let info;
  try {
    info = await api(`/api/work-items/info?name=${encodeURIComponent(selectedName)}`);
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
        const stamp = Date.now();
        if (viewports.input.url && viewports.input.name === updated.name) {
          const freshUrl = bustUrl(stripBust(viewports.input.url), stamp);
          viewports.input.url = null;
          mountViewport(viewports.input, "png", freshUrl, updated.name, updated.path)
            .catch((e) => clearViewport(viewports.input, e.message));
        }
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
  const rows = [
    ["j / ↓", "Next image"],
    ["k / ↑", "Previous image"],
    ["g / G", "First / last image"],
    ["Enter", "Run process"],
    [",", "Process settings"],
    ["i", "Image info & rotate"],
    ["/", "Browse library"],
    ["[ / ]", "Cycle process"],
    ["m", "Cycle Single / Batch"],
    ["q", "Open Jobs queue"],
    ["1 / 2", "Focus input / output panel"],
    ["+ / -", "Zoom focused panel"],
    ["0", "Actual size (1:1)"],
    ["f", "Fit to frame"],
    ["t", "Cycle output variant"],
    ["b", "Cycle background of focused panel"],
    ["Esc", "Close modal / cancel"],
  ];
  const root = document.createElement("div");
  root.className = "form";
  const grid = document.createElement("div");
  grid.className = "info-grid";
  for (const [keys, desc] of rows) {
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
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}

settingsButtonEl.addEventListener("click", openSettingsModal);
shortcutButtonEl.addEventListener("click", openShortcutsModal);

let focusedVp = "output";
function focusViewport(name) {
  focusedVp = name;
  for (const [n, vp] of Object.entries(viewports)) {
    vp.el.parentElement?.classList.toggle("panel-focused", n === name);
  }
}
focusViewport("output");
outputPreviewEl.addEventListener("pointerdown", () => focusViewport("output"));

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

function moveLibrary(delta) {
  const list = visibleLibraryItems.length ? visibleLibraryItems : workItems;
  if (!list.length) return;
  const i = list.findIndex((it) => it.name === selectedName);
  const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta));
  if (list[j].name === selectedName) return;
  selectedName = list[j].name;
  manualOutputName = null;
  editor.pinned = false;
  renderQueue();
  renderPreviews().catch((error) => setStatus(error.message, 2500));
  const active = queueEl.querySelector(".queue-item.active");
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function cycleProcess(delta) {
  const opts = Array.from(processSelectEl.options);
  const i = opts.findIndex((o) => o.value === processSelectEl.value);
  const j = (i + delta + opts.length) % opts.length;
  processSelectEl.value = opts[j].value;
  processSelectEl.dispatchEvent(new Event("change"));
  setStatus(`Process: ${opts[j].text}`, 1500);
}

function cycleMode() {
  modeSelectEl.value = modeSelectEl.value === "batch" ? "single" : "batch";
  setStatus(`Mode: ${modeSelectEl.value}`, 1200);
}

function cycleOutputVariant() {
  const matches = latestOutputsFor(selectedName);
  if (matches.length <= 1) return;
  const cur = selectedOutput?.name;
  const i = matches.findIndex((m) => m.name === cur);
  const next = matches[(i + 1 + matches.length) % matches.length];
  manualOutputName = next.name;
  renderPreviews().catch((error) => setStatus(error.message, 2500));
}

document.addEventListener("keydown", (event) => {
  const tag = (event.target?.tagName || "").toLowerCase();
  const isEditing = tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable;
  if (event.key === "Escape" && isEditing && document.activeElement?.blur) {
    document.activeElement.blur();
    return;
  }
  if (isEditing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!modalRootEl.hidden && event.key !== "Escape") return;

  switch (event.key) {
    case "j": case "ArrowDown": event.preventDefault(); moveLibrary(1); break;
    case "k": case "ArrowUp": event.preventDefault(); moveLibrary(-1); break;
    case "g": event.preventDefault(); moveLibrary(-workItems.length); break;
    case "G": event.preventDefault(); moveLibrary(workItems.length); break;
    case "Enter": event.preventDefault(); runProcess(); break;
    case ",": event.preventDefault(); openSettingsModal(); break;
    case "i": event.preventDefault(); openInfoModal(); break;
    case "/": event.preventDefault(); openBrowseModal(); break;
    case "?": event.preventDefault(); openShortcutsModal(); break;
    case "[": event.preventDefault(); cycleProcess(-1); break;
    case "]": event.preventDefault(); cycleProcess(1); break;
    case "m": event.preventDefault(); cycleMode(); break;
    case "q": event.preventDefault(); openJobsModal(); break;
    case "1": event.preventDefault(); focusViewport("input"); break;
    case "2": event.preventDefault(); focusViewport("output"); break;
    case "+": case "=": event.preventDefault(); zoomVp(viewports[focusedVp], 1.2); break;
    case "-": case "_": event.preventDefault(); zoomVp(viewports[focusedVp], 1 / 1.2); break;
    case "0": event.preventDefault(); actualVp(viewports[focusedVp]); break;
    case "f": event.preventDefault(); fitVp(viewports[focusedVp]); break;
    case "t": event.preventDefault(); cycleOutputVariant(); break;
    case "b": event.preventDefault(); cycleBg(focusedVp); break;
  }
});

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
