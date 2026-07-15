#!/usr/bin/env python3
"""Render the live hv canvas to a real PNG, using the app's OWN renderer.

Epic A1 ("render -> png", the agent surface's first primitive — see the ui-legibility
memory: "I can already emit SVG; what I lack is EYES"). This is deliberately NOT a second
rasteriser: tools/svg_render.py is a narrow Pillow/cairosvg tool built for axis-aligned
pixel-art SVGs and would silently mis-render gradients, masks, filters, live shapes,
symbols and text-on-path. This script instead drives a real (headless) browser to the
live app and calls window.__render.png(...) — the exact browser-canvas rasteriser
src/ui/export.js already uses for the real Export-PNG dialog. What you get back is
BYTE-IDENTICAL to what a user's Export would produce, because it's the same code path.

Needs the hv server already running (this script does not start or stop one, on purpose
- a script-launched server that outlives a crash is exactly how a background e2e run
once orphaned a Chromium tree and thrashed the whole machine; see hv-e2e-env-flake.md).

Usage:
  tools/render_png.py OUT.png [--svg IN.svg] [--scale N | --width W --height H]
                      [--bg transparent|white|black] [--base-url URL]

  --svg IN.svg   mount this SVG as the document before rendering. This is the main use:
                 write/generate an SVG, then look at exactly what a user's Export would
                 produce from it. Omitting --svg renders the app's own default boot
                 document instead (a blank canvas, normally) — Playwright opens a FRESH,
                 isolated browser context, so it can NOT see a real user's already-open
                 tab or its in-browser localStorage/unsaved edits; there is no "peek at
                 what's on someone's screen right now" mode here.
"""
from __future__ import annotations
import argparse, base64, sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def render_png(
    out_path: str,
    svg_path: str | None = None,
    *,
    scale: float = 1,
    width: int = 0,
    height: int = 0,
    background: str = "transparent",
    base_url: str = "http://127.0.0.1:2002",
) -> dict:
    svg_text = Path(svg_path).read_text() if svg_path else None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(base_url, wait_until="domcontentloaded")
            page.wait_for_function(
                "() => !!window.editor && !!window.__render && typeof mountStageFromText === 'function'",
                timeout=20000,
            )
            if svg_text is not None:
                page.evaluate(
                    "svg => mountStageFromText(svg, 'render_png.svg')", svg_text
                )
                page.wait_for_timeout(120)   # let layout settle before reading native size (see [[hv-e2e-env-flake]])
            result = page.evaluate(
                "opts => window.__render.png(opts)",
                {"scale": scale, "width": width, "height": height, "background": background},
            )
        finally:
            browser.close()

    data_url = result["dataUrl"]
    header, b64 = data_url.split(",", 1)
    png_bytes = base64.b64decode(b64)
    Path(out_path).write_bytes(png_bytes)
    return {"path": out_path, "width": result["w"], "height": result["h"], "bytes": len(png_bytes)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", help="output PNG path")
    ap.add_argument("--svg", help="mount this SVG file as the document before rendering")
    ap.add_argument("--scale", type=float, default=1, help="multiply the document's native size (default 1)")
    ap.add_argument("--width", type=int, default=0, help="explicit output width (overrides --scale)")
    ap.add_argument("--height", type=int, default=0, help="explicit output height (overrides --scale)")
    ap.add_argument("--bg", default="transparent", choices=["transparent", "white", "black"])
    ap.add_argument("--base-url", default="http://127.0.0.1:2002")
    args = ap.parse_args()

    try:
        info = render_png(
            args.out, args.svg,
            scale=args.scale, width=args.width, height=args.height,
            background=args.bg, base_url=args.base_url,
        )
    except Exception as e:
        print(f"render_png failed: {e}", file=sys.stderr)
        print(f"(is the hv server running at {args.base_url}? try ./run.sh)", file=sys.stderr)
        return 1

    print(f"wrote {info['path']} ({info['width']}x{info['height']}, {info['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
