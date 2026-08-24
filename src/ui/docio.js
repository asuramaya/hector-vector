// Document menu actions — extracted from app.js (#28, post-docstate). New / Open /
// Place / Save / Save-As / Save-project(.hv) / Export, plus mountStageFromText (the
// canvas swap-in). State lives in docstate (selectedOutput/outputs/workItems + setters);
// this module only CALLS INTO the viewport (applyBgMode/measureFit) + library
// (refreshLibrary/refreshAll/renderLibrary/renderGalleryGrid) layers, injected via
// configureDocIO — a one-directional dependency now that the shared state is detangled.
import { editor, ghostBtn } from "../editor.js";
import { api } from "./api.js";
import { openModal, closeModal } from "./modal.js";
import { sectionTitle, fieldRow, makeNumberRaw } from "./widgets.js";
import { serializeForSave, openExportModal } from "./export.js";
import { hideContextMenu } from "./menus.js";
import { renderGalleryGrid } from "./gallery.js";
import { viewports, applyBgMode, measureFit } from "./viewport.js";
import {
  selectedOutput, outputs, workItems, projects,
  setSelectedName, setSelectedOutput, setManualOutputName, setProjects,
} from "./docstate.js";

let setStatus, outputLabelEl, modalSearchEl, modalBodyEl,
    rememberLastDoc, stem, stem_, refreshLibrary, refreshAll, renderLibrary;
export function configureDocIO(deps) {
  ({ setStatus, outputLabelEl, modalSearchEl, modalBodyEl,
     rememberLastDoc, stem, stem_, refreshLibrary, refreshAll, renderLibrary } = deps);
}

// ---------- document menu actions ----------
export function mountStageFromText(text, name) {
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
  // Adopt the new document SYNCHRONOUSLY — editor.sync()/adopt() only read the DOM + rebuild
  // state (no layout needed), so editor.stage must point at the just-mounted svg the instant
  // mountStageFromText returns. Deferring it to the rAF left a window where editor.stage still
  // referenced the OLD document (e.g. code/tests reading editor.stage right after a mount saw a
  // stale stage — a lingering raster from the previous doc). Only measureFit needs layout → rAF.
  editor.sync();
  requestAnimationFrame(() => measureFit(vp));
}

