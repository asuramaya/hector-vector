// Manage screen: a dismissible overlay over the still-live canvas (not a second room).
// It borrows the Library / Processor / Jobs panels out of the cramped 270px right dock
// into a roomy grid — browse, compose a pipeline, watch the queue — then hands them back
// INTACT when you dismiss it. The panels keep their fixed IDs and renderers (#library-list,
// #processor-body, #jobs-list); only their parent element changes, so nothing re-renders
// or rewires. See manage-screen-plan for the original screen-swap design, and thread
// 5747/5754/5759 for why it became an overlay: Manage used to be a separate full-screen
// route (.app.manage swapping .editor-grid out); the operator flagged that as a false
// dichotomy — browsing and editing aren't mutually exclusive, and leaving Edit to grab a
// library asset broke flow. Manage now rides the SAME #modal-root overlay Open/Place/
// Settings already use (modal.js) — same dismiss-over-a-live-canvas mechanism, just at
// full-viewport density instead of the narrow/normal sizes. The canvas is never hidden;
// it just sits behind the modal's dim backdrop, exactly like any other modal.
//
// The grid itself (gridEl) is a PERMANENT element, reparented between two homes rather
// than rebuilt: appEl (parked, hidden) when Manage is closed, modalBodyEl (shown) when
// open. That's why Manage passes modal.js's hostDetach hook instead of letting closeModal
// do its normal innerHTML wipe — a wipe would destroy the borrowed panels, not just hide
// them. The dock cooperates via __docks.borrow()/restore(): borrow marks the panels "away"
// (the dock stops reconciling them) and returns their section elements for us to reparent.

// Library (browse) · Processor (compose + run) · Info (inspect the selected image) · Jobs
// (watch) — the processing workflow. All four are Manage citizens, not Edit-dock panels.
const BORROW = ["library", "processor", "info", "jobs"];

let docks, measureFit, viewports, modalBodyEl, modalSearchEl, openModal, closeModal;
let appEl, gridEl, btnEdit, btnManage;
let manageOn = false;

export function createManage(deps) {
  ({ docks, measureFit, viewports, modalBodyEl, modalSearchEl, openModal, closeModal } = deps);
  appEl = document.querySelector(".app");
  gridEl = document.querySelector(".manage-grid");
  btnEdit = document.querySelector("#view-edit");
  btnManage = document.querySelector("#view-manage");
  if (btnEdit) btnEdit.addEventListener("click", () => leave());
  if (btnManage) btnManage.addEventListener("click", () => enter());
  // The Library / Processor / Jobs panels are Manage-screen citizens — NOT Edit-dock panels.
  // Move them out of the dock ONCE, into the Manage grid, where they live permanently; the
  // Edit dock then keeps only the editing panels (History / Layers / Properties / Colour).
  // docks.borrow() marks them "away" so the dock won't reclaim them on any reconcile.
  if (gridEl && docks) for (const [name, el] of docks.borrow(BORROW)) {
    gridEl.appendChild(el);
    // Info is the selection inspector — give it a hint until an image is opened into it.
    if (name === "info") { const body = el.querySelector(".fp-body"); if (body && !body.textContent.trim()) body.innerHTML = '<div class="info-empty">Click a Library tile to inspect it here.</div>'; }
  }
  if (gridEl) gridEl.hidden = true;   // parked by default; enter() moves it into the modal
  syncButtons();
  return { enter, leave, toggle, isManage: () => manageOn };
}

// Move the grid back to its parked home (appEl), out of the modal — the hostDetach half
// of the overlay contract. Runs on EVERY dismissal path (Close button, backdrop, Esc,
// or leave()), since closeModal calls it directly rather than only from leave().
function parkGrid() {
  if (!gridEl) return;
  gridEl.hidden = true;
  appEl.appendChild(gridEl);
}

// Open the overlay: move the grid into the modal body (a reparent, not a rebuild — its
// contents and their state survive), then open at full-viewport density. Also the
// "Process this" seam — the Processor auto-targets whatever raster is on the canvas
// (processTarget → currentRasterTarget), so entering carries your current work in as the
// pipeline source; we re-render it so the target row is fresh.
function enter() {
  if (manageOn || !gridEl || !modalBodyEl || !openModal) return;
  manageOn = true;
  gridEl.hidden = false;
  modalBodyEl.appendChild(gridEl);
  if (modalSearchEl) modalSearchEl.hidden = true;   // Library has its own filter chin
  openModal("Manage", false, {
    fullscreen: true,
    hostDetach: parkGrid,
    // Runs on every dismissal path (not just leave()), so manageOn/measureFit/syncButtons
    // stay correct even when the operator closes via Esc/backdrop/X instead of the Edit tab.
    onClose: () => { manageOn = false; requestAnimationFrame(() => { if (measureFit && viewports) measureFit(viewports.output); }); syncButtons(); },
  });
  if (typeof window.renderProcessorPanel === "function") window.renderProcessorPanel();
  syncButtons();
}

// Dismiss the overlay — closeModal runs parkGrid (hostDetach) + the onClose bookkeeping
// registered in enter(), so this is the only path leave() needs.
function leave() {
  if (!manageOn || !closeModal) return;
  closeModal();
}

function toggle() { manageOn ? leave() : enter(); }

function syncButtons() {
  if (btnEdit) { btnEdit.classList.toggle("active", !manageOn); btnEdit.setAttribute("aria-pressed", String(!manageOn)); }
  if (btnManage) { btnManage.classList.toggle("active", manageOn); btnManage.setAttribute("aria-pressed", String(manageOn)); }
}
