// Manage screen: a second station on the same bench (not a second room). It borrows
// the Library / Processor / Jobs panels out of the cramped 270px right dock into a
// roomy grid — browse, compose a pipeline, watch the queue — then hands them back
// INTACT when you return to the canvas. The panels keep their fixed IDs and renderers
// (#library-list, #processor-body, #jobs-list); only their parent element changes, so
// nothing re-renders or rewires. The seams are one tap each way. See manage-screen-plan.
//
// The dock cooperates via __docks.borrow()/restore(): borrow marks the panels "away"
// (the dock stops reconciling them) and returns their section elements for us to
// reparent; restore un-marks them and lets the dock pull them home.

// Library (browse) · Processor (compose + run) · Jobs (watch) — the processing workflow.
const BORROW = ["library", "processor", "jobs"];

let docks, measureFit, viewports;
let appEl, gridEl, btnEdit, btnManage;
let manageOn = false;

export function createManage(deps) {
  ({ docks, measureFit, viewports } = deps);
  appEl = document.querySelector(".app");
  gridEl = document.querySelector(".manage-grid");
  btnEdit = document.querySelector("#view-edit");
  btnManage = document.querySelector("#view-manage");
  if (btnEdit) btnEdit.addEventListener("click", () => leave());
  if (btnManage) btnManage.addEventListener("click", () => enter());
  // The Library / Processor / Jobs panels are Manage-screen citizens — NOT Edit-dock panels.
  // Move them out of the dock ONCE, into the Manage grid, where they live permanently; the
  // Edit dock then keeps only the editing panels (History / Layers / Properties / Colour).
  // The toggle just shows/hides the grid — no per-switch reparenting. docks.borrow() marks
  // them "away" so the dock won't reclaim them on any reconcile.
  if (gridEl && docks) for (const [, el] of docks.borrow(BORROW)) gridEl.appendChild(el);
  syncButtons();
  return { enter, leave, toggle, isManage: () => manageOn };
}

// Flip TO the Manage screen: reveal the grid (the panels already live there), hide the
// canvas. Also the "Process this" seam — the Processor auto-targets whatever raster is on
// the canvas (processTarget → currentRasterTarget), so crossing over carries your current
// work in as the pipeline source; we re-render it so the target row is fresh.
function enter() {
  if (manageOn || !gridEl || !docks) return;
  manageOn = true;
  appEl.classList.add("manage");
  if (typeof window.renderProcessorPanel === "function") window.renderProcessorPanel();
  syncButtons();
}

// Flip BACK to the workbench: hide the grid, then re-fit the stage (it was hidden, so its
// measured size was stale — the dock does this same rAF dance on every relayout).
function leave() {
  if (!manageOn) return;
  manageOn = false;
  appEl.classList.remove("manage");
  requestAnimationFrame(() => { if (measureFit && viewports) measureFit(viewports.output); });
  syncButtons();
}

function toggle() { manageOn ? leave() : enter(); }

function syncButtons() {
  if (btnEdit) { btnEdit.classList.toggle("active", !manageOn); btnEdit.setAttribute("aria-pressed", String(!manageOn)); }
  if (btnManage) { btnManage.classList.toggle("active", manageOn); btnManage.setAttribute("aria-pressed", String(manageOn)); }
}
