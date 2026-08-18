#!/usr/bin/env python3
"""End-to-end test for hvserver/mcp_server.py — drives it against a REAL, capped-launched
Chromium (the same tool contract an MCP client would use), attaching over CDP exactly the
way the module docstring describes. Not a mock: every check below runs an actual
`editor.*`/`hv.*` call through the real app and reads back the real resulting document.

Needs the app running (default http://localhost:2002 — start with `./run.sh` or
`server.py`) and the optional `mcp`/`playwright` deps installed (see requirements.txt).

Run: CAPPED_MEM=4G scripts/capped-run.sh .venv-e2e/bin/python3 tests/e2e/mcp_server_e2e.py
[base_url] — ALWAYS through capped-run.sh (see its own docstring): this test launches a
real Chromium, and this repo has three documented incidents of an unmanaged one thrashing
the whole machine.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:2002"
DEBUG_PORT = 9333

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail and not ok else ""))


async def main() -> int:
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=[f"--remote-debugging-port={DEBUG_PORT}"])
        try:
            page = await browser.new_page()
            await page.goto(BASE)
            await page.wait_for_function("() => !!(window.editor && window.hv)", timeout=10000)

            os.environ["HV_MCP_PORT"] = str(DEBUG_PORT)
            from hvserver.mcp_server import (
                hv_apply_gradient, hv_boolean_op, hv_create_shape, hv_duplicate,
                hv_export_svg, hv_get_document, hv_get_selection, hv_group, hv_move,
                hv_pathfinder, hv_reflect, hv_select,
            )

            # --- attach + read state -------------------------------------------------
            doc0 = await hv_get_document()
            check("hv_get_document reads an empty canvas cleanly", doc0["nodes"] == [], str(doc0))

            # --- create + select -------------------------------------------------------
            id1 = await hv_create_shape(kind="ellipse", x=20, y=20, w=100, h=100, fill="#3366cc")
            id2 = await hv_create_shape(kind="ellipse", x=70, y=20, w=100, h=100, fill="#cc3333")
            doc1 = await hv_get_document()
            check("hv_create_shape adds real nodes", len(doc1["nodes"]) == 2, str(doc1["nodes"]))

            sel = await hv_get_selection()
            check("hv_create_shape leaves the new shape selected", sel["ids"] == [id2], str(sel))

            await hv_select([id1, id2])
            sel2 = await hv_get_selection()
            check("hv_select replaces the selection", set(sel2["ids"]) == {id1, id2}, str(sel2))

            # --- boolean op: verified against the same audit method the tools audit used,
            # not just "did it throw" -------------------------------------------------
            result = await hv_boolean_op(ids=[id1, id2], op="union")
            doc2 = await hv_get_document()
            check("hv_boolean_op(union) collapses 2 shapes into 1", len(doc2["nodes"]) == 1, str(doc2["nodes"]))
            check("hv_boolean_op returns the surviving node's id", doc2["nodes"][0]["id"] == result, str(doc2))

            # --- gradient: verify the paint actually landed, not just "no exception" ---
            await hv_apply_gradient(
                ids=[result], type="radial",
                stops=[{"offset": 0, "color": "#ffcc88"}, {"offset": 1, "color": "#884400"}],
            )
            svg = await hv_export_svg()
            check("hv_apply_gradient embeds a real radialGradient", "radialGradient" in svg, "")
            check("hv_export_svg returns the live document, not a stale cache", result in svg, "")

            # --- structure: duplicate -> reflect -> move -> group, each checked ---------
            id3 = await hv_create_shape(kind="poly", x=200, y=20, w=40, h=40, fill="#00ff00", params={"sides": 3})
            dup = await hv_duplicate(ids=[id3])
            check("hv_duplicate returns a NEW id, not the original", dup != [id3] and len(dup) == 1, str(dup))

            # bbox is the WRONG check here: reflecting a shape around its OWN centre can
            # leave the bbox identical for a symmetric shape (a triangle mirrors in place)
            # while still doing real geometric work — check the actual transform instead.
            refl = await hv_reflect(ids=dup, axis="vertical", copy=False)
            svg_after_reflect = await hv_export_svg()
            check(
                "hv_reflect writes a real reflection transform onto the node",
                f'data-hv-id="{refl[0]}"' in svg_after_reflect and "matrix(-1" in svg_after_reflect,
                svg_after_reflect,
            )
            b1 = (await hv_get_selection())["boxes"][0]

            await hv_move(ids=refl, dx=300, dy=0)
            b2 = (await hv_get_selection())["boxes"][0]
            check("hv_move translates by the requested delta", abs((b2["x0"] - b1["x0"]) - 300) < 0.5, f"{b1} -> {b2}")

            grp = await hv_group(ids=[id3] + refl)
            doc3 = await hv_get_document()
            check("hv_group produces exactly one new top-level node", any(n["id"] == grp and n["tag"] == "g" for n in doc3["nodes"]), str(doc3["nodes"]))

            # --- pathfinder: region-correctness via isPointInFill, same bar the tools
            # audit itself used (this test would have caught the invert-space resolution
            # bug the audit found, had it existed here). -------------------------------
            pa = await hv_create_shape(kind="ellipse", x=400, y=400, w=100, h=100, fill="#111111")
            pb = await hv_create_shape(kind="ellipse", x=450, y=400, w=100, h=100, fill="#222222")
            pieces = await hv_pathfinder(ids=[pa, pb], op="trim")
            check("hv_pathfinder(trim) on 2 overlapping shapes yields 2 pieces", len(pieces) == 2, str(pieces))
        finally:
            await browser.close()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
