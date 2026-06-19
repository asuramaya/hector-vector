"""Engines layer (#29 split): the vectorize / trace / raster-op machinery — the
program's image→vector core. Trace config + mask building + preprocessing, the B&W and
colour vtracer paths, the planar clean-colour tracer, pixelvec, the raster ops
(upscale / remove-bg), and the pluggable VECTORIZE_ENGINES / RASTER_OPS registries with
their single dispatch entry points (vectorize_svg / apply_raster_op).

Sits above models (ensure_tools_ready + build_ai_cutout/build_upscale_spandrel + SR_MODELS),
jobs (run_subprocess), and files (resolve_source_url); the pipeline + HTTP handler call
vectorize_svg / apply_raster_op / the *_info registries from here. Pure down-deps + the
external trace tools (pixelvec / simplify_svg) and engine.py cutout helpers. Re-exported
behind the server facade.
"""
from __future__ import annotations

import copy
import hashlib
import re
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

import numpy as np
from PIL import Image

from hvserver.paths import (
    OUTPUTS_DIR, SCRATCH_DIR, REALESRGAN_BIN, REALESRGAN_DIR, VTRACER_BIN,
    TRACE_MAX_DIM, TRACE_ABS_MAX_DIM, rembg_installed,
)
from hvserver.jobs import run_subprocess, log_subprocess_lines
from hvserver.models import ensure_tools_ready, build_ai_cutout, build_upscale_spandrel, SR_MODELS
from hvserver.files import resolve_source_url

import pixelvec        # noqa: E402  (resolved via paths' sys.path.insert(TOOLS_DIR))
import simplify_svg    # noqa: E402
from engine import build_alpha_cutout, build_monochrome_assets, has_meaningful_alpha  # noqa: E402


def build_chromakey_cutout(input_path: Path, output_path: Path) -> None:
    rgba = Image.open(input_path).convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            green_dominance = g - max(r, b)
            if g > 70 and green_dominance > 25:
                alpha = max(0, 255 - int(green_dominance * 4))
                pixels[x, y] = (r, g, b, alpha)
    rgba.save(output_path)


