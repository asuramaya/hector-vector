// =========================================================================
// hector-vector — app shell. State, library/queue, viewports, modal + form
// primitives, the Process workspace, menus, document ops, keyboard, bootstrap.
// Consumes the hv library and the editor module; exposes a small service set to
// the editor and a window bridge for automation (both at the bottom of file).
// =========================================================================
import * as hv from "./hv/index.js";
import { shapeToAbsPath } from "./hv/index.js";
import { editor, ghostBtn } from "./editor.js";
import { createLayoutCustomize } from "./ui/layout.js";
import { createDocks } from "./ui/docks.js";
import { createManage } from "./ui/manage.js";
import { api } from "./ui/api.js";
import * as fonts from "./ui/fonts.js";
import {
  jobsCache, activityState, TERMINAL_STATES,
  configureJobs, resetFailCount, nextJobsSeq, installJobActive,
  fetchJobs, loadJobs, applyJobsData,
} from "./ui/jobs.js";
import {
  configureProcessor, armLive, armOp,
  rasterLive, rasterOp, rasterLiveNode, rasterOpNode, rasterOpName, rasterStageBusy,
  rasterLiveKicks, rasterOpKicks, engineSchemas, rasterOpSchemas,
  capsInfo, capsBusy, capsTried,
  rasterHref, rasterName, rasterNaturalSize,
  ensureEngineSchemas, currentEngineId, setEngine, schemaWhenOk, schemaControl,
  ensureRasterOpSchemas, rasterOpById, ensureCapsInfo, capById,
  startRasterLive, endRasterLive, scheduleRasterLive, commitRasterLive,
  commitFocusedVectorize, autoSuggestTrace,
  startRasterOpLive, endRasterOpLive, scheduleRasterOpLive, commitRasterOpLive,
} from "./ui/processor.js";
import { openColorPicker, activeColorPicker, configureColorPicker } from "./ui/colorpicker.js";
import { configurePlatform } from "./ui/platform.js";
import { CLOUD } from "./ui/env.js";
import { cloudFontCatalog, cloudLoadFont, cloudInstalledFonts } from "./ui/cloud-fonts.js";
import {
  configureWidgets, fieldRow, sectionTitle, fmtBytes,
  makeSelect, makeSelectRaw, makeNumberRaw, makeRange, makeNumber,
} from "./ui/widgets.js";
import {
  configureMenus, openMenuEl, ctxMenuEl, openMenu, closeMenus,
  hideContextMenu, showContextMenu, showRichContextMenu,
} from "./ui/menus.js";
import {
  configureExport, inlineSvgImages, serializeForSave, openExportModal, setSaveByteCap,
} from "./ui/export.js";
import {
  configureModal, floatingInput, openModal, closeModal, confirmDialog,
} from "./ui/modal.js";
import {
  configureSettings, openAppSettings, openToolsSettings, loadVersion, versionInfo,
  appSettingsOpen, setAppSettingsOpen, setPwaInstallPrompt,
} from "./ui/settings.js";
import {
  workItems, outputs, projects, selectedName, selectedOutput, manualOutputName,
  setWorkItems, setOutputs, setProjects, setSelectedName, setSelectedOutput, setManualOutputName,
} from "./ui/docstate.js";
import {
  configureDocIO, mountStageFromText, mountBlankCanvas, newBlankDoc, loadSvgToStage,
  openOpenModal, placeFromUrl, openPlaceModal, saveDocument, defaultSaveName,
  saveAsDocument, saveProject, openProject, loadProjects, exportFlow,
} from "./ui/docio.js";
import { configureShortcuts, openShortcutsModal } from "./ui/shortcuts.js";
import {
  configureGallery, renderGalleryGrid, loadRasterToCanvas, loadFileToCanvas, canvasIsEmpty,
  copyToClipboard, downloadBlob, downloadUrl, revealInFileManager,
  copySvgSource, downloadCurrentSvg, openFromFile, revealCurrentFile,
} from "./ui/gallery.js";
import {
  configureViewport, viewports, cycleBg, measureFit, drawRulers,
  applyViewportState, mountViewport, clearViewport, bindRulerGuides,
  zoomVp, fitVp, actualVp, frameRect, bindViewportDragging, bindViewportZoom,
} from "./ui/viewport.js";
import {
  configureDataSync, workspace, refreshAll, refreshExceptCanvas, loadOutputs, uploadFiles,
  latestOutputsFor, itemIsProcessed, renderPreviews, refreshLibrary,
  applyStatusData, fetchStatus, applyOutputsData, fetchOutputs,
} from "./ui/datasync.js";
import {
  configureInfo, openInfoModal, openVectorInfoModal, openProjectInfo, infoForCurrentContext,
} from "./ui/info.js";
import { configureLibrary, renderLibrary, libraryMode } from "./ui/library.js";

// One-shot panel-layout self-heal. A corrupted persisted dock layout (a panel
// floated/grouped/stranded in a state that swallows clicks) survives reload AND a
// code revert — it lives in localStorage, not in the code — so the only cure is to
// clear it. Gated on a marker so this fires exactly ONCE per bump: it never wipes a
// layout the user later arranges on purpose. Bump LAYOUT_HEAL_MARK to force another
// clean reset for everyone after a layout regression. Images/projects live on the
// server and are untouched; only panel POSITIONS reset to the default dock.
const LAYOUT_HEAL_MARK = "2026-06-05";
try {
  if (localStorage.getItem("hector-vector:layout-heal") !== LAYOUT_HEAL_MARK) {
    ["hector-vector:docks", "hector-vector:dock-groups", "hector-vector:layout",
     "hector-vector:layout-active", "hector-vector:sides-folded", "hector-vector:dock-w"]
      .forEach((k) => localStorage.removeItem(k));
    localStorage.setItem("hector-vector:layout-heal", LAYOUT_HEAL_MARK);
  }
} catch {}

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
  pipeline_order: "dejpeg,denoise,deblur,upscale,removebg,vectorize",   // visual block order (persisted); flow stays canonical
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
      editor.pinned = false; setSelectedName(d.sel); setManualOutputName(d.manual || null);
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

let statusHoldUntil = 0;
// library view state (libraryMode/sort/selection) now lives in src/ui/library.js
// (libraryMode imported below); workspace + outputsDir live in src/ui/datasync.js.

// (output viewport + background modes extracted → src/ui/viewport.js)

// api() lives in src/ui/api.js (imported above).

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

// (output resolution + fetch/apply/refresh data-sync layer extracted → src/ui/datasync.js)

// Modal shell (src/ui/modal.js): inject the #modal-root elements + the close hook that
// drops the settings-open flag on every dismissal path (appSettingsOpen is declared
// further down; the closure only runs post-boot when a modal actually closes).
configureModal({ modalRootEl, modalTitleEl, modalBodyEl, modalSearchEl, onAnyClose: () => setAppSettingsOpen(false) });
// Output viewport (src/ui/viewport.js): owns the `viewports` state + bg modes + all
// fit/zoom/pan/ruler mechanics. Only seam it needs is setStatus (the bg-cycle toast).
configureViewport({ setStatus });
// Data-sync layer (src/ui/datasync.js): the fetch→apply→refresh chain + output
// resolution. State is in docstate/jobs/viewport (imported there); inject the
// library/processor/dock render seams + the job-output path helpers + the active
// process kind (all hoisted fns / top consts here).
configureDataSync({
  setStatus, outputLabelEl, rememberLastDoc, renderLibrary, renderProcessorPanel, syncDockContext,
  stem, jobOutputUrl, jobOutputName, jobOutputFolder, jobOutputKind, chooseFinalOutput, effectiveProcessKind,
});
// Jobs state + poll layer live in src/ui/jobs.js (jobsCache, activityState,
// TERMINAL_STATES imported above as live bindings). Wire its UI seams once.
configureJobs({ setStatus, renderJobsPanel, revealPanel, canReplaceStatus });
// Colour picker lives in src/ui/colorpicker.js; inject the two shell helpers it needs
// (both are hoisted top-level fns, so they're in scope at module-eval time).
configureColorPicker({ floatingInput, showContextMenu });
// Platform adapters for the editor's server-touching features (fonts, text→outlines). Desktop
// routes them through the Python backend; the cloud build has no backend, so it gets stub
// adapters until the real client ones land (C4 fonts-from-CDN, C5 WASM/degraded shaping). The
// editor code is identical either way — it only ever calls platform.*.
configurePlatform(CLOUD ? {
  // Cloud: fonts from the Google Fonts CSS2 API directly (no backend), text→outlines still deferred.
  fontCatalog: cloudFontCatalog,
  installedFonts: cloudInstalledFonts,
  loadFont: cloudLoadFont,
  textOutline: async () => { throw new Error("Text → outlines is coming to the cloud editor soon — for now, use the desktop app."); },
} : {
  fontCatalog: (qs) => api(`/api/fonts/catalog?${qs}`),
  loadFont: (spec) => api("/api/fonts/load", "POST", spec),
  installedFonts: () => api("/api/fonts/installed"),
  textOutline: (payload) => api("/api/text-outline", "POST", payload),
});
// Form primitives (src/ui/widgets.js): inject the live settings object (assigned once
// at boot, mutated in place) + persistSettings so makeSelect/makeRange/makeNumber bind.
configureWidgets({ settings, persistSettings });
// General Settings modal (src/ui/settings.js): inject the modal/status seams, prefs +
// persistPrefs, a workspace getter (reassigned on refresh), and the data-sync fns it
// calls. It owns appSettingsOpen/pwaInstallPrompt/versionInfo (imported as live bindings).
configureSettings({
  setStatus, openModal, closeModal, modalSearchEl, modalBodyEl,
  prefs, persistPrefs, getWorkspace: () => workspace,
  refreshAll, fetchStatus, applyStatusData,
});
// Gallery grid + file actions (src/ui/gallery.js): state is in docstate; inject the
// status/modal/viewport seams + the doc-loaders it leans on (mountBlankCanvas/
// mountStageFromText from docio, defaultSaveName, rememberLastDoc).
configureGallery({
  setStatus, modalBodyEl, mountBlankCanvas, mountStageFromText, rememberLastDoc, defaultSaveName,
});
// Document menu actions (src/ui/docio.js): state is in docstate; inject the library +
// status seams it calls into (viewport seams it imports straight from viewport.js).
configureDocIO({
  setStatus, outputLabelEl, modalSearchEl, modalBodyEl,
  rememberLastDoc, stem, stem_, refreshLibrary, refreshAll, renderLibrary,
});
// Keyboard-shortcuts modal (src/ui/shortcuts.js): inject the modal content elements.
configureShortcuts({ modalSearchEl, modalBodyEl });
// Item Info panels (src/ui/info.js): calls into docio/gallery/datasync (imported there);
// inject setStatus + a libraryMode getter (it drives the empty-context fallback).
configureInfo({ setStatus, getLibraryMode: () => libraryMode });
// Library dock panel (src/ui/library.js): owns its view state, reads docstate + datasync,
// calls into info/docio (imported there); inject the processor/dock/overflow seams.
configureLibrary({ renderProcessorPanel, syncDockContext, observeOverflow });

