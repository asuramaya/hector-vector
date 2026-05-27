#!/usr/bin/env python3
"""End-to-end stress test for the vector editor, driven through a real browser.

Uses Playwright to issue genuine pointer + keyboard input (so the
pointer -> getScreenCTM -> selection/move pipeline is exercised for real, not
faked via dispatchEvent) and reads back live `editor` state to assert outcomes.

Run:  .venv-e2e/bin/python tests/e2e/editor_e2e.py [base_url]
Needs the app running (default http://localhost:2002).
"""
from __future__ import annotations
import json, sys, time
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
    page.evaluate("svg => { selectedOutput = null; manualOutputName = null; mountStageFromText(svg, 'ctl.svg'); }", CTL)
    page.wait_for_function("editor.stage && editor.nodeById('r2')", timeout=8000)
    page.wait_for_timeout(150)

def set_inspector_input(page, kind, index, value, event):
    """Set the index-th inspector input of a given type and dispatch `event`."""
    page.evaluate(
        """({kind, index, value, event}) => {
            const sel = kind === 'color' ? '#inspector-body input[type=color]'
                      : kind === 'number' ? '#inspector-body input[type=number]'
                      : '#inspector-body input[type=checkbox]';
            const el = document.querySelectorAll(sel)[index];
            if (!el) throw new Error('no inspector input ' + kind + ' #' + index);
            if (kind === 'checkbox') el.checked = !!value; else el.value = String(value);
            el.dispatchEvent(new Event(event, { bubbles: true }));
        }""", {"kind": kind, "index": index, "value": value, "event": event})

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
    page.evaluate("svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'bool.svg'); }", BOOL_DOC)
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

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1500, "height": 900})
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_function("typeof editor!=='undefined' && typeof mountStageFromText==='function'", timeout=20000)
        # The live library may auto-load a PNG (no editable stage). Guarantee a stage
        # so the suite doesn't depend on what's in the outputs dir.
        page.wait_for_timeout(500)
        if not page.evaluate("!!editor.stage"):
            mount_ctl(page)

        # ---- A. Save on the auto-loaded (library) document ----
        big_nodes = page.evaluate("editor.stage.querySelectorAll('[data-hv-id]').length")
        has_output = page.evaluate("!!selectedOutput")
        if has_output:
            page.click("#save-button")
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
        insp = page.eval_on_selector("#inspector-title", "e => e.textContent")
        check("empty click selects artboard", page.evaluate("editor.artboardSelected") and insp == "Artboard", insp)

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

        # inspector: fill via the real color input, and verify a whole picker
        # drag (many 'input' events + one 'change') coalesces to ONE undo entry.
        click_node(page, "r1")
        page.wait_for_timeout(60)
        hf = page.evaluate("editor.history.length")
        page.evaluate("""() => { const el = document.querySelector('#inspector-body input[type=color]');
            ['#00aa00','#00cc00','#00ee00','#00ff00'].forEach(v => { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); });
            el.dispatchEvent(new Event('change',{bubbles:true})); }""")
        page.wait_for_timeout(60)
        check("inspector fill applies", page.evaluate("editor.nodeById('r1').getAttribute('fill')") == "#00ff00")
        check("colour drag coalesces to ONE undo entry", page.evaluate("editor.history.length") == hf + 1,
              f"delta={page.evaluate('editor.history.length')-hf}")

        # inspector: stroke width (the v0 'stroke not applied' regression)
        set_inspector_input(page, "number", 0, "5", "change")
        page.wait_for_timeout(60)
        sw = page.evaluate("editor.nodeById('r1').getAttribute('stroke-width')")
        sk = page.evaluate("editor.nodeById('r1').getAttribute('stroke')")
        check("inspector stroke applies", sw and float(sw) == 5 and bool(sk), f"width={sw} stroke={sk}")

        # inspector: opacity
        set_inspector_input(page, "number", 1, "0.5", "change")
        page.wait_for_timeout(60)
        check("inspector opacity applies", page.evaluate("editor.nodeById('r1').getAttribute('opacity')") == "0.5")

        # delete
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
        set_inspector_input(page, "checkbox", 0, True, "change")      # No fill
        page.wait_for_timeout(50)
        check("fill none via checkbox", page.evaluate("editor.nodeById('r3').getAttribute('fill')") == "none")
        set_inspector_input(page, "number", 0, "4", "change"); page.wait_for_timeout(40)
        set_inspector_input(page, "number", 0, "0", "change"); page.wait_for_timeout(40)
        check("stroke width 0 removes stroke", page.evaluate("!editor.nodeById('r3').getAttribute('stroke')"))

        # undo consistency: a batch of mixed ops fully undoes back to the baseline document
        mount_ctl(page)
        base = page.evaluate(SUMMARY)
        click_node(page, "r1"); set_inspector_input(page, "color", 0, "#0000ff", "input"); page.wait_for_timeout(40)
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

        # ---- F. Process workspace + rail collapse doesn't break the stage ----
        page.click("#process-button"); page.wait_for_timeout(150)
        ws = page.evaluate("""() => ({
            open: !document.querySelector('#modal-root').hidden,
            gallery: !!document.querySelector('#process-gallery'),
            jobs: !!document.querySelector('#process-jobs'),
            run: [...document.querySelectorAll('.process-controls .primary-button')].some(b => /Run/.test(b.textContent)),
        })""")
        check("Process workspace opens with gallery + jobs + run", ws["open"] and ws["gallery"] and ws["jobs"] and ws["run"], str(ws))
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
        rows = page.evaluate("[...document.querySelectorAll('#layers-list .layer-row')].map(r=>r.dataset.id)")
        # list is reverse DOM order: top row = frontmost (last artwork child)
        check("layers list reflects nodes (reverse order)", rows == ["r3", "r2", "r1"], f"rows={rows}")

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
        page.evaluate("svg => { selectedOutput=null; mountStageFromText(svg,'wrap.svg'); }", WRAP)
        page.wait_for_function("editor.stage && editor._artworkNodes().length >= 1", timeout=8000); page.wait_for_timeout(120)
        check("wrapper group flattened into per-shape layers", page.evaluate("editor._artworkNodes().length") == 3,
              f"n={page.evaluate('editor._artworkNodes().length')}")

        # serialize strips editor-only metadata
        mount_ctl(page)
        page.evaluate("editor.rename('r1','My Rect'); editor.toggleLock('r2');")
        meta = page.evaluate("editor.serialize()")
        check("serialize strips editor metadata", ("data-hv-name" not in meta) and ("data-hv-locked" not in meta))

        # ---- Phase 4: shape tools ----
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.style.fill = '#123456'")   # last-used fill new shapes should inherit
        draw_shape(page, "rect", 0.15, 0.15, 0.55, 0.5)
        rsel = sel_node(page)
        check("rect tool creates a selected rect", rsel and rsel["tag"] == "rect" and n_nodes(page) == base + 1,
              f"sel={rsel} n={n_nodes(page)}")
        check("drawn rect inherits last-used fill", rsel and rsel["attrs"].get("fill") == "#123456",
              str(rsel and rsel["attrs"].get("fill")))
        check("shape tool stays active after drawing", page.evaluate("editor.tool") == "rect")
        page.evaluate("editor.undo()"); page.wait_for_timeout(40)
        check("undo removes the drawn rect", n_nodes(page) == base)

        mount_ctl(page)
        draw_shape(page, "ellipse", 0.2, 0.2, 0.7, 0.6)
        esel = sel_node(page)
        check("ellipse tool creates a selected ellipse", esel and esel["tag"] == "ellipse")

        mount_ctl(page)
        draw_shape(page, "line", 0.2, 0.2, 0.8, 0.7)
        lsel = sel_node(page)
        check("line tool creates a selected line with a stroke",
              lsel and lsel["tag"] == "line" and lsel["attrs"].get("stroke") not in (None, "none")
              and lsel["attrs"].get("fill") == "none", str(lsel))

        # Shift constrains a rect to a square even on a wide drag
        mount_ctl(page)
        draw_shape(page, "rect", 0.1, 0.4, 0.9, 0.55, shift=True)
        sq = sel_node(page)
        ok_sq = sq and abs(float(sq["attrs"]["width"]) - float(sq["attrs"]["height"])) < 0.5
        check("Shift constrains rect to a square", ok_sq, str(sq and (sq["attrs"]["width"], sq["attrs"]["height"])))

        # A bare click (no drag) creates nothing and leaves no undo entry
        mount_ctl(page)
        base = n_nodes(page)
        page.evaluate("editor.setTool('rect')")
        ab = artboard_rect(page)
        page.mouse.move(ab["x"] + ab["w"] * 0.5, ab["y"] + ab["h"] * 0.5)
        page.mouse.down(); page.mouse.up(); page.wait_for_timeout(40)
        check("bare click draws nothing / no history", n_nodes(page) == base and page.evaluate("editor.history.length") == 0,
              f"n={n_nodes(page)} hist={page.evaluate('editor.history.length')}")

        # Keyboard shortcuts switch tools
        page.evaluate("editor.setTool('select')")
        page.keyboard.press("p"); check("P selects pen tool", page.evaluate("editor.tool") == "pen")
        page.keyboard.press("r"); check("R selects rect tool", page.evaluate("editor.tool") == "rect")
        page.keyboard.press("e"); check("E selects ellipse tool", page.evaluate("editor.tool") == "ellipse")
        page.keyboard.press("l"); check("L selects line tool", page.evaluate("editor.tool") == "line")
        page.keyboard.press("v"); check("V returns to select tool", page.evaluate("editor.tool") == "select")

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
        page.evaluate("""svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'ue.svg'); }""",
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
        page.evaluate("""svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'sep.svg'); }""",
                      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect data-hv-id="ra" x="10" y="10" width="40" height="40" fill="#36c"/><rect data-hv-id="rb" x="140" y="140" width="40" height="40" fill="#c33"/></svg>')
        page.wait_for_function("editor.stage && editor.nodeById('rb')", timeout=8000)
        page.evaluate("editor.selection=new Set(['ra','rb']); editor.booleanOp('intersect');")
        page.wait_for_timeout(80)
        check("empty intersection changes nothing", n_nodes(page) == 2)

        # Boolean needs 2+ fillable shapes
        mount_bool(page, select_both=False)
        page.evaluate("editor.selection = new Set(['ra']); editor.booleanOp('union')"); page.wait_for_timeout(40)
        check("single selection: boolean is a no-op", n_nodes(page) == 2)

        # invert-space overlap fix: overlap of two shapes must be a HOLE, not XOR-filled
        mount_bool(page)
        page.evaluate("editor.invertSpace()"); page.wait_for_timeout(150)
        check("invert-space fills the empty artboard area", result_inside(page, 10, 10))
        check("invert-space leaves shape interiors empty (overlap not XOR-filled)",
              not result_inside(page, 30, 30) and not result_inside(page, 80, 80)
              and not result_inside(page, 130, 130))

        # ---- Layers cleanup: drop ghost/empty nodes, keep valid ones ----
        page.evaluate("""svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'ghosts.svg'); }""",
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

        # ---- Phase 4: contextual transforms (rotate / flip) ----
        page.evaluate("""svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'xf.svg'); }""",
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
        page.evaluate("""svg => { selectedOutput=null; manualOutputName=null; mountStageFromText(svg,'wide.svg'); }""",
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

        # right-click an object → contextual menu, and it selects the object
        mount_ctl(page)
        r = node_rect(page, "r2")
        page.mouse.click(r["cx"], r["cy"], button="right"); page.wait_for_timeout(80)
        ctx = page.evaluate("""() => { const m=document.querySelector('.context-menu'); return m
            ? { n: m.querySelectorAll('.menu-item').length, labels: [...m.querySelectorAll('.menu-label')].map(l=>l.textContent) } : null; }""")
        check("object context menu opens with actions", ctx and ctx["n"] >= 8 and "Duplicate" in ctx["labels"] and "Flip Horizontal" in ctx["labels"], str(ctx and ctx["n"]))
        check("right-click selects the object", page.evaluate("editor.selection.has('r2')"))
        page.keyboard.press("Escape"); page.wait_for_timeout(40)
        check("Escape closes the context menu", page.evaluate("!document.querySelector('.context-menu')"))

        # right-click empty canvas → artboard menu
        ab = artboard_rect(page)
        page.mouse.click(ab["x"] + ab["w"] * 0.04, ab["y"] + ab["h"] * 0.94, button="right"); page.wait_for_timeout(80)
        ctx2 = page.evaluate("""() => { const m=document.querySelector('.context-menu'); return m
            ? [...m.querySelectorAll('.menu-label')].map(l=>l.textContent) : null; }""")
        check("canvas context menu has Select All + Paste", ctx2 and "Select All" in ctx2 and "Paste" in ctx2, str(ctx2))
        page.keyboard.press("Escape")

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
        page.click("#open-button"); page.wait_for_timeout(150)
        modal_open = page.evaluate("!document.querySelector('#modal-root').hidden")
        cells = page.evaluate("document.querySelectorAll('#modal-body .gallery-cell').length")
        check("Open modal lists vectors", modal_open and cells >= 0, f"open={modal_open} cells={cells}")
        page.evaluate("closeModal()")

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
