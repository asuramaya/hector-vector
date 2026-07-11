// Diagnostic overlay for the iOS touch-coordinate bug. Opt-in via ?touchdebug on the URL —
// zero cost otherwise.
//
// A pure matrix round-trip (clientXY -> stage space via getScreenCTM().inverse() -> back via
// the same CTM) is tautologically ~0 and can't show a visual-viewport/layout-viewport
// divergence. Instead this drops a real <circle> into the live stage SVG at the mapped stage
// coordinate and reads back getBoundingClientRect() — that forces the browser to actually lay
// out and paint the element, so it reflects whatever the browser truly does with pinch-zoom /
// visual-viewport offset at render time. If the blue dot (rendered probe) and the red dot (raw
// touch) diverge, that's the bug, live. The HUD dumps visualViewport + devicePixelRatio so one
// operator screenshot from a real iPhone tells us scale error vs translate error vs neither.
export function initTouchDebug() {
  if (!new URLSearchParams(location.search).has("touchdebug")) return;

  const root = document.createElement("div");
  root.id = "touchdebug-overlay";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  document.body.appendChild(root);

  const hud = document.createElement("pre");
  hud.style.cssText =
    "position:fixed;top:0;left:0;margin:0;padding:6px 8px;background:rgba(0,0,0,.78);" +
    "color:#0f0;font:11px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;" +
    "max-width:100vw;box-sizing:border-box;";
  root.appendChild(hud);

  const dots = new Map(); // pointerId -> { raw, mapped }
  const mkDot = (color) => {
    const d = document.createElement("div");
    d.style.cssText =
      `position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;` +
      `border-radius:50%;border:2px solid ${color};box-sizing:border-box;display:none;pointer-events:none;`;
    root.appendChild(d);
    return d;
  };
  const place = (dot, x, y) => {
    dot.style.transform = `translate(${x}px, ${y}px)`;
    dot.style.display = "block";
  };

  const NS = "http://www.w3.org/2000/svg";
  // Render a real probe circle in stage space and measure where the browser actually paints it —
  // the only way to catch a divergence that pure CTM math can't see.
  const measureRendered = (stage, clientX, clientY) => {
    const ctm = stage && stage.getScreenCTM && stage.getScreenCTM();
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
  };

  const update = (e) => {
    let entry = dots.get(e.pointerId);
    if (!entry) {
      entry = { raw: mkDot("#f22"), mapped: mkDot("#2af") };
      dots.set(e.pointerId, entry);
    }
    place(entry.raw, e.clientX, e.clientY);

    const stage = window.editor && window.editor.stage;
    const rendered = measureRendered(stage, e.clientX, e.clientY);
    let diff = null;
    if (rendered) {
      diff = Math.hypot(rendered.x - e.clientX, rendered.y - e.clientY);
      place(entry.mapped, rendered.x, rendered.y);
    }

    const vv = window.visualViewport;
    hud.textContent = [
      `touchdebug — pointers:${dots.size}  (red=raw touch, blue=rendered probe)`,
      `raw client: ${e.clientX.toFixed(1)}, ${e.clientY.toFixed(1)}`,
      diff !== null ? `render diff: ${diff.toFixed(1)}px  ${diff > 3 ? "<-- MISMATCH" : "(ok)"}` : "no stage CTM",
      vv
        ? `visualViewport scale:${vv.scale.toFixed(3)} offset:${vv.offsetLeft.toFixed(1)},${vv.offsetTop.toFixed(1)} size:${vv.width.toFixed(0)}x${vv.height.toFixed(0)}`
        : "visualViewport: n/a",
      `devicePixelRatio: ${window.devicePixelRatio}`,
      `innerWidth/Height: ${window.innerWidth}x${window.innerHeight}`,
      `screen avail: ${window.screen ? window.screen.availWidth + "x" + window.screen.availHeight : "n/a"}`,
    ].join("\n");
  };

  const clear = (e) => {
    const entry = dots.get(e.pointerId);
    if (!entry) return;
    entry.raw.style.display = "none";
    entry.mapped.style.display = "none";
  };

  window.addEventListener("pointerdown", update, true);
  window.addEventListener("pointermove", update, true);
  window.addEventListener("pointerup", clear, true);
  window.addEventListener("pointercancel", clear, true);

  if (window.visualViewport) {
    const onVV = () => {
      const vv = window.visualViewport;
      hud.textContent =
        `touchdebug — waiting for a touch\n` +
        `visualViewport scale:${vv.scale.toFixed(3)} offset:${vv.offsetLeft.toFixed(1)},${vv.offsetTop.toFixed(1)} size:${vv.width.toFixed(0)}x${vv.height.toFixed(0)}\n` +
        `devicePixelRatio: ${window.devicePixelRatio}\ninnerWidth/Height: ${window.innerWidth}x${window.innerHeight}`;
    };
    window.visualViewport.addEventListener("resize", onVV);
    window.visualViewport.addEventListener("scroll", onVV);
    onVV();
  }
}
