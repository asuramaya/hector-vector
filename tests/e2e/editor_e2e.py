#!/usr/bin/env python3
"""End-to-end stress test for the vector editor, driven through a real browser.

Uses Playwright to issue genuine pointer + keyboard input (so the
pointer -> getScreenCTM -> selection/move pipeline is exercised for real, not
faked via dispatchEvent) and reads back live `editor` state to assert outcomes.

Run:  .venv-e2e/bin/python tests/e2e/editor_e2e.py [base_url]
Needs the app running (default http://localhost:2002).
"""
from __future__ import annotations
import json, os, re, sys, time
from playwright.sync_api import sync_playwright

# Positional base URL stays argv[1] (back-compat); flags are parsed out so they don't get
# mistaken for the base. --only=<substr> (or --only <substr>) focuses sections (see
# section()); failures always grab a screenshot into tests/e2e/_failshots/ for the flake.
def _flag(name, default=None):
    """Read --name=value or --name value; returns the string value (or default)."""
    pre = f"--{name}="
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a.startswith(pre): return a[len(pre):]
        if a == f"--{name}": return argv[i + 1] if i + 1 < len(argv) else True
    return default
ONLY = _flag("only")   # substring; focus sections whose name contains it (case-insensitive)
_VALUES = {ONLY} if isinstance(ONLY, str) else set()
_ARGS = [a for a in sys.argv[1:] if not a.startswith("--") and a not in _VALUES]
BASE = _ARGS[0] if _ARGS else "http://localhost:2002"

CTL = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect data-hv-id="r1" x="20"  y="20"  width="40" height="40" fill="#3366cc"/>
  <rect data-hv-id="r2" x="120" y="20"  width="40" height="40" fill="#cc3333"/>
  <rect data-hv-id="r3" x="70"  y="120" width="40" height="40" fill="#33aa55"/>
</svg>"""

# Structural fingerprint of the document (ignores artboard/overlay), for
# asserting that undo returns to an identical baseline.
SUMMARY = """() => {
  const vb = editor.stage.getAttribute('viewBox');
  const nodes = [...editor.stage.querySelectorAll('[data-hv-id]')].map(n => (
    n.tagName + '|' + (n.getAttribute('fill')||'') + '|' + (n.getAttribute('transform')||'')
    + '|' + (n.getAttribute('x')||'') + ',' + (n.getAttribute('y')||'')
  )).sort();
  return JSON.stringify({ vb, nodes });
}"""

results = []
_PAGE = None                       # set by main() once the browser page exists
_SHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_failshots")
_CUR_SECTION = "boot"              # current section label (for screenshot names + skip checks)

def set_page(page):
    global _PAGE
    _PAGE = page

def _recover(page):
    """Section-boundary cleanup (#38): dismiss any modal / open menu a PRIOR section left
    behind, so a leaked overlay backdrop can't intercept the NEXT section's first click —
    the failure mode where one section's leak aborted the whole run at a later, unrelated
    click (the cascade). Best-effort + silent: recovery must never mask or invent a real
    assertion. It touches ONLY transient chrome (modal-root, header menus) — never the
    canvas / dock / selection state sections legitimately carry forward — so on a clean run
    it is a verified no-op (no modal open ⇒ nothing happens)."""
    if page is None:
        return
    try:
        page.evaluate("""() => {
            const m = document.querySelector('#modal-root');
            if (m && !m.hidden) {
                const close = m.querySelector('.modal-backdrop[data-modal-close]') || m.querySelector('[data-modal-close]');
                if (close) close.click();         // route through the app's own closeModal
                if (!m.hidden) m.hidden = true;   // hard fallback if something kept it open
            }
            document.querySelectorAll('.menu-list:not([hidden])').forEach(el => { el.hidden = true; });
        }""")
    except Exception:
        pass   # recovery is best-effort; never let it surface as a section result

def section(name):
    """Mark the start of a named test section: scrubs any overlay a prior section leaked
    (_recover — #38 isolation), narrates progress, and tags any failing check's screenshot
    with the section label. Returns whether this section is in scope for the current --only
    filter, so a caller can gate optional/expensive work:
        if not section("Boolean ops"): ...skip heavy setup...
    Sections still run inline (shared page/state), but a leaked modal can no longer cascade
    into unrelated sections, and an outright crash is now reported per-section by the
    module-level net (see bottom of file) instead of hanging the run. Full per-section
    execution isolation (each section a standalone fn) stays deferred — low value vs the
    reindent risk on this green 2.9k-line suite."""
    global _CUR_SECTION
    _recover(_PAGE)                      # scrub leaked overlays before this section starts
    _CUR_SECTION = name
    in_scope = (not ONLY) or (ONLY.lower() in name.lower())
    print(f"\n=== {name} ==={'' if in_scope else '  (out of --only scope)'}")
    return in_scope

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail and not ok else ""))
    if not ok and _PAGE is not None:
        try:
            os.makedirs(_SHOT_DIR, exist_ok=True)
            slug = re.sub(r"[^a-z0-9]+", "-", f"{_CUR_SECTION}-{name}".lower()).strip("-")[:70]
            _PAGE.screenshot(path=os.path.join(_SHOT_DIR, f"{len(results):03d}-{slug}.png"))
        except Exception:
            pass   # screenshotting must never mask the real assertion failure

def settle(page, js, timeout=4000):
    """#33: replace a fixed wait_for_timeout that exists only to outlast a debounce/async
    write with a wait for the actual end-state (`js` returns truthy). Fast when the state
    is already there; bounded otherwise. A timeout is SWALLOWED on purpose — the assertion
    that follows then reports the real (still-wrong) state with context instead of this
    turning a behavioural failure into a raw Playwright abort."""
    try:
        page.wait_for_function(js, timeout=timeout)
    except Exception:
        pass

def node_rect(page, nid):
    return page.evaluate(
        "id => { const n = editor.nodeById(id); if(!n) return null; const r = n.getBoundingClientRect();"
        "return {x:r.left, y:r.top, w:r.width, h:r.height, cx:r.left+r.width/2, cy:r.top+r.height/2}; }", nid)

def click_node(page, nid, shift=False):
    r = node_rect(page, nid)
    if shift:
        page.keyboard.down("Shift")
        page.mouse.click(r["cx"], r["cy"])
        page.keyboard.up("Shift")
    else:
        page.mouse.click(r["cx"], r["cy"])

def mount_ctl(page):
    page.evaluate("svg => { app.selectedOutput = null; app.manualOutputName = null; mountStageFromText(svg, 'ctl.svg'); }", CTL)
    # 20s, not 8s: when this runs right after the 5000-anchor LOD stress section the
    # renderer is still busy and the adopt can take ~12s under load. It's a condition
    # wait, so a higher ceiling is free on the fast path and only saves us under load.
    page.wait_for_function("editor.stage && editor.nodeById('r2')", timeout=20000)
    page.wait_for_timeout(150)

def open_ctx_panel(page):
    """Open the right-click style+actions panel for the current selection/artboard."""
    page.evaluate("""() => {
        const sw = document.querySelector('.stage-wrap');
        const sel = [...editor.selection];
        let x = 12, y = 12, target = sw;
        if (sel.length) { const n = editor.nodeById(sel[0]); const r = n.getBoundingClientRect(); x = r.left + r.width/2; y = r.top + r.height/2; target = n; }
        target.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }""")

def set_inspector_input(page, kind, index, value, event):
    """Set the index-th style input of a given type in the context panel; dispatch `event`."""
    open_ctx_panel(page)
    page.evaluate(
        """({kind, index, value, event}) => {
            const sel = kind === 'color' ? '.context-panel input[type=color]'
                      : kind === 'number' ? '.context-panel input[type=number]'
                      : '.context-panel input[type=checkbox]';
            const el = document.querySelectorAll(sel)[index];
            if (!el) throw new Error('no style input ' + kind + ' #' + index);
            if (kind === 'checkbox') el.checked = !!value; else el.value = String(value);
            el.dispatchEvent(new Event(event, { bubbles: true }));
        }""", {"kind": kind, "index": index, "value": value, "event": event})

def set_inspector_number_by_label(page, label, value, event="change"):
    """Set the number input in the context-panel row whose label matches `label`.
    (Index-based addressing is fragile now the object panel leads with Transform X/Y/W/H.)"""
    open_ctx_panel(page)
    page.evaluate(
        """({label, value, event}) => {
            const row = [...document.querySelectorAll('.context-panel .insp-row')]
                .find(r => r.querySelector('span') && r.querySelector('span').textContent === label);
            const el = row && row.querySelector('input[type=number]');
            if (!el) throw new Error('no number input for ' + label);
            el.value = String(value); el.dispatchEvent(new Event(event, { bubbles: true }));
        }""", {"label": label, "value": value, "event": event})

def pick_color(page, swatch_index, hexes=None, none=False):
    """Summon the live Colour panel via the toolstrip fill/stroke swatch (0=fill, 1=stroke),
    fire each hex (live-applied to the selection), optionally None; edits coalesce into one
    undo on a short debounce, so wait for that. Then close the Colour panel."""
    page.click("#swatch-fill" if swatch_index == 0 else "#swatch-stroke")
    page.wait_for_function("!!document.querySelector('.cp-window')", timeout=4000)
    for h in (hexes or []):
        page.evaluate("""(v) => { const el = document.querySelector('.cp-hex input');
            el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }""", h)
    if none:
        page.click(".cp-window .cp-none")
    # wait for the coalesced "Colour" undo entry to actually commit (app.js debounces
    # editor.commitCoalesce ~280ms after the last edit, clearing editor._coalescing) before
    # closing — a condition, not a fixed 360ms. _coalescing is set true synchronously by the
    # colour-apply, so this can't return early mid-coalesce and drop the entry.
    settle(page, "() => !editor._coalescing")
    page.evaluate("window.__docks && window.__docks.close('color')")
    page.wait_for_timeout(40)

def set_opacity(page, frac):
    """Drive the object-opacity slider in the context panel (0..1)."""
    open_ctx_panel(page)
    # The panel now has several range sliders (Miter, dash Dash/Gap, Opacity), so target
    # the Opacity row by its label rather than the first range in the panel.
    page.evaluate("""(f) => {
        const row = [...document.querySelectorAll('.context-panel .insp-row')]
            .find(r => r.querySelector('span') && r.querySelector('span').textContent === 'Opacity');
        const el = row && row.querySelector('input[type=range]');
        if (!el) throw new Error('no opacity slider'); el.value = String(Math.round(f * 100));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true })); }""", frac)

def artboard_rect(page):
    return page.evaluate(
        "() => { const r = editor.artboardEl().getBoundingClientRect();"
        "return {x:r.left, y:r.top, w:r.width, h:r.height}; }")

def draw_shape(page, tool, fx0, fy0, fx1, fy1, shift=False):
    """Drag a shape across the artboard, coords given as fractions of the artboard box."""
    page.evaluate(f"editor.setTool('{tool}')")
    ab = artboard_rect(page)
    x0, y0 = ab["x"] + ab["w"] * fx0, ab["y"] + ab["h"] * fy0
    x1, y1 = ab["x"] + ab["w"] * fx1, ab["y"] + ab["h"] * fy1
    page.mouse.move(x0, y0); page.mouse.down()
    if shift: page.keyboard.down("Shift")
    page.mouse.move(x1, y1, steps=12); page.mouse.up()
    if shift: page.keyboard.up("Shift")
    page.wait_for_timeout(40)

def pen_click(page, fx, fy, drag=None):
    """Pen-tool click at an artboard fraction; pass drag=(fx,fy) to make it a curve anchor."""
    ab = artboard_rect(page)
    x, y = ab["x"] + ab["w"] * fx, ab["y"] + ab["h"] * fy
    page.mouse.move(x, y); page.mouse.down()
    if drag:
        page.mouse.move(ab["x"] + ab["w"] * drag[0], ab["y"] + ab["h"] * drag[1], steps=6)
    page.mouse.up()
    page.wait_for_timeout(30)

def curv_click(page, fx, fy, alt=False, shift=False):
    """Curvature-tool click at an artboard fraction, with optional Alt/Shift modifiers."""
    ab = artboard_rect(page)
    x, y = ab["x"] + ab["w"] * fx, ab["y"] + ab["h"] * fy
    if alt: page.keyboard.down("Alt")
    if shift: page.keyboard.down("Shift")
    page.mouse.move(x, y); page.mouse.down(); page.mouse.up()
    if shift: page.keyboard.up("Shift")
    if alt: page.keyboard.up("Alt")
    page.wait_for_timeout(30)

BOOL_DOC = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect data-hv-id="ra" x="20" y="20" width="80" height="80" fill="#3366cc"/>
  <rect data-hv-id="rb" x="60" y="60" width="80" height="80" fill="#cc3333"/>
</svg>"""   # A covers 20..100, B covers 60..140 → overlap 60..100 (40x40)

def mount_bool(page, select_both=True):
    page.evaluate("svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'bool.svg'); }", BOOL_DOC)
    page.wait_for_function("editor.stage && editor.nodeById('rb')", timeout=8000)
    if select_both:
        page.evaluate("editor.selection = new Set(['ra','rb']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector();")
    page.wait_for_timeout(60)

def result_inside(page, x, y):
    return page.evaluate(
        "([x,y]) => { const id=[...editor.selection][0]; const n=editor.nodeById(id); if(!n) return null;"
        "const pt=editor.stage.createSVGPoint(); pt.x=x; pt.y=y; return n.isPointInFill(pt); }", [x, y])

def sel_node(page):
    return page.evaluate(
        "() => { const id=[...editor.selection][0]; const n=id&&editor.nodeById(id);"
        "if(!n) return null; const a={}; for (const x of n.attributes) a[x.name]=x.value;"
        "return {tag:n.tagName.toLowerCase(), attrs:a}; }")

def n_nodes(page):
    return page.evaluate("editor.stage.querySelectorAll('[data-hv-id]').length")

def file_menu_click(page, label):
    """Open the header File menu and click the item whose label contains `label`."""
    page.click('.menu[data-menu="file"] .menu-trigger'); page.wait_for_timeout(60)
    page.click(f'.menu[data-menu="file"] .menu-item:has-text("{label}")'); page.wait_for_timeout(60)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1500, "height": 900})
        set_page(page)   # so a failing check() auto-captures a screenshot into _failshots/
        # domcontentloaded, NOT networkidle: a populated workspace fires dozens of
        # /work-items thumbnail requests on boot, so the network never idles within 30s
        # and goto() times out. Readiness is the editor globals + mounted stage below —
        # those condition waits are the real signal; networkidle was a fragile proxy.
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_function("typeof editor!=='undefined' && typeof mountStageFromText==='function'", timeout=20000)
        # Boot is async (refreshAll → mountBlankCanvas; no auto-install) and refreshAll
        # awaits mounting the newest library preview first, so the gap to the blank canvas
        # swings ~60ms–1s with disk/load. Wait for the canvas to mount (no fixed sleep).
        page.wait_for_function("()=>!!editor.stage", timeout=15000)
        # The standalone Process VIEW was dissolved into dock panels — startup mounts a
        # blank canvas directly (no process-active, no #process-view), with the pipeline
        # available in the Processor dock panel alongside.
        boot = page.evaluate("""() => ({
            stage: !!editor.stage,
            noProcessView: !document.querySelector('#process-view'),
            notProcessActive: !document.querySelector('.app.editor').classList.contains('process-active'),
            processorPanel: !!document.querySelector('.rail-section.processor'),
        })""")
        check("startup mounts a blank canvas (Process view dissolved into the Processor dock panel)",
              boot["stage"] and boot["noProcessView"] and boot["notProcessActive"] and boot["processorPanel"], str(boot))
        if not page.evaluate("!!editor.stage"):
            mount_ctl(page)

        section("A. Save on the auto-loaded (library) document")
        big_nodes = page.evaluate("editor.stage.querySelectorAll('[data-hv-id]').length")
        has_output = page.evaluate("!!window.app.selectedOutput")
        if has_output:
            file_menu_click(page, "Save")
            page.wait_for_function("/Saved|Save failed/.test(document.querySelector('#status-text').textContent)", timeout=8000)
            status = page.eval_on_selector("#status-text", "e => e.textContent")
            check("save library doc", "Saved" in status, status)
        else:
            check("save library doc (skipped, no selectedOutput)", True)

        section("B. Node tool on a HUGE path: LOD instead of refusing. A 5000-anchor path")
        # must (a) mount handles (editable, not the old hard refuse) yet (b) stay bounded
        # under the render budget so the DOM never blows up; zooming in reveals more. ----
        big_d = "M10 10 " + " ".join(
            f"L{10 + (i * 0.07) % 480:.1f} {10 + (i * 11 % 480)}" for i in range(5000))
        page.evaluate("""(d) => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
              + '<path data-hv-id="huge1" d="'+d+'" fill="none" stroke="#222" stroke-width="1"/></svg>', 'huge.svg'); }""", big_d)
        page.wait_for_timeout(120)
        page.evaluate("() => { editor.selection = new Set(['huge1']); editor.artboardSelected = false; editor._renderSelection(); editor.setTool('node'); }")
        page.wait_for_timeout(150)
        lod = page.evaluate("""() => { const ov = editor._overlayEl();
            const h = ov.querySelectorAll('.hv-handles .hv-node-anchor').length;
            return { handles: h, lod: !!editor._nodeLOD }; }""")
        check("node tool LOD: huge path mounts a bounded, editable handle set",
              0 < lod["handles"] <= 1500 and lod["lod"], str(lod))
        # zoom in: fewer anchors fall in view → finer detail (still bounded)
        zoomed = page.evaluate("""() => { for (let i=0;i<14;i++) zoomVp(viewports.output, 1.2);
            return editor._overlayEl().querySelectorAll('.hv-handles .hv-node-anchor').length; }""")
        check("node tool LOD: zooming in keeps handles bounded", 0 < zoomed <= 1500, f"zoomed={zoomed}")
        page.evaluate("() => { fitVp(viewports.output); editor.setTool('select'); }")

        section("C. Controlled 3-rect document for precise interaction tests")
        mount_ctl(page)
        check("controlled doc adopted", page.evaluate("editor.stage.querySelectorAll('[data-hv-id]').length") == 3)

        # selection by real click
        click_node(page, "r2")
        page.wait_for_timeout(80)
        sel = page.evaluate("[...editor.selection]")
        boxes = page.evaluate("editor._overlayEl().querySelectorAll('.hv-sel-box').length")
        check("click selects shape", sel == ["r2"] and boxes == 1, f"sel={sel} boxes={boxes}")

        # shift-click adds
        click_node(page, "r1", shift=True)
        check("shift-click multi-select", page.evaluate("editor.selection.size") == 2)

        # empty click selects artboard
        page.mouse.click(node_rect(page, "r2")["cx"], node_rect(page, "r2")["cy"])  # reselect single first
        page.evaluate("editor.artboardSelected=false")
        empty = page.evaluate("""() => {
            const vb = editor.stage.viewBox.baseVal; const m = editor.stage.getScreenCTM();
            const pt = new DOMPoint(vb.x+2, vb.y+vb.height-2).matrixTransform(m);  // bottom-left corner, no shape
            return {x: pt.x, y: pt.y};
        }""")
        page.mouse.click(empty["x"], empty["y"])
        page.wait_for_timeout(80)
        check("empty click selects artboard", page.evaluate("editor.artboardSelected"))

        # drag-move maps screen delta to geometry (getScreenCTM round trip)
        click_node(page, "r3")
        before = node_rect(page, "r3")
        h0 = page.evaluate("editor.history.length")
        page.mouse.move(before["cx"], before["cy"]); page.mouse.down()
        page.mouse.move(before["cx"] + 80, before["cy"] + 50, steps=10); page.mouse.up()
        page.wait_for_timeout(80)
        after = node_rect(page, "r3")
        moved_ok = abs((after["x"] - before["x"]) - 80) < 6 and abs((after["y"] - before["y"]) - 50) < 6
        check("drag moves shape by screen delta", moved_ok, f"dx={after['x']-before['x']:.1f} dy={after['y']-before['y']:.1f}")
        check("move pushed one history entry", page.evaluate("editor.history.length") == h0 + 1)

        # undo / redo
        page.keyboard.press("Control+z"); page.wait_for_timeout(60)
        undo = node_rect(page, "r3")
        check("undo restores position", abs(undo["x"] - before["x"]) < 4, f"x={undo['x']:.1f} vs {before['x']:.1f}")
        page.keyboard.press("Control+Shift+z"); page.wait_for_timeout(60)
        redo = node_rect(page, "r3")
        check("redo re-applies move", abs(redo["x"] - after["x"]) < 4)

        # inspector: fill via the unified colour picker — a whole picker session
        # (many live 'input' events + one OK) coalesces to ONE undo entry.
        click_node(page, "r1")
        page.wait_for_timeout(60)
        hf = page.evaluate("editor.history.length")
        pick_color(page, 0, hexes=["00aa00", "00cc00", "00ee00", "00ff00"])
        check("inspector fill applies", page.evaluate("editor.nodeById('r1').getAttribute('fill')") == "#00ff00")
        check("colour picker session coalesces to ONE undo entry", page.evaluate("editor.history.length") == hf + 1,
              f"delta={page.evaluate('editor.history.length')-hf}")

        # Colour panel: eyedropper + persistent swatch system (base palette, "+" to save
        # the current colour, click-to-apply, right-click to remove). It's a dockable panel
        # now (the toolstrip swatch summons it), not a modal — no OK/Cancel.
        page.evaluate("() => localStorage.removeItem('hector-vector:swatches')")
        page.click("#swatch-fill")
        page.wait_for_function("!!document.querySelector('.cp-window')", timeout=4000)
        picker = page.evaluate("""() => ({
            eyedropper: !!document.querySelector('.cp-eyedrop'),
            base: document.querySelectorAll('.cp-swatches .cp-sw:not(.cp-sw-add)').length,
            embedded: !!document.querySelector('.cp-window.cp-embedded'),
            noOk: !document.querySelector('.cp-ok') })""")
        check("Colour is an embedded panel editor (no OK/Cancel)", picker["embedded"] and picker["noOk"], f"{picker}")
        check("picker exposes an eyedropper button", picker["eyedropper"])
        check("picker shows a base swatch palette", picker["base"] >= 10, f"base={picker['base']}")
        page.evaluate("""() => { const el = document.querySelector('.cp-hex input');
            el.value = '123456'; el.dispatchEvent(new Event('input', { bubbles: true })); }""")
        page.click(".cp-sw-add"); page.wait_for_timeout(40)
        saved = page.evaluate("() => JSON.parse(localStorage.getItem('hector-vector:swatches') || '[]')")
        first_hex = (saved[0].get("c") if (saved and isinstance(saved[0], dict)) else (saved[0] if saved else None))
        check("saving a swatch persists it", bool(saved) and first_hex.lower() == "#123456", f"saved={saved}")
        page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)

        section("Colour panel: RGB/HSL/HSB model tabs + recent-colours strip")
        page.evaluate("() => { localStorage.removeItem('hector-vector:swatches-recent'); localStorage.removeItem('hector-vector:cp-model'); }")
        page.click("#swatch-fill"); page.wait_for_function("!!document.querySelector('.cp-window')", timeout=4000)
        check("colour panel has RGB/HSL/HSB model tabs",
              page.evaluate("[...document.querySelectorAll('.cp-tab')].map(t=>t.dataset.m)") == ["rgb", "hsl", "hsb"])
        page.evaluate("""() => { const el=document.querySelector('.cp-hex input'); el.value='ff0000'; el.dispatchEvent(new Event('input',{bubbles:true})); }""")
        page.click(".cp-tab[data-m=hsl]"); page.wait_for_timeout(40)
        hsl = page.evaluate("""() => ({ h:+document.querySelector('.cp-triple input[data-k=h]').value,
            s:+document.querySelector('.cp-triple input[data-k=s]').value,
            l:+document.querySelector('.cp-triple input[data-k=l]').value })""")
        check("HSL tab reads correct H/S/L for red", hsl == {"h": 0, "s": 100, "l": 50}, str(hsl))
        page.evaluate("""() => { const el=document.querySelector('.cp-triple input[data-k=l]'); el.value='25'; el.dispatchEvent(new Event('input',{bubbles:true})); }""")
        page.wait_for_timeout(40)
        check("editing an HSL field applies", page.evaluate("document.querySelector('.cp-hex input').value.toLowerCase()") == "800000")
        page.click(".cp-tab[data-m=hsb]"); page.wait_for_timeout(40)
        check("HSB tab exposes H/S/B", page.evaluate("!!document.querySelector('.cp-triple input[data-k=v]')"))
        check("the chosen colour model persists", page.evaluate("localStorage.getItem('hector-vector:cp-model')") == "hsb")
        page.evaluate("""() => { const el=document.querySelector('.cp-hex input'); el.value='3366cc'; el.dispatchEvent(new Event('input',{bubbles:true})); }""")
        settle(page, "() => (JSON.parse(localStorage.getItem('hector-vector:swatches-recent')||'[]')).some(c => c.toLowerCase()==='#3366cc')")  # the recents debounce, waited as a condition not a fixed 820ms
        rec = page.evaluate("() => JSON.parse(localStorage.getItem('hector-vector:swatches-recent')||'[]')")
        check("recent colours are tracked", any(c.lower() == "#3366cc" for c in rec), str(rec))
        check("recent strip is shown", page.evaluate("() => { const r=document.querySelector('.cp-recent'); return !!r && !r.hidden; }"))
        page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)

        # MAIN colour = a fill/stroke DUO, summoned by the toolstrip fill swatch; X toggles
        # the field's target, Shift+X swaps. Edits apply LIVE (the panel has no Cancel).
        page.click("#swatch-fill")
        page.wait_for_selector(".cp-window", timeout=4000)
        duo = page.evaluate("""() => ({
            isDuo: !!document.querySelector('.cp-side.duo'),
            targets: [...document.querySelectorAll('.cp-side .cp-target-lab')].map(t => t.textContent),
            active: document.querySelector('.cp-target.active .cp-target-lab')?.textContent })""")
        check("main colour is a fill/stroke duo",
              duo["isDuo"] and duo["targets"] == ["Fill", "Stroke"] and duo["active"] == "Fill", f"{duo}")
        set_hex = lambda v: page.evaluate("""(v) => { const el = document.querySelector('.cp-hex input');
            el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }""", v)
        set_hex("abc123"); page.wait_for_timeout(30)
        page.keyboard.press("x"); page.wait_for_timeout(30)   # → edit Stroke
        active2 = page.evaluate("() => document.querySelector('.cp-target.active .cp-target-lab')?.textContent")
        set_hex("def456"); page.wait_for_timeout(30)
        mid = page.evaluate("""() => ({ fill: editor.nodeById('r1').getAttribute('fill'),
            stroke: editor.nodeById('r1').getAttribute('stroke') })""")
        check("X switches the field to the stroke target (live apply)",
              active2 == "Stroke" and mid["fill"] == "#abc123" and mid["stroke"] == "#def456", f"active={active2} {mid}")
        page.keyboard.press("Shift+X"); page.wait_for_timeout(30)
        swapped = page.evaluate("""() => ({ fill: editor.nodeById('r1').getAttribute('fill'),
            stroke: editor.nodeById('r1').getAttribute('stroke') })""")
        check("Shift+X swaps fill/stroke", swapped["fill"] == "#def456" and swapped["stroke"] == "#abc123", f"{swapped}")
        settle(page, "() => !editor._coalescing"); page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)   # commit the coalesced undo (condition, not 320ms) before closing

        # inspector: stroke width (the v0 'stroke not applied' regression). Addressed by
        # row label now that Transform (X/Y/W/H) leads the object panel.
        set_inspector_number_by_label(page, "Width", "5")
        page.wait_for_timeout(60)
        sw = page.evaluate("editor.nodeById('r1').getAttribute('stroke-width')")
        sk = page.evaluate("editor.nodeById('r1').getAttribute('stroke')")
        check("inspector stroke applies", sw and float(sw) == 5 and bool(sk), f"width={sw} stroke={sk}")

        # inspector: object opacity via the slider
        set_opacity(page, 0.5)
        page.wait_for_timeout(60)
        check("inspector opacity applies", page.evaluate("editor.nodeById('r1').getAttribute('opacity')") == "0.5")

        # inspector: stroke cap. Cap is CONTEXTUAL (only with open ends or a dash pattern),
        # and r1 is a closed solid rect, so apply dashes first to reveal the Cap seg.
        open_ctx_panel(page)
        page.evaluate("editor.setStrokeAttr('stroke-dasharray','6 4'); editor._renderInspector();"); page.wait_for_timeout(50)
        seg_active = page.evaluate("""() => { const row=[...document.querySelectorAll('.context-panel .insp-row')]
            .find(r=>r.querySelector('span')&&r.querySelector('span').textContent==='Cap');
            const seg=row.querySelector('.insp-seg');
            const btn=[...seg.querySelectorAll('.insp-seg-btn')].find(b => b.title === 'Round'); btn.click();
            const a = seg.querySelector('.insp-seg-btn.active'); return a && a.title; }""")
        page.wait_for_timeout(40)
        check("stroke cap via segmented control", page.evaluate("editor.nodeById('r1').getAttribute('stroke-linecap')") == "round")
        # the segmented control updates its OWN active highlight (the 'unresponsive panel' fix)
        check("segmented control reflects the active option", seg_active == "Round", f"active={seg_active}")
        # Cap sits UNDER Dashes (it shapes the dash/dot ends)
        order = page.evaluate("""() => { const g=[...document.querySelectorAll('.context-panel .insp-group')]
            .find(g=>{const t=g.querySelector('.insp-title');return t&&t.textContent==='Stroke';});
            return [...g.querySelectorAll('.insp-row > span')].map(s=>s.textContent); }""")
        check("Cap row sits under Dashes", "Dashes" in order and "Cap" in order and order.index("Cap") > order.index("Dashes"), str(order))
        # Dash/Gap sliders now have a numeric readout
        check("dash sliders show numeric values",
              page.evaluate("document.querySelectorAll('.context-panel .insp-dash-val').length") >= 2)
        page.evaluate("editor.setStrokeAttr('stroke-dasharray',null); editor._renderInspector();"); page.wait_for_timeout(40)
        # Miter row is contextual — present for a miter join, gone for round/bevel (it
        # appears/disappears rather than greying out). A new stroke seeds a round join, so
        # set miter first, then clicking the Join seg to round must re-render it away.
        has_miter = lambda: page.evaluate("""() => [...document.querySelectorAll('.context-panel .insp-row > span, .context-panel .insp-field > span')].some(s=>s.textContent==='Miter')""")
        page.evaluate("editor.setStrokeAttr('stroke-linejoin','miter'); editor._renderInspector();"); page.wait_for_timeout(50)
        check("Miter row present for a miter join", has_miter())
        page.evaluate("""() => { const join=[...document.querySelectorAll('.context-panel .insp-seg')]
            .find(s=>[...s.querySelectorAll('.insp-seg-btn')].some(b=>b.title==='Bevel'));
            const round=[...join.querySelectorAll('.insp-seg-btn')].find(b=>b.title==='Round'); round.click(); }""")
        page.wait_for_timeout(60)
        check("Miter row hidden for a non-miter join (seg re-render)", not has_miter())
        # drag-to-scrub: dragging the Width label changes stroke-width (invisible slider)
        open_ctx_panel(page)
        lbl = page.evaluate("""() => { const sp = [...document.querySelectorAll('.context-panel .insp-row > span')]
            .find(s => s.textContent === 'Width'); if (!sp) return null;
            sp.scrollIntoView({ block: 'center' });   // Stroke now sits below Transform/Align/Arrange — bring it into the panel's scroll viewport
            const r = sp.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }""")
        w0 = page.evaluate("parseFloat(editor.nodeById('r1').getAttribute('stroke-width'))")
        page.mouse.move(lbl["x"], lbl["y"]); page.mouse.down()
        page.mouse.move(lbl["x"] + 40, lbl["y"], steps=10); page.mouse.up(); page.wait_for_timeout(50)
        w1 = page.evaluate("parseFloat(editor.nodeById('r1').getAttribute('stroke-width'))")
        check("drag-scrub label changes the value", w1 > w0, f"{w0} -> {w1}")
        open_ctx_panel(page)
        # dash editor: pick the "Dashed" preset → composes a "dash gap" stroke-dasharray
        page.evaluate("""() => { const b = [...document.querySelectorAll('.context-panel .insp-seg-btn')]
            .find(x => x.dataset.mode === 'dashed'); b.click(); }""")
        page.wait_for_timeout(40)
        da = page.evaluate("editor.nodeById('r1').getAttribute('stroke-dasharray')")
        check("stroke dashes apply", bool(da) and len(da.split()) == 2, f"dasharray={da}")
        # "Dotted" forces dash→0 and a round cap so it renders as round dots
        page.evaluate("""() => { const b = [...document.querySelectorAll('.context-panel .insp-seg-btn')]
            .find(x => x.dataset.mode === 'dotted'); b.click(); }""")
        page.wait_for_timeout(40)
        dot = page.evaluate("""() => ({ da: editor.nodeById('r1').getAttribute('stroke-dasharray'),
            cap: editor.nodeById('r1').getAttribute('stroke-linecap') })""")
        check("dotted preset → 0-length dashes + round cap", dot["da"].split()[0] == "0" and dot["cap"] == "round", f"{dot}")
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()")   # the panel persists now — tuck it away so it doesn't cover later canvas clicks

        # D shortcut → default white fill / black stroke on the selection
        page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
        page.keyboard.press("d"); page.wait_for_timeout(40)
        dstate = page.evaluate("""() => { const n = editor.nodeById('r1');
            return { fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke') }; }""")
        check("D sets default fill/stroke", dstate["fill"] == "#ffffff" and dstate["stroke"] == "#000000", str(dstate))

        # delete
        page.keyboard.press("Escape")   # close the style panel before clicking the canvas
        click_node(page, "r2"); page.wait_for_timeout(50)
        page.keyboard.press("Delete"); page.wait_for_timeout(60)
        check("delete removes node", page.evaluate("!editor.nodeById('r2')") and page.evaluate("editor.selection.size") == 0)

        # artboard resize via inspector
        page.evaluate("editor.artboardSelected=true; editor.selection=new Set(); editor._renderSelection(); editor._renderInspector();")
        page.wait_for_timeout(60)
        set_inspector_input(page, "number", 0, "321", "change")  # width
        set_inspector_input(page, "number", 1, "217", "change")  # height
        page.wait_for_timeout(60)
        check("artboard resize updates viewBox", page.evaluate("editor.stage.getAttribute('viewBox')") == "0 0 321 217")

        # node tool on small doc mounts draggable handles, drag is undoable
        mount_ctl(page)
        page.evaluate("editor.setTool('node')")
        page.wait_for_timeout(120)
        nh = page.evaluate("editor._overlayEl().querySelectorAll('.hv-handle').length")
        check("node tool mounts handles (small doc)", nh > 0, f"handles={nh}")
        if nh > 0:
            hpos = page.evaluate("() => { const c = editor._overlayEl().querySelector('.hv-handle'); const r = c.getBoundingClientRect(); return {cx:r.left+r.width/2, cy:r.top+r.height/2}; }")
            hh = page.evaluate("editor.history.length")
            page.mouse.move(hpos["cx"], hpos["cy"]); page.mouse.down()
            page.mouse.move(hpos["cx"] + 25, hpos["cy"] + 0, steps=8); page.mouse.up()
            page.wait_for_timeout(80)
            check("node drag is undoable", page.evaluate("editor.history.length") >= hh + 1)
        page.evaluate("editor.setTool('select')")

        section("D. Stress: zoom+pan drag accuracy, multi-move, none-toggles, undo consistency")
        mount_ctl(page)

        # drag accuracy must hold under zoom + pan (catches double-scaling of the CTM)
        page.evaluate("""() => { const vp = viewports.output; vp.scale = 3.1; vp.x = 90; vp.y = -40; applyViewportState(vp); }""")
        page.wait_for_timeout(60)
        click_node(page, "r1")
        b = node_rect(page, "r1")
        page.mouse.move(b["cx"], b["cy"]); page.mouse.down()
        page.mouse.move(b["cx"] + 60, b["cy"] + 35, steps=10); page.mouse.up()
        page.wait_for_timeout(60)
        a = node_rect(page, "r1")
        zoom_ok = abs((a["x"] - b["x"]) - 60) < 6 and abs((a["y"] - b["y"]) - 35) < 6
        check("drag accurate under zoom+pan", zoom_ok, f"dx={a['x']-b['x']:.1f} dy={a['y']-b['y']:.1f}")
        page.evaluate("() => { const vp = viewports.output; vp.scale = vp.fitScale||1; vp.x=0; vp.y=0; applyViewportState(vp); }")

        # multi-select move: both shapes move by the same screen delta
        mount_ctl(page)
        click_node(page, "r1"); click_node(page, "r2", shift=True)
        r1b, r2b = node_rect(page, "r1"), node_rect(page, "r2")
        page.mouse.move(r1b["cx"], r1b["cy"]); page.mouse.down()
        page.mouse.move(r1b["cx"] + 30, r1b["cy"] + 20, steps=8); page.mouse.up()
        page.wait_for_timeout(60)
        r1a, r2a = node_rect(page, "r1"), node_rect(page, "r2")
        multi_ok = abs((r1a["x"]-r1b["x"])-30) < 6 and abs((r2a["x"]-r2b["x"])-30) < 6 and abs((r2a["y"]-r2b["y"])-20) < 6
        check("multi-select moves all together", multi_ok)

        # fill 'none' + stroke width 0 removes the attributes cleanly
        mount_ctl(page)
        click_node(page, "r3"); page.wait_for_timeout(50)
        pick_color(page, 0, none=True)      # fill → None via the picker
        page.wait_for_timeout(50)
        check("fill none via picker", page.evaluate("editor.nodeById('r3').getAttribute('fill')") == "none")
        set_inspector_number_by_label(page, "Width", "4"); page.wait_for_timeout(40)
        set_inspector_number_by_label(page, "Width", "0"); page.wait_for_timeout(40)
        check("stroke width 0 removes stroke", page.evaluate("!editor.nodeById('r3').getAttribute('stroke')"))

        # undo consistency: a batch of mixed ops fully undoes back to the baseline document
        mount_ctl(page)
        base = page.evaluate(SUMMARY)
        click_node(page, "r1"); pick_color(page, 0, hexes=["0000ff"]); page.wait_for_timeout(40)
        page.keyboard.press("Escape")   # close the style panel before clicking the canvas
        click_node(page, "r2")
        rr = node_rect(page, "r2"); page.mouse.move(rr["cx"], rr["cy"]); page.mouse.down(); page.mouse.move(rr["cx"]+33, rr["cy"]+22, steps=6); page.mouse.up()
        page.wait_for_timeout(40)
        click_node(page, "r3"); page.keyboard.press("Delete"); page.wait_for_timeout(40)
        page.evaluate("while (editor.history.length) editor.undo();")
        page.wait_for_timeout(60)
        after_undo = page.evaluate(SUMMARY)
        check("full undo returns to baseline", after_undo == base, f"\n   base={base}\n   undo={after_undo}")
        n_redo = page.evaluate("editor.redo.length")
        page.evaluate("while (editor.redo.length) editor.redoAction();")
        page.wait_for_timeout(60)
        check("redo replays all ops", page.evaluate("editor.redo.length") == 0 and n_redo >= 3, f"redo_steps={n_redo}")

        section("E. Phase 2: invert-space, duplicate, z-order")
        mount_ctl(page)
        # duplicate (Cmd/Ctrl+D)
        click_node(page, "r1"); page.wait_for_timeout(40)
        n_before = page.evaluate("editor._artworkNodes().length")
        page.keyboard.press("Control+d"); page.wait_for_timeout(60)
        n_after = page.evaluate("editor._artworkNodes().length")
        check("duplicate adds a node + selects clone", n_after == n_before + 1 and page.evaluate("editor.selection.size") == 1,
              f"{n_before}->{n_after}")
        page.keyboard.press("Control+z"); page.wait_for_timeout(50)
        check("duplicate is undoable", page.evaluate("editor._artworkNodes().length") == n_before)

        # z-order: send a node to back -> it becomes the first artwork child
        click_node(page, "r2"); page.wait_for_timeout(40)
        page.evaluate("editor.reorder('back')"); page.wait_for_timeout(50)
        check("send to back reorders DOM", page.evaluate("editor._artworkNodes()[0].getAttribute('data-hv-id')") == "r2")
        page.evaluate("editor.reorder('front')"); page.wait_for_timeout(50)
        ids = page.evaluate("editor._artworkNodes().map(n=>n.getAttribute('data-hv-id'))")
        check("bring to front reorders DOM", ids[-1] == "r2", f"order={ids}")

        # invert-space: selecting nothing inverts the whole graphic into one path
        # (artboard outline + a hole per shape → ≥4 subpaths)
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=false; editor.invertSpace();")
        page.wait_for_timeout(60)
        inv = page.evaluate("""() => {
            const arts = editor._artworkNodes();
            const p = arts.length === 1 ? arts[0] : null;
            return { n: arts.length, tag: p && p.tagName.toLowerCase(), rule: p && p.getAttribute('fill-rule'),
                     subpaths: p ? (p.getAttribute('d').match(/M/g)||[]).length : 0 };
        }""")
        check("invert-space makes one compound path with holes", inv["n"] == 1 and inv["tag"] == "path"
              and inv["rule"] == "nonzero" and inv["subpaths"] >= 4, str(inv))
        page.keyboard.press("Control+z"); page.wait_for_timeout(50)
        check("invert-space is undoable", page.evaluate("editor._artworkNodes().length") == 3)

        # tool buttons carry their shortcut letter (rendered as a corner badge via CSS)
        badges = page.evaluate("""() => { const tb = [...document.querySelectorAll('.tool-button[data-tool]')];
            return { total: tb.length, keyed: tb.filter(b => (b.getAttribute('data-key') || '').length >= 1).length,
                     pen: document.querySelector('.tool-button[data-tool=pen]').getAttribute('data-key') }; }""")
        check("tool buttons have shortcut badges", badges["total"] >= 7 and badges["keyed"] == badges["total"] and badges["pen"] == "P", str(badges))
        # V and A are the two primary tools; marquee + transform tool buttons are gone
        check("toolstrip unified to V/A primaries (no marquee/transform buttons)",
              page.evaluate("""() => !document.querySelector('.tool-button[data-tool=marquee]')
                  && !document.querySelector('.tool-button[data-tool=transform]')
                  && document.querySelectorAll('.tool-button.tool-primary').length === 2 """))
        # viewport controls are standardized badged buttons too
        check("viewport controls have shortcut badges",
              page.evaluate("""() => { const v = [...document.querySelectorAll('.viewport-controls .tool-button[data-key]')];
                  return v.length >= 5 && v.every(b => b.getAttribute('data-key')); }"""))

        # transform box is correct for a shape carrying a non-translate transform
        # (the imported-shape "bounding box bugs out" regression)
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">'
              + '<rect data-hv-id="m1" x="10" y="10" width="50" height="50" fill="#888" transform="matrix(1.8 0 0 1.8 60 60)"/></svg>','m.svg'); }""")
        page.wait_for_timeout(120)
        page.evaluate("() => { editor.setTool('select'); editor.selection = new Set(['m1']); editor.enterTransform('scale'); }")
        page.wait_for_timeout(60)
        mbox = page.evaluate("""() => { const bx = document.querySelector('.hv-xform-box'); const sh = editor.nodeById('m1');
            if (!bx) return null; const r = bx.getBoundingClientRect(), q = sh.getBoundingClientRect();
            return Math.max(Math.abs(r.left-q.left), Math.abs(r.top-q.top), Math.abs(r.right-q.right), Math.abs(r.bottom-q.bottom)); }""")
        check("transform box aligns with a matrix-transformed shape", mbox is not None and mbox < 2, f"max offset={mbox}")

        # rotate mode (enterTransform 'rotate'): resize handles hidden, corner rotators shown
        page.evaluate("() => editor.enterTransform('rotate')"); page.wait_for_timeout(60)
        rmode = page.evaluate("""() => ({ rot: document.querySelectorAll('.hv-xform-rot').length,
            resize: document.querySelectorAll('.hv-xform-handle').length }) """)
        check("rotate mode shows rotators, hides resize handles", rmode["rot"] == 4 and rmode["resize"] == 0, str(rmode))
        # rotation handles sit OUTSIDE the corners now — grab one directly and rotate
        rb = page.evaluate("""() => { const z = document.querySelector('.hv-xform-rot'); const bx = document.querySelector('.hv-xform-box').getBoundingClientRect();
            const r = z.getBoundingClientRect(); return { cx:(bx.left+bx.right)/2, cy:(bx.top+bx.bottom)/2, zx:r.left+r.width/2, zy:r.top+r.height/2 }; }""")
        import math as _m
        rad = _m.hypot(rb["zx"] - rb["cx"], rb["zy"] - rb["cy"]) or 1; a0 = _m.atan2(rb["zy"] - rb["cy"], rb["zx"] - rb["cx"])
        page.mouse.move(rb["zx"], rb["zy"]); page.mouse.down()
        page.mouse.move(rb["cx"] + rad * _m.cos(a0 + _m.pi / 6), rb["cy"] + rad * _m.sin(a0 + _m.pi / 6), steps=12); page.mouse.up()
        page.wait_for_timeout(60)
        rotated = page.evaluate("() => { const c = editor.nodeById('m1').transform.baseVal.consolidate(); return c ? Math.abs(c.matrix.b) > 0.05 : false; }")
        check("corner rotator rotates the selection", rotated)
        page.evaluate("() => editor.clearXform()")

        # Regressions: a rotated object must survive move + node-edit (it carries a matrix).
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">'
              + '<path data-hv-id="rt" d="M60 60 L140 200 L40 180 Z" fill="#888" transform="rotate(25 100 130)"/></svg>','rt.svg'); }""")
        page.wait_for_timeout(120)
        # move it (drag the body) — rotation (matrix b) must survive, not snap to a plain translate
        page.evaluate("() => { editor.setTool('select'); editor.selection = new Set(['rt']); editor._renderSelection(); }")
        rr = page.evaluate("() => { const r = editor.nodeById('rt').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; }")
        page.mouse.move(rr["x"], rr["y"]); page.mouse.down(); page.mouse.move(rr["x"]+40, rr["y"]+25, steps=8); page.mouse.up(); page.wait_for_timeout(50)
        moved_keeps_rot = page.evaluate("() => { const c = editor.nodeById('rt').transform.baseVal.consolidate(); return c ? Math.abs(c.matrix.b) > 0.05 : false; }")
        check("moving a rotated object preserves its rotation", moved_keeps_rot)
        # node tool bakes the rotation into geometry so handles line up (transform cleared)
        page.evaluate("() => editor.setTool('node')"); page.wait_for_timeout(80)
        baked = page.evaluate("() => !(editor.nodeById('rt').getAttribute('transform') || '').trim()")
        align = page.evaluate("""() => { const m = editor.stage.getScreenCTM();
            const a = hv.pathToAnchors(editor.nodeById('rt')).anchors[0];
            const pt = new DOMPoint(a.x, a.y).matrixTransform(m);
            const anc = editor._overlayEl().querySelector('.hv-node-anchor'); const r = anc.getBoundingClientRect();
            return Math.hypot(r.left + r.width/2 - pt.x, r.top + r.height/2 - pt.y); }""")
        check("node tool flattens rotation; handles align", baked and align is not None and align < 3, f"baked={baked} off={align}")
        # round + Alt-convert work on the (now flat) path
        page.evaluate("() => { editor._nodeSel = new Set(['rt#1']); editor.setSelectedAnchorsType('smooth'); }"); page.wait_for_timeout(30)
        rounded = page.evaluate("() => { const a = hv.pathToAnchors(editor.nodeById('rt')).anchors[1]; return !!(a.in && a.out); }")
        page.evaluate("() => editor._altClickAnchor({ el: editor.nodeById('rt'), k: 1, kind: 'anchor' })"); page.wait_for_timeout(30)
        cornered = page.evaluate("""() => { const a = hv.pathToAnchors(editor.nodeById('rt')).anchors[1];
            const real = (h) => h && Math.hypot(h.x-a.x, h.y-a.y) > 1e-6; return !(real(a.in) || real(a.out)); }""")
        check("round → smooth and Alt-click → corner both work", rounded and cornered, f"round={rounded} corner={cornered}")
        page.evaluate("() => editor.setTool('select')")

        section("F. Header structure (the standalone Process VIEW is dissolved into panels)")
        # The old disconnected Process VIEW (a modal #process-view + its #process-button) is gone.
        # NB: #view-edit / #view-manage now belong to the NEW Edit/Manage screen swap (Section Z),
        # a different feature — so we no longer assert their absence here.
        check("Process view fully removed (no #process-view modal, no #process-button)",
              page.evaluate("!document.querySelector('#process-view') && !document.querySelector('#process-button')"))
        # the q/Tab Process-view shortcut is GONE — its shims are removed (q is a free key now).
        page.keyboard.press("q"); page.keyboard.press("Tab"); page.wait_for_timeout(40)
        check("q / Tab Process-view shortcut + shims removed",
              page.evaluate("() => typeof window.showProcessView === 'undefined' && typeof window.showEditView === 'undefined'"))
        # footer Jobs button removed (redundant with the Jobs dock panel)
        check("footer Jobs button removed", page.evaluate("!document.querySelector('#jobs-button')"))
        # brand removed → header is action-only
        check("brand removed from header", page.evaluate("!document.querySelector('.brand')"))
        # header: File ▾ menu (left), Process centered, no loose New/Open/Save/Export buttons
        check("File menu replaces loose header buttons", page.evaluate(
            "!!document.querySelector('.menu[data-menu=\"file\"]') && !document.querySelector('#open-button') && !document.querySelector('#save-button')"))
        file_menu_click(page, "Open vector")
        check("File menu Open opens the browser", page.evaluate("!document.querySelector('#modal-root').hidden"))
        page.evaluate("closeModal()")

        # File ▸ Settings… opens the general settings (prefs + install + about)
        file_menu_click(page, "Settings")
        settings = page.evaluate("""() => ({
            title: document.querySelector('#modal-title').textContent,
            toggles: document.querySelectorAll('#modal-body input[type=checkbox]').length,
            startup: !![...document.querySelectorAll('#modal-body .form-label')].find(e => e.textContent === 'On launch'),
            about: !!document.querySelector('#modal-body .about-block'),
            install: [...document.querySelectorAll('#modal-body .form-label')].some(e => e.textContent === 'Desktop app'),
            source: [...document.querySelectorAll('#modal-body .form-label')].some(e => e.textContent === 'Folder')
                    && [...document.querySelectorAll('#modal-body button')].some(b => b.textContent.trim() === 'Set source'),
        })""")
        check("Settings modal has prefs + install + about",
              settings["title"] == "Settings" and settings["toggles"] >= 1 and settings["startup"] and settings["about"] and settings["install"], str(settings))
        # the library-source switcher has a UI entry point again (was orphaned; backend /api/source always worked)
        check("Settings modal exposes the library source folder switcher", settings["source"], str(settings))
        # changing the startup choice persists to localStorage
        page.evaluate("""() => { const s = document.querySelector('#modal-body select');
            s.value = 'resume'; s.dispatchEvent(new Event('change', { bubbles: true })); }""")
        check("settings startup choice persists", page.evaluate("JSON.parse(localStorage.getItem('hector-vector:prefs')).startup") == "resume")
        page.evaluate("""() => { localStorage.setItem('hector-vector:prefs', JSON.stringify({startup:'blank', smartGuides:true})); closeModal(); }""")
        # NOTE: action buttons / header tiles are MOVABLE customize-layout tiles (any .tool-button
        # can be dragged between the toolstrip / stage-toolbar / action bar / panel headers, and the
        # arrangement persists). So we assert REACHABILITY — the control exists once and is wired —
        # NOT which bar it currently sits in. Placement/move/persist/reset behaviour is covered by
        # the customize-layout tests below; pinning a movable tile to a fixed bar is a fragile test.
        check("undo/redo controls are reachable",
              page.evaluate("""!!document.querySelector('#undo-button') && !!document.querySelector('#redo-button')"""))
        check("reorder / group / rename / delete + cleanup / merge controls are reachable",
              page.evaluate("""['layer-front','layer-forward','layer-backward','layer-back','layer-group','layer-ungroup','layer-rename','layer-delete','layer-cleanup','layer-merge']
                .every(id => !!document.querySelector('#' + id))"""))
        check("clipboard + boolean + transform controls are reachable",
              page.evaluate("""['act-cut','act-copy','act-paste','act-duplicate','act-union','act-subtract','act-intersect','act-rotate-cw','act-rotate-ccw','act-flip-h','act-flip-v']
                .every(id => !!document.querySelector('#' + id))"""))
        # invert-space lives in exactly ONE place (the movable Object-panel-header ⊠ tile) — a count,
        # not a location, so it survives the tile being dragged to another bar but catches duplication.
        check("invert-space is a single reachable tile (not duplicated across bars)",
              page.evaluate("""() => { const inv = [...document.querySelectorAll('.tool-button')].filter(b => /invert/i.test(b.title));
                return inv.length === 1; }"""))
        page.evaluate("window.__docks.showColor()"); page.wait_for_timeout(60)
        check("cycle-background is a single reachable tile",
              page.evaluate("""() => { const bg = [...document.querySelectorAll('.tool-button')].filter(b => /background/i.test(b.title));
                return bg.length === 1; }"""))
        check("panel header action areas are layout-bar receivers",
              page.evaluate("!!document.querySelector('.rail-section.color .panel-actions.hdr-slots.layout-bar')"))
        page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)

        # --- customizable picture-frame layout (right-click a frame bar; auto-save + profiles) ---
        # all four bars share the one .tool-button object so they match
        check("every frame bar uses the shared .tool-button class",
              page.evaluate("""['.toolstrip','.stage-toolbar','.actionbar','.viewport-controls']
                .every(s => document.querySelectorAll(s + ' .tool-button').length > 0)
                && !document.querySelector('.vp-btn')"""))
        # the Layout control is no longer a header button — it's the frame's right-click menu
        check("Layout header button is gone; right-clicking a frame bar opens the Layout menu",
              page.evaluate("""() => {
                if (document.querySelector('.menu[data-menu="layout"]')) return false;   // header dropdown removed
                document.querySelector('.toolstrip').dispatchEvent(new MouseEvent('contextmenu',
                  {bubbles:true, cancelable:true, clientX:20, clientY:20}));
                const menu = document.querySelector('.context-menu');
                const ok = !!menu && [...menu.querySelectorAll('.menu-item')]
                  .some(b => /Customize layout/.test(b.textContent));
                document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); return ok; }"""))
        # customize mode (via the exposed controller) makes frame tiles draggable
        page.evaluate("window.__layout.toggleEdit()")
        check("customize mode makes frame tiles draggable",
              page.evaluate("""!!document.querySelector('.app.editor.customizing')
                && document.querySelector('.toolstrip .tool-button').draggable === true"""))
        # the bottom bar (the full-width .panel-foot, not just its centered button cluster)
        # turns blue in customize mode — same tint as the top toolstrip
        check("customize mode tints the whole bottom bar blue (panel-foot, like the toolstrip)",
              page.evaluate("""() => { const f=getComputedStyle(document.querySelector('.panel-foot')).backgroundColor;
                const t=getComputedStyle(document.querySelector('.toolstrip')).backgroundColor;
                return f===t && f!=='rgba(0, 0, 0, 0)' && f!=='transparent'; }"""))
        # move the Pen tile into the action bar; arrangement auto-saves
        page.evaluate("() => { const pen = document.querySelector('.toolstrip [data-tool=pen]'); document.querySelector('.actionbar').appendChild(pen); window.__layout.save(); }")
        check("moved tile auto-saves into the layout",
              page.evaluate("""() => { const L = JSON.parse(localStorage.getItem('hector-vector:layout') || '{}');
                return !!document.querySelector('.actionbar [data-tool=pen]')
                  && L.actions.includes('tool:pen') && !L.tools.includes('tool:pen'); }"""))
        # save it as a named profile, then reset to default
        page.evaluate("window.__layout.saveProfile('Test'); window.__layout.reset()")
        check("Reset restores the default layout and clears storage",
              page.evaluate("""() => !!document.querySelector('.toolstrip [data-tool=pen]')
                && !document.querySelector('.actionbar [data-tool=pen]')
                && localStorage.getItem('hector-vector:layout') === null"""))
        # the saved profile is listed and re-applies the arrangement
        check("a saved profile re-applies the arrangement",
              page.evaluate("""() => { if (!window.__layout.listProfiles().includes('Test')) return false;
                window.__layout.applyProfile('Test');
                return !!document.querySelector('.actionbar [data-tool=pen]'); }"""))
        # profiles can be renamed and deleted (was: "clunky, cant delete or edit profiles")
        check("a profile can be renamed",
              page.evaluate("""() => { window.__layout.renameProfile('Test','Renamed');
                const L = window.__layout.listProfiles(); return L.includes('Renamed') && !L.includes('Test'); }"""))
        check("a profile can be deleted",
              page.evaluate("""() => { window.__layout.deleteProfile('Renamed'); return !window.__layout.listProfiles().includes('Renamed'); }"""))
        # the Layout right-click menu renders each profile as a manageable row (rename ✎ / delete ✕)
        check("Layout right-click menu shows rename/delete on a profile row",
              page.evaluate("""() => { window.__layout.saveProfile('Row');
                document.querySelector('.toolstrip').dispatchEvent(new MouseEvent('contextmenu',
                  {bubbles:true, cancelable:true, clientX:20, clientY:20}));
                const rows=[...document.querySelectorAll('.context-menu .menu-row')];
                const ok = rows.some(r => r.querySelector('.menu-rowlabel') && r.querySelectorAll('.menu-rowbtn').length===2);
                document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
                window.__layout.deleteProfile('Row'); return ok; }"""))
        # --- active-profile STATE: selection is tracked, divergence shows as "edited" ---
        page.evaluate("window.__layout.reset()")
        check("Default is the active baseline after reset",
              page.evaluate("window.__layout.activeProfile() === null && window.__layout.isDirty() === false"))
        # save current as a profile → it becomes the active selection (and persists)
        page.evaluate("window.__layout.saveProfile('StateP')")
        check("saving a profile makes it the active selection",
              page.evaluate("""window.__layout.activeProfile() === 'StateP'
                && window.__layout.isDirty() === false
                && localStorage.getItem('hector-vector:layout-active') === 'StateP'"""))
        # mutate the live arrangement → active profile is now dirty ("edited"), selection unchanged
        page.evaluate("() => { const pen=document.querySelector('.toolstrip [data-tool=pen]'); document.querySelector('.actionbar').appendChild(pen); window.__layout.save(); }")
        check("editing a selected profile marks it dirty without losing the selection",
              page.evaluate("window.__layout.activeProfile() === 'StateP' && window.__layout.isDirty() === true"))
        # the right-click menu reflects state: active row checked + an "edited" badge
        page.evaluate("""document.querySelector('.toolstrip').dispatchEvent(new MouseEvent('contextmenu',
            {bubbles:true, cancelable:true, clientX:20, clientY:20}))""")
        check("right-click menu shows the active profile checked with an edited badge",
              page.evaluate("""() => { const rows=[...document.querySelectorAll('.context-menu .menu-row')];
                const r = rows.find(r => /StateP/.test(r.textContent));
                const checked = !!r && r.querySelector('.menu-rowlabel.checked') && r.querySelector('.menu-check').textContent.trim()==='✓';
                const badge = !!r && !!r.querySelector('.menu-badge');
                const upd = [...document.querySelectorAll('.context-menu .menu-item')].some(i=>/Update/.test(i.textContent));
                return checked && badge && upd; }"""))
        page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))")
        # Update folds the live edit back into the profile → clean again
        page.evaluate("window.__layout.updateActive()")
        check("Update writes the live arrangement back into the active profile",
              page.evaluate("window.__layout.activeProfile() === 'StateP' && window.__layout.isDirty() === false"))
        # renaming the active profile carries the selection across
        page.evaluate("window.__layout.renameProfile('StateP','StateQ')")
        check("renaming the active profile keeps it selected under the new name",
              page.evaluate("window.__layout.activeProfile() === 'StateQ'"))
        # deleting the active profile drops back to Default (null)
        page.evaluate("window.__layout.deleteProfile('StateQ')")
        check("deleting the active profile falls back to Default",
              page.evaluate("window.__layout.activeProfile() === null && !window.__layout.listProfiles().includes('StateQ')"))
        # clean up: reset to default, exit customize mode
        page.evaluate("() => { window.__layout.reset(); if (window.__layout.isEditing()) window.__layout.toggleEdit(); }")
        # Ctrl/Cmd+R toggles the rulers
        rulers0 = page.evaluate("!!document.querySelector('#vp-rulers').classList.contains('on')")
        page.keyboard.press("Control+r"); page.wait_for_timeout(60)
        check("Ctrl+R toggles the rulers",
              page.evaluate("!!document.querySelector('#vp-rulers').classList.contains('on')") != rulers0)
        page.keyboard.press("Control+r"); page.wait_for_timeout(60)   # restore
        # colour swatches moved out of the toolstrip onto the canvas inner bottom-right
        check("colour swatches float over the stage body (not the toolstrip)",
              page.evaluate("!!document.querySelector('.stage-body #tool-swatches #swatch-fill') && !document.querySelector('.toolstrip #swatch-fill')"))
        check("no rotate/flip buttons in the toolstrip", page.evaluate("!document.querySelector('.toolstrip [data-xform]')"))
        # leftover output-variant picker (Upscale/Cutout/SVG/Edited) is gone
        check("output-variant picker removed", page.evaluate("!document.querySelector('#output-picker')"))
        # File menu dropdown opens within the viewport (regression: right:0 pushed it off-screen left)
        page.click('.menu[data-menu="file"] .menu-trigger'); page.wait_for_timeout(60)
        in_bounds = page.evaluate("""() => {
            const l=document.querySelector('.menu[data-menu="file"] .menu-list');
            if(!l || l.hidden) return false;
            const r=l.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth + 1 && r.width > 0;
        }""")
        check("File menu opens within bounds", in_bounds)
        check("File menu has Place into canvas", page.evaluate(
            "[...document.querySelectorAll('.menu[data-menu=\"file\"] .menu-item')].some(b => b.textContent.includes('Place into canvas'))"))
        page.keyboard.press("Escape")
        # Layers live in the right dock (alongside the inspector), not a left rail
        check("Layers panel is in the right dock", page.evaluate("!!document.querySelector('#rightdock .rail-section.layers #layers-list')"))
        # collapsing the dock must keep the stage wide (regression: it used to fall into
        # the dock's grid track and collapse to ~0)
        w_before = page.evaluate("document.querySelector('#output-preview').getBoundingClientRect().width")
        page.click("#rail-toggle"); page.wait_for_timeout(120)
        dock_hidden = page.evaluate("getComputedStyle(document.querySelector('#rightdock')).display === 'none'")
        w_after = page.evaluate("document.querySelector('#output-preview').getBoundingClientRect().width")
        check("dock collapse hides dock and widens the stage", dock_hidden and w_after >= w_before - 1, f"before={w_before} after={w_after}")
        page.click("#rail-toggle"); page.wait_for_timeout(120)
        check("dock re-expands", page.evaluate("getComputedStyle(document.querySelector('#rightdock')).display !== 'none'"))

        section("G. Phase 3: layers panel")
        mount_ctl(page)
        page.wait_for_timeout(60)
        rows = page.evaluate("[...document.querySelectorAll('#layers-list .layer-row:not(.artboard-row)')].map(r=>r.dataset.id)")
        # list is reverse DOM order: top row = frontmost (last artwork child)
        check("layers list reflects nodes (reverse order)", rows == ["r3", "r2", "r1"], f"rows={rows}")

        # the Artboard row is pinned to the bottom chin (#layers-foot, not the scrolling list) and selects the canvas
        check("artboard row pinned to the layers chin",
              page.evaluate("!!document.querySelector('#layers-foot .layer-row.artboard-row') && !document.querySelector('#layers-list .artboard-row')") is True)
        page.click("#layers-foot .layer-row.artboard-row"); page.wait_for_timeout(50)
        check("clicking artboard row selects the artboard", page.evaluate("editor.artboardSelected === true && editor.selection.size === 0"))

        # click a layer row selects that node on the canvas
        page.click("#layers-list .layer-row[data-id='r2']"); page.wait_for_timeout(50)
        check("clicking a layer row selects it", page.evaluate("[...editor.selection]") == ["r2"])

        # visibility toggle hides the node
        page.evaluate("editor.setVisibility('r1', false)"); page.wait_for_timeout(40)
        check("layer visibility hides node", page.evaluate("editor.nodeById('r1').getAttribute('display')") == "none")
        page.evaluate("editor.setVisibility('r1', true)")

        # locking prevents canvas selection
        page.evaluate("editor.toggleLock('r3')"); page.wait_for_timeout(40)
        click_node(page, "r3"); page.wait_for_timeout(50)
        check("locked node is not selectable on canvas", page.evaluate("!editor.selection.has('r3')"))
        page.evaluate("editor.toggleLock('r3')")

        # drag-reorder (logic): src lands just in front of target
        mount_ctl(page)
        page.evaluate("editor.reorderTo('r1','r3')"); page.wait_for_timeout(40)
        order = page.evaluate("editor._artworkNodes().map(n=>n.getAttribute('data-hv-id'))")
        check("reorder places node in front of target", order == ["r2", "r3", "r1"], f"order={order}")

        # rows are draggable
        check("layer rows are draggable", page.evaluate("document.querySelector('#layers-list .layer-row').draggable") is True)

        # group / ungroup
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2']); editor.artboardSelected=false; editor.group();")
        page.wait_for_timeout(50)
        g = page.evaluate("""() => { const a = editor._artworkNodes(); const sel=[...editor.selection];
            return { count: a.length, selTag: sel.length===1 ? editor.nodeById(sel[0]).tagName.toLowerCase() : null }; }""")
        check("group wraps selection into one <g>", g["count"] == 2 and g["selTag"] == "g", str(g))
        page.evaluate("editor.ungroup()"); page.wait_for_timeout(50)
        check("ungroup restores top-level nodes", page.evaluate("editor._artworkNodes().length") == 3)
        page.keyboard.press("Control+z"); page.wait_for_timeout(40)
        check("ungroup is undoable", page.evaluate("editor._artworkNodes().length") == 2)

        section("drag layers in/out of groups, selection normalization, header counts, mixed inspector")
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2']); editor.artboardSelected=false; editor.group();")
        page.wait_for_timeout(40)
        gid = page.evaluate("[...editor.selection][0]")
        page.evaluate(f"editor.reorderTo('r3', '{gid}')"); page.wait_for_timeout(40)   # drop r3 onto the group row
        check("dropping a layer on a group nests it inside",
              page.evaluate(f"editor.nodeById('r3').parentNode === editor.nodeById('{gid}') && !editor._artworkNodes().some(n=>n.getAttribute('data-hv-id')==='r3')"))
        page.evaluate("editor.reorderToRoot('r3')"); page.wait_for_timeout(40)         # drop r3 on the artboard chin
        check("dropping on the artboard chin pulls a layer back to top level",
              page.evaluate("editor.nodeById('r3').parentNode === editor.stage"))
        check("a group + its own child normalizes to just the group (no double-move)",
              page.evaluate(f"""() => {{ editor.selection = new Set(['{gid}','r1']);
                const t = editor._topSelection(editor.selectedNodes());
                return t.length===1 && t[0]===editor.nodeById('{gid}'); }}"""))
        # group-in-group: grouping shapes that already live in a group nests a new <g> inside it
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2','r3']); editor.group();"); page.wait_for_timeout(40)
        outer = page.evaluate("[...editor.selection][0]")
        page.evaluate("editor.selection=new Set(['r1','r2']); editor.group();"); page.wait_for_timeout(40)
        check("can create a group inside a group",
              page.evaluate(f"""() => {{ const inner=[...editor.selection][0]; const g=editor.nodeById(inner);
                return g && g.tagName.toLowerCase()==='g' && g.parentNode===editor.nodeById('{outer}')
                  && editor.nodeById('r1').parentNode===g; }}"""))
        # multi-node drag moves the whole selection together, keeping z-order
        mount_ctl(page)
        page.evaluate("editor._reorderDrop(['r1','r2'],'r3','after')"); page.wait_for_timeout(40)
        check("multi-node reorder moves the selection together (z-order kept)",
              page.evaluate("JSON.stringify(editor._artworkNodes().map(n=>n.getAttribute('data-hv-id')))") == '["r3","r1","r2"]')
        # position-aware drop: 'before' inserts ahead of the target
        mount_ctl(page)
        page.evaluate("editor._reorderDrop(['r3'],'r1','before')"); page.wait_for_timeout(40)
        check("drop 'before' lands the layer ahead of the target",
              page.evaluate("JSON.stringify(editor._artworkNodes().map(n=>n.getAttribute('data-hv-id')))") == '["r3","r1","r2"]')
        # dragging to empty space / root pulls multiple layers out of a group
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2']); editor.group(); editor._reorderManyToRoot(['r1','r2']);"); page.wait_for_timeout(40)
        check("multi pull-to-root removes layers from their group",
              page.evaluate("editor.nodeById('r1').parentNode===editor.stage && editor.nodeById('r2').parentNode===editor.stage"))
        check("layers count badge shows the top-level count",
              page.evaluate("document.querySelector('#layers-count').textContent === String(editor._artworkNodes().length)"))
        check("history count badge is non-empty after edits",
              page.evaluate("document.querySelector('#history-count').textContent !== ''"))
        # mismatched multi-selection → indeterminate ("Mixed") state in the object panel
        # (colour moved to the Colour panel; the remaining style — e.g. stroke width — still
        # shows Mixed instead of silently showing just the first object's value)
        page.evaluate("""() => { app.selectedOutput=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
              + '<rect data-hv-id="mx1" x="10" y="10" width="40" height="40" fill="#ff0000" stroke="#000" stroke-width="2"/>'
              + '<rect data-hv-id="mx2" x="60" y="10" width="40" height="40" fill="#0000ff" stroke="#000" stroke-width="8"/></svg>','mix.svg'); }""")
        page.wait_for_timeout(60)
        check("mismatched stroke widths show a Mixed state",
              page.evaluate("""() => { editor.selection=new Set(['mx1','mx2']); editor.artboardSelected=false;
                const panel = editor._objectPanel(editor.selectedNodes());
                const row = [...panel.querySelectorAll('.insp-row')].find(r => r.querySelector('span') && r.querySelector('span').textContent === 'Width');
                const inp = row && row.querySelector('input[type=number]');
                return !!inp && (inp.placeholder.toLowerCase()==='mixed' || inp.value===''); }"""))

        section("redesigned Object panel: Transform / Shape / Stroke / Appearance + align chin")
        page.evaluate("""() => { app.selectedOutput=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
              + '<rect data-hv-id="t1" x="20" y="30" width="40" height="20"/>'
              + '<path data-hv-id="t2" d="M100 100 L140 100 L140 140 Z"/></svg>','obj.svg'); }""")
        page.wait_for_timeout(60)
        page.evaluate("editor.selection=new Set(['t1']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector();")
        page.wait_for_timeout(40)
        groups = page.evaluate("[...document.querySelectorAll('.context-panel .insp-title')].map(t=>t.textContent)")
        check("object panel has Transform/Stroke/Appearance sections (Flip + Arrange dropped — global)",
              all(g in groups for g in ["Transform", "Stroke", "Appearance"]) and "Arrange" not in groups and "Align to artboard" not in groups, str(groups))
        # align-to-artboard lives in the panel's pinned bottom chin now (6 buttons)
        check("align-to-artboard buttons sit in the bottom chin",
              page.evaluate("document.querySelectorAll('.context-panel .insp-foot .insp-alignbar .insp-iconbtn').length") == 6)
        # X/Y and W/H pair two-up; Rotate is a lone compact "R" half-row (Corner moved to
        # Shape). Single-letter labels for congruence with X/Y/W/H. No Lock W:H / magnet.
        check("X/Y, W/H paired and Rotate is a compact R half-row",
              page.evaluate("""() => {
                const fl = f => f.querySelector('span') && f.querySelector('span').textContent;
                const pairs = [...document.querySelectorAll('.context-panel .insp-row.insp-pair')]
                  .map(r => [...r.querySelectorAll('.insp-field')].map(fl).join(''));
                const has = l => [...document.querySelectorAll('.context-panel .insp-field')].some(f => fl(f) === l);
                const noLock = ![...document.querySelectorAll('.context-panel .insp-row > span, .context-panel .insp-field > span')]
                  .some(s => s.textContent === 'Lock W:H');
                const noMagnet = !document.querySelector('.context-panel .insp-link');
                return ['X','Y','W','H','R'].every(has) && pairs.includes('XY')
                  && pairs.includes('WH') && pairs.includes('R') && noLock && noMagnet; }"""))
        # Corner (C) is contextual — it lives in the Shape section (a full Width-style row)
        # and appears for a rect.
        check("Corner (C) appears in Shape for a rect",
              page.evaluate("""() => {
                const shape = [...document.querySelectorAll('.context-panel .insp-group')]
                  .find(g => { const t = g.querySelector('.insp-title'); return t && t.textContent === 'Shape'; });
                return !!shape && [...shape.querySelectorAll('.insp-row > span')].some(s => s.textContent === 'C'); }"""))
        # Native number spinners are suppressed (scrub label replaces them).
        check("number inputs drop the native spinner",
              page.evaluate("""() => { const i = document.querySelector('.context-panel .insp-field input[type=number]');
                return i && ['textfield','none'].includes(getComputedStyle(i).appearance || getComputedStyle(i).webkitAppearance); }"""))
        # Strokeless selection: Stroke section shows ONLY Width — Cap/Join/Dashes appear
        # with context, they aren't greyed placeholders.
        check("strokeless selection shows only Width in Stroke",
              page.evaluate("""() => {
                const st = [...document.querySelectorAll('.context-panel .insp-group')]
                  .find(g => { const t = g.querySelector('.insp-title'); return t && t.textContent === 'Stroke'; });
                if (!st) return false;
                const labels = [...st.querySelectorAll('.insp-row > span, .insp-field > span')].map(s => s.textContent);
                return labels.includes('Width') && !labels.includes('Cap') && !labels.includes('Join') && !labels.includes('Dashes'); }"""))
        # Rotate is a scrub-numeric like X/Y/W/H (label "R"), not a button bar
        check("Rotate (R) is a numeric field in Transform",
              page.evaluate("""() => { const r=[...document.querySelectorAll('.context-panel .insp-field')].find(r=>r.querySelector('span')&&r.querySelector('span').textContent==='R'); return !!r && !!r.querySelector('input[type=number]'); }"""))
        page.evaluate("editor.setSelectionPos(0,0)")
        bb = page.evaluate("() => { const b = editor.selectionBBox(); return [Math.round(b.x0), Math.round(b.y0)]; }")
        check("Transform X/Y moves the selection to the origin", bb == [0, 0], str(bb))
        page.evaluate("editor.setSelectionSize(80, null, false)")
        check("Transform W resizes the selection",
              page.evaluate("() => Math.round(editor.selectionBBox().x1 - editor.selectionBBox().x0)") == 80)
        page.evaluate("editor.rotateSelectionBy(90)")
        check("rotate composes a transform", page.evaluate("!!editor.nodeById('t1').getAttribute('transform')"))
        page.evaluate("editor.setRectRadius(6)")
        check("corner radius sets rx on a rect", page.evaluate("editor.nodeById('t1').getAttribute('rx')") == "6")
        page.evaluate("editor.applyBlendMode('multiply')")
        check("blend mode applies via inline style", page.evaluate("editor.nodeById('t1').style.mixBlendMode") == "multiply")
        page.evaluate("editor.setSelectionSize(40,40,false); editor.align('hcenter'); editor.align('vmiddle')")
        cen = page.evaluate("""() => { const b=editor.selectionBBox(), vb=editor.stage.viewBox.baseVal;
            return [Math.round((b.x0+b.x1)/2-(vb.x+vb.width/2)), Math.round((b.y0+b.y1)/2-(vb.y+vb.height/2))]; }""")
        check("align centres the selection on the artboard", abs(cen[0]) <= 1 and abs(cen[1]) <= 1, str(cen))
        # W and Rotate scrub LIVE — the shape changes DURING the drag, not just on release.
        def field_label_xy(label):
            return page.evaluate("""(label) => { const f=[...document.querySelectorAll('.context-panel .insp-field')]
                .find(f=>f.querySelector('span')&&f.querySelector('span').textContent===label); if(!f) return null;
                f.scrollIntoView({block:'center'}); const r=f.querySelector('span').getBoundingClientRect();
                return {x:r.left+r.width/2, y:r.top+r.height/2}; }""", label)
        wxy = field_label_xy("W")
        w_before = page.evaluate("() => Math.round(editor.selectionBBox().x1 - editor.selectionBBox().x0)")
        page.mouse.move(wxy["x"], wxy["y"]); page.mouse.down()
        page.mouse.move(wxy["x"] + 48, wxy["y"], steps=8)
        w_live = page.evaluate("() => Math.round(editor.selectionBBox().x1 - editor.selectionBBox().x0)")
        page.mouse.up(); page.wait_for_timeout(40)
        check("W scrubs the width live (before release)", w_live > w_before, f"{w_before} -> {w_live}")
        rxy = field_label_xy("R")
        page.mouse.move(rxy["x"], rxy["y"]); page.mouse.down()
        page.mouse.move(rxy["x"] + 40, rxy["y"], steps=8)
        rot_live = page.evaluate("() => { const c=editor.nodeById('t1').transform.baseVal.consolidate(); return c?Math.abs(c.matrix.b)>0.02:false; }")
        page.mouse.up(); page.wait_for_timeout(40)
        check("Rotate scrubs live about a fixed centre (before release)", rot_live)
        page.evaluate("editor.selection=new Set(['t2']); editor._renderSelection(); editor._renderInspector();")
        page.wait_for_timeout(30)
        check("Shape section exposes Fill rule for a path",
              page.evaluate("""[...document.querySelectorAll('.context-panel .insp-row > span')].some(s=>s.textContent==='Fill rule')"""))
        # Corner (C) is contextual — ABSENT entirely for a non-rect (not greyed out).
        check("Corner is absent for a non-rect (contextual, not greyed)",
              page.evaluate("""() => ![...document.querySelectorAll('.context-panel .insp-row > span, .context-panel .insp-field > span')]
                .some(s => s.textContent === 'C')"""))
        page.evaluate("editor.setAttrAll('fill-rule','evenodd')")
        check("fill-rule applies to the path", page.evaluate("editor.nodeById('t2').getAttribute('fill-rule')") == "evenodd")

        section("H. Polish pass: handle scaling, panel collapse, modal width, swatch, flatten")
        # node handles stay a constant screen size under zoom
        mount_ctl(page)
        page.evaluate("editor.setTool('node')"); page.wait_for_timeout(80)
        hw = lambda: page.evaluate("() => { const c = editor._overlayEl().querySelector('.hv-handle'); return c ? c.getBoundingClientRect().width : 0; }")
        w1 = hw()
        page.evaluate("zoomVp(viewports.output, 4)"); page.wait_for_timeout(80)
        w2 = hw()
        check("node handles stay constant screen size under zoom", w1 > 0 and abs(w2 - w1) < 4, f"w1={w1:.1f} w2={w2:.1f}")
        page.evaluate("editor.setTool('select'); fitVp(viewports.output)")

        # collapsed section shrinks to its header (no empty flex gap)
        page.evaluate("() => { const s = document.querySelector('#rightdock .rail-section.layers'); if (!s.classList.contains('collapsed')) s.querySelector('.section-head').click(); }")
        page.wait_for_timeout(60)
        ch = page.evaluate("document.querySelector('#rightdock .rail-section.layers').offsetHeight")
        check("collapsed section shrinks to header", ch < 70, f"height={ch}")
        page.evaluate("() => { const s = document.querySelector('#rightdock .rail-section.layers'); if (s.classList.contains('collapsed')) s.querySelector('.section-head').click(); }")

        # form modal narrow vs gallery modal wide
        page.evaluate("newBlankDoc()"); page.wait_for_timeout(60)
        check("form modal is narrow", page.evaluate("document.querySelector('.modal-window').classList.contains('modal-narrow')"))
        page.evaluate("closeModal()")
        page.evaluate("openOpenModal()"); page.wait_for_timeout(60)
        check("gallery modal is wide", not page.evaluate("document.querySelector('.modal-window').classList.contains('modal-narrow')"))
        page.evaluate("closeModal()")

        # layer rows show a colour swatch
        mount_ctl(page); page.wait_for_timeout(60)
        sw = page.evaluate("() => { const s = document.querySelector('#layers-list .layer-swatch'); return s ? getComputedStyle(s).backgroundColor : null; }")
        check("layer rows show a colour swatch", sw is not None and sw != "rgba(0, 0, 0, 0)", f"bg={sw}")

        # a single wrapper <g> import is flattened into per-shape layers (layered extraction)
        WRAP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><g transform="translate(5 5)"><rect x="0" y="0" width="40" height="40" fill="#ff0000"/><rect x="50" y="0" width="40" height="40" fill="#00ff00"/><circle cx="50" cy="70" r="18" fill="#0000ff"/></g></svg>'
        page.evaluate("svg => { app.selectedOutput=null; mountStageFromText(svg,'wrap.svg'); }", WRAP)
        page.wait_for_function("editor.stage && editor._artworkNodes().length >= 1", timeout=8000); page.wait_for_timeout(120)
        check("wrapper group flattened into per-shape layers", page.evaluate("editor._artworkNodes().length") == 3,
              f"n={page.evaluate('editor._artworkNodes().length')}")

        # serialize strips editor-only metadata
        mount_ctl(page)
        page.evaluate("editor.rename('r1','My Rect'); editor.toggleLock('r2');")
        meta = page.evaluate("editor.serialize()")
        check("serialize strips editor metadata", ("data-hv-name" not in meta) and ("data-hv-locked" not in meta))
        # exported SVG carries no live-shape params (data-hv-*) — the `d` is the truth
        page.evaluate("editor.setTool('rect')")
        _ab = artboard_rect(page)
        page.mouse.move(_ab["x"] + _ab["w"]*0.2, _ab["y"] + _ab["h"]*0.2); page.mouse.down()
        page.mouse.move(_ab["x"] + _ab["w"]*0.5, _ab["y"] + _ab["h"]*0.5, steps=6); page.mouse.up(); page.wait_for_timeout(60)
        page.evaluate("editor.setTool('select')")
        check("serialize strips live-shape params, keeps the path d",
              "data-hv-shape" not in page.evaluate("editor.serialize()") and "data-hv-bx" not in page.evaluate("editor.serialize()"))

        section("Phase 4: shape tools")
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.style.fill = '#123456'")   # last-used fill new shapes should inherit
        draw_shape(page, "rect", 0.15, 0.15, 0.55, 0.5)
        rsel = sel_node(page)
        # Shapes are now born as parametric "live shape" <path>s (data-hv-shape), never
        # native <rect>/<ellipse> — so there's never a path-conversion step.
        check("rect tool creates a selected live-shape path (rect kind)",
              rsel and rsel["tag"] == "path" and rsel["attrs"].get("data-hv-shape") == "rect" and n_nodes(page) == base + 1,
              f"sel={rsel} n={n_nodes(page)}")
        check("drawn rect inherits last-used fill", rsel and rsel["attrs"].get("fill") == "#123456",
              str(rsel and rsel["attrs"].get("fill")))
        check("shape tool stays active after drawing", page.evaluate("editor.tool") == "rect")
        page.evaluate("editor.undo()"); page.wait_for_timeout(40)
        check("undo removes the drawn rect", n_nodes(page) == base)

        mount_ctl(page)
        draw_shape(page, "ellipse", 0.2, 0.2, 0.7, 0.6)
        esel = sel_node(page)
        check("ellipse tool creates a selected live-shape path (ellipse kind)",
              esel and esel["tag"] == "path" and esel["attrs"].get("data-hv-shape") == "ellipse", str(esel))

        mount_ctl(page)
        draw_shape(page, "line", 0.2, 0.2, 0.8, 0.7)
        lsel = sel_node(page)
        # a line is a plain 2-anchor <path> now (pen-editable endpoints), not a native <line>
        check("line tool creates a selected 2-point path with a stroke",
              lsel and lsel["tag"] == "path" and lsel["attrs"].get("stroke") not in (None, "none")
              and lsel["attrs"].get("fill") == "none" and "L" in (lsel["attrs"].get("d") or ""), str(lsel))
        lid = page.evaluate("[...editor.selection][0]")
        page.evaluate(f"editor.selection=new Set(['{lid}']); editor.setTool('node');"); page.wait_for_timeout(80)
        check("line endpoints are 2 pen-style node anchors",
              page.evaluate("document.querySelectorAll('.hv-node-anchor').length") == 2)
        page.evaluate("editor.setTool('select')")

        # Shift constrains a rect to a square even on a wide drag
        mount_ctl(page)
        draw_shape(page, "rect", 0.1, 0.4, 0.9, 0.55, shift=True)
        sq = sel_node(page)
        ok_sq = sq and abs(float(sq["attrs"]["data-hv-bw"]) - float(sq["attrs"]["data-hv-bh"])) < 0.5
        check("Shift constrains rect to a square", ok_sq, str(sq and (sq["attrs"].get("data-hv-bw"), sq["attrs"].get("data-hv-bh"))))

        # A bare click (no drag) creates nothing and leaves no undo entry
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.setTool('rect')")
        ab = artboard_rect(page)
        page.mouse.move(ab["x"] + ab["w"] * 0.5, ab["y"] + ab["h"] * 0.5)
        page.mouse.down(); page.mouse.up(); page.wait_for_timeout(40)
        check("bare click draws nothing / no history", n_nodes(page) == base and page.evaluate("editor.history.length") == 0,
              f"n={n_nodes(page)} hist={page.evaluate('editor.history.length')}")

        section("parametric 'live shapes': rect/poly/star/ellipse as paths + Shape panel")
        mount_ctl(page)
        draw_shape(page, "rect", 0.2, 0.2, 0.7, 0.6)
        sid = page.evaluate("[...editor.selection][0]")
        # the Shape panel offers a Type switch + corner fields for a live shape
        shape_titles = page.evaluate("""() => { const g=[...document.querySelectorAll('.context-panel .insp-group')]
            .find(g=>{const t=g.querySelector('.insp-title');return t&&t.textContent==='Shape';});
            return g ? [...g.querySelectorAll('.insp-row > span, .insp-field > span')].map(s=>s.textContent) : []; }""")
        check("live-shape Shape panel shows Type + corner fields",
              page.evaluate("""!!document.querySelector('.context-panel .insp-seg')""") and ("C" in shape_titles)
              and ("TL" in shape_titles) and ("TR" in shape_titles), str(shape_titles))
        # NO redundant "Expand to path" button — it's already a path; point control is the node tool
        check("no redundant Expand-to-path button",
              not page.evaluate("""[...document.querySelectorAll('.context-panel .ghost-button')].some(b=>/Expand/.test(b.textContent))"""))
        # corner radius regenerates the path d with arcs (rounded), keeping it a live rect
        d_sharp = page.evaluate(f"editor.nodeById('{sid}').getAttribute('d')")
        page.evaluate("editor.setRectRadius(8)"); page.wait_for_timeout(30)
        d_round = page.evaluate(f"editor.nodeById('{sid}').getAttribute('d')")
        # rounded corners are CUBIC BÉZIERS (pen-editable), not SVG `A` arcs
        check("corner radius regenerates rounded cubic-bezier corners", "C" in d_round and "A" not in d_round and d_round != d_sharp and page.evaluate(f"editor.nodeById('{sid}').getAttribute('data-hv-shape')") == "rect", d_round[:50])
        # switch the kind in place: rect -> polygon (sides param), morphs the same box
        page.evaluate("editor.setShapeKind('poly')"); page.wait_for_timeout(30)
        check("rect -> polygon switches kind in place",
              page.evaluate(f"editor.nodeById('{sid}').getAttribute('data-hv-shape')") == "poly"
              and page.evaluate(f"!!editor.nodeById('{sid}').getAttribute('data-hv-sides')"))
        sides_titles = page.evaluate("""() => { const g=[...document.querySelectorAll('.context-panel .insp-group')]
            .find(g=>{const t=g.querySelector('.insp-title');return t&&t.textContent==='Shape';});
            return [...g.querySelectorAll('.insp-row > span, .insp-field > span')].map(s=>s.textContent); }""")
        check("polygon Shape panel shows Sides", "Sides" in sides_titles, str(sides_titles))
        page.evaluate("editor.setShapeParam('sides', 3, 'poly'); editor._renderSelection();"); page.wait_for_timeout(20)
        check("polygon sides param regenerates (triangle = 3 corners)",
              page.evaluate(f"(editor.nodeById('{sid}').getAttribute('d').match(/[ML]/g)||[]).length") == 3)
        # switch to star -> points + inset params
        page.evaluate("editor.setShapeKind('star')"); page.wait_for_timeout(30)
        check("polygon -> star exposes points + inset",
              page.evaluate(f"editor.nodeById('{sid}').getAttribute('data-hv-shape')") == "star"
              and page.evaluate(f"!!editor.nodeById('{sid}').getAttribute('data-hv-points')"))
        # (no Expand button / API — node-editing is the way a shape becomes freeform; that
        #  transition is covered by "node-editing a live shape freezes it" below.)

        # ellipse arc: a span turns the full ellipse into a centre-anchored pie wedge
        mount_ctl(page)
        draw_shape(page, "ellipse", 0.25, 0.25, 0.7, 0.7)
        eid = page.evaluate("[...editor.selection][0]")
        page.evaluate(f"editor.selection=new Set(['{eid}']); editor.setShapeParam('end', 90, 'ellipse'); editor._renderSelection();"); page.wait_for_timeout(30)
        check("ellipse arc carves a pie wedge", page.evaluate(f"/^M[\\d.\\s-]+L/.test(editor.nodeById('{eid}').getAttribute('d'))"),
              page.evaluate(f"editor.nodeById('{eid}').getAttribute('d')")[:30])
        # circle points are pen-like: a full ellipse is 4 cubic-bezier anchors (top/right/
        # bottom/left) WITH direction handles, not opaque SVG arc endpoints.
        mount_ctl(page)
        draw_shape(page, "ellipse", 0.25, 0.25, 0.75, 0.75)
        cid = page.evaluate("[...editor.selection][0]")
        check("circle is cubic beziers (4 C segments), no SVG arcs",
              page.evaluate(f"(editor.nodeById('{cid}').getAttribute('d').match(/C/g)||[]).length") == 4
              and "A" not in page.evaluate(f"editor.nodeById('{cid}').getAttribute('d')"))
        page.evaluate(f"editor.selection=new Set(['{cid}']); editor.setTool('node');"); page.wait_for_timeout(80)
        check("circle shows 4 node anchors WITH bezier direction handles (pen-like)",
              page.evaluate("document.querySelectorAll('.hv-node-anchor').length") == 4
              and page.evaluate("document.querySelectorAll('.hv-node-handle').length") > 0)
        page.evaluate("editor.setTool('select')")

        section("contextual stroke rows: Join only where a shape has POINTY corners, Cap only")
        #      where the stroke has visible ENDS (open path or dash/dotted pattern). ----
        def stroke_labels():
            return page.evaluate("""() => { const g=[...document.querySelectorAll('.context-panel .insp-group')]
                .find(g=>{const t=g.querySelector('.insp-title');return t&&t.textContent==='Stroke';});
                return g ? [...g.querySelectorAll('.insp-row > span, .insp-field > span')].map(s=>s.textContent) : []; }""")
        page.evaluate(f"editor.selection=new Set(['{cid}']); editor.artboardSelected=false; editor.applyStroke('#000000',3); editor._renderInspector();"); page.wait_for_timeout(40)
        check("circle (all curves, closed) hides Join AND Cap", "Join" not in stroke_labels() and "Cap" not in stroke_labels(), str(stroke_labels()))
        mount_ctl(page); draw_shape(page, "line", 0.2, 0.2, 0.8, 0.6)
        page.evaluate("editor.applyStroke('#000000',3); editor._renderInspector();"); page.wait_for_timeout(40)
        ll = stroke_labels()
        check("stroked line (open, no corners) shows Cap, hides Join", "Cap" in ll and "Join" not in ll, str(ll))
        mount_ctl(page); draw_shape(page, "rect", 0.2, 0.2, 0.6, 0.6)
        page.evaluate("editor.applyStroke('#000000',3); editor._renderInspector();"); page.wait_for_timeout(40)
        rl = stroke_labels()
        check("closed solid rect (corners) shows Join, hides Cap", "Join" in rl and "Cap" not in rl, str(rl))
        # FULL POINT CONTROL on shapes: a live polygon exposes one node anchor per vertex
        # in the node tool, and dragging one both moves the geometry and frees it from its
        # params (no "Expand" step needed).
        mount_ctl(page)
        draw_shape(page, "rect", 0.2, 0.2, 0.6, 0.6)
        nid = page.evaluate("[...editor.selection][0]")
        page.evaluate(f"editor.selection=new Set(['{nid}']); editor.setShapeKind('poly'); editor.setShapeParam('sides',5,'poly'); editor.setShapeParam('corner',0,'poly'); editor._renderSelection();")
        page.evaluate("editor.setTool('node')"); page.wait_for_timeout(80)
        check("node tool shows one anchor per polygon vertex (full point control)",
              page.evaluate("document.querySelectorAll('.hv-node-anchor').length") == 5,
              str(page.evaluate("document.querySelectorAll('.hv-node-anchor').length")))
        d_before = page.evaluate(f"editor.nodeById('{nid}').getAttribute('d')")
        h = page.evaluate("() => { const c = editor._overlayEl().querySelector('.hv-handle'); const r=c.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; }")
        page.mouse.move(h["x"], h["y"]); page.mouse.down(); page.mouse.move(h["x"]+14, h["y"]+10, steps=4); page.mouse.up(); page.wait_for_timeout(40)
        check("dragging a vertex edits the geometry and frees it from params",
              page.evaluate(f"!editor.nodeById('{nid}').hasAttribute('data-hv-shape')")
              and page.evaluate(f"editor.nodeById('{nid}').getAttribute('d')") != d_before)
        # the object panel updates INSTANTLY — the parametric Type switch is gone now
        page.evaluate(f"editor.setTool('select'); editor.selection=new Set(['{nid}']); editor._renderInspector();"); page.wait_for_timeout(40)
        check("object panel instantly reflects the shape is no longer parametric",
              not page.evaluate("""[...document.querySelectorAll('.context-panel .insp-row > span, .context-panel .insp-field > span')].some(s=>s.textContent==='Type')"""))

        # Keyboard shortcuts switch tools
        page.evaluate("editor.setTool('select')")
        page.keyboard.press("p"); check("P selects pen tool", page.evaluate("editor.tool") == "pen")
        page.keyboard.press("r"); check("R selects rect tool", page.evaluate("editor.tool") == "rect")
        page.keyboard.press("e"); check("E selects ellipse tool", page.evaluate("editor.tool") == "ellipse")
        page.keyboard.press("l"); check("L selects line tool", page.evaluate("editor.tool") == "line")
        page.keyboard.press("v"); check("V returns to select tool", page.evaluate("editor.tool") == "select")

        # marquee folded into V: dragging empty space rubber-band-selects (no marquee tool)
        mount_ctl(page); page.evaluate("editor.setTool('select')")
        ab = artboard_rect(page)
        page.mouse.move(ab["x"] + ab["w"] * 0.02, ab["y"] + ab["h"] * 0.02); page.mouse.down()
        page.mouse.move(ab["x"] + ab["w"] * 0.98, ab["y"] + ab["h"] * 0.45, steps=12); page.mouse.up()
        page.wait_for_timeout(60)
        msel = page.evaluate("() => [...editor.selection].sort().join(',')")
        check("empty-drag marquee-selects in V", msel == "r1,r2", f"sel={msel}")
        # Ctrl+T toggles scale handles within select (transform is a V sub-mode)
        page.evaluate("() => editor.enterTransform('scale')"); page.wait_for_timeout(40)
        check("Ctrl+T scale handles in select mode",
              page.evaluate("() => editor.tool === 'select' && !!document.querySelector('.hv-xform-box') && document.querySelectorAll('.hv-xform-handle').length === 8"))
        page.evaluate("() => editor.enterTransform('scale')"); page.wait_for_timeout(40)   # toggle off
        check("Ctrl+T again returns to plain selection",
              page.evaluate("() => !editor._xformMode && !document.querySelector('.hv-xform-box')"))
        page.evaluate("editor.setTool('select'); editor.selection = new Set();")

        section("Phase 4: pen tool")
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.setTool('pen')")
        pen_click(page, 0.2, 0.2); pen_click(page, 0.6, 0.25); pen_click(page, 0.5, 0.6)
        check("pen path in progress (uncommitted)", page.evaluate("!!editor._pen") and n_nodes(page) == base)
        page.keyboard.press("Enter"); page.wait_for_timeout(40)
        psel = sel_node(page)
        check("Enter finishes an open path", psel and psel["tag"] == "path" and n_nodes(page) == base + 1
              and "L" in psel["attrs"]["d"] and "Z" not in psel["attrs"]["d"], str(psel and psel["attrs"].get("d")))
        check("open pen path has no fill", psel and psel["attrs"].get("fill") == "none")
        page.evaluate("editor.undo()"); page.wait_for_timeout(40)
        check("undo removes the pen path", n_nodes(page) == base and not page.evaluate("!!editor._pen"))

        # Pen tool on a SELECTED object shows its anchor points (so add/remove is obvious)
        mount_ctl(page)
        page.evaluate("editor.setTool('select'); editor.selection=new Set(['r2']); editor._renderSelection();")
        page.evaluate("editor.setTool('pen')"); page.wait_for_timeout(60)
        check("pen tool shows the selected object's points", page.evaluate("document.querySelectorAll('.hv-pen-point').length") > 0)
        # …and clears them with nothing selected
        page.evaluate("editor.setTool('select'); editor.selection=new Set(); editor._renderSelection(); editor.setTool('pen')"); page.wait_for_timeout(40)
        check("pen points clear when nothing is selected", page.evaluate("document.querySelectorAll('.hv-pen-point').length") == 0)
        page.evaluate("editor.setTool('select')")

        # Click-drag at an anchor yields a curve (cubic segment)
        mount_ctl(page)
        page.evaluate("editor.setTool('pen')")
        pen_click(page, 0.2, 0.3); pen_click(page, 0.6, 0.3, drag=(0.7, 0.15))
        page.keyboard.press("Enter"); page.wait_for_timeout(40)
        csel = sel_node(page)
        check("drag in pen yields a curve", csel and "C" in csel["attrs"]["d"], str(csel and csel["attrs"].get("d")))

        # Clicking the first anchor closes the path and it takes the fill
        mount_ctl(page)
        page.evaluate("editor.setTool('pen'); editor.style.fill='#22aa44';")
        pen_click(page, 0.25, 0.25); pen_click(page, 0.65, 0.3); pen_click(page, 0.45, 0.65)
        pen_click(page, 0.25, 0.25)   # back on the first anchor → close
        page.wait_for_timeout(40)
        zsel = sel_node(page)
        check("clicking first anchor closes the path", zsel and zsel["attrs"]["d"].rstrip().endswith("Z")
              and zsel["attrs"].get("fill") == "#22aa44", str(zsel and (zsel["attrs"].get("d"), zsel["attrs"].get("fill"))))

        # Closing waits for release: pressing the first anchor does NOT finish on
        # pointer-down, and dragging before release sets the closing tangent (curve).
        mount_ctl(page)
        page.evaluate("editor.setTool('pen'); editor.style.fill='#22aa44';")
        pen_click(page, 0.25, 0.25); pen_click(page, 0.65, 0.3); pen_click(page, 0.45, 0.65)
        abx = artboard_rect(page)
        fx, fy = abx["x"] + abx["w"] * 0.25, abx["y"] + abx["h"] * 0.25
        page.mouse.move(fx, fy); page.mouse.down()
        mid_open = page.evaluate("!!editor._pen")   # still in progress while the button is held
        page.mouse.move(fx, fy - 40, steps=8); page.mouse.up(); page.wait_for_timeout(60)
        dsel = sel_node(page)
        check("close waits for release; drag sets the closing tangent",
              mid_open and dsel and dsel["attrs"]["d"].rstrip().endswith("Z") and "C" in dsel["attrs"]["d"]
              and not page.evaluate("!!editor._pen"),
              str((mid_open, dsel and dsel["attrs"].get("d"))))

        # A lone point + finish creates nothing and leaves no history
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.setTool('pen')")
        pen_click(page, 0.5, 0.5)
        page.keyboard.press("Enter"); page.wait_for_timeout(40)
        check("single-point pen makes nothing / no history",
              n_nodes(page) == base and page.evaluate("editor.history.length") == 0 and not page.evaluate("!!editor._pen"))

        # Switching tools commits an in-progress path
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.setTool('pen')")
        pen_click(page, 0.3, 0.3); pen_click(page, 0.7, 0.7)
        page.evaluate("editor.setTool('select')"); page.wait_for_timeout(40)
        check("switching tool commits the open path", n_nodes(page) == base + 1 and not page.evaluate("!!editor._pen"))

        # Pen marks live in the overlay → stripped on serialize
        mount_ctl(page)
        page.evaluate("editor.setTool('pen')")
        pen_click(page, 0.3, 0.3); pen_click(page, 0.6, 0.6)
        has_marks = page.evaluate("!!editor._overlayEl().querySelector('.hv-pen-anchor')")
        clean = page.evaluate("editor.serialize()")
        check("pen marks render then serialize-strip", has_marks and "hv-pen" not in clean)
        page.keyboard.press("Escape"); page.wait_for_timeout(30)
        check("Escape cancels the pen path", not page.evaluate("!!editor._pen"))

        section("Curvature tool: advanced keybinds (Alt corner / Shift 45° / Backspace / drag)")
        mount_ctl(page)
        page.evaluate("editor.setTool('curvature')")
        curv_click(page, 0.2, 0.3); curv_click(page, 0.5, 0.3); curv_click(page, 0.7, 0.6)
        check("curvature builds smooth points", page.evaluate("editor._curv && editor._curv.pts.length") == 3)
        # Backspace drops the last point
        page.keyboard.press("Backspace"); page.wait_for_timeout(30)
        check("Backspace removes the last curvature point", page.evaluate("editor._curv.pts.length") == 2)
        # Alt-click drops a corner point (corner:true)
        curv_click(page, 0.8, 0.4, alt=True)
        check("Alt-click drops a corner point",
              page.evaluate("editor._curv.pts.length===3 && editor._curv.pts[2].corner === true"))
        # Drag an existing (non-first) point to reposition it. Point 1 sits at (0.5, 0.3);
        # the first point is reserved for close-path, so drag a middle one.
        ab = artboard_rect(page)
        px = page.evaluate("editor._curv.pts[1].x")
        sx, sy = ab["x"] + ab["w"] * 0.5, ab["y"] + ab["h"] * 0.3
        dx, dy = ab["x"] + ab["w"] * 0.65, ab["y"] + ab["h"] * 0.3
        page.mouse.move(sx, sy); page.mouse.down(); page.mouse.move(dx, dy, steps=8); page.mouse.up()
        page.wait_for_timeout(40)
        moved_to = page.evaluate("editor._curv && editor._curv.pts[1].x")
        check("dragging a curvature point repositions it",
              page.evaluate("!!editor._curv") and (moved_to - px) > 10,   # doc units; drag was ~30
              f"x moved from {px} to {moved_to}")
        # Enter finishes → a real curved path with C segments
        page.keyboard.press("Enter"); page.wait_for_timeout(50)
        csel = sel_node(page)
        check("Enter finishes the curvature path (cubic segments)",
              not page.evaluate("!!editor._curv") and csel and "C" in csel["attrs"].get("d", ""),
              str(csel and csel["attrs"].get("d")))
        # Shift constrains a new point to a 45° ray from the previous one
        mount_ctl(page)
        page.evaluate("editor.setTool('curvature')")
        curv_click(page, 0.3, 0.3); curv_click(page, 0.7, 0.5, shift=True)
        check("Shift constrains the next curvature point to 45°",
              page.evaluate("""() => { const p=editor._curv.pts; const dx=p[1].x-p[0].x, dy=p[1].y-p[0].y;
                const a=Math.abs(Math.atan2(dy,dx)*180/Math.PI); const m=Math.min(a%45, 45-(a%45));
                return m < 0.5; }"""))
        page.keyboard.press("Escape"); page.wait_for_timeout(30)
        check("Escape cancels the curvature path", not page.evaluate("!!editor._curv"))

        section("Phase 4: boolean ops (point-membership on the result path)")
        # A-only=(30,30), B-only=(130,130), overlap=(80,80), outside=(10,10)
        mount_bool(page)
        page.evaluate("editor.booleanOp('union')"); page.wait_for_timeout(120)
        u = sel_node(page)
        check("union → single path replacing two rects", u and u["tag"] == "path" and n_nodes(page) == 1)
        check("union covers both rects + overlap, not outside",
              result_inside(page, 30, 30) and result_inside(page, 130, 130)
              and result_inside(page, 80, 80) and not result_inside(page, 10, 10))
        page.evaluate("editor.undo()"); page.wait_for_timeout(60)
        check("union is undoable (two rects return)", n_nodes(page) == 2)

        # Union of a rect + ellipse must keep the curved bulge (guards the DP
        # simplifier from flattening a gently-curved arc into a chord)
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'ue.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="ra" x="30" y="40" width="90" height="90" fill="#36c"/><ellipse data-hv-id="eb" cx="130" cy="120" rx="55" ry="45" fill="#e08a2b"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('eb')", timeout=8000)
        page.evaluate("editor.selection=new Set(['ra','eb']); editor.booleanOp('union');")
        page.wait_for_timeout(120)
        check("union keeps the ellipse bulge (curve not flattened)",
              result_inside(page, 170, 120) and result_inside(page, 50, 60)
              and not result_inside(page, 10, 10))
        # The boundary is refit to minimal cubics (shared fitcurve core), NOT emitted
        # as a dense `L` polyline — so the curved bulge is a few C's and the whole
        # path is compact (the old polyline ran to dozens of segments).
        bd = page.evaluate("""() => { const p=editor.stage.querySelector('path[data-hv-id]');
            const d=p?p.getAttribute('d'):''; return { c:(d.match(/C/g)||[]).length, l:(d.match(/L/g)||[]).length, len:d.length }; }""")
        check("boolean output is compact cubics, not a dense polyline",
              bd["c"] >= 1 and (bd["c"] + bd["l"]) <= 24, str(bd))

        mount_bool(page)
        page.evaluate("editor.booleanOp('subtract')"); page.wait_for_timeout(120)
        check("subtract keeps back-only, drops overlap + front",
              result_inside(page, 30, 30) and not result_inside(page, 80, 80)
              and not result_inside(page, 130, 130))

        mount_bool(page)
        page.evaluate("editor.booleanOp('intersect')"); page.wait_for_timeout(120)
        check("intersect keeps only the overlap",
              result_inside(page, 80, 80) and not result_inside(page, 30, 30)
              and not result_inside(page, 130, 130) and n_nodes(page) == 1)

        # Non-overlapping shapes → empty intersection leaves the inputs untouched
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'sep.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="ra" x="10" y="10" width="40" height="40" fill="#36c"/><rect data-hv-id="rb" x="140" y="140" width="40" height="40" fill="#c33"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('rb')", timeout=8000)
        page.evaluate("editor.selection=new Set(['ra','rb']); editor.booleanOp('intersect');")
        page.wait_for_timeout(80)
        check("empty intersection changes nothing", n_nodes(page) == 2)

        # Boolean needs 2+ fillable shapes
        mount_bool(page, select_both=False)
        page.evaluate("editor.selection = new Set(['ra']); editor.booleanOp('union')"); page.wait_for_timeout(40)
        check("single selection: boolean is a no-op", n_nodes(page) == 2)

        # Boolean works on a GROUPED selection (group counts its leaves, result lands in the group)
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'grpbool.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="ga" x="20" y="20" width="60" height="60" fill="#36c"/><rect data-hv-id="gb" x="50" y="50" width="60" height="60" fill="#36c"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('gb')", timeout=8000)
        page.evaluate("editor.selection=new Set(['ga','gb']); editor.group();"); page.wait_for_timeout(40)
        check("a grouped selection counts its fillable leaves",
              page.evaluate("editor._fillableSelection().length === 2"))
        page.evaluate("editor.booleanOp('union')"); page.wait_for_timeout(80)
        check("union runs on a grouped selection and lands inside the group",
              page.evaluate("""() => { const pid=[...editor.selection][0]; const p=editor.nodeById(pid);
                return p && p.tagName.toLowerCase()==='path' && p.parentNode && p.parentNode.tagName.toLowerCase()==='g'; }"""))

        # clicking a shape inside a group selects the WHOLE group (so dragging moves the group, not one child)
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'grpclick.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="ca" x="20" y="20" width="40" height="40" fill="#36c"/><rect data-hv-id="cb" x="70" y="20" width="40" height="40" fill="#c33"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('cb')", timeout=8000)
        page.evaluate("editor.setTool('select'); editor.selection=new Set(['ca','cb']); editor.group();"); page.wait_for_timeout(40)
        gid = page.evaluate("[...editor.selection][0]")
        page.evaluate("""() => { editor.selection=new Set(); const c=editor.nodeById('ca'); const r=c.getBoundingClientRect();
            c.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:r.left+5,clientY:r.top+5,bubbles:true,cancelable:true}));
            window.dispatchEvent(new PointerEvent('pointerup',{button:0,bubbles:true})); }""")
        page.wait_for_timeout(40)
        check("clicking a grouped shape selects the whole group",
              page.evaluate(f"editor.selection.has('{gid}') && !editor.selection.has('ca')"))

        # invert-space overlap fix: overlap of two shapes must be a HOLE, not XOR-filled
        mount_bool(page)
        page.evaluate("editor.invertSpace()"); page.wait_for_timeout(150)
        check("invert-space fills the empty artboard area", result_inside(page, 10, 10))
        check("invert-space leaves shape interiors empty (overlap not XOR-filled)",
              not result_inside(page, 30, 30) and not result_inside(page, 80, 80)
              and not result_inside(page, 130, 130))

        section("Layers cleanup: drop ghost/empty nodes, keep valid ones")
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'ghosts.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
                      '<rect data-hv-id="ra" x="20" y="20" width="60" height="60" fill="#36c"/>'
                      '<path data-hv-id="gp" d="M10 10" fill="#000"/>'
                      '<rect data-hv-id="zr" x="5" y="5" width="0" height="0" fill="#c33"/>'
                      '<g data-hv-id="gg"></g></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('ra')", timeout=8000)
        page.evaluate("editor.cleanupLayers()"); page.wait_for_timeout(60)
        kept = page.evaluate("!!editor.nodeById('ra')")
        gone = page.evaluate("!editor.nodeById('gp') && !editor.nodeById('zr') && !editor.nodeById('gg')")
        check("cleanup removes ghost layers, keeps valid", kept and gone, f"kept={kept} gone={gone}")
        # cleanup is undoable
        page.evaluate("editor.undo()"); page.wait_for_timeout(60)
        check("layers cleanup is undoable", page.evaluate("editor._artworkNodes().length") == 4)

        section("Merge same-colour layers (consolidate trace output)")
        # Mimics a monochrome trace: same fill, each path positioned by translate.
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'mono.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
                      '<path data-hv-id="m1" transform="translate(10,10)" d="M0 0 H20 V20 H0 Z" fill="#000"/>'
                      '<path data-hv-id="m2" transform="translate(100,100)" d="M0 0 H20 V20 H0 Z" fill="#000"/>'
                      '<path data-hv-id="m3" transform="translate(150,20)" d="M0 0 H10 V10 H0 Z" fill="#ff0000"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('m1')", timeout=8000)
        before = page.evaluate("editor._artworkNodes().length")
        page.evaluate("editor.consolidateByColor()"); page.wait_for_timeout(60)
        after = page.evaluate("editor._artworkNodes().length")
        check("merge same-colour collapses paths", before == 3 and after == 2, f"before={before} after={after}")
        merged_ok = page.evaluate("""() => {
            const ps=[...editor.stage.querySelectorAll('path')].filter(p=>['#000','#000000'].includes(p.getAttribute('fill')));
            if(ps.length!==1) return false;
            const p=ps[0]; if(p.getAttribute('transform')) return false;   // translate baked in
            const bb=p.getBBox();                                          // spans (10,10)->(30,30) and (100,100)->(120,120)
            return bb.x<=11 && bb.y<=11 && (bb.x+bb.width)>=119 && (bb.y+bb.height)>=119;
        }""")
        check("merged path keeps both regions (transform baked)", merged_ok)
        check("merge leaves other colours alone", page.evaluate("!!editor.nodeById('m3')"))
        page.evaluate("editor.undo()"); page.wait_for_timeout(60)
        check("merge is undoable", page.evaluate("editor._artworkNodes().length") == 3)

        section("Place / merge a vector INTO the current canvas (not replace)")
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="a1" x="10" y="10" width="40" height="40" fill="#36c"/></svg>','A.svg'); }""")
        page.wait_for_function("editor.stage && editor.nodeById('a1')", timeout=8000)
        # place a larger vector (400x400) — should fit-scale + centre, wrapped as one group
        n_placed = page.evaluate("""() => editor.placeSvgMarkup(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="180" fill="#e33"/><rect x="20" y="20" width="60" height="60" fill="#3a3"/></svg>', 'B.svg')""")
        page.wait_for_timeout(80)
        place = page.evaluate("""() => {
            const tops=editor._artworkNodes();
            const g=tops.find(x=>x.tagName.toLowerCase()==='g');
            const bb=g?g.getBBox():null; const vb=editor.stage.viewBox.baseVal;
            return { keptOriginal: !!editor.nodeById('a1'), tops: tops.length, group: !!g,
                     children: g?g.children.length:0, selected: [...editor.selection],
                     noScale: g?!/(scale|matrix)/.test(g.getAttribute('transform')||''):false,
                     inside: bb? (bb.x>=-1 && bb.y>=-1 && bb.x+bb.width<=vb.width+1 && bb.y+bb.height<=vb.height+1): false };
        }""")
        check("place adds (not replaces): original kept", place["keptOriginal"] and place["tops"] == 2, str(place))
        check("placed art is one group of the source objects", place["group"] and place["children"] == 2 and n_placed == 2)
        check("placed group is selected", len(place["selected"]) == 1)
        check("placed art fits inside the artboard, scale baked (translate-only)", place["inside"] and place["noScale"])
        page.evaluate("editor.undo()"); page.wait_for_timeout(60)
        check("place is undoable", page.evaluate("!!editor.nodeById('a1') && editor._artworkNodes().length") == 1)

        section("Artboard navigation: Shift+O selects it, spacebar pans")
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=false; editor._renderSelection(); if(document.activeElement?.blur) document.activeElement.blur();")
        page.keyboard.press("Shift+O"); page.wait_for_timeout(40)
        check("Shift+O selects the artboard", page.evaluate("editor.artboardSelected === true"))
        page.keyboard.down("Space"); page.wait_for_timeout(30)
        check("spacebar engages pan mode", page.evaluate("editor._spacePan === true && document.querySelector('.stage-wrap').classList.contains('space-pan')"))
        page.keyboard.up("Space"); page.wait_for_timeout(30)
        check("releasing space ends pan mode", page.evaluate("!editor._spacePan && !document.querySelector('.stage-wrap').classList.contains('space-pan')"))

        section("Phase 4: contextual transforms (rotate / flip)")
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'xf.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="rr" x="50" y="50" width="40" height="20" fill="#36c"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('rr')", timeout=8000)
        page.evaluate("editor.selection=new Set(['rr']); editor.artboardSelected=false; editor.transform('rotateCW');")
        dims = page.evaluate("() => { const n=editor.nodeById('rr'); return {w:+n.getAttribute('width'), h:+n.getAttribute('height')}; }")
        check("object rotate 90° swaps width/height", abs(dims["w"] - 20) < 0.6 and abs(dims["h"] - 40) < 0.6, str(dims))

        # whole-artboard flip H mirrors content position; twice = identity
        mount_ctl(page)
        x0 = page.evaluate("+editor.nodeById('r1').getAttribute('x')")
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=true; editor.transform('flipH');")
        x1 = page.evaluate("+editor.nodeById('r1').getAttribute('x')")
        page.evaluate("editor.transform('flipH');")
        x2 = page.evaluate("+editor.nodeById('r1').getAttribute('x')")
        check("artboard flip H mirrors then restores", abs(x1 - 140) < 1 and abs(x2 - x0) < 1, f"x0={x0} x1={x1} x2={x2}")

        # whole-artboard rotate 90° swaps the artboard dimensions, undoably
        page.evaluate("""svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'wide.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect data-hv-id="ra" x="10" y="10" width="50" height="30" fill="#36c"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('ra')", timeout=8000)
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=true; editor.transform('rotateCW');")
        check("artboard rotate 90° swaps dimensions", page.evaluate("editor.stage.getAttribute('viewBox').trim()") == "0 0 200 300")
        page.evaluate("editor.undo()"); page.wait_for_timeout(60)
        check("transform is undoable", page.evaluate("editor.stage.getAttribute('viewBox').trim()") == "0 0 300 200")

        section("Command layer: clipboard, select-all, nudge, context menu")
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1']); editor.copy(); editor.paste();")
        check("copy + paste adds a selected object", n_nodes(page) == 4 and page.evaluate("editor.selection.size") == 1)
        # Paste from OUTSIDE the app: pasted SVG markup is sanitized (no script/on*/javascript:) and
        # merged into the canvas as a grouped, selected object. Exercises the real sanitize+place path.
        mount_ctl(page)
        before_paste = n_nodes(page)
        ext = page.evaluate(r"""() => {
            const dirty = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
              + '<script>window.__pwn=1<\/script>'
              + '<rect x="0" y="0" width="20" height="20" fill="#0a0" onclick="alert(1)"/>'
              + '<a href="javascript:alert(2)"><circle cx="30" cy="30" r="6" fill="#00a"/></a></svg>';
            const clean = window.__paste.sanitize(dirty);
            const safe = !/<script/i.test(clean) && !/onclick/i.test(clean) && !/javascript:/i.test(clean) && !window.__pwn;
            window.__paste.svgIntoCanvas(dirty, 'Pasted vector');
            return { safe, sel: editor.selection.size }; }""")
        check("paste external vector sanitizes (script/on*/js:) + places a grouped object",
              ext["safe"] and n_nodes(page) > before_paste and ext["sel"] == 1, str(ext))
        mount_ctl(page)   # fresh flat mount: the paste above left a grouped (nested) object
        page.evaluate("editor.selectAll()")
        check("select all selects every artwork node", page.evaluate("editor.selection.size") == n_nodes(page))
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1']); editor.nudge(5,-3);")
        check("nudge moves the selection", "translate" in (page.evaluate("editor.nodeById('r1').getAttribute('transform')") or ""))

        # right-click an object → summons the persistent floating Properties panel + selects it
        mount_ctl(page)
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()")   # start closed so the right-click reaches the canvas
        r = node_rect(page, "r2")
        page.mouse.click(r["cx"], r["cy"], button="right"); page.wait_for_timeout(80)
        ctx = page.evaluate("""() => { const m=document.querySelector('.rail-section.properties'); return m
            ? { actions: m.querySelectorAll('.grid-item').length, style: !!m.querySelector('.fp-body input'),
                hasStrokeSeg: !!m.querySelector('.insp-seg') } : null; }""")
        # object right-click is now STYLE-ONLY (actions moved to the toolbars)
        check("object context panel is style-only (no actions grid)", ctx and ctx["style"] and ctx["actions"] == 0, str(ctx))
        check("right-click selects the object", page.evaluate("editor.selection.has('r2')"))
        # selecting an object enables the object action bar (cut) + layer reorder
        check("action bar enables on selection",
              page.evaluate("!document.querySelector('#act-cut').disabled && !document.querySelector('#layer-front').disabled"))
        page.keyboard.press("Escape"); page.wait_for_timeout(40)
        check("Escape closes the context menu", page.evaluate("!document.querySelector('.context-menu')"))

        section("Defs foundation: store, mint, clone-independence, GC, round-trip (Epic 0)")
        mount_ctl(page)
        f = page.evaluate(r"""() => {
            const NS='http://www.w3.org/2000/svg';
            const defs = editor._defs();
            const oneDefs = editor.stage.querySelectorAll('defs.hv-defs').length === 1 && defs === editor._defs();
            const idA = editor._mintDefId('hvgrad');
            const g = document.createElementNS(NS,'linearGradient'); g.setAttribute('id', idA);
            const s = document.createElementNS(NS,'stop'); s.setAttribute('offset','0'); s.setAttribute('stop-color','#f00'); g.appendChild(s);
            defs.appendChild(g);
            const r1 = editor.nodeById('r1'); r1.setAttribute('fill','url(#'+idA+')');
            // duplicate r1 → the clone's fill must repoint to a NEW, deep-copied gradient
            editor.selection = new Set(['r1']); editor.artboardSelected = false;
            editor.duplicate();
            const cloneId = [...editor.selection][0];
            const clone = editor.nodeById(cloneId);
            const cgid = (/url\(#([^)]+)\)/.exec(clone.getAttribute('fill')||'')||[])[1];
            const independent = !!cgid && cgid !== idA && !!editor.stage.querySelector('#'+CSS.escape(cgid));
            // serialize survival: gradient + its id present, all data-hv-* stripped
            const ser = editor.serialize();
            const serOk = ser.includes(idA) && ser.includes('linearGradient') && !ser.includes('data-hv-');
            // delete the clone → its copied gradient is GC'd; the original (still used by r1) survives
            editor.selection = new Set([cloneId]); editor.deleteSelection();
            const gcOk = !editor.stage.querySelector('#'+CSS.escape(cgid)) && !!editor.stage.querySelector('#'+CSS.escape(idA));
            return { oneDefs, independent, serOk, gcOk }; }""")
        check("defs store: single .hv-defs; clone deep-copies the gradient (independent)",
              f["oneDefs"] and f["independent"], str(f))
        check("defs round-trip: gradient survives serialize (data-hv-* stripped) + orphan GC on delete",
              f["serOk"] and f["gcOk"], str(f))
        # reopen a doc whose resource id is high-numbered → idSeq must advance past it (no re-mint collision)
        rid = page.evaluate(r"""() => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">'
              + '<defs class="hv-defs"><linearGradient id="hvgrad999"><stop offset="0" stop-color="#000"/></linearGradient></defs>'
              + '<rect data-hv-id="n2" x="1" y="1" width="9" height="9" fill="url(#hvgrad999)"/></svg>';
            window.mountStageFromText(svg, 'reopen-defs');
            const fresh = editor._mintDefId('hvgrad');
            return { n: +((/\d+/.exec(fresh)||[0])[0]), unused: !editor.stage.querySelector('#'+CSS.escape(fresh)), kept: !!editor.stage.querySelector('#hvgrad999') }; }""")
        check("reopen counts resource ids into idSeq (fresh mint can't collide)",
              rid["n"] > 999 and rid["unused"] and rid["kept"], str(rid))
        # Gradient paint model (Epic G core): applyPaint writes a gradient def + url(), paintOf reads
        # it back to a spec, it round-trips through serialize, and switching to solid GC's the gradient.
        mount_ctl(page)
        gm = page.evaluate(r"""() => {
            const spec = { type:'linear', x1:0,y1:0,x2:1,y2:0, stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff',opacity:0.5}] };
            editor.selection = new Set(['r1']); editor.artboardSelected = false;
            editor.push('grad'); editor.applyPaint('fill', { kind:'gradient', spec });
            const r1 = editor.nodeById('r1');
            const isUrl = /^url\(#hvgrad\d+\)$/.test(r1.getAttribute('fill')||'');
            const gid = (/url\(#([^)]+)\)/.exec(r1.getAttribute('fill')||'')||[])[1];
            const grad = gid ? editor.stage.querySelector('#'+CSS.escape(gid)) : null;
            const stops = grad ? grad.querySelectorAll('stop').length : 0;
            const back = editor.paintOf(r1, 'fill');
            const readOk = back.kind==='gradient' && back.spec.type==='linear' && back.spec.stops.length===2
                          && back.spec.stops[0].color==='#ff0000' && Math.abs(back.spec.stops[1].opacity-0.5)<0.01;
            const ser = editor.serialize();
            const serOk = ser.includes('linearGradient') && ser.includes(gid);
            editor.applyPaint('fill', { kind:'solid', color:'#00ff00' });   // switch to solid → gradient GC'd
            const solidOk = r1.getAttribute('fill')==='#00ff00' && !editor.stage.querySelector('#'+CSS.escape(gid));
            return { isUrl, stops, readOk, serOk, solidOk }; }""")
        check("gradient model: applyPaint writes def+url, paintOf round-trips, solid GC's it",
              gm["isUrl"] and gm["stops"]==2 and gm["readOk"] and gm["serOk"] and gm["solidOk"], str(gm))
        # Gradient UI (Epic G): the Colour panel exposes paint-type tabs; Linear applies a gradient
        # fill + a 2-stop strip, Radial swaps the type, Solid returns a flat colour. Panel-summon.
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1']); editor.artboardSelected=false; editor._renderInspector(); window.__docks && window.__docks.showColor();")
        page.wait_for_timeout(300)
        gu = page.evaluate(r"""() => {
            const tabs = [...document.querySelectorAll('.cp-ptype')].map(b=>b.dataset.t);
            const click = (t) => { const b=[...document.querySelectorAll('.cp-ptype')].find(x=>x.dataset.t===t); if (b) b.click(); };
            click('linear');
            const r = editor.nodeById('r1'); const m=/url\(#([^)]+)\)/.exec(r.getAttribute('fill')||'');
            const g = m ? editor.stage.querySelector('#'+CSS.escape(m[1])) : null;
            const isLinear = !!(g && /linearGradient$/i.test(g.tagName) && g.querySelectorAll('stop').length===2);
            const handles = document.querySelectorAll('.cp-grad-stop').length;
            click('radial');
            const m2=/url\(#([^)]+)\)/.exec(editor.nodeById('r1').getAttribute('fill')||''); const g2=m2?editor.stage.querySelector('#'+CSS.escape(m2[1])):null;
            const isRadial = !!(g2 && /radialGradient$/i.test(g2.tagName));
            click('solid');
            const solidOk = /^#?[0-9a-fA-F]{3,8}$/.test(editor.nodeById('r1').getAttribute('fill')||'');
            return { tabsOk: tabs.join(',')==='none,solid,linear,radial', isLinear, handles, isRadial, solidOk }; }""")
        check("gradient UI: Colour panel paint-type tabs apply linear/radial gradient + revert to solid",
              gu["tabsOk"] and gu["isLinear"] and gu["handles"]==2 and gu["isRadial"] and gu["solidOk"], str(gu))
        # Gradient survives a boolean (G.8): the union copies the source's url() fill → the result
        # is still gradient-filled (the def moves with it, no orphan, no dropped paint).
        bg = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="20" y="20" width="90" height="90" fill="#888"/><rect data-hv-id="b" x="70" y="70" width="90" height="90" fill="#888"/></svg>','bg');
            editor.selection=new Set(['b']); editor.artboardSelected=false;
            editor.push('g'); editor.applyPaint('fill', { kind:'gradient', spec:{ type:'linear', x1:0,y1:0,x2:1,y2:0, stops:[{offset:0,color:'#f00'},{offset:1,color:'#00f'}] } });
            editor.selection=new Set(['a','b']); editor.booleanOp('union');
            const ps=[...editor.stage.querySelectorAll('path[data-hv-id]')]; const res=ps[ps.length-1];
            const m=/url\(#([^)]+)\)/.exec(res?res.getAttribute('fill')||'':''); const g=m?editor.stage.querySelector('#'+CSS.escape(m[1])):null;
            return !!(g && /gradient$/i.test(g.tagName)); }""")
        check("gradient survives a boolean op (union keeps the url() fill)", bg is True)
        # On-canvas gradient handles (G.4) + inspector (G.5): a gradient object exposes an "Edit on
        # canvas" affordance; entering mounts start/end (linear) or centre/radius (radial) handles
        # that re-mount as the geometry changes and round-trip through serialize; Escape/clear exits.
        gh = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="40" y="40" width="120" height="120" fill="#888"/></svg>','gh');
            editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false;
            editor.push('g'); editor.applyPaint('fill',{kind:'gradient',spec:{type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#f00'},{offset:1,color:'#00f'}]}});
            editor._renderInspector();
            const hasBtn = [...document.querySelectorAll('.insp-action')].some(b=>/Edit on canvas/.test(b.textContent||''));
            editor.enterGradientEdit('fill');
            const linMounted = editor._gradMode && document.querySelectorAll('.hv-gradedit-handle').length===2 && document.querySelectorAll('.hv-gradedit-line').length===1;
            const g = editor._gradEl(editor.nodeById('r1'),'fill');
            editor.beginCoalesce(); g.setAttribute('x2','0.5'); g.setAttribute('y2','1'); editor._renderSelection(); editor.commitCoalesce('grad');
            const remount = document.querySelectorAll('.hv-gradedit-handle').length===2;
            const serOk = /x2="0.5"/.test(editor.serialize());
            editor.applyPaint('fill',{kind:'gradient',spec:{type:'radial',cx:0.5,cy:0.5,r:0.5,stops:[{offset:0,color:'#fff'},{offset:1,color:'#000'}]}});
            editor._gradMode=true; editor._renderSelection();
            const radMounted = document.querySelectorAll('.hv-gradedit-ring').length===1 && document.querySelectorAll('.hv-gradedit-handle').length===2;
            editor.clearGradMode();
            const exited = !editor._gradMode && document.querySelectorAll('.hv-gradedit-handle').length===0;
            return { hasBtn, linMounted, remount, serOk, radMounted, exited }; }""")
        check("gradient handles: edit affordance + linear/radial handles mount, re-mount, round-trip, exit",
              gh["hasBtn"] and gh["linMounted"] and gh["remount"] and gh["serOk"] and gh["radMounted"] and gh["exited"], str(gh))
        # Gradient hardening (stress pass): stroke gradients, no orphan buildup when cycling paint
        # types, undo/redo restores the def, and a saved→reopened gradient stays editable.
        gs = page.evaluate(r"""() => {
            const LIN = {kind:'gradient',spec:{type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#f00'},{offset:1,color:'#00f'}]}};
            const RAD = {kind:'gradient',spec:{type:'radial',cx:0.5,cy:0.5,r:0.5,stops:[{offset:0,color:'#fff'},{offset:1,color:'#000'}]}};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="20" y="20" width="80" height="80" fill="#ccc" stroke="#000" stroke-width="4"/></svg>','gs');
            editor.selection=new Set(['a']); editor.artboardSelected=false;
            editor.push('s1'); editor.applyPaint('stroke', LIN);
            const strokeGrad = editor.paintOf(editor.nodeById('a'),'stroke').kind==='gradient';
            // cycle fill paint types many times → exactly ONE live gradient remains (no orphan buildup)
            editor.push('s2');
            for (let i=0;i<6;i++){ editor.applyPaint('fill',LIN); editor.applyPaint('fill',RAD); editor.applyFill('#123456'); }
            editor.applyPaint('fill', LIN);
            const liveFillGrads = editor.stage.querySelectorAll('defs.hv-defs > linearGradient, defs.hv-defs > radialGradient').length; // stroke(1)+fill(1)
            // undo a fresh solid-fill step → the fill gradient (+ its def) comes back
            editor.push('s3'); editor.applyFill('#222222'); editor.undo();
            const undoOk = /url\(#/.test(editor.nodeById('a').getAttribute('fill')||'') && !!editor.stage.querySelector('defs.hv-defs linearGradient');
            // save → reopen → still an editable gradient
            window.mountStageFromText(editor.serialize(),'gs2');
            const node = editor.stage.querySelector('rect:not(.hv-artboard)');
            const reopenOk = node && editor.paintOf(node,'fill').kind==='gradient';
            return { strokeGrad, liveFillGrads, undoOk, reopenOk }; }""")
        check("gradient hardening: stroke gradient, no orphan buildup, undo/redo, reopen-editable",
              gs["strokeGrad"] and gs["liveFillGrads"]==2 and gs["undoOk"] and gs["reopenOk"], str(gs))
        # Masks & clipping (Epic M): make a clipping mask (top object → <clipPath>, rest grouped),
        # release it (shape returns as artwork, def GC'd), make an opacity mask (<mask> luminance),
        # round-trip + clone independence, and the inspector Release / Make affordances.
        section("Masks & clipping: clip + opacity masks, release, round-trip, clone (Epic M)")
        mount_ctl(page)
        mk = page.evaluate(r"""() => {
            editor.setTool('select');
            editor.selection = new Set(['r1','r3']); editor.artboardSelected = false;   // r3 is frontmost → the mask
            editor._renderSelection(); editor._renderInspector();
            editor.makeClipMask();
            const gid = [...editor.selection][0];
            const g = editor.nodeById(gid);
            const cid = (/url\(#([^)]+)\)/.exec(g && g.getAttribute('clip-path')||'')||[])[1];
            const cp = cid ? editor.stage.querySelector('#'+CSS.escape(cid)) : null;
            const isClipGroup = !!(g && g.tagName.toLowerCase()==='g' && cid && cid.indexOf('hvclip')===0);
            const clipInDefs = !!(cp && cp.tagName.toLowerCase()==='clippath' && cp.closest('defs.hv-defs') && cp.children.length===1);
            const contentGrouped = g.querySelector('[data-hv-id]') && !editor.stage.querySelector('rect[data-hv-id="r3"]'); // r3 moved into defs (id stripped)
            const detected = editor._clipGroupOf(g) === g;
            // round-trip: clipPath id + clip-path attr survive serialize; data-hv-* stripped
            const ser = editor.serialize();
            const serOk = ser.includes(cid) && ser.includes('clipPath') && ser.includes('clip-path') && !ser.includes('data-hv-');
            return { isClipGroup, clipInDefs, contentGrouped: !!contentGrouped, detected, serOk, gid }; }""")
        check("clip mask: top object → clipPath in defs, content grouped, detected, round-trips",
              mk["isClipGroup"] and mk["clipInDefs"] and mk["contentGrouped"] and mk["detected"] and mk["serOk"], str(mk))
        # Release: the masking shape comes back as a normal object inside the (now plain) group; the
        # clipPath def is GC'd; clone-independence — duplicating a clip group deep-copies the clipPath.
        rel = page.evaluate(r"""() => {
            const g = editor.nodeById('%s');
            const cid = (/url\(#([^)]+)\)/.exec(g.getAttribute('clip-path')||'')||[])[1];
            // first prove clone independence BEFORE releasing
            editor.selection = new Set([g.getAttribute('data-hv-id')]); editor.artboardSelected=false;
            editor.duplicate();
            const dupId = [...editor.selection][0];
            const dup = editor.nodeById(dupId);
            const dcid = (/url\(#([^)]+)\)/.exec(dup.getAttribute('clip-path')||'')||[])[1];
            const cloneIndep = !!dcid && dcid !== cid && !!editor.stage.querySelector('#'+CSS.escape(dcid));
            editor.selection = new Set([dupId]); editor.deleteSelection();   // drop the dup → its clipPath GC's
            const dupGc = !editor.stage.querySelector('#'+CSS.escape(dcid)) && !!editor.stage.querySelector('#'+CSS.escape(cid));
            // now release the original
            editor.selection = new Set([g.getAttribute('data-hv-id')]); editor.artboardSelected=false;
            editor.releaseMask();
            const released = !g.hasAttribute('clip-path') && !editor.stage.querySelector('#'+CSS.escape(cid));
            const shapeBack = g.querySelectorAll('[data-hv-id]').length >= 2;   // content + the former mask, now a normal child
            return { cloneIndep, dupGc, released, shapeBack }; }""" % mk["gid"])
        check("clip mask: clone deep-copies the clipPath (independent), release returns the shape + GC's the def",
              rel["cloneIndep"] and rel["dupGc"] and rel["released"] and rel["shapeBack"], str(rel))
        # Opacity mask via <mask> (luminance); detection + release.
        mount_ctl(page)
        om = page.evaluate(r"""() => {
            editor.setTool('select');
            editor.selection = new Set(['r1','r3']); editor.artboardSelected=false;
            editor.makeOpacityMask();
            const g = editor.nodeById([...editor.selection][0]);
            const mid = (/url\(#([^)]+)\)/.exec(g.getAttribute('mask')||'')||[])[1];
            const mk = mid ? editor.stage.querySelector('#'+CSS.escape(mid)) : null;
            const isMaskGroup = !!(mid && mid.indexOf('hvmask')===0 && mk && mk.tagName.toLowerCase()==='mask' && mk.closest('defs.hv-defs'));
            const detected = editor._maskGroupOf(g) === g;
            const ser = editor.serialize(); const serOk = ser.includes(mid) && ser.includes('<mask');
            editor.selection = new Set([g.getAttribute('data-hv-id')]); editor.releaseMask();
            const released = !g.hasAttribute('mask') && !editor.stage.querySelector('#'+CSS.escape(mid));
            return { isMaskGroup, detected, serOk, released }; }""")
        check("opacity mask: top object → <mask> (luminance) in defs, detected, round-trips, releases",
              om["isMaskGroup"] and om["detected"] and om["serOk"] and om["released"], str(om))
        # Inspector affordances (M.4): ≥2 selected with a vector on top → "Make clipping mask";
        # a selected clip group → "Release".
        mount_ctl(page)
        insp = page.evaluate(r"""() => {
            // assert on the panel BUILDER (_objectPanel) directly — the live inspector is the
            // right-click context panel, mounted on demand, which the harness doesn't open here.
            editor.setTool('select');
            editor.selection = new Set(['r1','r3']); editor.artboardSelected=false;
            const p1 = editor._objectPanel(editor.selectedNodes()).innerHTML;
            const makeBtn = /Make clipping mask/.test(p1) && /Make opacity mask/.test(p1);
            editor.makeClipMask();
            const g = editor.nodeById([...editor.selection][0]);
            const p2 = editor._objectPanel([g]).innerHTML;
            const relBtn = /Clipping mask/.test(p2) && />Release</.test(p2);
            return { makeBtn, relBtn }; }""")
        check("mask inspector: Make-clipping-mask on a 2+ selection, Release on a clip group",
              insp["makeBtn"] and insp["relBtn"], str(insp))
        # Mask hardening (stress pass): undo fully restores the un-masked objects; deleting a clip
        # group GC's its def; masks NEST; a clip shape's own gradient is NOT GC'd while it clips;
        # release works after save→reopen (DOM-only); a raster on top is refused as a clip shape.
        mh = page.evaluate(r"""() => {
            const reset = () => { window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="20" y="20" width="40" height="40" fill="#36c"/><rect data-hv-id="r2" x="120" y="20" width="40" height="40" fill="#c33"/><rect data-hv-id="r3" x="70" y="120" width="40" height="40" fill="#3a5"/></svg>','mh'); editor.setTool('select'); };
            reset(); editor.selection=new Set(['r1','r3']); editor.artboardSelected=false; editor.makeClipMask(); editor.undo();
            const undoOk = editor.stage.querySelectorAll('rect[data-hv-id]').length===3 && editor.stage.querySelectorAll('g[data-hv-id]').length===0 && editor.stage.querySelectorAll('defs.hv-defs clipPath').length===0;
            reset(); editor.selection=new Set(['r1','r3']); editor.makeClipMask();
            let g = editor.nodeById([...editor.selection][0]); editor.selection=new Set([g.getAttribute('data-hv-id')]); editor.deleteSelection();
            const delGc = editor.stage.querySelectorAll('defs.hv-defs clipPath').length===0;
            reset(); editor.selection=new Set(['r1','r3']); editor.makeClipMask();
            const gid=[...editor.selection][0]; editor.selection=new Set([gid,'r2']); editor.makeClipMask();
            const outer=editor.nodeById([...editor.selection][0]);
            const nested = editor.stage.querySelectorAll('defs.hv-defs clipPath').length===2 && !!outer.querySelector('g[clip-path]');
            reset();
            editor.selection=new Set(['r3']); editor.push('g'); editor.applyPaint('fill',{kind:'gradient',spec:{type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#f00'},{offset:1,color:'#00f'}]}});
            const grId=(/url\(#([^)]+)\)/.exec(editor.nodeById('r3').getAttribute('fill'))||[])[1];
            editor.selection=new Set(['r1','r3']); editor.makeClipMask(); editor._gcDefs();
            const gradKept = !!editor.stage.querySelector('#'+CSS.escape(grId));
            reset(); editor.selection=new Set(['r1','r3']); editor.makeClipMask();
            window.mountStageFromText(editor.serialize(),'mh2');
            g=[...editor.stage.querySelectorAll('g[data-hv-id]')].find(x=>editor._clipGroupOf(x)===x);
            editor.selection=new Set([g.getAttribute('data-hv-id')]); editor.releaseMask();
            const reopenRel = !g.hasAttribute('clip-path') && editor.stage.querySelectorAll('defs.hv-defs clipPath').length===0;
            return { undoOk, delGc, nested, gradKept, reopenRel }; }""")
        check("mask hardening: undo restores, delete GC's, masks nest, clip-shape gradient kept, reopen-release",
              mh["undoOk"] and mh["delGc"] and mh["nested"] and mh["gradKept"] and mh["reopenRel"], str(mh))
        # Expand & Pathfinder (Epic X): outline stroke (filled-path replaces the stroke, honouring
        # width/cap via the raster→bézier engine), offset path (grow/shrink copies), and Pathfinder
        # Divide (overlap → grouped face regions, each coloured by the topmost shape). Round-trips.
        section("Expand & Pathfinder: outline-stroke, offset-path, divide (Epic X)")
        ox = page.evaluate(r"""() => {
            // 1. outline an OPEN stroked path (no fill) → replaced by a filled outline path
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="p1" d="M30 100 L170 100" fill="none" stroke="#cc3333" stroke-width="20" stroke-linecap="round"/></svg>','ox1');
            editor.setTool('select'); editor.selection=new Set(['p1']); editor.artboardSelected=false; editor.outlineStroke();
            const gone = editor.nodeById('p1')===null;
            const out = editor.stage.querySelector('path[data-hv-id]');
            const filledOutline = !!out && out.getAttribute('fill')==='#cc3333' && (out.getAttribute('stroke')||'none')==='none' && (out.getAttribute('d')||'').length>20;
            const ser = editor.serialize(); const serOk = ser.includes('path') && !ser.includes('data-hv-');
            // 2. outline a FILLED+stroked rect → original kept (no stroke) + outline added
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="40" y="40" width="120" height="120" fill="#ffffff" stroke="#000000" stroke-width="12"/></svg>','ox2');
            editor.selection=new Set(['r1']); editor.outlineStroke();
            const r1=editor.nodeById('r1');
            const keptFill = !!r1 && r1.getAttribute('fill')==='#ffffff' && (r1.getAttribute('stroke')||'none')==='none' && editor.stage.querySelectorAll('[data-hv-id]').length===2;
            return { gone, filledOutline, serOk, keptFill }; }""")
        check("outline stroke: open path → filled outline (round cap), filled+stroked keeps fill + adds outline, round-trips",
              ox["gone"] and ox["filledOutline"] and ox["serOk"] and ox["keptFill"], str(ox))
        of = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240"><rect data-hv-id="r1" x="80" y="80" width="80" height="80" fill="#3399cc"/></svg>','of1');
            editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false;
            const w0 = editor.nodeById('r1').getBBox().width;
            editor.offsetPath(18);
            const copy = editor.nodeById([...editor.selection][0]);
            const grew = !!copy && copy.getBBox().width > w0+12 && copy.getAttribute('fill')==='#3399cc' && editor.stage.querySelectorAll('[data-hv-id]').length===2;
            // shrink the original
            editor.selection=new Set(['r1']); editor.offsetPath(-15);
            const shrunk = editor.nodeById([...editor.selection][0]).getBBox().width < w0-8;
            // over-shrink collapses gracefully (no new object, original count preserved)
            editor.selection=new Set(['r1']); const before=editor.stage.querySelectorAll('[data-hv-id]').length;
            editor.offsetPath(-9999);
            const graceful = editor.stage.querySelectorAll('[data-hv-id]').length===before;
            return { grew, shrunk, graceful }; }""")
        check("offset path: grow adds a larger copy (fill kept), shrink smaller, over-shrink collapses cleanly",
              of["grew"] and of["shrunk"] and of["graceful"], str(of))
        dv = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="30" y="60" width="90" height="80" fill="#ee5555"/><rect data-hv-id="b" x="90" y="60" width="90" height="80" fill="#55ee55"/></svg>','dv1');
            editor.setTool('select'); editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            editor.pathfinder('divide');
            const g = editor.nodeById([...editor.selection][0]);
            const isG = !!g && g.tagName.toLowerCase()==='g';
            const faces = isG ? g.querySelectorAll('path[data-hv-id]').length : 0;
            const colours = isG ? new Set([...g.querySelectorAll('path')].map(p=>p.getAttribute('fill'))).size : 0;
            const origGone = !editor.stage.querySelector('rect[data-hv-id="a"]') && !editor.stage.querySelector('rect[data-hv-id="b"]');
            editor.undo();
            const undoOk = !!editor.stage.querySelector('rect[data-hv-id="a"]') && !!editor.stage.querySelector('rect[data-hv-id="b"]');
            return { isG, faces, colours, origGone, undoOk }; }""")
        check("pathfinder divide: 2 overlapping rects → grouped 3 faces in 2 colours, originals gone, undo restores",
              dv["isG"] and dv["faces"]==3 and dv["colours"]==2 and dv["origGone"] and dv["undoOk"], str(dv))
        pf = page.evaluate(r"""() => {
            const D2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="30" y="60" width="90" height="80" fill="#ee5555"/><rect data-hv-id="b" x="90" y="60" width="90" height="80" fill="#55ee55"/></svg>';
            const D3 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 200" width="220" height="200"><rect data-hv-id="a" x="20" y="60" width="80" height="80" fill="#ee5555"/><rect data-hv-id="b" x="70" y="60" width="80" height="80" fill="#ee5555"/><rect data-hv-id="c" x="120" y="60" width="80" height="80" fill="#55ee55"/></svg>';
            const run = (doc, sel, op) => { window.mountStageFromText(doc,'pf'); editor.setTool('select'); editor.selection=new Set(sel); editor.artboardSelected=false; editor.pathfinder(op);
                const ids=[...editor.selection]; const g=editor.nodeById(ids[0]); const isG=!!g&&g.tagName.toLowerCase()==='g';
                return { isG, paths: isG?g.querySelectorAll('path').length:ids.length,
                         colours: isG?new Set([...g.querySelectorAll('path')].map(p=>p.getAttribute('fill'))).size:new Set(ids.map(i=>{const n=editor.nodeById(i);return n&&n.getAttribute('fill');})).size,
                         gone: sel.every(i=>!editor.stage.querySelector('[data-hv-id="'+i+'"]')) }; };
            const trim = run(D2, ['a','b'], 'trim');            // 2 pieces, 2 colours, grouped
            const crop = run(D2, ['a','b'], 'crop');            // a∩b, coloured a, single-region group
            const minusB = run(D2, ['a','b'], 'minus-back');    // b − a, single green path (not a group)
            const merge = run(D3, ['a','b','c'], 'merge');      // a,b red merge → 2 colours
            return { trim, crop, minusB, merge }; }""")
        check("pathfinder trim/crop/minus-back/merge: hidden-removal, front-crop, back-subtract, same-colour-merge",
              pf["trim"]["isG"] and pf["trim"]["paths"]==2 and pf["trim"]["colours"]==2 and pf["trim"]["gone"]
              and pf["crop"]["isG"] and pf["crop"]["colours"]==1 and pf["crop"]["gone"]
              and (not pf["minusB"]["isG"]) and pf["minusB"]["paths"]==1 and pf["minusB"]["colours"]==1 and pf["minusB"]["gone"]
              and pf["merge"]["isG"] and pf["merge"]["colours"]==2 and pf["merge"]["gone"], str(pf))
        # Expand (X.2): a live-shape <path> + a primitive <circle>, one stroked — expand bakes
        # all to plain <path> (no data-hv-shape, no primitives), outlining the stroke; round-trips.
        ex = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 200" width="220" height="200"><path data-hv-id="r1" data-hv-shape="rect" d="M40 40 H140 V140 H40 Z" fill="#ffcc00" stroke="#333333" stroke-width="8"/><circle data-hv-id="c1" cx="180" cy="60" r="22" fill="#00ccff"/></svg>','ex');
            editor.setTool('select'); editor.selection=new Set(['r1','c1']); editor.artboardSelected=false;
            editor.expandSelection();
            const allPaths = [...editor.stage.querySelectorAll('[data-hv-id]')].every(n=>n.tagName.toLowerCase()==='path');
            const noLive = editor.stage.querySelectorAll('[data-hv-shape]').length===0;
            const noPrim = editor.stage.querySelectorAll('rect[data-hv-id],circle[data-hv-id],ellipse[data-hv-id]').length===0;
            const r1 = editor.nodeById('r1');
            const strokeGone = !!r1 && (r1.getAttribute('stroke')||'none')==='none' && r1.getAttribute('fill')==='#ffcc00';
            const ser = editor.serialize(); const serOk = !ser.includes('data-hv-') && ser.includes('<path');
            return { allPaths, noLive, noPrim, strokeGone, serOk }; }""")
        check("expand: live shapes + primitives → plain paths, strokes outlined, no data-hv-shape, round-trips",
              ex["allPaths"] and ex["noLive"] and ex["noPrim"] and ex["strokeGone"] and ex["serOk"], str(ex))
        # Expand/Pathfinder hardening (stress pass): a dashed stroke outlines to disjoint pieces;
        # outline undo restores the stroke; pathfinder flattens a GROUPED selection; an evenodd
        # donut offset keeps its hole; >6 inputs are refused; a no-trace outline never drops the node.
        xh = page.evaluate(r"""() => {
            // dashed → multiple subpaths
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60" width="200" height="60"><path data-hv-id="p" d="M10 30 L190 30" fill="none" stroke="#000000" stroke-width="14" stroke-dasharray="20 16"/></svg>','xh1');
            editor.setTool('select'); editor.selection=new Set(['p']); editor.artboardSelected=false; editor.outlineStroke();
            const o = editor.stage.querySelector('path[data-hv-id]');
            const dashPieces = o ? (o.getAttribute('d').match(/M/gi)||[]).length : 0;
            // outline undo restores stroke
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r" x="40" y="40" width="100" height="100" fill="none" stroke="#cc0000" stroke-width="10"/></svg>','xh2');
            editor.selection=new Set(['r']); editor.outlineStroke(); editor.undo();
            const undoOk = !!editor.nodeById('r') && editor.nodeById('r').getAttribute('stroke')==='#cc0000' && editor.stage.querySelectorAll('[data-hv-id]').length===1;
            // pathfinder on a GROUPED selection (effective-leaves flatten)
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><g data-hv-id="g0"><rect data-hv-id="a" x="30" y="60" width="90" height="80" fill="#ee5555"/><rect data-hv-id="b" x="90" y="60" width="90" height="80" fill="#55ee55"/></g></svg>','xh3');
            editor.selection=new Set(['g0']); editor.pathfinder('divide');
            const g=editor.nodeById([...editor.selection][0]); const groupedOk = !!g && g.tagName.toLowerCase()==='g' && g.querySelectorAll('path').length>=3;
            // evenodd donut offset keeps the hole
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="d" d="M40 40 H160 V160 H40 Z M80 80 H120 V120 H80 Z" fill-rule="evenodd" fill="#3399cc"/></svg>','xh4');
            editor.selection=new Set(['d']); editor.offsetPath(8);
            const donutOk = (editor.nodeById([...editor.selection][0]).getAttribute('d').match(/M/gi)||[]).length>=2;
            // >6 inputs refused
            let r=''; for (let i=0;i<7;i++) r+='<rect data-hv-id="r'+i+'" x="'+(10+i*8)+'" y="40" width="40" height="40" fill="#999"/>';
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120">'+r+'</svg>','xh5');
            editor.selection=new Set(['r0','r1','r2','r3','r4','r5','r6']);
            const before=editor.stage.querySelectorAll('[data-hv-id]').length; editor.pathfinder('divide');
            const capOk = editor.stage.querySelectorAll('[data-hv-id]').length===before && editor.stage.querySelectorAll('g[data-hv-id]').length===0;
            return { dashPieces, undoOk, groupedOk, donutOk, capOk }; }""")
        check("expand/pathfinder hardening: dashed→pieces, outline-undo, grouped pathfinder, donut-offset hole, >6 refused",
              xh["dashPieces"]>=4 and xh["undoOk"] and xh["groupedOk"] and xh["donutOk"] and xh["capOk"], str(xh))
        # Geometric stroker (Epic S): the analytic outline replaces the raster route in
        # _strokeOutlinePath — exact joins/caps, no bitmap quantization. Guards: a closed
        # stroke gives a precise annulus bbox WITH a hole; a hairline relative to a big bbox
        # still outlines (the raster route lost thin coverage); a miter corner reaches its apex.
        sg = page.evaluate(r"""() => {
            // 1. closed square stroke w=16 → outer bbox exactly 100+16, inner hole present
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r" x="50" y="50" width="100" height="100" fill="none" stroke="#225588" stroke-width="16" stroke-linejoin="miter"/></svg>','sg1');
            editor.setTool('select'); editor.selection=new Set(['r']); editor.artboardSelected=false; editor.outlineStroke();
            const o=editor.stage.querySelector('path[data-hv-id]'); const bb=o?o.getBBox():{width:0,height:0};
            const precise = Math.abs(bb.width-116)<2 && Math.abs(bb.height-116)<2;
            const hole = o ? (o.getAttribute('d').match(/M/gi)||[]).length>=2 : false;
            // 2. hairline relative to a large bbox (w/big ≈ 1/330) still produces an outline
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 200" width="2000" height="200"><path data-hv-id="h" d="M20 100 L1980 140" fill="none" stroke="#c33" stroke-width="6" stroke-linecap="butt"/></svg>','sg2');
            editor.selection=new Set(['h']); editor.outlineStroke();
            const oh=editor.stage.querySelector('path[data-hv-id]');
            const hairline = !!oh && oh.getAttribute('fill')==='#c33' && (oh.getAttribute('d')||'').length>20 && oh.getBBox().width>1900;
            // 3. miter join reaches its apex: an L outline extends to the outer corner (bbox 120+hw)
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="l" d="M30 30 L150 30 L150 150" fill="none" stroke="#000" stroke-width="20" stroke-linejoin="miter" stroke-linecap="butt"/></svg>','sg3');
            editor.selection=new Set(['l']); editor.outlineStroke();
            const ol=editor.stage.querySelector('path[data-hv-id]'); const bl=ol?ol.getBBox():{x:0,width:0};
            const miterApex = !!ol && (bl.x+bl.width) > 158;   // 150 + hw(10) outer corner
            return { precise, hole, hairline, miterApex }; }""")
        check("geometric stroker (Epic S): precise annulus bbox+hole, hairline-relative outline, miter apex reached",
              sg["precise"] and sg["hole"] and sg["hairline"] and sg["miterApex"], str(sg))
        # Width tool (Epic W): a stroked path → a parametric <g data-hv-wstroke> with a generated
        # variable ribbon (the stroker's per-vertex width). Make / swell-profile / uniform-base
        # scale / Release / Expand; serialize bakes to a plain path (no data-hv-*); no errors.
        section("Width tool: variable-width strokes (Epic W)")
        wv = page.evaluate(r"""() => {
            const out = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="p1" d="M30 100 L170 100" fill="none" stroke="#cc3333" stroke-width="12"/></svg>','wv1');
            editor.setTool('width'); editor.selection=new Set(['p1']); editor.artboardSelected=false;
            const ids = editor.makeWidthStroke(['p1']); const g = editor.nodeById(ids[0]);
            out.made = !!g && g.tagName.toLowerCase()==='g' && g.hasAttribute('data-hv-wstroke') && editor.nodeById('p1')===null;
            const rb = g && g.querySelector('path[data-hv-wribbon]');
            out.ribbon = !!rb && rb.getAttribute('fill')==='#cc3333' && (rb.getAttribute('d')||'').length>20 && Math.abs(rb.getBBox().height-12)<3;
            // swell the middle → ribbon grows tall there (variable width really renders)
            const spec = editor._wsSpec(g); spec.profile=[{t:0,l:6,r:6},{t:0.5,l:30,r:30},{t:1,l:6,r:6}];
            editor._wsSet(g, spec); editor._regenWidthStroke(g);
            out.swell = g.querySelector('path[data-hv-wribbon]').getBBox().height > 50;
            // base-width scrub scales the whole profile; uniform reset flattens it
            editor.setWidthBase(g, 24); out.scaled = editor._wsSpec(g).profile[1].l > 55;
            editor.resetWidthUniform(g); out.uniform = editor._wsSpec(g).profile.every(s=>Math.abs(s.l-12)<0.01);
            // serialize → plain path, no data-hv-* / wstroke
            const ser = editor.serialize(); out.serOk = ser.includes('<path') && !ser.includes('data-hv-') && !ser.includes('wstroke');
            // release → stroked path again
            editor.releaseWidthStroke(g);
            const rp = editor.stage.querySelector('path[data-hv-id]');
            out.released = !!rp && rp.getAttribute('stroke')==='#cc3333' && editor.stage.querySelector('[data-hv-wstroke]')===null;
            // remake + expand → plain filled path, group gone, undo restores the group
            const ids2 = editor.makeWidthStroke([rp.getAttribute('data-hv-id')]);
            editor.expandWidthStroke(editor.nodeById(ids2[0]));
            out.expanded = editor.stage.querySelector('[data-hv-wstroke]')===null && editor.stage.querySelector('path[data-hv-id][fill="#cc3333"]')!==null;
            editor.undo(); out.undoOk = editor.stage.querySelector('[data-hv-wstroke]')!==null;
            return out; }""")
        check("width tool: make→variable ribbon, swell renders, base-scale, uniform reset, release, expand+undo, round-trips",
              wv["made"] and wv["ribbon"] and wv["swell"] and wv["scaled"] and wv["uniform"] and wv["serOk"] and wv["released"] and wv["expanded"] and wv["undoOk"], str(wv))
        # Path-construction tools (Epic B): Shape Builder / Scissors / Knife / Eraser — driven via
        # their pure cores (shapeBuilderPaint / scissorsCut / knifeCut / eraseSweep). Each ends in
        # plain editable paths on the same raster+marching engine the booleans use; undo restores.
        section("Path tools: Shape Builder / Scissors / Knife / Eraser (Epic B)")
        bld = page.evaluate(r"""() => {
            const out = {};
            const two = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="40" y="70" width="80" height="60" fill="#ee5555"/><rect data-hv-id="b" x="90" y="70" width="80" height="60" fill="#55ee55"/></svg>';
            // Shape Builder merge: paint across both → one path, rects gone, undo restores both rects
            window.mountStageFromText(two,'b1'); editor.setTool('shapebuilder'); editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            editor.shapeBuilderPaint([{x:60,y:100},{x:100,y:100},{x:150,y:100}], false);
            out.merge = editor.stage.querySelectorAll('path[data-hv-id]').length===1 && editor.stage.querySelectorAll('rect[data-hv-id]').length===0;
            editor.undo(); out.mergeUndo = editor.stage.querySelectorAll('rect[data-hv-id]').length===2;
            // Shape Builder Alt-remove: paint just the overlap → it's removed (result present)
            window.mountStageFromText(two,'b2'); editor.selection=new Set(['a','b']);
            editor.shapeBuilderPaint([{x:105,y:100}], true);
            out.remove = editor.stage.querySelectorAll('path[data-hv-id]').length>=1 && editor.stage.querySelectorAll('rect[data-hv-id]').length===0;
            // Scissors on a CLOSED rect path → reopens (no Z), still one object
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="c" d="M50 50 H150 V150 H50 Z" fill="#39c"/></svg>','b3'); editor.setTool('scissors');
            editor.scissorsCut(100, 50, 6);
            const cp = editor.stage.querySelector('path[data-hv-id]');
            out.scClosed = !!cp && !/[zZ]/.test(cp.getAttribute('d')||'') && editor.stage.querySelectorAll('path[data-hv-id]').length===1;
            // Scissors on an OPEN path → two objects; undo restores one
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path data-hv-id="o" d="M30 100 L170 100" fill="none" stroke="#000" stroke-width="6"/></svg>','b4');
            editor.scissorsCut(100, 100, 6);
            out.scOpen = editor.stage.querySelectorAll('path[data-hv-id]').length===2;
            editor.undo(); out.scUndo = editor.stage.querySelectorAll('path[data-hv-id]').length===1;
            // Knife straight cut through a rect → two pieces, original gone
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="k" x="60" y="60" width="80" height="80" fill="#c84"/></svg>','b5'); editor.setTool('knife'); editor.selection=new Set();
            editor.knifeCut([{x:100,y:40},{x:100,y:160}], true);
            out.knife = editor.stage.querySelectorAll('path[data-hv-id]').length===2 && editor.stage.querySelectorAll('rect[data-hv-id]').length===0;
            // Eraser sweep across a rect → splits into 2 lobes (a hole through the middle); undo restores
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="e" x="40" y="40" width="120" height="120" fill="#7a3"/></svg>','b6'); editor.setTool('eraser'); editor.selection=new Set();
            editor.eraseSweep([{x:40,y:100},{x:80,y:100},{x:120,y:100},{x:160,y:100}], 16);
            const ep = editor.stage.querySelector('path[data-hv-id]');
            out.erase = !!ep && (ep.getAttribute('d').match(/M/gi)||[]).length>=2;
            editor.undo(); out.eraseUndo = !!editor.stage.querySelector('rect[data-hv-id="e"]');
            return out; }""")
        check("shape builder merge+undo / alt-remove, scissors close→open & open→two+undo, knife two pieces, eraser splits+undo",
              bld["merge"] and bld["mergeUndo"] and bld["remove"] and bld["scClosed"] and bld["scOpen"] and bld["scUndo"]
              and bld["knife"] and bld["erase"] and bld["eraseUndo"], str(bld))
        # Blend tool (Epic L): interpolate N shapes between two objects → a parametric
        # <g data-hv-blend> (endpoints + generated steps), morphing geometry + colour. Steps
        # param regen, reverse, Expand+undo; serialize bakes to a plain group (no data-hv-*).
        section("Blend tool: interpolate between two shapes (Epic L)")
        bn = page.evaluate(r"""() => {
            const o = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><circle data-hv-id="a" cx="50" cy="100" r="30" fill="#ff3333"/><circle data-hv-id="b" cx="350" cy="100" r="30" fill="#3333ff"/></svg>','bn');
            editor.setTool('select'); editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            editor.makeBlend();
            const g = editor.nodeById([...editor.selection][0]);
            o.group = !!g && g.tagName.toLowerCase()==='g' && g.hasAttribute('data-hv-blend');
            o.origGone = !editor.stage.querySelector('circle[data-hv-id]');
            const spec = editor._blendSpec(g);
            o.childCount = g.querySelectorAll('path[data-hv-id]').length === spec.steps + 2;
            const kids=[...g.querySelectorAll('path[data-hv-id]')]; const mid=kids[Math.floor(kids.length/2)]; const mbb=mid.getBBox();
            o.midPlaced = mbb.x > 60 && mbb.x < 340;                         // a step sits between the endpoints
            const mf=(mid.getAttribute('fill')||'').toLowerCase();
            o.midColour = /^#/.test(mf) && mf!=='#ff3333' && mf!=='#3333ff';  // colour interpolated
            editor.setBlendParam(g, 'steps', 3); o.regen = g.querySelectorAll('path[data-hv-id]').length === 5;
            editor.setBlendParam(g, 'reverse', true); o.reverse = editor._blendSpec(g).reverse===true && g.querySelectorAll('path[data-hv-id]').length===5;
            const ser = editor.serialize(); o.serOk = ser.includes('<g') && ser.includes('<path') && !ser.includes('data-hv-') && !ser.includes('blend');
            editor.expandBlend(g); o.expanded = !g.hasAttribute('data-hv-blend') && g.querySelectorAll('path').length===5;
            editor.undo(); o.undoOk = editor.stage.querySelector('[data-hv-blend]')!==null;
            return o; }""")
        check("blend: 2 shapes → parametric group (endpoints+steps), colour+shape interp, steps regen, reverse, expand+undo, round-trips",
              bn["group"] and bn["origGone"] and bn["childCount"] and bn["midPlaced"] and bn["midColour"]
              and bn["regen"] and bn["reverse"] and bn["serOk"] and bn["expanded"] and bn["undoOk"], str(bn))
        # Colour systems (Epic C): Pattern fills (top object → <pattern> in defs applied below;
        # tile scale/rotate via patternTransform; round-trips) + Recolor Artwork (harvest distinct
        # solid colours, remap one exactly, Hue/Sat/Light shift over all). (Global colours deferred.)
        section("Colour systems: Pattern fills + Recolor Artwork (Epic C)")
        cl = page.evaluate(r"""() => {
            const o = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="bg" x="20" y="20" width="160" height="160" fill="#dddddd"/><circle data-hv-id="dot" cx="40" cy="40" r="8" fill="#cc3366"/></svg>','cl1');
            editor.setTool('select'); editor.selection=new Set(['bg','dot']); editor.artboardSelected=false;
            editor.fillWithPattern();
            const bg = editor.nodeById('bg'); const fill = bg?bg.getAttribute('fill'):'';
            o.patApplied = /url\(#hvpat/.test(fill||'') && editor.nodeById('dot')===null;
            const pid = (/#([^)]+)\)/.exec(fill)||[])[1]; const pat = pid && editor.stage.querySelector('#'+CSS.escape(pid));
            o.patDef = !!pat && pat.tagName.toLowerCase()==='pattern' && !!pat.querySelector('circle');
            editor.setPatternParam(bg,'scale',2); editor.setPatternParam(bg,'rotate',30);
            o.patXform = /scale\(2/.test(pat.getAttribute('patternTransform')||'') && /rotate\(30/.test(pat.getAttribute('patternTransform')||'');
            const ser = editor.serialize(); o.patSer = ser.includes('<pattern') && ser.includes('url(#'+pid+')') && !ser.includes('data-hv-');
            editor.undo(); editor.undo(); editor.undo(); o.patUndo = !!editor.nodeById('dot') && editor.nodeById('bg').getAttribute('fill')==='#dddddd';
            // Recolor
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="10" y="10" width="50" height="50" fill="#ff0000"/><rect data-hv-id="b" x="70" y="10" width="50" height="50" fill="#ff0000"/><rect data-hv-id="c" x="130" y="10" width="50" height="50" fill="#0000ff"/></svg>','cl2');
            editor.selection=new Set(['a','b','c']); editor.artboardSelected=false;
            const h = editor._harvestColors(editor.selectedNodes());
            o.harvest = h.size===2 && (h.get('#ff0000')||[]).length===2;
            editor.push('Recolor'); editor.recolorApply(h.get('#ff0000'),'#00aa00');
            o.remap = editor.nodeById('a').getAttribute('fill')==='#00aa00' && editor.nodeById('c').getAttribute('fill')==='#0000ff';
            editor._recolorClearBase(); editor.beginCoalesce(); editor.recolorShift(60,0,0); editor.commitCoalesce('Recolor'); editor._recolorClearBase();
            const fa = editor.nodeById('a').getAttribute('fill'); o.shift = /^#[0-9a-f]{6}$/i.test(fa) && fa.toLowerCase()!=='#00aa00';
            return o; }""")
        check("pattern fill: top→<pattern> applied below, tile scale/rotate, round-trips, undo · recolor: harvest 2, remap exact, HSL shift",
              cl["patApplied"] and cl["patDef"] and cl["patXform"] and cl["patSer"] and cl["patUndo"]
              and cl["harvest"] and cl["remap"] and cl["shift"], str(cl))
        # Recolor swatch → clicking it edits the harvested colour CONTEXTUALLY in the dock Colour
        # panel (a solo "Recolor" picker with a Done bar), NOT a popup modal and NOT embedded into
        # the 20px swatch (the host:sw regression collapsed .cp-field to ~2px → a thin rainbow
        # column). Live-applies via recolorApply; Done returns to the duo fill/stroke picker.
        rcui = page.evaluate(r"""() => {
            const o = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="10" y="10" width="50" height="50" fill="#cc8844" stroke="#333333" stroke-width="6"/><circle data-hv-id="b" cx="120" cy="40" r="20" fill="#3377cc" stroke="#aa2255" stroke-width="6"/></svg>','rcui');
            editor.setTool('select'); editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            editor._renderSelection(); editor._renderInspector();
            const sw = document.querySelector('.insp-recolor-sw');
            o.hasSwatch = !!sw && Math.round(sw.getBoundingClientRect().width)===20;
            if (sw) sw.click();
            o.targetSet = !!editor._recolorTarget;
            o.noModal = !document.querySelector('.cp-backdrop');
            o.notEmbedded = !document.querySelector('.insp-recolor-sw .cp-window');
            o.inDockColour = !!document.querySelector('.rail-section.color .section-body .cp-window');
            o.hasDoneBar = !!document.querySelector('.rail-section.color .cp-recolor-done');
            const f = document.querySelector('.rail-section.color .cp-field');
            o.fieldWide = !!f && f.getBoundingClientRect().width > 80;
            o.swIntact = !!sw && Math.round(sw.getBoundingClientRect().width)===20;
            if (editor._recolorTarget) editor.recolorApply(editor._recolorTarget.targets, '#00ff00');
            o.liveApply = editor.nodeById('a').getAttribute('fill')==='#00ff00';
            const done = document.querySelector('.rail-section.color .cp-recolor-done'); if (done) done.click();
            o.doneClears = !editor._recolorTarget && !!document.querySelector('.rail-section.color .cp-side');
            return o; }""")
        check("recolor swatch click → contextual dock Colour panel (Recolor mode, not modal/embedded), live-applies, Done returns to duo",
              rcui["hasSwatch"] and rcui["targetSet"] and rcui["noModal"] and rcui["notEmbedded"] and rcui["inDockColour"]
              and rcui["hasDoneBar"] and rcui["fieldWide"] and rcui["swIntact"] and rcui["liveApply"] and rcui["doneClears"], str(rcui))
        # Isolation mode (Epic I): double-click a group to edit inside it — dim outside, scope
        # selection/marquee/new-objects to the group's children, breadcrumb + Esc exit. The dim is
        # editor-only (stripped from serialize + history; re-synced by id after undo).
        section("Isolation mode: edit inside a group (Epic I)")
        iso = page.evaluate(r"""() => {
            const o = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><g data-hv-id="g"><rect data-hv-id="c1" x="20" y="20" width="40" height="40" fill="#e55"/><rect data-hv-id="c2" x="80" y="20" width="40" height="40" fill="#5e5"/></g><rect data-hv-id="out" x="20" y="120" width="60" height="40" fill="#55e"/></svg>','iso');
            editor.setTool('select');
            editor.enterIsolation(editor.nodeById('g'));
            o.entered = editor.isIsolated() && editor.stage.classList.contains('hv-iso') && editor.nodeById('g').classList.contains('hv-iso-keep') && !!document.querySelector('.hv-iso-crumb');
            o.scope = JSON.stringify(editor._artScope().map(n=>n.getAttribute('data-hv-id')))==='["c1","c2"]';
            editor.selectAll(); o.selAll = editor.selection.has('c1') && editor.selection.has('c2') && !editor.selection.has('out');
            const before = editor.nodeById('g').children.length;
            const node = document.createElementNS('http://www.w3.org/2000/svg','rect');
            node.setAttribute('data-hv-id','n'+(++editor.idSeq)); node.setAttribute('x','130'); node.setAttribute('y','20'); node.setAttribute('width','20'); node.setAttribute('height','20'); node.setAttribute('fill','#999');
            editor._artHome().insertBefore(node, editor._artBefore());
            o.newInside = editor.nodeById('g').children.length === before+1;
            o.serClean = !editor.serialize().includes('hv-iso');
            editor.selection=new Set(['c1']); editor.push('move'); editor.nodeById('c1').setAttribute('x','25'); editor.undo();
            o.afterUndo = editor.isIsolated() && editor.stage.classList.contains('hv-iso') && editor.nodeById('g').classList.contains('hv-iso-keep');
            editor.exitIsolation();
            o.exited = !editor.isIsolated() && !editor.stage.classList.contains('hv-iso') && !document.querySelector('.hv-iso-crumb') && editor.selection.has('g');
            editor.enterIsolation(editor.nodeById('g')); editor.nodeById('g').remove(); editor._reconcileIsolation();
            o.reconcileGone = !editor.isIsolated();
            return o; }""")
        check("isolation: enter (dim+keep+crumb), scoped scope/select-all, new objects parent inside, serialize+undo clean, exit selects group, reconcile on delete",
              iso["entered"] and iso["scope"] and iso["selAll"] and iso["newInside"] and iso["serClean"]
              and iso["afterUndo"] and iso["exited"] and iso["reconcileGone"], str(iso))
        # Symbols & instances (Epic Y): selection → a <g class=hv-symbol> master in defs + a <use>
        # instance; duplicate shares the master; edit-master (surface+isolate, Epic I) propagates to
        # all instances; break-link makes an independent copy; <symbol>/<use> round-trip in serialize.
        section("Symbols & instances (Epic Y)")
        sym = page.evaluate(r"""() => {
            const o = {};
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><rect data-hv-id="a" x="20" y="20" width="30" height="30" fill="#e55"/><circle data-hv-id="b" cx="65" cy="35" r="12" fill="#5e5"/></svg>','sy');
            editor.setTool('select'); editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            editor.makeSymbol();
            const use = editor.nodeById([...editor.selection][0]);
            const symId = (/#(.+)$/.exec(use.getAttribute('href'))||[])[1];
            const master = editor.stage.querySelector('#'+CSS.escape(symId));
            o.made = !!use && use.tagName.toLowerCase()==='use' && /#hvsym/.test(use.getAttribute('href')||'') && use.getBBox().width>20;
            o.master = !!master && master.classList.contains('hv-symbol') && master.closest('defs')!==null && master.querySelectorAll('rect,circle').length===2;
            o.origGone = !editor.stage.querySelector('rect[data-hv-id="a"]') && !editor.stage.querySelector('circle[data-hv-id="b"]');
            editor.duplicate();
            const uses = editor.stage.querySelectorAll('use[data-hv-id]');
            o.dupShares = uses.length===2 && uses[0].getAttribute('href')===uses[1].getAttribute('href');
            // edit master: surface+isolate, recolor a child, exit → propagates to instances
            editor.selection=new Set([use.getAttribute('data-hv-id')]); editor.editSymbol(use);
            o.editing = editor.isIsolated() && !!editor._symEdit && editor.stage.querySelector('#'+CSS.escape(symId)).closest('defs')===null;
            editor.push('edit'); editor.stage.querySelector('#'+CSS.escape(symId)).querySelector('rect').setAttribute('fill','#0000ff');
            editor.exitIsolation();
            const after = editor.stage.querySelector('#'+CSS.escape(symId));
            o.returned = !!after && after.closest('defs')!==null && !editor.isIsolated() && !editor._symEdit;
            o.propagated = after.querySelector('rect').getAttribute('fill')==='#0000ff';
            o.serOk = editor.serialize().includes('hv-symbol') && editor.serialize().includes('<use') && !editor.serialize().includes('data-hv-');
            const firstUse = editor.stage.querySelector('use[data-hv-id]'); editor.breakSymbolLink(firstUse);
            const broke = editor.nodeById([...editor.selection][0]);
            o.broke = !!broke && broke.tagName.toLowerCase()==='g' && broke.querySelectorAll('rect,circle').length===2 && editor.stage.querySelectorAll('use[data-hv-id]').length===1;
            return o; }""")
        check("symbols: make (master in defs + <use>), originals gone, duplicate shares master, edit-master propagates, break-link copies, round-trips",
              sym["made"] and sym["master"] and sym["origGone"] and sym["dupShares"] and sym["editing"]
              and sym["returned"] and sym["propagated"] and sym["serOk"] and sym["broke"], str(sym))
        # Appearance / live effects (Epic E): a per-object effect stack (drop shadow / blur / glow)
        # rendered to a chained <filter> in defs; live param edits; serialize strips the working
        # JSON but keeps the filter; reopen RECONSTRUCTS the editable spec; clone-independent; GC.
        section("Appearance: live effects — drop shadow / blur / glow (Epic E)")
        ef = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="60" y="60" width="80" height="80" fill="#3399cc"/></svg>','ef');
            editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false;
            editor.addEffect('shadow'); editor.addEffect('blur');
            const fidOf = (id)=>{ const n=editor.nodeById(id); return (/url\(#([^)]+)\)/.exec(n&&n.getAttribute('filter')||'')||[])[1]; };
            const fid = fidOf('r1'); const filt = editor.stage.querySelector('#'+CSS.escape(fid));
            const prims = [...filt.children].map(c=>c.tagName.replace(/^.*:/,''));
            const chained = prims.length===2 && filt.children[1].getAttribute('in')==='fx1';   // blur reads the shadow's result
            const stackOk = fid.indexOf('hvfilt')===0 && prims[0].toLowerCase()==='fedropshadow' && prims[1].toLowerCase()==='fegaussianblur';
            // live edit: move the shadow → the (rebuilt) filter's feDropShadow updates
            editor.updateEffect(editor.nodeById('r1'), 0, { dx: 13, dy: 9 });
            const fresh = editor.stage.querySelector('#'+CSS.escape(fidOf('r1')));
            const editOk = fresh.querySelector('feDropShadow').getAttribute('dx')==='13';
            // serialize strips data-hv-effects but keeps the filter; reopen reconstructs the spec
            const ser = editor.serialize();
            const serOk = ser.includes('feDropShadow') && ser.includes('feGaussianBlur') && !ser.includes('data-hv-');
            window.mountStageFromText(ser,'ef2');
            const rn = editor.stage.querySelector('rect:not(.hv-artboard)');
            const reFx = editor.effectsOf(rn); const reopenOk = reFx.length===2 && reFx[0].type==='shadow' && reFx[1].type==='blur' && Math.round(reFx[0].dx)===13;
            // clone-independence: duplicate → its own filter id
            editor.selection=new Set([rn.getAttribute('data-hv-id')]); editor.artboardSelected=false; editor.duplicate();
            const dup = editor.nodeById([...editor.selection][0]); const dfid = (/url\(#([^)]+)\)/.exec(dup.getAttribute('filter')||'')||[])[1];
            const indep = !!dfid && dfid !== fidOf(rn.getAttribute('data-hv-id')) && !!editor.stage.querySelector('#'+CSS.escape(dfid));
            // remove all effects → filter dropped + GC'd
            editor.selection=new Set([rn.getAttribute('data-hv-id')]);
            editor.removeEffect(rn, 0); editor.removeEffect(rn, 0);
            const cleared = !rn.hasAttribute('filter');
            return { stackOk, chained, editOk, serOk, reopenOk, indep, cleared }; }""")
        check("effects: shadow+blur chain to one filter, live edit, serialize strips JSON keeps filter, reopen-editable, clone-independent, removable",
              ef["stackOk"] and ef["chained"] and ef["editOk"] and ef["serOk"] and ef["reopenOk"] and ef["indep"] and ef["cleared"], str(ef))
        # Effects hardening (stress pass): effect on a GROUP; undo drops the filter; same-type effects
        # stack as chained primitives; a boolean of an effected shape leaves NO orphan filter; reopen
        # then APPEND another effect (reconstruct + add).
        eh = page.evaluate(r"""() => {
            const fid=(id)=>{const n=editor.nodeById(id);return (/url\(#([^)]+)\)/.exec(n&&n.getAttribute('filter')||'')||[])[1];};
            // group
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><g data-hv-id="g0"><rect data-hv-id="a" x="40" y="40" width="60" height="60" fill="#e55"/><rect data-hv-id="b" x="90" y="90" width="60" height="60" fill="#5e5"/></g></svg>','eh1');
            editor.setTool('select'); editor.selection=new Set(['g0']); editor.artboardSelected=false; editor.addEffect('shadow');
            const groupOk = !!fid('g0') && fid('g0').indexOf('hvfilt')===0;
            // undo
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="60" y="60" width="80" height="80" fill="#39c"/></svg>','eh2');
            editor.selection=new Set(['r1']); editor.addEffect('blur'); editor.undo();
            const undoOk = !editor.nodeById('r1').hasAttribute('filter');
            // same-type stack
            editor.selection=new Set(['r1']); editor.addEffect('blur'); editor.addEffect('blur');
            const f=editor.stage.querySelector('#'+CSS.escape(fid('r1'))); const sameType = f.children.length===2 && f.children[1].getAttribute('in')==='fx1';
            // boolean leaves no orphan filter
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="a" x="40" y="40" width="80" height="80" fill="#888"/><rect data-hv-id="b" x="80" y="80" width="80" height="80" fill="#888"/></svg>','eh3');
            editor.selection=new Set(['a']); editor.addEffect('shadow'); editor.selection=new Set(['a','b']); editor.booleanOp('union');
            const boolGc = editor.stage.querySelectorAll('defs.hv-defs filter').length===0;
            // reopen + append
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect data-hv-id="r1" x="60" y="60" width="80" height="80" fill="#39c"/></svg>','eh4');
            editor.selection=new Set(['r1']); editor.addEffect('blur');
            window.mountStageFromText(editor.serialize(),'eh5'); const rn=editor.stage.querySelector('rect:not(.hv-artboard)');
            editor.selection=new Set([rn.getAttribute('data-hv-id')]); editor.addEffect('shadow');
            const fx=editor.effectsOf(rn); const appendOk = fx.length===2 && fx[0].type==='blur' && fx[1].type==='shadow';
            return { groupOk, undoOk, sameType, boolGc, appendOk }; }""")
        check("effects hardening: group filter, undo drops it, same-type stack chains, boolean leaves no orphan, reopen+append",
              eh["groupOk"] and eh["undoOk"] and eh["sameType"] and eh["boolGc"] and eh["appendOk"], str(eh))
        # Transforms & Repeat (Epic T): reflect (+copy), shear, transform-each (own centre),
        # transform-again, and parametric repeat (grid/radial/mirror) with live count + expand.
        section("Transforms & Repeat: reflect / shear / each / again / repeat (Epic T)")
        tr = page.evaluate(r"""() => {
            const R = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400"><rect data-hv-id="r1" x="40" y="40" width="60" height="40" fill="#3399cc"/></svg>';
            const fresh = (d)=>{ window.mountStageFromText(d||R,'tr'); editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false; };
            fresh(); const n0=editor.stage.querySelectorAll('[data-hv-id]').length; editor.reflectSelection('vertical',{copy:true});
            const reflectCopy = editor.stage.querySelectorAll('[data-hv-id]').length===n0+1;
            fresh(); editor.shearSelection(20,0); const sheared=/matrix/.test(editor.nodeById('r1').getAttribute('transform')||'');
            // transform-each rotates each about its own centre (centres stay put)
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><rect data-hv-id="a" x="20" y="20" width="40" height="40" fill="#e55"/><rect data-hv-id="b" x="220" y="220" width="40" height="40" fill="#5e5"/></svg>','tre');
            editor.selection=new Set(['a','b']); editor.artboardSelected=false;
            const ca=editor._nodeBBoxUser(editor.nodeById('a')); editor.transformEach({deg:45});
            const a2=editor._nodeBBoxUser(editor.nodeById('a')); const eachOk=Math.abs((a2.x0+a2.x1)/2-(ca.x0+ca.x1)/2)<2;
            // transform-again replays the last transform
            fresh(); editor.shearSelection(10,0); const t1=editor.nodeById('r1').getAttribute('transform'); editor.transformAgain();
            const againOk = editor.nodeById('r1').getAttribute('transform')!==t1;
            // repeat grid: parametric group, live count
            fresh(); editor.repeat('grid'); let g=editor.nodeById([...editor.selection][0]);
            const gridOk = editor.isRepeatGroup(g) && g.children.length===9;   // 3x3 = unit + 8 clones
            editor.setRepeatParam(g,'rows',4); editor.setRepeatParam(g,'cols',2); const gridLive = g.children.length===8;   // 4x2
            // radial live count
            fresh(); editor.repeat('radial'); g=editor.nodeById([...editor.selection][0]); editor.setRepeatParam(g,'count',8);
            const radialOk = g.children.length===8;
            // expand drops the parametric markers
            fresh(); editor.repeat('mirror'); g=editor.nodeById([...editor.selection][0]); const mirrorOk=g.children.length===2;
            editor.expandRepeat(g); const expandOk = !editor.isRepeatGroup(g) && !g.querySelector('[data-hv-repeat-unit]');
            return { reflectCopy, sheared, eachOk, againOk, gridOk, gridLive, radialOk, mirrorOk, expandOk }; }""")
        check("transforms: reflect-copy, shear, transform-each(own centre), transform-again, grid/radial/mirror repeat + live count + expand",
              tr["reflectCopy"] and tr["sheared"] and tr["eachOk"] and tr["againOk"] and tr["gridOk"] and tr["gridLive"] and tr["radialOk"] and tr["mirrorOk"] and tr["expandOk"], str(tr))
        # Transforms/Repeat hardening (stress): repeat serialize→reopen bakes clones to real geometry;
        # repeat undo restores the single original; repeat a GROUP (nested clones); count 1×1 → master
        # only; reflect-copy of a gradient object stays independent.
        th = page.evaluate(r"""() => {
            const R='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><rect data-hv-id="r1" x="40" y="40" width="50" height="40" fill="#3399cc"/></svg>';
            window.mountStageFromText(R,'th1'); editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false; editor.repeat('grid');
            const ser=editor.serialize(); const noParams=!ser.includes('data-hv-');
            window.mountStageFromText(ser,'th1b'); const reopenBakes = noParams && editor.stage.querySelectorAll('rect').length>=9;
            window.mountStageFromText(R,'th2'); editor.selection=new Set(['r1']); editor.repeat('radial'); editor.undo();
            const undoOk = !!editor.nodeById('r1') && editor.stage.querySelectorAll('g[data-hv-id]').length===0;
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><g data-hv-id="g0"><rect data-hv-id="a" x="30" y="30" width="30" height="30" fill="#e55"/><circle data-hv-id="b" cx="75" cy="45" r="12" fill="#5e5"/></g></svg>','th3');
            editor.selection=new Set(['g0']); editor.repeat('grid'); let g=editor.nodeById([...editor.selection][0]);
            const nested = editor.isRepeatGroup(g) && g.children.length===9 && g.querySelectorAll('circle').length===9;
            window.mountStageFromText(R,'th4'); editor.selection=new Set(['r1']); editor.repeat('grid'); g=editor.nodeById([...editor.selection][0]);
            editor.setRepeatParam(g,'rows',1); editor.setRepeatParam(g,'cols',1); const count1 = g.children.length===1;
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><rect data-hv-id="r1" x="40" y="40" width="80" height="80" fill="#888"/></svg>','th5');
            editor.selection=new Set(['r1']); editor.push('g'); editor.applyPaint('fill',{kind:'gradient',spec:{type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#f00'},{offset:1,color:'#00f'}]}});
            const gid=(/url\(#([^)]+)\)/.exec(editor.nodeById('r1').getAttribute('fill'))||[])[1];
            editor.reflectSelection('vertical',{copy:true}); const cp=editor.nodeById([...editor.selection][0]);
            const cgid=(/url\(#([^)]+)\)/.exec(cp.getAttribute('fill'))||[])[1];
            const reflectIndep = !!cgid && cgid!==gid && !!editor.stage.querySelector('#'+CSS.escape(cgid));
            return { reopenBakes, undoOk, nested, count1, reflectIndep }; }""")
        check("transforms/repeat hardening: reopen bakes clones, repeat-undo, nested group repeat, 1x1→master, reflect-copy gradient independent",
              th["reopenBakes"] and th["undoOk"] and th["nested"] and th["count1"] and th["reflectIndep"], str(th))
        # Multiple artboards (Epic A): extra named artboards grow the canvas viewBox to the union,
        # persist in <metadata> (chrome frames stripped on export), round-trip (primary geom +
        # extras restored), stay OUT of the artwork/layers, and delete back to a single artboard.
        section("Multiple artboards: add / persist / reopen / per-artboard export (Epic A)")
        aa = page.evaluate(r"""() => {
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><rect data-hv-id="r1" x="40" y="40" width="120" height="120" fill="#3399cc"/></svg>','aa');
            editor.setTool('select'); editor.artboardSelected=true; editor.selection=new Set();
            const vb0 = editor.stage.getAttribute('viewBox');
            editor.addArtboard();
            const grew = editor.stage.getAttribute('viewBox')!==vb0 && parseFloat(editor.stage.getAttribute('viewBox').split(' ')[2])>400;
            const two = editor.allArtboards().length===2;
            const framed = editor.stage.querySelectorAll('g.hv-ablayer .hv-abframe').length===1;
            // serialize: metadata persists, chrome stripped, artwork untouched
            const ser = editor.serialize();
            const metaKept = ser.includes('hv-artboards') && ser.includes('"extras"');
            const chromeStripped = !ser.includes('hv-ablayer') && !ser.includes('hv-abframe');
            // reopen: primary geom + extras restored; chrome stays OUT of artwork/layers
            window.mountStageFromText(ser,'aa2');
            const reTwo = editor.allArtboards().length===2;
            const rePrimary = editor.allArtboards()[0].w===400;
            const cleanArt = editor._artworkNodes().length===1 && [...editor.stage.querySelectorAll('[data-hv-id]')].every(n=>n.tagName.toLowerCase()==='rect');
            // per-artboard SVG export crops the viewBox to that artboard
            const ab2 = editor.allArtboards()[1];
            // delete the extra → single artboard, viewBox back to the primary
            editor.artboardSelected=true; editor.deleteArtboard(0);
            const single = editor.allArtboards().length===1 && editor.stage.getAttribute('viewBox')==='0 0 400 300' && !editor.stage.querySelector('g.hv-ablayer rect');
            return { grew, two, framed, metaKept, chromeStripped, reTwo, rePrimary, cleanArt, single }; }""")
        check("artboards: add grows canvas + frames, metadata persists (chrome stripped), reopen restores primary+extras, artwork clean, delete→single",
              aa["grew"] and aa["two"] and aa["framed"] and aa["metaKept"] and aa["chromeStripped"] and aa["reTwo"] and aa["rePrimary"] and aa["cleanArt"] and aa["single"], str(aa))
        # Artboard hardening (stress): three extras grow the union; resize reflows; fit changes the
        # viewport; art in an extra region isn't clipped; per-artboard SVG export crops the viewBox;
        # undo-add restores single; a plain doc stays single (back-compat).
        ah = page.evaluate(r"""() => {
            const R='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><rect data-hv-id="r1" x="40" y="40" width="120" height="120" fill="#39c"/></svg>';
            const fresh=()=>{ window.mountStageFromText(R,'ah'); editor.setTool('select'); editor.artboardSelected=true; editor.selection=new Set(); };
            fresh(); editor.addArtboard(); editor.addArtboard(); editor.addArtboard();
            const multi = editor.allArtboards().length===4 && parseFloat(editor.stage.getAttribute('viewBox').split(' ')[2])>1600;
            fresh(); editor.addArtboard(); const w0=parseFloat(editor.stage.getAttribute('viewBox').split(' ')[2]); editor.resizeArtboard(0,900,300);
            const resize = parseFloat(editor.stage.getAttribute('viewBox').split(' ')[2])>w0;
            fresh(); editor.addArtboard(); const vp=viewports.output, s0=vp.scale, x0=vp.x; editor.fitToArtboard(editor.allArtboards()[1]);
            const fit = vp.scale!==s0 || vp.x!==x0;
            fresh(); editor.addArtboard(); const ab=editor.allArtboards()[1]; const vb=editor.stage.viewBox.baseVal;
            const noClip = (ab.x+ab.w/2)>=vb.x && (ab.x+ab.w/2)<=vb.x+vb.width;
            fresh(); editor.addArtboard();
            let svgText=''; const _B=window.Blob; window.Blob=function(parts,opts){ if(opts&&/svg/.test(opts.type)) svgText=parts.join(''); return new _B(parts,opts); };
            const _ca=document.createElement.bind(document); document.createElement=(t)=>{ const el=_ca(t); if(t==='a') el.click=()=>{}; return el; };
            editor.exportArtboardSVG(editor.allArtboards()[1],'ab2'); window.Blob=_B; document.createElement=_ca;
            const m=/viewBox="([^"]+)"/.exec(svgText); const exportCrop=!!m && Math.abs(parseFloat(m[1].split(' ')[2])-editor.allArtboards()[1].w)<1;
            fresh(); editor.addArtboard(); editor.undo(); const undoOk=editor.allArtboards().length===1;
            window.mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 250" width="250" height="250"><circle data-hv-id="c1" cx="125" cy="125" r="80" fill="#c33"/></svg>','ahb');
            const backcompat = editor.allArtboards().length===1 && !editor.stage.querySelector('g.hv-ablayer') && editor.stage.getAttribute('viewBox')==='0 0 250 250';
            return { multi, resize, fit, noClip, exportCrop, undoOk, backcompat }; }""")
        check("artboard hardening: 3 extras grow union, resize reflows, fit moves viewport, no-clip, export-crop, undo-add, back-compat single",
              ah["multi"] and ah["resize"] and ah["fit"] and ah["noClip"] and ah["exportCrop"] and ah["undoOk"] and ah["backcompat"], str(ah))

        section("nested layers tree: group → indented children with ids; collapse hides them")
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2','r3']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector(); editor.group();")
        page.wait_for_timeout(80)
        tree = page.evaluate("""() => {
            const rows=[...document.querySelectorAll('#layers-list .layer-row:not(.artboard-row)')];
            const grp = rows.find(r=>r.classList.contains('is-group'));
            const kids = rows.filter(r=>parseInt(r.style.paddingLeft||'0') > 6);
            const childIds = grp ? [...editor.selectedNodes()[0].children].every(c=>c.hasAttribute('data-hv-id')) : false;
            return { hasGroupRow: !!grp, indentedKids: kids.length, childIds }; }""")
        check("group renders a tree with indented children", tree["hasGroupRow"] and tree["indentedKids"] == 3 and tree["childIds"], str(tree))
        # collapse the group → children hidden
        page.evaluate("() => document.querySelector('#layers-list .layer-row.is-group .layer-twist').click()")
        page.wait_for_timeout(60)
        check("collapsing a group hides its children",
              page.evaluate("[...document.querySelectorAll('#layers-list .layer-row:not(.artboard-row)')].filter(r=>parseInt(r.style.paddingLeft||'0')>6).length") == 0)
        # right-click a layer row opens the same object context panel + selects that node
        page.evaluate("() => document.querySelector('#layers-list .layer-row.is-group .layer-twist').click()")  # expand
        page.wait_for_timeout(60)
        page.evaluate("""() => { const child=[...document.querySelectorAll('#layers-list .layer-row')].find(r=>parseInt(r.style.paddingLeft||'0')>6);
            child.dispatchEvent(new MouseEvent('contextmenu',{clientX:300,clientY:200,bubbles:true,cancelable:true})); }""")
        page.wait_for_timeout(80)
        check("layer-row right-click opens the object panel + selects nested child",
              page.evaluate("""!!document.querySelector('.rail-section.properties') && editor.selection.size===1
                && [...editor.selection].every(id=>{const n=editor.nodeById(id); return n && n.parentNode.tagName.toLowerCase()==='g';})"""))
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()"); page.wait_for_timeout(40)

        section("node-edit focus: a selection limits visible anchors; nothing selected shows all")
        mount_ctl(page)
        n_anch = lambda: page.evaluate("document.querySelectorAll('.hv-handles .hv-node-anchor, .hv-handles circle.hv-handle').length")
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector(); editor.setTool('node');")
        page.wait_for_timeout(100); all_anchors = n_anch()
        page.evaluate("editor.setTool('select'); editor.selection=new Set(['r1']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector(); editor.setTool('node');")
        page.wait_for_timeout(100); focus_anchors = n_anch()
        check("node focus shows fewer anchors than the whole doc", all_anchors > 0 and 0 < focus_anchors < all_anchors, f"all={all_anchors} focus={focus_anchors}")
        # node mode draws NO object bounding box (just anchors) — the line/select-box clutter fix
        check("node mode hides the selection bbox", page.evaluate("editor._overlayEl().querySelectorAll('.hv-sel-box').length") == 0)
        page.evaluate("editor.setTool('select'); editor.selection=new Set(); editor._renderSelection(); editor._renderInspector();")

        section("group right-click registers its objects ('N objects') and recolours them all")
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1','r2','r3']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector(); editor.group();")
        page.wait_for_timeout(60)
        leaves = page.evaluate("editor._effectiveLeaves().length")
        check("group expands to its leaf objects", leaves == 3, f"leaves={leaves}")
        # recolour the group → applies to every child leaf
        page.evaluate("editor.applyFill('#abcdef');")
        page.wait_for_timeout(40)
        allred = page.evaluate("""() => { const g=editor.selectedNodes()[0];
            return [...g.children].every(c => c.getAttribute('fill') === '#abcdef'); }""")
        check("recolouring a group hits all its children", allred)

        # right-click empty canvas → artboard panel is STYLE-ONLY now (size + background);
        # its old actions are duplicated on the toolbars / moved to the bottom viewport bar.
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()")
        ab = artboard_rect(page)
        page.mouse.click(ab["x"] + ab["w"] * 0.04, ab["y"] + ab["h"] * 0.94, button="right"); page.wait_for_timeout(80)
        ctx2 = page.evaluate("""() => { const m=document.querySelector('.rail-section.properties'); return m
            ? { actions: m.querySelectorAll('.grid-item').length, size: !!m.querySelector('.fp-body input') } : null; }""")
        check("artboard context panel is style-only (no actions grid)", ctx2 and ctx2["size"] and ctx2["actions"] == 0, str(ctx2))
        check("Smart-guides + Select-All moved to the viewport bar",
              page.evaluate("!!document.querySelector('.viewport-controls #vp-guides') && !!document.querySelector('.viewport-controls #vp-selectall')"))
        page.keyboard.press("Escape")

        section("transparent artboard shows a checker (not solid white)")
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()")
        mount_ctl(page)
        page.evaluate("editor.selectArtboard(); editor.applyArtboardBg('#ffffff');")
        opaque = page.evaluate("editor.stage.classList.contains('transparent-board')")
        page.evaluate("editor.applyArtboardBg(null);")
        trans = page.evaluate("()=>({cls: editor.stage.classList.contains('transparent-board'), fill: editor.artboardEl().getAttribute('fill')})")
        check("transparent artboard toggles the checker class", (not opaque) and trans["cls"] and trans["fill"] == "none", f"opaque_cls={opaque} {trans}")
        # right-clicking the Artboard row in the layers panel opens the artboard panel
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel(); editor.selection=new Set(); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector();")
        page.evaluate("""()=>{const r=document.querySelector('#layers-foot .layer-row.artboard-row');
            r.dispatchEvent(new MouseEvent('contextmenu',{clientX:300,clientY:300,bubbles:true,cancelable:true}));}""")
        page.wait_for_timeout(80)
        check("artboard-row right-click selects artboard + opens its panel",
              page.evaluate("""editor.artboardSelected && !!document.querySelector('.rail-section.properties')
                && document.querySelector('.rail-section.properties .fp-title').textContent === 'Artboard'"""))
        page.evaluate("window.hideFloatPanel && window.hideFloatPanel()")
        # selected object name shows in the header indicator
        mount_ctl(page); page.evaluate("editor.selection=new Set(['r1']); editor.artboardSelected=false; editor._renderSelection(); editor._renderInspector();")
        check("header shows the selected object name", "Rectangle" in page.evaluate("document.querySelector('#sel-label').textContent"))

        section("Pipeline kind/output mapping (the standalone Process VIEW + its stage strip")
        # are gone; the Processor dock panel covers the stage UI — see the Processor checks
        # above). effectiveProcessKind/outputChipInfo are still the shared mapping driving
        # previews + skip-detection; verify them off `settings` via the Processor chip. ----
        kinds = page.evaluate("""() => {
          const r={}; const set=(o)=>{ Object.assign(settings,o); renderProcessorPanel(); };
          const out=()=>document.querySelector('#processor-out').textContent;
          set({stage_upscale:true, stage_removebg:true, stage_vectorize:true, vectorize_method:'trace'});
          r.allThree=effectiveProcessKind(); r.allOut=out();
          set({stage_vectorize:false}); r.noVec=effectiveProcessKind(); r.noVecOut=out();
          set({stage_removebg:false}); r.upOnly=effectiveProcessKind();
          set({stage_upscale:false}); r.none=effectiveProcessKind(); r.noneOut=out();
          set({stage_upscale:true, stage_removebg:true, stage_vectorize:true, vectorize_method:'pixel'}); r.pixel=effectiveProcessKind();
          set({vectorize_method:'trace'});
          return r;
        }""")
        check("pipeline kind/output mapping (all3=pipeline/SVG · no-vec=cutout/PNG · up-only=upscale · none · pixel=pixelvec)",
              kinds["allThree"] == "pipeline" and kinds["allOut"] == "SVG" and kinds["noVec"] == "cutout"
              and kinds["noVecOut"] == "PNG" and kinds["upOnly"] == "upscale" and (kinds["none"] in (None, ""))
              and kinds["noneOut"] == "" and kinds["pixel"] == "pixelvec", str(kinds))
        page.evaluate("() => { Object.assign(settings,{trace_simplify:'medium', trace_colormode:'bw'}); }")

        section("Settings: registry-driven AI models & tools inventory (#51)")
        # The panel renders itself from GET /api/capabilities, so it scales with the model
        # count: capability groups, per-model size/intents, and an availability chip each.
        file_menu_click(page, "Settings"); page.wait_for_timeout(100)
        page.wait_for_function("""() => /AI models & tools/.test((document.querySelector('#modal-body')||{}).textContent||'')
            && document.querySelectorAll('#modal-body .cap-group').length >= 3""", timeout=4000)
        ai = page.evaluate("""() => {
          const titles = [...document.querySelectorAll('#modal-body .cap-group-title')].map(s=>s.textContent);
          const models = [...document.querySelectorAll('#modal-body .cap-model-name')].map(s=>s.textContent);
          const states = [...document.querySelectorAll('#modal-body .cap-model-state')].map(s=>s.textContent);
          return { groups: titles.length, cutout: titles.some(t=>/Cutout/.test(t)),
                   upscale: titles.includes('Upscale'), vectorize: titles.includes('Vectorize'),
                   models: models.length, birefnet: models.some(m=>/BiRefNet/.test(m)),
                   stated: states.length >= models.length && states.length > 0 };
        }""")
        check("Settings AI panel renders a registry-driven capability/model inventory (#51)",
              ai["groups"] >= 3 and ai["cutout"] and ai["upscale"] and ai["vectorize"]
              and ai["models"] >= 6 and ai["birefnet"] and ai["stated"], str(ai))
        page.evaluate("closeModal();")
        # Install is consolidated: a stage needing a missing tool routes here rather than
        # installing inline. openToolsSettings() deep-links straight to the install hub.
        page.evaluate("() => window.app.openToolsSettings()")
        page.wait_for_function("""() => { const m=document.querySelector('#modal-root');
            return m && !m.hidden && /AI models & tools/.test((document.querySelector('#modal-body')||{}).textContent||''); }""", timeout=3000)
        deep = page.evaluate("() => /AI models & tools/.test((document.querySelector('#modal-body')||{}).textContent||'')")
        page.evaluate("closeModal();")
        check("openToolsSettings deep-links to the centralized install hub (no scattered inline installers)", deep)

        section("Cleanup / object removal (LaMa) — overlay hook + /api/cleanup endpoint (#56)")
        check("the cleanup mask-overlay launcher is exposed", page.evaluate("() => typeof window.app.startCleanup === 'function'"))
        # Drive the backend the way the overlay does: a tiny image + a white mask square → /api/cleanup.
        clean = page.evaluate("""async () => {
          const img = document.createElement('canvas'); img.width=img.height=96;
          const ig = img.getContext('2d'); ig.fillStyle='#3c9650'; ig.fillRect(0,0,96,96); ig.fillStyle='#d22828'; ig.fillRect(36,36,24,24);
          const msk = document.createElement('canvas'); msk.width=msk.height=96;
          const mg = msk.getContext('2d'); mg.fillStyle='#000'; mg.fillRect(0,0,96,96); mg.fillStyle='#fff'; mg.fillRect(32,32,32,32);
          try {
            const r = await fetch('/api/cleanup', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({input_url: img.toDataURL('image/png'), mask_url: msk.toDataURL('image/png')})});
            if (!r.ok) return {ok:false, status:r.status};
            const j = await r.json(); return {ok: typeof j.url==='string' && j.url.includes('/outputs/'), url:j.url};
          } catch(e) { return {ok:false, err:String(e)}; }
        }""")
        check("POST /api/cleanup runs LaMa and returns a scratch result URL (#56)", clean.get("ok"), str(clean))

        section("Face restore (GFPGAN ONNX) — overlay hook + capability availability (#57)")
        # (The actual restore needs a real face image, verified server-side; here we check wiring.)
        check("the face-restore launcher is exposed", page.evaluate("() => typeof window.app.restoreFaces === 'function'"))
        faceavail = page.evaluate("""async () => {
          const caps = await (await fetch('/api/capabilities')).json();
          const f = caps.find(c => c.id === 'face');
          return !!f && f.models.some(m => m.available && m.needs.includes('onnxruntime') && m.needs.includes('opencv'));
        }""")
        check("face-restore capability is registered + available (onnxruntime+opencv) (#57)", faceavail)

        section("Degradation fixers (SCUNet/FBCNN/NAFNet via spandrel) — hook + endpoint (#58)")
        check("the degradation-fix launcher is exposed", page.evaluate("() => typeof window.app.applyRestore === 'function'"))
        fixavail = page.evaluate("""async () => {
          const caps = await (await fetch('/api/capabilities')).json();
          return ['denoise','dejpeg','deblur'].every(id => { const c = caps.find(x=>x.id===id);
            return c && c.models.some(m => m.available && m.needs.includes('spandrel')); });
        }""")
        check("denoise/dejpeg/deblur capabilities registered + available via spandrel (#58)", fixavail)
        denoise = page.evaluate("""async () => {
          const c = document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d');
          const d=g.createImageData(64,64); for(let i=0;i<d.data.length;i+=4){const v=90+((Math.imul(i,2654435761)>>>24)%40-20);d.data[i]=v;d.data[i+1]=v+30;d.data[i+2]=v+60;d.data[i+3]=255;} g.putImageData(d,0,0);
          try { const r = await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},
            body: JSON.stringify({input_url:c.toDataURL('image/png'), model:'scunet-denoise'})});
            if(!r.ok) return {ok:false,status:r.status}; const j=await r.json(); return {ok: typeof j.url==='string' && j.url.includes('/outputs/')};
          } catch(e){ return {ok:false, err:String(e)}; }
        }""")
        check("POST /api/restore runs a spandrel denoise and returns a result URL (#58)", denoise.get("ok"), str(denoise))

        # serialize cleanliness
        mount_ctl(page)
        s = page.evaluate("editor.serialize()")
        check("serialize strips overlay + ids", ("hv-overlay" not in s) and ("data-hv-id" not in s) and s.strip().startswith("<svg"))

        # deep undo empties the stack and disables the button
        page.evaluate("for (let i=0;i<200;i++) editor.undo();")
        page.wait_for_timeout(60)
        check("undo button disabled at history bottom", page.evaluate("document.querySelector('#undo-button').disabled") is True)

        # Open modal opens and lists vectors
        page.evaluate("editor.pinned=false")
        file_menu_click(page, "Open vector"); page.wait_for_timeout(100)
        modal_open = page.evaluate("!document.querySelector('#modal-root').hidden")
        cells = page.evaluate("document.querySelectorAll('#modal-body .gallery-cell').length")
        check("Open modal lists vectors", modal_open and cells >= 0, f"open={modal_open} cells={cells}")
        # SVG thumbs render as <img> (reliable/lazy), never as throttled <object>
        thumbs = page.evaluate("""() => ({
            objects: document.querySelectorAll('#modal-body .gallery-thumb object').length,
            imgs: document.querySelectorAll('#modal-body .gallery-thumb img').length,
            cells: document.querySelectorAll('#modal-body .gallery-cell').length,
        })""")
        check("gallery thumbs use <img>, not <object>",
              thumbs["objects"] == 0 and thumbs["imgs"] == thumbs["cells"], str(thumbs))
        page.evaluate("closeModal()")

        section("Detail (Info) is a dock PANEL now (not a modal); carries Rename / Download /")
        # Delete for C/R/V. Drive the vector detail with a synthetic item; the body fetch may
        # 404 (leaves dashes) but the action row is built regardless.
        page.evaluate("""() => openVectorInfoModal({name:'probe.svg', url:'/outputs/__none__/probe.svg', path:''})""")
        page.wait_for_function("() => !!document.querySelector('.rail-section.info .info-actions button')", timeout=2000)
        # The action row is a uniform icon chin (tool-buttons): ✎ Rename · ⇩ Download · ✕ Delete.
        det = page.evaluate("""() => {
          const btns = [...document.querySelectorAll('.rail-section.info .info-actions button')];
          const labels = btns.map(b=>b.textContent.trim());
          return { rename: labels.includes('✎'), download: labels.includes('⇩'),
                   del: labels.includes('✕'), danger: !!document.querySelector('.rail-section.info .info-actions .danger-button'),
                   chin: btns.length>0 && btns.every(b=>b.classList.contains('tool-button')),
                   panel: !!document.querySelector('.rail-section.info'), notModal: !document.querySelector('#modal-body .info-actions') };
        }""")
        check("Info is a dock panel with a uniform tool-button chin (✎ Rename / ⇩ Download / ✕ Delete)",
              det["rename"] and det["download"] and det["del"] and det["danger"] and det["chin"] and det["panel"] and det["notModal"], str(det))
        # Delete is a two-click guard: first click arms (turns red, glyph → ‼), no request yet.
        page.evaluate("""() => [...document.querySelectorAll('.rail-section.info .info-actions button')].find(b=>b.textContent.trim()==='✕').click()""")
        page.wait_for_timeout(40)
        armed = page.evaluate("""() => { const b=document.querySelector('.rail-section.info .info-actions .danger-button');
          return { armed: b.classList.contains('danger-armed'), text: b.textContent.trim() }; }""")
        check("Delete arms on first click (no immediate destroy)",
              armed["armed"] and armed["text"] == "‼", str(armed))
        # Rename opens the in-app floating input (no window.prompt).
        page.evaluate("""() => [...document.querySelectorAll('.rail-section.info .info-actions button')].find(b=>b.textContent.trim()==='✎').click()""")
        page.wait_for_timeout(40)
        check("Rename opens the floating input (no window.prompt)",
              page.evaluate("() => !!document.querySelector('.hv-float-input')"))
        page.evaluate("""() => { const i=document.querySelector('.hv-float-input input'); if(i){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); } window.__docks.close('info'); }""")

        section("Processor panel: pipeline stages (de-crammed from Properties) + live preview")
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
              + '<rect class="hv-artboard" x="0" y="0" width="200" height="200" fill="#fff"/></svg>','raster-host.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        # place a raster <image> node (a 1px data URL suffices for the editor mechanics).
        # Re-place inside the wait: a concurrent stage remount (e.g. the job poller) can
        # occasionally drop the freshly-placed node, so keep placing until it sticks.
        page.wait_for_function("""() => {
            if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            const px='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            editor.placeImage(px,'shot.png',120,120); return false; }""", timeout=6000)
        # Properties is now a COMPACT pointer — the pipeline was de-crammed into the Processor panel.
        # raster Properties no longer carries a "Process / Open Processor" pointer — the
        # Processor panel is contextual now, so rasterTools returns null when no live
        # preview is running (it only surfaces Keep/Revert during a live trace).
        decram = page.evaluate("""() => { const node=editor.stage.querySelector('image[data-hv-id]');
            return { isImage: node.tagName.toLowerCase()==='image', noPointer: editor.rasterTools(node) === null }; }""")
        check("raster Properties has no Process pointer (Processor is contextual)",
              decram["isImage"] and decram["noPointer"], str(decram))
        # The Processor panel hosts the 6 stages, targeting the selected raster.
        stages = page.evaluate("""() => { renderProcessorPanel();
            return { names:[...document.querySelectorAll('#processor-body .proc-stage .stage-name')].map(s=>s.textContent),
                     target:(document.querySelector('#processor-body .proc-target-name')||{}).textContent }; }""")
        check("Processor hosts the pipeline stages (restoration + Upscale/Remove BG/Vectorize) for the selected raster",
              set(stages["names"]) == {"De-JPEG", "Denoise", "Deblur", "Upscale", "Remove BG", "Vectorize"}
              and stages["target"] != "Whole library (batch)", str(stages))
        # batch is EXPLICIT: the focused raster is the default; the ▦ swap toggles to
        # whole-library batch (and back). Was: silently defaulted to batch with no raster.
        batch = page.evaluate("""() => {
            const label = () => document.querySelector('#processor-body .proc-target-name').textContent;
            const runTxt = () => document.querySelector('#processor-chin .proc-run').textContent;   // Run lives in the pinned chin now
            const beforeLabel = label(), beforeRun = runTxt();
            document.querySelector('#processor-body .proc-target-swap').click();
            const afterLabel = label(), afterRun = runTxt();
            document.querySelector('#processor-body .proc-target-swap').click();   // toggle back
            return { beforeLabel, beforeRun, afterLabel, afterRun, restored: label() }; }""")
        check("batch is an explicit toggle (focused raster default; ▦ → whole library)",
              batch["beforeLabel"] != "Whole library (batch)" and batch["beforeRun"] == "Run → canvas"
              and batch["afterLabel"] == "Whole library (batch)" and batch["afterRun"] == "Run library"
              and batch["restored"] != "Whole library (batch)", str(batch))
        # Run lives in a pinned standard chin below the scrolling stage list (not in the body).
        chin = page.evaluate("""() => ({ runInChin: !!document.querySelector('.rail-section.processor > #processor-chin .proc-run'),
            runNotInBody: !document.querySelector('#processor-body .proc-run') })""")
        check("Run sits in the pinned Processor chin, not the scrolling body",
              chin["runInChin"] and chin["runNotInBody"], str(chin))
        # Vectorize card (expanded by default): intent-first — Outcome picker + Auto badge always
        # visible, live preview below; the Engine selector + Auto-detect + schema controls demote
        # into a collapsed Advanced (#49). Expand Advanced to assert they're all still there.
        vec = page.evaluate("""() => { settings.adv_vectorize=true; renderProcessorPanel();
            const body=document.querySelector('#processor-body .proc-stage[data-stage="vectorize"] .pipeline-detail-body');
            const r = body ? { outcome:[...body.querySelectorAll('.form-label')].some(s=>/Outcome/i.test(s.textContent)),
                            autoBadge:!!body.querySelector('.intent-auto'),
                            hasEngine:[...body.querySelectorAll('.form-label')].some(s=>/Engine/i.test(s.textContent)),
                            auto:/Auto-detect/.test(body.textContent),
                            live:[...body.querySelectorAll('button')].some(b=>/Live preview/i.test(b.textContent)),
                            ctrls: body.querySelectorAll('select,input').length } : {nobody:true};
            delete settings.adv_vectorize; renderProcessorPanel(); return r; }""")
        check("Vectorize card: Outcome picker + Auto badge + live preview, with Engine/Auto-detect/schema in Advanced (#49)",
              vec.get("outcome") and vec.get("autoBadge") and vec.get("hasEngine") and vec.get("auto") and vec.get("live") and vec.get("ctrls", 0) > 2, str(vec))
        # Contextual: the Processor is un-dimmed when a raster is the subject, dimmed when idle
        # (no canvas raster + library not on rasters). It stays put — only the emphasis changes.
        ctx = page.evaluate("""() => {
            const sec = document.querySelector('.rail-section.processor');
            const img = editor.stage.querySelector('image[data-hv-id]');
            editor.selection = new Set([img.getAttribute('data-hv-id')]); editor.artboardSelected = false; editor.onInspect();
            const whenRaster = !sec.classList.contains('dimmed');
            // canvas selection WINS: a non-raster selection dims it even while the library is on rasters
            editor.selection = new Set(); editor.artboardSelected = true; editor.onInspect();
            const whenNonRaster = sec.classList.contains('dimmed');
            document.querySelector('.lib-mode[data-mode="vector"]').click();   // library → vectors (no raster focus)
            editor.selection = new Set(); editor.artboardSelected = false; editor.onInspect();
            const whenIdle = sec.classList.contains('dimmed');
            document.querySelector('.lib-mode[data-mode="raster"]').click();   // restore library mode
            editor.selection = new Set([img.getAttribute('data-hv-id')]); editor.artboardSelected = false; editor.onInspect();   // restore selection for later tests
            return { whenRaster, whenNonRaster, whenIdle }; }""")
        check("Processor: un-dims for a raster, dims for a non-raster selection + when idle (canvas wins)",
              ctx["whenRaster"] and ctx["whenNonRaster"] and ctx["whenIdle"], str(ctx))

        tri = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
               '<path d="M10 10 L110 10 L60 100 Z" fill="#3366cc"/></svg>')
        prev = page.evaluate("""(svg) => { const node=editor.nodeById([...editor.selection][0]);
            const ok=editor.showRasterPreview(node,svg);
            return { ok, preview: !!editor.stage.querySelector('g.hv-preview'),
                     hidden: node.classList.contains('hv-raster-hidden') }; }""", tri)
        check("live preview swaps the canvas (preview group up, raster hidden)",
              prev["ok"] and prev["preview"] and prev["hidden"], str(prev))
        ser = page.evaluate("editor.serialize()")
        check("preview layer never leaks into serialized output",
              "hv-preview" not in ser and "hv-raster-hidden" not in ser)
        rev = page.evaluate("""() => { editor.clearRasterPreview(true);
            const node=editor.nodeById([...editor.selection][0]);
            return { gone: !editor.stage.querySelector('g.hv-preview'),
                     visible: !!node && !node.classList.contains('hv-raster-hidden') }; }""")
        check("revert clears the preview and restores the raster", rev["gone"] and rev["visible"], str(rev))

        section("schema-driven Vectorize card + EVERY control live-wired (now in the Processor panel)")
        # Regression guard for the half-wired bug (only 3 of ~12 controls re-traced) and the
        # phantom-knob bug (panel showed controls the active engine ignored). The card is
        # rendered purely from /api/vectorize/engines → only the selected engine's params show.
        eng = page.evaluate("""() => {
            const body = (e) => { settings.engine=e; settings.adv_vectorize=true; renderProcessorPanel();   // params live in Advanced now (#49)
                return (document.querySelector('#processor-body .proc-stage[data-stage="vectorize"] .pipeline-detail-body')||{}).textContent||''; };
            const clean=body('clean'), pixel=body('pixel'), vtr=body('vtracer');
            delete settings.engine; delete settings.adv_vectorize; renderProcessorPanel();
            return { cleanScoped: /Colours/.test(clean) && /Simplify/.test(clean) && !/Output/.test(clean) && !/Curves/.test(clean),
                     pixelScoped: /Shape mode/.test(pixel) && /Cell colour/.test(pixel) && !/Output/.test(pixel),
                     vtrScoped: /Output/.test(vtr) && /Curves/.test(vtr) }; }""")
        check("engine selector scopes the Vectorize card to only that engine's params (no phantom knobs)",
              eng["cleanScoped"] and eng["pixelScoped"] and eng["vtrScoped"], str(eng))
        wired = page.evaluate("""() => {
            const id=[...editor.selection][0];
            settings.engine='vtracer'; settings.adv_vectorize=true; renderProcessorPanel();   // vtracer schema (in Advanced) has a number + several selects
            app.armRasterLive(id);
            const body=document.querySelector('#processor-body .proc-stage[data-stage="vectorize"] .pipeline-detail-body');
            const num=body.querySelector('input[type=number]');
            const sel=[...body.querySelectorAll('select')].pop();   // a schema value select, not the Engine/Outcome selector
            const before=app.rasterLiveKicks;
            if (num) { num.value='1234'; num.dispatchEvent(new Event('input',{bubbles:true})); }
            const afterNum=app.rasterLiveKicks;
            if (sel) sel.dispatchEvent(new Event('change',{bubbles:true}));
            const afterSel=app.rasterLiveKicks;
            app.disarmRasterLive(); delete settings.engine; delete settings.adv_vectorize; renderProcessorPanel();
            return { hadNum:!!num, hadSel:!!sel, before, afterNum, afterSel }; }""")
        check("every Vectorize value control re-triggers the live trace (number + select)",
              wired["hadNum"] and wired["hadSel"] and wired["afterNum"] > wired["before"] and wired["afterSel"] > wired["afterNum"], str(wired))

        section("Upscale / Remove-bg cards: schema-driven + live-wired (raster ops)")
        rop = page.evaluate("""() => {
            // expand the upscale + removebg cards, and open their Advanced (model/params live there now, #49)
            for (const sid of ['upscale','removebg']) { const c=[...document.querySelectorAll('#processor-body .proc-stage')].find(x=>x.dataset.stage===sid); if(c && !c.classList.contains('expanded')) c.querySelector('.proc-stage-title').click(); }
            settings.adv_upscale=true; settings.adv_cutout=true;
            const txt=(sid)=>(document.querySelector(`#processor-body .proc-stage[data-stage="${sid}"] .pipeline-detail-body`)||{}).textContent||'';
            renderProcessorPanel(); const up=txt('upscale');
            settings.removebg_method='classical'; renderProcessorPanel(); const classical=txt('removebg');
            settings.removebg_method='ai';        renderProcessorPanel(); const ai=txt('removebg');
            settings.removebg_method='classical'; renderProcessorPanel();
            return { upScoped: /Model/.test(up) && /Scale/.test(up),
                     classicalNoAi: !/AI model/.test(classical),
                     aiShowsModel: /AI model/.test(ai) }; }""")
        check("upscale + remove-bg cards are schema-driven (Model/Scale; AI model only when AI; in Advanced #49)",
              rop["upScoped"] and rop["classicalNoAi"] and rop["aiShowsModel"], str(rop))
        wop = page.evaluate("""() => {
            const id=[...editor.selection][0];
            settings.adv_upscale=true; settings.adv_cutout=true;   // model/params live in Advanced now (#49)
            const findSel=(sid,v)=>{ const body=document.querySelector(`#processor-body .proc-stage[data-stage="${sid}"] .pipeline-detail-body`); return body && [...body.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===v)); };
            app.armRasterOp(id,'upscale'); renderProcessorPanel();   // Scale = plain value control → live re-run
            const scale=findSel('upscale','2'); const a=app.rasterOpKicks; if(scale) scale.dispatchEvent(new Event('change',{bubbles:true})); const b=app.rasterOpKicks;
            app.disarmRasterOp();
            app.armRasterOp(id,'removebg'); renderProcessorPanel();  // Method = when-driver → structural rebuild + re-run
            const method=findSel('removebg','classical'); const c=app.rasterOpKicks; if(method) method.dispatchEvent(new Event('change',{bubbles:true})); const d=app.rasterOpKicks;
            app.disarmRasterOp(); renderProcessorPanel();
            return { scale:!!scale, method:!!method, a,b,c,d }; }""")
        check("raster-op cards are live-wired (upscale scale + remove-bg method re-trigger the op)",
              wop["scale"] and wop["method"] and wop["b"] > wop["a"] and wop["d"] > wop["c"], str(wop))

        com = page.evaluate("""(svg) => { const node=editor.nodeById([...editor.selection][0]);
            editor.showRasterPreview(node,svg); editor.commitRasterToVector(node,svg,'shot');
            const g=editor.nodeById([...editor.selection][0]);
            return { imgs: editor.stage.querySelectorAll('image').length,
                     isGroup: !!g && g.tagName.toLowerCase()==='g',
                     paths: g? g.querySelectorAll('path').length:0,
                     preview: !!editor.stage.querySelector('g.hv-preview') }; }""", tri)
        check("commit replaces the raster with an editable vector layer",
              com["imgs"] == 0 and com["isGroup"] and com["paths"] >= 1 and not com["preview"], str(com))

        section("Save-As: a new/opened canvas (no selectedOutput) can be saved")
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
              + '<rect data-hv-id="r1" x="10" y="10" width="40" height="40" fill="#36c"/></svg>','saveas-probe.svg'); }""")
        check("new canvas has no save target yet", page.evaluate("!window.app.selectedOutput"))
        file_menu_click(page, "Save as")
        page.wait_for_function("!document.querySelector('#modal-root').hidden && !!document.querySelector('#modal-body .form input')", timeout=4000)
        page.fill('#modal-body .form input', 'e2e-saveas-probe')
        page.click('#modal-body .ghost-button:has-text("Save")')
        page.wait_for_function("/Saved|Save failed/.test(document.querySelector('#status-text').textContent)", timeout=8000)
        saveas = page.evaluate("""() => ({
            status: document.querySelector('#status-text').textContent,
            folder: window.app.selectedOutput && window.app.selectedOutput.folder,
            name: window.app.selectedOutput && window.app.selectedOutput.name,
        })""")
        check("Save-As gives a new canvas a save target",
              "Saved" in saveas["status"] and saveas["folder"] == "canvas"
              and str(saveas["name"]).endswith(".svg"), str(saveas))

        section("File surface: version, file menu items, download, open-from-disk, export routing")
        ver = page.evaluate("async () => { const r = await fetch('/api/version'); return r.ok ? await r.json() : null; }")
        check("/api/version returns a version", bool(ver) and bool(ver.get("version")), str(ver))

        page.click('.menu[data-menu="file"] .menu-trigger'); page.wait_for_timeout(60)
        file_items = page.evaluate("() => [...document.querySelectorAll('.menu[data-menu=\"file\"] .menu-item')].map(b=>b.textContent.trim())")
        page.keyboard.press("Escape")
        check("File menu exposes Open-from-file / Download .svg / Reveal",
              all(any(x in l for l in file_items) for x in ["Open from file", "Download .svg", "Reveal current file"]), str(file_items))

        # Download .svg → a synthetic <a download="*.svg"> click (stub the click to avoid a real download)
        page.evaluate("""() => { window.__dl=null;
            const real=HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click=function(){ if(this.download){ window.__dl={name:this.download,blob:this.href.startsWith('blob:')}; return; } return real.call(this); }; }""")
        page.evaluate("window.app.downloadCurrentSvg()")
        dl = page.evaluate("window.__dl")
        check("Download .svg emits an a[download$=.svg] blob", bool(dl) and str(dl.get("name")).endswith(".svg") and dl.get("blob"), str(dl))

        # Open from file (disk) → mounts a stage with no server save target
        tmp_svg = os.path.join(os.path.expanduser("~"), "hv-e2e-open.svg")
        with open(tmp_svg, "w") as fh:
            fh.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" fill="#0a0"/></svg>')
        with page.expect_file_chooser() as fc:
            page.evaluate("window.app.openFromFile()")
        fc.value.set_files(tmp_svg)
        page.wait_for_function("/Opened hv-e2e-open/.test(document.querySelector('#status-text').textContent)", timeout=4000)
        opened = page.evaluate("() => ({ stage: !!editor.stage, noTarget: !window.app.selectedOutput })")
        check("Open-from-file mounts a stage with no save target", opened["stage"] and opened["noTarget"], str(opened))
        os.remove(tmp_svg)

        # Export renders the LIVE canvas in-browser (no cairosvg, no save needed) — an
        # unsaved doc opens the Export window directly and renders straight to a download.
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect data-hv-id="rx" x="5" y="5" width="30" height="30" fill="#c33"/></svg>','export-probe.svg'); }""")
        page.evaluate("window.app.exportFlow()")
        page.wait_for_function("!document.querySelector('#modal-root').hidden && document.querySelector('#modal-title').textContent === 'Export PNG'", timeout=4000)
        modal0 = page.evaluate("""() => ({ title: document.querySelector('#modal-title').textContent,
            hasRender: [...document.querySelectorAll('#modal-body button')].some(b=>/Render PNG/.test(b.textContent)),
            hasPreview: !!document.querySelector('#modal-body .export-preview img') })""")
        check("Export on unsaved canvas opens the Export window directly (no Save-As dead end)",
              modal0["title"] == "Export PNG" and modal0["hasRender"] and modal0["hasPreview"], str(modal0))
        # stub the synthetic <a download> click so no real PNG lands on disk
        page.evaluate("""() => { window.__png=null; const real=HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click=function(){ if(this.download){ window.__png={name:this.download, blob:this.href.startsWith('blob:')}; return; } return real.call(this); }; }""")
        page.evaluate("""() => { for (const b of document.querySelectorAll('#modal-body button')) if (/Render PNG/.test(b.textContent)) { b.click(); break; } }""")
        page.wait_for_function("[...document.querySelectorAll('#modal-body button')].some(b=>/Download PNG/.test(b.textContent))", timeout=6000)
        res = page.evaluate("""() => ({ info: (document.querySelector('#modal-body .form-hint')||{}).textContent || '',
            buttons: [...document.querySelectorAll('#modal-body button')].map(b=>b.textContent.trim()) })""")
        check("client-side render produces a downloadable PNG result (no cairosvg)",
              "px" in res["info"] and "Download PNG" in res["buttons"], str(res))
        page.evaluate("""() => { for (const b of document.querySelectorAll('#modal-body button')) if (/Download PNG/.test(b.textContent)) { b.click(); break; } }""")
        png = page.evaluate("window.__png")
        check("Download PNG emits an a[download$=.png] blob", bool(png) and str(png.get("name")).endswith(".png") and png.get("blob"), str(png))
        page.evaluate("closeModal()")

        section("known-problem fix: SVG export bakes placed-raster hrefs to data URIs (self-contained)")
        inl = page.evaluate("""async () => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><image href="/assets/hv_logo.svg" x="0" y="0" width="50" height="50"/></svg>';
            const out = await window.app.inlineSvgImages(svg);
            return { hasData: /href\\s*=\\s*"data:/.test(out), droppedUrl: !/\\/assets\\/hv_logo\\.svg/.test(out) }; }""")
        check("SVG export inlines same-origin <image> hrefs to data URIs (portable off-machine)",
              inl["hasData"] and inl["droppedUrl"], str(inl))

        section("self-contained PERSISTED save: Save-As bakes a server-href raster into the")
        #      saved .svg, while the LIVE editor keeps its server href (re-processable). Uses a
        #      small same-origin asset so the baked file stays under the server's save cap. ----
        IMG_HREF = "/assets/hv_logo.svg"
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
              + '<rect class="hv-artboard" x="0" y="0" width="200" height="200" fill="#fff"/></svg>','bake-probe.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""(url) => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            editor.placeImage(url,'bake',120,120); return false; }""", arg=IMG_HREF, timeout=6000)
        file_menu_click(page, "Save as")
        page.wait_for_function("!document.querySelector('#modal-root').hidden && !!document.querySelector('#modal-body .form input')", timeout=4000)
        page.fill('#modal-body .form input', 'e2e-bake-probe')
        page.click('#modal-body .ghost-button:has-text("Save")')
        # Wait on the concrete save target (not the shared status text, which can carry a
        # stale "Saved" from an earlier test and match before this async save completes).
        page.wait_for_function("() => window.app.selectedOutput && /e2e-bake-probe/.test(window.app.selectedOutput.name)", timeout=8000)
        baked = page.evaluate("""async () => {
            const o = app.selectedOutput;
            const liveHref = editor.stage.querySelector('image').getAttribute('href') || '';
            const url = '/outputs/' + encodeURIComponent(o.folder) + '/' + encodeURIComponent(o.name);
            const text = await (await fetch(url)).text();
            const m = text.match(/<image[^>]*\\shref="([^"]*)"/i);
            return { savedData: !!(m && m[1].startsWith('data:')), liveNotBaked: !liveHref.startsWith('data:') && liveHref.length > 0 }; }""")
        check("persisted .svg bakes the raster href → data URI; live editor keeps its server href",
              baked["savedData"] and baked["liveNotBaked"], str(baked))

        section("self-contained save degrades EXPLICITLY, not silently (#32): when baking would")
        #      exceed the save cap, the user is ASKED — Cancel aborts, "Save linked" keeps
        #      (non-portable) refs. Force a cap just under the baked size so a small raster
        #      trips it (no giant image needed). The cap itself is sourced from the server.
        lim = page.evaluate("async () => (await (await fetch('/api/limits')).json())")
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
              + '<rect class="hv-artboard" x="0" y="0" width="100" height="100" fill="#fff"/></svg>','linked-fallback.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""() => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            editor.placeImage('/assets/hv_logo.svg','lf',80,80); return false; }""", timeout=6000)
        sizes = page.evaluate("""async () => { const raw = editor.serialize();
            const baked = await window.app.inlineSvgImages(raw); return { raw: raw.length, baked: baked.length }; }""")
        cap = sizes["raw"] + 1   # raw <= cap (so not the "even linked is over-cap" branch), baked > cap
        # (a) Cancel → save aborts (serializeForSave resolves null)
        page.evaluate(f"() => {{ window.app.setSaveByteCap({cap}); window.__sfs = window.app.serializeForSave(); }}")
        page.wait_for_function("() => !document.querySelector('#modal-root').hidden && !!document.querySelector('#modal-body .form-actions .primary-button')", timeout=4000)
        page.click('#modal-body .form-actions .ghost-button:has-text("Cancel")')
        cancelled = page.evaluate("async () => (await window.__sfs) === null")
        # (b) "Save linked" → returns the linked markup (href kept, NOT a data: URI)
        page.evaluate(f"() => {{ window.app.setSaveByteCap({cap}); window.__sfs2 = window.app.serializeForSave(); }}")
        page.wait_for_function("() => !document.querySelector('#modal-root').hidden && !!document.querySelector('#modal-body .form-actions .primary-button')", timeout=4000)
        page.click('#modal-body .form-actions .primary-button')
        linked = page.evaluate("""async () => { const out = await window.__sfs2;
            return { isLinked: !!out && /href="\\/assets\\/hv_logo\\.svg"/.test(out) && !/href="data:/.test(out) }; }""")
        page.evaluate("() => window.app.setSaveByteCap(null)")   # restore (next save re-fetches the real cap)
        check("self-contained save degrades EXPLICITLY: over-cap baking asks; Cancel aborts, 'Save linked' keeps refs; cap from /api/limits (#32)",
              isinstance(lim.get("max_svg_bytes"), int) and lim["max_svg_bytes"] >= 1 and cancelled and linked["isLinked"],
              str({"cap": lim, "cancelled": cancelled, **linked}))

        section("raster is a first-class object: fill/stroke no-op on <image> (clean DOM), and")
        #      its layers row shows a live thumbnail instead of a colour chip ----
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
              + '<rect class="hv-artboard" x="0" y="0" width="100" height="100" fill="#fff"/></svg>','raster-fc.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""() => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            const px='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            editor.placeImage(px,'fc.png',60,60); return false; }""", timeout=6000)
        rfc = page.evaluate("""() => {
            const id=[...editor.selection][0]; const img=editor.nodeById(id); window.__rasterId=id;
            editor.applyFill('#ff0000'); editor.applyStroke('#00ff00', 4);   // must NO-OP on a raster
            editor.applyFillOpacity(0.5); editor.applyStrokeOpacity(0.5);     // ditto
            editor.setStrokeAttr('stroke-linecap','square'); editor.setStrokeAlign('outside');
            editor.setAttrAll('fill-rule','evenodd');                         // ditto — every paint setter
            editor._renderLayers();
            const sw=document.querySelector(`#layers-list .layer-row[data-id="${id}"] .layer-swatch`);
            return { isRaster: editor.isRaster(img), noFill: !img.hasAttribute('fill'), noStroke: !img.hasAttribute('stroke'),
                     noPaint: !img.hasAttribute('fill-opacity') && !img.hasAttribute('stroke-opacity') && !img.hasAttribute('stroke-linecap')
                              && !img.hasAttribute('data-hv-stroke-align') && !img.hasAttribute('fill-rule'),
                     swatchRaster: !!(sw && sw.classList.contains('raster')) }; }""")
        # The swatch thumbnail is generated ASYNC + cached (#40): the full href is decoded once
        # into a tiny canvas PNG, never re-embedded per render. Wait for it, then verify it's the
        # generated thumb (a fresh data:image/png that ISN'T the raw href) and that it's cached.
        page.wait_for_function("""() => { const sw=document.querySelector(`#layers-list .layer-row[data-id="${window.__rasterId}"] .layer-swatch`);
            return !!sw && /url\\(/.test(sw.style.backgroundImage); }""", timeout=4000)
        thumb = page.evaluate("""() => { const sw=document.querySelector(`#layers-list .layer-row[data-id="${window.__rasterId}"] .layer-swatch`);
            const bg=sw.style.backgroundImage, href=editor.nodeById(window.__rasterId).getAttribute('href')||'';
            return { isPng:/url\\("data:image\\/png/.test(bg), notRawHref: bg.indexOf(href)===-1,
                     cached: !!(editor._rasterThumbCache && editor._rasterThumbCache.size>=1) }; }""")
        check("raster first-class: ALL paint setters no-op (#39) + layers swatch is a small cached thumbnail, not the raw href (#40)",
              rfc["isRaster"] and rfc["noFill"] and rfc["noStroke"] and rfc["noPaint"] and rfc["swatchRaster"]
              and thumb["isPng"] and thumb["notRawHref"] and thumb["cached"], str({**rfc, **thumb}))

        section("pipeline dissolves into the editor: an on-canvas raster is runnable in place")
        #      (no library name needed) and the Run label is honest about where it lands ----
        runl = page.evaluate("""() => {
            const id=[...editor.selection][0];
            settings.stage_vectorize=true; app.selectedName=null;
            editor.selection=new Set([id]); editor.artboardSelected=false; renderProcessorPanel();
            const onCanvas=document.querySelector('#processor-chin .proc-run');
            const r={ canvasLabel:onCanvas.textContent, canvasEnabled:!onCanvas.disabled };
            // library-only target (nothing on canvas selected, a library name set) → still
            // "Run → canvas": Run auto-loads the library raster onto the canvas (#34), so a
            // single-raster run is symmetric whether or not it's already placed.
            app.selectedName='nonexistent-probe.png'; editor.selection=new Set(); editor.artboardSelected=false; renderProcessorPanel();
            r.libLabel=document.querySelector('#processor-chin .proc-run').textContent;
            // whole-library batch via the explicit swap toggle
            document.querySelector('#processor-body .proc-target-swap').click();
            r.batchLabel=document.querySelector('#processor-chin .proc-run').textContent;
            document.querySelector('#processor-body .proc-target-swap').click();
            app.selectedName=null; delete settings.stage_vectorize; renderProcessorPanel();
            return r; }""")
        check("Run is honest + single-raster runs land on the canvas: canvas & library→'Run → canvas', batch→'Run library' (#34)",
              runl["canvasLabel"]=="Run → canvas" and runl["canvasEnabled"]
              and runl["libLabel"]=="Run → canvas" and runl["batchLabel"]=="Run library", str(runl))

        section("auto-routing: clicking a library raster surfaces its plan banner (#50 + browse→process)")
        # The auto-pipeline banner (.proc-auto) reads the analyzer's plan for the focused raster.
        # Regression guard: a Library raster CLICK must drive the Processor (re-render + schedule
        # /api/plan), not merely highlight the cell — else the Manage browse→process flow never
        # surfaces a plan. With a blank canvas the library pick IS the Processor target, so the
        # banner must appear where it was absent. It renders synchronously in its "Reading the
        # image…" busy state, so we don't wait on the (variable-cost) server analyze.
        # The Library + Processor live on the Manage screen, so drive this from there. Mount an
        # EMPTY stage (mountStageFromText, NOT newBlankDoc — that opens a modal) so the canvas holds
        # no raster and the library pick becomes the Processor target, then open Manage.
        page.evaluate("""() => {
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"></svg>', 'autoplan-probe.svg');
            app.selectedName=null; editor.selection=new Set(); editor.artboardSelected=false; renderProcessorPanel(); }""")
        page.click("#view-manage"); page.wait_for_function("() => document.querySelector('.app').classList.contains('manage')", timeout=4000)
        page.wait_for_timeout(80)
        page.evaluate("""() => { const r=document.querySelector('.lib-mode[data-mode="raster"]'); if (r) r.click(); }""")
        page.wait_for_timeout(60)
        has_thumb = page.evaluate("() => document.querySelectorAll('#library-list .gallery-thumb-button').length > 0")
        if has_thumb:
            before = page.evaluate("() => !!document.querySelector('#processor-body .proc-auto')")
            page.evaluate("() => document.querySelector('#library-list .gallery-thumb-button').click()")
            try:
                page.wait_for_function("() => !!document.querySelector('#processor-body .proc-auto')", timeout=3000); appeared = True
            except Exception:
                appeared = False
            check("a Library raster click drives the Processor auto-banner (was select-only; #50 browse→process)",
                  (not before) and appeared, f"before={before} after={appeared}")
        else:
            check("auto-banner browse→process check (skipped — empty library)", True)
        # Drop the library selection so the in-flight /api/plan is superseded+aborted (don't leave
        # the server analyzing a 150MP image into later sections), then return to Edit.
        page.evaluate("() => { app.selectedName=null; editor.selection=new Set(); renderProcessorPanel(); }")
        page.click("#view-edit"); page.wait_for_timeout(60)

        section("res-swing regression: a float shoved off-screen (e.g. a 4K layout opened on a")
        #      1080p screen) re-clamps fully into the viewport instead of stranding unreachable ----
        clamp = page.evaluate("""() => {
            const was = window.__docks.loc('history');   // restore EXACTLY afterwards
            window.__docks.float('history');
            const w = document.querySelector('.dock-window[data-dock-window="history"]');
            if (!w) return { nofloat: true };
            w.style.left = (innerWidth + 400) + 'px'; w.style.top = (innerHeight + 400) + 'px';
            const b = w.getBoundingClientRect();
            const before = b.left >= innerWidth || b.top >= innerHeight;
            window.__docks.clampFloats();
            const a = w.getBoundingClientRect();
            const after = a.left >= 0 && a.top >= 0 && a.right <= innerWidth + 1 && a.bottom <= innerHeight + 1;
            if (was === 'left' || was === 'right') window.__docks.dock('history', was); else window.__docks.shelve('history');
            const st = window.__docks.state(); if (st.history) delete st.history.rect;   // drop the off-screen test rect
            return { before, after }; }""")
        check("floating panel re-clamps into the viewport on resize/shrink (no off-screen stranding)",
              clamp.get("before") and clamp.get("after"), str(clamp))

        section("res-swing regression: a locking-bezel GROUP container also re-clamps")
        gclamp = page.evaluate("""() => {
            const wasH = window.__docks.loc('history'), wasL = window.__docks.loc('layers');
            window.__docks.float('history'); window.__docks.float('layers');
            if (!window.__docks.joinGroup) { window.__docks.shelve('history'); window.__docks.shelve('layers'); return { nogroup: true }; }
            window.__docks.joinGroup('history','layers','bottom');
            const g = document.querySelector('.dock-group');
            if (!g) return { nogroup: true };
            g.style.left = (innerWidth + 500) + 'px'; g.style.top = '8px';   // width still fits → reposition-only
            const members = () => [...g.querySelectorAll('.rail-section[data-section]')].map(s => {
                const r = s.getBoundingClientRect(); return { n: s.dataset.section, w: Math.round(r.width), h: Math.round(r.height), vis: s.offsetWidth > 0 && s.offsetHeight > 0 }; });
            const mBefore = members();
            const before = g.getBoundingClientRect().left >= innerWidth;
            window.__docks.clampFloats();
            const r = g.getBoundingClientRect();
            const after = r.left >= 0 && r.right <= innerWidth + 1;
            const mAfter = members();
            // internals pristine: a reposition-only clamp must NOT reflow the group's flex
            // children — same members, all visible, same sizes (±1px).
            const pristine = mBefore.length >= 2 && mBefore.length === mAfter.length
                && mAfter.every((m, i) => m.vis && m.n === mBefore[i].n
                    && Math.abs(m.w - mBefore[i].w) <= 1 && Math.abs(m.h - mBefore[i].h) <= 1);
            // Restore EXACTLY (don't leave persisted float rects — a stranded float would
            // otherwise re-open over the rail toggle after the suite's ?app=1 reload).
            const restore = (n, was) => { if (was === 'left' || was === 'right') window.__docks.dock(n, was); else window.__docks.shelve(n); };
            restore('history', wasH); restore('layers', wasL);
            const st = window.__docks.state(); if (st.history) delete st.history.rect; if (st.layers) delete st.layers.rect;
            return { before, after, pristine, members: mAfter.length }; }""")
        check("floating GROUP container re-clamps into the viewport AND its members stay pristine (#41)",
              gclamp.get("nogroup") or (gclamp.get("before") and gclamp.get("after") and gclamp.get("pristine")), str(gclamp))

        section("#41: the clamp fires on ANY layout reconcile (fold / dock / restore), not only")
        #      window resize — a float stranded by a programmatic move is recovered the next time
        #      the layout reconciles, WITHOUT an explicit clampFloats() call. ----
        recl = page.evaluate("""() => {
            const was = window.__docks.loc('history');
            window.__docks.float('history');
            const w = document.querySelector('.dock-window[data-dock-window="history"]');
            if (!w) return { nofloat: true };
            // strand it off-screen in BOTH the live style and the persisted rect (so however
            // reconcile re-places a float, it starts off-screen) — then DON'T call clampFloats.
            const st = window.__docks.state();
            if (st.history) st.history.rect = { x: innerWidth + 600, y: 8, w: 240, h: 200 };
            w.style.left = (innerWidth + 600) + 'px'; w.style.top = '8px';
            const before = w.getBoundingClientRect().left >= innerWidth;
            window.__docks.toggleFold(); window.__docks.toggleFold();   // reconcile() runs twice → should re-clamp
            const a = w.getBoundingClientRect();
            const after = a.left >= 0 && a.right <= innerWidth + 1;
            if (was === 'left' || was === 'right') window.__docks.dock('history', was); else window.__docks.shelve('history');
            const st2 = window.__docks.state(); if (st2.history) delete st2.history.rect;
            return { before, after }; }""")
        check("floats re-clamp on a non-resize layout change too (reconcile-driven, #41)",
              recl.get("nofloat") or (recl.get("before") and recl.get("after")), str(recl))

        section("Task 3 end-to-end (real job): a FOCUSED on-canvas run returns the result IN PLACE.")
        #      (a) vectorize → the raster becomes an editable vector group; the resolution
        #      ceiling + tiny-image seeding fix keep this fast and crash-free. ----
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
              + '<rect class="hv-artboard" x="0" y="0" width="120" height="120" fill="#fff"/></svg>','focusrun.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""() => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            // a multi-colour raster → several traced paths (a trivial 1-shape image traces
            // below the server's 'SVG too small' guard, which is meant to catch empty traces).
            const c=document.createElement('canvas'); c.width=c.height=96; const x=c.getContext('2d');
            x.fillStyle='#fff'; x.fillRect(0,0,96,96);
            x.fillStyle='#cc2222'; x.fillRect(10,10,40,40);
            x.fillStyle='#2266cc'; x.beginPath(); x.arc(64,64,24,0,7); x.fill();
            x.fillStyle='#22aa55'; x.fillRect(52,8,32,22);
            x.fillStyle='#222222'; x.fillRect(8,60,30,28);
            editor.placeImage(c.toDataURL('image/png'),'focus',96,96); return false; }""", timeout=6000)
        # A vectorize-ONLY focused run is WYSIWYG (#31): it commits exactly the live-preview
        # trace via /api/trace-preview, NOT a divergent /api/run/pipeline job at the batch
        # ceiling — so previewing and committing can never disagree. Spy on fetch to prove
        # the path collapsed (trace-preview hit, pipeline NOT hit).
        page.evaluate("""() => {
            window.__hits = { preview: 0, pipeline: 0 }; window.__origFetch = window.fetch;
            window.fetch = (u, ...rest) => { const s = String(u);
              if (s.includes('/api/trace-preview')) window.__hits.preview++;
              if (s.includes('/api/run/pipeline')) window.__hits.pipeline++;
              return window.__origFetch(u, ...rest); };
            const im=editor.stage.querySelector('image[data-hv-id]');
            editor.selection=new Set([im.getAttribute('data-hv-id')]); editor.artboardSelected=false; editor.onInspect();
            settings.stage_vectorize=true; settings.stage_upscale=false; settings.stage_removebg=false; settings.engine='clean';
            renderProcessorPanel();
            document.querySelector('#processor-chin .proc-run').click(); }""")
        page.wait_for_function("() => !editor.stage.querySelector('image[data-hv-id]') && !!editor.stage.querySelector('g[data-hv-id] path')", timeout=60000)
        vrun = page.evaluate("() => { window.fetch = window.__origFetch || window.fetch; return { imgs: editor.stage.querySelectorAll('image[data-hv-id]').length, vgroup: !!editor.stage.querySelector('g[data-hv-id] path'), hits: window.__hits }; }")
        check("focused vectorize-only run commits the preview trace IN PLACE via trace-preview, not a job (Task 3 + #31 WYSIWYG)",
              vrun["imgs"] == 0 and vrun["vgroup"] and vrun["hits"]["preview"] >= 1 and vrun["hits"]["pipeline"] == 0, str(vrun))

        # (b) a raster-producing stage (upscale) → the PNG result is swapped onto the SAME
        #     node: it stays an <image>, but its href moves from the data: source to an
        #     /outputs/ file. Uses a TRANSPARENT (RGBA) source so upscale takes the
        #     deterministic path (pure PIL — no Real-ESRGAN binary needed in CI).
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
              + '<rect class="hv-artboard" x="0" y="0" width="120" height="120" fill="#fff"/></svg>','focusrun2.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""() => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            const c=document.createElement('canvas'); c.width=c.height=64; const x=c.getContext('2d');
            x.fillStyle='#cc2222'; x.beginPath(); x.arc(32,32,20,0,7); x.fill();   // transparent outside → RGBA
            editor.placeImage(c.toDataURL('image/png'),'focusup',64,64); return false; }""", timeout=6000)
        page.evaluate("""() => {
            const im=editor.stage.querySelector('image[data-hv-id]');
            editor.selection=new Set([im.getAttribute('data-hv-id')]); editor.artboardSelected=false; editor.onInspect();
            settings.stage_vectorize=false; settings.stage_removebg=false; settings.stage_upscale=true; settings.scale='2';
            renderProcessorPanel();
            document.querySelector('#processor-chin .proc-run').click(); }""")
        page.wait_for_function("""() => { const im=editor.stage.querySelector('image[data-hv-id]');
            return !!im && (im.getAttribute('href')||'').startsWith('/outputs/'); }""", timeout=60000)
        brun = page.evaluate("""() => { const im=editor.stage.querySelector('image[data-hv-id]');
            return { stillImage: !!im, href: (im && (im.getAttribute('href')||'')).slice(0,9) }; }""")
        check("focused upscale run swaps the PNG result onto the same raster IN PLACE (Task 3, raster branch)",
              brun["stillImage"] and brun["href"] == "/outputs/", str(brun))
        # #33: a focused run does NOT litter the library — its output lands in a HIDDEN
        # (.pipeline-*) dir under a FRIENDLY stem (the raster's name, not inline-<hash>),
        # and the result file is absent from /api/outputs (the library listing).
        lit = page.evaluate("""async () => { const im=editor.stage.querySelector('image[data-hv-id]');
            const href = (im && (im.getAttribute('href')||'')) || '';
            const file = decodeURIComponent(href.split('/').pop() || '');
            const outs = await (await fetch('/api/outputs')).json();
            return { hiddenDir: /\\/outputs\\/\\.pipeline-/.test(href), friendly: /^focusup\\b/.test(file),
                     noInlineHash: !/inline-[0-9a-f]/.test(file),
                     notInLibrary: !(outs||[]).some(o => o.name === file) }; }""")
        check("focused run output is hidden from the library + friendly-named (#33)",
              lit["hiddenDir"] and lit["friendly"] and lit["noInlineHash"] and lit["notInLibrary"], str(lit))

        # (c) #34: a LIBRARY-selected raster (nothing on the canvas) is auto-loaded onto the
        #     canvas on Run, then processed in place — symmetric with an on-canvas raster, no
        #     "Load to preview" two-step. Inject a synthetic library item backed by a data URL
        #     (resolve_source_url materialises it), select it by name (empty canvas selection),
        #     run vectorize-only → the raster lands on the canvas and becomes a vector group.
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
              + '<rect class="hv-artboard" x="0" y="0" width="120" height="120" fill="#fff"/></svg>','autoload.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.evaluate("""() => {
            const c=document.createElement('canvas'); c.width=c.height=96; const x=c.getContext('2d');
            x.fillStyle='#fff'; x.fillRect(0,0,96,96);
            x.fillStyle='#cc2222'; x.fillRect(10,10,40,40);
            x.fillStyle='#2266cc'; x.beginPath(); x.arc(64,64,24,0,7); x.fill();
            x.fillStyle='#22aa55'; x.fillRect(52,8,32,22);
            window.app.workItems.push({ name:'autoload-probe.png', url:c.toDataURL('image/png') });
            editor.selection=new Set(); editor.artboardSelected=false;   // NOTHING on canvas selected
            app.selectedName='autoload-probe.png';                       // selected only in the library
            settings.stage_vectorize=true; settings.stage_upscale=false; settings.stage_removebg=false; settings.engine='clean';
            renderProcessorPanel();
            // sanity: with no canvas raster, the run is still 'Run → canvas' (auto-load)
            window.__autoBefore = { imgs: editor.stage.querySelectorAll('image[data-hv-id]').length,
                                    label: document.querySelector('#processor-chin .proc-run').textContent };
            document.querySelector('#processor-chin .proc-run').click(); }""")
        page.wait_for_function("() => !!editor.stage.querySelector('g[data-hv-id] path') && !editor.stage.querySelector('image[data-hv-id]')", timeout=60000)
        al = page.evaluate("() => ({ before: window.__autoBefore, vgroup: !!editor.stage.querySelector('g[data-hv-id] path'), imgs: editor.stage.querySelectorAll('image[data-hv-id]').length, vb: editor.stage.getAttribute('viewBox') })")
        page.evaluate("() => { app.selectedName=null; delete settings.stage_vectorize; delete settings.engine; renderProcessorPanel(); }")
        check("library-selected raster auto-loads onto the canvas on Run, then vectorises in place (#34)",
              al["before"]["imgs"] == 0 and al["before"]["label"] == "Run → canvas" and al["vgroup"] and al["imgs"] == 0, str(al))
        # Loading onto an empty/blank canvas auto-sizes the canvas to the image (96x96
        # probe), instead of forcing it into the prior 120x120 blank or refusing.
        check("loading onto an empty canvas auto-sizes it to the image (no forced/crammed canvas)",
              al["vb"] == "0 0 96 96", str(al))

        # (d) #42: a MULTI-STAGE focused run (upscale + vectorize chained) goes through the job
        #     path (not the vectorize-only fast path), traces the upscaled intermediate at the
        #     focused resolution, and returns the terminal SVG onto the raster in place. Uses an
        #     RGBA source so upscale takes the deterministic path (no Real-ESRGAN binary).
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">'
              + '<rect class="hv-artboard" x="0" y="0" width="120" height="120" fill="#fff"/></svg>','multistage.svg'); }""")
        page.wait_for_function("editor && editor.stage", timeout=4000)
        page.wait_for_function("""() => { if (!editor || !editor.stage) return false;
            if (editor.stage.querySelector('image[data-hv-id]')) return true;
            const c=document.createElement('canvas'); c.width=c.height=72; const x=c.getContext('2d');
            x.fillStyle='#cc2222'; x.fillRect(10,10,30,30);                       // shapes on a TRANSPARENT bg → RGBA
            x.fillStyle='#2266cc'; x.beginPath(); x.arc(48,48,16,0,7); x.fill();
            editor.placeImage(c.toDataURL('image/png'),'multi',72,72); return false; }""", timeout=6000)
        page.evaluate("""() => {
            const im=editor.stage.querySelector('image[data-hv-id]');
            editor.selection=new Set([im.getAttribute('data-hv-id')]); editor.artboardSelected=false; editor.onInspect();
            settings.stage_upscale=true; settings.scale='2'; settings.stage_removebg=false;
            settings.stage_vectorize=true; settings.engine='clean';
            renderProcessorPanel();
            window.__msFetch = window.fetch; window.__msPipeline = 0;
            window.fetch = (u, ...r) => { if (String(u).includes('/api/run/pipeline')) window.__msPipeline++; return window.__msFetch(u, ...r); };
            document.querySelector('#processor-chin .proc-run').click(); }""")
        page.wait_for_function("() => !editor.stage.querySelector('image[data-hv-id]') && !!editor.stage.querySelector('g[data-hv-id] path')", timeout=60000)
        ms = page.evaluate("() => { window.fetch = window.__msFetch || window.fetch; return { imgs: editor.stage.querySelectorAll('image[data-hv-id]').length, vgroup: !!editor.stage.querySelector('g[data-hv-id] path'), viaJob: window.__msPipeline }; }")
        page.evaluate("() => { delete settings.stage_upscale; delete settings.scale; delete settings.stage_vectorize; delete settings.engine; }")
        check("multi-stage focused run (upscale+vectorize) goes via a job and returns the vector in place (#42)",
              ms["imgs"] == 0 and ms["vgroup"] and ms["viaJob"] >= 1, str(ms))
        # Clean up after the real jobs: clear the queue (so the background job-poller doesn't
        # keep re-rendering panels and destabilising later clicks) and reset the stage flags.
        page.evaluate("""async () => {
            delete settings.stage_upscale; delete settings.scale; delete settings.stage_vectorize; delete settings.engine;
            try { await fetch('/api/jobs/clear', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}); } catch {}
            if (typeof loadJobs === 'function') { try { await loadJobs(); } catch {} } }""")
        page.wait_for_timeout(200)

        section("regression fix: stroke-align clip is re-anchored on clone (was sharing the source's clip id)")
        SA_DOC = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">'
                  '<rect class="hv-artboard" x="0" y="0" width="200" height="200" fill="#fff"/>'
                  '<path data-hv-id="sp" d="M40 40 L120 40 L120 120 Z" fill="#cde" stroke="#036" stroke-width="6"/></svg>')
        page.evaluate("svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'sa.svg'); }", SA_DOC)
        page.wait_for_function("editor.nodeById('sp')", timeout=4000)
        sa = page.evaluate("""() => {
            editor.selection=new Set(['sp']); editor.artboardSelected=false; editor._renderSelection();
            editor.setStrokeAlign('inside');
            const origClip = editor.nodeById('sp').getAttribute('clip-path');
            editor.duplicate();
            const clone = editor.nodeById([...editor.selection][0]);
            const cloneClip = clone.getAttribute('clip-path');
            const refDef = (cp) => !!(cp && editor.stage.querySelector(cp.replace('url(#','#').replace(')','')));
            return { origClip, cloneClip, distinct: !!origClip && !!cloneClip && origClip!==cloneClip,
                     origDef: refDef(origClip), cloneDef: refDef(cloneClip),
                     noIdCollision: editor.stage.querySelectorAll('#'+CSS.escape('sp')).length <= 1 }; }""")
        check("stroke-align clip is re-anchored on clone (own clip def, no id collision)",
              sa["distinct"] and sa["origDef"] and sa["cloneDef"] and sa["noIdCollision"], str(sa))

        section("Node tool under a transformed/grouped ancestor (anchors map through the CTM)")
        XF_DOC = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">'
                  '<g data-hv-id="g1" transform="translate(100 50)">'
                  '<path data-hv-id="p1" d="M0 0 L40 0 L40 40 Z" fill="#888"/></g></svg>')
        page.evaluate("svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'xf.svg'); }", XF_DOC)
        page.wait_for_function("editor.nodeById('p1')", timeout=8000)
        page.evaluate("editor.selection=new Set(['g1']); editor.artboardSelected=false; editor._renderSelection(); editor.setTool('node');")
        page.wait_for_timeout(140)
        centers = page.evaluate(
            "() => [...editor._overlayEl().querySelectorAll('.hv-node-anchor')]"
            ".map(r => ({x:+r.getAttribute('x')+(+r.getAttribute('width'))/2, y:+r.getAttribute('y')+(+r.getAttribute('height'))/2}))")
        near = lambda cx, cy: any(abs(c['x']-cx) < 2 and abs(c['y']-cy) < 2 for c in centers)
        # local anchors (0,0)(40,0)(40,40) + group translate(100,50) → stage (100,50)(140,50)(140,90)
        check("node anchors render through the ancestor transform",
              near(100, 50) and near(140, 50) and near(140, 90), str(centers))
        # writing back: moving an anchor to a stage point lands the LOCAL geometry correctly
        moved = page.evaluate(
            "() => { const nd = hv.pathNodes(editor.stage, null).find(n => n.id==='p1' && n.k===0);"
            "nd.moveTo(110, 60); const d = editor.nodeById('p1').getAttribute('d');"
            "return /M\\s*10[ ,]+10/.test(d); }")   # stage (110,60) - translate(100,50) = local (10,10)
        check("node drag writes back into local geometry", moved is True)
        page.evaluate("editor.setTool('select')")

        section("Ruler guides: persistent, editable when unlocked, view tied to rulers")
        mount_ctl(page)
        # guides + rulers share one visibility; default locked (no accidental moves)
        page.evaluate("editor.guidesHidden=false; editor.guidesLocked=true; editor.guides=[]; editor.renderGuides(); editor.addGuide('v', 30); editor.addGuide('h', 40);")
        page.wait_for_timeout(40)
        check("ruler guides render in their own layer",
              page.evaluate("editor.stage.querySelectorAll('g.hv-guideslayer .hv-guideobj').length") == 2)
        check("locked guides draw no drag hit-targets (can't be moved by accident)",
              page.evaluate("editor.stage.querySelectorAll('.hv-guidehit').length") == 0)
        check("guides render above artwork (layer is just below the overlay)",
              page.evaluate("() => { const g=editor.stage.querySelector('g.hv-guideslayer'); return !!g && g.nextSibling === editor._overlayEl(); }"))
        page.evaluate("editor.toggleGuidesLock();"); page.wait_for_timeout(20)   # unlock → editable
        check("unlocked guides expose drag hit-targets",
              page.evaluate("editor.stage.querySelectorAll('.hv-guidehit').length") == 2)
        ser = page.evaluate("editor.serialize()")
        check("guides never reach saved output", "hv-guideslayer" not in ser and "hv-guideobj" not in ser)
        check("guides layer is not artwork (no data-hv-id)",
              page.evaluate("!editor.stage.querySelector('g.hv-guideslayer[data-hv-id]') && editor._artworkNodes().length === 3"))
        page.evaluate("editor.push('probe'); editor.undo();"); page.wait_for_timeout(60)
        check("guides survive an undo restore (re-rendered on install)",
              page.evaluate("editor.stage.querySelectorAll('.hv-guideobj').length") == 2)
        # Ctrl+R hides rulers + guide marks together
        page.evaluate("if(!document.querySelector('#vp-rulers').classList.contains('on')) document.querySelector('#vp-rulers').click();"); page.wait_for_timeout(40)
        rulers_on = page.evaluate("document.querySelector('#vp-rulers').classList.contains('on')")
        page.keyboard.press("Control+r"); page.wait_for_timeout(40)
        check("Ctrl+R toggles rulers AND guide marks together",
              page.evaluate("document.querySelector('#vp-rulers').classList.contains('on')") != rulers_on
              and page.evaluate("editor.guidesHidden") == rulers_on)
        page.evaluate("document.querySelector('#vp-rulers').classList.contains('on') || document.querySelector('#vp-rulers').click(); editor.guidesHidden=false; editor.renderGuides(); editor.clearGuides();"); page.wait_for_timeout(20)
        check("clearGuides empties the layer",
              page.evaluate("editor.guides.length === 0 && editor.stage.querySelectorAll('.hv-guideobj').length === 0"))

        section("Customize layout: draggable dividers + right-click add/remove")
        page.evaluate("window.__layout.toggleEdit()"); page.wait_for_timeout(80)
        check("dividers become draggable in customize mode",
              page.evaluate("() => { const s=document.querySelector('.actionbar .tool-sep'); return !!s && s.draggable === true; }") is True)
        before = page.evaluate("document.querySelectorAll('.actionbar .tool-sep').length")
        page.evaluate("() => { const bar=document.querySelector('.actionbar'); const r=bar.getBoundingClientRect();"
                      "bar.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:Math.round(r.left+6),clientY:Math.round(r.top+6)})); }")
        page.wait_for_selector('.context-menu', timeout=4000)
        page.click('.context-menu .menu-item:has-text("Add divider")'); page.wait_for_timeout(80)
        after = page.evaluate("document.querySelectorAll('.actionbar .tool-sep').length")
        check("right-click adds a divider", after == before + 1, f"{before}->{after}")
        check("added divider is auto-saved to the layout",
              page.evaluate("(JSON.parse(localStorage.getItem('hector-vector:layout')||'{}').actions||[]).filter(k=>k==='|').length") == after)
        # remove it again via right-click on the divider itself
        page.evaluate("() => { const s=document.querySelector('.actionbar .tool-sep'); const r=s.getBoundingClientRect();"
                      "s.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:Math.round(r.left+1),clientY:Math.round(r.top+1)})); }")
        page.wait_for_selector('.context-menu .menu-item:has-text("Remove divider")', timeout=4000)
        page.click('.context-menu .menu-item:has-text("Remove divider")'); page.wait_for_timeout(80)
        check("right-click removes a divider",
              page.evaluate("document.querySelectorAll('.actionbar .tool-sep').length") == before, f"back to {before}")
        # panel headers are customize-layout receivers: drag a toolbar tile into one
        landed = page.evaluate("""() => {
            const tile = document.querySelector('.actionbar #act-union');
            const hdr = document.querySelector('.rail-section.properties .panel-actions');
            if (!tile || !hdr) return 'missing';
            const dt = new DataTransfer();
            tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = hdr.getBoundingClientRect();
            hdr.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientX: Math.round(r.right - 4), clientY: Math.round(r.top + r.height / 2), dataTransfer: dt }));
            hdr.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
            tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return document.querySelector('.rail-section.properties .panel-actions #act-union') ? 'in' : 'out'; }""")
        check("drag a toolbar tile INTO a panel header receiver", landed == "in", str(landed))
        check("header receiver arrangement is auto-saved",
              page.evaluate("((JSON.parse(localStorage.getItem('hector-vector:layout')||'{}'))['hdr-properties']||[]).includes('#act-union')"))
        # no blank-slot placeholder box any more — an empty/partial header just shows its real button(s)
        check("panel headers render no blank-slot placeholder",
              page.evaluate("!document.querySelector('.hdr-slot-empty')"))
        # Headers now scroll on overflow (tile-scroll), so the cap was raised past 3 — a
        # 4th dropped tile is accepted (was refused under the old 3-tile cap).
        capped = page.evaluate("""() => {
            const hdr = document.querySelector('.rail-section.properties .panel-actions');
            const drop = (id) => { const tile = document.querySelector('.actionbar #'+id); if (!tile) return;
              const dt = new DataTransfer(); tile.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
              const r = hdr.getBoundingClientRect();
              hdr.dispatchEvent(new DragEvent('dragover',{bubbles:true,clientX:Math.round(r.right-4),clientY:Math.round(r.top+r.height/2),dataTransfer:dt}));
              hdr.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
              tile.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt})); };
            drop('act-cut');
            drop('act-copy');  // a 4th tile — now accepted (overflow-scrolls)
            const tiles = [...hdr.children].filter(c => c.classList.contains('tool-button') && !c.classList.contains('panel-x'));
            return { n: tiles.length, copyIn: !!hdr.querySelector('#act-copy') }; }""")
        check("panel header accepts more than 3 tiles (overflow-scrolls)", capped["n"] >= 4 and capped["copyIn"] is True, str(capped))
        page.evaluate("window.__layout.toggleEdit(); window.__layout.reset()"); page.wait_for_timeout(60)
        check("Reset returns the moved tile to the action bar",
              page.evaluate("!!document.querySelector('.actionbar #act-union') && !document.querySelector('.rail-section.properties #act-union')"))

        section("Dockable panels: float, dock left/right, reorder, fold, Properties")
        check("docking controller is exposed", page.evaluate("!!window.__docks") is True)
        # leftdock is the leftmost grid child (before the toolstrip)
        check("left dock is the leftmost column",
              page.evaluate("() => document.querySelector('.editor-grid').firstElementChild.id === 'leftdock'"))
        # Properties + Colour default docked-right; float them out so the History/Layers checks
        # below see a clean right dock. (Library/Processor/Jobs aren't dock panels — they live on
        # the Manage screen — so they're already absent from the dock.)
        page.evaluate("window.__docks.float('properties'); window.__docks.float('color')"); page.wait_for_timeout(60)
        # float History (no detach button — controller / header-drag does it)
        page.evaluate("window.__docks.float('history')"); page.wait_for_timeout(80)
        check("a panel floats into a dock-window",
              page.evaluate("window.__docks.loc('history') === 'float' && !!document.querySelector('.dock-window[data-dock-window=\"history\"]')"))
        check("no detach buttons in panel headers (drag the header instead)",
              page.evaluate("!document.querySelector('.dock-detach')"))
        # collapsing a FLOATING panel hugs its header — the window's min-height is dropped so
        # there's no empty chin below the folded header (was: "floating + collapsed = empty chin")
        page.evaluate("""() => { const s=document.querySelector('.dock-window[data-dock-window="history"] .rail-section');
            if (s && !s.classList.contains('collapsed')) s.querySelector('.section-head').click(); }""")
        page.wait_for_timeout(60)
        win_h = page.evaluate("document.querySelector('.dock-window[data-dock-window=\"history\"]').getBoundingClientRect().height")
        head_h = page.evaluate("document.querySelector('.dock-window[data-dock-window=\"history\"] .section-head').getBoundingClientRect().height")
        check("a collapsed floating panel hugs its header (no empty chin)", win_h - head_h < 16, f"win={win_h} head={head_h}")
        page.evaluate("""() => { const s=document.querySelector('.dock-window[data-dock-window="history"] .rail-section');
            if (s && s.classList.contains('collapsed')) s.querySelector('.section-head').click(); }""")
        page.wait_for_timeout(40)
        # dock Layers LEFT → left dock auto-opens
        page.evaluate("window.__docks.dock('layers','left')"); page.wait_for_timeout(80)
        check("docking left auto-opens the left dock",
              page.evaluate("window.__docks.loc('layers')==='left' && getComputedStyle(document.querySelector('#leftdock')).display !== 'none' && !!document.querySelector('#leftdock .rail-section.layers')"))
        check("emptied right dock auto-closes",
              page.evaluate("getComputedStyle(document.querySelector('#rightdock')).display === 'none'"))
        # dock both into the right dock and REORDER: Layers above History
        page.evaluate("window.__docks.dock('history','right'); window.__docks.dock('layers','right','history')"); page.wait_for_timeout(80)
        order = page.evaluate("[...document.querySelectorAll('#rightdock .rail-section')].map(s=>s.dataset.section)")
        check("panels reorder within a dock (Layers above History)", order == ["layers", "history"], f"order={order}")
        page.evaluate("window.__docks.dock('history','right','layers'); window.__docks.dock('layers','right')"); page.wait_for_timeout(40)

        section("Locking-bezel groups: snap two floating panels into one move/scale group")
        page.evaluate("window.__docks.float('history'); window.__docks.float('layers')"); page.wait_for_timeout(60)
        grp = page.evaluate("""() => {
            window.__docks.joinGroup('history','layers','right');   // what an auto-snap drop does
            const cont = document.querySelector('.dock-group');
            const gid = window.__docks.groupOf('history');
            return { containers: document.querySelectorAll('.dock-group').length,
                     sections: cont ? cont.querySelectorAll(':scope > .rail-section').length : 0,
                     bezels: cont ? cont.querySelectorAll(':scope > .dock-bezel').length : 0,
                     handles: cont ? cont.querySelectorAll(':scope > .dock-rs').length : 0,
                     grouped: !!gid && gid === window.__docks.groupOf('layers'),
                     noStandaloneWin: !document.querySelector('.dock-window > .rail-section.history') }; }""")
        check("two panels snap-lock into one bezel group (resizable + move together)",
              grp["containers"] == 1 and grp["sections"] == 2 and grp["bezels"] == 1
              and grp["handles"] == 8 and grp["grouped"] and grp["noStandaloneWin"], str(grp))
        # double-click the bezel → detach the group back into standalone floating panels
        split = page.evaluate("""() => {
            document.querySelector('.dock-group .dock-bezel').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
            return { containers: document.querySelectorAll('.dock-group').length,
                     ungrouped: !window.__docks.groupOf('history') && !window.__docks.groupOf('layers'),
                     floats: window.__docks.loc('history')==='float' && window.__docks.loc('layers')==='float' }; }""")
        check("double-clicking the bezel detaches the group",
              split["containers"] == 0 and split["ungrouped"] and split["floats"], str(split))
        # Splitting a 3-panel group must NOT orphan the multi-panel side. (Regression: the
        # stale container was removed before its HTML sections were re-homed → they vanished.)
        vis3 = page.evaluate("""() => {
            window.__docks.float('history'); window.__docks.float('layers'); window.__docks.float('properties');
            window.__docks.joinGroup('layers','history','right');
            window.__docks.joinGroup('properties', window.__docks.groupOf('history'), 'right');   // history|layers|properties
            window.__docks.splitGroup(window.__docks.groupOf('history'), 1);                // [history] | [layers,properties]
            const seen = (n) => { const e=document.querySelector('.rail-section.'+n); if(!e) return false;
                const r=e.getBoundingClientRect(); return r.width>4 && r.height>4 && !!e.closest('.dock-window,.dock-group'); };
            const r = { history: seen('history'), layers: seen('layers'), properties: seen('properties'),
                     subgroup: Object.values(window.__docks.groups()).some(g => g.members.length===2) };
            window.__docks.dock('properties','right');   // restore the borrowed grouping subject
            return r; }""")
        check("splitting a 3-panel group keeps every panel mounted (no orphaned side)",
              vis3["history"] and vis3["layers"] and vis3["properties"] and vis3["subgroup"], str(vis3))
        # collapsing a grouped (snapped) member folds it to its header — flex 0 0 auto, no blank slot
        fold = page.evaluate("""() => {
            window.__docks.float('history'); window.__docks.float('layers'); window.__docks.joinGroup('layers','history','right');
            const hs = document.querySelector('.dock-group .rail-section.history .section-head');
            hs.dispatchEvent(new MouseEvent('click', {bubbles:true}));   // collapse history
            const h = document.querySelector('.dock-group .rail-section.history');
            const res = { collapsed: h.classList.contains('collapsed'), hugs: h.style.flex === '0 0 auto' };
            hs.dispatchEvent(new MouseEvent('click', {bubbles:true}));   // un-collapse (cleanup)
            return res; }""")
        check("collapsing a snapped panel folds it to its header (no blank slot)",
              fold["collapsed"] and fold["hugs"], str(fold))
        page.evaluate("window.__docks.dock('history','right'); window.__docks.dock('layers','right')"); page.wait_for_timeout(40)
        # Jobs + Processor are Manage-screen citizens now (not Edit-dock panels): they live in the
        # manage-grid, render their panels there, and are exempt from dock float/shelve. Verify they
        # render + their controls work AND that they do NOT sit in the Edit dock.
        jb = page.evaluate("""() => ({ notInEditDock: !document.querySelector('#rightdock .rail-section.jobs'),
            inGrid: !!document.querySelector('.manage-grid .rail-section.jobs'),
            hasPanel: !!document.querySelector('#jobs-list .jobs-panel'),
            away: window.__docks.isAway('jobs') })""")
        check("Jobs is a Manage-screen panel (renders), not in the Edit dock",
              jb["notInEditDock"] and jb["inGrid"] and jb["hasPanel"] and jb["away"], str(jb))
        proc = page.evaluate("""() => {
            const stages = [...document.querySelectorAll('#processor-body .proc-stage')].map(c => c.dataset.stage);
            const up = document.querySelector('#processor-body .proc-stage[data-stage="upscale"] .stage-toggle');
            const wasOn = up.checked; up.click(); const toggled = up.checked !== wasOn; up.click();
            return { notInEditDock: !document.querySelector('#rightdock .rail-section.processor'),
                     inGrid: !!document.querySelector('.manage-grid .rail-section.processor'),
                     stages, hasStages: stages.length === 6, toggled, away: window.__docks.isAway('processor') };
        }""")
        check("Processor is a Manage-screen flow-rail (stages render + toggle), not in the Edit dock",
              proc["notInEditDock"] and proc["inGrid"] and proc["hasStages"] and proc["toggled"] and proc["away"], str(proc))
        # Properties is the same kind of object — float it, then dock it back
        page.evaluate("window.__docks.float('properties')"); page.wait_for_timeout(60)
        check("Properties can float into a window",
              page.evaluate("window.__docks.loc('properties')==='float' && !!document.querySelector('.dock-window[data-dock-window=\"properties\"] .fp-body')"))
        page.evaluate("window.__docks.dock('properties','right')"); page.wait_for_timeout(60)
        check("Properties docks like any other panel",
              page.evaluate("window.__docks.loc('properties')==='right' && !!document.querySelector('#rightdock .rail-section.properties')"))
        # Colour is a dockable panel too — summon it (with a colourable object selected, so
        # it shows the embedded picker rather than the empty "select an object" state) and dock it
        page.evaluate("""() => { mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            + '<rect class="hv-artboard" x="0" y="0" width="100" height="100" fill="#fff"/>'
            + '<rect data-hv-id="cz" x="10" y="10" width="40" height="40" fill="#3366cc"/></svg>','color-host.svg'); }""")
        page.wait_for_function("editor.stage && editor.nodeById('cz')", timeout=8000)
        page.wait_for_timeout(80)   # let the mount's rAF sync settle before selecting
        page.evaluate("""() => { editor.selection = new Set(['cz']); editor.artboardSelected = false; editor.onInspect(); window.__docks.showColor(); }""")
        page.wait_for_timeout(80)
        check("Colour summons as a panel with the embedded editor",
              page.evaluate("!!document.querySelector('.rail-section.color .cp-window.cp-embedded')"))
        # ...and with nothing selected it shows an empty state, not the (tall) picker (no overflow)
        check("Colour shows an empty state when nothing is selected",
              page.evaluate("""() => { editor.selection=new Set(); editor.artboardSelected=false; editor.onInspect();
                  window.__docks.renderColor && window.__docks.renderColor();
                  const b=document.querySelector('.rail-section.color .fp-body');
                  return !!b && !b.querySelector('.cp-window') && /select/i.test(b.textContent); }"""))
        page.evaluate("window.__docks.dock('color','right')"); page.wait_for_timeout(60)
        check("Colour docks like any other panel",
              page.evaluate("window.__docks.loc('color')==='right' && !!document.querySelector('#rightdock .rail-section.color')"))
        section("Shelf: closed/unused panels park in the top-right header as squares")
        shelf = page.evaluate("""() => {
            window.__docks.dock('history','right'); window.__docks.close('history');                // close History → shelf
            const histSq = !!document.querySelector('#panel-shelf .shelf-sq[data-shelf="history"]');
            const histGone = !document.querySelector('#rightdock .rail-section.history');
            document.querySelector('#panel-shelf .shelf-sq[data-shelf="history"]').click();          // click square → reopen
            const histBack = !!document.querySelector('#rightdock .rail-section.history');
            const sqGone = !document.querySelector('#panel-shelf .shelf-sq[data-shelf="history"]');
            return { histSq, histGone, histBack, sqGone }; }""")
        check("shelf parks closed/unused panels as squares; clicking a square reopens them",
              shelf["histSq"] and shelf["histGone"] and shelf["histBack"] and shelf["sqGone"], str(shelf))
        # right-click a panel header → close it to the shelf (contextual close)
        rc = page.evaluate("""() => { window.__docks.dock('layers','right');
            document.querySelector('#rightdock .rail-section.layers .section-head').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));
            const shelved = !document.querySelector('#rightdock .rail-section.layers') && !!document.querySelector('#panel-shelf .shelf-sq[data-shelf="layers"]');
            window.__docks.unshelve('layers'); return shelved; }""")
        check("right-clicking a panel header shelves it", rc, str(rc))
        # Info is a Manage-screen citizen now (the selection inspector), not an Edit shelf/dock
        # panel — it lives in the manage-grid and is a standard panel (no ghost context-panel chrome).
        check("Info is a Manage-grid panel (standard chrome, not on the Edit shelf)",
              page.evaluate("""() => { const s=document.querySelector('.manage-grid .rail-section.info');
                  return !!s && !s.classList.contains('context-panel') && window.__docks.isAway('info')
                      && !document.querySelector('#panel-shelf .shelf-sq[data-shelf="info"]'); }"""))
        # state memory: a FLOATING panel that's shelved reopens FLOATING (not docked), on-screen
        mem = page.evaluate("""() => {
            window.__docks.float('history'); window.__docks.shelve('history'); window.__docks.unshelve('history');
            const win = document.querySelector('.dock-window .rail-section.history') &&
                        document.querySelector('.dock-window .rail-section.history').closest('.dock-window');
            const r = win ? win.getBoundingClientRect() : null;
            const onScreen = !!r && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
            return { floatedBack: window.__docks.loc('history') === 'float', onScreen }; }""")
        check("a floated panel reopens floating, on-screen (open/close state memory)",
              mem["floatedBack"] and mem["onScreen"], str(mem))
        section("Contextual auto-shelving: an unused panel parks itself into a shelf square, and")
        # pops back the moment it's relevant again (Colour follows the canvas selection). ----
        page.evaluate("""() => { mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            + '<rect class="hv-artboard" x="0" y="0" width="100" height="100" fill="#fff"/>'
            + '<rect data-hv-id="cz" x="10" y="10" width="40" height="40" fill="#3366cc"/></svg>','ctx-host.svg'); }""")
        page.wait_for_function("editor.stage && editor.nodeById('cz')", timeout=8000)
        page.wait_for_timeout(80)
        auto = page.evaluate("""() => {
            window.__docks.dock('color','right'); window.__docks.state().color.pinned = false;
            editor.selection = new Set(); editor.artboardSelected = false; window.__docks.syncContextual();
            const sq = document.querySelector('#panel-shelf .shelf-sq[data-shelf="color"]');
            const shelved = !document.querySelector('#rightdock .rail-section.color')
                            && !!sq && sq.classList.contains('auto');   // idle squares read as auto/dashed
            const locShelf = window.__docks.loc('color') === 'shelf';   // loc() reports the shelf (not a stale dock side)
            editor.selection = new Set(['cz']); editor.artboardSelected = false; editor.onInspect();
            const back = !!document.querySelector('#rightdock .rail-section.color')
                         && !document.querySelector('#panel-shelf .shelf-sq[data-shelf="color"]');
            return { shelved, locShelf, back }; }""")
        check("a contextual panel auto-shelves when unused and returns when relevant",
              auto["shelved"] and auto["locShelf"] and auto["back"], str(auto))
        # a panel the user placed by hand (pinned) is exempt — it stays put (dims, not parks)
        pin = page.evaluate("""() => {
            window.__docks.dock('color','right'); window.__docks.state().color.pinned = true;
            editor.selection = new Set(); editor.artboardSelected = false; window.__docks.syncContextual();
            const stayed = !!document.querySelector('#rightdock .rail-section.color');
            window.__docks.state().color.pinned = false; return stayed; }""")
        check("a user-pinned panel is exempt from contextual auto-shelving", pin, str(pin))
        # Info is the Manage selection inspector — its grid panel is never blank (a hint until an
        # image is opened into it; refillInfoContext fills it with the current context).
        info = page.evaluate("""() => {
            if (typeof window.refillInfoContext === 'function') window.refillInfoContext();
            const b = document.querySelector('.manage-grid .rail-section.info .fp-body');
            return { ok: !!b && b.textContent.trim().length > 0, text:(b?b.textContent:'').slice(0,40) }; }""")
        check("the Manage Info inspector fills with context (never blank)", info["ok"], str(info))
        # right-clicking a shelf square opens an options menu (open / float / dock either side)
        menu = page.evaluate("""() => {
            window.__docks.shelve('history');
            const sq = document.querySelector('#panel-shelf .shelf-sq[data-shelf="history"]');
            sq.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true, clientX:60, clientY:60}));
            const m = document.querySelector('.context-menu');
            const labels = m ? [...m.querySelectorAll('.menu-label')].map(e=>e.textContent) : [];
            const float = m ? [...m.querySelectorAll('.menu-item')].find(b=>/floating/i.test(b.textContent)) : null;
            if (float) float.click();
            return { hasMenu: !!m, labels, floated: window.__docks.loc('history')==='float' }; }""")
        check("right-clicking a shelf square opens an options menu (open / float / dock)",
              menu["hasMenu"] and any('float' in l.lower() for l in menu["labels"]) and menu["floated"], str(menu))
        # docked panels open at CONTENT height (capped at their even share) — a never-resized
        # panel gets an explicit `0 0 Npx` basis sized to fit, not a blind even slice.
        fit = page.evaluate("""() => {
            window.__docks.dock('color','right'); window.__docks.dock('properties','right');
            window.__docks.state().color.pinned = true; delete window.__docks.state().color.h;
            window.__docks.relayout();
            const dock = document.querySelector('#rightdock');
            const secs = [...dock.querySelectorAll(':scope > .rail-section')];
            const color = dock.querySelector('.rail-section.color');
            const even = dock.getBoundingClientRect().height / Math.max(1, secs.length);
            const parts = (color.style.flex || '').split(/\\s+/);
            const basis = parseFloat(parts[2]) || 0;
            window.__docks.state().color.pinned = false;
            return { basis, even, nonLast: secs.indexOf(color) < secs.length - 1, fmt: parts.slice(0,2).join(' ') }; }""")
        check("a docked panel opens at content height (capped at its even share)",
              fit["nonLast"] and fit["fmt"] == "0 0" and fit["basis"] > 0 and fit["basis"] <= fit["even"] + 1, str(fit))
        page.evaluate("window.__docks.dock('history','right')"); page.wait_for_timeout(40)
        check("docked panels hide the × (no close button in a rail)",
              page.evaluate("getComputedStyle(document.querySelector('#rightdock .rail-section.properties .panel-x')).display === 'none'"))
        # floating the Colour panel must KEEP it (was a disappearing bug: float left it !visible
        # so reconcile detached it from the DOM)
        page.evaluate("window.__docks.float('color')"); page.wait_for_timeout(60)
        check("floating Colour keeps it alive in a window (no vanish)",
              page.evaluate("window.__docks.loc('color')==='float' && !!document.querySelector('.dock-window[data-dock-window=\"color\"] .rail-section.color')"))
        # the × is hidden while floating too (re-dock by dragging the header)
        check("floating panels also hide the × (drag header to re-dock)",
              page.evaluate("getComputedStyle(document.querySelector('.dock-window[data-dock-window=\"color\"] .panel-x')).display === 'none'"))
        # detached section sheds its docked flex so it fills the window (no fixed-height gap/clip)
        check("a detached section fills its window (docked flex shed)",
              page.evaluate("document.querySelector('.dock-window[data-dock-window=\"color\"] .rail-section.color').style.flex === ''"))
        page.evaluate("window.__docks.dock('color','right')"); page.wait_for_timeout(40)
        page.evaluate("window.__docks.close('color'); window.__docks.dock('properties','right')"); page.wait_for_timeout(40)
        # fold BOTH side docks with the one toggle
        page.click('#rail-toggle'); page.wait_for_timeout(80)
        check("fold toggle hides both side docks",
              page.evaluate("window.__docks.isFolded() && getComputedStyle(document.querySelector('#rightdock')).display === 'none'"))
        page.click('#rail-toggle'); page.wait_for_timeout(80)
        check("unfold restores the docks",
              page.evaluate("!window.__docks.isFolded() && getComputedStyle(document.querySelector('#rightdock')).display !== 'none'"))
        # state persisted
        check("dock layout is persisted",
              page.evaluate("() => { const s=JSON.parse(localStorage.getItem('hector-vector:docks')||'{}'); return !!s.history && !!s.layers; }"))

        section("Manage screen: Library/Processor/Jobs are Manage citizens, NOT in the Edit dock")
        # The Manage screen A/Bs with the workbench. Library / Processor / Jobs are NOT Edit-dock
        # panels — they live permanently in the .manage-grid (moved there once at startup, marked
        # "away" so the dock won't reclaim them), and the Edit dock keeps only the editing panels.
        # The toggle just shows/hides the grid — no per-switch reparenting. See manage-screen-plan.
        check("Edit/Manage tabs exist; Edit active by default",
              page.evaluate("() => !!document.querySelector('#view-edit') && !!document.querySelector('#view-manage') && document.querySelector('#view-edit').classList.contains('active')"))
        parent = lambda sel: page.evaluate("(s) => { const e=document.querySelector(s); return e && e.parentElement ? (e.parentElement.id || e.parentElement.className) : null; }", sel)
        # In EDIT, the manage panels are NOT in the dock (they live hidden in the manage-grid) and
        # the Edit dock holds only editing panels (no library/processor/jobs leaking in).
        check("Library/Processor/Info/Jobs live in .manage-grid, not the Edit dock",
              all("manage-grid" in (parent(".rail-section." + n) or "") for n in ("library", "processor", "info", "jobs")))
        check("the Edit right-dock + header shelf have NO manage panels (only editing panels)",
              page.evaluate("() => [...document.querySelectorAll('#rightdock > .rail-section')].every(s => !['library','processor','info','jobs'].includes(s.dataset.section)) && !document.querySelector('#panel-shelf .shelf-sq[data-shelf=\"info\"]')"))
        check("docks marks them 'away' (exempt from dock reconcile / shelving)",
              page.evaluate("() => window.__docks.isAway('library') && window.__docks.isAway('processor') && window.__docks.isAway('info') && window.__docks.isAway('jobs')"))
        check("in Edit the manage-grid is hidden", page.evaluate("() => getComputedStyle(document.querySelector('.manage-grid')).display === 'none'"))
        # ENTER Manage → reveal the grid, hide the canvas; panels DON'T move (already there).
        page.click("#view-manage"); page.wait_for_function("() => document.querySelector('.app').classList.contains('manage')", timeout=4000)
        page.wait_for_timeout(60)
        check("Manage shows the grid + hides the editor-grid; panels stay put",
              page.evaluate("() => getComputedStyle(document.querySelector('.editor-grid')).display === 'none' && getComputedStyle(document.querySelector('.manage-grid')).display === 'grid'")
              and "manage-grid" in (parent(".rail-section.library") or ""))
        check("panel renderers still target their fixed IDs in the grid",
              page.evaluate("() => !!document.querySelector('.manage-grid #library-list') && (document.querySelector('#processor-body')||{}).childElementCount >= 0"))
        # LEAVE → canvas back, panels STAY in the grid (now hidden), never re-entering the dock.
        page.click("#view-edit"); page.wait_for_function("() => !document.querySelector('.app').classList.contains('manage')", timeout=4000)
        page.wait_for_timeout(60)
        check("back in Edit: editor-grid visible, manage panels still in the (hidden) grid — never leak into the dock",
              page.evaluate("() => document.querySelector('#view-edit').classList.contains('active') && getComputedStyle(document.querySelector('.editor-grid')).display !== 'none'")
              and "manage-grid" in (parent(".rail-section.library") or ""))
        # a second round-trip is stable
        page.click("#view-manage"); page.wait_for_timeout(60); page.click("#view-edit"); page.wait_for_timeout(60)
        check("Manage round-trip is stable (library stays a grid citizen)", "manage-grid" in (parent(".rail-section.library") or ""))

        section("Text: tool, inspector, multi-source fonts, convert-to-outlines (T1-T22)")
        # Deterministic, network-free coverage of the text feature. Creation via the overlay
        # editor needs real keyboard focus timing (flaky headless); instead we MOUNT a doc that
        # already contains <text> (the same adopt path a saved file takes) and exercise the
        # lifecycle off it. Live Google-Fonts fetch + outline conversion need network, so those
        # are checked at the API/UI-surface level here and end-to-end in the dev probes.
        TEXTDOC = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
                   '<rect class="hv-artboard" x="0" y="0" width="400" height="300" fill="#ffffff"/>'
                   '<text x="40" y="120" font-family="Helvetica, Arial, sans-serif" font-size="48" fill="#1d4ed8">Hello'
                   '<tspan x="40" dy="58">Vector</tspan></text></svg>')
        page.evaluate("svg => { app.selectedOutput=null; app.manualOutputName=null; mountStageFromText(svg,'text.svg'); }", TEXTDOC)
        settle(page, "() => !!editor.stage && !!editor.stage.querySelector('text')")
        # Each check is ATOMIC — re-select + mutate + assert inside ONE page.evaluate, guarding
        # nulls. Headless Chromium can momentarily report an SVG <text> absent across an evaluate
        # boundary right after a reflow-triggering mutation (synchronous + reliable in a real
        # browser); one synchronous call sidesteps that race.
        def t_check(label, body):
            settle(page, "() => !!editor.stage && !!editor.stage.querySelector('text')")   # text can read absent for a tick after a prior reflow
            check(label, page.evaluate("() => { const t=editor.stage.querySelector('text'); if(!t) return false;"
                                       " editor.selection=new Set([t.getAttribute('data-hv-id')]); editor.artboardSelected=false;" + body + " }") is True)
        check("text tool is registered (toolstrip + setTool)", page.evaluate(
            "() => { editor.setTool('text'); const ok = editor.tool==='text' && !!document.querySelector('.toolstrip [data-tool=text]'); editor.setTool('select'); return ok; }") is True)
        check("mounted <text> is adopted with a data-hv-id + layers label", page.evaluate(
            "() => { const t=editor.stage.querySelector('text'); return !!t && t.hasAttribute('data-hv-id') && editor.nodeName(t).startsWith('Hello'); }") is True)
        t_check("Properties panel builds a Text group with Font/Size/Align/Line rows",
            " const p=editor._objectPanel(editor.selectedNodes());"
            " const titles=[...p.querySelectorAll('.insp-title')].map(e=>e.textContent.trim());"
            " const labels=[...p.querySelectorAll('.insp-row > span')].map(s=>s.textContent.trim());"
            " return titles.includes('Text') && ['Font','Size','Align','Line'].every(l=>labels.includes(l));")
        t_check("font-size setter applies + reflows tspans",
            " editor.beginCoalesce(); editor._applyTextNum('font-size', 72, {reflow:true, styleKey:'fontSize'}); editor.commitCoalesce('Font size');"
            " const t2=editor.stage.querySelector('text'); return !!t2 && parseFloat(t2.getAttribute('font-size'))===72;")
        t_check("alignment setter applies (text-anchor)",
            " editor._setTextAttr('text-anchor','middle',{styleKey:'textAnchor',label:'Align'});"
            " const t2=editor.stage.querySelector('text'); return !!t2 && t2.getAttribute('text-anchor')==='middle';")
        t_check("fill applies to text (shared paint path, not raster)",
            " editor.applyFill('#ff0000'); const t2=editor.stage.querySelector('text'); return !!t2 && t2.getAttribute('fill')==='#ff0000' && !editor.isRaster(t2);")
        t_check("scaling text uses a transform matrix (not baked geometry)",
            " editor.setSelectionSize(300,null,true); const t2=editor.stage.querySelector('text'); return !!t2 && /matrix|scale/.test(t2.getAttribute('transform')||'');")
        t_check("the Text group exposes a Convert-to-outlines action",
            " const p=editor._objectPanel(editor.selectedNodes()); return [...p.querySelectorAll('button')].some(b=>/outline/i.test(b.textContent));")
        check("serialize round-trips <text> + <tspan>, strips data-hv-*", page.evaluate(
            "() => { const s=editor.serialize(); return s.includes('<text') && s.includes('<tspan') && !s.includes('data-hv-id') && !s.includes('data-hv-line-height'); }") is True)
        check("font registry + catalog search are wired (window.__fonts)", page.evaluate(
            "async () => { if(!window.__fonts) return false; const r=await window.__fonts.searchCatalog('mono'); return Array.isArray(r) && r.length>=3; }"))
        # Multi-source: the catalog always reports its providers (curated fallback even offline),
        # and results carry a source tag. Tolerant of network (curated Google families backfill).
        check("catalog is multi-source (reports providers + per-font source)", page.evaluate(
            "async () => { const r = await fetch('/api/fonts/catalog?q=mono').then(x=>x.json());"
            " return Array.isArray(r.sources) && r.sources.length>=1 && (r.fonts[0]? !!r.fonts[0].source : true); }"))
        # Browse default leads with recognisable popular families (not a wall of alphabetical "A"
        # fonts), and a query searches the FULL catalogue — 'garamond' isn't in the curated 36, so
        # finding it proves search reaches the whole 2000+ list, not just the visible page.
        check("font catalog: popular-first default + full-catalog search", page.evaluate(
            "async () => { try {"
            " const d = await fetch('/api/fonts/catalog?q=').then(x=>x.json());"
            " if(!d.fonts || !d.fonts.length) return true;"
            " const popFirst = ['Inter','Roboto','Open Sans','Lato','Montserrat'].includes(d.fonts[0].family);"
            " const g = await fetch('/api/fonts/catalog?q=garamond').then(x=>x.json());"
            " const deepHit = (g.fonts||[]).some(f=>/garamond/i.test(f.family));"
            " return popFirst && deepHit; } catch { return true; } }"))
        # Search isn't hard-capped at 60: a high limit returns ALL matches for a query, and the
        # limit is clamped server-side so a client can't ask for an unbounded render. Net-tolerant.
        check("font catalog honours limit (full-list search, clamped)", page.evaluate(
            "async () => { try {"
            " const a = await fetch('/api/fonts/catalog?q=sans&limit=500').then(x=>x.json());"
            " if(!a.fonts || !a.total) return true;"
            " const full = a.total <= 500 ? a.fonts.length === a.total : a.fonts.length >= 60;"
            " const c = await fetch('/api/fonts/catalog?q=&limit=99999').then(x=>x.json());"
            " return full && (c.fonts||[]).length <= 1000; } catch { return true; } }"))
        # Duplicating a text-on-path mints fresh REAL ids (not just data-hv-id) and rewires the
        # clone's <textPath> to the CLONE's path — no duplicate id, no cross-wiring to the original.
        check("cloning text-on-path re-ids real ids + rewires textPath", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg';"
            " const p=document.createElementNS(NS,'path'); p.setAttribute('data-hv-id','di_p'); p.setAttribute('d','M20 200 Q200 40 380 200'); p.setAttribute('fill','none');"
            " editor.stage.insertBefore(p, editor._overlayEl());"
            " const t=document.createElementNS(NS,'text'); t.setAttribute('data-hv-id','di_t'); t.setAttribute('x','20'); t.setAttribute('y','60'); t.textContent='Dup';"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor.selection=new Set(['di_t','di_p']); editor.artboardSelected=false; editor.putTextOnPath();"
            " editor.selection=new Set(['di_t','di_p']); const ids=editor._cloneSelection(10,10);"
            " const real=[...editor.stage.querySelectorAll('[id]')].map(n=>n.getAttribute('id'));"
            " const noDup = real.length===new Set(real).size;"
            " const cs=ids.map(i=>editor.stage.querySelector('[data-hv-id=\"'+i+'\"]'));"
            " const ct=cs.find(n=>n.tagName.toLowerCase()==='text'); const cp=cs.find(n=>n.tagName.toLowerCase()==='path');"
            " const tp=ct&&ct.querySelector(':scope > textPath');"
            " const wired = !!(cp&&tp&&tp.getAttribute('href')==='#'+cp.getAttribute('id'));"
            " [...editor.stage.querySelectorAll('[data-hv-id^=di_]')].forEach(n=>n.remove()); cs.forEach(n=>n&&n.remove()); editor.selection=new Set(); editor._renderSelection();"
            " return noDup && wired; }") is True)
        # Resizing text via the bbox handles keeps the scale (a matrix transform) instead of baking
        # it away — baking can't scale font-size, which snapped the text back to its original size.
        page.evaluate("() => { const NS='http://www.w3.org/2000/svg'; const t=document.createElementNS(NS,'text'); t.setAttribute('data-hv-id','rzt'); t.setAttribute('x','120'); t.setAttribute('y','120'); t.setAttribute('font-size','40'); t.setAttribute('font-family','sans-serif'); t.textContent='Resize'; editor.stage.insertBefore(t, editor._overlayEl()); editor.selection=new Set(['rzt']); editor.artboardSelected=false; editor.setTool('select'); editor.enterTransform('scale'); }")
        page.wait_for_timeout(120)
        _rb = page.evaluate("() => editor.stage.querySelector('[data-hv-id=rzt]').getBoundingClientRect().width")
        _hp = page.evaluate("() => { const h=document.querySelector('.hv-xform-handle.hv-xform-se'); if(!h) return null; const r=h.getBoundingClientRect(); return {cx:r.x+r.width/2, cy:r.y+r.height/2}; }")
        if _hp:
            page.mouse.move(_hp["cx"], _hp["cy"]); page.mouse.down(); page.mouse.move(_hp["cx"]+100, _hp["cy"]+100, steps=6); page.mouse.up()
            page.wait_for_timeout(120)
            _raw = page.evaluate("() => editor.stage.querySelector('[data-hv-id=rzt]').getBoundingClientRect().width")
            check("resizing text keeps its scale (no snap-back)", _raw > _rb * 1.3, f"{_rb}->{_raw}")
        page.evaluate("() => { const n=editor.stage.querySelector('[data-hv-id=rzt]'); if(n) n.remove(); editor._xformMode=null; editor.selection=new Set(); editor._renderSelection(); }")
        # text→vector is SHAPED (kerning + ligatures so it matches the rendered text) and emits
        # clean all-cubic geometry with a reported advance. Network-tolerant: passes if offline.
        check("text→outline is shaped, all-cubic, reports advance", page.evaluate(
            "async () => { try { const r = await fetch('/api/text-outline', {method:'POST',"
            " headers:{'Content-Type':'application/json'}, body: JSON.stringify({text:'AVA office',"
            " family:'Roboto', source:'fontsource', weight:400, fontSize:100, x:0, y:100})}).then(x=>x.json());"
            " return !!r.d && r.d.indexOf('Q')<0 && r.advance>0 && !!r.shaper; } catch { return true; } }"))
        # System fonts can't be downloaded, so convert outlines them with a free metric-compatible
        # OFL stand-in (Arial→Arimo) and REPORTS it; characters the font has no glyph for are
        # reported too (skipped, not silently dropped). Network-tolerant (offline → no d → passes).
        check("system fonts outline via a reported substitute; missing glyphs reported (#72/#74)", page.evaluate(
            "async () => { try {"
            " const a = await fetch('/api/text-outline',{method:'POST',headers:{'Content-Type':'application/json'},"
            "   body:JSON.stringify({text:'Arial here', family:'Arial', source:'', weight:400, fontSize:40})}).then(x=>x.json());"
            " const m = await fetch('/api/text-outline',{method:'POST',headers:{'Content-Type':'application/json'},"
            "   body:JSON.stringify({text:'hi ☃', family:'Roboto', source:'', weight:400, fontSize:40})}).then(x=>x.json());"
            " const subOk = !a.d || (typeof a.substituted==='string' && a.substituted.length>0);"
            " const missOk = !m.d || (Array.isArray(m.missing) && m.missing.indexOf('☃')>=0);"
            " return subOk && missOk; } catch { return true; } }"))
        # Complex scripts (Arabic/Indic/RTL): with uharfbuzz they shape correctly; without it the
        # server still emits a best-effort outline AND flags the script so the user is warned. The
        # invariant is that a complex script is NEVER silently wrong — it either shapes or warns.
        check("complex scripts either shape (harfbuzz) or warn (#73)", page.evaluate(
            "async () => { try { const r = await fetch('/api/text-outline',{method:'POST',headers:{'Content-Type':'application/json'},"
            "   body:JSON.stringify({text:'مرحبا', family:'Cairo', source:'google', weight:400, fontSize:40})}).then(x=>x.json());"
            " if(!r || r.error) return true;"          # offline/unresolved font → tolerate
            " const shaped = r.shaper==='harfbuzz' && !!r.d;"
            " const warned = !!r.complexScript;"
            " return shaped || warned; } catch { return true; } }"))
        # Reload hydration (#77): cached fonts carry their real family in a server manifest, so the
        # client re-registers them by family after a page reload (else the Installed list empties +
        # saved docs can't re-embed their fonts). Load a font, then hydrate from the cache and check
        # it appears in the registry by family. Network-tolerant (offline load → no url → passes).
        check("cached fonts re-hydrate into the registry by family (#77)", page.evaluate(
            "async () => { try {"
            " const load = await fetch('/api/fonts/load',{method:'POST',headers:{'Content-Type':'application/json'},"
            "   body:JSON.stringify({family:'Lobster', weight:400, italic:false, source:'google'})}).then(x=>x.json());"
            " if(!load || !load.url) return true;"          # couldn't download (offline) → tolerate
            " await window.__fonts.hydrateInstalled();"
            " return window.__fonts.installedFamilies().some(f=>f.family==='Lobster'); } catch { return true; } }"))
        # Export fidelity (#80): saved SVG + PNG embed the USED web fonts as base64 @font-face so
        # they render off-machine; system fonts are NOT embedded (the OS supplies them, and the
        # isolated export <img> renders them natively). Network-tolerant (offline load → passes).
        check("save embeds used web fonts as base64, skips system fonts (#80)", page.evaluate(
            "async () => { try {"
            " await window.__fonts.loadWebFont('Lobster',400,false,'google');"
            " const web = await window.__fonts.embedFontFaceCSS('<svg><text font-family=\"Lobster, cursive\">hi</text></svg>');"
            " const sys = await window.__fonts.embedFontFaceCSS('<svg><text font-family=\"Arial\">hi</text></svg>');"
            " const webOk = !web || (/@font-face/.test(web) && /base64,/.test(web));"
            " return webOk && sys===''; } catch { return true; } }"))
        t_check("font browser opens with source-filter chips + Installed/badge UI",
            " const p=editor._objectPanel(editor.selectedNodes()); document.body.appendChild(p); const btn=p.querySelector('.font-pick'); if(!btn){p.remove();return false;} btn.click();"
            " const pop=document.querySelector('.font-browser'); const chips=pop?pop.querySelectorAll('.font-chip').length:0;"
            " if(window.__fonts) window.__fonts.closeFontBrowser(); p.remove(); return !!pop && chips>=4;")
        # Offline degradation (#78): with the catalogue endpoint unreachable, the font browser must
        # still show Installed + System and say sources are unreachable — never a bare empty list
        # or an uncaught rejection. Block the route, open the browser, inspect, then unblock.
        page.route("**/api/fonts/catalog**", lambda r: r.abort())
        page.evaluate("() => window.__fonts.openFontBrowser(null,'',()=>{})")
        page.wait_for_timeout(350)
        _off = page.evaluate(
            "() => { const p=document.querySelector('.font-browser'); if(!p) return {};"
            " const secs=[...p.querySelectorAll('.font-sec')].map(s=>s.textContent);"
            " const hint=[...p.querySelectorAll('.font-empty')].some(e=>/unreachable/.test(e.textContent));"
            " const rows=p.querySelectorAll('.font-row').length;"
            " window.__fonts.closeFontBrowser(); return { sys: secs.includes('System'), hint, rows }; }")
        check("font browser degrades gracefully when sources are offline (#78)",
              bool(_off.get("sys") and _off.get("hint") and _off.get("rows", 0) > 0), f"{_off}")
        page.unroute("**/api/fonts/catalog**")
        # Installed/Web dedup: a downloaded family shows ONCE (under Installed), not again in the
        # Web list below. Network-tolerant (offline load → no installed family → trivially passes).
        check("font browser dedupes Installed vs Web (one row per family)", page.evaluate(
            "async () => { try {"
            " await window.__fonts.loadWebFont('Lobster',400,false,'google');"
            " window.__fonts.openFontBrowser(null,'',()=>{});"
            " const pop=document.querySelector('.font-browser'); const input=pop.querySelector('.font-search');"
            " input.value='lobster'; input.dispatchEvent(new Event('input'));"
            " await new Promise(r=>setTimeout(r,600));"
            " const names=[...pop.querySelectorAll('.font-row-name')].map(n=>n.textContent);"
            " window.__fonts.closeFontBrowser();"
            " return names.filter(n=>n==='Lobster').length <= 1; } catch { return true; } }"))
        # T10 area/box text: _writeAreaContent word-wraps to the box width (deterministic, no
        # network — measured with the loaded system font). The temp node is removed after.
        check("area text word-wraps to the box width (T10)", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg'; const t=document.createElementNS(NS,'text');"
            " t.setAttribute('data-hv-id','area'); t.setAttribute('x','20'); t.setAttribute('y','40');"
            " t.setAttribute('font-family','Arial, sans-serif'); t.setAttribute('font-size','20'); t.setAttribute('data-hv-text-width','160');"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor._writeAreaContent(t, 'The quick brown fox jumps over the lazy dog again and again');"
            " const lines = t.querySelectorAll('tspan').length;"
            " const fits = [...t.querySelectorAll('tspan')].every(s=>{ try { return s.getComputedTextLength() <= 163; } catch { return true; } });"
            " const ok = lines>=3 && fits; t.remove(); return ok; }") is True)
        # Area-text wrap fidelity: a single overlong token (no spaces) must CHAR-BREAK to fit the
        # box width — mirroring the overlay's overflow-wrap:break-word — instead of overflowing on
        # commit. Without the break-word path it'd be one long tspan far wider than the box.
        check("area text char-breaks an overlong token (break-word parity)", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg'; const t=document.createElementNS(NS,'text');"
            " t.setAttribute('data-hv-id','areabw'); t.setAttribute('x','20'); t.setAttribute('y','40');"
            " t.setAttribute('font-family','Arial, sans-serif'); t.setAttribute('font-size','20'); t.setAttribute('data-hv-text-width','120');"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor._writeAreaContent(t, 'supercalifragilisticexpialidocious_AND_then_some_more_letters');"
            " const sp=[...t.querySelectorAll('tspan')]; const lines=sp.length;"
            " const fits = sp.every(s=>{ try { return s.getComputedTextLength() <= 123; } catch { return true; } });"
            " const ok = lines>=2 && fits; t.remove(); return ok; }") is True)
        # T10+ bounded area-text frame (#75): the box stores a height; when the wrapped text is
        # taller than the box it's flagged (data-hv-overflow) and the inspector grows a Height row
        # plus an overflow note; enlarging the height clears it. Deterministic (system-font measure).
        check("area-text box tracks height + flags/clears overflow (#75)", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg'; const t=document.createElementNS(NS,'text');"
            " t.setAttribute('data-hv-id','ah2'); t.setAttribute('x','20'); t.setAttribute('y','40');"
            " t.setAttribute('font-family','Arial, sans-serif'); t.setAttribute('font-size','20');"
            " t.setAttribute('data-hv-text-width','160'); t.setAttribute('data-hv-text-height','45');"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor._writeAreaContent(t, 'The quick brown fox jumps over the lazy dog again and again');"
            " const over = t.getAttribute('data-hv-overflow')==='1';"
            " editor.selection=new Set(['ah2']); editor.artboardSelected=false;"
            " const p=editor._objectPanel(editor.selectedNodes());"
            " const hasH=[...p.querySelectorAll('.insp-row > span')].some(s=>s.textContent==='Height');"
            " const note=!!p.querySelector('.insp-note-warn');"
            " editor._setAreaHeight(400); const cleared=t.getAttribute('data-hv-overflow')!=='1';"
            " const ok=over && hasH && note && cleared;"
            " t.remove(); editor.selection=new Set(); editor._renderSelection(); return ok; }") is True)
        # T19 text-on-path: bind a text to a path → a <textPath href="#pathId"> that lays out
        # along the curve; the path gains a referencable id. Self-contained.
        check("text-on-path binds text to a path via <textPath> (T19)", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg';"
            " const path=document.createElementNS(NS,'path'); path.setAttribute('data-hv-id','op_p'); path.setAttribute('d','M20 200 Q200 40 380 200'); path.setAttribute('fill','none'); path.setAttribute('stroke','#ccc');"
            " editor.stage.insertBefore(path, editor._overlayEl());"
            " const t=document.createElementNS(NS,'text'); t.setAttribute('data-hv-id','op_t'); t.setAttribute('x','20'); t.setAttribute('y','60'); t.setAttribute('font-size','30'); t.textContent='On a path';"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor.selection=new Set(['op_t','op_p']); editor.artboardSelected=false; editor.putTextOnPath();"
            " const tp=editor.stage.querySelector('text > textPath'); const pid=editor.stage.querySelector('path[data-hv-id=op_p]').getAttribute('id');"
            " const ok = !!tp && !!pid && tp.getAttribute('href')==='#'+pid && /On a path/.test(tp.textContent||'');"
            " editor.selection=new Set(['op_t']); editor.detachTextFromPath(); t.remove(); path.remove(); return ok; }") is True)
        # T19/T23 text-on-path → outlines: the former hard-block is gone. Converting on-path text
        # lays each glyph along the curve (origin on the path, rotated to the tangent at its
        # mid-advance) and bakes them into ONE editable all-cubic path whose bbox rides the arch
        # — much taller than a flat baseline (~96px vs ~24px) and lifted up off y=200. Needs the
        # font server to outline, so it's network-tolerant: offline leaves the text bound (passes).
        check("text-on-path converts to curve-following outlines (T19/T23)", page.evaluate(
            "async () => { try { const NS='http://www.w3.org/2000/svg';"
            " const path=document.createElementNS(NS,'path'); path.setAttribute('data-hv-id','cp_p'); path.setAttribute('d','M20 200 Q200 40 380 200'); path.setAttribute('fill','none');"
            " editor.stage.insertBefore(path, editor._overlayEl());"
            " const t=document.createElementNS(NS,'text'); t.setAttribute('data-hv-id','cp_t'); t.setAttribute('x','20'); t.setAttribute('y','60'); t.setAttribute('font-size','34'); t.setAttribute('font-family','Roboto'); t.textContent='Curving text';"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor.selection=new Set(['cp_t','cp_p']); editor.artboardSelected=false; editor.putTextOnPath();"
            " editor.selection=new Set(['cp_t']); await editor.convertSelectedTextToOutlines();"
            " const np=editor.stage.querySelector('path[data-hv-id=cp_t]'); const stillText=!!editor.stage.querySelector('text[data-hv-id=cp_t]');"
            " let ok=true;"   # network-tolerant: offline can't outline → leaves it bound, don't fail
            " if(np && !stillText){ const d=np.getAttribute('d')||''; const bb=np.getBBox();"
            "   ok = /C/.test(d) && d.indexOf('Q')<0 && bb.height>55 && bb.y<150 && bb.width>80; }"
            " editor.selection=new Set(); [...editor.stage.querySelectorAll('[data-hv-id^=cp_]')].forEach(n=>n.remove()); editor._renderSelection();"
            " return ok; } catch(e){ return true; } }") is True)
        # #76 live curved preview: while editing on-path text the <textPath> stays VISIBLE (not
        # hidden behind the overlay) and re-renders each keystroke; the overlay is a transparent
        # caret. Typing updates the bound run live, and commit persists it. Self-contained.
        check("editing text-on-path previews the curve live (#76)", page.evaluate(
            "() => { const NS='http://www.w3.org/2000/svg';"
            " const path=document.createElementNS(NS,'path'); path.setAttribute('data-hv-id','lp_p'); path.setAttribute('d','M20 200 Q200 40 380 200'); path.setAttribute('fill','none');"
            " editor.stage.insertBefore(path, editor._overlayEl());"
            " const t=document.createElementNS(NS,'text'); t.setAttribute('data-hv-id','lp_t'); t.setAttribute('x','20'); t.setAttribute('y','60'); t.setAttribute('font-size','30'); t.textContent='Old';"
            " editor.stage.insertBefore(t, editor._overlayEl());"
            " editor.selection=new Set(['lp_t','lp_p']); editor.artboardSelected=false; editor.putTextOnPath();"
            " editor.setTool('text'); editor._editText(t, false);"
            " const visible=!t.classList.contains('hv-text-editing'); const ov=editor._textEdit && editor._textEdit.el;"
            " ov.textContent='Live curve'; editor._onTextInput();"
            " const tp=t.querySelector(':scope > textPath'); const live=(tp.textContent||'')==='Live curve'; const caretOnly=ov.style.color==='transparent';"
            " editor._commitText(); const committed=(t.querySelector(':scope > textPath')||{}).textContent==='Live curve';"
            " const ok=visible && live && caretOnly && committed;"
            " t.remove(); path.remove(); editor.selection=new Set(); editor._renderSelection(); return ok; }") is True)
        page.evaluate("() => { editor.selection=new Set(); editor.artboardSelected=false; editor._renderSelection(); }")

        section("App-window mode (standalone Chromium window)")
        # Headless can't exercise WCO/AWC, but the ?app=1 gate must engage and make
        # the header a draggable titlebar without disturbing normal layout. Window
        # controls are left to the native window manager (no custom buttons).
        page.goto(BASE + "/?app=1", wait_until="networkidle")
        page.wait_for_function("typeof editor !== 'undefined'")
        page.wait_for_timeout(80)
        check("app=1 adds .app-window", page.evaluate("document.querySelector('.app.editor').classList.contains('app-window')") is True)
        check("header becomes a drag region", page.evaluate("getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region')") == "drag")
        check("no custom window controls (native WM only)", page.evaluate("!document.querySelector('#window-controls') && !document.querySelector('.win-button')") is True)
        # normal browser load must NOT engage app-window mode
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_function("typeof editor !== 'undefined'")
        check("normal load stays windowed", page.evaluate("!document.querySelector('.app.editor').classList.contains('app-window') && getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region') !== 'drag'") is True)

        browser.close()

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print(f"\n{'='*48}\n{len(results)-n_fail}/{len(results)} checks passed")
    if n_fail:
        print("FAILURES:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}: {detail}")
    return 1 if n_fail else 0

if __name__ == "__main__":
    # Crash net (#38): if a section throws/stalls (e.g. a stuck click) it used to abort the
    # run with a bare traceback and NO tally — you couldn't see how far it got or which
    # section died. Catch it here, name the offending section, and print the partial tally.
    try:
        _rc = main()
    except Exception as _e:
        import traceback
        _nf = sum(1 for _, ok, _ in results if not ok)
        print(f"\n{'='*48}\n!! RUN ABORTED in section: {_CUR_SECTION}\n   {type(_e).__name__}: {_e}")
        print(f"   {len(results)-_nf}/{len(results)} checks passed before the abort")
        traceback.print_exc()
        _rc = 2
    sys.exit(_rc)
