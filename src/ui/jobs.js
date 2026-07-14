// Job/poll layer: fetches /api/jobs, tracks per-job state transitions, drives the
// chin progress bar + status line, and tells the poller when work finished so it
// can refresh outputs and auto-land results.
//
// Extracted from app.js (#26). Cross-module reads stay ergonomic via ES live
// bindings: `jobsCache`, `activityState`, and `TERMINAL_STATES` are imported and
// read directly by the rest of the shell (the module is their sole writer). UI
// hooks the layer can't own (status line, Jobs-panel render, panel reveal, the
// status-replace gate) are injected once via configure(). The compute client is
// imported straight from api.js.
//
// Stale-response sequencing (the audit's /api/jobs last-writer-wins race): every
// fetch path takes a monotonic token before it fetches; a response only applies
// while it still holds the newest token, so an older in-flight /api/jobs can no
// longer clobber a newer one. In sequential use the token always matches, so this
// is behaviour-identical except under genuine fetch overlap.
import { api } from "./api.js";

export const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);
export let jobsCache = [];
export let activityState = "idle"; // "idle" | "busy"

const knownJobStates = new Map();
let lastBatchFailCount = -1;
let _seq = 0;

// UI seams injected by the shell (configure() is called once at boot).
let setStatus = () => {};
let renderJobsPanel = () => {};
let revealPanel = () => {};
let canReplaceStatus = () => true;
// What the strip should say when this module has nothing to say. It used to say "Ready.", which was
// fine while the strip was a STATUS bar and is wrong now that it is the TEACHING line: the poller
// runs on a timer, so every few seconds it was quietly wiping out the sentence explaining the tool
// in the user's hand and replacing it with a word that tells them nothing. A module with no news
// should hand the surface back, not stamp its own idle message on it.
let idleStatus = () => "Ready.";
export function configureJobs(deps) {
  if (deps.setStatus) setStatus = deps.setStatus;
  if (deps.renderJobsPanel) renderJobsPanel = deps.renderJobsPanel;
  if (deps.revealPanel) revealPanel = deps.revealPanel;
  if (deps.canReplaceStatus) canReplaceStatus = deps.canReplaceStatus;
  if (deps.idleStatus) idleStatus = deps.idleStatus;
}

// Cleared to 0 by the shell when it kicks off a fresh pipeline run, so the next
// batch's failures are announced even if the previous batch had the same count.
export function resetFailCount() { lastBatchFailCount = 0; }

// A new monotonic token. A multi-resource refresh that fetches /api/jobs as part
// of a Promise.all takes its token BEFORE the fetch and passes it to applyJobsData.
export function nextJobsSeq() { return ++_seq; }

export function installJobActive(kind) {
  return jobsCache.some((j) => j.kind === kind && (j.status === "running" || j.status === "queued"));
}

// Live progress in the chin: a bar that tracks the running job (determinate when
// the pipeline reports step/total, indeterminate otherwise), hidden when idle.
export function updateFooterProgress(running, queuedCount) {
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

export async function fetchJobs() {
  return api("/api/jobs");
}

export async function loadJobs() {
  const seq = ++_seq;
  return applyJobsData(await fetchJobs(), seq);
}

const STALE = { completionsHappened: false, completedNow: [] };

export function applyJobsData(jobs, seq) {
  // Drop a response that a newer fetch has already superseded (no state mutation).
  if (seq != null && seq !== _seq) return STALE;
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
    setStatus(idleStatus());
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
