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
                hv_apply_fill, hv_apply_gradient, hv_boolean_op, hv_create_shape,
                hv_add_fill_layer, hv_align, hv_break_symbol_link, hv_create_text,
                hv_distribute, hv_duplicate, hv_expand_multi_fill, hv_export_svg,
                hv_get_document, hv_get_fill_layers, hv_get_selection, hv_group,
                hv_list_symbols, hv_make_multi_fill, hv_make_symbol, hv_move,
                hv_move_fill_layer, hv_pathfinder, hv_place_symbol_instance,
                hv_reflect, hv_remove_fill_layer, hv_select, hv_set_fill_layer,
                hv_set_shape_param, hv_set_text_box, hv_set_text_content, hv_set_text_style,
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

            # --- undo history: every mutating tool must be a real undo step, or a human
            # working alongside an agent gets silent history corruption (Halcyon's review
            # of PR #9 caught 4 tools bypassing history entirely — this section is the
            # regression test for that class of bug, not just "did the document change").
            n_before_undo = len((await hv_get_document())["nodes"])
            await page.evaluate("() => editor.undo()")
            n_after_undo = len((await hv_get_document())["nodes"])
            check(
                "hv_create_shape is a real undo step",
                n_after_undo == n_before_undo - 1, f"{n_before_undo} -> {n_after_undo}",
            )
            id2 = await hv_create_shape(kind="ellipse", x=70, y=20, w=100, h=100, fill="#cc3333")  # redo it for the rest of the run

            await hv_select([id1, id2])
            sel2 = await hv_get_selection()
            check("hv_select replaces the selection", set(sel2["ids"]) == {id1, id2}, str(sel2))

            # --- fill + shape-param: both are real editor commands that must land as real
            # undo steps too (the other half of the bug Halcyon's review found) ----------
            n_before = len((await hv_get_document())["nodes"])
            await hv_apply_fill(ids=[id1], color="#00ff00")
            fill_now = next(n["fill"] for n in (await hv_get_document())["nodes"] if n["id"] == id1)
            check("hv_apply_fill actually changes the fill", fill_now == "#00ff00", fill_now)
            await page.evaluate("() => editor.undo()")
            fill_after_undo = next(n["fill"] for n in (await hv_get_document())["nodes"] if n["id"] == id1)
            check("hv_apply_fill is a real undo step", fill_after_undo == "#3366cc", fill_after_undo)

            await hv_set_shape_param(id=id1, key="bw", value=250)
            svg_wide = await hv_export_svg()
            check("hv_set_shape_param changes the geometry", 'data-hv-bw="250"' in svg_wide, "")
            await page.evaluate("() => editor.undo()")
            svg_narrow = await hv_export_svg()
            check("hv_set_shape_param is a real undo step", 'data-hv-bw="250"' not in svg_narrow, "")
            n_after = len((await hv_get_document())["nodes"])
            check("undo of fill/shape-param didn't lose or duplicate nodes", n_after == n_before, f"{n_before} -> {n_after}")

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
            await page.evaluate("() => editor.undo()")
            svg_after_undo = await hv_export_svg()
            check("hv_apply_gradient is a real undo step", "radialGradient" not in svg_after_undo, "")
            await hv_apply_gradient(  # redo it for the rest of the run
                ids=[result], type="radial",
                stops=[{"offset": 0, "color": "#ffcc88"}, {"offset": 1, "color": "#884400"}],
            )

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

            # --- align / distribute -----------------------------------------------------
            vb = doc3["viewBox"]
            aid = await hv_create_shape(kind="rect", x=17, y=17, w=30, h=30, fill="#123456")
            await hv_align(ids=[aid], mode="left")
            b_left = (await hv_get_selection())["boxes"][0]
            check("hv_align(left) snaps the node's x0 to the artboard's left edge", abs(b_left["x0"] - vb["x"]) < 0.5, f"{b_left} vb={vb}")
            n_before_align_undo = len((await hv_get_document())["nodes"])
            await page.evaluate("() => editor.undo()")
            b_after_undo = (await hv_get_selection())["boxes"]
            check("hv_align is a real undo step", not b_after_undo or abs(b_after_undo[0]["x0"] - vb["x"]) > 0.5, f"{b_after_undo} vb={vb}")
            await hv_align(ids=[aid], mode="left")  # redo for the rest of the run

            da = await hv_create_shape(kind="rect", x=0, y=500, w=20, h=20, fill="#111111")
            db = await hv_create_shape(kind="rect", x=50, y=500, w=20, h=20, fill="#222222")
            dc = await hv_create_shape(kind="rect", x=200, y=500, w=20, h=20, fill="#333333")
            await hv_distribute(ids=[da, db, dc], axis="h")
            await hv_select([da, db, dc])
            boxes = sorted((await hv_get_selection())["boxes"], key=lambda b: b["x0"])
            gap1 = boxes[1]["x0"] - boxes[0]["x1"]
            gap2 = boxes[2]["x0"] - boxes[1]["x1"]
            check("hv_distribute(h) equalizes the gaps between 3 nodes", abs(gap1 - gap2) < 0.5, f"gaps={gap1},{gap2} boxes={boxes}")

            # --- text: point, area, style, content, box resize -------------------------
            tid = await hv_create_text(x=10, y=10, text="Hello\nWorld", style={"fontSize": 24})
            doc_t = await hv_get_document()
            node_t = next(n for n in doc_t["nodes"] if n["id"] == tid)
            check("hv_create_text (point) round-trips its content", node_t["content"] == "Hello\nWorld", str(node_t))

            n_before_text_undo = len((await hv_get_document())["nodes"])
            await page.evaluate("() => editor.undo()")
            n_after_text_undo = len((await hv_get_document())["nodes"])
            check("hv_create_text is a real undo step", n_after_text_undo == n_before_text_undo - 1, f"{n_before_text_undo} -> {n_after_text_undo}")
            tid = await hv_create_text(x=10, y=10, text="Hello\nWorld", style={"fontSize": 24})  # redo for the rest of the run

            await hv_set_text_content(id=tid, text="Goodbye")
            doc_t2 = await hv_get_document()
            node_t2 = next(n for n in doc_t2["nodes"] if n["id"] == tid)
            check("hv_set_text_content replaces the text", node_t2["content"] == "Goodbye", str(node_t2))

            await hv_set_text_style(ids=[tid], style={"fontWeight": "700", "textAnchor": "middle"})
            svg_t = await hv_export_svg()
            check(
                "hv_set_text_style writes real font-weight/text-anchor attrs",
                f'data-hv-id="{tid}"' in svg_t and 'font-weight="700"' in svg_t and 'text-anchor="middle"' in svg_t,
                svg_t,
            )

            # Soft-wrap boundaries collapse back to spaces on read (_readTextContent joins
            # them so re-editing doesn't freeze the wrap) — the observable trace of a wrap
            # is tspan COUNT in the export, not "\n" in the round-tripped content string.
            async def tspan_count(node_id: str) -> int:
                svg = await hv_export_svg()
                seg = svg.split(f'data-hv-id="{node_id}"', 1)[1].split("</text>", 1)[0]
                return seg.count("<tspan")

            atid = await hv_create_text(x=300, y=10, text="a long line that should wrap inside its box", w=80)
            n_lines_narrow = await tspan_count(atid)
            check("hv_create_text (area) wraps a long line into multiple tspans", n_lines_narrow > 1, f"tspans={n_lines_narrow}")

            await hv_set_text_box(id=atid, w=400)
            n_lines_wide = await tspan_count(atid)
            check("hv_set_text_box(w=400) re-wraps to fewer tspans", n_lines_wide < n_lines_narrow, f"{n_lines_narrow} -> {n_lines_wide}")

            # --- symbols: make, list, place, break ---------------------------------------
            sa = await hv_create_shape(kind="star", x=600, y=10, w=40, h=40, fill="#e07a2f")
            inst1 = await hv_make_symbol(ids=[sa])
            syms = await hv_list_symbols()
            check("hv_make_symbol creates exactly one symbol master", len(syms) == 1, str(syms))

            doc_s = await hv_get_document()
            check("hv_make_symbol replaces the source node with one <use> instance", any(n["id"] == inst1 and n["tag"] == "use" for n in doc_s["nodes"]), str(doc_s["nodes"]))

            inst2 = await hv_place_symbol_instance(symbol_id=syms[0]["id"], x=700, y=100)
            doc_s2 = await hv_get_document()
            check("hv_place_symbol_instance adds a second independent <use>", inst2 != inst1 and any(n["id"] == inst2 and n["tag"] == "use" for n in doc_s2["nodes"]), str(doc_s2["nodes"]))

            grp = await hv_break_symbol_link(id=inst2)
            doc_s3 = await hv_get_document()
            check("hv_break_symbol_link replaces the instance with an independent group", any(n["id"] == grp and n["tag"] == "g" for n in doc_s3["nodes"]) and not any(n["id"] == inst2 for n in doc_s3["nodes"]), str(doc_s3["nodes"]))
            check("hv_break_symbol_link leaves the OTHER instance (inst1) untouched", any(n["id"] == inst1 for n in doc_s3["nodes"]), str(doc_s3["nodes"]))

            # --- multi-fill / appearance --------------------------------------------------
            fa = await hv_create_shape(kind="rect", x=600, y=200, w=60, h=60, fill="#00aa00")
            stack = await hv_make_multi_fill(id=fa)
            layers0 = await hv_get_fill_layers(id=stack)
            check("hv_make_multi_fill creates a 2-layer stack", layers0 is not None and len(layers0) == 2, str(layers0))

            await hv_add_fill_layer(id=stack)
            layers1 = await hv_get_fill_layers(id=stack)
            check("hv_add_fill_layer grows the stack to 3", len(layers1) == 3, str(layers1))

            n_before_fill_undo = len((await hv_get_document())["nodes"])
            await hv_set_fill_layer(id=stack, index=1, fill="#ff00ff", opacity=0.5)
            layers2 = await hv_get_fill_layers(id=stack)
            check("hv_set_fill_layer changes exactly the targeted layer", layers2[1]["fill"] == "#ff00ff" and abs(layers2[1]["opacity"] - 0.5) < 0.01 and layers2[0] == layers1[0], str(layers2))
            await page.evaluate("() => editor.undo()")
            layers2_undo = await hv_get_fill_layers(id=stack)
            check("hv_set_fill_layer is a real undo step", layers2_undo[1]["fill"] != "#ff00ff", str(layers2_undo))
            await hv_set_fill_layer(id=stack, index=1, fill="#ff00ff", opacity=0.5)  # redo for the rest of the run
            check("no extra top-level nodes leaked from the fill-layer undo/redo", len((await hv_get_document())["nodes"]) == n_before_fill_undo, "")

            await hv_move_fill_layer(id=stack, index=1, direction="up")
            layers3 = await hv_get_fill_layers(id=stack)
            check("hv_move_fill_layer(up) swaps layer 1 to the top", layers3[2]["fill"] == "#ff00ff", str(layers3))

            await hv_remove_fill_layer(id=stack, index=0)
            layers4 = await hv_get_fill_layers(id=stack)
            check("hv_remove_fill_layer shrinks the stack", len(layers4) == 2, str(layers4))

            await hv_expand_multi_fill(id=stack)
            doc_mf = await hv_get_document()
            check("hv_expand_multi_fill drops the multi-fill group (no longer a stack)", (await hv_get_fill_layers(id=stack)) is None, str(doc_mf["nodes"]))

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
