#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import io
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ExifTags

from engine import build_alpha_cutout, build_monochrome_assets, has_meaningful_alpha


# Foundational layer (paths, constants, on-disk config, tool/model presence probes)
# lives in hvserver/paths.py (#29 split). It runs sys.path.insert(TOOLS_DIR) +
# mimetypes.add_type at import, so the tool imports below resolve. Re-exported here so
# `server.OUTPUTS_DIR` / `server.source_dir()` / `server.LAMA_MODEL` etc. keep working.
from hvserver.paths import *  # noqa: F401,F403
from hvserver.paths import (  # underscore helpers (not picked up by `import *`)
    _load_config, _save_config, _config_lock, _venv_has,
)

import pixelvec  # noqa: E402  (pure numpy/PIL, no venv needed)
import svg_render  # noqa: E402  (pure Pillow for axis-aligned SVGs; cairosvg optional)
import simplify_svg  # noqa: E402  (pure numpy; refit traced paths to minimal cubics)
import analyze  # noqa: E402  (pure numpy/PIL; the classical auto-routing brain — analyze→plan)

# Capabilities taxonomy + router resolution (hvserver/capabilities.py, #29 split).
# Re-exported so server.CAPABILITIES / resolve_capability_step / resolve_intent /
# capabilities_info keep resolving for the router + /api/capabilities + tests.
from hvserver.capabilities import *  # noqa: F401,F403,E402

# Files layer (hvserver/files.py, #29 split): work-items, the outputs/ library, uploads,
# rename/remove/info. Jobs-independent. Re-exported so server.list_outputs / select_inputs /
# save_uploaded_files / etc. keep resolving for run_pipeline, the job GC, and the HTTP handler.
from hvserver.files import *  # noqa: F401,F403,E402
from hvserver.files import (  # underscore helpers called from the regions that stayed here
    _safe_stem, _prune_focused_pipeline_dirs, _prune_scratch_inline, _read_body,
)

# Jobs layer (hvserver/jobs.py, #29 split): the async job table + queue workers, the
# UI-liveness auto-spindown watchdog, the heavy-sync in-flight counter, run_subprocess
# (current-job aware), and launch/cancel/retry. Models, engines, and the pipeline call
# run_subprocess / launch_job / _report_progress / _register_output from here, so it must
# be importable before them. Re-exported so server.jobs / launch_job / cancel_job / etc.
# (and the HTTP handler's heartbeat + in-flight + job endpoints) keep resolving.
from hvserver.jobs import *  # noqa: F401,F403,E402
from hvserver.jobs import (  # underscore helpers called from the regions that stayed here
    _touch_heartbeat, _inflight_incr, _inflight_decr, _idle_watchdog, _gc_outputs,
    _report_progress, _register_output,
)




def ensure_dirs() -> None:
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    INPUTS_DIR.mkdir(parents=True, exist_ok=True)


def seed_inputs() -> None:
    if source_dir().resolve() != DEFAULT_SOURCE_DIR.resolve():
        return
    if discover_work_items():
        return

    candidates: list[Path] = []
    candidates.extend(
        path for path in APP_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS and not is_derivative_name(path.name)
    )
    old_dir = APP_DIR / "old"
    if old_dir.exists():
        candidates.extend(
            path for path in old_dir.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS and not is_derivative_name(path.name)
        )

    seen = set()
    for src in candidates:
        if src.name in seen:
            continue
        seen.add(src.name)
        shutil.copy2(src, INPUTS_DIR / src.name)


# (#29 jobs utils -> hvserver/jobs.py: _id_counter + now_id + shell_join)




def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def tool_status() -> dict:
    missing_tools = []
    if not REALESRGAN_BIN.exists():
        missing_tools.append("realesrgan")
    if not VTRACER_BIN.exists():
        missing_tools.append("vtracer")
    rembg_ok = rembg_installed()
    return {
        "gpu_recommendation": "RTX A3000 12GB: reliable HQ path is Real-ESRGAN; SUPIR is optional low-VRAM experimental.",
        "realesrgan_installed": REALESRGAN_BIN.exists(),
        "vtracer_installed": VTRACER_BIN.exists(),
        "rembg_installed": rembg_ok,
        "spandrel_installed": spandrel_installed(),
        "svg_render_builtin": True,
        "svg_render_cairosvg": svg_render.cairosvg_available(),
        "venv_dir": str(VENV_DIR),
        "venv_python": str(VENV_PYTHON) if VENV_PYTHON.exists() else "",
        "cargo_available": command_exists("cargo"),
        "curl_available": command_exists("curl"),
        "unzip_available": command_exists("unzip"),
        "python": shutil.which("python3"),
        "app_dir": str(APP_DIR),
        "workspace_dir": str(WORKSPACE_DIR),
        "workspace_name": WORKSPACE_DIR.name,
        "outputs_dir": str(OUTPUTS_DIR),
        "inputs_dir": str(INPUTS_DIR),
        "source_dir": str(source_dir()),
        "default_source_dir": str(DEFAULT_SOURCE_DIR),
        "missing_tools": missing_tools,
        "work_items": [str(path) for path in discover_work_items()],
    }


# (#29 files layer -> hvserver/files.py - region 1/3: path helpers + scratch/pipeline-dir pruning)


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


# (#29 jobs layer -> hvserver/jobs.py: _new_job_record + launch_job/launch_internal_job + cancel/retry + has_running_job)




def install_realesrgan() -> dict:
    ensure_dirs()
    if REALESRGAN_BIN.exists():
        return {"message": "Real-ESRGAN NCNN already installed."}
    if has_running_job("install-realesrgan"):
        return {"message": "Real-ESRGAN NCNN install already running."}
    zip_path = TOOLS_DIR / "realesrgan-ncnn-vulkan.zip"
    tmp_dir = TOOLS_DIR / "_tmp_realesrgan"
    cmd = [
        "bash",
        "-lc",
        (
            f"set -euo pipefail; "
            f"mkdir -p {shlex_quote(str(TOOLS_DIR))}; "
            f"curl -L {shlex_quote(REALESRGAN_RELEASE)} -o {shlex_quote(str(zip_path))}; "
            f"rm -rf {shlex_quote(str(tmp_dir))}; "
            f"mkdir -p {shlex_quote(str(tmp_dir))}; "
            f"unzip -o {shlex_quote(str(zip_path))} -d {shlex_quote(str(tmp_dir))}; "
            f"rm -rf {shlex_quote(str(REALESRGAN_DIR))}; "
            f"mv {shlex_quote(str(tmp_dir))} {shlex_quote(str(REALESRGAN_DIR))}; "
            f"chmod +x {shlex_quote(str(REALESRGAN_BIN))}"
        ),
    ]
    return launch_job("install-realesrgan", cmd, summary="Install Real-ESRGAN", immediate=True)


def install_vtracer() -> dict:
    ensure_dirs()
    if VTRACER_BIN.exists():
        return {"message": "vtracer already installed."}
    if has_running_job("install-vtracer"):
        return {"message": "vtracer install already running."}
    cmd = ["cargo", "install", "vtracer", "--root", str(TOOLS_DIR / "cargo")]
    return launch_job("install-vtracer", cmd, summary="Install VTracer", immediate=True)


def install_rembg() -> dict:
    ensure_dirs()
    if rembg_installed():
        return {"message": "rembg already installed."}
    if has_running_job("install-rembg"):
        return {"message": "rembg install already running."}
    pip = VENV_DIR / "bin" / "pip"
    cmd = [
        "bash",
        "-lc",
        (
            f"set -euo pipefail; "
            f"if [ ! -x {shlex_quote(str(VENV_PYTHON))} ]; then "
            f"  python3 -m venv {shlex_quote(str(VENV_DIR))}; "
            f"fi; "
            f"{shlex_quote(str(pip))} install --upgrade pip wheel >/dev/null; "
            f"{shlex_quote(str(pip))} install --upgrade 'rembg[cpu]' onnxruntime pillow numpy"
        ),
    ]
    return launch_job(
        "install-rembg", cmd,
        summary="Install rembg (AI cutout, ~500MB)",
        immediate=True,
    )