function stem_(n) { return n.replace(/\.[^.]+$/, ""); }

// updateFooterProgress / fetchJobs / loadJobs / applyJobsData live in
// src/ui/jobs.js; refreshAll / refreshExceptCanvas / fetch* / apply* live in
// src/ui/datasync.js (both imported above).

Object.values(viewports).forEach(bindViewportDragging);
Object.values(viewports).forEach(bindViewportZoom);

document.querySelectorAll("[data-vp]").forEach((button) => {
  button.addEventListener("click", () => {
    const vpName = button.dataset.vp;
    const vp = viewports[vpName];
    const action = button.dataset.action;
    if (action === "bg") { cycleBg(vpName); return; }
    // Route through the shared helpers so the buttons honour the same 0.02–40 clamp
    // as keyboard/wheel zoom (a held + button used to drive scale arbitrarily high).
    if (action === "zoom-in") zoomVp(vp, 1.2);
    else if (action === "zoom-out") zoomVp(vp, 1 / 1.2);
    else if (action === "fit") fitVp(vp);
    else if (action === "actual") actualVp(vp);
  });
});

// (modal shell + floatingInput extracted → src/ui/modal.js)

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


// (gallery grid + file actions extracted → src/ui/gallery.js)

// (document menu actions extracted → src/ui/docio.js)

// (general Settings modal extracted → src/ui/settings.js)

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
    // Cloud build: no server/Library — file ops are browser-native (open a file, download the
    // .svg, export PNG). openFromFile + downloadCurrentSvg are already fully client-side.
    if (CLOUD) return [
      { label: "New blank canvas…", onClick: newBlankDoc },
      { type: "sep" },
      { label: "Open (.svg)…", onClick: openFromFile },
      { label: "Download (.svg)", onClick: downloadCurrentSvg },
      { type: "sep" },
      { label: "Export PNG…", onClick: exportFlow },
      { label: "Copy SVG markup", onClick: copySvgSource },
    ];
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
// Menus live in src/ui/menus.js; inject setStatus (error toasts) + the header menu map
// now that MENU_ITEMS is defined. The eval-time trigger/dismissal wiring stays below.
configureMenus({ setStatus, menuItems: MENU_ITEMS });
// Serialize/export engine (src/ui/export.js): inject modal + status + refresh seams,
// plus a getter/setter pair for the shared doc-selection state it reads/writes.
configureExport({
  setStatus, confirmDialog, openModal, closeModal,
  modalBodyEl, modalSearchEl, modalTitleEl,
  defaultSaveName, downloadBlob, refreshAll,
  getSelectedOutput: () => selectedOutput, setManualOutputName,
});

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
  // Gradient apply path (Epic G): the picker hands back a full spec; coalesce like a colour edit.
  const colApplyGradient = (w, spec) => { if (!coalescing) { editor.beginCoalesce(); coalescing = true; } editor.applyPaint(w, { kind: "gradient", spec }); active = w; refreshSwatches(); scheduleColorCommit(); };
  const curPaint = (which) => { const n = firstSel(); return n ? editor.paintOf(n, which) : null; };
  // Build the live editor into a host element (the Colour panel body). Reused on each
  // selection change (the docks module gates rebuilds to actual selection-set changes).
  const colApplyBg = (hex) => { if (!coalescing) { editor.beginCoalesce(); coalescing = true; } editor.applyArtboardBg(hex); scheduleColorCommit(); };
  editor._renderColorPanel = (hostEl) => {
    if (colorCtl) { colorCtl.destroy(); colorCtl = null; }
    const sect = hostEl.closest && hostEl.closest(".rail-section");
    const ftitle = sect && sect.querySelector(".fp-title");
    // Recolor mode (Epic C): a swatch in the inspector's Recolor group routes here instead of
    // popping a modal — a solo picker that live-remaps one harvested colour across the selection.
    if (editor._recolorTarget) {
      const { hex, targets } = editor._recolorTarget;
      if (ftitle) ftitle.textContent = "Recolor";
      hostEl.innerHTML = "";
      const bar = document.createElement("div"); bar.className = "cp-recolor-bar";
      const done = document.createElement("button"); done.type = "button"; done.className = "ghost-button cp-recolor-done"; done.textContent = "‹ Done";
      done.addEventListener("click", () => { editor._recolorTarget = null; editor._renderColorPanel(hostEl); });
      const lab = document.createElement("span"); lab.className = "cp-recolor-lab"; lab.textContent = "Remapping " + hex;
      bar.append(done, lab); hostEl.appendChild(bar);
      const pickerHost = document.createElement("div"); pickerHost.className = "cp-recolor-host"; hostEl.appendChild(pickerHost);
      colorCtl = openColorPicker({ title: "Recolor", host: pickerHost, color: hex, allowNone: false,
        onChange: (h) => editor.recolorApply(targets, h || hex) });
      return;
    }
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
        fill: { color: cur("fill"), alpha: curAlpha("fill"), paint: curPaint("fill") },
        stroke: { color: cur("stroke"), alpha: curAlpha("stroke"), paint: curPaint("stroke") },
        apply: colApply,
        applyGradient: colApplyGradient,   // enables the picker's gradient editor (objects only)
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
    if (t === "input" || t === "textarea" || t === "select" || e.target?.isContentEditable || !modalRootEl.hidden || activeColorPicker) return;
    if (e.key === "X" || e.key === "x") { e.preventDefault(); if (e.shiftKey) doSwap(); else { active = active === "fill" ? "stroke" : "fill"; refreshSwatches(); if (colorCtl) colorCtl.switchTo(active); } }
    else if (e.key === "d" || e.key === "D") { e.preventDefault(); setDefault(); }
    else if (e.key === "/") { e.preventDefault(); setNone(); }
  });
  editor.onInspect = refreshSwatches;   // editor pings this on every selection/structure change
  editor.pickColor = openColorPicker;   // single-target callers (artboard bg, object rows) reuse the same modal
  editor.pickPaint = pickFor;           // duo fill/stroke picker (the "main" colour picker + X)
  editor.openContextPanel = showContextPanel;   // layers-row right-click → same object panel as the canvas
  editor.showMenu = showContextMenu;            // inspector "Actions ▾" menu (object commands)
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
// ---- Raster processing engine (live-preview state machines + schema/data layer)
//      lives in src/ui/processor.js. View builders below drive it via its exports.
configureProcessor({ setStatus, settings, persistSettings, makeRange, makeNumber, makeSelect, fieldRow });

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
// ---- intent-first stage controls (#49) -------------------------------------------------
// Each stage card leads with an OUTCOME picker (what you want); the router resolves the best
// available model, shown as an Auto badge. The raw model/engine selector + params demote into
// a collapsed Advanced. Stage id → capability id; the three real stages map onto the registry.
const STAGE_TO_CAP = { upscale: "upscale", removebg: "cutout", vectorize: "vectorize" };
const INTENT_LABEL = {
  // cutout
  general: "General subject", product: "Product / e-commerce", portrait: "Portrait / hair",
  "high-res": "High-resolution detail", hair: "Hair / fine detail", fast: "Fast (no AI)", greenscreen: "Green screen",
  // upscale
  photo: "Photo", clean: "Clean / illustration", anime: "Anime / line-art",
  detail: "Max detail", lite: "Fast / lightweight", gan: "GAN / creative",
  // vectorize
  "logo-flat": "Flat logo", "colour-photo": "Colour / photo", "bw-silhouette": "B&W silhouette", "pixel-art": "Pixel-art",
};
// A few outcomes share one model but differ by a setting the registry's `invoke` doesn't carry
// (the analyzer's plan() sets these contextually). Encode that thin sugar here so picking the
// outcome is correct AND so the current outcome can be inferred back from settings.
const INTENT_PARAMS = {
  "bw-silhouette": { trace_colormode: "bw" },
  "colour-photo": { trace_colormode: "color", trace_color_style: "photo" },
};
// Best available model serving an intent (models are ordered best-first server-side, so this
// mirrors resolve_intent: prefer installed, else the first that serves it so we can offer install).
function resolveIntentClient(cap, intent) {
  const serving = (cap.models || []).filter((m) => (m.intents || []).includes(intent));
  if (!serving.length) return null;
  return serving.find((m) => m.available) || serving[0];
}
// Does the model's `invoke` (+ any INTENT_PARAMS) match the live settings? `engine` resolves
// through currentEngineId (it isn't stored as settings.engine directly for legacy configs).
function intentMatchesSettings(cap, intent) {
  const m = resolveIntentClient(cap, intent);
  if (!m) return false;
  const inv = m.invoke || {};
  const invOk = Object.entries(inv).every(([k, v]) =>
    k === "engine" ? currentEngineId() === v : String(settings[k] ?? "") === String(v));
  if (!invOk) return false;
  const extra = INTENT_PARAMS[intent];
  return !extra || Object.entries(extra).every(([k, v]) => String(settings[k] ?? "") === String(v));
}
// The outcome currently in effect, inferred from settings so it stays coherent with Advanced
// overrides. An explicit pick wins while it still matches (disambiguates shared-model intents
// like product vs general); else first matching intent; else null (a custom config).
function currentIntentFor(cap) {
  const pick = settings["intent_" + cap.id];
  if (pick && (cap.intents || []).includes(pick) && intentMatchesSettings(cap, pick)) return pick;
  for (const it of cap.intents || []) if (intentMatchesSettings(cap, it)) return it;
  return null;
}
// Apply an outcome: drop the resolved model's invoke (+ sugar) onto settings (engine via
// setEngine so the legacy fields stay coherent), and remember the pick.
function applyIntent(cap, intent) {
  const m = resolveIntentClient(cap, intent);
  if (!m) return;
  const inv = m.invoke || {};
  if (inv.engine) setEngine(inv.engine);
  for (const [k, v] of Object.entries(inv)) if (k !== "engine") settings[k] = v;
  const extra = INTENT_PARAMS[intent];
  if (extra) for (const [k, v] of Object.entries(extra)) settings[k] = v;
  settings["intent_" + cap.id] = intent;
  persistSettings();
}
// The Outcome picker + Auto badge that leads every stage card. Routes a not-installed pick to
// Settings. Returns false if caps aren't loaded yet (caller bails to a Loading state).
function buildIntentPicker(body, capId, rerender) {
  const cap = capById(capId);
  if (!cap) {
    // Not loaded yet → kick a ONE-SHOT load and re-render when it lands. Once we've
    // tried and the cap still isn't there (a server too old to expose /api/capabilities,
    // say), do NOT reschedule — rescheduling on every render is exactly what spun the
    // panel into an infinite rebuild loop that swallowed every click. Show a static hint
    // instead so the stage is still usable via Advanced.
    if (!capsTried && !capsBusy) { ensureCapsInfo().then(rerender); }
    else if (capsTried) {
      const h = document.createElement("div"); h.className = "form-hint";
      h.textContent = "Model registry unavailable — restart the server if this persists. Set the model in Advanced.";
      body.appendChild(h);
    }
    return false;
  }
  const cur = currentIntentFor(cap);
  const opts = (cap.intents || []).map((it) => [it, INTENT_LABEL[it] || it]);
  if (!cur) opts.unshift(["__custom__", "Custom"]);
  const sel = makeSelectRaw(cur || "__custom__", opts, (val) => {
    if (val === "__custom__") return;
    applyIntent(cap, val); rerender();
  });
  body.appendChild(fieldRow("Outcome", sel, "What you want — the model is picked for you."));
  const resolved = cur ? resolveIntentClient(cap, cur) : null;
  const badge = document.createElement("div"); badge.className = "intent-auto";
  if (resolved) {
    const tag = document.createElement("span"); tag.className = "intent-auto-tag"; tag.textContent = "Auto";
    const name = document.createElement("span"); name.className = "intent-auto-model"; name.textContent = resolved.label || resolved.id;
    badge.appendChild(tag); badge.appendChild(name);
    if (resolved.available === false) {
      const need = document.createElement("button"); need.type = "button"; need.className = "intent-auto-need";
      need.textContent = resolved.size_mb ? `needs install · ${resolved.size_mb}MB ⚙` : "needs install ⚙";
      need.title = "Install in Settings";
      need.addEventListener("click", () => openToolsSettings());
      badge.appendChild(need);
    }
  } else {
    badge.classList.add("muted"); badge.textContent = "Custom — set the model + params in Advanced.";
  }
  body.appendChild(badge);
  return true;
}
// A collapsed "Advanced" section under the Outcome picker (model override + the schema). The
// open state persists per capability; the header click rerenders the host panel.
function advancedSection(body, capId, rerender, fill) {
  const open = !!settings["adv_" + capId];
  const head = document.createElement("button"); head.type = "button"; head.className = "stage-adv-toggle";
  head.textContent = (open ? "▾ " : "▸ ") + "Advanced";
  head.addEventListener("click", () => { settings["adv_" + capId] = !open; persistSettings(); rerender(); });
  body.appendChild(head);
  if (open) { const det = document.createElement("div"); det.className = "stage-adv form"; fill(det); body.appendChild(det); }
}

