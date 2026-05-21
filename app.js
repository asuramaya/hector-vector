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
const openInputEl = document.querySelector("#open-input");
const openOutputEl = document.querySelector("#open-output");
const statusTextEl = document.querySelector("#status-text");
const removeSelectedEl = document.querySelector("#remove-selected");
const clearJobsEl = document.querySelector("#clear-jobs");
const jobsButtonEl = document.querySelector("#jobs-button");
const jobsCountEl = document.querySelector("#jobs-count");
const forceInputEl = document.querySelector("#force-input");
const runButtonEl = document.querySelector("#run-button");
const libraryHeaderEl = document.querySelector(".library .panel-head > span");
const sourcePathEl = document.querySelector("#source-path");
const sourceEditEl = document.querySelector("#source-edit");
const sourceResetEl = document.querySelector("#source-reset");
const sourceRowEl = document.querySelector(".source-row");
const browseButtonEl = document.querySelector("#browse-button");
const cleanDerivativesEl = document.querySelector("#clean-derivatives");
const infoButtonEl = document.querySelector("#info-button");
const outputPickerEl = document.querySelector("#output-picker");
const outputLabelEl = document.querySelector("#output-label");
const copySvgSourceEl = document.querySelector("#copy-svg-source");
const exportPngEl = document.querySelector("#export-png");
const copyOutputFolderEl = document.querySelector("#copy-output-folder");
const copyInputFolderEl = document.querySelector("#copy-input-folder");
const revealInputEl = document.querySelector("#reveal-input");
const revealOutputEl = document.querySelector("#reveal-output");
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
    .replace(/(?:\.cutout|\.chromakey)$/, "")
    .replace(/@\d+x\d+$/, "");  // group rendered "name@512x512.png" under its source
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
  if (name.includes(".cutout.")) return "Cutout";
  if (name.includes(".chromakey.")) return "Chromakey";
  if (name.includes(".preview.")) return "Preview";
  if (name.includes(".mask.")) return "Mask";
  if (name.endsWith(".svg")) return "SVG";
  return "Upscale";
}

const VARIANT_ORDER = ["Upscale", "Preview", "Cutout", "Chromakey", "Mask", "SVG"];

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
  const item = selectedItem();
  if (!item) {
    removeSelectedEl.disabled = true;
    removeSelectedEl.textContent = "Remove";
    removeSelectedEl.title = "Select an image to remove";
    return;
  }
  removeSelectedEl.disabled = !item.removable;
  removeSelectedEl.textContent = "Remove";
  removeSelectedEl.title = item.removable
    ? `Remove ${item.name}`
    : "Workspace files can't be removed from here";
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
    if (viewports.input.url) {
      openInputEl.href = input.url;
      openInputEl.style.visibility = "visible";
    } else {
      openInputEl.style.visibility = "hidden";
    }
  } else if (viewports.input.url !== null) {
    clearViewport(viewports.input, "No image selected.");
    openInputEl.style.visibility = "hidden";
  }

  if (selectedOutput) {
    if (viewports.output.url !== selectedOutput.url) {
      try {
        await mountViewport(viewports.output, selectedOutput.kind, selectedOutput.url, selectedOutput.name, selectedOutput.path);
      } catch (error) {
        clearViewport(viewports.output, error.message);
      }
    }
    if (viewports.output.url) {
      openOutputEl.href = selectedOutput.url;
      openOutputEl.style.visibility = "visible";
    } else {
      openOutputEl.style.visibility = "hidden";
    }
  } else if (viewports.output.url !== null) {
    clearViewport(viewports.output, "Run a process to render output.");
    openOutputEl.style.visibility = "hidden";
  }
  if (outputLabelEl) {
    outputLabelEl.textContent = selectedOutput ? `Output — ${variantLabel(selectedOutput.name)}` : "Output";
  }
  const outputIsSvg = !!(viewports.output.kind === "svg" && viewports.output.url);
  if (copySvgSourceEl) copySvgSourceEl.hidden = !outputIsSvg;
  if (exportPngEl) exportPngEl.hidden = !(outputIsSvg && selectedOutput);
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