def install_spandrel() -> dict:
    ensure_dirs()
    if spandrel_installed():
        return {"message": "spandrel already installed."}
    if has_running_job("install-spandrel"):
        return {"message": "spandrel install already running."}
    pip = VENV_DIR / "bin" / "pip"
    # torch + torchvision MUST come from the CPU index as a matched pair, else torchvision's
    # compiled ops (e.g. nms) fail to register against a mismatched torch. Then spandrel.
    cmd = [
        "bash", "-lc",
        (
            f"set -euo pipefail; "
            f"if [ ! -x {shlex_quote(str(VENV_PYTHON))} ]; then "
            f"  python3 -m venv {shlex_quote(str(VENV_DIR))}; "
            f"fi; "
            f"{shlex_quote(str(pip))} install --upgrade pip wheel >/dev/null; "
            f"{shlex_quote(str(pip))} install --upgrade torch torchvision "
            f"  --index-url https://download.pytorch.org/whl/cpu; "
            f"{shlex_quote(str(pip))} install --upgrade spandrel pillow numpy"
        ),
    ]
    return launch_job(
        "install-spandrel", cmd,
        summary="Install spandrel + torch (universal SR loader, ~300MB)",
        immediate=True,
    )


def install_opencv() -> dict:
    ensure_dirs()
    if _venv_has("cv2"):
        return {"message": "opencv already installed."}
    if has_running_job("install-opencv"):
        return {"message": "opencv install already running."}
    pip = VENV_DIR / "bin" / "pip"
    # headless build (no GUI libs); numpy-2 compatible, no downgrades. Powers face detect/align.
    cmd = ["bash", "-lc",
           f"set -euo pipefail; {shlex_quote(str(pip))} install --upgrade opencv-python-headless"]
    return launch_job("install-opencv", cmd, summary="Install opencv (face detect/align, ~60MB)", immediate=True)


def bootstrap_tools() -> dict:
    ensure_dirs()
    started = []
    if not REALESRGAN_BIN.exists():
        result = install_realesrgan()
        started.append(result.get("message", "Started Real-ESRGAN install."))
    if not VTRACER_BIN.exists():
        result = install_vtracer()
        started.append(result.get("message", "Started vtracer install."))
    if not started:
        return {"message": "All core tools are already installed."}
    return {"message": " | ".join(started)}


