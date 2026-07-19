// The help modal — extracted from app.js (#28). A self-contained reference dialog mirroring the live
// keymap. Imports openModal; the two #modal-root content elements are injected via configureShortcuts.
//
// IT ASKS WHAT KIND OF DEVICE IT IS, and this is not a nicety. The help this app shipped was a table
// of KEYBOARD SHORTCUTS — sixty rows of Ctrl+this and Alt+that — and it was the only help there was.
// On a phone, which has no keyboard, that is not "less useful", it is a document about a machine the
// reader is not holding. Worse, the ? button that opens it was itself `display:none` on mobile (it
// lived in the status bar, which the stylesheet hid), so the joke never even landed: a phone user
// could not reach the useless help. Both halves are fixed. A touch device gets the gestures it
// actually has, and the first row is the one nothing else can teach — HOLD A BUTTON TO FIND OUT WHAT
// IT DOES — because a gesture nobody tells you about does not exist.
import { openModal } from "./modal.js";

let modalSearchEl, modalBodyEl;
export function configureShortcuts(deps) {
  ({ modalSearchEl, modalBodyEl } = deps);
}

const isCoarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

// What a finger can do. Every one of these is a gesture that genuinely works today — a help page
// that advertises a gesture the app doesn't have is worse than no help page.
const TOUCH_ROWS = [
  ["§", "The one to know"],
  ["Hold a button", "Find out what it does, without doing it. The strip at the bottom explains it."],
  ["§", "Getting around"],
  ["Pinch", "Zoom in and out"],
  ["Two-finger drag", "Pan around the canvas"],
  ["Tap the logo", "The File menu (new, open, save, export)"],
  ["Tap the ⌸ button", "Panels: layers, colour, properties, history"],
  ["§", "Selecting & editing"],
  ["Tap a shape", "Select it"],
  ["Drag empty canvas", "Sweep up everything you drag across"],
  ["Hold a shape", "Its actions menu — everything you can do to it"],
  ["Drag a selected shape", "Move it"],
  ["⇲ then drag", "Resize it (the handles appear on the box)"],
  ["⟳ then drag", "Turn it (drag the round corner handles)"],
  ["✕", "Delete it (on the bar under the canvas)"],
  ["§", "Drawing"],
  ["Pick a tool, then drag", "Rectangle, ellipse and line all draw by dragging"],
  ["Pen: tap, tap, tap", "Each tap drops a corner; drag instead of tapping to curve"],
  ["Pen: tap the first point", "Closes the shape"],
  ["Points tool: drag a dot", "Reshape a path. Drag the line BETWEEN two dots to bend it."],
];

export function openShortcutsModal() {
  if (isCoarse()) return openTouchHelp();
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
  note.textContent = "Tip: hover any button and the bar at the bottom tells you what it's for. Right-click an object for its style + actions (fill, stroke, rotate, flip…), or empty canvas for artboard actions.";
  root.appendChild(note);
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}

// Same grid, same modal, different subject: what a FINGER can do.
function openTouchHelp() {
  openModal("Gestures");
  modalSearchEl.hidden = true;
  const root = document.createElement("div");
  root.className = "form";
  const grid = document.createElement("div");
  grid.className = "info-grid shortcut-grid";
  for (const [keys, desc] of TOUCH_ROWS) {
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
  note.textContent = "Lost? The strip along the bottom always says what the current tool does. Hold any button to have it explain itself.";
  root.appendChild(note);
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
}
