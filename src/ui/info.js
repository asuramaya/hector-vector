// Item Info panels — extracted from app.js (#28, the info/library/viewport
// subsystem). Renders the dock Info panel for a raster work-item, an output
// vector, or a saved .hv project (preview + metadata + Load/Open/Rename/Download/
// Delete), plus the shared rename/delete wiring. Pure presentation over data it
// fetches (api) or reads client-side; it calls INTO docio (place/open), gallery
// (file actions), and datasync (refresh after a rename/delete). The dock + status
// + libraryMode seams are injected via configureInfo.
import { api } from "./api.js";
import { floatingInput } from "./modal.js";
import { sectionTitle, fmtBytes } from "./widgets.js";
import { copyToClipboard, downloadUrl, revealInFileManager, loadRasterToCanvas } from "./gallery.js";
import { placeFromUrl, openProject, loadProjects } from "./docio.js";
import { loadOutputs, refreshAll } from "./datasync.js";
import { selectedName } from "./docstate.js";

let setStatus, getLibraryMode;
export function configureInfo(deps) { ({ setStatus, getLibraryMode } = deps); }

// The Info panel's body is content-driven, so the shelf square remembers the LAST thing
// that was inspected and re-renders it when reopened. Falls back to the current library
// selection, then a help state. Each open*Info builder records its reopen thunk here.
let lastInfoContext = null;
export function infoForCurrentContext() {
  if (typeof lastInfoContext === "function") { lastInfoContext(); return; }
  if (selectedName && getLibraryMode() === "raster") { openInfoModal(selectedName); return; }
  const help = document.createElement("div"); help.className = "insp-empty";
  help.textContent = "Right-click an item in the Library — or an object on the canvas — to inspect it here.";
  showInfoPanel("Info", help);
}

// Shared Rename / Download / Delete wiring for the C/R/V detail modals. `cfg`:
//   kind     "raster" | "vector" | "project"  (label + endpoint selection)
//   item     the library item — re-opened after a rename so the view stays live
//   url      file URL (download source + outputs rename/remove key)
//   nameBtn  the .info-name button — anchors the floating rename input
//   reopen   (newItem) => void — re-renders the detail view after a rename
//   refresh  async () => void — reloads the relevant library list after a change
// Appends buttons via the modal's own `act(label, title, fn, primary)` builder.
export function wireDetailActions(act, cfg) {
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
    if (!armed) {            // first click arms (turns red); second confirms
      armed = true;
      btn.classList.add("danger-armed");
      btn.textContent = "‼";
      btn.title = "Click again to delete permanently";
      return;
    }
    btn.disabled = true;
    api(removeEndpoint, "POST", keyPayload)
      .then(async (res) => { await cfg.refresh(); lastInfoContext = null; hideInfoPanel(); setStatus(res.message || "Deleted.", 2500); })
      .catch((e) => { btn.disabled = false; setStatus(e.message, 3500); });
  };

  act("✎", `Rename this ${kind}`, doRename);
  act("⇩", "Download a copy", () => downloadUrl(url, item.name));
  const del = document.createElement("button");
  del.type = "button"; del.className = "tool-button danger-button"; del.textContent = "✕";
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

export async function openInfoModal(name = selectedName) {
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
export async function openVectorInfoModal(item) {
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
  const act = (label, title, fn, primary) => { const b = document.createElement("button"); b.type = "button"; b.className = "tool-button" + (primary ? " info-primary" : ""); b.textContent = label; b.title = title; b.addEventListener("click", fn); actions.appendChild(b); };
  act("⊡", "Load into canvas — place this vector in the editor viewport", () => { placeFromUrl(item.url, item.name).catch((e) => setStatus(e.message, 3000)); }, true);
  const abs = item.path || "";
  if (abs) act("⌂", "Reveal in the file manager", () => revealInFileManager(abs));
  act("↗", "Open the vector in a new tab", () => window.open(item.url, "_blank", "noopener"));
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
export function openProjectInfo(item) {
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
  const act = (label, title, fn, primary) => { const b = document.createElement("button"); b.type = "button"; b.className = "tool-button" + (primary ? " info-primary" : ""); b.textContent = label; b.title = title; b.addEventListener("click", fn); actions.appendChild(b); };
  act("⊡", "Open project — restores layers + history", () => { openProject(item); }, true);
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
    b.type = "button"; b.className = "tool-button" + (primary ? " info-primary" : "");
    b.textContent = label; b.title = title;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  act("⊡", "Load into canvas — place this image in the editor viewport", () => { loadRasterToCanvas({ name: info.name, url }); }, true);
  if (absPath) act("⌂", "Reveal in the file manager", () => revealInFileManager(absPath));
  act("↗", "Open the full image in a new tab", () => window.open(url, "_blank", "noopener"));
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
