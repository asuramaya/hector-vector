// Keyboard-shortcuts help modal — extracted from app.js (#28). A self-contained
// reference dialog mirroring the live keymap. Imports openModal; the two #modal-root
// content elements are injected via configureShortcuts.
import { openModal } from "./modal.js";

let modalSearchEl, modalBodyEl;
export function configureShortcuts(deps) {
  ({ modalSearchEl, modalBodyEl } = deps);
}

export function openShortcutsModal() {
  openModal("Keyboard shortcuts");
  modalSearchEl.hidden = true;
  const mod = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  // Mirrors the live keymap in app.js (editor keymap + view/nav keymap + space-pan).
  const rows = [
    ["§", "Tools"],
    ["V", "Select / move (drag empty = marquee, Alt = lasso; Shift = 45°, Alt-drag = copy)"],
    [`${mod} + T / ${mod} + R`, "Scale / rotate the selection (within Select)"],
    ["A", "Edit points (direct select)"],
    ["P", "Pen"],
    ["C", "Curvature (Alt = corner, Shift = 45°, drag = move point, ⌫ = remove last)"],
    ["R / E / L", "Rectangle / Ellipse / Line"],
    ["Shift + O", "Select the artboard"],
    ["§", "Edit"],
    [`${mod} + Z`, "Undo"],
    [`${mod} + Shift + Z`, "Redo"],
    [`${mod} + C / X / V`, "Copy / Cut / Paste"],
    [`${mod} + D`, "Duplicate"],
    [`${mod} + A`, "Select all"],
    ["Delete / Backspace", "Delete selection"],
    ["← ↑ ↓ →", "Nudge (Shift = ×10)"],
    ["Esc", "Deselect / cancel"],
    ["§", "Arrange"],
    [`${mod} + G`, "Group"],
    [`${mod} + Shift + G`, "Ungroup"],
    [`${mod} + ] / [`, "Bring forward / send backward"],
    [`${mod} + Shift + ] / [`, "Bring to front / send to back"],
    ["§", "Pen"],
    ["Click / drag", "Corner point / smooth curve"],
    ["Alt + drag", "Break handle (cusp)"],
    ["Shift", "Constrain to 45°"],
    ["Click path / anchor", "Add (+) / remove (−) a point"],
    ["Click an endpoint", "Continue an open path"],
    [`${mod} (hold)`, "Temporarily edit points (Direct-Select)"],
    ["Enter", "Finish path"],
    ["Esc", "Cancel path"],
    ["§", "Node tool"],
    ["Click / Shift-click", "Select anchor / multi-select"],
    ["Drag empty canvas", "Marquee-select anchors (Shift adds)"],
    ["Drag a segment", "Reshape it (curve bends, line moves)"],
    ["Drag square", "Move selected anchors (Shift = 45°)"],
    ["Drag round dot", "Reshape curve (Alt = break)"],
    ["Alt-click anchor", "Smooth → corner"],
    ["Alt-drag anchor", "Corner → smooth"],
    [`${mod} + J`, "Join two selected endpoints"],
    ["Right-click a point", "Smooth / sharpen / join / delete"],
    ["Delete / Backspace", "Remove selected anchors"],
    ["§", "View & navigation"],
    ["Space (hold)", "Pan; or reposition a shape/point while creating"],
    ["+ / −", "Zoom in / out"],
    ["0", "Actual size (1:1)"],
    ["f", "Fit canvas to window"],
    ["b", "Cycle background"],
    ["Shift + F", "Open the File menu"],
    ["?", "This help"],
  ];
  const root = document.createElement("div");
  root.className = "form";
  const grid = document.createElement("div");
  grid.className = "info-grid shortcut-grid";
  for (const [keys, desc] of rows) {
    if (keys === "§") {
      const h = document.createElement("div");
      h.className = "shortcut-section";
      h.textContent = desc;
      grid.appendChild(h);
      continue;
    }
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
  const note = document.createElement("p");
  note.className = "form-hint";
  note.textContent = "Tip: right-click an object for its style + actions (fill, stroke, rotate, flip…), or empty canvas for artboard actions.";
  root.appendChild(note);
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}
