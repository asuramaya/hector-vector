// Modal shell + floating input — extracted from app.js (#28). The single #modal-root
// dialog that Open/Place/Save-As/Save-project/Export/Settings all render into, plus the
// small floating text input that replaces window.prompt and the yes/no confirmDialog.
// The shell injects the modal DOM elements + an onAnyClose hook (closeModal fires it on
// every dismissal path so the settings modal can drop its open flag).
import { ghostBtn } from "../editor.js";

let modalRootEl, modalTitleEl, modalBodyEl, modalSearchEl, onAnyClose = () => {};
export function configureModal(deps) {
  ({ modalRootEl, modalTitleEl, modalBodyEl, modalSearchEl } = deps);
  if (deps.onAnyClose) onAnyClose = deps.onAnyClose;
}

// A small floating text input that replaces window.prompt for in-app renames/saves
// (the browser prompt is ugly + blocking). Commits on Enter/blur, cancels on Escape.
export function floatingInput({ value = "", placeholder = "", title = "", x, y, onCommit }) {
  document.querySelectorAll(".hv-float-input").forEach((e) => e.remove());
  const wrap = document.createElement("div"); wrap.className = "hv-float-input"; wrap.style.position = "fixed";
  wrap.style.left = Math.max(8, Math.min((x == null ? window.innerWidth / 2 - 130 : x), window.innerWidth - 268)) + "px";
  wrap.style.top = Math.max(8, (y == null ? Math.round(window.innerHeight / 3) : y)) + "px";
  if (title) { const t = document.createElement("div"); t.className = "hv-float-label"; t.textContent = title; wrap.appendChild(t); }
  const inp = document.createElement("input"); inp.type = "text"; inp.value = value; if (placeholder) inp.placeholder = placeholder;
  wrap.appendChild(inp); document.body.appendChild(wrap); inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => { if (done) return; done = true; const v = inp.value.trim(); wrap.remove(); if (commit && v) onCommit(v); };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
}

// Fired exactly once whenever the modal closes by ANY path (OK/Cancel buttons,
// the [data-modal-close] X, backdrop click, or Esc). confirmDialog registers
// here so dismissals it doesn't own still settle its promise — see :openModal.
let modalOnClose = null;

export function openModal(title, narrow = false) {
  modalTitleEl.textContent = title;
  modalSearchEl.value = "";
  const win = modalRootEl.querySelector(".modal-window");
  if (win) win.classList.toggle("modal-narrow", !!narrow);
  modalRootEl.hidden = false;
  setTimeout(() => modalSearchEl.focus(), 0);
}

export function closeModal() {
  modalRootEl.hidden = true;
  modalBodyEl.innerHTML = "";
  onAnyClose();
  const cb = modalOnClose; modalOnClose = null;
  if (cb) cb();
}

// A yes/no modal → resolves true (confirmed) or false (cancelled, incl. Esc / backdrop).
// Used where an action would otherwise degrade silently (e.g. a save falling back to
// non-portable linked refs) so the user actively chooses instead of being surprised.
export function confirmDialog({ title = "Confirm", message = "", okLabel = "OK", cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    function finish(val) {
      if (settled) return; settled = true;
      modalOnClose = null;   // we're closing deliberately; don't re-fire as a dismissal
      closeModal(); resolve(val);
    }
    openModal(title, true);
    modalSearchEl.hidden = true;
    const root = document.createElement("div"); root.className = "form";
    const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.whiteSpace = "pre-line"; msg.textContent = message;
    root.appendChild(msg);
    const actions = document.createElement("div"); actions.className = "form-actions";
    const ok = ghostBtn(okLabel, () => finish(true)); ok.classList.add("primary-button");
    actions.appendChild(ghostBtn(cancelLabel, () => finish(false)));
    actions.appendChild(ok);
    root.appendChild(actions);
    modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
    // Any other close path (backdrop click, the X button, the generic Esc closer)
    // routes through closeModal → this hook, so the promise always settles (false).
    modalOnClose = () => { if (!settled) { settled = true; resolve(false); } };
    setTimeout(() => ok.focus(), 0);
  });
}