def validate_cutout_png(path: Path) -> None:
    rgba = Image.open(path).convert("RGBA")
    alpha = rgba.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"Blank cutout: {path.name} — nothing opaque (no subject found).")
    # Reject only an ESSENTIALLY-empty cutout, not a legitimately small subject. The bar is a
    # low absolute floor + a tight proportional term, so a tiny logo passes while a
    # background-key that found nothing still fails with a clear message.
    opaque = sum(1 for value in alpha.getdata() if value >= 8)
    if opaque < max(8, rgba.width * rgba.height // 40000):
        raise ValueError(f"Cutout nearly empty: {path.name} — the image looks flat / has no distinct subject.")


def validate_mask_png(path: Path) -> None:
    mask = Image.open(path).convert("L")
    black = sum(1 for value in mask.getdata() if value < 128)
    if black < max(8, mask.width * mask.height // 40000):
        raise ValueError(f"Mask nearly empty: {path.name} — the image looks flat / has no distinct subject.")


def validate_svg_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if "<svg" not in text or "<path" not in text:
        raise ValueError(f"SVG missing paths: {path.name}")
    # Non-empty iff some path carries real geometry — a draw command (L/C/Q/A/H/V, either
    # case), not just a lone moveto. This separates a genuinely empty/failed trace from a
    # legitimately SIMPLE one: a single small shape can be far under any byte threshold.
    if not any(re.search(r"[lcqahv]", d, re.IGNORECASE) for d in re.findall(r'd="([^"]*)"', text)):
        raise ValueError(f"SVG has no drawable geometry: {path.name}")


# Post-trace simplification strength → (per-subpath tolerance fraction, corner angle).
# Feature-relative tolerance keeps node count stable across resolutions. "off" skips.
SIMPLIFY_LEVELS = {
    "off": None,
    "light": (0.012, 72.0),
    "medium": (0.025, 70.0),
    "strong": (0.05, 68.0),
}


def simplify_trace_file(svg_path: Path, level: str, log) -> None:
    """Refit a freshly-traced SVG to minimal cubics in place (no-op for 'off' or if
    it wouldn't reduce node count). vtracer over-segments; this is what brings a
    logo down from thousands of anchors to ~the hundred a human would draw."""
    params = SIMPLIFY_LEVELS.get(level)
    if not params:
        return
    frac, ang = params
    try:
        text = svg_path.read_text(encoding="utf-8", errors="ignore")
        new, stats = simplify_svg.simplify_svg_text(text, frac=frac, corner_ang=ang)
    except Exception as exc:  # never let simplification sink an otherwise-good trace
        log(f"Simplify skipped ({exc.__class__.__name__}: {exc}).")
        return
    if stats["nodes_after"] and stats["nodes_after"] < stats["nodes_before"]:
        svg_path.write_text(new, encoding="utf-8")
        log(f"Simplified {stats['nodes_before']} → {stats['nodes_after']} nodes ({level}).")


def trace_config(payload: dict) -> dict:
    def clamp_float(value: object, low: float, high: float, default: float) -> str:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        parsed = max(low, min(high, parsed))
        if parsed.is_integer():
            return str(int(parsed))
        return str(parsed)

    mode = payload.get("trace_mode", "spline")
    if mode not in {"spline", "polygon", "pixel"}:
        mode = "spline"
    # Color trace runs on the original RGB image (not the monochrome mask). Style
    # picks the gradient granularity: poster = flat, limited palette (bigger step →
    # fewer layers); photo = smooth gradients (smaller step → more layers).
    colormode = "color" if str(payload.get("trace_colormode", "bw")).strip().lower() == "color" else "bw"
    color_style = payload.get("trace_color_style", "poster")
    if color_style not in {"poster", "photo", "clean"}:
        color_style = "poster"
    hierarchical = payload.get("trace_hierarchical", "stacked")
    if hierarchical not in {"stacked", "cutout"}:
        hierarchical = "stacked"
    gradient_step = "16" if color_style == "poster" else "8"
    # Poster style collapses the image to a real palette before tracing (median-cut,
    # no dither). This is what stops anti-aliasing fringes on near-binary art from
    # tracing as dozens of thin gray staircase layers. The "Colors" control (1–8)
    # maps to an actual palette size; photo style skips this to keep gradients.
    cp_int = int(float(clamp_float(payload.get("color_precision", "6"), 1, 8, 6)))
    poster_colors = {1: 2, 2: 3, 3: 4, 4: 6, 5: 8, 6: 12, 7: 16, 8: 24}[cp_int]
    simplify = payload.get("trace_simplify", "medium")
    if simplify not in SIMPLIFY_LEVELS:
        simplify = "medium"
    return {
        "mode": mode,
        "colormode": colormode,
        "color_style": color_style,
        "hierarchical": hierarchical,
        "gradient_step": gradient_step,
        "poster_colors": poster_colors,
        "simplify": simplify,
        "filter_speckle": clamp_float(payload.get("filter_speckle", "6"), 0, 32, 6),
        "corner_threshold": clamp_float(payload.get("corner_threshold", "85"), 30, 180, 85),
        "segment_length": clamp_float(payload.get("segment_length", "4.5"), 3.5, 10, 4.5),
        "splice_threshold": clamp_float(payload.get("splice_threshold", "45"), 0, 180, 45),
        "path_precision": clamp_float(payload.get("path_precision", "2"), 0, 10, 2),
        "color_precision": clamp_float(payload.get("color_precision", "6"), 1, 8, 6),
    }


def mask_config(payload: dict) -> dict:
    raw_target = payload.get("target_max_dim")
    target: int | None = None
    if raw_target not in (None, "", 0, "0"):
        try:
            value = int(float(raw_target))
        except (TypeError, ValueError):
            value = 0
        if value > 32:
            target = max(64, min(16384, value))
    raw_threshold = payload.get("mask_threshold")
    threshold: int | None = None
    if raw_threshold not in (None, "", "auto"):
        try:
            value = int(float(raw_threshold))
        except (TypeError, ValueError):
            value = -1
        if 16 <= value <= 240:
            threshold = value
    return {"target_max_dim": target, "mask_threshold": threshold}


def apply_preprocess(src: Path, dest: Path, *, target_max_dim: int | None) -> Path:
    if target_max_dim is None:
        return src
    with Image.open(src) as im:
        w, h = im.size
        longest = max(w, h)
        if longest <= target_max_dim:
            return src
        ratio = target_max_dim / float(longest)
        new_size = (max(1, int(round(w * ratio))), max(1, int(round(h * ratio))))
        resized = im.convert("RGBA").resize(new_size, Image.Resampling.LANCZOS)
        resized.save(dest)
    return dest


# key -> [path, last_used_monotonic]. Insertion order is the LRU order (hits move to end).
_preprocess_cache: dict[tuple, list] = {}
_preprocess_cache_lock = threading.Lock()
_PREPROCESS_CACHE_MAX = 24
_PREPROCESS_EVICT_GRACE = 60.0   # don't unlink an evicted file used within this window (a trace may hold it)


def preprocess_for_trace(src: Path, target_max_dim: int) -> Path:
    """Downscale `src` to target_max_dim ONCE and reuse it across live-preview
    traces. The live preview re-traces on every slider drag; without this, each
    trace re-resized a multi-megapixel source (~0.35s) before vtracer even ran.
    Cached downscaled files live in SCRATCH_DIR, keyed by (path, mtime, size, dim)
    so an edited source busts the cache. Returns `src` unchanged when it already
    fits the cap (apply_preprocess's own fast path). Read-only: the engines trace
    FROM this file and never mutate it, so sharing it across calls is safe."""
    try:
        st = src.stat()
    except OSError:
        return src
    key = (str(src), int(st.st_mtime_ns), int(st.st_size), int(target_max_dim))
    with _preprocess_cache_lock:
        hit = _preprocess_cache.get(key)
        if hit is not None and (hit[0] == src or hit[0].exists()):
            hit[1] = time.monotonic()                       # mark recently used
            _preprocess_cache[key] = _preprocess_cache.pop(key)   # move to LRU tail
            return hit[0]
    # Miss — resize outside the lock (CPU/IO bound), then publish under it.
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(repr(key).encode()).hexdigest()[:16]
    dest = SCRATCH_DIR / f"pp-{digest}{src.suffix.lower() or '.png'}"
    out = apply_preprocess(src, dest, target_max_dim=target_max_dim)
    with _preprocess_cache_lock:
        _preprocess_cache[key] = [out, time.monotonic()]
        now = time.monotonic()
        while len(_preprocess_cache) > _PREPROCESS_CACHE_MAX:
            old_key, (old_path, used) = next(iter(_preprocess_cache.items()))
            del _preprocess_cache[old_key]
            # Only unlink if it hasn't been handed out recently — a concurrent trace may
            # still be reading this exact (content-addressed) file. Skipped files are
            # bounded by _prune_scratch_inline's pp-* sweep.
            if now - used < _PREPROCESS_EVICT_GRACE:
                continue
            try:
                if old_path != src and old_path.parent == SCRATCH_DIR and old_path.exists():
                    old_path.unlink()
            except OSError:
                pass
    return out


def build_mask_with_overrides(src: Path, mask_path: Path, cutout_path: Path | None, mask_cfg: dict) -> None:
    threshold = mask_cfg.get("mask_threshold")
    if threshold is None:
        build_monochrome_assets(src, mask_output=mask_path, cutout_output=cutout_path)
        return
    rgba = Image.open(src).convert("RGBA")
    gray = np.asarray(rgba.convert("L"))
    alpha = np.asarray(rgba.getchannel("A"))
    mask_bool = gray <= int(threshold)
    if alpha.max() > 8:
        mask_bool = mask_bool & (alpha >= 8)
    mask_u8 = (mask_bool.astype(np.uint8) * 255)
    traced = Image.new("L", rgba.size, 255)
    traced.paste(0, mask=Image.fromarray(mask_u8, mode="L"))
    traced.save(mask_path)
    if cutout_path is not None:
        build_alpha_cutout(src, cutout_path)


# (#29 files layer -> hvserver/files.py - region 2/3: work-items + outputs library + input selection)


# (#29 jobs layer -> hvserver/jobs.py: clean_log_line + log_subprocess_lines + run_subprocess)




def source_has_alpha(path: Path) -> bool:
    return has_meaningful_alpha(Image.open(path).convert("RGBA"))


def deterministic_upscale(src: Path, dest: Path, scale: int) -> None:
    rgba = Image.open(src).convert("RGBA")
    resized = rgba.resize((rgba.width * scale, rgba.height * scale), Image.Resampling.LANCZOS)
    resized.save(dest)


def trace_mask_to_svg(mask_path: Path, svg_path: Path, trace: dict, log) -> None:
    lines = run_subprocess(
        [
            str(VTRACER_BIN),
            "--input",
            str(mask_path),
            "--output",
            str(svg_path),
            "--preset",
            "bw",
            "--mode",
            trace["mode"],
            "--filter_speckle",
            trace["filter_speckle"],
            "--corner_threshold",
            trace["corner_threshold"],
            "--segment_length",
            trace["segment_length"],
            "--splice_threshold",
            trace["splice_threshold"],
            "--path_precision",
            trace["path_precision"],
            "--color_precision",
            trace["color_precision"],
        ]
    )
    log_subprocess_lines(log, lines)


def flatten_rgba_to_white(src: Path, dest: Path) -> Image.Image:
    """Composite a (possibly transparent) image onto opaque white, drop alpha.

    Color tracing needs a real RGB image: vtracer has no notion of alpha, so a
    transparent cutout would otherwise trace its zeroed RGB as a black slab. White
    is the neutral backdrop the trace can later strip. Returns the RGB image."""
    rgba = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    bg.alpha_composite(rgba)
    rgb = bg.convert("RGB")
    rgb.save(dest)
    return rgb


def prepare_color_input(src: Path, dest: Path, trace: dict) -> None:
    """Flatten to white, then — for poster style — collapse to a small palette.

    The poster pass (median-cut, dither OFF) is the fix for the staircase/fill-spam
    edge case: anti-aliased near-binary art otherwise spawns one thin gray layer per
    AA shade, each a pixel staircase. A real palette merges those fringes into clean
    flat regions. Photo style is left untouched so gradients survive."""
    rgb = flatten_rgba_to_white(src, dest)
    if trace.get("color_style") == "poster":
        k = int(trace.get("poster_colors", 16))
        posterized = rgb.quantize(colors=max(2, k), method=Image.Quantize.MEDIANCUT,
                                  dither=Image.Dither.NONE).convert("RGB")
        posterized.save(dest)


def image_is_near_binary(path: Path) -> bool:
    """True when an image is effectively grayscale and ~2-tone — the case where a
    Color trace is strictly worse than B&W (far more nodes for no real color)."""
    im = Image.open(path).convert("RGB")
    arr = np.asarray(im.resize((128, 128)), dtype=np.float32)
    # Low chroma (near-grayscale; the loose bound tolerates upscale/JPEG color
    # fringing) AND most pixels piled at the black/white extremes (2-tone).
    chroma = float((arr.max(axis=2) - arr.min(axis=2)).mean())
    luma = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    extremes = float(((luma < 48) | (luma > 208)).mean())
    return chroma < 40 and extremes > 0.82


def trace_color_to_svg(src_path: Path, svg_path: Path, trace: dict, log) -> None:
    """Full-color trace straight off the RGB image.

    Flags are set explicitly — never via --preset, whose `bw` variant silently
    collapses the output to black/white (the same trap that bites the mask path)."""
    lines = run_subprocess(
        [
            str(VTRACER_BIN),
            "--input",
            str(src_path),
            "--output",
            str(svg_path),
            "--colormode",
            "color",
            "--hierarchical",
            trace["hierarchical"],
            "--mode",
            trace["mode"],
            "--filter_speckle",
            trace["filter_speckle"],
            "--corner_threshold",
            trace["corner_threshold"],
            "--segment_length",
            trace["segment_length"],
            "--splice_threshold",
            trace["splice_threshold"],
            "--path_precision",
            trace["path_precision"],
            "--color_precision",
            trace["color_precision"],
            "--gradient_step",
            trace["gradient_step"],
        ]
    )
    log_subprocess_lines(log, lines)


def pixelvec_config(payload: dict) -> dict:
    def clamp_int(value: object, low: int, high: int, default: int) -> int:
        try:
            parsed = int(float(value))
        except (TypeError, ValueError):
            return default
        return max(low, min(high, parsed))

    mode = payload.get("pv_mode", "merged")
    if mode not in {"merged", "pixels", "path"}:
        mode = "merged"
    sample = payload.get("pv_sample", "mode")
    if sample not in {"mode", "median", "center"}:
        sample = "mode"
    # Grid: "auto" (0) or a forced cell count. Accept a single pv_grid or per-axis.
    raw_grid = payload.get("pv_grid")
    gx = gy = 0
    if raw_grid not in (None, "", "auto", "0", 0):
        gx = gy = clamp_int(raw_grid, 0, 4096, 0)
    gx = clamp_int(payload.get("pv_gridx", gx), 0, 4096, gx)
    gy = clamp_int(payload.get("pv_gridy", gy), 0, 4096, gy)
    quantize = clamp_int(payload.get("pv_quantize", 0), 0, 256, 0)
    if quantize == 1:
        quantize = 0
    return {
        "mode": mode,
        "sample": sample,
        "gridx": gx,
        "gridy": gy,
        "quantize": quantize,
        "key_corner": bool(payload.get("pv_key_corner")),
    }


def validate_pixelvec_svg(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if "<svg" not in text or ("<rect" not in text and "<path" not in text):
        raise ValueError(f"Pixel SVG missing shapes: {path.name}")


def derive_mask_from_alpha(cutout_path: Path, mask_path: Path, threshold: int = 128) -> None:
    rgba = Image.open(cutout_path).convert("RGBA")
    alpha = rgba.getchannel("A")
    binary = alpha.point(lambda v, t=threshold: 0 if v >= t else 255)
    binary.convert("L").save(mask_path)


def _km_palette(rgb: Image.Image, k: int, iters: int = 6):
    """k-means on pixel colours, seeded farthest-point from the densest coarse bin.
    Snaps anti-aliased fringe to the TRUE dominant colours instead of averaging them
    (median-cut's flaw) — the key to a clean flat-logo trace. Returns (centroids, idx)."""
    arr = np.asarray(rgb, dtype=np.float32).reshape(-1, 3)
    step = max(1, len(arr) // 20000)
    samp = arr[::step]
    coarse = (samp // 16).astype(int)
    key = coarse[:, 0] * 1024 + coarse[:, 1] * 32 + coarse[:, 2]
    # Seed from a pixel that actually lives in the densest coarse bin. NOTE: argmax over
    # the bincount returns the most-frequent KEY VALUE (0..15855), not a sample index —
    # indexing `samp` with it is a bug that only stayed hidden on large images (where samp
    # happened to be long enough to be in-bounds) and crashed on small ones. Map back to a
    # real sample in that bin instead.
    dominant = int(np.argmax(np.bincount(key)))
    seeds = [samp[int(np.flatnonzero(key == dominant)[0])]]
    for _ in range(k - 1):
        d = np.min([np.sum((samp - s) ** 2, 1) for s in seeds], 0)
        seeds.append(samp[int(np.argmax(d))])
    C = np.array(seeds, dtype=np.float32)
    for _ in range(iters):
        lab = np.argmin(((samp[:, None, :] - C[None, :, :]) ** 2).sum(2), 1)
        for j in range(k):
            m = lab == j
            if m.any():
                C[j] = samp[m].mean(0)
    full = np.argmin(((arr[:, None, :] - C[None, :, :]) ** 2).sum(2), 1)
    return C.round().astype(int), full.reshape(np.asarray(rgb).shape[:2])


def _bake_translate(d: str, tx: float, ty: float) -> str:
    """vtracer emits each <path> with its own translate; bake it into the absolute
    coordinates so paths from different layers share one coordinate space."""
    k = [0]
    def repl(m):
        v = float(m.group()) + (tx if k[0] % 2 == 0 else ty)
        k[0] += 1
        return f"{v:.2f}"
    return re.sub(r"-?\d*\.?\d+", repl, d)


def _trace_mask_to_d(mask_bool: np.ndarray, tmp: Path, speckle: int = 4) -> str:
    """Trace one binary layer (True = ink) with vtracer B&W and return one absolute
    `d` string (holes preserved → letter counters survive)."""
    img = Image.fromarray(np.where(mask_bool, 0, 255).astype(np.uint8), "L")
    src = tmp / "m.png"; out = tmp / "m.svg"; img.save(src)
    run_subprocess([str(VTRACER_BIN), "--input", str(src), "--output", str(out),
                    "--preset", "bw", "--mode", "spline", "--filter_speckle", str(speckle)])
    txt = out.read_text(encoding="utf-8", errors="ignore")
    ds = []
    for tag in re.findall(r"<path\b[^>]*>", txt):
        dm = re.search(r'd="([^"]*)"', tag)
        if not dm:
            continue
        tm = re.search(r"translate\(([-\d.]+)[ ,]([-\d.]+)\)", tag)
        tx, ty = (float(tm.group(1)), float(tm.group(2))) if tm else (0.0, 0.0)
        ds.append(_bake_translate(dm.group(1), tx, ty) if (tx or ty) else dm.group(1))
    return " ".join(ds)


def _snap_logo_color(c) -> tuple:
    """Nudge a near-pure centroid to the clean colour a logo wants (#ff0000, not #cc1010)."""
    r, g, b = int(c[0]), int(c[1]), int(c[2])
    if r > 180 and g > 180 and b > 180:
        return (255, 255, 255)
    if r < 60 and g < 60 and b < 60:
        return (0, 0, 0)
    if r > 120 and g < 90 and b < 90:
        return (min(255, int(r * 1.25)), 0, 0)
    return (r, g, b)


def clean_color_trace(src: Path, n: int, simplify: str, *, max_dim: int | None = None,
                      drop_bg: bool = True, speckle: int = 4, do_snap: bool = True) -> str:
    """Region/planar colour trace for FLAT logos — the fix for vtracer-stacked halos.
    Hard-quantise to N true colours (k-means), trace EACH colour as its own B&W mask
    (non-overlapping, holes preserved), drop the background → transparent, and assemble
    bottom(lightest)→top(darkest). No inter-colour halos, counters intact, clean palette."""
    ensure_tools_ready("vtracer")
    rgba = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    bg.alpha_composite(rgba)
    rgb = bg.convert("RGB")
    if max_dim:
        rgb.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
    colors_arr, idx = _km_palette(rgb, max(2, n))
    colors = [tuple(int(x) for x in c) for c in colors_arr]
    H, W = idx.shape
    border = np.concatenate([idx[0, :], idx[-1, :], idx[:, 0], idx[:, -1]])
    bg_idx = int(np.bincount(border, minlength=len(colors)).argmax())
    luma = lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    order = [i for i in range(len(colors)) if not (drop_bg and i == bg_idx)]
    order.sort(key=lambda i: -luma(colors[i]))      # lightest first (bottom) → darkest on top
    params = SIMPLIFY_LEVELS.get(simplify)
    layers = []
    with tempfile.TemporaryDirectory(prefix="hv-clean-") as td:
        tmp = Path(td)
        for i in order:
            mask = idx == i
            if int(mask.sum()) < 4:
                continue
            d = _trace_mask_to_d(mask, tmp, speckle)
            if params and d:
                try:
                    d, _ = simplify_svg.simplify_d(d, params[0], params[1])
                except Exception:  # noqa: BLE001
                    pass
            if d:
                layers.append((_snap_logo_color(colors[i]) if do_snap else colors[i], d))
    body = "".join(f'<path d="{d}" fill="#{c[0]:02x}{c[1]:02x}{c[2]:02x}"/>' for c, d in layers)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
            f'width="{W}" height="{H}">{body}</svg>')


# ---------------------------------------------------------------- raster ops (registry)
# In-place raster→raster transforms for the panel (upscale / remove-bg), each run
# SYNCHRONOUSLY into the scratch dir and returned as a resolvable URL (the canvas swaps
# to it; no job, no library copy — the dump/choppy fix). Pluggable like VECTORIZE_ENGINES
# and described by the same param-schema shape, so the client renders + live-wires both
# stages from one source of truth (/api/raster-ops). `apply(src, dest_dir, stem, stamp,
# payload, log) → output Path`.

def _op_upscale(src, dest_dir, stem, stamp, payload, log):
    for old in dest_dir.glob(f"{stem}.up.*.png"):
        old.unlink(missing_ok=True)
    dest = dest_dir / f"{stem}.up.{stamp}.png"
    scale = int(payload.get("scale", "4"))
    model = payload.get("model", "realesrgan-x4plus")
    if source_has_alpha(src):                       # ESRGAN drops alpha → Lanczos resize keeps it
        deterministic_upscale(src, dest, scale)
    elif model in SR_MODELS:                         # spandrel path (scale is the model's own)
        build_upscale_spandrel(src, dest, model, int(payload.get("tile", 256)), log)
    else:
        ensure_tools_ready("realesrgan")
        run_subprocess([str(REALESRGAN_BIN), "-i", str(src), "-o", str(dest),
                        "-n", model, "-s", str(scale)],
                       cwd=REALESRGAN_DIR)
    return dest


def _op_removebg(src, dest_dir, stem, stamp, payload, log):
    out = dest_dir / f"{stem}.cut.{stamp}.png"
    for old in dest_dir.glob(f"{stem}.cut.*.png"):
        old.unlink(missing_ok=True)
    method = (payload.get("removebg_method") or "classical").strip()
    if method == "green":
        build_chromakey_cutout(src, out)
    elif method == "ai":
        if not rembg_installed():
            raise ValueError("AI cutout requested but rembg is not installed (Settings → install, or use Classical).")
        build_ai_cutout(src, out, (payload.get("cutout_model") or "u2net").strip(),
                        bool(payload.get("alpha_matting")), log)
    else:
        build_mask_with_overrides(src, dest_dir / f"{stem}.mask.{stamp}.png", out, mask_config(payload))
        (dest_dir / f"{stem}.mask.{stamp}.png").unlink(missing_ok=True)
    validate_cutout_png(out)
    return out


RASTER_OPS = {
    "upscale": {
        "label": "Upscale", "caps": {"needs": ["realesrgan"]},
        "schema": [
            {"key": "model", "type": "select", "default": "realesrgan-x4plus", "label": "Model",
             "options": [["realesrgan-x4plus", "ESRGAN x4+ (photo)"], ["realesrnet-x4plus", "ESRNet x4+ (cleaner)"], ["realesr-animevideov3", "Anime / line-art"],
                         ["realesrgan-x4-spandrel", "Real-ESRGAN x4 (spandrel/torch)"], ["dat2-realweb-x4", "DAT-2 — detail (spandrel)"],
                         ["span-nomos-x4", "SPAN — fast (spandrel)"], ["realcugan-up2x", "Real-CUGAN ×2 — anime (spandrel)"],
                         ["aurasr-v2", "AuraSR v2 ×4 — GAN (spandrel, 2.4GB)"]]},
            {"key": "scale", "type": "select", "default": "4", "label": "Scale",
             "options": [["2", "2×"], ["3", "3×"], ["4", "4×"]]},
        ],
        "apply": _op_upscale,
    },
    "removebg": {
        "label": "Remove background", "caps": {"needs": []},   # classical always works → no hard requirement
        "schema": [
            {"key": "removebg_method", "type": "select", "default": "classical", "label": "Method",
             "options": [["classical", "Classical — fast"], ["ai", "AI (rembg)"], ["green", "Greenscreen"]]},
            {"key": "cutout_model", "type": "select", "default": "u2net", "label": "AI model", "when": {"removebg_method": "ai"},
             "options": [["u2net", "u2net — general (176MB)"], ["u2netp", "u2netp — fast/light (5MB)"], ["u2net_human_seg", "u2net — humans"],
                         ["isnet-general-use", "ISNet — sharper general"], ["isnet-anime", "ISNet anime"],
                         ["birefnet-general", "BiRefNet general — OSS SOTA (928MB)"], ["birefnet-general-lite", "BiRefNet lite (214MB)"],
                         ["birefnet-portrait", "BiRefNet portrait (928MB)"], ["birefnet-hrsod", "BiRefNet HR — high-res detail (928MB)"],
                         ["birefnet-massive", "BiRefNet massive — hair / fine detail (928MB)"],
                         ["ben2", "BEN2 — CGM hair / 4K matting (213MB)"], ["silueta", "silueta — quantized U²-Net"]]},
            {"key": "alpha_matting", "type": "checkbox", "default": False, "label": "Alpha matting", "when": {"removebg_method": "ai"},
             "hint": "Refines edges (hair). Slower."},
        ],
        "apply": _op_removebg,
    },
}


def raster_ops_info() -> list[dict]:
    """Serializable raster-op registry for the client (drops the apply callable).
    `available` reflects whether the op's required tools are present (rembg for the AI
    cutout *method* is checked at run time, since Classical needs nothing)."""
    out = []
    for oid, o in RASTER_OPS.items():
        needs = o["caps"].get("needs", [])
        available = ("realesrgan" not in needs or REALESRGAN_BIN.exists())
        out.append({"id": oid, "label": o["label"], "caps": o["caps"],
                    "schema": o["schema"], "available": available,
                    "rembg_installed": rembg_installed()})
    return out


def apply_raster_op(payload: dict) -> dict:
    """Run a registered raster op into the scratch dir and return a resolvable URL.
    Transient (mirrors trace-preview): no job, no poll, no library copy."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    op = (payload.get("op") or "").strip()
    if op not in RASTER_OPS:
        raise ValueError(f"Unknown raster op: {op!r}")
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-.") or "img"
    stamp = int(time.time() * 1000) % 1000000
    out = RASTER_OPS[op]["apply"](src, SCRATCH_DIR, stem, stamp, payload, lambda *_a, **_k: None)
    rel = out.relative_to(OUTPUTS_DIR).as_posix()
    return {"url": "/outputs/" + "/".join(urllib.parse.quote(p) for p in rel.split("/")), "name": out.name}


# ---------------------------------------------------------------- vectorize engines
# Pluggable engine layer (migration toward the abstract-architecture spec). Each engine
# is self-contained: trace(src, payload, cfgs, tmp, log) → SVG text. ONE dispatch path
# (`vectorize_svg`) feeds BOTH the live preview and the commit/pipeline, so they can't
# drift. New engines (potrace, a neural quality tier) drop in here with a param_schema.

def _engine_clean(src, payload, trace, mask_cfg, pv, tmp, log):
    return clean_color_trace(src, n=int(float(trace["color_precision"])),
                             simplify=trace["simplify"], speckle=int(float(trace["filter_speckle"])))


def _engine_vtracer(src, payload, trace, mask_cfg, pv, tmp, log):
    ensure_tools_ready("vtracer")
    dest = tmp / "o.svg"
    if trace["colormode"] == "color":
        flat = tmp / "flat.png"
        prepare_color_input(src, flat, trace)
        trace_color_to_svg(flat, dest, trace, log)
    else:
        mask = tmp / "mask.png"
        build_mask_with_overrides(src, mask, None, mask_cfg)
        trace_mask_to_svg(mask, dest, trace, log)
    simplify_trace_file(dest, trace["simplify"], log)
    return dest.read_text(encoding="utf-8", errors="ignore")


def _engine_pixel(src, payload, trace, mask_cfg, pv, tmp, log):
    dest = tmp / "o.svg"
    pixelvec.vectorize_pixel_art(src, dest, mode=pv["mode"], sample=pv["sample"],
                                 gridx=pv["gridx"], gridy=pv["gridy"],
                                 quantize=pv["quantize"], key_corner=pv["key_corner"])
    return dest.read_text(encoding="utf-8", errors="ignore")


VECTORIZE_ENGINES = {
    "clean": {
        "label": "Clean — flat logo (planar, no halos)", "group": "trace",
        "caps": {"colormodes": ["color"], "holes": True, "planar": True, "speed": "live", "needs": ["vtracer"]},
        # Schema = the COMPLETE set of params this engine actually consumes (see
        # _engine_clean / clean_color_trace). The client renders the panel purely from
        # this — so a control is shown iff the engine reads it. No phantom knobs.
        "schema": [
            {"key": "color_precision", "type": "range", "min": 1, "max": 8, "step": 1, "default": 3,
             "label": "Colours", "hint": "Palette size — fewer = flatter, cleaner logo."},
            {"key": "trace_simplify", "type": "select", "default": "medium", "label": "Simplify",
             "options": [["off", "Off — raw"], ["light", "Light"], ["medium", "Medium — recommended"], ["strong", "Strong — fewest nodes"]]},
            {"key": "filter_speckle", "type": "range", "min": 0, "max": 32, "step": 1, "default": 6,
             "label": "Filter speckle", "advanced": True, "hint": "Drop blobs smaller than N px."},
            {"key": "target_max_dim", "type": "number", "default": None, "label": "Max trace size", "advanced": True,
             "placeholder": f"auto (≤{TRACE_MAX_DIM}px)",
             "hint": f"Longest side fed to the tracer. Blank = the {TRACE_MAX_DIM}px default; raise it for "
                     f"full-fidelity large art (slower, more nodes), up to {TRACE_ABS_MAX_DIM}px."},
        ],
        "trace": _engine_clean,
    },
    "vtracer": {
        "label": "VTracer — colour / B&W", "group": "trace",
        "caps": {"colormodes": ["bw", "color"], "holes": False, "planar": False, "speed": "live", "needs": ["vtracer"]},
        "schema": [
            {"key": "trace_colormode", "type": "select", "default": "bw", "label": "Output",
             "options": [["bw", "Black & white — silhouette"], ["color", "Colour — full palette"]]},
            {"key": "trace_color_style", "type": "select", "default": "poster", "label": "Style", "when": {"trace_colormode": "color"},
             "options": [["poster", "Poster — flat palette"], ["photo", "Photo — gradients"]]},
            {"key": "color_precision", "type": "range", "min": 1, "max": 8, "step": 1, "default": 6, "label": "Colours", "when": {"trace_colormode": "color"}},
            {"key": "trace_hierarchical", "type": "select", "default": "stacked", "label": "Layers", "when": {"trace_colormode": "color"},
             "options": [["stacked", "Stacked — layered fills"], ["cutout", "Cutout — non-overlapping"]]},
            {"key": "mask_threshold", "type": "number", "default": None, "label": "Black threshold", "when": {"trace_colormode": "bw"},
             "placeholder": "auto (otsu)", "hint": "Gray cutoff; higher = more foreground."},
            {"key": "trace_simplify", "type": "select", "default": "medium", "label": "Simplify",
             "options": [["off", "Off — raw vtracer"], ["light", "Light"], ["medium", "Medium — recommended"], ["strong", "Strong — fewest nodes"]]},
            {"key": "trace_mode", "type": "select", "default": "spline", "label": "Curves",
             "options": [["spline", "Spline (curves)"], ["polygon", "Polygon"], ["pixel", "Pixel (no smoothing)"]]},
            {"key": "target_max_dim", "type": "number", "default": None, "label": "Max trace size",
             "placeholder": f"auto (≤{TRACE_MAX_DIM}px)",
             "hint": f"Longest side fed to the tracer. Blank = the {TRACE_MAX_DIM}px default (tames oversized / "
                     f"upscaled input); raise it for full-fidelity large art — slower, more nodes — up to {TRACE_ABS_MAX_DIM}px."},
            {"key": "segment_length", "type": "range", "min": 3.5, "max": 10, "step": 0.5, "default": 4.5, "label": "Smooth (segment length)", "advanced": True},
            {"key": "filter_speckle", "type": "range", "min": 0, "max": 16, "step": 1, "default": 6, "label": "Filter speckle", "advanced": True},
            {"key": "corner_threshold", "type": "range", "min": 30, "max": 180, "step": 5, "default": 85, "label": "Corner threshold", "advanced": True},
            {"key": "splice_threshold", "type": "range", "min": 0, "max": 180, "step": 5, "default": 45, "label": "Splice threshold", "advanced": True},
            {"key": "path_precision", "type": "range", "min": 0, "max": 10, "step": 1, "default": 2, "label": "Path precision", "advanced": True},
        ],
        "trace": _engine_vtracer,
    },
    "pixel": {
        "label": "Pixel-art — recover grid", "group": "pixel",
        "caps": {"colormodes": ["color"], "holes": True, "planar": True, "speed": "live", "needs": []},
        "schema": [
            {"key": "pv_grid", "type": "number", "default": None, "label": "Native size (cells)",
             "placeholder": "auto-detect", "hint": "Blank = auto-detect the pixel grid."},
            {"key": "pv_sample", "type": "select", "default": "mode", "label": "Cell colour",
             "options": [["mode", "Mode — most common"], ["median", "Median — robust"], ["center", "Center pixel"]]},
            {"key": "pv_quantize", "type": "number", "default": None, "label": "Quantize colours",
             "placeholder": "keep all", "hint": "Snap to an N-colour palette."},
            {"key": "pv_key_corner", "type": "checkbox", "default": False, "label": "Key out corner",
             "hint": "Make the dominant corner colour transparent."},
            {"key": "pv_mode", "type": "select", "default": "merged", "label": "Shape mode",
             "options": [["merged", "Merged rects — compact"], ["path", "Per-colour paths"], ["pixels", "One rect per pixel"]]},
        ],
        "trace": _engine_pixel,
    },
}


def resolve_engine(payload: dict) -> str:
    """Explicit `engine` wins; otherwise derive from the legacy method/style params so
    existing callers keep working unchanged."""
    e = (payload.get("engine") or "").strip()
    if e in VECTORIZE_ENGINES:
        return e
    if (payload.get("vectorize_method") or "trace").strip() == "pixel":
        return "pixel"
    if str(payload.get("trace_colormode", "")).lower() == "color" and payload.get("trace_color_style") == "clean":
        return "clean"
    return "vtracer"


def vectorize_svg(src: Path, payload: dict, *, max_dim: int | None = None, log=None) -> str:
    """The single vectorize entry point: resolve the engine, (optionally) downscale the
    source, and return SVG text. Used by the live preview AND the commit/pipeline."""
    eng = resolve_engine(payload)
    trace = trace_config(payload)
    mask_cfg = mask_config(payload)
    pv = pixelvec_config(payload)
    log = log or (lambda *a, **k: None)
    with tempfile.TemporaryDirectory(prefix="hv-vec-") as td:
        tmp = Path(td)
        cur = src
        # An explicit max_dim (the live preview's / focused run's tight cap) wins; otherwise
        # use the trace ceiling: the user's explicit "Max trace size" (target_max_dim) if set
        # — so genuinely large clean art can be traced at full fidelity — else the safety
        # default so an oversized / upscaled raster doesn't overproduce. Cached downscale: the
        # live preview re-traces on every drag, so resizing the full-res source each time was
        # pure waste (see preprocess_for_trace).
        cap = max_dim if max_dim is not None else _trace_ceiling(mask_cfg)
        if cap:
            cur = preprocess_for_trace(src, cap)
        return VECTORIZE_ENGINES[eng]["trace"](cur, payload, trace, mask_cfg, pv, tmp, log)


def _trace_ceiling(mask_cfg: dict) -> int | None:
    """The longest-side cap for a commit/batch trace. An explicit user target_max_dim is an
    OPT-IN (it can exceed the default — that's the point: full-fidelity large art), clamped to
    the absolute safety bound. Unset → the default ceiling that tames oversized/upscaled input."""
    target = mask_cfg.get("target_max_dim")
    if target:
        return min(int(target), TRACE_ABS_MAX_DIM)
    return TRACE_MAX_DIM


def vectorize_engines_info() -> list[dict]:
    """Serializable registry for the client (drops the trace callable). `available`
    reflects whether the engine's required tools are present."""
    out = []
    for eid, e in VECTORIZE_ENGINES.items():
        needs = e["caps"].get("needs", [])
        available = ("vtracer" not in needs) or VTRACER_BIN.exists()
        out.append({"id": eid, "label": e["label"], "group": e["group"],
                    "caps": e["caps"], "schema": e["schema"], "available": available})
    return out
