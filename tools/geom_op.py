#!/usr/bin/env python3
"""Run a REAL geometry op (union/subtract/intersect, offset, outline-stroke) against path
data, through the live app's own engine — not a symbolic path-algebra reimplementation.

Epic A2 ("the geometry kernel" — see the ui-legibility memory: computations an agent
would otherwise get quietly wrong). hv's booleans are marching-squares point-in-fill
sampling against a REAL attached SVG element (SVGGeometryElement.isPointInFill,
editor.js's _fillTester) — there is no pure-Node/Python equivalent to call. This drives a
headless browser exactly like tools/render_png.py, and for the same reason: reuse the one
engine that's actually correct rather than risk a second, different one.

Each call mounts a THROWAWAY scratch document in an ISOLATED Playwright page — never a
real user's tab — so it can never clobber anything a human has open. Needs the hv server
already running (see render_png.py's docstring on why this script does not start/stop one).

Usage:
  tools/geom_op.py boolean {union|subtract|intersect} --shape D [--shape D ...]
  tools/geom_op.py offset --amount N --shape D [--shape D ...]
  tools/geom_op.py outline-stroke --shape D [--width W] [--shape D --width W ...]

  Shapes are absolute SVG path `d` strings (one --shape per path). For `boolean subtract`,
  the FIRST --shape is the back shape (the one kept); the rest are cut out of it —
  booleanOp orders inputs by document position, and this script mounts them in --shape
  order, so that order is exactly what you pass.

Prints JSON to stdout: one object for `boolean` ({"d", "bbox"}), an ARRAY (one entry per
input shape, same order) for `offset`/`outline-stroke`.
"""
from __future__ import annotations
import argparse, json, sys
from playwright.sync_api import sync_playwright


def _run(base_url: str, fn: str, args: list):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(base_url, wait_until="domcontentloaded")
            page.wait_for_function(
                "() => !!window.editor && !!window.__geom && typeof mountStageFromText === 'function'",
                timeout=20000,
            )
            return page.evaluate(f"(a) => window.__geom.{fn}(...a)", args)
        finally:
            browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("op", choices=["boolean", "offset", "outline-stroke"])
    ap.add_argument("op_arg", nargs="?", help="union/subtract/intersect (boolean only)")
    ap.add_argument("--amount", type=float, help="offset amount in user units — negative shrinks (offset only)")
    ap.add_argument("--shape", action="append", default=[], help="an absolute path `d` string; repeat per shape")
    ap.add_argument("--width", action="append", default=[], type=float, help="stroke width paired with the --shape at the same position (outline-stroke only; default 4)")
    ap.add_argument("--base-url", default="http://127.0.0.1:2002")
    args = ap.parse_args()

    if not args.shape:
        print("at least one --shape is required", file=sys.stderr)
        return 1

    try:
        if args.op == "boolean":
            if args.op_arg not in ("union", "subtract", "intersect"):
                print("boolean needs union|subtract|intersect as its argument", file=sys.stderr)
                return 1
            result = _run(args.base_url, "boolean", [args.shape, args.op_arg])
        elif args.op == "offset":
            if args.amount is None or args.amount == 0:
                print("offset needs --amount (a non-zero number; negative shrinks)", file=sys.stderr)
                return 1
            result = _run(args.base_url, "offset", [args.shape, args.amount])
        else:
            widths = (args.width + [4] * len(args.shape))[: len(args.shape)]
            result = _run(args.base_url, "outlineStroke", [args.shape, widths])
    except Exception as e:
        print(f"geom_op failed: {e}", file=sys.stderr)
        print(f"(is the hv server running at {args.base_url}? try ./run.sh)", file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