// A raster-op stage (upscale / remove-bg): Outcome picker → Auto model, Advanced (model +
// params), then a live preview that swaps the canvas image to the result (Keep / Revert).
function renderRasterOpStage(body, opId, node, rerender = rasterReRender) {
  if (!rasterOpSchemas) {
    const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Loading…";
    body.appendChild(h); ensureRasterOpSchemas().then(rerender); return;
  }
  const op = rasterOpById(opId); if (!op) return;
  const live = rasterOp && rasterOpName === opId;
  const liveKick = () => { if (rasterOp && rasterOpName === opId) scheduleRasterOpLive(false); };
  // Outcome-first: pick what you want, the model is resolved + applied. The raw method/model
  // selector and tuning params live in Advanced (they read/write the same settings keys, so
  // the picker and the override stay in sync).
  if (STAGE_TO_CAP[opId]) buildIntentPicker(body, STAGE_TO_CAP[opId], rerender);
  advancedSection(body, STAGE_TO_CAP[opId] || opId, rerender, (det) => {
    const whenKeys = new Set();
    for (const p of op.schema) if (p.when) Object.keys(p.when).forEach((kk) => whenKeys.add(kk));
    for (const p of op.schema) { if (!schemaWhenOk(p)) continue; det.appendChild(schemaControl(p, whenKeys, liveKick, rerender)); }
    // AI cutout needs rembg — point at the one install hub (Settings), don't install inline.
    if (opId === "removebg" && settings.removebg_method === "ai" && !op.rembg_installed) {
      det.appendChild(toolSetupNote("AI cutout needs rembg (~500MB).", "Install rembg in Settings"));
    }
  });
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
  const engUnavailable = !!(eng && eng.available === false);

  // Outcome-first: pick what you want; the engine is resolved + applied. The engine override,
  // auto-detect, and the trace params live in Advanced (same settings keys → stays in sync).
  buildIntentPicker(body, "vectorize", rerender);
  advancedSection(body, "vectorize", rerender, (det) => {
    const engSel = makeSelectRaw(engId,
      engineSchemas.map((e) => [e.id, e.available === false ? `${e.label} (unavailable)` : e.label]),
      (val) => { const t = engineSchemas.find((e) => e.id === val); if (t && t.available === false) return; setEngine(val); structural(); });
    det.appendChild(fieldRow("Engine", engSel, eng && eng.caps && eng.caps.planar ? "Planar — keeps holes/counters, no halos." : undefined));
    // Selected engine's tool is missing → route to Settings (its params/preview are moot until
    // installed). The selector above still lets you switch to an available engine.
    if (engUnavailable) {
      const tool = (eng.caps && eng.caps.needs && eng.caps.needs.includes("vtracer")) ? "VTracer" : "the required tool";
      det.appendChild(toolSetupNote(`The “${eng.label}” engine needs ${tool}.`, `Install ${tool} in Settings`));
      return;
    }
    const autoRow = document.createElement("div"); autoRow.className = "rt-actions";
    const auto = document.createElement("button");
    auto.type = "button"; auto.className = "ghost-button"; auto.textContent = "✨ Auto-detect settings";
    auto.title = node ? "Inspect the image and pick sensible vectorize settings" : "Select a raster to auto-detect";
    auto.disabled = rasterStageBusy || !node;
    auto.addEventListener("click", () => autoSuggestTrace(node));
    autoRow.appendChild(auto); det.appendChild(autoRow);

    const schema = (eng && eng.schema) || [];
    const whenKeys = new Set();
    for (const p of schema) if (p.when) Object.keys(p.when).forEach((kk) => whenKeys.add(kk));
    const advanced = [];
    for (const p of schema) {
      if (!schemaWhenOk(p)) continue;
      if (p.advanced) { advanced.push(p); continue; }
      det.appendChild(schemaControl(p, whenKeys, liveKick, structural));
    }
    if (advanced.length) {
      const advToggle = document.createElement("input");
      advToggle.type = "checkbox"; advToggle.checked = !!settings.trace_advanced;
      advToggle.addEventListener("change", () => { settings.trace_advanced = advToggle.checked; persistSettings(); structural(); });
      det.appendChild(fieldRow("More", advToggle));
      if (settings.trace_advanced) for (const p of advanced) if (schemaWhenOk(p)) det.appendChild(schemaControl(p, whenKeys, liveKick, structural));
    }
  });
  if (engUnavailable) return;   // no live preview on an engine that isn't installed
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
const RESTORE_STAGE_INFO = {
  dejpeg: { model: "FBCNN", why: "Auto-suggested when the analyzer detects JPEG blocking." },
  denoise: { model: "SCUNet", why: "Auto-suggested when the analyzer detects sensor noise." },
  deblur: { model: "NAFNet", why: "Offered when the image looks soft / out of focus." },
};
function renderStageSettings(body, id, node, rerender = rasterReRender) {
  if (id === "vectorize") { renderVectorizeStage(body, node, rerender); return; }
  const info = RESTORE_STAGE_INFO[id];
  if (info) {   // restoration stages: fixed model, no params — just explain what they do
    const p = document.createElement("p"); p.className = "stage-restore-note";
    p.textContent = `Restoration via ${info.model} (spandrel). ${info.why} Runs before upscale.`;
    body.appendChild(p);
    return;
  }
  renderRasterOpStage(body, id, node, rerender);
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
  wire("#act-paste", () => pasteCommand());
  wire("#act-duplicate", () => editor.duplicate());
  wire("#act-union", () => editor.booleanOp("union"));
  wire("#act-subtract", () => editor.booleanOp("subtract"));
  wire("#act-intersect", () => editor.booleanOp("intersect"));
  wire("#act-clip", () => {
    const s = editor.selectedNodes();
    const masked = s.length === 1 && (editor._clipGroupOf(s[0]) === s[0] || editor._maskGroupOf(s[0]) === s[0]);
    if (masked) editor.releaseMask(); else editor.makeClipMask();
  });
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
    // Clip: release when a single clipped/masked group is selected (button flips to ↺ / "Release"),
    // else make-clip when ≥2 objects are selected with a vector on top.
    const clipGroup = hasSel && n === 1 && (editor._clipGroupOf(sel[0]) === sel[0] || editor._maskGroupOf(sel[0]) === sel[0]);
    const canMakeClip = editor._topSelection(sel).filter((s) => s.hasAttribute && s.hasAttribute("data-hv-id")).length >= 2;
    const clipBtn = document.querySelector("#act-clip");
    if (clipBtn) {
      clipBtn.disabled = !(clipGroup || canMakeClip);
      clipBtn.textContent = clipGroup ? "↺" : "⛶";
      clipBtn.title = clipGroup ? "Release mask (Ctrl/Cmd+Alt+7)" : "Make clipping mask (Ctrl/Cmd+7) — top object clips the rest";
    }
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
  // ---- Customizable picture-frame layout (extracted → src/ui/layout.js) ----
  layoutCtl = createLayoutCustomize({ appEl, editor, setStatus, floatingInput, showRichContextMenu, MENU_ITEMS });
  window.__layout = layoutCtl;
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
  // ---- Dockable panels + collapse carets + shelf + bezel groups (extracted → src/ui/docks.js) ----
  window.__docks = createDocks({ editor, measureFit, viewports, renderProcessorPanel, renderLibrary, renderJobsPanel, processorRelevant, cycleBg });

  // ---- Manage screen: A/Bs with the workbench; borrows Library/Processor/Jobs into a
  //      roomy grid (extracted → src/ui/manage.js). ----
  // Manage borrows the Library/Processor/Jobs panels into a browse+batch grid — all server-only,
  // so there's nothing to manage in the cloud build.
  window.__manage = CLOUD ? null : createManage({ docks: window.__docks, measureFit, viewports });
  window.__fonts = fonts;   // text inspector's font browser + save-embed/export hooks
  fonts.hydrateInstalled();   // re-register cached fonts after a reload (Installed list + save-embed)

  // ---- Keep-alive: let the server self-spin-down when this window closes ----
  // The server is the program's compute half; while a window is open it should
  // stay up, and once the window closes it should GC + exit (no lingering stale
  // server for the next launch to reuse). We ping on a timer; closing the window
  // stops the pings and the server's watchdog takes it down after a grace window.
  // Any normal request also counts as a beat, so this is just the idle backstop.
  if (!CLOUD) setInterval(() => { fetch("/api/heartbeat", { cache: "no-store" }).catch(() => {}); }, 15000);

  // ---- PWA install (surfaced as a File-menu item; one-click path to WCO) ----
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Self-heal: the current sw.js is passthrough (never caches), but an EARLIER caching service
    // worker could still be serving stale style.css/JS from Cache Storage and survive a reload —
    // wipe any leftover caches so the live server's no-store assets always win. Harmless when empty.
    if (window.caches && caches.keys) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); setPwaInstallPrompt(e); if (appSettingsOpen) openAppSettings(); });
  window.addEventListener("appinstalled", () => { setPwaInstallPrompt(null); if (appSettingsOpen) openAppSettings(); });

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
  if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); if (modalRootEl.hidden) { if (CLOUD) downloadCurrentSvg(); else if (e.shiftKey) saveAsDocument(); else saveDocument(); } return; }
  if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) editor.redoAction(); else editor.undo(); return; }
  if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); editor.redoAction(); return; }
  if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); if (e.shiftKey) editor.transformAgain(); else editor.duplicate(); return; }   // Ctrl/Cmd+D duplicate · +Shift Transform Again (Illustrator's Ctrl+D, kept off Duplicate)
  if (mod && (e.key === "g" || e.key === "G")) { e.preventDefault(); if (e.shiftKey) editor.ungroup(); else editor.group(); return; }
  if (mod && e.key === "7") { e.preventDefault(); if (e.altKey) editor.releaseMask(); else editor.makeClipMask(); return; }   // Ctrl/Cmd+7 make clip · +Alt release (Illustrator parity)
  if (mod && e.altKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); editor.makeBlend(); return; }   // Ctrl/Cmd+Alt+B — Make Blend (Illustrator parity)
  if (e.key === "F8") { e.preventDefault(); editor.makeSymbol(); return; }   // F8 — New Symbol (Illustrator parity)
  if (mod && (e.key === "j" || e.key === "J")) { e.preventDefault(); editor.joinNodes(); return; }
  if (mod && e.key === "]") { e.preventDefault(); editor.reorder(e.shiftKey ? "front" : "forward"); return; }
  if (mod && e.key === "[") { e.preventDefault(); editor.reorder(e.shiftKey ? "back" : "backward"); return; }
  if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); editor.copy(); return; }
  if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); editor.cut(); return; }
  // Don't preventDefault: let the browser fire its native `paste` event so the document-level
  // paste handler can route OS-clipboard images/vectors (and fall back to the in-editor clipboard).
  // The bare return stops Ctrl+V from falling through to the plain-"v" select-tool shortcut below.
  if (mod && (e.key === "v" || e.key === "V")) { return; }
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
  // Shift-modified tool shortcuts (Epic B path tools) — checked BEFORE the plain-letter
  // tools below so Shift+E/Shift+C don't fall through to ellipse/curvature.
  if (e.shiftKey && e.key === "M") { editor.setTool("shapebuilder"); return; }   // Shift+M (Illustrator parity)
  if (e.shiftKey && e.key === "E") { editor.setTool("eraser"); return; }         // Shift+E
  if (e.shiftKey && e.key === "C") { editor.setTool("scissors"); return; }       // Shift+C
  if (e.shiftKey && e.key === "K") { editor.setTool("knife"); return; }          // Shift+K
  if (editor.tool === "eraser" && (e.key === "[" || e.key === "]")) { e.preventDefault(); editor.adjustEraser(e.key === "]" ? 3 : -3); editor._showHint(); return; }
  if (e.key === "v" || e.key === "V") { editor.setTool("select"); editor.clearXform(); return; }
  if (e.key === "a" || e.key === "A") { editor.setTool("node"); return; }
  if (e.key === "p" || e.key === "P") { editor.setTool("pen"); return; }
  if (e.key === "c" || e.key === "C") { editor.setTool("curvature"); return; }
  if (e.key === "r" || e.key === "R") { editor.setTool("rect"); return; }
  if (e.key === "e" || e.key === "E") { editor.setTool("ellipse"); return; }
  if (e.key === "l" || e.key === "L") { editor.setTool("line"); return; }
  if (e.key === "t" || e.key === "T") { editor.setTool("text"); return; }
  if (e.key === "w" || e.key === "W") { editor.setTool("width"); return; }
  if (e.key === "Escape" && editor.stage) {
    if (editor._gradMode) { editor.clearGradMode(); return; }   // first Esc exits the gradient editor
    if (editor._xformMode) { editor.clearXform(); return; }     // …or scale/rotate
    if (editor.isIsolated && editor.isIsolated()) { editor.exitIsolation(); return; }   // …or isolation mode (Epic I)
    editor.selection = new Set(); editor.artboardSelected = false; editor._renderSelection(); editor._renderInspector(); editor._showHint();
  }
});


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

