#!/usr/bin/env python3
"""End-to-end stress test for the vector editor, driven through a real browser.

Uses Playwright to issue genuine pointer + keyboard input (so the
pointer -> getScreenCTM -> selection/move pipeline is exercised for real, not
faked via dispatchEvent) and reads back live `editor` state to assert outcomes.

Run:  .venv-e2e/bin/python tests/e2e/editor_e2e.py [base_url]
Needs the app running (default http://localhost:2002).
"""
from __future__ import annotations
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:2002"

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
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail and not ok else ""))

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
    page.wait_for_function("editor.stage && editor.nodeById('r2')", timeout=8000)
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
    page.wait_for_timeout(360)   # let the coalesced "Colour" undo entry commit (debounce)
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
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_function("typeof editor!=='undefined' && typeof mountStageFromText==='function'", timeout=20000)
        # The live library may auto-load a PNG (no editable stage). Guarantee a stage
        # so the suite doesn't depend on what's in the outputs dir.
        page.wait_for_timeout(500)
        # Default startup (prefs.startup === "blank"): a fresh canvas mounts and the
        # Process workspace opens over it.
        boot = page.evaluate("""() => ({
            stage: !!editor.stage,
            modal: !document.querySelector('#modal-root').hidden,
            title: document.querySelector('#modal-title').textContent,
        })""")
        check("startup mounts a blank canvas + opens Process",
              boot["stage"] and boot["modal"] and "Process" in boot["title"], str(boot))
        # dismiss the modal so it doesn't intercept the suite's clicks.
        if page.evaluate("!document.querySelector('#modal-root').hidden"):
            page.keyboard.press("Escape"); page.wait_for_timeout(150)
        if not page.evaluate("!!editor.stage"):
            mount_ctl(page)

        # ---- A. Save on the auto-loaded (library) document ----
        big_nodes = page.evaluate("editor.stage.querySelectorAll('[data-hv-id]').length")
        has_output = page.evaluate("!!window.app.selectedOutput")
        if has_output:
            file_menu_click(page, "Save")
            page.wait_for_function("/Saved|Save failed/.test(document.querySelector('#status-text').textContent)", timeout=8000)
            status = page.eval_on_selector("#status-text", "e => e.textContent")
            check("save library doc", "Saved" in status, status)
        else:
            check("save library doc (skipped, no selectedOutput)", True)

        # ---- B. Node tool on a large doc refuses to mount thousands of handles ----
        page.evaluate("editor.setTool('node')")
        page.wait_for_timeout(120)
        handles = page.evaluate("editor._overlayEl().querySelectorAll('.hv-handle').length")
        big_anchor_guard = (big_nodes < 400) or (handles == 0)  # huge docs must NOT spray handles
        check("node tool guards huge docs", big_anchor_guard, f"nodes={big_nodes} handles={handles}")
        page.evaluate("editor.setTool('select')")

        # ---- C. Controlled 3-rect document for precise interaction tests ----
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

        # ---- Colour panel: RGB/HSL/HSB model tabs + recent-colours strip ----
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
        page.wait_for_timeout(820)   # past the recents debounce
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
        page.wait_for_timeout(320); page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)

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

        # inspector: stroke cap (segmented control) + dashes (r1 has a stroke now)
        open_ctx_panel(page)
        seg_active = page.evaluate("""() => { const seg = document.querySelectorAll('.context-panel .insp-seg')[0];
            const btn = [...seg.querySelectorAll('.insp-seg-btn')].find(b => b.title === 'Round'); btn.click();
            const a = seg.querySelector('.insp-seg-btn.active'); return a && a.title; }""")
        page.wait_for_timeout(40)
        check("stroke cap via segmented control", page.evaluate("editor.nodeById('r1').getAttribute('stroke-linecap')") == "round")
        # the segmented control updates its OWN active highlight (the 'unresponsive panel' fix)
        check("segmented control reflects the active option", seg_active == "Round", f"active={seg_active}")
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

        # ---- D. Stress: zoom+pan drag accuracy, multi-move, none-toggles, undo consistency ----
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

        # ---- E. Phase 2: invert-space, duplicate, z-order ----
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

        # ---- F. Process workspace + rail collapse doesn't break the stage ----
        page.click("#process-button"); page.wait_for_timeout(150)
        ws = page.evaluate("""() => ({
            open: !document.querySelector('#modal-root').hidden,
            gallery: !!document.querySelector('#process-gallery'),
            jobs: !!document.querySelector('#process-jobs'),
            run: [...document.querySelectorAll('.process-controls .primary-button')].some(b => /Run/.test(b.textContent)),
        })""")
        check("Process workspace opens with gallery + jobs + run", ws["open"] and ws["gallery"] and ws["jobs"] and ws["run"], str(ws))
        # rescued Browse: the gallery head carries a filter box (+ per-item actions)
        check("Process gallery has a filter box (rescued Browse)",
              page.evaluate("!!document.querySelector('#process-gallery .process-filter')"))
        # processing defaults to Single
        mode_default = page.evaluate("document.querySelector('#mode-select').value")
        check("processing defaults to Single", mode_default == "single", mode_default)
        page.evaluate("closeModal()")
        # footer Jobs button removed (redundant with header Process…)
        check("footer Jobs button removed", page.evaluate("!document.querySelector('#jobs-button')"))
        # 'q' opens the workspace instead
        page.keyboard.press("q"); page.wait_for_timeout(120)
        check("q opens the workspace", page.evaluate("!!document.querySelector('#process-jobs')"))
        page.evaluate("closeModal()")
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
        })""")
        check("Settings modal has prefs + install + about",
              settings["title"] == "Settings" and settings["toggles"] >= 1 and settings["startup"] and settings["about"] and settings["install"], str(settings))
        # changing the startup choice persists to localStorage
        page.evaluate("""() => { const s = document.querySelector('#modal-body select');
            s.value = 'resume'; s.dispatchEvent(new Event('change', { bubbles: true })); }""")
        check("settings startup choice persists", page.evaluate("JSON.parse(localStorage.getItem('hector-vector:prefs')).startup") == "resume")
        page.evaluate("""() => { localStorage.setItem('hector-vector:prefs', JSON.stringify({startup:'blank', smartGuides:true})); closeModal(); }""")
        # Edit/Process view-swap sits on the right; Process is the right-most, icon-only.
        swap = page.evaluate("""() => {
            const h=document.querySelector('.editor-bar').getBoundingClientRect();
            const e=document.querySelector('#view-edit'), p=document.querySelector('#process-button');
            const pr=p.getBoundingClientRect();
            return {
              pair: !!e && !!p && !!document.querySelector('.view-swap #process-button'),
              right: pr.right > h.left + (h.width*0.6),         // process lives on the right half
              order: e.getBoundingClientRect().left < pr.left,  // Edit before Process
              iconOnly: p.textContent.replace(/\\d+/g,'').trim() === '▦',  // no "Process…" text (count badge digits stripped)
            };
        }""")
        check("Edit/Process view-swap is right-aligned & icon-only",
              swap["pair"] and swap["right"] and swap["order"] and swap["iconOnly"], str(swap))
        # the swap reflects the active view: opening Process activates it, Edit deactivates
        page.click("#process-button"); page.wait_for_timeout(120)
        active_proc = page.evaluate("document.querySelector('#process-button').classList.contains('active') && !document.querySelector('#view-edit').classList.contains('active')")
        page.click("#view-edit"); page.wait_for_timeout(120)
        active_edit = page.evaluate("document.querySelector('#view-edit').classList.contains('active') && !document.querySelector('#process-button').classList.contains('active') && document.querySelector('#modal-root').hidden")
        check("view-swap reflects + toggles the active view", active_proc and active_edit)
        # undo/redo moved into the History panel header (and out of the viewport controls)
        check("undo/redo sit in the History header",
              page.evaluate("""!!document.querySelector('.rail-section.history .panel-actions #undo-button')
                && !!document.querySelector('.rail-section.history .panel-actions #redo-button')
                && !document.querySelector('.viewport-controls #undo-button')"""))
        # top arrange bar carries reorder + group/ungroup + rename/delete; cleanup/merge moved to the Layers header
        check("top stage toolbar carries reorder / group / delete",
              page.evaluate("""['layer-front','layer-forward','layer-backward','layer-back','layer-group','layer-ungroup','layer-rename','layer-delete']
                .every(id => !!document.querySelector('.stage-toolbar #' + id))
                && !document.querySelector('.stage-toolbar #layer-cleanup')
                && ['layer-cleanup','layer-merge'].every(id => !!document.querySelector('.rail-section.layers .section-head #' + id))
                && !document.querySelector('.rail-section.layers .menu')"""))
        # object clipboard/boolean/transform actions live on the right-side action bar (delete/rename
        # moved to Layers; invert-space relocated to the Object panel header)
        check("object action bar carries clipboard + transform",
              page.evaluate("""['act-cut','act-copy','act-paste','act-duplicate','act-union','act-rotate-cw','act-flip-h']
                .every(id => !!document.querySelector('.actionbar #' + id))
                && !document.querySelector('.actionbar #act-delete') && !document.querySelector('.actionbar #act-invert')"""))
        # the panel headers carry a default action tile: Object → invert-space, Colour → cycle-bg,
        # and the header action area is a registered customize-layout receiver
        check("Object panel header has the invert-space tile",
              page.evaluate("""() => { const b = document.querySelector('.rail-section.properties .section-head #hdr-invert'); return !!b && /invert/i.test(b.title); }"""))
        page.evaluate("window.__docks.showColor()"); page.wait_for_timeout(60)
        check("Colour panel header has the cycle-background tile",
              page.evaluate("""() => { const b = document.querySelector('.rail-section.color .section-head #hdr-bg'); return !!b && /background/i.test(b.title); }"""))
        check("panel header action areas are layout-bar receivers",
              page.evaluate("!!document.querySelector('.rail-section.color .panel-actions.hdr-slots.layout-bar')"))
        page.evaluate("window.__docks.close('color')"); page.wait_for_timeout(40)
        # the cycle-bg control left the viewport bar
        check("cycle-background no longer in the viewport bar",
              page.evaluate("!document.querySelector('.viewport-controls [data-action=\"bg\"]')"))

        # --- customizable picture-frame layout (Layout header dropdown; auto-save + profiles) ---
        # all four bars share the one .tool-button object so they match
        check("every frame bar uses the shared .tool-button class",
              page.evaluate("""['.toolstrip','.stage-toolbar','.actionbar','.viewport-controls']
                .every(s => document.querySelectorAll(s + ' .tool-button').length > 0)
                && !document.querySelector('.vp-btn')"""))
        # the Layout control is a header dropdown next to File (not footer buttons)
        check("Layout is a header dropdown next to File",
              page.evaluate("""!!document.querySelector('.doc-actions-left .menu[data-menu="layout"]')
                && !document.querySelector('#layout-save') && !document.querySelector('#layout-edit')"""))
        # customize mode (via the exposed controller) makes frame tiles draggable
        page.evaluate("window.__layout.toggleEdit()")
        check("customize mode makes frame tiles draggable",
              page.evaluate("""!!document.querySelector('.app.editor.customizing')
                && document.querySelector('.toolstrip .tool-button').draggable === true"""))
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
        # the Layout dropdown renders each profile as a manageable row (rename ✎ / delete ✕)
        check("Layout dropdown shows rename/delete on a profile row",
              page.evaluate("""() => { window.__layout.saveProfile('Row');
                document.querySelector('.menu[data-menu=layout] .menu-trigger').click();
                const rows=[...document.querySelectorAll('.menu[data-menu=layout] .menu-row')];
                const ok = rows.some(r => r.querySelector('.menu-rowlabel') && r.querySelectorAll('.menu-rowbtn').length===2);
                document.body.click(); window.__layout.deleteProfile('Row'); return ok; }"""))
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
        # the dropdown reflects state: active row checked + an "edited" badge
        page.evaluate("document.querySelector('.menu[data-menu=layout] .menu-trigger').click()")
        check("dropdown shows the active profile checked with an edited badge",
              page.evaluate("""() => { const rows=[...document.querySelectorAll('.menu[data-menu=layout] .menu-row')];
                const r = rows.find(r => /StateP/.test(r.textContent));
                const checked = !!r && r.querySelector('.menu-rowlabel.checked') && r.querySelector('.menu-check').textContent.trim()==='✓';
                const badge = !!r && !!r.querySelector('.menu-badge');
                const upd = [...document.querySelectorAll('.menu[data-menu=layout] .menu-item')].some(i=>/Update/.test(i.textContent));
                return checked && badge && upd; }"""))
        page.evaluate("document.body.click()")
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

        # ---- G. Phase 3: layers panel ----
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

        # ---- drag layers in/out of groups, selection normalization, header counts, mixed inspector ----
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

        # ---- redesigned Object panel: Transform / Shape / Stroke / Appearance + align chin ----
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

        # ---- H. Polish pass: handle scaling, panel collapse, modal width, swatch, flatten ----
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

        # ---- Phase 4: shape tools ----
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

        # ---- parametric "live shapes": rect/poly/star/ellipse as paths + Shape panel ----
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
        page.evaluate("editor.setTool('select')")

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

        # ---- Phase 4: pen tool ----
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

        # ---- Phase 4: boolean ops (point-membership on the result path) ----
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

        # ---- Layers cleanup: drop ghost/empty nodes, keep valid ones ----
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

        # ---- Merge same-colour layers (consolidate trace output) ----
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

        # ---- Place / merge a vector INTO the current canvas (not replace) ----
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

        # ---- Artboard navigation: Shift+O selects it, spacebar pans ----
        page.evaluate("editor.selection=new Set(); editor.artboardSelected=false; editor._renderSelection(); if(document.activeElement?.blur) document.activeElement.blur();")
        page.keyboard.press("Shift+O"); page.wait_for_timeout(40)
        check("Shift+O selects the artboard", page.evaluate("editor.artboardSelected === true"))
        page.keyboard.down("Space"); page.wait_for_timeout(30)
        check("spacebar engages pan mode", page.evaluate("editor._spacePan === true && document.querySelector('.stage-wrap').classList.contains('space-pan')"))
        page.keyboard.up("Space"); page.wait_for_timeout(30)
        check("releasing space ends pan mode", page.evaluate("!editor._spacePan && !document.querySelector('.stage-wrap').classList.contains('space-pan')"))

        # ---- Phase 4: contextual transforms (rotate / flip) ----
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

        # ---- Command layer: clipboard, select-all, nudge, context menu ----
        mount_ctl(page)
        page.evaluate("editor.selection=new Set(['r1']); editor.copy(); editor.paste();")
        check("copy + paste adds a selected object", n_nodes(page) == 4 and page.evaluate("editor.selection.size") == 1)
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

        # ---- nested layers tree: group → indented children with ids; collapse hides them ----
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

        # ---- node-edit focus: a selection limits visible anchors; nothing selected shows all ----
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

        # ---- group right-click registers its objects ("N objects") and recolours them all ----
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

        # ---- transparent artboard shows a checker (not solid white) ----
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

        # ---- Process workspace: backends as first-class inline options ----
        page.evaluate("processSelectEl.value='pipeline';")
        page.click("#process-button"); page.wait_for_timeout(150)
        opt_labels = page.evaluate("() => [...document.querySelectorAll('.process-opts .process-opt>span')].map(s=>s.textContent)")
        check("pipeline surfaces backend options inline", all(x in opt_labels for x in ["Model", "Scale", "Trace", "Curves", "Cutout"]), str(opt_labels))
        # an inline option drives settings directly
        page.evaluate("""() => { const s=[...document.querySelectorAll('.process-opts select')].find(x=>x.options[0].value==='spline'); s.value='polygon'; s.dispatchEvent(new Event('change')); }""")
        check("inline backend option updates settings", page.evaluate("settings.trace_mode") == "polygon")
        # AI cutout reveals the model picker and re-renders the workspace (not the Settings modal)
        page.evaluate("settings.cutout_backend='ai'; renderProcessWorkspace();"); page.wait_for_timeout(60)
        ws_labels = page.evaluate("() => [...document.querySelectorAll('.process-opts .process-opt>span')].map(s=>s.textContent)")
        check("AI cutout reveals model picker in-place", page.evaluate("!!document.querySelector('.process-workspace')") and "AI model" in ws_labels, str(ws_labels))
        page.evaluate("settings.cutout_backend='classical';")
        # switching pipeline narrows the options
        page.evaluate("processSelectEl.value='upscale'; renderProcessWorkspace();"); page.wait_for_timeout(60)
        up_labels = page.evaluate("() => [...document.querySelectorAll('.process-opts .process-opt>span')].map(s=>s.textContent)")
        check("switching pipeline updates the options", up_labels == ["Model", "Scale"], str(up_labels))
        # gallery polish: no horizontal overflow, square thumbs, compact icon actions that fit the cell
        page.evaluate("processSelectEl.value='pipeline'; renderProcessWorkspace();"); page.wait_for_timeout(80)
        poly = page.evaluate("""() => {
          const body=document.querySelector('.modal-body');
          const cell=document.querySelector('.gallery-cell');
          if(!cell) return {skip:true};
          const t=document.querySelector('.gallery-thumb').getBoundingClientRect();
          const a=document.querySelector('.gallery-actions');
          const ab=a.getBoundingClientRect(), cb=cell.getBoundingClientRect();
          return { overflowX: body.scrollWidth-body.clientWidth, square: Math.abs(t.width-t.height)<2,
                   contain: getComputedStyle(document.querySelector('.gallery-thumb img')).objectFit,
                   icons: a.children.length, fit: ab.right<=cb.right+0.5 && ab.left>=cb.left-0.5 };
        }""")
        check("process gallery: no overflow, square thumbs, icon actions fit",
              poly.get("skip") or (poly["overflowX"] <= 0 and poly["square"] and poly["contain"] == "contain" and poly["icons"] >= 1 and poly["fit"]), str(poly))
        page.evaluate("closeModal(); processSelectEl.value='pipeline';")

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

        # ---- Save-As: a new/opened canvas (no selectedOutput) can be saved ----
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

        # ---- File surface: version, file menu items, download, open-from-disk, export routing ----
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

        # Export on an unsaved canvas routes through Save-As (no dead-end toast)
        page.evaluate("""() => { app.selectedOutput=null; app.manualOutputName=null;
            mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect data-hv-id="rx" x="5" y="5" width="30" height="30" fill="#c33"/></svg>','export-probe.svg'); }""")
        page.evaluate("window.app.exportFlow()")
        page.wait_for_function("!document.querySelector('#modal-root').hidden && document.querySelector('#modal-title').textContent === 'Save as'", timeout=4000)
        check("Export on unsaved canvas opens Save-As (no dead end)",
              page.evaluate("document.querySelector('#modal-title').textContent") == "Save as")
        page.evaluate("closeModal()")

        # ---- Node tool under a transformed/grouped ancestor (anchors map through the CTM) ----
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

        # ---- Ruler guides: persistent, editable when unlocked, view tied to rulers ----
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

        # ---- Customize layout: draggable dividers + right-click add/remove ----
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
        # 3-tile cap on panel headers: header now has hdr-invert + act-union (2); fill to 3, the 4th is refused
        capped = page.evaluate("""() => {
            const hdr = document.querySelector('.rail-section.properties .panel-actions');
            const drop = (id) => { const tile = document.querySelector('.actionbar #'+id); if (!tile) return;
              const dt = new DataTransfer(); tile.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
              const r = hdr.getBoundingClientRect();
              hdr.dispatchEvent(new DragEvent('dragover',{bubbles:true,clientX:Math.round(r.right-4),clientY:Math.round(r.top+r.height/2),dataTransfer:dt}));
              hdr.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
              tile.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt})); };
            drop('act-cut');   // -> 3 tiles (at cap)
            drop('act-copy');  // -> refused (would be 4)
            const tiles = [...hdr.children].filter(c => c.classList.contains('tool-button') && !c.classList.contains('panel-x'));
            return { n: tiles.length, copyIn: !!hdr.querySelector('#act-copy') }; }""")
        check("panel header is capped at 3 action tiles", capped["n"] == 3 and capped["copyIn"] is False, str(capped))
        page.evaluate("window.__layout.toggleEdit(); window.__layout.reset()"); page.wait_for_timeout(60)
        check("Reset returns the moved tile to the action bar",
              page.evaluate("!!document.querySelector('.actionbar #act-union') && !document.querySelector('.rail-section.properties #act-union')"))

        # ---- Dockable panels: float, dock left/right, reorder, fold, Properties ----
        check("docking controller is exposed", page.evaluate("!!window.__docks") is True)
        # leftdock is the leftmost grid child (before the toolstrip)
        check("left dock is the leftmost column",
              page.evaluate("() => document.querySelector('.editor-grid').firstElementChild.id === 'leftdock'"))
        # Properties + Colour default docked-right (permanent panels); float them out so the
        # History/Layers checks below see a clean right dock.
        page.evaluate("window.__docks.float('properties'); window.__docks.float('color')"); page.wait_for_timeout(60)
        # float History (no detach button — controller / header-drag does it)
        page.evaluate("window.__docks.float('history')"); page.wait_for_timeout(80)
        check("a panel floats into a dock-window",
              page.evaluate("window.__docks.loc('history') === 'float' && !!document.querySelector('.dock-window[data-dock-window=\"history\"]')"))
        check("no detach buttons in panel headers (drag the header instead)",
              page.evaluate("!document.querySelector('.dock-detach')"))
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
        # Properties is the same kind of object — float it, then dock it back
        page.evaluate("window.__docks.float('properties')"); page.wait_for_timeout(60)
        check("Properties can float into a window",
              page.evaluate("window.__docks.loc('properties')==='float' && !!document.querySelector('.dock-window[data-dock-window=\"properties\"] .fp-body')"))
        page.evaluate("window.__docks.dock('properties','right')"); page.wait_for_timeout(60)
        check("Properties docks like any other panel",
              page.evaluate("window.__docks.loc('properties')==='right' && !!document.querySelector('#rightdock .rail-section.properties')"))
        # Colour is a dockable panel too — summon it and dock it
        page.evaluate("window.__docks.showColor()"); page.wait_for_timeout(80)
        check("Colour summons as a panel with the embedded editor",
              page.evaluate("!!document.querySelector('.rail-section.color .cp-window.cp-embedded')"))
        page.evaluate("window.__docks.dock('color','right')"); page.wait_for_timeout(60)
        check("Colour docks like any other panel",
              page.evaluate("window.__docks.loc('color')==='right' && !!document.querySelector('#rightdock .rail-section.color')"))
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

        # ---- App-window mode (standalone Chromium window) ----
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
    sys.exit(main())