// Mount a fresh white artboard with no save target (Save → Save-As).
export function mountBlankCanvas(W = 512, H = 512) {
  setSelectedOutput(null); setManualOutputName(null);
  const txt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect class="hv-artboard" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/></svg>`;
  mountStageFromText(txt, `untitled-${W}x${H}.svg`);
}

export function newBlankDoc() {
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

export async function loadSvgToStage(url, name, output = null) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    setSelectedName(null); setManualOutputName(null);
    mountStageFromText(text, name);   // pinned = true; the recompute guard then keeps selectedOutput as set below
    // A re-opened canvas file keeps its save target so Save overwrites it in place;
    // any other standalone vector opens untracked (Save → Save-As).
    setSelectedOutput(output);
    rememberLastDoc();
    setStatus(`Opened ${name}.`, 2000);
  } catch (e) { setStatus(`Open failed: ${e.message}`, 3000); }
}

export function openOpenModal() {
  const svgs = outputs.filter((o) => o.kind === "svg");
  openModal(`Open — ${svgs.length} vector(s)`);
  const items = svgs.map((o) => ({ name: o.name, url: o.url, kind: "svg", folder: o.folder, path: o.path, active: false }));
  const apply = () => {
    const q = modalSearchEl.value.trim().toLowerCase();
    const vis = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    renderGalleryGrid(vis, (picked) => {
      closeModal();
      const wi = workItems.find((w) => stem(w.name) === stem(picked.name));
      if (wi) { editor.pinned = false; setSelectedName(wi.name); setManualOutputName(picked.name); refreshLibrary(); refreshAll(); }
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

// Open a saved .hv PROJECT (canvas + full undo/redo history) — the missing counterpart to
// Save project below; before this, a project could only be reopened by finding it in the
// Library sidebar's Canvas tab and either dragging it onto the canvas or digging into its
// right-click info modal, with no File-menu path at all despite Save living right there.
// A click here opens immediately (unlike the Library grid's click-to-select — this picker's
// only job is "open one"), same one-step gesture as the vector Open modal above.
export function openOpenProjectModal() {
  const render = () => {
    openModal(`Open project — ${projects.length} saved`);
    const items = projects.map((p) => ({ name: p.name, url: p.url, icon: "⛋" }));
    const apply = () => {
      const q = modalSearchEl.value.trim().toLowerCase();
      const vis = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
      renderGalleryGrid(vis, (picked) => { closeModal(); openProject(picked); });
    };
    modalSearchEl.oninput = apply;
    apply();
  };
  // The Canvas library tab lazily loads projects on first visit — a session that never
  // opened it would otherwise show a false "0 saved" here.
  if (projects.length) render(); else loadProjects().then(render);
}

export async function placeFromUrl(url, name) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!editor.stage) mountBlankCanvas();   // auto-create rather than refuse on a stage-less editor
    editor.placeSvgMarkup(await res.text(), name);
  } catch (e) { setStatus(`Place failed: ${e.message}`, 3000); }
}

// Place / merge another vector into the current canvas (vs Open, which replaces).
export function openPlaceModal() {
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
export async function saveDocument() {
  if (!editor.stage) return;
  if (selectedOutput && selectedOutput.folder === "canvas") return saveCanvasInPlace();
  if (selectedOutput) return editor.save();
  return saveAsDocument();
}

export async function saveCanvasInPlace() {
  try {
    // Self-contained: bake raster hrefs → data URIs (the live editor keeps its server
    // hrefs — only the saved bytes are inlined; falls back to linked if too large).
    const svg = await serializeForSave(); if (!svg) return;
    const data = await api("/api/save-svg-as", "POST", { name: selectedOutput.name, svg, overwrite: true });
    applySavedCanvas(data);
    setStatus(data.message || "Saved.", 2500);
  } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
}

export function defaultSaveName() {
  const n = viewports.output.name || (selectedOutput && selectedOutput.name) || "untitled.svg";
  return stem_(n).replace(/\.edited$/, "");
}

export function saveAsDocument(onDone) {
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
export function saveProject() {
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

export async function openProject(item) {
  let data;
  try { data = await (await fetch(item.url)).json(); }
  catch (e) { setStatus(`Couldn't open ${item.name}: ${e.message}`, 3500); return; }
  if (!data || typeof data.svg !== "string" || !/<svg[\s>]/i.test(data.svg)) { setStatus("That .hv project is invalid.", 3000); return; }
  setSelectedName(null); setManualOutputName(null); setSelectedOutput(null);
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

export async function loadProjects() {
  try { setProjects(await api("/api/projects")); } catch { setProjects([]); }
  renderLibrary();
}

// A freshly Save-As'd canvas becomes a tracked-but-pinned doc: it owns a concrete
// selectedOutput (so Export + plain Save work) without being a library item, and
// stays mounted from memory (no disk remount that would drop the editor state).
export function applySavedCanvas(data) {
  editor.pinned = true;
  setSelectedName(null); setManualOutputName(null);
  setSelectedOutput({
    name: data.name, folder: data.folder,
    url: `/outputs/${encodeURIComponent(data.folder)}/${encodeURIComponent(data.name)}`,
    kind: "svg", path: data.output,
  });
  viewports.output.name = data.name;
  if (outputLabelEl) outputLabelEl.textContent = `Canvas — ${data.name}`;
  rememberLastDoc();
  refreshAll();
}

export function exportFlow() {
  // Export renders the LIVE canvas in the browser (no save/round-trip needed), so an
  // unsaved doc can export straight to a download. A save target is only needed to ALSO
  // drop the PNG in the library (offered as a secondary action in the result step).
  if (!editor.stage) { setStatus("Open or create a canvas first.", 2500); return; }
  openExportModal();
}