// Header shortcut: Shift+F opens the File menu. Kept here (not in the view/nav
// handler, which bails while a modal is open) so it stays reachable.
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
// (menu render + context-menu builders extracted → src/ui/menus.js;
// openMenuEl/ctxMenuEl live bindings + functions imported above. DOM wiring stays below.)
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
      // Right-click an object → the same context-gated Actions commands as the inspector's
      // "Actions ▾" button, plus a fallback to open the full Properties panel. Rasters (no
      // vector commands) fall straight through to Properties.
      const acts = editor._objectActions ? editor._objectActions(editor.selectedNodes()) : [];
      if (acts.length) {
        showContextMenu(e.clientX, e.clientY, [
          ...acts,
          { type: "sep" },
          { label: "Open Properties…", onClick: () => showContextPanel(e.clientX, e.clientY, "object") },
        ]);
      } else {
        showContextPanel(e.clientX, e.clientY, "object");
      }
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

// (serialize/export engine extracted → src/ui/export.js)

// Always swallow window-level drags so the browser never navigates the app away on a
// drop (a tab-dragged image/link carries text/uri-list, not Files — previously that
// fell through and the browser opened the URL, destroying the unsaved canvas).
window.addEventListener("dragover", (event) => {
  event.preventDefault();
});
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  // A library drag carries our custom type and is handled on #output-preview; never
  // treat it as a file import here (that's what duplicated dragged lib items).
  if (event.dataTransfer?.types?.includes("application/x-hv-lib")) return;
  const files = event.dataTransfer?.files;
  if (!files?.length) return;   // non-file drop: swallowed above, nothing to import
  // Route by where it landed. A drop ON the Library panel imports (that's its job).
  // Anywhere else — the canvas, the editor chrome — places raster images straight onto
  // the working canvas (mint-if-empty) so a drag isn't "eaten" into the library. Files
  // the canvas can't take as pixels (SVG/PDF/…) still import.
  const onLibrary = !!(event.target?.closest && event.target.closest(".rail-section.library"));
  const all = [...files];
  const rasters = all.filter((f) => f.type && f.type.startsWith("image/") && f.type !== "image/svg+xml");
  const others = all.filter((f) => !rasters.includes(f));
  try {
    if (onLibrary || rasters.length === 0) {
      setStatus(`Importing ${all.length} file(s)…`);
      await uploadFiles(files);
      return;
    }
    for (const f of rasters) await loadFileToCanvas(f);
    if (others.length) await uploadFiles(others);
    setStatus(`Placed ${rasters.length} image${rasters.length === 1 ? "" : "s"} on the canvas`
      + (others.length ? `, imported ${others.length} other file(s)` : ""), 2500);
  } catch (error) {
    setStatus(error.message, 4000);
  }
});
// ---------- paste from OUTSIDE the app (the OS clipboard): images + vectors ----------
// Pull the first <svg>…</svg> out of pasted markup — design tools (Figma/Illustrator/Inkscape)
// put SVG on the clipboard as text/html or text/plain. Returns "" when there's no SVG.
function _extractSvgMarkup(s) {
  if (!s) return "";
  const m = String(s).match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : "";
}
// Strip active/unsafe content from pasted SVG before it touches the document: scripts,
// foreignObject (can host HTML/JS), inline on* handlers, and javascript: links. Returns a
// serialized, sanitized <svg> string, or "" if it isn't valid SVG. Pasted markup is untrusted.
function _sanitizeSvgMarkup(text) {
  let root;
  try { root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement; } catch { return ""; }
  if (!root || root.tagName.toLowerCase() !== "svg" || root.querySelector("parsererror")) return "";
  root.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
  const scrub = (el) => {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      const val = (a.value || "").replace(/\s+/g, "").toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      else if ((name === "href" || name.endsWith(":href")) && val.startsWith("javascript:")) el.removeAttribute(a.name);
    }
    for (const c of [...el.children]) scrub(c);
  };
  scrub(root);
  return new XMLSerializer().serializeToString(root);
}
// Place pasted vector markup INTO the working canvas: merge it as a grouped object when there's
// already artwork, or open it as the document when the canvas is empty (so it sizes to the art).
async function pasteSvgIntoCanvas(rawSvg, name = "Pasted vector") {
  const svg = _sanitizeSvgMarkup(rawSvg);
  if (!svg) { setStatus("That clipboard vector couldn't be read.", 3000); return false; }
  if (canvasIsEmpty()) { mountStageFromText(svg, name); setStatus(`Pasted ${name}.`, 2200); }
  else editor.placeSvgMarkup(svg, name);
  return true;
}
// Consume real OS-clipboard content (image or vector from another app) out of a paste event's
// DataTransfer. Returns true if it handled external content; false → the caller falls back to
// the in-editor shape clipboard. All DataTransfer reads happen before the first await (the object
// is only live during the event's synchronous phase).
async function pasteExternalFromEvent(dt) {
  if (!dt) return false;
  // 1) raster image bytes (a screenshot, a copied photo) → place as an <image> on the canvas
  let file = [...(dt.files || [])].find((f) => f.type && f.type.startsWith("image/") && f.type !== "image/svg+xml");
  if (!file) { const it = [...(dt.items || [])].find((i) => i.kind === "file" && i.type.startsWith("image/") && i.type !== "image/svg+xml"); if (it) file = it.getAsFile(); }
  // 2) vector: an .svg file, an image/svg+xml item, or SVG markup inside text/html or text/plain
  const svgFile = [...(dt.files || [])].find((f) => f.type === "image/svg+xml" || /\.svg$/i.test(f.name || ""));
  const html = svgFile ? "" : (dt.getData("text/html") || "");
  const plain = svgFile ? "" : (dt.getData("text/plain") || "");
  if (file) { await loadFileToCanvas(file); return true; }
  let svg = "";
  if (svgFile) svg = await svgFile.text();
  else svg = _extractSvgMarkup(html) || _extractSvgMarkup(plain);
  if (svg) { await pasteSvgIntoCanvas(svg, "Pasted vector"); return true; }
  return false;
}
// The single paste entry point for the canvas. External image/vector wins; otherwise it falls
// back to the in-editor shape clipboard (editor.paste). Text fields and the text-edit overlay
// keep their native paste — we never hijack those.
document.addEventListener("paste", async (e) => {
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
  if (modalRootEl && !modalRootEl.hidden) return;   // a dialog is open → leave its paste alone
  e.preventDefault();
  try { if (!(await pasteExternalFromEvent(e.clipboardData))) editor.paste(); }
  catch (err) { setStatus((err && err.message) || "Paste failed.", 3000); }
});
// Menu "Paste": there's no paste event to read, so pull from the async OS clipboard (image or
// vector) when the browser allows it, falling back to the in-editor shape clipboard.
async function pasteCommand() {
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const imgType = item.types.find((ty) => ty.startsWith("image/") && ty !== "image/svg+xml");
        if (imgType) { const blob = await item.getType(imgType); await loadFileToCanvas(new File([blob], "Pasted image", { type: imgType })); return; }
        if (item.types.includes("image/svg+xml")) { await pasteSvgIntoCanvas(await (await item.getType("image/svg+xml")).text(), "Pasted vector"); return; }
        if (item.types.includes("text/html")) { const svg = _extractSvgMarkup(await (await item.getType("text/html")).text()); if (svg) { await pasteSvgIntoCanvas(svg, "Pasted vector"); return; } }
      }
    } catch { /* permission denied / nothing readable → in-editor clipboard */ }
  }
  editor.paste();
}
// Test hook (mirrors window.__fonts/__manage): exercise the sanitize + place path deterministically.
window.__paste = { extractSvg: _extractSvgMarkup, sanitize: _sanitizeSvgMarkup, svgIntoCanvas: pasteSvgIntoCanvas };

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
    // Seam (Manage → workbench): a focused "Run → canvas" delivers its result onto the
    // canvas, so cross back to Edit and let it land in front of you. A batch run is headless
    // (watch it in the Jobs panel) — stay on the Manage screen.
    if (!t.batch && window.__manage && window.__manage.isManage()) window.__manage.leave();
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
    if (returnNode && onlyStage("vectorize")) {
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
    resetFailCount();
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
  if (job.source_name) setSelectedName(job.source_name);
  setManualOutputName(rel ? jobOutputName(rel) : null);
  // A blank/opened/Save-As'd doc is pinned, and renderPreviews() bails on pinned —
  // so without this, View does nothing in the default app state. Unpin to land the output.
  editor.pinned = false;
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
  { id: "dejpeg",    key: "stage_dejpeg",    label: "De-JPEG",   note: "Remove JPEG artifacts (FBCNN)" },
  { id: "denoise",   key: "stage_denoise",   label: "Denoise",   note: "Reduce noise (SCUNet)" },
  { id: "deblur",    key: "stage_deblur",    label: "Deblur",    note: "Sharpen soft focus (NAFNet)" },
  { id: "upscale",   key: "stage_upscale",   label: "Upscale",   note: "Enlarge with Real-ESRGAN" },
  { id: "removebg",  key: "stage_removebg",  label: "Remove BG", note: "Isolate the subject" },
  { id: "vectorize", key: "stage_vectorize", label: "Vectorize", note: "Raster → SVG" },
];
const STAGE_BY_ID = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, s]));
const CANON_ORDER = PIPELINE_STAGES.map((s) => s.id);
// Per-stage body expand/collapse state (survives re-render; Vectorize open first).
const stageExpanded = { dejpeg: false, denoise: false, deblur: false, upscale: false, removebg: false, vectorize: true };

