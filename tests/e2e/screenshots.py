#!/usr/bin/env python3
"""Capture live documentation screenshots of the editor through a real browser.

Drives the actual running app (no mockups): mounts real SVG/raster content,
opens the real dock panels, and screenshots the viewport into docs/. Re-run
whenever the UI changes so the README stays honest.

Run:  .venv-e2e/bin/python tests/e2e/screenshots.py [base_url]
Needs the app running (default http://localhost:2002).
"""
from __future__ import annotations
import sys, pathlib
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:2002"
ROOT = pathlib.Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

# The project's own logo (a hand-built SVG) as the hero document — on-brand, and a
# clean vector to show off editing/selection/nodes against.
HERO_SVG = (ROOT / "assets/hv_logo.svg").read_text()


def boot(page):
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_function("typeof editor !== 'undefined' && typeof window.__docks !== 'undefined'")
    page.wait_for_timeout(150)


def mount(page, svg):
    page.evaluate("(s) => mountStageFromText(s, 'demo.svg')", svg)
    page.wait_for_function("editor.stage && editor.stage.querySelector('[data-hv-id]')", timeout=8000)
    page.wait_for_timeout(120)
    page.evaluate("() => { fitVp(viewports.output); editor.setTool('select'); }")
    page.wait_for_timeout(120)


def shot(page, name):
    DOCS.mkdir(exist_ok=True)
    out = DOCS / name
    page.screenshot(path=str(out))
    print(f"  wrote {out.relative_to(ROOT)}")


def reset_panels(page):
    # Known starting layout: only Layers + Properties docked right; everything else shelved.
    page.evaluate("""() => {
        const keep = { layers: 'right', properties: 'right' };
        for (const n of ['history','layers','library','processor','properties','color','info','jobs']) {
            if (keep[n]) window.__docks.dock(n, keep[n]); else window.__docks.shelve(n);
        }
    }""")
    page.wait_for_timeout(120)


def cap_hero(page):
    boot(page); reset_panels(page); mount(page, HERO_SVG)
    # Select a prominent shape so the selection handles + Properties populate.
    page.evaluate("""() => {
        const paths = [...editor.stage.querySelectorAll('path[data-hv-id]')];
        // pick the largest non-background path (skip the white frame at index 0)
        const pick = paths.slice(1).sort((a,b) => b.getBBox().width*b.getBBox().height - a.getBBox().width*a.getBBox().height)[0] || paths[0];
        const id = pick.getAttribute('data-hv-id');
        editor.selection = new Set([id]); editor.artboardSelected = false;
        editor._renderSelection(); editor._renderInspector(); editor._renderLayers(); editor.onInspect();
    }""")
    page.wait_for_timeout(200)
    shot(page, "editor-hero.png")


def cap_processor(page):
    boot(page); reset_panels(page)
    page.evaluate("""() => mountStageFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480"><rect class="hv-artboard" x="0" y="0" width="640" height="480" fill="#ffffff"/></svg>', 'untitled.svg')""")
    page.wait_for_function("editor.stage", timeout=6000)
    page.wait_for_timeout(120)
    # Place a real raster from the library as an <image> node, select it, open the Processor.
    name = page.evaluate("""async () => {
        const r = await fetch('/api/work-items'); const d = await r.json();
        const items = Array.isArray(d) ? d : (d.items || []);
        const prefer = ['buybot.png','launchpad.png','forcefield.png','bridge.png','ci.png','id.png'];
        const it = prefer.map(n => items.find(i => i.name === n)).find(Boolean)
                 || items.find(i => /\\.(png|jpg|jpeg)$/i.test(i.name)) || items[0];
        if (!it) return null;
        const dim = 320;
        editor.placeImage(it.url, it.name, dim, dim);
        return it.name;
    }""")
    page.wait_for_function("editor.stage && editor.stage.querySelector('image[data-hv-id]')", timeout=8000)
    page.wait_for_timeout(150)
    page.evaluate("() => { fitVp(viewports.output); const img = editor.stage.querySelector('image[data-hv-id]'); const id = img.getAttribute('data-hv-id'); editor.selection = new Set([id]); editor.artboardSelected = false; editor._renderSelection(); editor.onInspect(); }")
    # Dock the Processor (contextual → relevant now a raster is selected) and expand its stages.
    page.evaluate("""() => {
        window.__docks.dock('processor','right');
        renderProcessorPanel();
        document.querySelectorAll('#processor-body .proc-stage .stage-name, #processor-body .proc-stage .stage-head').forEach(h => h.click && h.click());
    }""")
    page.wait_for_timeout(250)
    shot(page, "editor-processor.png")


def cap_nodes(page):
    boot(page); reset_panels(page); mount(page, HERO_SVG)
    # Pick the curviest path (most cubic segments) so the bézier anchors + handles read.
    page.evaluate("""() => {
        const paths = [...editor.stage.querySelectorAll('path[data-hv-id]')];
        const curves = (p) => (p.getAttribute('d')||'').split(/[Cc]/).length;
        const pick = paths.slice().sort((a,b) => curves(b) - curves(a))[0] || paths[0];
        const id = pick.getAttribute('data-hv-id');
        editor.selection = new Set([id]); editor.artboardSelected = false;
        editor._renderSelection(); editor._renderInspector(); editor.setTool('node');
        // frame the selection so its handles are on-screen
        fitVp(viewports.output);
    }""")
    page.wait_for_timeout(150)
    page.evaluate("() => { for (let i=0;i<2;i++) zoomVp(viewports.output, 1.12); }")
    page.wait_for_timeout(250)
    shot(page, "editor-nodes.png")


def cap_panels(page):
    boot(page); mount(page, HERO_SVG)
    # Show off the dock system: a floating locking-bezel group + the shelf squares.
    page.evaluate("""() => {
        for (const n of ['history','layers','library','processor','properties','color','info','jobs']) window.__docks.shelve(n);
        window.__docks.float('layers'); window.__docks.float('history');
    }""")
    page.wait_for_timeout(150)
    # snap History onto Layers into one bezel group, and dock Properties right
    page.evaluate("""() => {
        if (window.__docks.joinGroup) window.__docks.joinGroup('history','layers','bottom');
        window.__docks.dock('properties','right');
        const paths = [...editor.stage.querySelectorAll('path[data-hv-id]')];
        const pick = paths.slice(1)[0] || paths[0];
        if (pick) { editor.selection = new Set([pick.getAttribute('data-hv-id')]); editor.artboardSelected=false; editor._renderSelection(); editor.onInspect(); }
    }""")
    page.wait_for_timeout(300)
    shot(page, "editor-panels.png")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        cap_hero(page)
        cap_processor(page)
        cap_nodes(page)
        cap_panels(page)
        browser.close()
    print("done")


if __name__ == "__main__":
    main()