function openModal(title) {
  modalTitleEl.textContent = title;
  modalSearchEl.value = "";
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
      closeModal();
      renderQueue();
      renderPreviews().catch((error) => setStatus(error.message, 2500));
    });
  };
  modalSearchEl.oninput = applyFilter;
  applyFilter();
}

browseButtonEl.addEventListener("click", openBrowseModal);

cleanDerivativesEl.addEventListener("click", async () => {
  if (!confirm("Delete all .cutout/.mask/.preview/.chromakey files from the current source folder?")) return;
  try {
    const data = await api("/api/work-items/clean-derivatives", "POST", {});
    setStatus(data.message || "Cleaned.", 2500);
    await refreshAll();
  } catch (error) {
    setStatus(error.message, 3000);
  }
});

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

document.querySelector("#copy-input-path").addEventListener("click", async () => {
  const item = selectedItem();
  const abs = item ? absInputPath(item) : viewports.input.path;
  if (!abs) return;
  await copyToClipboard(abs);
});

document.querySelector("#copy-output-path").addEventListener("click", async () => {
  const abs = selectedOutput ? absOutputPath(selectedOutput) : viewports.output.path;
  if (!abs) return;
  await copyToClipboard(abs);
});

if (copyInputFolderEl) {
  copyInputFolderEl.addEventListener("click", async () => {
    const item = selectedItem();
    const abs = item ? absInputPath(item) : viewports.input.path;
    const dir = parentDir(abs);
    if (!dir) return;
    await copyToClipboard(dir);
  });
}

if (copyOutputFolderEl) {
  copyOutputFolderEl.addEventListener("click", async () => {
    const abs = selectedOutput ? absOutputPath(selectedOutput) : viewports.output.path;
    const dir = parentDir(abs);
    if (!dir) return;
    await copyToClipboard(dir);
  });
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

if (revealInputEl) {
  revealInputEl.addEventListener("click", () => {
    const item = selectedItem();
    const abs = item ? absInputPath(item) : viewports.input.path;
    revealInFileManager(abs);
  });
}

if (revealOutputEl) {
  revealOutputEl.addEventListener("click", () => {
    const abs = selectedOutput ? absOutputPath(selectedOutput) : viewports.output.path;
    revealInFileManager(abs);
  });
}

if (copySvgSourceEl) {
  copySvgSourceEl.addEventListener("click", async () => {
    if (!viewports.output.url || viewports.output.kind !== "svg") return;
    try {
      const res = await fetch(viewports.output.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await copyToClipboard(text, `SVG (${text.length} chars)`);
    } catch (e) {
      setStatus(`Copy SVG failed: ${e.message}`, 3000);
    }
  });
}

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
  openModal("Export PNG");
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

if (exportPngEl) exportPngEl.addEventListener("click", openExportModal);

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

removeSelectedEl.addEventListener("click", async () => {
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
});

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
  openModal(`Settings — ${label}`);
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
  openModal(`Info — ${selectedName}`);
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
infoButtonEl.addEventListener("click", openInfoModal);
shortcutButtonEl.addEventListener("click", openShortcutsModal);

let focusedVp = "input";
function focusViewport(name) {
  focusedVp = name;
  for (const [n, vp] of Object.entries(viewports)) {
    vp.el.parentElement?.classList.toggle("panel-focused", n === name);
  }
}
focusViewport("input");
inputPreviewEl.addEventListener("pointerdown", () => focusViewport("input"));
outputPreviewEl.addEventListener("pointerdown", () => focusViewport("output"));

function zoomVp(vp, factor) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = Math.max(0.02, Math.min(40, vp.scale * factor));
  applyViewportState(vp);
}
function fitVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = vp.fitScale || 1;
  vp.x = 0; vp.y = 0;
  applyViewportState(vp);
}
function actualVp(vp) {
  if (!vp.el.querySelector(".viewport-content")) return;
  vp.scale = 1; vp.x = 0; vp.y = 0;
  applyViewportState(vp);
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
          // Force fresh mount so the new artifact shows up automatically.
          manualOutputName = null;
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