// Visual block order from settings.pipeline_order, sanitized to the known stages.
function stageOrder() {
  const want = String(settings.pipeline_order || "").split(",").map((s) => s.trim()).filter((s) => STAGE_BY_ID[s]);
  const seen = new Set(want);
  return [...want, ...CANON_ORDER.filter((id) => !seen.has(id))];
}
const stageOn = (id) => !!settings[STAGE_BY_ID[id].key];
const anyStageEnabled = () => CANON_ORDER.some(stageOn);
// True when `id` is enabled and every OTHER pipeline stage is off — used to gate the
// WYSIWYG fast path, which is only valid when nothing else would alter the raster first.
const onlyStage = (id) => stageOn(id) && CANON_ORDER.every((o) => o === id || !stageOn(o));
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
  if (stageOn("dejpeg") || stageOn("denoise") || stageOn("deblur")) return `${sourceStem}.png`;
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

// (library chin + renderLibrary + SVG-thumb cache extracted → src/ui/library.js)

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

// (library grid cells + R/V/C renderers extracted → src/ui/library.js)

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

// ---------- Auto-pipeline surface (#50): classical analysis → suggested compose ----------
// POST /api/plan for the focused raster (the deterministic, offline brain — tools/analyze.py,
// see [[auto-routing-classical-not-vlm]]) and render "here's what I'd do + why" with a one-click
// Apply that composes the stage strip to match, plus the offered (intent) steps as one-tap adds.
// The capabilities the strip can act on today map onto the three real stages; P3 caps
// (dejpeg/denoise/deblur/cleanup/face) surface as read-only "needs install" rows.
const CAP_TO_STAGE = { upscale: "upscale", cutout: "removebg", vectorize: "vectorize",
  dejpeg: "dejpeg", denoise: "denoise", deblur: "deblur" };
