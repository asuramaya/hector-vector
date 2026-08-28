// Data-sync layer — extracted from app.js (#28, the info/library/viewport
// subsystem keystone). The connective tissue between the server and the UI:
// fetch /api/status|work-items|outputs|jobs, apply each payload into docstate,
// then reconcile the library + canvas. Also owns output-resolution (which
// produced file represents a given source: latestOutputsFor / preferredOutput /
// itemIsProcessed) and the `workspace` snapshot.
//
// State it reads/writes lives in docstate (work-items/outputs/selection); jobs
// state + the stale-response sequence token come from jobs.js. Everything it
// only CALLS INTO (library render, processor panel, dock context, the job-output
// path helpers, the active-process kind) is injected via configureDataSync, so
// this stays a mostly one-directional importer.
import { editor } from "../editor.js";
import { api } from "./api.js";
import { viewports, mountViewport, clearViewport } from "./viewport.js";
import { jobsCache, TERMINAL_STATES, nextJobsSeq, fetchJobs, applyJobsData } from "./jobs.js";
import {
  outputs, manualOutputName, selectedName, selectedOutput, workItems,
  setWorkItems, setOutputs, setSelectedName, setSelectedOutput,
} from "./docstate.js";

let setStatus, outputLabelEl, rememberLastDoc, renderLibrary, renderProcessorPanel, syncDockContext,
    stem, jobOutputUrl, jobOutputName, jobOutputFolder, jobOutputKind, chooseFinalOutput, effectiveProcessKind;
export function configureDataSync(deps) {
  ({ setStatus, outputLabelEl, rememberLastDoc, renderLibrary, renderProcessorPanel, syncDockContext,
     stem, jobOutputUrl, jobOutputName, jobOutputFolder, jobOutputKind, chooseFinalOutput, effectiveProcessKind } = deps);
}

// The last /api/status payload (source dir, tool-install flags, outputs dir).
// Reassigned wholesale on each status fetch — importers read it live.
export let workspace = null;
let outputsDir = "";   // set from status; retained for parity (currently unread)

// ---------- output resolution ----------
export function latestOutputsFor(name) {
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

export function preferredOutput(name) {
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

export function itemIsProcessed(name) {
  return latestOutputsFor(name).length > 0;
}

// ---------- reconcile + refresh ----------
// Reconcile library state after work-items change: ensure selectedName still
// points at a real item (default to the first), then repaint the Library dock
// panel (self-guards if not mounted).
export function refreshLibrary() {
  if (!workItems.length) setSelectedName(null);
  else if (!workItems.some((item) => item.name === selectedName)) setSelectedName(workItems[0].name);
  renderLibrary();   // dock panel (self-guards if not mounted)
  if (typeof renderProcessorPanel === "function") renderProcessorPanel();   // library selection drives the Processor target + contextual reveal/dim
  syncDockContext();
}

export async function renderPreviews() {
  // editor.pinned = showing a blank/opened/Save-As'd doc that isn't tied to the
  // library; don't let a library-driven render clobber it. The selectedOutput
  // recompute lives inside this guard too: a pinned doc keeps the save target it
  // owns (null when unsaved, the canvas file after Save-As) instead of silently
  // adopting whatever preferredOutput(selectedName) resolves to.
  if (!editor.pinned) {
    setSelectedOutput(preferredOutput(selectedName));
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

export async function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
  await refreshAll((data.files || []).at(-1) || null);
  setStatus(data.message, 2500);
  return data;
}

export async function fetchQueue() {
  return api("/api/work-items");
}

export function applyQueueData(items, preferredSelection = null) {
  setWorkItems(items);
  if (preferredSelection && workItems.some((item) => item.name === preferredSelection)) {
    setSelectedName(preferredSelection);
  }
  refreshLibrary();
}

export async function fetchStatus() {
  return api("/api/status");
}

export function applyStatusData(data) {
  workspace = data;
  outputsDir = workspace.outputs_dir || "";
}

export async function fetchOutputs() {
  return api("/api/outputs");
}

export function applyOutputsData(data) {
  setOutputs(data);
}

export async function loadOutputs() {
  applyOutputsData(await fetchOutputs());
  refreshLibrary();
  await renderPreviews();
}

export async function refreshAll(preferredSelection = null) {
  const jobsSeq = nextJobsSeq();   // claim the token before the fetch (stale-response guard)
  const [statusData, queueData, outputsData, jobsData] = await Promise.all([
    fetchStatus(),
    fetchQueue(),
    fetchOutputs(),
    fetchJobs(),
  ]);
  applyStatusData(statusData);
  applyQueueData(queueData, preferredSelection);
  applyOutputsData(outputsData);
  applyJobsData(jobsData, jobsSeq);
  refreshLibrary();
  await renderPreviews();
}

// Like refreshAll, but DOES NOT re-render the canvas preview. Background processing
// (a batch run, or any job starting) must never clear or replace the live editor
// document — the canvas only changes on explicit user action (open/load/place/view).
export async function refreshExceptCanvas(preferredSelection = null) {
  const jobsSeq = nextJobsSeq();   // claim the token before the fetch (stale-response guard)
  const [statusData, queueData, outputsData, jobsData] = await Promise.all([
    fetchStatus(),
    fetchQueue(),
    fetchOutputs(),
    fetchJobs(),
  ]);
  applyStatusData(statusData);
  applyQueueData(queueData, preferredSelection);
  applyOutputsData(outputsData);
  applyJobsData(jobsData, jobsSeq);
  refreshLibrary();
}