# ---------------------------------------------------------------------------
# Version + self-update (git-pull based; the app is distributed as a git clone)
# ---------------------------------------------------------------------------
def _git(*args: str, timeout: float = 8.0) -> str | None:
    """Run a git command in APP_DIR; return stripped stdout, or None on any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", str(APP_DIR), *args],
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return None
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _is_git_repo() -> bool:
    return _git("rev-parse", "--is-inside-work-tree") == "true"


def version_info() -> dict:
    is_git = _is_git_repo()
    return {
        "version": APP_VERSION,
        "isGit": is_git,
        "commit": (_git("rev-parse", "--short", "HEAD") or "") if is_git else "",
        "branch": (_git("rev-parse", "--abbrev-ref", "HEAD") or "") if is_git else "",
        "dirty": bool(_git("status", "--porcelain")) if is_git else False,
        "repo": GITHUB_REPO,
    }


def _version_tuple(s: str) -> tuple:
    nums = re.findall(r"\d+", s or "")
    return tuple(int(n) for n in nums[:3]) or (0,)


def check_update(payload: dict | None = None) -> dict:
    """Compare the local VERSION against the latest GitHub release tag. Network
    failures degrade to {error} rather than throwing — this is best-effort."""
    import urllib.request  # stdlib; local import keeps the module top lean
    info = version_info()
    api = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    latest = None
    url = f"https://github.com/{GITHUB_REPO}/releases"
    try:
        req = urllib.request.Request(api, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "hector-vector-updater",
        })
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = (data.get("tag_name") or "").lstrip("v") or None
        url = data.get("html_url") or url
    except Exception as exc:  # offline, rate-limited, no releases yet, etc.
        return {"current": info["version"], "latest": None, "behind": False,
                "url": url, "isGit": info["isGit"], "dirty": info["dirty"],
                "error": f"Could not reach GitHub ({exc.__class__.__name__})."}
    behind = bool(latest) and _version_tuple(latest) > _version_tuple(info["version"])
    return {"current": info["version"], "latest": latest, "behind": behind,
            "url": url, "isGit": info["isGit"], "dirty": info["dirty"]}


def apply_update(payload: dict | None = None) -> dict:
    """git pull --ff-only, then sync deps into .venv if present. Refuses on a
    non-git checkout or a dirty working tree (so we never clobber local edits)."""
    if not _is_git_repo():
        raise ValueError("Not a git checkout — update with your package manager or re-clone.")
    if _git("status", "--porcelain"):
        raise ValueError("Working tree has local changes — commit or stash them before updating.")
    if has_running_job("update"):
        return {"message": "Update already running."}
    pip = VENV_DIR / "bin" / "pip"
    cmd = [
        "bash", "-lc",
        (
            f"set -euo pipefail; "
            f"git -C {shlex_quote(str(APP_DIR))} pull --ff-only; "
            f"if [ -x {shlex_quote(str(pip))} ]; then "
            f"  {shlex_quote(str(pip))} install -r {shlex_quote(str(APP_DIR / 'requirements.txt'))}; "
            f"fi; "
            f"echo 'Update complete — restart hector-vector to finish.'"
        ),
    ]
    result = launch_job("update", cmd, summary="Update hector-vector (git pull)", immediate=True)
    result["restart"] = True
    return result


def ensure_tools_ready(*required: str) -> None:
    # HOT PATH: this runs on every live-preview trace. Check ONLY the specific
    # binaries asked for (a cheap filesystem stat) — never the full tool_status(),
    # which probes rembg and used to import torch (~10s) on every keystroke.
    binaries = {"vtracer": VTRACER_BIN, "realesrgan": REALESRGAN_BIN}
    needed_missing = [name for name in required if name in binaries and not binaries[name].exists()]
    if not needed_missing:
        return
    bootstrap_tools()
    pretty = ", ".join(needed_missing)
    raise ValueError(f"Missing tools are being installed automatically: {pretty}. Check Jobs and retry when they finish.")


def _skip_message(kind: str, skipped: list[str]) -> str:
    return (
        f"Nothing new to {kind}: all {len(skipped)} input(s) already processed. "
        f"Tick Force to reprocess."
    )


AI_CUTOUT_MODELS = {
    "u2net", "u2netp", "u2net_human_seg",
    "isnet-general-use", "isnet-anime",
    "birefnet-general", "birefnet-general-lite",
    "birefnet-portrait", "birefnet-hrsod", "birefnet-massive",
    "silueta", "sam",
    "ben2",  # BYO-ONNX (#60): rembg ben_custom + a hosted BEN2 weight (see BEN2_MODEL)
}

# BEN2 proper (#60): Confidence-Guided Matting, best-in-class hair/4K. rembg packages a
# `ben_custom` session but ships no weight — it takes an explicit model_path that rembg
# forces to live under the u2net home dir. The official ONNX is curl-able + Apache-2.0.
U2NET_DIR = Path(os.environ.get("U2NET_HOME", str(Path.home() / ".u2net")))
BEN2_MODEL = {
    "session": "ben_custom", "file": "ben2_base.onnx", "size_mb": 213,
    "url": "https://huggingface.co/PramaLLC/BEN2/resolve/main/BEN2_Base.onnx",
}


def fetch_model(path: Path, url: str, *, label: str, size_mb: float, log=None) -> Path:
    """Download a model weight ATOMICALLY (returns immediately if already present).

    curl -fsSL writes to a .part sidecar; -f makes curl fail on an HTTP error instead
    of saving the error page as the model. We then sanity-check the size against the
    spec and only rename into place on success — so neither an HTTP error body nor a
    transfer interrupted by cancel/shutdown can ever poison the cache (the old code
    left such partials in place forever, bricking the capability until hand-deleted)."""
    if path.exists():
        return path
    if not command_exists("curl"):
        raise ValueError("curl is required to download model weights.")
    path.parent.mkdir(parents=True, exist_ok=True)
    if log:
        log(f"Downloading {label} (~{size_mb}MB)…")
    part = path.with_name(path.name + ".part")
    part.unlink(missing_ok=True)
    try:
        run_subprocess(["curl", "-fsSL", "-o", str(part), url])
        floor = max(64 * 1024, int(size_mb * 1024 * 1024 * 0.5))   # at least half the expected size
        got = part.stat().st_size if part.exists() else 0
        if got < floor:
            raise ValueError(f"{label} download incomplete ({got} bytes, expected ~{size_mb}MB).")
        part.replace(path)   # atomic on the same filesystem
    except BaseException:    # incl. cancel/shutdown terminating curl → never leave a partial
        part.unlink(missing_ok=True)
        raise
    return path


def ensure_ben2_model(log=None) -> Path:
    """Resolve the BEN2 ONNX weight (under the u2net home dir), downloading on first use."""
    return fetch_model(U2NET_DIR / BEN2_MODEL["file"], BEN2_MODEL["url"],
                       label="BEN2 cutout model", size_mb=BEN2_MODEL["size_mb"], log=log)


def build_ai_cutout(src: Path, dest: Path, model: str, alpha_matting: bool, log) -> None:
    if not rembg_installed():
        raise ValueError("rembg is not installed in the project venv. Click 'Install rembg' in Settings.")
    if model not in AI_CUTOUT_MODELS:
        raise ValueError(f"Unknown AI cutout model: {model}")
    cmd = [str(VENV_PYTHON), str(AI_CUTOUT_SCRIPT), str(src), str(dest)]
    if model == "ben2":
        # BYO-ONNX slot: hand rembg the ben_custom session + the local weight path.
        path = ensure_ben2_model(log)
        cmd += ["--model", BEN2_MODEL["session"], "--model-path", str(path)]
    else:
        cmd += ["--model", model]
    if alpha_matting:
        cmd.append("--alpha-matting")
    log_subprocess_lines(log, run_subprocess(cmd))


# Spandrel-loadable SR checkpoints (the universal-loader model zoo, #54/#55). Keyed by a
# stable id used in the upscale `model` setting; the id is what routes a request to the
# spandrel path instead of the ncnn binary. Weights download on first use into SR_MODELS_DIR.
SR_MODELS = {
    "realesrgan-x4-spandrel": {
        "label": "Real-ESRGAN ×4 (spandrel)", "scale": 4, "size_mb": 64,
        "file": "RealESRGAN_x4plus.pth",
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"},
    # #55 tiers behind intents. Arch + scale confirmed by a spandrel load+run on each.
    "dat2-realweb-x4": {                                 # DAT-2, detail / real-photo restore
        "label": "DAT-2 RealWebPhoto ×4 (detail)", "scale": 4, "size_mb": 134,
        "file": "4xRealWebPhoto_v4_dat2.safetensors",
        "url": "https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2/resolve/main/4xRealWebPhoto_v4_dat2.safetensors"},
    "span-nomos-x4": {                                   # SPAN, fast / lightweight
        "label": "SPAN NomosUni ×4 (fast)", "scale": 4, "size_mb": 5,
        "file": "4xNomosUni_span_multijpg.safetensors",
        "url": "https://huggingface.co/Phips/4xNomosUni_span_multijpg/resolve/main/4xNomosUni_span_multijpg.safetensors"},
    "realcugan-up2x": {                                  # Real-CUGAN (UpCunet2x), anime ×2
        "label": "Real-CUGAN ×2 (anime)", "scale": 2, "size_mb": 5,
        "file": "realcugan-up2x-no-denoise.pth",
        "url": "https://huggingface.co/spaces/luoxia/Real-CUGAN/resolve/main/weights_v3/up2x-latest-no-denoise.pth"},
    "aurasr-v2": {                                       # AuraSR v2 (GigaGAN UnetUpsampler), GAN ×4
        "label": "AuraSR v2 ×4 (GAN)", "scale": 4, "size_mb": 2470,
        "file": "AuraSR-v2.safetensors",
        "url": "https://huggingface.co/fal/AuraSR-v2/resolve/main/model.safetensors"},
    # #58 degradation fixers — spandrel restoration archs (scale 1), run through the SAME
    # executor as SR (it reads scale from the checkpoint). No new deps (spandrel from #54).
    "scunet-denoise": {                                  # SCUNet, denoise
        "label": "SCUNet denoise", "scale": 1, "size_mb": 69,
        "file": "scunet_color_real_psnr.pth",
        "url": "https://huggingface.co/deepinv/scunet/resolve/main/scunet_color_real_psnr.pth"},
    "fbcnn-dejpeg": {                                     # FBCNN, JPEG-artifact removal
        "label": "FBCNN de-JPEG", "scale": 1, "size_mb": 275,
        "file": "fbcnn_color.pth",
        "url": "https://github.com/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth"},
    "nafnet-deblur": {                                    # NAFNet, deblur
        "label": "NAFNet deblur", "scale": 1, "size_mb": 260,
        "file": "NAFNet-GoPro-width64.pth",
        "url": "https://huggingface.co/nyanko7/nafnet-models/resolve/main/NAFNet-GoPro-width64.pth"},
}
# Restoration PIPELINE stages → their fixed SR_MODELS id. The stage flag (stage_<id>) flips it
# on; the model is implied by the stage (no settings key, so no collision with upscale's model).
# Order here is the flow order — degradation fixes run BEFORE upscale (clean, then enlarge).
RESTORE_STAGE_MODELS = {"dejpeg": "fbcnn-dejpeg", "denoise": "scunet-denoise", "deblur": "nafnet-deblur"}


def ensure_sr_model(model_id: str, log=None) -> Path:
    """Resolve an SR model id to a local checkpoint path, downloading on first use."""
    spec = SR_MODELS.get(model_id)
    if spec is None:
        raise ValueError(f"Unknown SR model: {model_id}")
    return fetch_model(SR_MODELS_DIR / spec["file"], spec["url"],
                       label=spec["label"], size_mb=spec["size_mb"], log=log)


def build_upscale_spandrel(src: Path, dest: Path, model_id: str, tile: int, log) -> None:
    if not spandrel_installed():
        raise ValueError("spandrel is not installed in the project venv. Click 'Install spandrel' in Settings.")
    path = ensure_sr_model(model_id, log)
    cmd = [str(VENV_PYTHON), str(UPSCALE_SPANDREL_SCRIPT), str(src), str(dest),
           "--model", str(path), "--tile", str(tile)]
    log_subprocess_lines(log, run_subprocess(cmd))


def ensure_inpaint_model(log=None) -> Path:
    """Resolve the big-LaMa ONNX, downloading on first use."""
    return fetch_model(INPAINT_DIR / LAMA_MODEL["file"], LAMA_MODEL["url"],
                       label="LaMa cleanup model", size_mb=LAMA_MODEL["size_mb"], log=log)


def build_lama_cleanup(src: Path, mask: Path, dest: Path, log) -> None:
    if not _venv_has("onnxruntime"):
        raise ValueError("onnxruntime is not installed in the project venv (install rembg or onnxruntime in Settings).")
    path = ensure_inpaint_model(log)
    cmd = [str(VENV_PYTHON), str(LAMA_SCRIPT), str(src), str(mask), str(dest), "--model", str(path)]
    log_subprocess_lines(log, run_subprocess(cmd))


def cleanup_inpaint(payload: dict) -> dict:
    """Object removal: resolve the source image + the painted mask (both may be data: URLs),
    run LaMa, return a scratch URL. Transient — mirrors apply_raster_op (no job/library copy)."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    mask = resolve_source_url(payload.get("mask_url", ""))
    if mask is None:
        raise ValueError("Could not resolve the cleanup mask.")
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-.") or "img"
    stamp = int(time.time() * 1000) % 1000000
    out = SCRATCH_DIR / f"{stem}.clean.{stamp}.png"
    build_lama_cleanup(src, mask, out, lambda *_a, **_k: None)
    rel = out.relative_to(OUTPUTS_DIR).as_posix()
    return {"url": "/outputs/" + "/".join(urllib.parse.quote(p) for p in rel.split("/")), "name": out.name}


