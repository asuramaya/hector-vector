#!/usr/bin/env python3
"""Smoke tests: every module parses, and the core pixel-art -> SVG -> PNG path
works on the bundled example sprite. Run with `python3 tests/test_smoke.py`
(needs Pillow + numpy; no pytest required)."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def check_parses() -> None:
    for rel in ["server.py", "engine.py", "mask_trace_prep.py",
                "tools/pixelvec.py", "tools/svg_render.py", "tools/ai_cutout.py"]:
        ast.parse((ROOT / rel).read_text())
    print("ok: all Python modules parse")


def check_pixelvec() -> None:
    import pixelvec
    src = ROOT / "examples" / "fire_h_x11.png"   # 264x330 nearest upscale of a 24x30 sprite
    out = ROOT / "tests" / "_out.svg"
    info = pixelvec.vectorize_pixel_art(src, out, mode="merged")
    assert info["grid"] == [24, 30], f"expected native grid 24x30, got {info['grid']}"
    assert info["shapes"] > 0, "no shapes emitted"
    svg = out.read_text()
    assert "<svg" in svg and ("<rect" in svg or "<path" in svg), "SVG missing shapes"
    print(f"ok: pixelvec recovered {info['grid']} grid, {info['shapes']} shapes")
    return out


def check_render(svg: Path) -> None:
    import svg_render
    from PIL import Image
    out = ROOT / "tests" / "_out.png"
    info = svg_render.render_svg(svg, out, scale=4)   # 24x30 -> 96x120
    assert info["backend"] == "builtin", f"expected builtin backend, got {info['backend']}"
    with Image.open(out) as im:
        assert im.size == (96, 120), f"expected 96x120 render, got {im.size}"
    print(f"ok: svg_render produced {info['size']} PNG via {info['backend']}")


def check_color_simplify() -> None:
    """Color-trace simplification: near-binary art is detected, and poster style
    collapses anti-aliasing fringes to a real palette (the staircase/fill-spam fix)
    while photo style leaves the gradient intact. Pure PIL/numpy — no vtracer."""
    sys.path.insert(0, str(ROOT))
    import server
    from PIL import Image, ImageDraw

    # a near-binary anti-aliased wedge (the case that fill-spams in naive color trace)
    big = Image.new("L", (800, 800), 255)
    ImageDraw.Draw(big).polygon([(400, 40), (120, 760), (680, 760)], fill=0)
    nb = ROOT / "tests" / "_nb.png"
    big.resize((300, 300), Image.Resampling.LANCZOS).convert("RGB").save(nb)
    # a genuine horizontal gradient (must NOT be treated as near-binary)
    col = Image.new("RGB", (300, 300))
    dc = ImageDraw.Draw(col)
    for i in range(300):
        dc.line([(i, 0), (i, 300)], fill=(i % 256, (i * 2) % 256, 200))
    cf = ROOT / "tests" / "_col.png"
    col.save(cf)

    assert server.image_is_near_binary(nb), "AA 2-tone wedge should read as near-binary"
    assert not server.image_is_near_binary(cf), "a gradient must not read as near-binary"

    tr = server.trace_config({"trace_colormode": "color", "trace_color_style": "poster", "color_precision": "3"})
    assert tr["poster_colors"] == 4, f"cp=3 should map to a 4-colour palette, got {tr['poster_colors']}"

    pflat = ROOT / "tests" / "_pflat.png"
    server.prepare_color_input(nb, pflat, tr)
    pcolors = len(Image.open(pflat).convert("RGB").getcolors(maxcolors=1 << 20) or [])
    assert 0 < pcolors <= tr["poster_colors"] + 1, f"poster left {pcolors} colours (palette {tr['poster_colors']})"

    photo = server.trace_config({"trace_colormode": "color", "trace_color_style": "photo", "color_precision": "6"})
    fflat = ROOT / "tests" / "_fflat.png"
    server.prepare_color_input(nb, fflat, photo)
    fcolors = len(Image.open(fflat).convert("RGB").getcolors(maxcolors=1 << 20) or [])
    assert fcolors > pcolors, "photo style must keep the AA ramp (no quantize)"
    print(f"ok: color simplify — near-binary detected, poster {fcolors}->{pcolors} colours, photo preserved")
    for t in ["_nb.png", "_col.png", "_pflat.png", "_fflat.png"]:
        (ROOT / "tests" / t).unlink(missing_ok=True)


def check_path_simplify() -> None:
    """Post-trace refit collapses over-segmented paths to minimal cubics, preserves
    structure, and is RESOLUTION-STABLE — the same shape at 3x scale simplifies to
    the same node count (node density tracks geometry, not pixels). Pure numpy."""
    import math
    sys.path.insert(0, str(ROOT / "tools"))
    import simplify_svg

    def circle_svg(dim, cx, cy, r, n=200):
        p = [f"{cx + r*math.cos(2*math.pi*i/n):.2f},{cy + r*math.sin(2*math.pi*i/n):.2f}" for i in range(n)]
        d = "M" + p[0] + " " + " ".join("L" + q for q in p[1:]) + " Z"
        return f'<svg width="{dim}" height="{dim}"><path d="{d}" fill="#123abc"/></svg>'

    new, st = simplify_svg.simplify_svg_text(circle_svg(1000, 500, 500, 300), frac=0.02)
    assert st["nodes_after"] <= st["nodes_before"] // 10, f"weak reduction: {st}"
    assert 2 <= st["nodes_after"] <= 12, f"a circle should need a handful of cubics, got {st['nodes_after']}"
    assert new.count("<path") == 1 and 'fill="#123abc"' in new, "lost the path or its fill"

    _, st3 = simplify_svg.simplify_svg_text(circle_svg(3000, 1500, 1500, 900), frac=0.02)
    assert st3["nodes_after"] == st["nodes_after"], \
        f"not resolution-stable: {st['nodes_after']} at 1x vs {st3['nodes_after']} at 3x"
    print(f"ok: simplify {st['nodes_before']}->{st['nodes_after']} nodes, resolution-stable across 3x")


def check_pipeline_stages() -> None:
    """The generalized pipeline resolves stage flags + methods from a payload, and
    a flag-less payload stays back-compatible (all three stages). Pure logic."""
    sys.path.insert(0, str(ROOT))
    import server

    # explicit flags honored, with method strings
    st = server._pipeline_stages({"stage_upscale": False, "stage_removebg": True,
                                  "stage_vectorize": True, "removebg_method": "green",
                                  "vectorize_method": "pixel"})
    assert st["upscale"] is False and st["removebg"] and st["vectorize"], st
    assert st["removebg_method"] == "green" and st["vectorize_method"] == "pixel", st

    # stringy booleans coerce; the bare (legacy) payload is all-three Production SVG
    assert server._stage_on("true") and server._stage_on(1) and not server._stage_on("0")
    legacy = server._pipeline_stages({})
    assert legacy["upscale"] and legacy["removebg"] and legacy["vectorize"], legacy

    # methods fall back to the old single-purpose settings when unspecified
    fb = server._pipeline_stages({"stage_vectorize": True, "cutout_backend": "ai", "trace_mode": "pixel"})
    assert fb["removebg_method"] == "ai" and fb["vectorize_method"] == "pixel", fb

    summ = server._pipeline_summary("logo.png", st)
    assert "Greenscreen" in summ and "Pixel trace" in summ and "logo.png" in summ, summ
    print("ok: pipeline stage flags resolve (explicit, legacy all-three, method fallbacks)")


def check_pipeline_skip() -> None:
    """Stage-aware skip-detection: the terminal output a stage-set emits (SVG /
    cutout PNG / upscale PNG) and 'already processed' track the ACTUAL stages, not
    a fixed 'pipeline -> .svg' — so an upscale-only run is skipped on its PNG and a
    vectorize run isn't falsely skipped by a leftover upscale PNG. Pure logic + a
    throwaway pipeline-* folder."""
    sys.path.insert(0, str(ROOT))
    import server

    on = {"upscale": True, "removebg": True, "vectorize": True}
    assert server.pipeline_expected_output(on, "img") == "img.svg"
    assert server.pipeline_expected_output({"upscale": True, "removebg": True, "vectorize": False}, "img") == "img.cutout.png"
    assert server.pipeline_expected_output({"upscale": True, "removebg": False, "vectorize": False}, "img") == "img.png"
    assert server.pipeline_expected_output({"upscale": False, "removebg": False, "vectorize": False}, "img") is None

    folder = server.OUTPUTS_DIR / "pipeline-_skiptest"
    folder.mkdir(parents=True, exist_ok=True)
    try:
        # only the upscale PNG exists on disk
        (folder / "_skipstem.png").write_text("")
        up_only = {"upscale": True, "removebg": False, "vectorize": False}
        vec = {"upscale": True, "removebg": True, "vectorize": True}
        assert server.is_pipeline_processed(up_only, "_skipstem"), "upscale-only must skip on its PNG"
        assert not server.is_pipeline_processed(vec, "_skipstem"), "a vectorize run must NOT skip on a leftover upscale PNG"
        # now the SVG exists too -> the vectorize run is genuinely done
        (folder / "_skipstem.svg").write_text("<svg/>")
        assert server.is_pipeline_processed(vec, "_skipstem"), "vectorize must skip once its SVG exists"
        assert not server.is_pipeline_processed(vec, "_other"), "unrelated stem must not skip"
    finally:
        for child in folder.glob("*"):
            child.unlink()
        folder.rmdir()
    print("ok: stage-aware skip — expected output + is_pipeline_processed track the live stage-set")


def main() -> int:
    check_parses()
    svg = check_pixelvec()
    check_render(svg)
    check_color_simplify()
    check_path_simplify()
    check_pipeline_stages()
    check_pipeline_skip()
    for tmp in ["_out.svg", "_out.png"]:
        (ROOT / "tests" / tmp).unlink(missing_ok=True)
    print("\nALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
