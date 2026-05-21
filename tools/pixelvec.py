#!/usr/bin/env python3
"""Pixel art -> exact square-grid SVG.

The inverse of the vtracer path: no smoothing, no spline fitting. We recover the
native pixel grid of (possibly upscaled / anti-aliased) pixel art, snap each cell
to a single colour, and emit axis-aligned squares.

Pipeline:
  1. Grid recovery   -- autocorrelation of edge energy finds the cell size; a
                        boundary-energy ratio test rejects false grids so true
                        pixel-to-pixel art (Minecraft textures) stays native.
  2. Colour recovery -- per cell take the mode (default) / median / center colour
                        over an eroded interior so anti-aliased borders don't leak.
  3. Square emission -- merged runs (default), one rect per pixel, or per-colour
                        paths. Coordinates are in NATIVE pixel units with
                        shape-rendering="crispEdges" so output scales perfectly.

CLI:
  pixelvec.py IN OUT [--mode merged|pixels|path] [--sample mode|median|center]
              [--gridx N] [--gridy N] [--quantize N] [--key-corner]
Prints a one-line JSON summary (grid, rect count) to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


# ---------------------------------------------------------------- grid recovery
def edge_energy(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-boundary colour-change energy along each axis. rgb: (H,W,3) float."""
    dx = np.abs(np.diff(rgb, axis=1)).sum(axis=2)  # (H, W-1)
    dy = np.abs(np.diff(rgb, axis=0)).sum(axis=2)  # (H-1, W)
    return dx.sum(axis=0), dy.sum(axis=1)