def ensure_face_models(log=None) -> tuple[Path, Path]:
    """Resolve the GFPGAN + YuNet weights, downloading on first use."""
    out = []
    for spec in (GFPGAN_MODEL, YUNET_MODEL):
        out.append(fetch_model(FACE_DIR / spec["file"], spec["url"],
                               label=spec["file"], size_mb=spec["size_mb"], log=log))
    return out[0], out[1]


def build_face_restore(src: Path, dest: Path, log) -> None:
    if not _venv_has("onnxruntime") or not _venv_has("cv2"):
        raise ValueError("Face restore needs onnxruntime + opencv in the project venv (install in Settings).")
    gfpgan, yunet = ensure_face_models(log)
    cmd = [str(VENV_PYTHON), str(FACE_RESTORE_SCRIPT), str(src), str(dest),
           "--gfpgan", str(gfpgan), "--detector", str(yunet)]
    log_subprocess_lines(log, run_subprocess(cmd))


_FACE_COUNT_CACHE: dict[tuple, int] = {}


def detect_face_count(path: Path) -> int:
    """Face count for analyzer gating (0 if opencv/model absent). Subprocess'd to the venv
    (cv2 isn't in the server interpreter) + cached by (path, mtime) so repeat plans are free."""
    if not _venv_has("cv2"):
        return 0
    yunet = FACE_DIR / YUNET_MODEL["file"]
    if not yunet.exists():
        return 0
    try:
        key = (str(path), path.stat().st_mtime_ns)
    except OSError:
        return 0
    if key in _FACE_COUNT_CACHE:
        return _FACE_COUNT_CACHE[key]
    n = 0
    try:
        out = subprocess.run([str(VENV_PYTHON), str(DETECT_FACES_SCRIPT), str(path), str(yunet)],
                             capture_output=True, text=True, timeout=30)
        m = re.search(r"faces=(\d+)", out.stdout or "")
        n = int(m.group(1)) if m else 0
    except (OSError, subprocess.TimeoutExpired, ValueError):
        n = 0
    _FACE_COUNT_CACHE[key] = n
    return n