const CAP_LABEL = {
  upscale: "Upscale", cutout: "Remove BG", vectorize: "Vectorize", dejpeg: "De-JPEG",
  denoise: "Denoise", deblur: "Deblur", cleanup: "Cleanup", face: "Face restore",
};
let procPlan = null;          // last /api/plan response: { analysis, plan:{auto,offered,notes,summary} }
let procPlanSrcUrl = null;    // the source url procPlan was computed for (cache key)
let procPlanBusy = false;

// The image the plan acts on: the canvas raster's href, else the library selection's file url.
function procPlanSourceUrl(t) {
  if (t.batch) return null;
  if (t.node) return rasterHref(t.node);
  if (t.name) { const wi = workItems.find((i) => i.name === t.name); return wi ? wi.url : null; }
  return null;
}
// Only library/output files are analyzable by /api/plan (resolve_source_url accepts exactly
// these on disk). Skip everything else — data: URIs (import first), /assets/ UI fixtures, http(s)
// — so we never fire a request that's guaranteed to fail, and the banner stays quiet for them.
function procPlannable(url) {
  return !!url && (url.startsWith("/work-items/") || url.startsWith("/outputs/"));
}
let procPlanTimer = null;
let procPlanAbort = null;   // AbortController for the in-flight fetch (cancel-on-supersede)
let procPlanWanted;         // the source url the debounce is currently aiming at (storm guard)
// DEBOUNCED entry point (called from the rail builder). /api/plan runs a real image analysis
// server-side, so firing it on every selection would hammer the local server as the user clicks
// around — and a heavy analyze() on a big raster can starve other in-flight requests. So we wait
// for the selection to SETTLE, re-resolve the target at fire time, and fetch at most once per
// settled source. Never blocks the render; the banner fills in via refreshAutoBanner when ready.
//
// STORM GUARD: buildProcessorRail() calls this on EVERY render, and the panel can re-render
// faster than the debounce window (panel drag, live-preview ticks). Naively clearing+resetting
// the timer each time means it never elapses → the fetch never fires → the banner is wedged
// on "Reading the image…" forever (the exact stuck-read bug). So we only (re)arm the timer when
// the target source actually CHANGES; a render storm on the same source is a no-op.
function scheduleProcPlan() {
  const url = procPlanSourceUrl(processTarget());
  if (url === procPlanWanted) return;   // same source already scheduled/loaded — don't restart the debounce
  procPlanWanted = url;
  if (procPlanTimer) clearTimeout(procPlanTimer);
  procPlanTimer = setTimeout(() => { procPlanTimer = null; ensureProcPlan(processTarget()); }, 350);
}
// Fetch (or reuse) the plan for the current target, then refresh the banner. A superseded
// request is ABORTED — so a stale fetch can't resolve late and perturb an unrelated interaction
// (the source of E2E flakiness when this was fire-and-forget). We claim `procPlanSrcUrl` BEFORE
// awaiting AND keep it set on a real failure (procPlan=null) — so an unresolvable source (a
// non-library href that 400s) is cached as "analyzed, no plan" rather than refetched. Skips
// data: URLs (those must be imported to the library first).
async function ensureProcPlan(t) {
  const url = procPlanSourceUrl(t);
  if (!procPlannable(url)) {                             // data:/assets/non-library → nothing to fetch
    if (procPlanAbort) { procPlanAbort.abort(); procPlanAbort = null; }
    procPlanBusy = false; procPlan = null; procPlanSrcUrl = null; refreshAutoBanner(); return;
  }
  if (url === procPlanSrcUrl) return;                    // already analyzed/fetching this source
  if (procPlanAbort) procPlanAbort.abort();              // supersede any in-flight fetch
  const ac = new AbortController(); procPlanAbort = ac;
  procPlanBusy = true; procPlanSrcUrl = url;             // claim now → a failure won't re-loop
  let aborted = false;
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_url: url }), signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
    procPlan = data;
  } catch (e) {
    if (e && e.name === "AbortError") aborted = true;    // superseded → leave state to the new request
    else procPlan = null;                                // real failure: cache it (no refetch)
  } finally {
    if (!aborted) {
      if (procPlanAbort === ac) procPlanAbort = null;
      procPlanBusy = false;
      // Surgically swap JUST the banner — never a full renderProcessorPanel() here (that would
      // re-run the stage cards' renderStageSettings and its live-preview side effects mid-flight).
      // refreshAutoBanner self-guards on the target still matching this source.
      try { refreshAutoBanner(); } catch {}
    }
  }
}
// Replace ONLY the .proc-auto banner inside the live rail (no stage-card rebuild, no live
// preview kick), guarded so a late plan for a source the user navigated away from is ignored.
function refreshAutoBanner() {
  const host = document.querySelector("#processor-body"); if (!host) return;
  const rail = host.querySelector(".proc-rail"); if (!rail) return;
  const t = processTarget();
  if (procPlanSourceUrl(t) !== procPlanSrcUrl) return;   // target changed; this banner isn't ours
  const old = rail.querySelector(".proc-auto");
  const next = buildAutoBanner(t);
  if (old && next) old.replaceWith(next);
  else if (old) old.remove();
  else if (next) { const tgt = rail.querySelector(".proc-target"); tgt ? tgt.after(next) : rail.prepend(next); }
}
// A compact human read of the analyzer's signals, for the banner header.
function describeAnalysis(a) {
  if (!a) return "";
  const cls = { flat_graphic: "Flat graphic", line_art: "Line art", photo: "Photo", photo_gray: "Grayscale photo" }[a.content_class] || a.content_class;
  const bits = [cls, `${a.width}×${a.height}`];
  if (a.has_alpha) bits.push("has alpha");
  if (a.low_res) bits.push("low-res");
  return bits.join(" · ");
}
// One plan step row: capability + why + an availability badge, or (for an offered, mappable
// step) a one-tap "Add" that enables just that stage.
function buildPlanStepRow(s, offered) {
  const row = document.createElement("div"); row.className = "proc-plan-step";
  const cap = document.createElement("span"); cap.className = "proc-plan-cap"; cap.textContent = CAP_LABEL[s.capability] || s.capability;
  const why = document.createElement("span"); why.className = "proc-plan-why"; why.textContent = s.why || "";
  row.appendChild(cap); row.appendChild(why);
  const stage = CAP_TO_STAGE[s.capability];
  if (s.available === false) {
    const b = document.createElement("span"); b.className = "proc-plan-badge needs";
    b.textContent = (s.needs && s.needs.length) ? "needs install" : "unavailable";
    if (s.needs && s.needs.length) b.title = `Requires: ${s.needs.join(", ")}`;
    row.appendChild(b);
  } else if (offered && stage) {
    const add = document.createElement("button"); add.type = "button"; add.className = "proc-plan-add";
    add.textContent = "Add"; add.title = `Enable ${CAP_LABEL[s.capability] || s.capability}`;
    add.addEventListener("click", () => addPlanStep(s));
    row.appendChild(add);
  } else if (offered && s.capability === "face") {
    // Face restore is a one-shot op (not a pipeline stage) → run it directly on the target.
    const run = document.createElement("button"); run.type = "button"; run.className = "proc-plan-add";
    run.textContent = "Restore"; run.title = "Restore detected faces (GFPGAN)";
    run.addEventListener("click", () => restoreFaces(processTarget().node));
    row.appendChild(run);
  }
  return row;
}
// Apply one step's model/params onto the live settings (NOT the on/off toggle — callers own
// that). `invoke` is the server-authoritative executor mapping (engine / model / removebg_method
// / cutout_model); `params` are the analyzer's tuned values (colour_precision, scale, simplify).
// Engine goes through setEngine so vectorize_method + colormode/style stay coherent.
function applyStepConfig(s) {
  const inv = s.invoke || {};
  if (inv.engine) setEngine(inv.engine);
  for (const [k, v] of Object.entries(inv)) if (k !== "engine") settings[k] = v;
  if (s.params) for (const [k, v] of Object.entries(s.params)) settings[k] = v;
}
// Compose the stage strip to EXACTLY the auto plan: mapped+available stages on, the rest off,
// engine + params applied. Steps whose models aren't installed are skipped (and noted).
function applyAutoPlan(plan) {
  const auto = (plan && plan.auto) || [];
  const want = new Set();
  for (const s of auto) {
    const sid = CAP_TO_STAGE[s.capability];
    if (!sid || s.available === false) continue;
    want.add(sid);
    applyStepConfig(s);
  }
  if (!want.size) { setStatus("Those steps need models that aren’t installed yet.", 3200); return; }
  for (const st of PIPELINE_STAGES) settings[st.key] = want.has(st.id);
  persistSettings();
  procRerender();
  setStatus("Applied the suggested pipeline.", 2200);
}
// Add a single (offered) step to the current strip without disturbing the other stages.
function addPlanStep(s) {
  const sid = CAP_TO_STAGE[s.capability];
  if (!sid) return;
  applyStepConfig(s);
  settings[STAGE_BY_ID[sid].key] = true;
  persistSettings();
  procRerender();
}
// The banner: the analyzer's read + the auto chain (with Apply) + the offered intents.
// Null for batch / no-source (nothing to analyze). Shows a loading/import hint until ready.
function buildAutoBanner(t) {
  const url = procPlanSourceUrl(t);
  if (t.batch || !url) return null;
  const wrap = document.createElement("div"); wrap.className = "proc-auto";
  if (url.startsWith("data:")) {
    wrap.classList.add("muted");
    wrap.textContent = "Import this image to the library to auto-analyze it.";
    return wrap;
  }
  if (!procPlannable(url)) return null;   // an asset/non-library source the planner can't read
  // Not analyzed yet (or a different source is loading) → loading hint.
  if (procPlanSrcUrl !== url || procPlanBusy) {
    wrap.classList.add("muted");
    wrap.textContent = "Reading the image…";
    return wrap;
  }
  // Analyzed THIS source but it couldn't be planned (unresolvable href) → no banner.
  if (!procPlan) return null;
  const { analysis, plan } = procPlan;
  const head = document.createElement("div"); head.className = "proc-auto-head";
  const badge = document.createElement("span"); badge.className = "proc-auto-badge"; badge.textContent = "Auto";
  const sum = document.createElement("span"); sum.className = "proc-auto-sum"; sum.textContent = describeAnalysis(analysis);
  head.appendChild(badge); head.appendChild(sum);
  wrap.appendChild(head);

  const auto = (plan && plan.auto) || [];
  if (auto.length) {
    const steps = document.createElement("div"); steps.className = "proc-auto-steps";
    for (const s of auto) steps.appendChild(buildPlanStepRow(s, false));
    wrap.appendChild(steps);
    const apply = document.createElement("button"); apply.type = "button"; apply.className = "proc-auto-apply";
    const mappable = auto.some((s) => CAP_TO_STAGE[s.capability] && s.available !== false);
    apply.textContent = "Apply"; apply.disabled = !mappable;
    apply.title = mappable ? "Set the stage strip to match this plan" : "These steps need models that aren’t installed yet";
    apply.addEventListener("click", () => applyAutoPlan(plan));
    wrap.appendChild(apply);
  } else {
    const none = document.createElement("div"); none.className = "proc-auto-none";
    none.textContent = "Nothing needs fixing — compose a pipeline below.";
    wrap.appendChild(none);
  }

  const offered = (plan && plan.offered) || [];
  if (offered.length) {
    const off = document.createElement("div"); off.className = "proc-auto-offered";
    const lbl = document.createElement("div"); lbl.className = "proc-auto-offered-lbl"; lbl.textContent = "Also possible";
    off.appendChild(lbl);
    for (const s of offered) off.appendChild(buildPlanStepRow(s, true));
    wrap.appendChild(off);
  }
  return wrap;
}

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
// Object-removal (LaMa) cleanup: a self-contained brush-mask overlay over the on-canvas
// raster. The user paints the region to erase; Apply rasterises the strokes to a mask at the
// image's NATIVE resolution, POSTs {image, mask} to /api/cleanup, and swaps the result href in
// place (one undo step, mirroring placeJobResultOnNode). It's a modal overlay rather than an
// editor tool because painting is a different interaction model than the vector tools.
function startCleanup(node) {
  node = node || (processTarget().node);
  if (!node || !editor.isRaster(node)) { setStatus("Select a raster on the canvas to clean up.", 2800); return; }
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) { setStatus("Zoom so the image is visible, then try Remove object.", 3200); return; }

  const ov = document.createElement("div"); ov.className = "cleanup-overlay";
  const dpr = window.devicePixelRatio || 1;
  const cv = document.createElement("canvas"); cv.className = "cleanup-canvas";
  cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
  cv.style.left = rect.left + "px"; cv.style.top = rect.top + "px";
  cv.style.width = rect.width + "px"; cv.style.height = rect.height + "px";
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "rgba(255,40,40,0.5)";
  let brush = Math.max(8, Math.round(Math.min(rect.width, rect.height) / 14));
  let painting = false, last = null, painted = false;
  const at = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const dot = (p) => { ctx.lineWidth = brush; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke(); };
  cv.addEventListener("pointerdown", (e) => { painting = true; painted = true; last = at(e); dot(last); cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", (e) => { if (!painting) return; const p = at(e); ctx.lineWidth = brush; ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; });
  const stopPaint = () => { painting = false; };
  cv.addEventListener("pointerup", stopPaint); cv.addEventListener("pointercancel", stopPaint);
  ov.appendChild(cv);

  const bar = document.createElement("div"); bar.className = "cleanup-bar";
  const hint = document.createElement("span"); hint.className = "cleanup-hint"; hint.textContent = "Paint over what to erase";
  const sz = document.createElement("input"); sz.type = "range"; sz.min = "4"; sz.max = "120"; sz.value = String(brush);
  sz.title = "Brush size"; sz.addEventListener("input", () => { brush = +sz.value; });
  const teardown = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { teardown(); setStatus("Cleanup cancelled.", 1500); } };
  document.addEventListener("keydown", onKey);
  const cancel = ghostBtn("Cancel", () => { teardown(); setStatus("Cleanup cancelled.", 1500); });
  const apply = ghostBtn("Remove", async () => {
    if (!painted) { setStatus("Paint over the area to remove first.", 2500); return; }
    const nat = await rasterNaturalSize(node);   // true source resolution, not the 1×1 that mediaNaturalSize gave
    const mc = document.createElement("canvas"); mc.width = nat.w; mc.height = nat.h;
    const mx = mc.getContext("2d");
    mx.drawImage(cv, 0, 0, nat.w, nat.h);                 // scale the painted strokes to native res
    const id = mx.getImageData(0, 0, nat.w, nat.h), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const on = d[i + 3] > 10; d[i] = d[i + 1] = d[i + 2] = on ? 255 : 0; d[i + 3] = 255; }
    mx.putImageData(id, 0, 0);
    const maskUrl = mc.toDataURL("image/png");
    teardown();
    setStatus("Removing… first run downloads the LaMa model (~208MB).", 0);
    try {
      const res = await api("/api/cleanup", "POST", { input_url: rasterHref(node), mask_url: maskUrl });
      if (!node.isConnected || !editor.isRaster(node)) { setStatus("The canvas changed; cleanup result discarded.", 4000); return; }
      node.setAttribute("href", res.url);
      editor.push("Remove object");
      editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
      setStatus("Removed the painted region.", 2800);
    } catch (e) { setStatus(`Cleanup failed: ${e.message}`, 4500); }
  });
  bar.appendChild(hint); bar.appendChild(sz); bar.appendChild(cancel); bar.appendChild(apply);
  ov.appendChild(bar);
  document.body.appendChild(ov);
  setStatus("Cleanup: paint over the object, then Remove (Esc to cancel).", 0);
}

