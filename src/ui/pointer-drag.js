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
  let ghostEl = null, ghostHome = null;

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

  // The real `el` never moves visually any more — it stays put (dimmed via the .dragging class)
  // and keeps being reflowed in place by the caller's onMove/insertBefore, exactly as before. What
  // the pointer actually carries is a CLONE, fixed-positioned straight off the viewport and appended
  // to <body>, so no ancestor's `overflow: hidden`/`auto` (a scrollable toolstrip rail, a panel's
  // scrolling body, the layer list) can clip it once the drag crosses that ancestor's own edge — the
  // old approach transformed `el` itself, which is still a DOM child of whatever bar/list it started
  // in, so dragging a toolbar tile out of its (clipped) rail made it silently invisible past the rail's
  // border: not stuck, just unpainted. Same fixed-overlay pattern this app already uses for
  // `.xform-readout`.
  function makeGhost() {
    if (ghostAxis === "none") return;
    const r = el.getBoundingClientRect();
    ghostHome = { x: r.left, y: r.top, w: r.width, h: r.height };
    const g = el.cloneNode(true);
    g.removeAttribute("id");
    g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    g.classList.remove("dragging");
    g.classList.add("hv-drag-ghost");
    g.style.cssText = `position:fixed; left:0; top:0; width:${r.width}px; height:${r.height}px; margin:0; pointer-events:none; z-index:1100;`;
    document.body.appendChild(g);
    ghostEl = g;
  }
  // Keep the ghost under the pointer. ghostAxis locks the OTHER axis to where the drag started
  // (ghostHome, captured once) rather than the element's live natural position — el's natural rect
  // can shift as the live reflow reorders it, and a full-width list row locked to its own column
  // shouldn't visually drift sideways just because a sibling above it changed.
  function ghost(x, y) {
    if (ghostAxis === "none" || !ghostEl) return;
    const left = ghostAxis === "y" ? ghostHome.x : x - ghostHome.w / 2;
    const top = ghostAxis === "x" ? ghostHome.y : y - ghostHome.h / 2;
    ghostEl.style.transform = `translate(${left}px, ${top}px)`;
  }

  function cleanup() {
    if (el) el.classList.remove("dragging");
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    ghostHome = null;
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
      makeGhost();
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
    cleanup();
    if (dropped) onDrop(node, where); else onTap(node);
  }

  function cancel(e) { if (e.pointerId !== pid) return; restore(); }
  // stopPropagation, not just preventDefault: an active drag OWNS this Escape entirely. Without it,
  // the same keypress falls through (this handler doesn't unwind the drag until AFTER it returns) to
  // any other Escape listener the host app has registered elsewhere (closing customize-layout mode,
  // say) — one keypress silently doing two unrelated things in the same tick.
  function key(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); restore(); } }
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
