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


def main() -> int:
    check_parses()
    svg = check_pixelvec()
    check_render(svg)
    check_color_simplify()
    check_path_simplify()
    for tmp in ["_out.svg", "_out.png"]:
        (ROOT / "tests" / tmp).unlink(missing_ok=True)
    print("\nALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
