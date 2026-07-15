#!/usr/bin/env python3
"""Query and mutate a REAL document by its editing id, through the live app.

Epic A3 ("the addressable document" — see the ui-legibility memory: the real agent job
is precision tedium at volume — "normalize every stroke in this icon set to 1.5px" — not
illustration, at which an agent would be mediocre). This mounts an actual SVG file into
the live editor (an isolated Playwright page — never a real user's tab, same discipline
as render_png.py/geom_op.py), lists or edits nodes by id, then serializes the clean
result the SAME way the app's own Save does (editor.serialize() strips the internal
data-hv-id bookkeeping attribute — it was never meant to leak into saved output).

Needs the hv server already running (see render_png.py's docstring for why this script
does not start/stop one itself).

Usage:
  tools/doc_op.py list IN.svg
      Print a JSON array of every node: {"id", "tag", "attrs": {...}, "bbox"}.

  tools/doc_op.py set IN.svg OUT.svg --edit '[{"id": "n3", "attrs": {"stroke-width": "1.5"}}, ...]'
      Apply each edit (attrs is a {name: value} object; a null value REMOVES that
      attribute), then write the resulting SVG to OUT.svg. --edit can also be a path to a
      JSON file containing that same array (handy once the edit list gets long).
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def _run(base_url: str, svg_text: str, fn) -> object:
    """fn(page) does the work once the document is mounted; returns whatever fn returns."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(base_url, wait_until="domcontentloaded")
            page.wait_for_function(
                "() => !!window.editor && !!window.__doc && typeof mountStageFromText === 'function'",
                timeout=20000,
            )
            page.evaluate("svg => window.__doc.open(svg, 'doc-op.svg')", svg_text)
            page.wait_for_timeout(120)   # settle before reading bbox (see [[hv-e2e-env-flake]])
            return fn(page)
        finally:
            browser.close()


def cmd_list(args) -> int:
    svg_text = Path(args.svg).read_text()
    result = _run(args.base_url, svg_text, lambda page: page.evaluate("() => window.__doc.list()"))
    print(json.dumps(result, indent=2))
    return 0


def cmd_set(args) -> int:
    svg_text = Path(args.svg).read_text()
    edit_arg = args.edit
    edits = json.loads(Path(edit_arg).read_text()) if Path(edit_arg).is_file() else json.loads(edit_arg)

    def do(page):
        for e in edits:
            page.evaluate("([id, attrs]) => window.__doc.set(id, attrs)", [e["id"], e.get("attrs", {})])
        return page.evaluate("() => window.__doc.serialize()")

    result = _run(args.base_url, svg_text, do)
    Path(args.out).write_text(result)
    print(f"wrote {args.out} ({len(edits)} edit(s) applied)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:2002")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="print every node's id/tag/attrs/bbox as JSON")
    p_list.add_argument("svg")
    p_list.set_defaults(fn=cmd_list)

    p_set = sub.add_parser("set", help="apply attribute edits by id and write the result")
    p_set.add_argument("svg")
    p_set.add_argument("out")
    p_set.add_argument("--edit", required=True, help='JSON array (or path to one): [{"id":..,"attrs":{...}}]')
    p_set.set_defaults(fn=cmd_set)

    args = ap.parse_args()
    try:
        return args.fn(args)
    except Exception as e:
        print(f"doc_op failed: {e}", file=sys.stderr)
        print(f"(is the hv server running at {args.base_url}? try ./run.sh)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
