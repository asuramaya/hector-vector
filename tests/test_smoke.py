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
    src = ROOT / "examples" / "potion_256.png"   # 256x256 nearest upscale of a 16x16 sprite
    out = ROOT / "tests" / "_out.svg"
    info = pixelvec.vectorize_pixel_art(src, out, mode="merged")
    assert info["grid"] == [16, 16], f"expected native grid 16x16, got {info['grid']}"
    assert info["shapes"] > 0, "no shapes emitted"
    svg = out.read_text()
    assert "<svg" in svg and ("<rect" in svg or "<path" in svg), "SVG missing shapes"
    print(f"ok: pixelvec recovered {info['grid']} grid, {info['shapes']} shapes")
    return out


def check_render(svg: Path) -> None:
    import svg_render
    from PIL import Image
    out = ROOT / "tests" / "_out.png"
    info = svg_render.render_svg(svg, out, scale=4)   # 16 -> 64
    assert info["backend"] == "builtin", f"expected builtin backend, got {info['backend']}"
    with Image.open(out) as im:
        assert im.size == (64, 64), f"expected 64x64 render, got {im.size}"
    print(f"ok: svg_render produced {info['size']} PNG via {info['backend']}")


def main() -> int:
    check_parses()
    svg = check_pixelvec()
    check_render(svg)
    for tmp in ["_out.svg", "_out.png"]:
        (ROOT / "tests" / tmp).unlink(missing_ok=True)
    print("\nALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