// One-shot face restoration (GFPGAN): detects faces server-side, no mask. Swaps the result
// href in one undo step, mirroring placeJobResultOnNode / the cleanup apply.
async function restoreFaces(node) {
  node = node || (processTarget().node);
  if (!node || !editor.isRaster(node)) { setStatus("Select a raster on the canvas to restore.", 2800); return; }
  setStatus("Restoring faces… first run downloads GFPGAN (~341MB).", 0);
  try {
    const res = await api("/api/face-restore", "POST", { input_url: rasterHref(node) });
    if (!node.isConnected || !editor.isRaster(node)) { setStatus("The canvas changed; result discarded.", 4000); return; }
    node.setAttribute("href", res.url);
    editor.push("Restore faces");
    editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
    setStatus("Restored faces (no change if none were found).", 3000);
  } catch (e) { setStatus(`Face restore failed: ${e.message}`, 4500); }
}

// One-shot degradation fix (#58): denoise / de-JPEG / deblur via a spandrel restoration model.
async function applyRestore(model, label, node) {
  node = node || (processTarget().node);
  if (!node || !editor.isRaster(node)) { setStatus("Select a raster on the canvas first.", 2800); return; }
  setStatus(`${label}… first run downloads the model.`, 0);
  try {
    const res = await api("/api/restore", "POST", { input_url: rasterHref(node), model });
    if (!node.isConnected || !editor.isRaster(node)) { setStatus("The canvas changed; result discarded.", 4000); return; }
    node.setAttribute("href", res.url);
    editor.push(label);
    editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
    setStatus(`${label} done.`, 2800);
  } catch (e) { setStatus(`${label} failed: ${e.message}`, 4500); }
}

