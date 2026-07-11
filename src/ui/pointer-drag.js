// Drag on POINTER events, so it works with a finger as well as a mouse.
//
// HTML5 drag-and-drop (el.draggable + dragstart/dragover/drop) never fires from touch — on any
// browser, on any phone. Three features in this app were built on it and were therefore silently,
// completely dead on a touch device: the toolbar customize engine, the layer-list reorder, and the
// pipeline stage strip. Nothing caught it because the e2e drove those code paths through their APIs
// rather than by actually dragging.
//
// The callback shape is deliberately identical to what a `dragover` handler already computed —
// onMove(el, container, x, y) — so an adopting module keeps its existing hit-test and reflow logic
// verbatim and only swaps the event source. If adopting this requires rewriting your insertion
// logic, something has gone wrong.
export function createPointerDrag({
  containerAt,                 // (x, y, dragEl) -> Element|null — the caller decides what a drop zone is
  onStart = () => {},
  onMove = () => {},           // live reflow, exactly as dragover did
  onDrop = () => {},
  onCancel = () => {},
  onTap = () => {},            // down+up under the threshold — a tap, not a drag
  ignoreFrom = null,           // CSS selector: a pointerdown starting here is not a drag (nested buttons)
  // CSS selector for a drag HANDLE that touch must start from. Needed wherever the draggable thing
  // lives in a SCROLLING container (the layer list): a finger dragging a row is indistinguishable
  // from a finger scrolling the list, so touch reorders from the grip and scrolls from anywhere
  // else. A mouse has no such conflict and can still drag the whole row.
  touchHandle = null,
  ghostAxis = "both",          // which way the dragged element follows the pointer ("y" for list rows,
                               // which are full-width — tracking x as well would fling them sideways)
  threshold = 6,               // mouse: px of travel before it's a drag
  touchThreshold = 8,          // finger: a little more, fingers wobble
  autoScroll = true,
} = {}) {
  let el = null, pid = null, sx = 0, sy = 0, dragging = false, home = null, cont = null, scrollRAF = 0;

  const dist = (x, y) => Math.hypot(x - sx, y - sy);
  const limit = (e) => (e.pointerType === "touch" ? touchThreshold : threshold);

  // A scrolling bar (the phone tool strip) has to keep scrolling when you drag a tile to its edge —
  // native DnD did this for free.
  function edgeScroll(x, y) {
    if (!autoScroll || !cont) return;
    const r = cont.getBoundingClientRect(), PAD = 28, STEP = 12;
    let dx = 0, dy = 0;
    if (cont.scrollWidth > cont.clientWidth) {
      if (x < r.left + PAD) dx = -STEP; else if (x > r.right - PAD) dx = STEP;
    }
    if (cont.scrollHeight > cont.clientHeight) {
      if (y < r.top + PAD) dy = -STEP; else if (y > r.bottom - PAD) dy = STEP;
    }
    if (!dx && !dy) { cancelAnimationFrame(scrollRAF); scrollRAF = 0; return; }
    if (scrollRAF) return;
    const step = () => { if (!dragging) { scrollRAF = 0; return; } cont.scrollBy(dx, dy); scrollRAF = requestAnimationFrame(step); };
    scrollRAF = requestAnimationFrame(step);
  }

  // Keep the tile under the pointer. Recomputed from the element's CURRENT rect every move rather
  // than accumulated from the start point — the live reflow physically relocates the tile mid-drag,
  // so an accumulated offset would drift away from the finger.
  function ghost(x, y) {
    if (ghostAxis === "none") return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const dx = ghostAxis === "y" ? 0 : x - (r.left + r.width / 2);
    const dy = ghostAxis === "x" ? 0 : y - (r.top + r.height / 2);
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function cleanup() {
    if (el) { el.style.transform = ""; el.classList.remove("dragging"); }
    cancelAnimationFrame(scrollRAF); scrollRAF = 0;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    el = null; pid = null; dragging = false; home = null; cont = null;
  }

  function move(e) {
    if (e.pointerId !== pid || !el) return;
    if (!dragging) {
      if (dist(e.clientX, e.clientY) < limit(e)) return;
      dragging = true;
      home = { parent: el.parentNode, next: el.nextSibling };   // for Escape
      el.classList.add("dragging");
      onStart(el);
    }
    e.preventDefault();
    const c = containerAt(e.clientX, e.clientY, el);
    if (c) { cont = c; onMove(el, c, e.clientX, e.clientY); }
    ghost(e.clientX, e.clientY);
    edgeScroll(e.clientX, e.clientY);
  }

  function up(e) {
    if (e.pointerId !== pid || !el) return;
    const node = el, dropped = dragging, where = cont;
    if (dragging) { el.style.transform = ""; el.classList.remove("dragging"); }
    cleanup();
    if (dropped) onDrop(node, where); else onTap(node);
  }

  function cancel(e) { if (e.pointerId !== pid) return; restore(); }
  function key(e) { if (e.key === "Escape") { e.preventDefault(); restore(); } }
  function restore() {
    if (!el) return;
    const node = el, h = home, was = dragging;
    if (was && h && h.parent) h.parent.insertBefore(node, h.next);   // put it back exactly where it started
    cleanup();
    if (was) onCancel(node);
  }

  function down(e) {
    if (el) return;                                   // one drag at a time
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // a press that starts on a nested control (a layer row's eye/twisty) is that control's, not a drag
    if (ignoreFrom && e.target.closest && e.target.closest(ignoreFrom)) return;
    if (touchHandle && e.pointerType !== "mouse" && !(e.target.closest && e.target.closest(touchHandle))) return;
    el = e.currentTarget; pid = e.pointerId; sx = e.clientX; sy = e.clientY; dragging = false;
    // NB: NO preventDefault here. Calling it on pointerdown suppresses the compatibility mouse
    // events on touch — including `click` — which would kill tap-to-select on a layer row. Selection
    // is suppressed in move() instead, once we know it's actually a drag; native image-drag is
    // already off because arm() sets draggable = false.
    // Deliberately NOT setPointerCapture either. Old WebKit is quirky about it, and synthetic
    // PointerEvents dispatched from page.evaluate carry pointerId 0 — setPointerCapture(0) throws,
    // which would make this helper untestable with the very technique the e2e suite already uses.
    // Window listeners filtered by pointerId are both more robust and testable.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
  }

  return {
    arm(node) {
      if (!node || node._pdArmed) return;
      node._pdArmed = true;
      node.draggable = false;              // make sure the native DnD engine can't race us
      node.dataset.hvMovable = "1";        // what "this tile is draggable" now looks like
      node.addEventListener("pointerdown", down);
    },
    disarm(node) {
      if (!node || !node._pdArmed) return;
      node._pdArmed = false;
      delete node.dataset.hvMovable;
      node.removeEventListener("pointerdown", down);
      if (el === node) restore();
    },
    destroy() { restore(); },
    isDragging: () => dragging,
  };
}