def _integer_scale(rgb: np.ndarray, max_scale: int = 64, tol: float = 1.0) -> int:
    """Largest integer s that divides both dimensions and leaves every s×s block
    (nearly) constant. This is the exact, robust signature of a nearest-neighbour
    integer upscale (Minecraft textures, exported sprites) and yields a uniform
    scale on both axes. Returns 1 when no such block grid exists (native art or
    non-integer / anti-aliased resampling -> caller falls back to spectral)."""
    h, w = rgb.shape[:2]
    upper = min(max_scale, w // 2, h // 2)
    best = 1
    for s in range(2, upper + 1):
        if w % s or h % s:
            continue
        blocks = rgb.reshape(h // s, s, w // s, s, rgb.shape[2])
        if blocks.var(axis=(1, 3)).mean() <= tol:
            best = s
    return best


def _spectral_period(energy: np.ndarray) -> tuple[float, float]:
    """Dominant spatial period of the edge-energy signal via its power spectrum.

    Works in the frequency domain and ignores DC + ultra-low frequencies, so it
    is robust to the smooth ramps that bilinear/anti-aliased upscaling produces
    (where a plain autocorrelation argmax collapses onto the smallest lag).

    Returns (period_px, strength) where strength = dominant-bin power / mean band
    power. A genuine pixel grid yields one sharp dominant bin (high strength);
    a true gradient spreads its power and scores low.
    """
    n = energy.size
    if n < 8:
        return 1.0, 0.0
    e = energy - energy.mean()
    if not np.any(e):
        return 1.0, 0.0
    power = np.abs(np.fft.rfft(e * np.hanning(n))) ** 2
    freqs = np.fft.rfftfreq(n)  # cycles/px in [0, 0.5]
    # plausible cells: period in [2, n/3]  ->  require >=3 repeats to trust a grid
    band = (freqs >= 3.0 / n) & (freqs <= 0.5)
    if not band.any():
        return 1.0, 0.0
    masked = np.where(band, power, 0.0)
    k = int(np.argmax(masked))
    if masked[k] <= 0:
        return 1.0, 0.0
    strength = masked[k] / (power[band].mean() or 1e-9)
    # sub-bin parabolic refine on the frequency peak
    fk = freqs[k]
    if 1 <= k < freqs.size - 1:
        y0, y1, y2 = power[k - 1], power[k], power[k + 1]
        denom = y0 - 2 * y1 + y2
        if denom:
            df = 0.5 * (y0 - y2) / denom
            fk = freqs[k] + float(np.clip(df, -0.5, 0.5)) * (freqs[1] - freqs[0])
    return (1.0 / fk if fk > 0 else 1.0), float(strength)


_SPECTRAL_CONF = 8.0  # min dominant-bin / mean-band power ratio to trust a grid


def detect_grid(rgba: np.ndarray) -> tuple[int, int]:
    """Recover (nx, ny) native cell counts.

    1. Block-consistency finds a clean nearest-neighbour *integer* upscale exactly
       and uniformly (Minecraft textures, exported sprites).
    2. Otherwise per-axis spectral detection handles non-integer nearest scaling.
       Upscaling is virtually always uniform, so a confident axis lends its scale
       to a weak one (sprites with repeated/transparent rows give a faint signal
       on that axis). Neither axis confident -> native (gradients, real photos).
    """
    h, w = rgba.shape[:2]
    rgb = rgba[..., :3].astype(np.float32)

    scale = _integer_scale(rgb)
    if scale > 1:
        return w // scale, h // scale

    ex, ey = edge_energy(rgb)
    px, sx = _spectral_period(ex)
    py, sy = _spectral_period(ey)
    cx = sx >= _SPECTRAL_CONF and px >= 1.5
    cy = sy >= _SPECTRAL_CONF and py >= 1.5
    if cx and cy:
        period_x, period_y = px, py
    elif cx:
        period_x = period_y = px  # uniform-scale transfer
    elif cy:
        period_x = period_y = py
    else:
        return w, h  # native
    nx = max(1, min(w, round(w / period_x)))
    ny = max(1, min(h, round(h / period_y)))
    return nx, ny


# -------------------------------------------------------------- colour recovery
def _cell_color(patch: np.ndarray, sample: str) -> tuple[int, int, int, int] | None:
    """patch: (h,w,4) uint8 region for one native cell. None => transparent."""
    if patch.size == 0:
        return None
    h, w = patch.shape[:2]
    if h >= 4 and w >= 4:  # erode interior to dodge anti-aliased borders
        my, mx = max(1, h // 4), max(1, w // 4)
        patch = patch[my:h - my, mx:w - mx]
    alpha = patch[..., 3]
    opaque = alpha >= 128
    if opaque.mean() < 0.5:
        return None
    rgb = patch[..., :3][opaque].astype(np.int32)
    a = int(np.median(alpha[opaque]))
    if sample == "center":
        c = rgb[len(rgb) // 2]
    elif sample == "median":
        c = np.median(rgb, axis=0)
    else:  # mode: most common colour after light quantisation, then its true median
        q = (rgb // 8)
        keys = q[:, 0] * 65536 + q[:, 1] * 256 + q[:, 2]
        vals, counts = np.unique(keys, return_counts=True)
        sel = keys == vals[counts.argmax()]
        c = np.median(rgb[sel], axis=0)
    return (int(c[0]), int(c[1]), int(c[2]), a)


def build_grid(rgba: np.ndarray, nx: int, ny: int, sample: str):
    """Sample an (ny, nx) grid of colours via linspace cell mapping."""
    H, W = rgba.shape[:2]
    xe = np.linspace(0, W, nx + 1).round().astype(int)
    ye = np.linspace(0, H, ny + 1).round().astype(int)
    grid = [[None] * nx for _ in range(ny)]
    for j in range(ny):
        y0, y1 = ye[j], max(ye[j] + 1, ye[j + 1])
        for i in range(nx):
            x0, x1 = xe[i], max(xe[i] + 1, xe[i + 1])
            grid[j][i] = _cell_color(rgba[y0:y1, x0:x1], sample)
    return grid


def quantize_grid(grid, n_colors: int):
    """Snap opaque cell colours to an n-colour median-cut palette."""
    ny, nx = len(grid), len(grid[0])
    arr = np.zeros((ny, nx, 3), dtype=np.uint8)
    for j in range(ny):
        for i in range(nx):
            c = grid[j][i]
            if c is not None:
                arr[j, i] = c[:3]
    pal = np.array(
        Image.fromarray(arr).quantize(colors=max(2, n_colors), method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    )
    for j in range(ny):
        for i in range(nx):
            if grid[j][i] is not None:
                r, g, b = pal[j, i]
                grid[j][i] = (int(r), int(g), int(b), grid[j][i][3])
    return grid


def key_out_corner(grid, tol: int = 24):
    """Treat the dominant corner colour as transparent (background key-out)."""
    ny, nx = len(grid), len(grid[0])
    corners = [grid[0][0], grid[0][nx - 1], grid[ny - 1][0], grid[ny - 1][nx - 1]]
    corners = [c for c in corners if c is not None]
    if not corners:
        return grid
    key = max(set(corners), key=corners.count)
    kr, kg, kb, _ = key
    for j in range(ny):
        for i in range(nx):
            c = grid[j][i]
            if c is not None and abs(c[0] - kr) + abs(c[1] - kg) + abs(c[2] - kb) <= tol:
                grid[j][i] = None
    return grid


# ------------------------------------------------------------- square emission
def _hex(c) -> str:
    return f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}"


def merge_rects(grid):
    """Greedy run-length + vertical coalesce -> list of [x,y,w,h,(r,g,b,a)]."""
    ny, nx = len(grid), len(grid[0])
    out: list[list] = []
    active: dict = {}  # (x,w,color) -> index in out whose bottom touches this row
    for y in range(ny):
        row: list[tuple[int, int, tuple]] = []
        x = 0
        while x < nx:
            c = grid[y][x]
            if c is None:
                x += 1
                continue
            x2 = x + 1
            while x2 < nx and grid[y][x2] == c:
                x2 += 1
            row.append((x, x2 - x, c))
            x = x2
        new_active: dict = {}
        for (rx, rw, c) in row:
            key = (rx, rw, c)
            if key in active:
                idx = active[key]
                out[idx][3] += 1
            else:
                out.append([rx, y, rw, 1, c])
                idx = len(out) - 1
            new_active[key] = idx
        active = new_active
    return out


def grid_to_svg(grid, mode: str) -> str:
    ny, nx = len(grid), len(grid[0])
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {nx} {ny}" '
        f'width="{nx}" height="{ny}" shape-rendering="crispEdges">'
    )
    body: list[str] = []
    if mode == "pixels":
        for y in range(ny):
            for x in range(nx):
                c = grid[y][x]
                if c is None:
                    continue
                op = "" if c[3] >= 255 else f' fill-opacity="{c[3] / 255:.3f}"'
                body.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{_hex(c)}"{op}/>')
    elif mode == "path":
        by_color: dict = {}
        for (x, y, w, h, c) in merge_rects(grid):
            by_color.setdefault(c, []).append(f"M{x} {y}h{w}v{h}h{-w}z")
        for c, segs in by_color.items():
            op = "" if c[3] >= 255 else f' fill-opacity="{c[3] / 255:.3f}"'
            body.append(f'<path fill="{_hex(c)}"{op} d="{"".join(segs)}"/>')
    else:  # merged
        for (x, y, w, h, c) in merge_rects(grid):
            op = "" if c[3] >= 255 else f' fill-opacity="{c[3] / 255:.3f}"'
            body.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{_hex(c)}"{op}/>')
    return head + "".join(body) + "</svg>"


# -------------------------------------------------------------------------- API
def vectorize_pixel_art(
    input_path: Path,
    output_path: Path,
    *,
    mode: str = "merged",
    sample: str = "mode",
    gridx: int = 0,
    gridy: int = 0,
    quantize: int = 0,
    key_corner: bool = False,
) -> dict:
    rgba = np.array(Image.open(input_path).convert("RGBA"))
    H, W = rgba.shape[:2]
    if gridx > 0 and gridy > 0:
        nx, ny = gridx, gridy
    else:
        dnx, dny = detect_grid(rgba)
        nx = gridx if gridx > 0 else dnx
        ny = gridy if gridy > 0 else dny
    grid = build_grid(rgba, nx, ny, sample)
    if quantize and quantize >= 2:
        grid = quantize_grid(grid, quantize)
    if key_corner:
        grid = key_out_corner(grid)
    svg = grid_to_svg(grid, mode)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(svg, encoding="utf-8")
    n_shapes = svg.count("<rect") + svg.count("<path")
    n_opaque = sum(1 for row in grid for c in row if c is not None)
    return {
        "source_size": [W, H],
        "grid": [nx, ny],
        "downscale": [round(W / nx, 2), round(H / ny, 2)],
        "shapes": n_shapes,
        "opaque_cells": n_opaque,
        "mode": mode,
        "bytes": len(svg),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Pixel art -> square-grid SVG.")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--mode", choices=["merged", "pixels", "path"], default="merged")
    p.add_argument("--sample", choices=["mode", "median", "center"], default="mode")
    p.add_argument("--gridx", type=int, default=0, help="Force native width in cells (0 = auto).")
    p.add_argument("--gridy", type=int, default=0, help="Force native height in cells (0 = auto).")
    p.add_argument("--quantize", type=int, default=0, help="Snap to N-colour palette (0 = keep).")
    p.add_argument("--key-corner", action="store_true", help="Make the dominant corner colour transparent.")
    args = p.parse_args()
    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2
    info = vectorize_pixel_art(
        args.input, args.output,
        mode=args.mode, sample=args.sample,
        gridx=args.gridx, gridy=args.gridy,
        quantize=args.quantize, key_corner=args.key_corner,
    )
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