def face_restore_op(payload: dict) -> dict:
    """One-shot face restoration (GFPGAN). Detects + restores faces internally — no mask.
    Transient like apply_raster_op/cleanup: scratch output, no job/library copy."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-.") or "img"
    stamp = int(time.time() * 1000) % 1000000
    out = SCRATCH_DIR / f"{stem}.face.{stamp}.png"
    build_face_restore(src, out, lambda *_a, **_k: None)
    rel = out.relative_to(OUTPUTS_DIR).as_posix()
    return {"url": "/outputs/" + "/".join(urllib.parse.quote(p) for p in rel.split("/")), "name": out.name}


def restore_op(payload: dict) -> dict:
    """Degradation fix (#58): run a spandrel restoration model (denoise/dejpeg/deblur) on the
    image. Reuses build_upscale_spandrel — the executor is model-agnostic (scale from the
    checkpoint, =1 for restoration). Transient scratch output, like apply_raster_op."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    model = (payload.get("model") or "").strip()
    if model not in SR_MODELS:
        raise ValueError(f"Unknown restore model: {model!r}")
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-.") or "img"
    stamp = int(time.time() * 1000) % 1000000
    out = SCRATCH_DIR / f"{stem}.restore.{stamp}.png"
    build_upscale_spandrel(src, out, model, 256, lambda *_a, **_k: None)
    rel = out.relative_to(OUTPUTS_DIR).as_posix()
    return {"url": "/outputs/" + "/".join(urllib.parse.quote(p) for p in rel.split("/")), "name": out.name}


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


def _resolve_output_svg(payload: dict) -> Path:
    """Resolve a caller-supplied SVG reference to a path inside OUTPUTS_DIR."""
    requested = (payload.get("path") or "").strip()
    if not requested:
        folder = (payload.get("folder") or "").strip()
        name = (payload.get("name") or "").strip()
        if not name:
            raise ValueError("Missing SVG 'path' (or 'folder' + 'name').")
        requested = str(OUTPUTS_DIR / folder / name) if folder else str(OUTPUTS_DIR / name)
    target = Path(requested).expanduser().resolve()
    try:
        target.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError(f"SVG is outside the outputs folder: {target}")
    if not target.exists():
        raise ValueError(f"SVG not found: {target}")
    if target.suffix.lower() != ".svg":
        raise ValueError("Render target must be an .svg file.")
    return target


def save_render(payload: dict) -> dict:
    """Persist a PNG the BROWSER rendered (the export modal rasterises the SVG on a
    canvas — full fidelity, no cairosvg/system dependency) next to its source SVG, so
    the export still lands in the library and can be revealed. Bytes arrive base64."""
    svg = _resolve_output_svg(payload)
    raw_b64 = (payload.get("png_base64") or "")
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    try:
        raw = base64.b64decode(raw_b64, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Invalid PNG data.")
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Rendered data is not a PNG.")
    if len(raw) > 96_000_000:
        raise ValueError("Rendered PNG is too large to save (>96 MB).")
    try:
        w, h = int(payload.get("width") or 0), int(payload.get("height") or 0)
    except (TypeError, ValueError):
        w = h = 0
    final = svg.with_name(f"{svg.stem}@{w}x{h}.png" if w > 0 and h > 0 else f"{svg.stem}.export.png")
    if final.exists():
        final.unlink()
    final.write_bytes(raw)
    invalidate_outputs_cache()
    return {
        "message": f"Saved {final.name}.",
        "output": str(final), "folder": svg.parent.name, "name": final.name,
        "size": [w, h],
    }


def save_svg(payload: dict) -> dict:
    """Write an edited SVG (from the in-app editor) next to its source as
    `{stem}.edited.svg`, confined to the outputs folder."""
    folder = (payload.get("folder") or "").strip()
    name = (payload.get("name") or "").strip()
    svg_text = payload.get("svg")
    if not folder or not name:
        raise ValueError("Missing 'folder' + 'name'.")
    # folder/name come from the client — never let them escape the outputs tree
    if name != Path(name).name or folder != Path(folder).name:
        raise ValueError("Folder/name must be plain components (no path separators).")
    if name.lower().endswith((".png", ".jpg", ".jpeg")) or not name.lower().endswith(".svg"):
        raise ValueError("Source output must be an .svg file.")
    if not isinstance(svg_text, str) or "<svg" not in svg_text.lower():
        raise ValueError("Missing or invalid 'svg' markup.")
    if len(svg_text) > MAX_SVG_SAVE_BYTES:
        raise ValueError(f"SVG is too large to save (>{MAX_SVG_SAVE_BYTES // 1_000_000} MB).")
    target_dir = (OUTPUTS_DIR / folder).resolve()
    try:
        target_dir.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Folder is outside the outputs directory.")
    if not target_dir.is_dir():
        raise ValueError(f"Output folder not found: {folder}")
    stem = name[:-4]
    if stem.endswith(".edited"):       # re-saving an edit shouldn't stack suffixes
        stem = stem[: -len(".edited")]
    out = (target_dir / f"{stem}.edited.svg").resolve()
    try:
        out.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Resolved path is outside the outputs directory.")
    out.write_text(svg_text, encoding="utf-8")
    invalidate_outputs_cache()
    _register_output(out)
    return {
        "message": f"Saved {out.name}.",
        "output": str(out),
        "folder": folder,
        "name": out.name,
    }


def save_hv(payload: dict) -> dict:
    """Save a full editor PROJECT (.hv) — the canvas markup plus the undo/redo
    history — as JSON in the outputs `canvas/` folder. Powers the library's Canvas
    tab; opening one restores layers + history."""
    raw = (payload.get("name") or "").strip()
    svg_text = payload.get("svg")
    if not raw:
        raise ValueError("Missing 'name'.")
    if not isinstance(svg_text, str) or "<svg" not in svg_text.lower():
        raise ValueError("Missing or invalid 'svg' markup.")
    stem = Path(raw).name
    for ext in (".hv", ".svg"):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "untitled"
    target_dir = (OUTPUTS_DIR / "canvas").resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    out = (target_dir / f"{stem}.hv").resolve()
    try:
        out.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Resolved path is outside the outputs directory.")
    if out.exists() and not payload.get("overwrite"):
        n = 2
        while (target_dir / f"{stem}-{n}.hv").exists():
            n += 1
        stem = f"{stem}-{n}"
        out = (target_dir / f"{stem}.hv").resolve()
    doc = {
        "version": 1,
        "name": out.name,
        "svg": svg_text,
        "history": payload.get("history") or [],
        "redo": payload.get("redo") or [],
    }
    blob = json.dumps(doc)
    if len(blob) > 96_000_000:
        raise ValueError("Project is too large to save (>96 MB).")
    out.write_text(blob, encoding="utf-8")
    invalidate_outputs_cache()
    return {"name": out.name, "url": f"/outputs/canvas/{urllib.parse.quote(out.name)}", "message": f"Saved project {out.name}"}


def list_projects() -> list[dict]:
    """List saved .hv projects (newest first) for the library's Canvas tab."""
    folder = OUTPUTS_DIR / "canvas"
    items: list[dict] = []
    if folder.is_dir():
        for p in sorted(folder.glob("*.hv"), key=lambda x: x.stat().st_mtime, reverse=True):
            items.append({
                "name": p.name,
                "url": f"/outputs/canvas/{urllib.parse.quote(p.name)}",
                "modified_at": p.stat().st_mtime,
            })
    return items


def save_svg_as(payload: dict) -> dict:
    """Save a new/opened canvas under a caller-chosen name into a dedicated
    `canvas/` folder inside the outputs tree (created on demand). Unlike
    `save_svg`, this needs no pre-existing source folder — it's the Save-As path
    for documents made with New blank canvas or Open vector, which otherwise have
    nowhere to write. Returns the folder+name so the client can wire up plain
    Save (`/api/save-svg`) for subsequent writes."""
    raw = (payload.get("name") or "").strip()
    svg_text = payload.get("svg")
    if not raw:
        raise ValueError("Missing 'name'.")
    if not isinstance(svg_text, str) or "<svg" not in svg_text.lower():
        raise ValueError("Missing or invalid 'svg' markup.")
    if len(svg_text) > MAX_SVG_SAVE_BYTES:
        raise ValueError(f"SVG is too large to save (>{MAX_SVG_SAVE_BYTES // 1_000_000} MB).")
    # Reduce the caller's name to a single safe stem; force a .svg extension.
    stem = Path(raw).name
    if stem.lower().endswith(".svg"):
        stem = stem[:-4]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "untitled"
    folder = "canvas"
    target_dir = (OUTPUTS_DIR / folder).resolve()
    try:
        target_dir.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Folder is outside the outputs directory.")
    target_dir.mkdir(parents=True, exist_ok=True)
    out = (target_dir / f"{stem}.svg").resolve()
    try:
        out.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Resolved path is outside the outputs directory.")
    # Re-saving an existing canvas doc overwrites in place; a fresh Save-As that
    # would clobber a different file disambiguates with a numeric suffix.
    if out.exists() and not payload.get("overwrite"):
        n = 2
        while (target_dir / f"{stem}-{n}.svg").exists():
            n += 1
        stem = f"{stem}-{n}"
        out = (target_dir / f"{stem}.svg").resolve()
    out.write_text(svg_text, encoding="utf-8")
    invalidate_outputs_cache()
    _register_output(out)
    return {
        "message": f"Saved {out.name}.",
        "output": str(out),
        "folder": folder,
        "name": out.name,
    }


def derive_mask_from_alpha(cutout_path: Path, mask_path: Path, threshold: int = 128) -> None:
    rgba = Image.open(cutout_path).convert("RGBA")
    alpha = rgba.getchannel("A")
    binary = alpha.point(lambda v, t=threshold: 0 if v >= t else 255)
    binary.convert("L").save(mask_path)


def _stage_on(value: object) -> bool:
    """Coerce a stage flag (JSON bool, or a stringy "true"/"1"/"on") to bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return False


def _pipeline_stages(payload: dict) -> dict:
    """Resolve the enabled stages + their methods from a pipeline payload.

    A payload with NO `stage_*` keys is the classic all-three Production SVG
    pipeline (back-compat for `/api/run/pipeline` callers that predate the strip).
    Methods fall back to the legacy single-purpose settings so an old payload
    still routes the way it used to."""
    stage_keys = ("stage_upscale", "stage_removebg", "stage_vectorize",
                  "stage_dejpeg", "stage_denoise", "stage_deblur")
    explicit = any(k in payload for k in stage_keys)
    up = _stage_on(payload.get("stage_upscale")) if explicit else True
    rb = _stage_on(payload.get("stage_removebg")) if explicit else True
    vec = _stage_on(payload.get("stage_vectorize")) if explicit else True
    # Restoration stages default OFF (legacy all-three payloads had no concept of them).
    fixes = {sid: _stage_on(payload.get(f"stage_{sid}")) for sid in RESTORE_STAGE_MODELS}

    rb_method = (payload.get("removebg_method") or "").strip().lower()
    if rb_method not in ("classical", "ai", "green"):
        rb_method = "ai" if (payload.get("cutout_backend") == "ai") else "classical"
    vec_method = (payload.get("vectorize_method") or "").strip().lower()
    if vec_method not in ("trace", "pixel"):
        vec_method = "pixel" if (payload.get("trace_mode") == "pixel") else "trace"
    return {"upscale": up, "removebg": rb, "vectorize": vec,
            "removebg_method": rb_method, "vectorize_method": vec_method, **fixes}


def _pipeline_summary(name: str, st: dict) -> str:
    parts = []
    for sid, label in (("dejpeg", "De-JPEG"), ("denoise", "Denoise"), ("deblur", "Deblur")):
        if st.get(sid):
            parts.append(label)
    if st["upscale"]:
        parts.append("Upscale")
    if st["removebg"]:
        parts.append({"green": "Greenscreen", "ai": "AI cutout"}.get(st["removebg_method"], "Cutout"))
    if st["vectorize"]:
        parts.append("Pixel trace" if st["vectorize_method"] == "pixel" else "Trace")
    return f"{' + '.join(parts) or 'Pipeline'} {name}"


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


# (capabilities taxonomy + router resolution extracted -> hvserver/capabilities.py)

def suggest_trace_settings(payload: dict) -> dict:
    """T1 "Auto": recommend vectorize settings from cheap image statistics — no
    model, milliseconds, pure numpy/PIL. Mirrors what a human does eyeballing the
    image: silhouette vs colour, flat poster art vs photographic gradients, and how
    many colours to keep. The client fills the panel from this; the user can still
    override. (A VLM recommender or a neural vectorizer would be the heavier T2/T3.)"""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    rgb = bg.convert("RGB")
    rgb.thumbnail((200, 200), Image.Resampling.LANCZOS)   # downscale for fast stats
    arr = np.asarray(rgb, dtype=np.float32)
    px_chroma = arr.max(2) - arr.min(2)                       # per-pixel saturation
    chroma = float(px_chroma.mean())                          # mean colourfulness 0–255
    # A MINORITY saturated colour (e.g. a red logo on B/W) barely moves the mean, so
    # also measure the SHARE of vivid pixels — that's what says "this needs colour".
    colorful_frac = float((px_chroma > 60).mean())
    # palette: median-cut to 32, how many colours actually hold real estate
    q = rgb.quantize(colors=32, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    frac = np.bincount(np.asarray(q).ravel(), minlength=32).astype(np.float32)
    frac = frac / max(1.0, frac.sum())
    significant = int((frac > 0.02).sum())                    # colours with >2% of pixels
    top6 = float(np.sort(frac)[::-1][:6].sum())               # coverage of the 6 biggest
    luma = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    gy, gx = np.gradient(luma)
    edge_frac = float((np.hypot(gx, gy) > 24).mean())         # share of hard-edge pixels
    near_binary = image_is_near_binary(src)
    has_alpha = source_has_alpha(src)

    if colorful_frac < 0.03:
        # No real colour: a 2-tone logo → B&W silhouette; a grayscale photo → photo
        # mode (it traces the gray levels; a silhouette would flatten the tones).
        if near_binary:
            out = {"engine": "vtracer", "trace_colormode": "bw", "trace_simplify": "medium"}
            reason = "Near-2-tone grayscale → B&W silhouette trace."
        else:
            simplify = "medium" if edge_frac > 0.2 else "light"
            out = {"engine": "vtracer", "trace_colormode": "color", "trace_color_style": "photo",
                   "color_precision": 6, "trace_simplify": simplify}
            reason = f"Grayscale, multi-tone → Colour · Photo · 6 levels · simplify {simplify}."
    else:
        # Real colour present. Few dominant colours → flat poster art; many → photo.
        # (Lean on the dominant-colour COUNT, not top-N coverage — AA fringe spreads a
        #  flat logo's 3 colours across many near-duplicate palette bins.)
        if significant <= 6:
            k = max(2, min(8, significant))
            out = {"engine": "clean", "trace_colormode": "color", "trace_color_style": "clean",
                   "color_precision": k, "trace_simplify": "medium"}
            reason = (f"Flat colour logo — {significant} dominant colours "
                      f"→ Clean engine (planar, no halos) · {k} colours · simplify medium.")
        else:
            simplify = "medium" if edge_frac > 0.2 else "light"
            out = {"engine": "vtracer", "trace_colormode": "color", "trace_color_style": "photo",
                   "color_precision": 6, "trace_simplify": simplify}
            reason = f"Photographic / gradient-rich ({significant} colours) → Colour · Photo · 6 colours · simplify {simplify}."
    out["vectorize_method"] = "trace"
    out["reason"] = reason
    out["stats"] = {"chroma": round(chroma, 1), "colorful_frac": round(colorful_frac, 3),
                    "significant_colors": significant, "top6_coverage": round(top6, 3),
                    "edge_frac": round(edge_frac, 3), "near_binary": near_binary, "has_alpha": has_alpha}
    return out


def plan_image(payload: dict) -> dict:
    """The auto-routing brain for a selected raster: classical analysis → an
    affordance-only processing plan + offered (intent) steps. No model, no LLM,
    deterministic (see tools/analyze.py and [[auto-routing-classical-not-vlm]]).
    The client drives the Auto-pipeline surface from this; the user can override.
    Model ids in the plan are intent — availability/fallback is layered by the caller."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image to analyze.")
    a = analyze.analyze(src)
    pl = analyze.plan(a)
    # Resolve each router decision against the capability registry → availability +
    # the invoke params the executor will use. Lets the UI show "needs install" / route
    # to an installed fallback instead of proposing a model that isn't there.
    for step in pl.get("auto", []) + pl.get("offered", []):
        info = resolve_capability_step(step.get("capability"), step.get("model"))
        if info:
            step["available"] = info["available"]
            step["needs"] = info["needs"]
            step["invoke"] = info["invoke"]
            if info.get("size_mb"):
                step["size_mb"] = info["size_mb"]
    # Face-restore is OFFERED (never auto) only when a face is actually present — the gate
    # the pixels can decide. Photographic content only (a flat graphic won't have a face).
    if a["content_class"] in ("photo", "photo_gray", "screenshot"):
        faces = detect_face_count(src)
        if faces > 0:
            step = {"capability": "face", "intent": "restore", "model": "gfpgan",
                    "why": f"{faces} face{'s' if faces != 1 else ''} detected — restore if low-quality."}
            info = resolve_capability_step("face", "gfpgan")
            if info:
                step["available"] = info["available"]
                step["needs"] = info["needs"]
                step["invoke"] = info["invoke"]
            pl["offered"].append(step)
    return {"analysis": a, "plan": pl}


def trace_preview(payload: dict) -> dict:
    """SYNCHRONOUS, resolution-capped vectorize for the raster panel's LIVE preview.
    Resolves the selected canvas raster (`input_url`) and runs it through the single
    `vectorize_svg` dispatch (same engine the commit/pipeline uses → no drift),
    returning SVG text directly. No job, no saved output. The cap keeps each trace
    fast enough to drive a debounced live preview as the user drags sliders."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image for preview.")
    cap = max(64, min(2048, int(payload.get("preview_max_dim") or TRACE_PREVIEW_DIM)))
    svg_text = vectorize_svg(src, payload, max_dim=cap)
    return {"svg": svg_text, "nodes": len(re.findall(r"[MLCZ]", svg_text)), "capped": cap}


def run_pipeline(payload: dict) -> dict:
    """Generalized pipeline: upscale → remove-bg → vectorize, each stage
    independently toggleable. The 6 old processes are just stage subsets of this
    one route (see `_pipeline_stages`). Disabled trailing stages early-stop the
    job at a PNG; the legacy single-purpose endpoints remain for back-compat."""
    st = _pipeline_stages(payload)
    up, rb, vec = st["upscale"], st["removebg"], st["vectorize"]
    rb_method, vec_method = st["removebg_method"], st["vectorize_method"]
    active_fixes = [sid for sid in RESTORE_STAGE_MODELS if st.get(sid)]   # dejpeg/denoise/deblur, in flow order
    if not (up or rb or vec or active_fixes):
        return {"message": "Enable at least one pipeline stage.", "started": 0, "skipped": []}

    model = payload.get("model", "realesrgan-x4plus")
    scale = int(payload.get("scale", "4"))
    cutout_model = (payload.get("cutout_model") or "u2net").strip()
    alpha_matting = bool(payload.get("alpha_matting"))
    trace = trace_config(payload)
    mask_cfg = mask_config(payload)
    pv_cfg = pixelvec_config(payload)

    # Fail fast on missing prerequisites for the stages that are actually on.
    if vec and vec_method == "trace":
        ensure_tools_ready("vtracer")
    if rb and rb_method == "ai" and not rembg_installed():
        raise ValueError("AI cutout requested but rembg is not installed. Install it from Settings, or use the classical method.")
    if (active_fixes or (up and model in SR_MODELS)) and not spandrel_installed():
        raise ValueError("This pipeline needs spandrel (denoise/de-JPEG/deblur or a spandrel upscale model). Install it from Settings.")

    # Skip-detection is stage-aware: skip a discovered image only when THIS
    # stage-set's terminal output already exists (see is_pipeline_processed).
    # Explicit selections (single mode) and input_path bypass skip by contract —
    # the client guards those — so we only filter the discover branch here.
    targets, _ = select_inputs(payload)
    skipped: list[str] = []
    explicit = bool(payload.get("inputs")) or bool(payload.get("input_path", "").strip()) \
        or bool(payload.get("input_url", "").strip())   # a canvas raster's href is an explicit single target
    if not explicit and not payload.get("force"):
        kept: list[Path] = []
        for f in targets:
            if is_pipeline_processed(st, f.stem):
                skipped.append(f.name)
            else:
                kept.append(f)
        targets = kept
    if not targets:
        return {"message": _skip_message("run pipeline on", skipped), "started": 0, "skipped": skipped}
    # A focused on-canvas run (input_url) is the interactive path: the canvas is the
    # destination, so its outputs are NOT library deliverables. Write them to a HIDDEN
    # output dir (dot-prefixed → excluded from list_outputs) under a friendly stem from the
    # raster's name (not the materialized inline-<hash> input), and trace at the same
    # resolution the live preview uses so a focused vectorize matches the preview (WYSIWYG).
    # A user-set target_max_dim already downscaled the intermediate above, so don't second-
    # guess it; batch/library runs (no input_url) keep the full ceiling and a visible dir.
    focused = bool(payload.get("input_url", "").strip())
    vec_dim = TRACE_PREVIEW_DIM if (focused and mask_cfg["target_max_dim"] is None) else None
    if focused:
        _prune_focused_pipeline_dirs()   # bound old hidden focused-run dirs BEFORE we mint a new one
    out_dir = output_dir("pipeline", hidden=focused)
    friendly = _safe_stem(payload.get("input_name")) if focused else None
    total = len(active_fixes) + sum((up, rb, vec)) + 1   # +1 for the closing "Done" tick
    jobs_started = []
    for src in targets:
        stem = friendly or src.stem
        job_name = (payload.get("input_name") or src.name) if focused else src.name
        upscale_dest = out_dir / f"{stem}.png"
        mask_dest = out_dir / f"{stem}.mask.png"
        cutout_dest = out_dir / f"{stem}.cutout.png"
        vector_dest = out_dir / f"{stem}.svg"
        def worker(log, src=src, stem=stem, upscale_dest=upscale_dest, mask_dest=mask_dest, cutout_dest=cutout_dest, vector_dest=vector_dest) -> None:
            step = {"n": 0}
            def tick(label):
                step["n"] += 1
                _report_progress(step["n"], total, label)
            current = src   # the image flowing between stages

            # --- 0) Degradation fixes (restoration prelude): dejpeg → denoise → deblur, BEFORE
            #        upscale (clean then enlarge). Each is a spandrel scale-1 model; chain them.
            #        When restoration is the ONLY work, the last fix writes the terminal PNG.
            restore_terminal = not (up or rb or vec)
            for i, sid in enumerate(active_fixes):
                tick({"dejpeg": "De-JPEG", "denoise": "Denoise", "deblur": "Deblur"}[sid])
                last = i == len(active_fixes) - 1
                dest = upscale_dest if (restore_terminal and last) else (out_dir / f"{stem}.fix-{sid}.png")
                log(f"{sid} via spandrel ({RESTORE_STAGE_MODELS[sid]}).")
                build_upscale_spandrel(current, dest, RESTORE_STAGE_MODELS[sid], 256, log)
                _register_output(dest)
                current = dest

            # --- 1) Upscale ---
            if up:
                tick("Upscale")
                if source_has_alpha(current):
                    log(f"Alpha-aware source detected for {current.name}; using deterministic upscale.")
                    deterministic_upscale(current, upscale_dest, scale)
                elif model in SR_MODELS:
                    log(f"Upscale via spandrel ({model}).")
                    build_upscale_spandrel(current, upscale_dest, model, 256, log)
                else:
                    ensure_tools_ready("realesrgan")
                    lines = run_subprocess(
                        [str(REALESRGAN_BIN), "-i", str(current), "-o", str(upscale_dest),
                         "-n", model, "-s", str(scale)],
                        cwd=REALESRGAN_DIR,
                    )
                    log_subprocess_lines(log, lines)
                _register_output(upscale_dest)
                current = upscale_dest

            # Optional downscale before the heavier stages, on whatever's current.
            if mask_cfg["target_max_dim"] is not None and (rb or vec):
                preview_path = out_dir / f"{stem}.preview.png"
                staged = apply_preprocess(current, preview_path, target_max_dim=mask_cfg["target_max_dim"])
                if staged is not current:
                    log(f"Resized intermediate to max dim {mask_cfg['target_max_dim']}.")
                    _register_output(preview_path)
                    current = staged

            # --- 2) Remove background ---
            if rb:
                tick({"green": "Greenscreen key", "ai": "AI cutout"}.get(rb_method, "Build mask + cutout"))
                if rb_method == "green":
                    build_chromakey_cutout(current, cutout_dest)
                    validate_cutout_png(cutout_dest)
                    derive_mask_from_alpha(cutout_dest, mask_dest)
                    validate_mask_png(mask_dest)
                elif rb_method == "ai":
                    log(f"AI cutout via rembg ({cutout_model}).")
                    build_ai_cutout(current, cutout_dest, cutout_model, alpha_matting, log)
                    validate_cutout_png(cutout_dest)
                    derive_mask_from_alpha(cutout_dest, mask_dest)
                    validate_mask_png(mask_dest)
                else:   # classical (writes both mask + cutout off `current`)
                    build_mask_with_overrides(current, mask_dest, cutout_dest, mask_cfg)
                    validate_mask_png(mask_dest)
                    validate_cutout_png(cutout_dest)
                _register_output(mask_dest)
                _register_output(cutout_dest)
                current = cutout_dest

            # --- 3) Vectorize (or early-stop at the PNG) ---
            # ONE dispatch (vectorize_svg) shared with the live preview — the engine
            # resolves from the payload (clean / vtracer-colour / vtracer-bw / pixel).
            if vec:
                tick("Pixel trace" if vec_method == "pixel" else "Trace SVG")
                vector_dest.write_text(vectorize_svg(current, payload, max_dim=vec_dim, log=log), encoding="utf-8")
                if vec_method == "pixel":
                    validate_pixelvec_svg(vector_dest)
                else:
                    validate_svg_file(vector_dest)
                _register_output(vector_dest)

            _report_progress(total, total, "Done")

        jobs_started.append(
            launch_internal_job(
                "pipeline", _pipeline_summary(job_name, st), worker,
                source_name=job_name, output_dir=str(out_dir),
            )
        )
    msg = f"Started {len(jobs_started)} pipeline job(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    # Job ids let a single-target caller (the raster panel) await its job and then
    # swap the produced output onto the canvas.
    return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started),
            "skipped": skipped, "jobs": [j["id"] for j in jobs_started]}


# (#29 files layer -> hvserver/files.py - region 3/3: uploads + rename/remove + work-item info + reveal)


# (#29 jobs layer -> hvserver/jobs.py: clear_finished_jobs)




def shlex_quote(value: str) -> str:
    import shlex

    return shlex.quote(value)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        _touch_heartbeat()   # any request from the UI counts as "still alive"
        if parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
        if parsed.path == "/api/heartbeat":
            # The UI's keep-alive ping (also lets launch.sh tell a current server
            # from a stale one that predates this endpoint). Cheap + no-store.
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/status":
            self.send_json(tool_status())
            return
        if parsed.path == "/api/version":
            self.send_json(version_info())
            return
        if parsed.path == "/api/source":
            self.send_json(get_source_info())
            return
        if parsed.path == "/api/work-items":
            self.send_json([work_item_record(path) for path in discover_work_items()])
            return
        if parsed.path == "/api/work-items/info":
            params = urllib.parse.parse_qs(parsed.query)
            name_list = params.get("name") or []
            try:
                self.send_json(work_item_info(name_list[0] if name_list else ""))
            except Exception as exc:  # noqa: BLE001
                self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/jobs":
            # Deep-copy under the lock: send_json/json.dumps runs unlocked, and worker
            # threads mutate log_lines/progress live — encoding the shared dicts could
            # yield torn JSON or a dict-changed-size error in the handler thread.
            with jobs_lock:
                data = copy.deepcopy(list(reversed(list(jobs.values()))))
            self.send_json(data)
            return
        if parsed.path == "/api/outputs":
            self.send_json(list_outputs())
            return
        if parsed.path == "/api/projects":
            self.send_json(list_projects())
            return
        if parsed.path == "/api/vectorize/engines":
            self.send_json(vectorize_engines_info())
            return
        if parsed.path == "/api/raster-ops":
            self.send_json(raster_ops_info())
            return
        if parsed.path == "/api/capabilities":
            self.send_json(capabilities_info())
            return
        if parsed.path == "/api/limits":
            # Save guards the client mirrors (so the bake-vs-link decision uses the real cap).
            self.send_json({"max_svg_bytes": MAX_SVG_SAVE_BYTES})
            return
        if parsed.path.startswith("/work-items/"):
            path = resolve_work_item(parsed.path.removeprefix("/work-items/"))
            if path is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            # ?w=N → a resized thumbnail (the gallery serves these so it isn't
            # downloading the full-res originals just to shrink them with CSS).
            w = urllib.parse.parse_qs(parsed.query).get("w", [None])[0]
            if w and w.isdigit():
                self.serve_thumbnail(path, int(w))
                return
            self.serve_file(path)
            return
        if parsed.path.startswith("/outputs/"):
            rel = Path(urllib.parse.unquote(parsed.path.removeprefix("/outputs/")))
            path = (OUTPUTS_DIR / rel).resolve()
            try:
                path.relative_to(OUTPUTS_DIR.resolve())
            except ValueError:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            self.serve_file(path)
            return
        if parsed.path.startswith("/assets/"):
            rel = Path(urllib.parse.unquote(parsed.path.removeprefix("/assets/")))
            path = (ASSETS_DIR / rel).resolve()
            try:
                path.relative_to(ASSETS_DIR.resolve())
            except ValueError:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            self.serve_file(path)
            return
        if parsed.path.startswith("/src/"):
            rel = Path(urllib.parse.unquote(parsed.path.removeprefix("/src/")))
            path = (SRC_DIR / rel).resolve()
            try:
                path.relative_to(SRC_DIR.resolve())
            except ValueError:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            self.serve_file(path)
            return
        file_name = STATIC_FILES.get(parsed.path)
        if file_name:
            self.serve_file(APP_DIR / file_name)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    @staticmethod
    def _host_is_loopback(value: str) -> bool:
        if not value:
            return True   # header absent → non-browser client (curl/tests), not the CSRF threat
        host = urllib.parse.urlsplit(value if "//" in value else "//" + value).hostname
        return host in ("127.0.0.1", "localhost", "::1")

    def _request_is_local(self) -> bool:
        # The server binds 127.0.0.1, but any web page in any browser can still POST to it
        # cross-site (a text/plain fetch skips CORS preflight). Reject unless the request is
        # loopback-addressed and same-origin: closes browser CSRF + DNS-rebinding on the
        # write surface. GET stays open (it serves same-origin UI assets).
        if not self._host_is_loopback(self.headers.get("Host")):
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            return self._host_is_loopback(origin)
        return self._host_is_loopback(self.headers.get("Referer"))

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        _touch_heartbeat()   # any request from the UI counts as "still alive"
        if not self._request_is_local():
            self.send_error(HTTPStatus.FORBIDDEN, "Cross-origin POST refused")
            return
        heavy = parsed.path in HEAVY_SYNC_PATHS   # in-flight while this thread does the compute
        if heavy:
            _inflight_incr()
        try:
            if parsed.path == "/api/upload":
                result = save_uploaded_files(self)
                self.send_json(result)
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = _read_body(self, length) if length else b"{}"
            try:
                payload = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON")
                return
            if parsed.path == "/api/install/realesrgan":
                result = install_realesrgan()
            elif parsed.path == "/api/install/vtracer":
                result = install_vtracer()
            elif parsed.path == "/api/install/rembg":
                result = install_rembg()
            elif parsed.path == "/api/install/spandrel":
                result = install_spandrel()
            elif parsed.path == "/api/cleanup":
                result = cleanup_inpaint(payload)
            elif parsed.path == "/api/face-restore":
                result = face_restore_op(payload)
            elif parsed.path == "/api/restore":
                result = restore_op(payload)
            elif parsed.path == "/api/install/opencv":
                result = install_opencv()
            elif parsed.path == "/api/update/check":
                result = check_update(payload)
            elif parsed.path == "/api/update/apply":
                result = apply_update(payload)
            elif parsed.path == "/api/work-items/remove":
                result = remove_work_item(payload)
            elif parsed.path == "/api/work-items/rename":
                result = rename_work_item(payload)
            elif parsed.path == "/api/outputs/rename":
                result = rename_output(payload)
            elif parsed.path == "/api/outputs/remove":
                result = remove_output(payload)
            elif parsed.path == "/api/save-render":
                result = save_render(payload)
            elif parsed.path == "/api/save-svg":
                result = save_svg(payload)
            elif parsed.path == "/api/save-svg-as":
                result = save_svg_as(payload)
            elif parsed.path == "/api/save-hv":
                result = save_hv(payload)
            elif parsed.path == "/api/reveal":
                result = reveal_path(payload)
            elif parsed.path == "/api/source":
                result = set_source_dir_api(payload)
            elif parsed.path == "/api/jobs/clear":
                result = clear_finished_jobs()
            elif parsed.path == "/api/jobs/cancel":
                result = cancel_job(payload)
            elif parsed.path == "/api/jobs/retry":
                result = retry_job(payload)
            elif parsed.path == "/api/run/pipeline":
                result = run_pipeline(payload)
            elif parsed.path == "/api/trace-preview":
                result = trace_preview(payload)
            elif parsed.path == "/api/trace-suggest":
                result = suggest_trace_settings(payload)
            elif parsed.path == "/api/plan":
                result = plan_image(payload)
            elif parsed.path == "/api/raster-op":
                result = apply_raster_op(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
                return
        except PayloadTooLarge as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        except (ValueError, KeyError) as exc:
            # Bad/missing payload fields → genuinely the caller's fault.
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        except Exception as exc:  # noqa: BLE001
            # Server-side fault (disk full, subprocess crash, bug) — don't mis-bucket as 400.
            self.send_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        finally:
            if heavy:
                _inflight_decr()
        self.send_json(result)

    def serve_thumbnail(self, path: Path, w: int) -> None:
        w = max(16, min(1024, w))
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)
                im.thumbnail((w, w), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                if im.mode in ("RGBA", "LA", "P"):   # keep transparency → PNG
                    im.convert("RGBA").save(buf, "PNG", optimize=True)
                    ctype = "image/png"
                else:
                    im.convert("RGB").save(buf, "JPEG", quality=82)
                    ctype = "image/jpeg"
            data = buf.getvalue()
        except Exception:  # noqa: BLE001 — a bad/odd image just falls back to the original
            self.serve_file(path)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(data)

    def serve_file(self, path: Path) -> None:
        if not path.is_file():   # missing OR a directory — read_bytes() on a dir would crash the handler
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self.send_response(HTTPStatus.OK)
        content_type, _ = mimetypes.guess_type(path.name)
        content_type = content_type or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "image/svg+xml"}:
            content_type = f"{content_type}; charset=utf-8"
        self.send_header("Content-Type", content_type)
        # No build step → the app is the source files. Code/markup must never be cached
        # by the browser, or edits silently don't take after a reload (the recurring
        # "it doesn't work after I changed it" trap). Images/binaries stay cacheable.
        base = content_type.split(";", 1)[0]
        if base in {"text/html", "text/css", "application/javascript", "text/javascript"} or path.suffix.lower() in {".js", ".mjs", ".css", ".html"}:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(path.read_bytes())

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def main() -> None:
    ensure_dirs()
    seed_inputs()
    bootstrap_tools()
    _gc_outputs()   # sweep stale recovery-scratch left by prior sessions on the way up
    port = int(os.environ.get("PORT", "2002"))
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
    print(f"hector-vector UI: http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _gc_outputs()   # and again on the way down
        server.server_close()


if __name__ == "__main__":
    main()
