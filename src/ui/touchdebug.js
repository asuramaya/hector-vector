// Diagnostic recorder + overlay for the iOS touch-coordinate bug. Two independent knobs:
//  - a lightweight recorder that ALWAYS runs (cheap: remembers the last touch snapshot, no DOM)
//    so Settings -> Debug can show "what happened last time you touched the canvas" even if the
//    visual overlay wasn't switched on when it happened;
//  - a visual overlay (red/blue dots + HUD), toggled by ?touchdebug on the URL at boot, or live
//    from Settings -> Debug -> "Touch debug overlay".
//
// The overlay drops a real <circle> into the live stage SVG at the mapped touch point and reads
// back its ACTUAL painted screen position — not a tautological CTM round-trip (inverse then
// forward through the same matrix is always ~0 and can't show a visual/layout-viewport bug).
// Measures TWICE per touch: once through the raw stage.getScreenCTM() (blue dot — shows whether
// the underlying browser bug is present at all) and once through editor.stageCTM() (green dot —
// the corrected transform the tools actually draw with, shows whether the fix works). If blue is
// off but green lands on the red raw-touch dot, the bug exists and the fix handles it.
const NS = "http://www.w3.org/2000/svg";

let lastSnapshot = null;
let visual = null; // { root, hud, dots: Map<pointerId, {raw, mapped}> }

function measureRendered(stage, clientX, clientY, ctm) {
  if (!ctm) return null;
  const stagePt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  const scale = Math.hypot(ctm.a, ctm.b) || 1;
  const probe = document.createElementNS(NS, "circle");
  probe.setAttribute("r", String(4 / scale));
  probe.setAttribute("cx", String(stagePt.x));
  probe.setAttribute("cy", String(stagePt.y));
  probe.setAttribute("fill", "none");
  probe.style.pointerEvents = "none";
  stage.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Measures with BOTH the raw getScreenCTM() (what a naive implementation would use — shows
// whether the underlying browser bug is present at all) AND editor.stageCTM() (the corrected
// transform the tools actually draw with — shows whether the fix closes the gap). Two numbers,
// one screenshot: is the bug present, and does the fix work.
function snapshotFor(e) {
  const ed = window.editor;
  const stage = ed && ed.stage;
  const rawCTM = stage && stage.getScreenCTM && stage.getScreenCTM();
  const correctedCTM = ed && ed.stageCTM ? ed.stageCTM() : rawCTM;
  const rendered = measureRendered(stage, e.clientX, e.clientY, rawCTM);
  const corrected = measureRendered(stage, e.clientX, e.clientY, correctedCTM);
  const vv = window.visualViewport;
  return {
    client: { x: e.clientX, y: e.clientY },
    rendered,
    diff: rendered ? Math.hypot(rendered.x - e.clientX, rendered.y - e.clientY) : null,
    corrected,
    correctedDiff: corrected ? Math.hypot(corrected.x - e.clientX, corrected.y - e.clientY) : null,
    visualViewport: vv ? { scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, width: vv.width, height: vv.height } : null,
    devicePixelRatio: window.devicePixelRatio,
    inner: { w: window.innerWidth, h: window.innerHeight },
    ua: navigator.userAgent,
    when: Date.now(),
  };
}

export function getTouchDebugSnapshot() { return lastSnapshot; }

export function formatTouchDebugSnapshot(s) {
  if (!s) return "No touch recorded yet — touch the canvas once, then come back.";
  const vv = s.visualViewport;
  return [
    `recorded: ${new Date(s.when).toLocaleTimeString()}`,
    `raw client: ${s.client.x.toFixed(1)}, ${s.client.y.toFixed(1)}`,
    s.rendered ? `raw CTM probe: ${s.rendered.x.toFixed(1)}, ${s.rendered.y.toFixed(1)}` : "raw CTM probe: n/a (no stage)",
    s.diff !== null ? `raw diff: ${s.diff.toFixed(1)}px${s.diff > 3 ? "  <-- bug present" : "  (ok)"}` : "raw diff: n/a",
    s.corrected ? `corrected probe: ${s.corrected.x.toFixed(1)}, ${s.corrected.y.toFixed(1)}` : "corrected probe: n/a",
    s.correctedDiff !== null ? `corrected diff: ${s.correctedDiff.toFixed(1)}px${s.correctedDiff > 3 ? "  <-- FIX NOT WORKING" : "  (fix OK)"}` : "corrected diff: n/a",
    vv
      ? `visualViewport scale:${vv.scale.toFixed(3)} offset:${vv.offsetLeft.toFixed(1)},${vv.offsetTop.toFixed(1)} size:${vv.width.toFixed(0)}x${vv.height.toFixed(0)}`
      : "visualViewport: n/a",
    `devicePixelRatio: ${s.devicePixelRatio}`,
    `innerWidth/Height: ${s.inner.w}x${s.inner.h}`,
    `UA: ${s.ua}`,
  ].join("\n");
}

function mkOverlay() {
  const root = document.createElement("div");
  root.id = "touchdebug-overlay";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  document.body.appendChild(root);

  const hud = document.createElement("pre");
  hud.style.cssText =
    "position:fixed;top:0;left:0;margin:0;padding:6px 8px;background:rgba(0,0,0,.78);" +
    "color:#0f0;font:11px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;" +
    "max-width:100vw;box-sizing:border-box;";
  hud.textContent = "touchdebug — waiting for a touch";
  root.appendChild(hud);

  const dots = new Map();
  const mkDot = (color) => {
    const d = document.createElement("div");
    d.style.cssText =
      `position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;` +
      `border-radius:50%;border:2px solid ${color};box-sizing:border-box;display:none;pointer-events:none;`;
    root.appendChild(d);
    return d;
  };
  const place = (dot, x, y) => { dot.style.transform = `translate(${x}px, ${y}px)`; dot.style.display = "block"; };

  return {
    root,
    update(e, snap) {
      let entry = dots.get(e.pointerId);
      if (!entry) { entry = { raw: mkDot("#f22"), mapped: mkDot("#2af"), corrected: mkDot("#2e2") }; dots.set(e.pointerId, entry); }
      place(entry.raw, snap.client.x, snap.client.y);
      if (snap.rendered) place(entry.mapped, snap.rendered.x, snap.rendered.y);
      if (snap.corrected) place(entry.corrected, snap.corrected.x, snap.corrected.y);
      hud.textContent = `touchdebug — pointers:${dots.size}  (red=raw touch, blue=raw-CTM probe, green=corrected probe)\n` + formatTouchDebugSnapshot(snap);
    },
    clear(e) {
      const entry = dots.get(e.pointerId);
      if (!entry) return;
      entry.raw.remove(); entry.mapped.remove(); entry.corrected.remove();
      dots.delete(e.pointerId);
    },
  };
}

export function setTouchDebugVisual(on) {
  if (on && !visual) visual = mkOverlay();
  if (!on && visual) { visual.root.remove(); visual = null; }
}
export function isTouchDebugVisualOn() { return !!visual; }

function onPointer(e) {
  if (e.pointerType !== "touch") return;
  lastSnapshot = snapshotFor(e);
  if (visual) visual.update(e, lastSnapshot);
}
function onPointerEnd(e) {
  if (e.pointerType !== "touch") return;
  if (visual) visual.clear(e);
}

export function initTouchDebug() {
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("pointermove", onPointer, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
  if (new URLSearchParams(location.search).has("touchdebug")) setTouchDebugVisual(true);
}
