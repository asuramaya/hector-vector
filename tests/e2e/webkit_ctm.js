// Runs the stage-CTM invariant on REAL WebKit — the engine behind every iOS browser (Safari AND
// Chrome-iOS; iOS forces WebKit on everyone, which is why "try a different browser" never helped).
//
// This exists because the iOS touch-coordinate bug survived three fix attempts while the whole
// Chromium e2e suite stayed green. The calibration probes in editor.js used to be r=0 circles; SVG
// says r=0 disables rendering, so WebKit returns an EMPTY getBoundingClientRect for them (pinned at
// the page origin) while Chromium reports the right position anyway. All three probes collapsed
// onto one point on iOS, the affine solve went SINGULAR, and every tool inverted that into garbage.
// Headless Chromium physically could not see it. So: test on the engine that actually ships.
//
// Runs via docker, because Playwright's WebKit build refuses to install on many host distros
// (ubuntu 26.04 among them) — the image already carries a WebKit that does run:
//
//   PORT=2099 .venv/bin/python server.py &
//   docker run --rm --network host --memory=8g --memory-swap=8g \
//     -v "$PWD/tests/e2e:/w" -w /w \
//     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
//     -e NODE_PATH=/usr/lib/node_modules mcr.microsoft.com/playwright:v1.60.0-noble \
//     bash -lc 'npm i -g --silent playwright@1.60.0 >/dev/null 2>&1; node webkit_ctm.js'
//
// --memory/--memory-swap: a WebKit-driving container gets the same hard cap as the local
// Chromium runs (see scripts/capped-run.sh) — this test's own browser tree is just as capable
// of growing a runaway renderer, and docker's default is UNBOUNDED host memory, not a safe one.
// (The image ships the browsers but not the client library, hence the npm install.)
// Pass a base URL as argv[2] to point it elsewhere (defaults to http://127.0.0.1:2099).
const { webkit, chromium } = require("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:2099";
const ZOOMS = [1, 0.78, 2.5];

async function run(label, browserType) {
  const browser = await browserType.launch();
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("typeof editor!=='undefined'", { timeout: 20000 });
  await page.waitForFunction("()=>!!editor.stage && !!editor.stage.querySelector('g.hv-overlay')", { timeout: 20000 });
  await page.waitForTimeout(800);   // let the blank-canvas mount settle

  const rows = await page.evaluate((zooms) => {
    const NS = "http://www.w3.org/2000/svg";
    const stage = editor.stage;
    const host = stage.querySelector("g.hv-overlay") || stage;
    // Ground truth: where does stage point (x,y) REALLY paint? A sized rect renders in every engine.
    const paintedAt = (x, y) => {
      const raw = stage.getScreenCTM(), h = 4 / (Math.hypot(raw.a, raw.b) || 1);
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x - h); r.setAttribute("y", y - h);
      r.setAttribute("width", 2 * h); r.setAttribute("height", 2 * h); r.setAttribute("fill", "none");
      host.appendChild(r); const b = r.getBoundingClientRect(); r.remove();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const out = [];
    for (const z of zooms) {
      viewports.output.scale = z;
      document.querySelector(".viewport-content").style.transform =
        `translate(${viewports.output.x}px, ${viewports.output.y}px) scale(${z})`;
      editor._ctmCache = null;
      const m = editor.stageCTM(), det = m.a * m.d - m.b * m.c;
      const rc = viewports.output.el.getBoundingClientRect();
      const cx = rc.left + rc.width * 0.4, cy = rc.top + rc.height * 0.6;
      const sp = new DOMPoint(cx, cy).matrixTransform(m.inverse());
      const p = paintedAt(sp.x, sp.y);
      // _ctmMeasured is the one that gives this rig teeth. A degenerate probe makes the calibration
      // bail out to the raw CTM, which on THIS desktop engine round-trips perfectly — so err and det
      // both look fine while the correction iOS depends on is silently dead. Assert it actually ran.
      out.push({ z, det: +det.toFixed(6), err: +Math.hypot(p.x - cx, p.y - cy).toFixed(3),
                 measured: editor._ctmMeasured === true });
    }
    return out;
  }, ZOOMS);

  let ok = true;
  console.log(`\n=== ${label} ===`);
  for (const r of rows) {
    const singular = Math.abs(r.det) < 1e-9;
    const bad = singular || r.err >= 1.0 || !r.measured;
    if (bad) ok = false;
    const why = singular ? "FAIL (SINGULAR CTM)"
      : !r.measured ? "FAIL (calibration fell back to the raw CTM — inert on iOS)"
      : r.err >= 1.0 ? "FAIL (touch misses)" : "ok";
    console.log(`  zoom ${String(r.z).padEnd(5)} det=${String(r.det).padEnd(10)} ` +
                `touch->paint err=${String(r.err).padEnd(7)} calibrated=${String(r.measured).padEnd(6)} ${why}`);
  }

  // ── Press-and-hold = right-click ────────────────────────────────────────────────────────────
  // A finger has no second button, so without this every command behind the Actions menu is
  // unreachable on a phone. It belongs in THIS rig and not only in the Chromium suite because iOS
  // does not reliably fire `contextmenu` on a long-press, and we deliberately switched off
  // -webkit-touch-callout over the canvas — both WebKit-only behaviours the Chromium run cannot see.
  const lp = await page.evaluate(async () => {
    const fit = document.querySelector('[data-action="fit"]'); if (fit) fit.click();
    await new Promise((r) => setTimeout(r, 250));
    editor.setTool("rect");
    const b0 = editor.stage.getBoundingClientRect();
    const NS = "http://www.w3.org/2000/svg";
    const sq = document.createElementNS(NS, "rect");
    const vb = editor.stage.viewBox.baseVal;
    sq.setAttribute("x", vb.x + vb.width * 0.25); sq.setAttribute("y", vb.y + vb.height * 0.25);
    sq.setAttribute("width", vb.width * 0.5); sq.setAttribute("height", vb.height * 0.5);
    sq.setAttribute("fill", "#c33"); sq.setAttribute("data-hv-id", "lpwk");
    (editor._artRoot ? editor._artRoot() : editor.stage).appendChild(sq);
    editor.setTool("select"); editor.selection = new Set(); editor._renderSelection();
    await new Promise((r) => setTimeout(r, 100));

    const hold = async (ms) => {
      const b = editor.stage.getBoundingClientRect();
      const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
      const tgt = document.elementFromPoint(x, y) || document.querySelector(".stage-wrap");
      // down AND up on the same target: touch pointers get implicit pointer capture, so that is
      // where a real engine delivers the release.
      const mk = (t, btns) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: btns });
      tgt.dispatchEvent(mk("pointerdown", 1));
      await new Promise((r) => setTimeout(r, ms));
      tgt.dispatchEvent(mk("pointerup", 0));
      await new Promise((r) => setTimeout(r, 120));
      const m = document.querySelector(".context-menu");
      const open = !!m && m.getBoundingClientRect().width > 0;   // position:fixed → offsetParent is always null
      const items = m ? m.querySelectorAll("button").length : 0;
      if (m) m.remove();
      return { open, items };
    };
    const nBefore = editor._artworkNodes().length;
    const held = await hold(650);
    const tapped = await hold(120);
    return {
      held: held.open, items: held.items, tapped: tapped.open,
      selected: [...editor.selection].join(","),
      // the aborted in-flight gesture must not leave a stray node behind
      clean: editor._artworkNodes().length === nBefore,
      // the callout that used to pop Safari's Copy/Look-Up sheet over the artwork
      callout: getComputedStyle(document.querySelector(".stage-wrap")).webkitTouchCallout || "(unset)",
    };
  });
  const lpOk = lp.held && lp.items > 0 && !lp.tapped && lp.selected === "lpwk" && lp.clean;
  if (!lpOk) ok = false;
  console.log(`  long-press   menu=${String(lp.held).padEnd(6)} items=${String(lp.items).padEnd(3)} ` +
              `quick-tap-opens=${String(lp.tapped).padEnd(6)} selected=${lp.selected || "(none)"} ` +
              `no-stray-node=${lp.clean} callout=${lp.callout} ${lpOk ? "ok" : "FAIL"}`);

  // ── The Panels sheet is a TAB surface, not a stack ──────────────────────────────────────────
  // This belongs in THIS rig and not only in the Chromium suite. The pane fills the sheet with a
  // flex(1 1 auto) + min-height:0 + overflow:auto column nested inside a position:fixed element —
  // which is precisely where WebKit has always diverged from Blink on flex sizing. If the pane
  // collapses to its content height on iOS, or refuses to scroll, then every panel is a stub and a
  // green headless Chromium run would say nothing at all. Same class of blind spot as the r=0 probes.
  await page.waitForTimeout(400);
  const sheet = await page.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    // Feed the long-press click-eater. After a hold, longpress.js arms a capture-phase swallower for
    // exactly ONE click — the one the engine synthesizes when the finger lifts, which would otherwise
    // fire whatever menu item appeared under the fingertip. Our synthetic pointer events never produce
    // that click, so the eater can still be armed and would swallow this block's tap on the FAB
    // instead. Nothing is wrong with the app; a real thumb always feeds it. Feed it deliberately
    // rather than racing a timer — that race is exactly what made this check flaky.
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nap(60);
    // Idempotent: the FAB TOGGLES, and an earlier check may already have raised the sheet (an error
    // toast can call revealPanel, which opens it). A blind click would close it and read a sheet that
    // is 102% translated off-screen.
    const app = document.querySelector("main.app");
    if (!app.classList.contains("sheet-open")) document.querySelector("#mobile-panels").click();
    const d = document.querySelector("#rightdock");
    // The sheet SLIDES in (a 0.26s transform transition). Poll until it lands instead of napping a
    // guessed number of milliseconds and reading it mid-flight — WebKit under docker is slower than
    // Chromium, and a fixed sleep here fails about one run in three for no reason at all.
    let box = d.getBoundingClientRect();
    for (let i = 0; i < 60 && Math.abs(box.bottom - innerHeight) > 2; i++) {
      await nap(50);
      box = d.getBoundingClientRect();
    }
    const strip = d.querySelector(".sheet-tabs");
    const tabs = [...d.querySelectorAll(".sheet-tab")];
    const shown = () => [...d.children].filter((c) => !c.classList.contains("sheet-tabbar")
      && getComputedStyle(c).display !== "none");
    const before = shown().length;
    const lay = tabs.find((t) => t.dataset.tabKey === "layers");
    if (lay) lay.click();
    await nap(250);
    const after = shown(), pane = after[0];
    const ph = pane ? pane.getBoundingClientRect().height : 0;
    return {
      tabbed: d.classList.contains("sheet-tabbed"),
      n: tabs.length,
      // 100dvh/dvh-sized sheet must sit ON the visual viewport — vh would push it under Safari's chrome
      onscreen: box.top > 0 && box.top < innerHeight - 40 && box.bottom <= innerHeight + 1,
      one: before === 1 && after.length === 1,
      swapped: !!pane && pane.dataset.section === "layers",
      sideways: !!strip && strip.scrollWidth > strip.clientWidth + 1,
      fill: box.height ? +(ph / box.height).toFixed(2) : 0,   // the pane FILLS the sheet, not its content height
      sheetScrolls: d.scrollHeight > d.clientHeight + 1,      // one scroller, and it isn't this one
      geom: `top=${Math.round(box.top)} vh=${innerHeight} cls="${app.className}" fab=${getComputedStyle(document.querySelector("#mobile-panels")).display}`,
    };
  });
  const shOk = sheet.tabbed && sheet.one && sheet.swapped && sheet.onscreen
    && sheet.n >= 3 && sheet.fill > 0.7 && !sheet.sheetScrolls;
  if (!shOk) ok = false;
  console.log(`  sheet tabs   tabbed=${String(sheet.tabbed).padEnd(6)} tabs=${String(sheet.n).padEnd(3)} ` +
              `one-pane=${String(sheet.one).padEnd(6)} swaps=${String(sheet.swapped).padEnd(6)} ` +
              `pane-fills=${String(sheet.fill).padEnd(5)} scrolls-sideways=${String(sheet.sideways).padEnd(6)} ` +
              `onscreen=${String(sheet.onscreen).padEnd(6)} ${sheet.geom} ${shOk ? "ok" : "FAIL"}`);

  await browser.close();
  return ok;
}

(async () => {
  const a = await run("WEBKIT — the engine every iOS browser runs on", webkit);
  const b = await run("CHROMIUM — desktop reference", chromium);
  console.log(a && b ? "\nPASS — a touch lands where it paints, in both engines." : "\nFAIL");
  process.exit(a && b ? 0 : 1);
})();
