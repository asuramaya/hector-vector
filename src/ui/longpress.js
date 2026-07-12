// Press and hold on a touch screen = right-click on a mouse.
//
// A finger has no second button, so every command that lives behind the context menu — the whole
// Actions registry — was simply unreachable on a phone. Holding did nothing at all.
//
// Two things make this harder than "start a timer":
//
// 1. iOS does NOT reliably fire `contextmenu` on long-press, and we've deliberately turned off
//    -webkit-touch-callout over the canvas (it was popping Safari's Copy/Look-Up sheet on top of the
//    artwork). So the gesture has to be detected explicitly.
//
// 2. By the time the timer fires, the press has ALREADY begun a tool gesture — the finger is midway
//    through _beginDraw / _beginMove / _beginMarquee. Those loops listen only for pointermove and
//    pointerup; they do NOT listen for pointercancel, so there is nothing to cancel them with.
//    The escape hatch is the one bindViewportTouch already uses when a second finger lands: dispatch
//    a synthetic ZERO-DELTA pointerup on document. It bubbles to window where the drag loops live,
//    and every one of them tears down cleanly on a sub-threshold delta (_beginDraw removes its
//    un-moved node; _beginMove and _beginMarquee commit nothing). We reuse that rather than invent
//    a second abort path.
export function bindLongPress(el, {
  onLongPress,                 // (clientX, clientY, target) -> void
  shouldIgnore = () => false,  // (event) -> bool: a press the caller doesn't want to arm at all
  delay = 500,                 // iOS's own long-press is ~500ms; matching it feels native
  tolerance = 10,             // px of travel that still counts as "holding still" (fingers wobble)
} = {}) {
  let timer = 0, pid = null, sx = 0, sy = 0, target = null;

  const disarm = () => { clearTimeout(timer); timer = 0; pid = null; target = null; };

  function fire() {
    timer = 0;
    const x = sx, y = sy, t = target, id = pid;
    disarm();

    // End whatever the press started, as if the finger had simply lifted without moving.
    try {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: id, clientX: x, clientY: y }));
    } catch { /* older engines: the loop rides through and its real pointerup finalizes it; harmless */ }

    // The menu opens UNDER the finger, and the finger is still down. When it finally lifts, the
    // browser synthesizes a click right there — which would activate whatever menu item just appeared
    // under the fingertip. Swallow exactly ONE click: the release.
    //
    // This used to be a 700ms window, and a window is wrong in BOTH directions:
    //   · hold longer than the window and the release-click sails through, picking an item you never
    //     chose;
    //   · lift fast and tap an item INSIDE the window and it eats YOUR tap instead — the menu plays
    //     dead on first touch, which reads as "the menu is broken", because it is.
    // One click, then disarm. No clock to race. The timeout is only a backstop for the case where the
    // engine synthesizes no click at all (then nothing was eaten, and nothing needs to be).
    let spent = false;
    const done = () => {
      if (spent) return;
      spent = true;
      clearTimeout(leak);
      window.removeEventListener("click", eat, true);
      window.removeEventListener("pointerup", lifted, true);
      window.removeEventListener("pointercancel", lifted, true);
    };
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); done(); };
    // Disarm on the RELEASE of the finger that opened the menu — never on a clock. A timer long enough
    // to cover a long hold is also long enough to eat the user's first real tap; a timer short enough
    // not to is also short enough to let the release-click through. The release is the actual event we
    // are guarding against, so wait for it, give the synthesized click a beat to arrive, then stand
    // down. (If it never arrives, nothing was eaten and nothing needs to be.)
    const lifted = (ev) => { if (ev.pointerId === id) setTimeout(done, 350); };
    const leak = setTimeout(done, 15000);   // the pointer never reported up at all: don't leak the listener
    window.addEventListener("click", eat, true);
    window.addEventListener("pointerup", lifted, true);
    window.addEventListener("pointercancel", lifted, true);

    onLongPress(x, y, t);
  }

  // The press is armed on the element, but tracked on the WINDOW.
  //
  // pointerdown listens on `el` at CAPTURE: editor._onPointerDown calls stopPropagation() on nearly
  // every branch (shape tools, the node tool, a select-tool hit, empty canvas), so a bubble-phase
  // listener here would never see the press at all.
  //
  // move/up/cancel MUST listen on the window, not on `el`. A finger that slides off the canvas — onto
  // a toolbar, or past the edge of the screen — sends its pointerup to something that is not a
  // descendant of `el`, so an el-bound listener never sees the release, the timer is never disarmed,
  // and a context menu erupts half a second after the user already let go. (Every drag loop in this
  // codebase listens on the window for precisely this reason; this one has to as well.)
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;   // a mouse already has a real right-click
    if (pid !== null) { disarm(); return; }  // a second finger → this is a pinch, not a hold
    if (shouldIgnore(e)) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; target = e.target;
    timer = setTimeout(fire, delay);
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid || !timer) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > tolerance) disarm();   // they're drawing, not holding
  }, true);

  const lift = (e) => { if (e.pointerId === pid) disarm(); };
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);

  return { destroy: disarm };
}