function buildProcessorRail() {
  const rail = document.createElement("div"); rail.className = "proc-rail";
  const t = processTarget();

  // Target row: the focused raster (default) or the whole library (explicit batch).
  // The ▦/🖼 button on the right is the EXPLICIT batch toggle — batch is never silent.
  const tgt = document.createElement("div"); tgt.className = "proc-target" + (t.batch ? " batch" : "");
  // Make the currently-loaded image unmistakable: show its thumbnail (when a focused raster
  // resolves to a real URL), falling back to the 🖼/▦ glyph for batch / data-URL sources.
  const tgtUrl = t.batch ? null : procPlanSourceUrl(t);
  let ic;
  if (tgtUrl && !tgtUrl.startsWith("data:")) {
    ic = document.createElement("img"); ic.className = "proc-target-thumb";
    ic.src = tgtUrl + (tgtUrl.includes("?") ? "" : "?w=80"); ic.alt = ""; ic.loading = "lazy"; ic.decoding = "async";
  } else {
    ic = document.createElement("span"); ic.className = "proc-target-ic"; ic.textContent = t.batch ? "▦" : "🖼";
  }
  const nm = document.createElement("span"); nm.className = "proc-target-name"; nm.textContent = t.label;
  const swap = document.createElement("button");
  swap.type = "button"; swap.className = "proc-target-swap tool-button" + (t.batch ? " on" : "");
  swap.textContent = t.batch ? "🖼" : "▦";
  swap.title = t.batch ? "Switch to the selected raster" : "Switch to the whole library (batch)";
  swap.addEventListener("click", (e) => { e.stopPropagation(); processBatch = !processBatch; renderProcessorPanel(); syncDockContext(); });
  tgt.appendChild(ic); tgt.appendChild(nm); tgt.appendChild(swap); rail.appendChild(tgt);

  // Auto-pipeline surface: analyze the focused raster and suggest a compose. The fetch is
  // DEBOUNCED (settle the selection first; /api/plan does real server-side analysis) and the
  // banner refreshes surgically when the plan lands; here we just reflect current state.
  scheduleProcPlan();
  const banner = buildAutoBanner(t);
  if (banner) rail.appendChild(banner);

  // Object removal is interactive (paint a mask), so it's a button here, not a pipeline stage.
  if (t.node && editor.isRaster(t.node)) {
    const clean = document.createElement("button");
    clean.type = "button"; clean.className = "proc-cleanup-btn";
    clean.textContent = "🩹 Remove object…";
    clean.title = "Paint over something to erase it (LaMa cleanup)";
    clean.addEventListener("click", () => startCleanup(t.node));
    rail.appendChild(clean);

    const face = document.createElement("button");
    face.type = "button"; face.className = "proc-cleanup-btn";
    face.textContent = "✨ Restore faces";
    face.title = "GFPGAN face restoration — detects faces automatically (no change if none found)";
    face.addEventListener("click", () => restoreFaces(t.node));
    rail.appendChild(face);

    // Degradation fixers (#58): compact row — denoise / de-JPEG / deblur (spandrel restoration).
    const fixes = document.createElement("div"); fixes.className = "proc-fix-row";
    [["scunet-denoise", "Denoise"], ["fbcnn-dejpeg", "De-JPEG"], ["nafnet-deblur", "Deblur"]].forEach(([m, l]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "proc-fix-btn";
      b.textContent = l; b.title = `${l} — spandrel restoration`;
      b.addEventListener("click", () => applyRestore(m, l, t.node));
      fixes.appendChild(b);
    });
    rail.appendChild(fixes);
  }

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
// Populate the chin host (#processor-chin, itself a .processor-chin) IN PLACE — building a
// nested .processor-chin inside it doubled the ink top-border into a stray orphan line.
function fillProcessorChin(chin, t) {
  chin.innerHTML = "";
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
  const run = document.createElement("button"); run.type = "button"; run.className = "proc-run";
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
}
function renderProcessorPanel() {
  if (!pipelineConstsReady) return;   // called by renderPanels before the pipeline consts init (module eval) → no-op until ready
  const host = document.querySelector("#processor-body"); if (!host) return;
  const keepScroll = host.scrollTop;
  host.innerHTML = "";
  host.appendChild(buildProcessorRail());
  host.scrollTop = keepScroll;
  const chinHost = document.querySelector("#processor-chin");
  if (chinHost) fillProcessorChin(chinHost, processTarget());
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

// (item Info panels — raster/vector/project — extracted → src/ui/info.js)
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


// (item Info panels — wireDetailActions + raster/vector/project builders — extracted → src/ui/info.js)

// (keyboard-shortcuts modal extracted → src/ui/shortcuts.js)

shortcutButtonEl.addEventListener("click", openShortcutsModal);

// (zoom/fit/actual helpers + wheel binding extracted → src/ui/viewport.js)

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
        // Use the canonical stem() (strips @WxH + .cutout/.chromakey/.edited) on BOTH
        // sides, matching how the rest of the app matches a job to its source — stem_()
        // (extension-only) here matched inconsistently for suffixed names.
        const selStem = selectedName ? stem(selectedName) : null;
        const touchesSelection = selStem && completedNow.some(
          (j) => j.source_name && stem(j.source_name) === selStem
        );
        refreshLibrary();
        if (touchesSelection) {
          // Force fresh mount so the new artifact lands on the canvas automatically.
          setManualOutputName(null);
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
export { setStatus, api, refreshAll, viewports, measureFit, frameRect, outputPreviewEl, selectedOutput, setManualOutputName, inlineSvgImages, serializeForSave };

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
  get selectedName() { return selectedName; }, set selectedName(v) { setSelectedName(v); },
  get selectedOutput() { return selectedOutput; }, set selectedOutput(v) { setSelectedOutput(v); },
  get manualOutputName() { return manualOutputName; }, set manualOutputName(v) { setManualOutputName(v); },
  get versionInfo() { return versionInfo; },
  // Live-vectorize introspection / test harness (no network): arm the live state so a
  // control's change handler exercises the real wiring, then read the re-trace counter.
  inlineSvgImages,   // exposed for the E2E: bake <image> hrefs → data URIs (self-contained export)
  serializeForSave,  // self-contained save serializer (bake, or linked with explicit consent) — for the E2E
  setSaveByteCap,   // test seam: force/clear the save cap (now lives in ui/export.js)
  get workItems() { return workItems; },     // exposed for the E2E (library auto-load-on-run test)
  openToolsSettings,                          // deep-link to Settings → AI models & tools (install hub)
  startCleanup,                               // object-removal mask overlay (#56)
  restoreFaces,                               // one-shot GFPGAN face restoration (#57)
  applyRestore,                               // one-shot degradation fix: denoise/dejpeg/deblur (#58)
  get engineSchemas() { return engineSchemas; },
  get rasterOpSchemas() { return rasterOpSchemas; },
  get activeColorPicker() { return activeColorPicker; },   // live binding from ui/colorpicker.js (test seam)
  get rasterLiveKicks() { return rasterLiveKicks; },
  get rasterOpKicks() { return rasterOpKicks; },
  armRasterLive(id) { armLive(editor.nodeById(id)); },
  disarmRasterLive() { endRasterLive(false); },
  armRasterOp(id, op) { armOp(editor.nodeById(id), op); },
  disarmRasterOp() { endRasterOpLive(false); },
};
