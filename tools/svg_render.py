#!/usr/bin/env python3
"""Rasterise an SVG to PNG at an arbitrary size.

Two backends:
  * builtin -- pure Pillow. Handles axis-aligned SVGs (solid-fill <rect> and
    rectangle-only <path> built from M/h/v/z), which is exactly what the
    Pixel Art -> SVG process emits. Output is pixel-exact at any scale.
  * cairosvg -- used only when the SVG contains curves/lines (vtracer output).
    Optional dependency; a clear error is raised if it is missing.

CLI:
  svg_render.py IN.svg OUT.png [--scale N | --width W | --height H] [--bg COLOR]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# path commands that mean "this is not a plain rectangle outline"
_CURVE_CMDS = re.compile(r"[CcSsQqTtAaLl]")
_NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"

_BG_PRESETS = {
    "transparent": (0, 0, 0, 0),
    "white": (255, 255, 255, 255),
    "black": (0, 0, 0, 255),
}


def _parse_viewbox(svg: str) -> tuple[float, float, float, float] | None:
    m = re.search(r'viewBox\s*=\s*"\s*(%s)\s+(%s)\s+(%s)\s+(%s)\s*"' % (_NUM, _NUM, _NUM, _NUM), svg)
    if m:
        return tuple(float(g) for g in m.groups())  # type: ignore[return-value]
    wm = re.search(r'\bwidth\s*=\s*"(%s)"' % _NUM, svg)
    hm = re.search(r'\bheight\s*=\s*"(%s)"' % _NUM, svg)
    if wm and hm:
        return 0.0, 0.0, float(wm.group(1)), float(hm.group(1))
    return None


def _attr(tag: str, name: str, default: float = 0.0) -> float:
    m = re.search(r'\b%s\s*=\s*"(%s)"' % (name, _NUM), tag)
    return float(m.group(1)) if m else default


# Sentinel: the fill is PRESENT but not something the builtin can render (a named
# colour, gradient ref, etc.). Distinguished from None (fill="none"/absent → skip the
# shape) so the caller bails to cairosvg instead of silently dropping it.
_UNRENDERABLE = object()


def _parse_color(val: str) -> tuple[int, int, int] | None:
    val = val.strip()
    m = re.fullmatch(r'#([0-9a-fA-F]{6})', val)
    if m:
        h = m.group(1)
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    m = re.fullmatch(r'#([0-9a-fA-F]{3})', val)
    if m:
        h = m.group(1)
        return int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16)
    m = re.fullmatch(r'rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)', val)
    if m:
        return tuple(max(0, min(255, int(g))) for g in m.groups())
    return None


def _fill(tag: str):
    m = re.search(r'fill\s*=\s*"([^"]*)"', tag)
    if not m:
        return None                     # no fill attribute → skip (preserve prior behaviour)
    val = m.group(1).strip()
    if val == "none":
        return None
    rgb = _parse_color(val)
    if rgb is None:
        return _UNRENDERABLE            # present but unparseable → caller bails to cairosvg
    om = re.search(r'fill-opacity\s*=\s*"(%s)"' % _NUM, tag)
    a = int(round(float(om.group(1)) * 255)) if om else 255
    return (rgb[0], rgb[1], rgb[2], max(0, min(255, a)))


def _rects_from_axis_path(d: str) -> list[tuple[float, float, float, float]]:
    """Parse a rectangle-only path (M x y h w v h h -w z ...) into rects."""
    rects: list[tuple[float, float, float, float]] = []
    for sub in re.split(r"(?=[Mm])", d):
        sub = sub.strip()
        if not sub:
            continue
        mm = re.match(r"[Mm]\s*(%s)[\s,]+(%s)" % (_NUM, _NUM), sub)
        if not mm:
            continue
        x0, y0 = float(mm.group(1)), float(mm.group(2))
        hs = re.findall(r"[Hh]\s*(%s)" % _NUM, sub)
        vs = re.findall(r"[Vv]\s*(%s)" % _NUM, sub)
        if not hs or not vs:
            continue
        w = abs(float(hs[0]))
        h = abs(float(vs[0]))
        rects.append((x0, y0, w, h))
    return rects


def _collect_axis_shapes(svg: str):
    """Return list of (x,y,w,h,rgba) if the SVG is axis-aligned only, else None.

    Returns None (→ cairosvg fallback) for ANYTHING the builtin can't render exactly:
    non-rect primitives, curves, transforms, or a present-but-unparseable fill — so we
    never emit a silently PARTIAL raster."""
    if re.search(r"<(circle|ellipse|polygon|polyline|line|text|image)\b", svg):
        return None
    if re.search(r"\btransform\s*=", svg):
        return None  # the builtin ignores transforms — defer to cairosvg rather than misplace shapes
    shapes = []
    for tag in re.findall(r"<rect\b[^>]*>", svg):
        col = _fill(tag)
        if col is _UNRENDERABLE:
            return None
        if col is None:
            continue
        shapes.append((_attr(tag, "x"), _attr(tag, "y"), _attr(tag, "width"), _attr(tag, "height"), col))
    for tag in re.findall(r"<path\b[^>]*>", svg):
        dm = re.search(r'\bd\s*=\s*"([^"]*)"', tag)
        if not dm:
            continue
        d = dm.group(1)
        if _CURVE_CMDS.search(d):
            return None  # curved/line path -> not a builtin-renderable SVG
        col = _fill(tag)
        if col is _UNRENDERABLE:
            return None
        if col is None:
            continue
        for (x, y, w, h) in _rects_from_axis_path(d):
            shapes.append((x, y, w, h, col))
    return shapes


def _target_size(vw: float, vh: float, scale: float | None, width: int | None, height: int | None) -> tuple[int, int]:
    if scale and scale > 0:
        return max(1, round(vw * scale)), max(1, round(vh * scale))
    if width and height:
        return max(1, int(width)), max(1, int(height))
    if width:
        return max(1, int(width)), max(1, round(vh * (width / vw)))
    if height:
        return max(1, round(vw * (height / vh))), max(1, int(height))
    return max(1, round(vw)), max(1, round(vh))


def _render_builtin(svg: str, shapes, vbox, size, bg_rgba) -> Image.Image:
    vx, vy, vw, vh = vbox
    tw, th = size
    sx, sy = tw / vw, th / vh
    overlay = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for (x, y, w, h, col) in shapes:
        x0 = round((x - vx) * sx)
        y0 = round((y - vy) * sy)
        x1 = round((x - vx + w) * sx)
        y1 = round((y - vy + h) * sy)
        if x1 <= x0 or y1 <= y0:
            continue
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=col)  # inclusive -> seamless tiling
    base = Image.new("RGBA", (tw, th), bg_rgba)
    return Image.alpha_composite(base, overlay)


def _render_cairosvg(svg_path: Path, out_png: Path, size, bg_rgba):
    try:
        import cairosvg  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "This SVG has curves/lines and needs a full rasteriser. Install cairosvg "
            "(e.g. `.venv/bin/pip install cairosvg` or `pip install cairosvg`) and retry."
        ) from exc
    tw, th = size
    bg = None if bg_rgba[3] == 0 else "#%02x%02x%02x" % bg_rgba[:3]
    cairosvg.svg2png(url=str(svg_path), write_to=str(out_png), output_width=tw, output_height=th, background_color=bg)


def render_svg(
    svg_path: Path,
    out_png: Path,
    *,
    scale: float | None = None,
    width: int | None = None,
    height: int | None = None,
    background: str = "transparent",
) -> dict:
    svg = Path(svg_path).read_text(encoding="utf-8", errors="ignore")
    vbox = _parse_viewbox(svg)
    if not vbox or vbox[2] <= 0 or vbox[3] <= 0:
        raise ValueError("SVG has no usable viewBox / size.")
    vx, vy, vw, vh = vbox
    size = _target_size(vw, vh, scale, width, height)
    bg_rgba = _BG_PRESETS.get(background, _BG_PRESETS["transparent"])
    out_png = Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)

    shapes = _collect_axis_shapes(svg)
    if shapes is not None and shapes:
        img = _render_builtin(svg, shapes, vbox, size, bg_rgba)
        if background != "transparent":
            img = img.convert("RGB")
        img.save(out_png)
        backend = "builtin"
    else:
        _render_cairosvg(svg_path, out_png, size, bg_rgba)
        backend = "cairosvg"
    return {
        "backend": backend,
        "native": [round(vw, 2), round(vh, 2)],
        "size": list(size),
        "background": background,
        "output": str(out_png),
    }


def cairosvg_available() -> bool:
    try:
        import cairosvg  # noqa: F401
        return True
    except ImportError:
        return False


def main() -> int:
    p = argparse.ArgumentParser(description="Rasterise an SVG to PNG at any size.")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--scale", type=float, help="Multiply native size by N.")
    g.add_argument("--width", type=int, help="Target width (px); height keeps aspect.")
    g.add_argument("--height", type=int, help="Target height (px); width keeps aspect.")
    p.add_argument("--bg", default="transparent", choices=list(_BG_PRESETS), help="Background.")
    args = p.parse_args()
    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2
    import json
    try:
        info = render_svg(args.input, args.output, scale=args.scale, width=args.width, height=args.height, background=args.bg)
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
