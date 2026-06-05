#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
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


APP_DIR = Path(__file__).resolve().parent
TOOLS_DIR = APP_DIR / "tools"
sys.path.insert(0, str(TOOLS_DIR))
import pixelvec  # noqa: E402  (pure numpy/PIL, no venv needed)
import svg_render  # noqa: E402  (pure Pillow for axis-aligned SVGs; cairosvg optional)
import simplify_svg  # noqa: E402  (pure numpy; refit traced paths to minimal cubics)
import analyze  # noqa: E402  (pure numpy/PIL; the classical auto-routing brain — analyze→plan)
# `.webmanifest` is not in the stdlib mime table; Chromium wants a JSON-ish type.
mimetypes.add_type("application/manifest+json", ".webmanifest")
OUTPUTS_DIR = APP_DIR / "outputs"
# Transient in-place raster results (panel upscale/remove-bg) live here. Dot-prefixed
# so the library scan skips them — applying a stage edits the canvas, it doesn't
# publish a library copy. Served via /outputs/ so the client (and a later vectorize)
# can still resolve the URL.
SCRATCH_DIR = OUTPUTS_DIR / ".scratch"
INPUTS_DIR = APP_DIR / "inputs"
# Safety ceiling for the vectorize stage. Tracing scales with PIXELS, not display size,
# so an oversized raster — most acutely an upscaled one (Real-ESRGAN x4 → a 7000px+ image)
# fed straight into Vectorize — overproduces a giant SVG (one connected region's boundary
# becomes tens of thousands of nodes) and can wedge the simplify refit for minutes. Vectors
# gain no perceptible fidelity past this, so normalise the trace resolution. The live
# preview + focused runs cap tighter still (TRACE_PREVIEW_DIM, below); this is the BATCH
# ceiling, keeping a headless library trace in the same league instead of exploding to full
# res. Images at/under this are passed through untouched.
TRACE_MAX_DIM = 1600
# Absolute upper bound on a user-chosen trace size (the "Max trace size" override): even an
# explicit opt-in is clamped here so a pathological value can't OOM / wedge the tracer.
TRACE_ABS_MAX_DIM = 6000
# The WYSIWYG resolution: both the live preview and a FOCUSED on-canvas run trace at this,
# so what you preview is what you commit. Tighter than the batch ceiling above on purpose —
# the focused/interactive path favours a clean, fast, preview-identical result. Batch/library
# runs (no preview to match) still trace up to TRACE_MAX_DIM. Mirrors the client's
# TRACE_PREVIEW_DIM; the preview route clamps any requested value to 64..2048.
TRACE_PREVIEW_DIM = 1000
# Single source of truth for the editor-SVG save guard. The client mirrors this via
# /api/limits so the two can't drift (it decides whether to bake rasters or fall back to
# linked refs BEFORE sending, to avoid a doomed round-trip).
MAX_SVG_SAVE_BYTES = 16_000_000
ASSETS_DIR = APP_DIR / "assets"
SRC_DIR = APP_DIR / "src"          # ES-module tree: hv/ library + editor + app shell
WORKSPACE_DIR = APP_DIR

# Single source of truth for the version, shared with the frontend via /api/version.
try:
    APP_VERSION = (APP_DIR / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
except OSError:
    APP_VERSION = "0.0.0"
GITHUB_REPO = "asuramaya/hector-vector"
MASK_PREP_SCRIPT = APP_DIR / "mask_trace_prep.py"
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/sw.js": "sw.js",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
DERIVATIVE_MARKERS = (".cutout.", ".chromakey.", ".mask.", ".newmask.", ".preview.")
CONFIG_PATH = APP_DIR / ".hector-config.json"
DEFAULT_SOURCE_DIR = APP_DIR / "inputs"
_config_lock = threading.Lock()


def is_derivative_name(name: str) -> bool:
    lower = name.lower()
    return any(marker in lower for marker in DERIVATIVE_MARKERS)


def _load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def source_dir() -> Path:
    with _config_lock:
        cfg = _load_config()
        candidate = cfg.get("source_dir")
    if candidate:
        path = Path(candidate).expanduser()
        if path.is_dir():
            return path.resolve()
    return DEFAULT_SOURCE_DIR


def set_source_dir(new_path: str) -> Path:
    if not new_path:
        raise ValueError("Source folder path is empty.")
    path = Path(new_path).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"Folder does not exist: {path}")
    if not path.is_dir():
        raise ValueError(f"Not a folder: {path}")
    with _config_lock:
        cfg = _load_config()
        cfg["source_dir"] = str(path)
        _save_config(cfg)
    return path

REALESRGAN_RELEASE = (
    "https://github.com/xinntao/Real-ESRGAN/releases/download/"
    "v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
)
REALESRGAN_DIR = TOOLS_DIR / "realesrgan-ncnn-vulkan"
REALESRGAN_BIN = REALESRGAN_DIR / "realesrgan-ncnn-vulkan"
VTRACER_BIN = TOOLS_DIR / "cargo" / "bin" / "vtracer"
SUPIR_WRAPPER = TOOLS_DIR / "supir" / "run_supir.sh"
VENV_DIR = APP_DIR / ".venv"
VENV_PYTHON = VENV_DIR / "bin" / "python3"
AI_CUTOUT_SCRIPT = TOOLS_DIR / "ai_cutout.py"


def rembg_installed() -> bool:
    # `import rembg` pulls in torch/onnxruntime (~10–17s), so a literal import
    # probe is far too heavy to run on tool_status() / raster-ops fetches. Locate
    # the package with find_spec instead — it resolves the module without executing
    # it, so this is interpreter-startup cheap (~30ms) and always reflects reality.
    if not VENV_PYTHON.exists():
        return False
    try:
        result = subprocess.run(
            [str(VENV_PYTHON), "-c",
             "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('rembg') else 1)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
# Per-job non-serializable state (subprocess handle, retry factory, cancel flag).
# Kept separate so jobs dict stays JSON-safe.
job_internals: dict[str, dict] = {}

JOB_CONCURRENCY = max(1, int(os.environ.get("HECTOR_CONCURRENCY", "1")))
job_queue: "queue.Queue[tuple[str, object]]" = queue.Queue()
TERMINAL_JOB_STATES = {"done", "failed", "cancelled"}
_workers_started = threading.Event()


def _cancel_requested(job_id: str) -> bool:
    return bool(job_internals.get(job_id, {}).get("cancel_requested"))


def _set_internal(job_id: str, **kwargs) -> None:
    with jobs_lock:
        job_internals.setdefault(job_id, {}).update(kwargs)


# Thread-local current-job binding so run_subprocess can register its
# Popen handle with the right job for cancel.
_current_job = threading.local()


def _set_current_job(job_id: str | None) -> None:
    _current_job.job_id = job_id


def _current_job_id() -> str | None:
    return getattr(_current_job, "job_id", None)


def _report_progress(step: int, total: int, label: str | None = None) -> None:
    job_id = _current_job_id()
    if not job_id:
        return
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        job["progress"] = {"step": step, "total": total, "label": label}


def _register_output(path: Path) -> None:
    job_id = _current_job_id()
    if not job_id:
        return
    try:
        rel = path.relative_to(OUTPUTS_DIR).as_posix()
    except ValueError:
        rel = str(path)
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        outs = job.setdefault("outputs", [])
        if rel not in outs:
            outs.append(rel)
    invalidate_outputs_cache()


def _queue_worker() -> None:
    while True:
        job_id, runner = job_queue.get()
        try:
            with jobs_lock:
                job = jobs.get(job_id)
                if job is None:
                    continue
                if job["status"] != "queued":
                    continue
                if _cancel_requested(job_id):
                    job["status"] = "cancelled"
                    job["returncode"] = -1
                    job["started_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    continue
                job["status"] = "running"
                job["started_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            try:
                _set_current_job(job_id)
                runner()
            except Exception as exc:  # noqa: BLE001
                with jobs_lock:
                    job = jobs.get(job_id)
                    if job is not None:
                        job["log_lines"].append(f"worker error: {exc}")
                        job["status"] = "cancelled" if _cancel_requested(job_id) else "failed"
                        job["returncode"] = 1
            finally:
                _set_current_job(None)
            invalidate_outputs_cache()
        finally:
            job_queue.task_done()


def start_workers() -> None:
    if _workers_started.is_set():
        return
    _workers_started.set()
    for _ in range(JOB_CONCURRENCY):
        threading.Thread(target=_queue_worker, daemon=True).start()


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


_id_counter = 0
_id_lock = threading.Lock()


def now_id(prefix: str) -> str:
    global _id_counter
    with _id_lock:
        _id_counter += 1
        n = _id_counter
    return f"{prefix}-{int(time.time() * 1000)}-{n:04d}"


def shell_join(parts: list[str]) -> str:
    return subprocess.list2cmdline(parts)


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
        "supir_hook_installed": SUPIR_WRAPPER.exists(),
        "rembg_installed": rembg_ok,
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


def require_path(path_str: str, kind: str) -> Path:
    if not path_str:
        raise ValueError(f"Missing {kind} path.")
    path = Path(path_str).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"{kind.capitalize()} path does not exist: {path}")
    return path


def output_dir(label: str, hidden: bool = False) -> Path:
    stamp = time.strftime('%Y%m%d-%H%M%S')
    # A hidden dir is dot-prefixed: still served under /outputs/ (so the canvas can fetch
    # its result) but skipped by list_outputs — used for focused on-canvas runs whose output
    # lands on the canvas, not in the library.
    name = f"{'.' if hidden else ''}{label}-{stamp}-{int(time.time() * 1000) % 1000:03d}"
    base = OUTPUTS_DIR / name
    out = base
    suffix = 1
    while out.exists():
        out = OUTPUTS_DIR / f"{base.name}-{suffix}"
        suffix += 1
    out.mkdir(parents=True, exist_ok=False)
    return out


def _safe_stem(name: str | None) -> str | None:
    """A filesystem-safe stem from a display name (drops any extension + path bits), or
    None if there's nothing usable — callers fall back to the source file's own stem."""
    if not name:
        return None
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(str(name)).stem).strip("-.")
    return s or None


def _prune_focused_pipeline_dirs(keep: int = 24) -> None:
    """Bound the hidden focused-run output dirs (`.pipeline-*`). Their results have already
    been placed on the canvas, so they're recovery scratch, not deliverables. Remove EMPTY
    ones, and SVG-terminal ones (the vector was inlined into the canvas → the files are
    disposable) beyond the most-recent `keep`. NEVER touch a PNG-only dir: an upscale /
    remove-bg result is referenced by the live canvas <image href>, so deleting it would
    break the image on the canvas."""
    try:
        dirs = sorted(OUTPUTS_DIR.glob(".pipeline-*"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    now = time.time()
    svg_terminal_seen = 0
    for d in dirs:
        if not d.is_dir():
            continue
        try:
            files = [f for f in d.iterdir() if f.is_file()]
        except OSError:
            continue
        if not files:                                   # empty → safe to drop, but only once
            try:                                         # it's clearly stale (never race an
                stale = (now - d.stat().st_mtime) > 120  # in-flight job that just mkdir'd it)
            except OSError:
                stale = False
            if stale:
                _rmtree_quiet(d)
            continue
        has_svg = any(f.suffix.lower() == ".svg" for f in files)
        if not has_svg:                                 # PNG-only → may back a live canvas href; keep
            continue
        svg_terminal_seen += 1
        if svg_terminal_seen > keep:
            _rmtree_quiet(d)


def _rmtree_quiet(path: Path) -> None:
    try:
        for child in path.iterdir():
            if child.is_file():
                child.unlink()
        path.rmdir()
    except OSError:
        pass


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


_preprocess_cache: dict[tuple, Path] = {}
_preprocess_cache_lock = threading.Lock()
_PREPROCESS_CACHE_MAX = 8


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
        if hit is not None and (hit == src or hit.exists()):
            return hit
    # Miss — resize outside the lock (CPU/IO bound), then publish under it.
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(repr(key).encode()).hexdigest()[:16]
    dest = SCRATCH_DIR / f"pp-{digest}{src.suffix.lower() or '.png'}"
    out = apply_preprocess(src, dest, target_max_dim=target_max_dim)
    with _preprocess_cache_lock:
        _preprocess_cache[key] = out
        while len(_preprocess_cache) > _PREPROCESS_CACHE_MAX:
            old_key, old_path = next(iter(_preprocess_cache.items()))
            del _preprocess_cache[old_key]
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


def iter_inputs(input_path: Path) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    files = sorted(p for p in input_path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
    if not files:
        raise ValueError(f"No supported image files found in {input_path}")
    return files


def discover_work_items() -> list[Path]:
    base = source_dir()
    if not base.is_dir():
        return []
    try:
        children = list(base.iterdir())
    except OSError:
        return []
    items: dict[str, Path] = {}
    for path in children:
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if is_derivative_name(path.name):
            continue
        items.setdefault(path.name, path)
    return sorted(items.values(), key=lambda path: path.name.lower())


def resolve_work_item(name: str) -> Path | None:
    clean_name = Path(urllib.parse.unquote(name)).name
    path = source_dir() / clean_name
    if path.exists() and path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
        return path
    return None


def _materialize_data_url(url: str) -> Path | None:
    """Decode a `data:` URI raster into the scratch dir so a self-contained SVG
    (its <image> hrefs baked to base64 on save/export) stays re-processable by the
    pipeline — reopen a portable .svg and you can still upscale / cutout / re-trace
    its rasters. Keyed by content hash so repeated runs reuse one file."""
    m = re.match(r"data:([^;,]*)((?:;[^,]*)*),(.*)$", url, re.DOTALL)
    if not m:
        return None
    mime, params, payload = m.group(1), m.group(2), m.group(3)
    try:
        if ";base64" in params:
            data = base64.b64decode(payload, validate=False)
        else:
            data = urllib.parse.unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        return None
    if not data:
        return None
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
           "image/gif": ".gif", "image/bmp": ".bmp"}.get(mime.strip().lower()) \
        or mimetypes.guess_extension((mime.split(";")[0] or "").strip()) or ".png"
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    out = SCRATCH_DIR / f"inline-{hashlib.sha1(data).hexdigest()[:16]}{ext}"
    if not out.exists():
        out.write_bytes(data)
    _prune_scratch_inline(keep=40, exclude=out)
    return out


def _prune_scratch_inline(keep: int = 40, exclude: Path | None = None) -> None:
    """Cap the materialized `inline-*` data-URI scratch files so they don't accumulate
    across reopen-and-reprocess cycles. Keep the most-recently-modified `keep`; the file
    just written is always kept (exclude)."""
    try:
        files = sorted(SCRATCH_DIR.glob("inline-*"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    for p in files[keep:]:
        if p == exclude:
            continue
        try:
            p.unlink()
        except OSError:
            pass


def resolve_source_url(url: str) -> Path | None:
    """Resolve a canvas raster's href (`/work-items/<name>`, `/outputs/<rel>`, or an
    inlined `data:` URI) to a real file on disk. The raster panel runs pipeline stages
    on the selected image without the client ever needing the absolute path — it just
    hands back the node's href. Returns None for anything outside the tree."""
    s = (url or "").strip()
    if s.startswith("data:"):
        return _materialize_data_url(s)
    raw = urllib.parse.unquote(s)
    if raw.startswith("/work-items/"):
        return resolve_work_item(raw.removeprefix("/work-items/"))
    if raw.startswith("/outputs/"):
        p = (OUTPUTS_DIR / Path(raw.removeprefix("/outputs/").lstrip("/"))).resolve()
        try:
            p.relative_to(OUTPUTS_DIR.resolve())
        except ValueError:
            return None
        return p if p.is_file() else None
    return None


def work_item_record(path: Path) -> dict:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return {
        "name": path.name,
        "url": f"/work-items/{urllib.parse.quote(path.name)}",
        "path": str(path),
        "origin": "source",
        "removable": True,
        "modified_at": mtime,
    }


_outputs_cache: dict = {"sig": None, "items": []}
_outputs_cache_lock = threading.Lock()
OUTPUT_FOLDER_SCAN_LIMIT = 80


def _outputs_signature() -> tuple:
    try:
        stat = OUTPUTS_DIR.stat()
    except OSError:
        return ()
    return (stat.st_mtime_ns, stat.st_size)


def list_outputs(limit: int = 240) -> list[dict]:
    sig = _outputs_signature()
    with _outputs_cache_lock:
        cached_sig = _outputs_cache["sig"]
        cached_items = _outputs_cache["items"]
    if sig == cached_sig and cached_items:
        return cached_items[:limit]

    items: list[dict] = []
    seen_names: set[str] = set()

    def _folder_key(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0

    folders = sorted(
        (folder for folder in OUTPUTS_DIR.glob("*") if folder.is_dir() and not folder.name.startswith(".")),
        key=_folder_key,
        reverse=True,
    )[:OUTPUT_FOLDER_SCAN_LIMIT]
    for folder in folders:
        try:
            children = sorted(folder.iterdir())
        except OSError:
            continue
        for path in children:
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".png", ".svg"}:
                continue
            if ".mask." in path.name:
                continue
            if path.name in seen_names:
                continue
            seen_names.add(path.name)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                mtime = 0.0
            items.append(
                {
                    "name": path.name,
                    "folder": folder.name,
                    "url": f"/outputs/{urllib.parse.quote(folder.name)}/{urllib.parse.quote(path.name)}",
                    "kind": path.suffix.lower().lstrip("."),
                    "path": str(path),
                    "modified_at": mtime,
                }
            )
    with _outputs_cache_lock:
        _outputs_cache["sig"] = sig
        _outputs_cache["items"] = items
    return items[:limit]


def invalidate_outputs_cache() -> None:
    with _outputs_cache_lock:
        _outputs_cache["sig"] = None


def pipeline_expected_output(st: dict, stem: str) -> str | None:
    """The terminal file a stage-set emits: SVG if Vectorize is on, else the
    cutout PNG if Remove-BG is on, else the Upscale PNG. Mirrors the client's
    pipelineExpectedOutput() so single- and batch-mode skip-detection agree on
    what 'already processed' means for the actual stages that will run."""
    if st.get("vectorize"):
        return f"{stem}.svg"
    if st.get("removebg"):
        return f"{stem}.cutout.png"
    if st.get("upscale"):
        return f"{stem}.png"
    return None


def is_pipeline_processed(st: dict, stem: str) -> bool:
    """True when this stage-set's terminal output already exists in a pipeline-*
    folder. Stage-aware: an upscale-only run is skipped on its PNG, a vectorize run
    on its SVG — never falsely re-run (or falsely skipped) by a fixed expectation."""
    want = pipeline_expected_output(st, stem)
    if not want:
        return False
    for folder in OUTPUTS_DIR.glob("pipeline-*"):
        if folder.is_dir() and (folder / want).exists():
            return True
    return False


def select_inputs(payload: dict) -> tuple[list[Path], list[str]]:
    """Resolve the input set: explicit `inputs`, then `input_path`, else discover
    the workspace. Skip-detection now lives in the caller (run_pipeline is
    stage-aware), so the second tuple element (skipped names) is always empty —
    it's kept only so existing `targets, _ = select_inputs(...)` sites don't change."""
    # A canvas raster hands back its href; resolve it to the backing file. Highest
    # priority so the raster panel can run a stage on exactly the selected image.
    url = payload.get("input_url", "").strip()
    if url:
        path = resolve_source_url(url)
        if path is None:
            raise ValueError(f"Could not resolve image: {url}")
        return [path], []
    selected = payload.get("inputs") or []
    if selected:
        files = []
        for name in selected:
            path = resolve_work_item(str(name))
            if path is not None:
                files.append(path)
        if files:
            return files, []
    input_path = payload.get("input_path", "").strip()
    if input_path:
        return iter_inputs(require_path(input_path, "input")), []
    files = discover_work_items()
    if not files:
        raise ValueError(f"No supported image files found in {APP_DIR}")
    return files, []


def resolve_inputs(payload: dict) -> list[Path]:
    return select_inputs(payload)[0]


def clean_log_line(line: str) -> str | None:
    noisy = [
        "queueC=",
        "queueG=",
        "queueT=",
        "bugsbn1=",
        "bugbilz=",
        "bugcopc=",
        "bugihfa=",
        "fp16-p/s/a=",
        "int8-p/s/a=",
        "subgroup=",
        "basic=",
        "vote=",
        "ballot=",
        "shuffle=",
    ]
    if any(token in line for token in noisy):
        return None
    line = line.rstrip()
    if not line:
        return None
    return line


def log_subprocess_lines(log, lines: list[str]) -> None:
    for line in lines:
        cleaned = clean_log_line(line)
        if cleaned:
            log(cleaned)


def run_subprocess(command: list[str], cwd: Path | None = None) -> list[str]:
    job_id = _current_job_id()
    proc = subprocess.Popen(
        command,
        cwd=str(cwd or APP_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if job_id:
        _set_internal(job_id, proc=proc)
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        with proc.stdout:
            for line in proc.stdout:
                lines.append(line.rstrip())
        proc.wait()
    finally:
        if job_id:
            _set_internal(job_id, proc=None)
    if proc.returncode != 0:
        if job_id and _cancel_requested(job_id):
            raise RuntimeError("cancelled")
        tail = " | ".join(line for line in lines[-8:] if line)
        raise RuntimeError(tail or shell_join(command))
    return lines


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


def _new_job_record(kind: str, summary: str | None, source_name: str | None, output_dir: str | None, *, queued: bool) -> str:
    job_id = now_id(kind)
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "queued" if queued else "running",
            "summary": summary or kind,
            "source_name": source_name,
            "output_dir": output_dir,
            "queued_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "started_at": None if queued else time.strftime("%Y-%m-%d %H:%M:%S"),
            "returncode": None,
            "log_lines": [],
            "outputs": [],
            "progress": None,
        }
    return job_id


def launch_job(
    kind: str,
    command: list[str],
    cwd: Path | None = None,
    summary: str | None = None,
    source_name: str | None = None,
    output_dir: str | None = None,
    immediate: bool = False,
    expected_outputs: list[Path] | None = None,
) -> dict:
    job_id = _new_job_record(kind, summary, source_name, output_dir, queued=not immediate)

    def retry_spec() -> dict:
        return launch_job(
            kind, command, cwd=cwd, summary=summary,
            source_name=source_name, output_dir=output_dir, immediate=immediate,
            expected_outputs=expected_outputs,
        )

    _set_internal(job_id, retry=retry_spec, retryable=True)

    def runner() -> None:
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(cwd or APP_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError as exc:
            with jobs_lock:
                jobs[job_id]["log_lines"].append(str(exc))
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["returncode"] = 127
            return
        _set_internal(job_id, proc=proc)
        with proc.stdout:
            for line in proc.stdout:
                cleaned = clean_log_line(line)
                if cleaned is None:
                    continue
                with jobs_lock:
                    jobs[job_id]["log_lines"].append(cleaned)
                    jobs[job_id]["log_lines"] = jobs[job_id]["log_lines"][-40:]
        proc.wait()
        with jobs_lock:
            jobs[job_id]["returncode"] = proc.returncode
            if _cancel_requested(job_id):
                jobs[job_id]["status"] = "cancelled"
            else:
                jobs[job_id]["status"] = "done" if proc.returncode == 0 else "failed"
        if proc.returncode == 0 and expected_outputs:
            for out_path in expected_outputs:
                if out_path.exists():
                    _register_output(out_path)

    def threaded_runner() -> None:
        _set_current_job(job_id)
        try:
            runner()
        finally:
            _set_current_job(None)
            invalidate_outputs_cache()

    if immediate:
        threading.Thread(target=threaded_runner, daemon=True).start()
    else:
        start_workers()
        job_queue.put((job_id, runner))
    return jobs[job_id]


def launch_internal_job(
    kind: str,
    summary: str,
    worker,
    immediate: bool = False,
    source_name: str | None = None,
    output_dir: str | None = None,
) -> dict:
    job_id = _new_job_record(kind, summary, source_name, output_dir, queued=not immediate)

    def retry_spec() -> dict:
        return launch_internal_job(
            kind, summary, worker, immediate=immediate,
            source_name=source_name, output_dir=output_dir,
        )

    _set_internal(job_id, retry=retry_spec, retryable=True, internal=True)

    def log(line: str) -> None:
        cleaned = clean_log_line(line) or line.strip()
        if not cleaned:
            return
        with jobs_lock:
            jobs[job_id]["log_lines"].append(cleaned)
            jobs[job_id]["log_lines"] = jobs[job_id]["log_lines"][-60:]

    def runner() -> None:
        try:
            worker(log)
            with jobs_lock:
                jobs[job_id]["returncode"] = 0
                if _cancel_requested(job_id):
                    jobs[job_id]["status"] = "cancelled"
                else:
                    jobs[job_id]["status"] = "done"
        except Exception as exc:  # noqa: BLE001
            log(str(exc))
            with jobs_lock:
                jobs[job_id]["returncode"] = 1
                jobs[job_id]["status"] = "cancelled" if _cancel_requested(job_id) else "failed"

    def threaded_runner() -> None:
        _set_current_job(job_id)
        try:
            runner()
        finally:
            _set_current_job(None)
            invalidate_outputs_cache()

    if immediate:
        threading.Thread(target=threaded_runner, daemon=True).start()
    else:
        start_workers()
        job_queue.put((job_id, runner))
    return jobs[job_id]


def cancel_job(payload: dict) -> dict:
    job_id = (payload.get("id") or "").strip()
    if not job_id:
        raise ValueError("Missing job id.")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise ValueError(f"Unknown job {job_id}.")
        if job["status"] in TERMINAL_JOB_STATES:
            return {"message": f"Job already {job['status']}.", "id": job_id}
        job_internals.setdefault(job_id, {})["cancel_requested"] = True
        status = job["status"]
        proc = job_internals.get(job_id, {}).get("proc")
        internal = bool(job_internals.get(job_id, {}).get("internal"))
        if status == "queued":
            job["status"] = "cancelled"
            job["returncode"] = -1
            job["log_lines"].append("cancelled before start")
            return {"message": "Job cancelled.", "id": job_id}
    # status == "running"
    if proc is not None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as exc:  # noqa: BLE001
            with jobs_lock:
                jobs[job_id]["log_lines"].append(f"cancel error: {exc}")
        with jobs_lock:
            jobs[job_id]["log_lines"].append("cancel signal sent to active subprocess")
        return {"message": "Cancel signal sent.", "id": job_id}
    if internal:
        # No active child process right now; the worker will stop at the
        # next subprocess call (or run to completion if it has none left).
        with jobs_lock:
            jobs[job_id]["log_lines"].append("cancel requested; will stop at next step")
        return {"message": "Cancel requested; will stop at next step.", "id": job_id}
    return {"message": "Cancel requested.", "id": job_id}


def retry_job(payload: dict) -> dict:
    job_id = (payload.get("id") or "").strip()
    if not job_id:
        raise ValueError("Missing job id.")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise ValueError(f"Unknown job {job_id}.")
        retry = job_internals.get(job_id, {}).get("retry")
        if not retry:
            raise ValueError("Job cannot be retried.")
        if job["status"] not in TERMINAL_JOB_STATES:
            raise ValueError(f"Job is {job['status']}; only finished jobs can be retried.")
    new_job = retry()
    return {"message": "Job re-queued.", "id": new_job["id"]}


def has_running_job(kind: str) -> bool:
    with jobs_lock:
        return any(job["kind"] == kind and job["status"] == "running" for job in jobs.values())


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
}


def build_ai_cutout(src: Path, dest: Path, model: str, alpha_matting: bool, log) -> None:
    if not rembg_installed():
        raise ValueError("rembg is not installed in the project venv. Click 'Install rembg' in Settings.")
    if model not in AI_CUTOUT_MODELS:
        raise ValueError(f"Unknown AI cutout model: {model}")
    cmd = [str(VENV_PYTHON), str(AI_CUTOUT_SCRIPT), str(src), str(dest), "--model", model]
    if alpha_matting:
        cmd.append("--alpha-matting")
    log_subprocess_lines(log, run_subprocess(cmd))


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
    stage_keys = ("stage_upscale", "stage_removebg", "stage_vectorize")
    explicit = any(k in payload for k in stage_keys)
    up = _stage_on(payload.get("stage_upscale")) if explicit else True
    rb = _stage_on(payload.get("stage_removebg")) if explicit else True
    vec = _stage_on(payload.get("stage_vectorize")) if explicit else True

    rb_method = (payload.get("removebg_method") or "").strip().lower()
    if rb_method not in ("classical", "ai", "green"):
        rb_method = "ai" if (payload.get("cutout_backend") == "ai") else "classical"
    vec_method = (payload.get("vectorize_method") or "").strip().lower()
    if vec_method not in ("trace", "pixel"):
        vec_method = "pixel" if (payload.get("trace_mode") == "pixel") else "trace"
    return {"upscale": up, "removebg": rb, "vectorize": vec,
            "removebg_method": rb_method, "vectorize_method": vec_method}


def _pipeline_summary(name: str, st: dict) -> str:
    parts = []
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
    if source_has_alpha(src):                       # ESRGAN drops alpha → Lanczos resize keeps it
        deterministic_upscale(src, dest, scale)
    else:
        ensure_tools_ready("realesrgan")
        run_subprocess([str(REALESRGAN_BIN), "-i", str(src), "-o", str(dest),
                        "-n", payload.get("model", "realesrgan-x4plus"), "-s", str(scale)],
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
             "options": [["realesrgan-x4plus", "ESRGAN x4+ (photo)"], ["realesrnet-x4plus", "ESRNet x4+ (cleaner)"], ["realesr-animevideov3", "Anime / line-art"]]},
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
                         ["birefnet-massive", "BiRefNet massive — hair / fine detail (928MB)"], ["silueta", "silueta — quantized U²-Net"]]},
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


# ---------------------------------------------------------------- capabilities (taxonomy)
# A DESCRIPTIVE layer over the apply/trace registries (RASTER_OPS / VECTORIZE_ENGINES):
# what OUTCOMES (capabilities × intents) exist and which model achieves each. The auto
# router (tools/analyze.plan) emits (capability, intent, model) decisions; this resolves
# them to a real plugin — install needs + the `invoke` params that select it on the EXISTING
# execution path (RASTER_OPS[op].apply for kind "raster"; vectorize_svg with engine= for
# "svg"). Adding a model is a line here, not a new panel or new plumbing. P3 capabilities
# are declared (so the router's ids resolve) with models that aren't installed yet →
# available:false until their task lands. See [[auto-routing-classical-not-vlm]].

CAPABILITIES = {
    "cutout": {
        "label": "Cutout / remove background", "kind": "raster", "op": "removebg",
        "intents": ["general", "product", "portrait", "high-res", "hair", "fast", "greenscreen"],
        "models": [
            {"id": "classical", "label": "Classical (edge/threshold)", "intents": ["fast"], "needs": [],
             "invoke": {"removebg_method": "classical"}},
            {"id": "green", "label": "Greenscreen key", "intents": ["greenscreen"], "needs": [],
             "invoke": {"removebg_method": "green"}},
            # Ordered best-first per intent: the intent resolver picks the first available
            # model serving the chosen outcome, so SOTA (BiRefNet) wins "general" over u2net.
            # Sizes are the actual ONNX weights pooch fetches on first use (verified via HEAD):
            # the full BiRefNet checkpoints are 928MB each; the swin-tiny lite is 214MB.
            {"id": "birefnet-general", "label": "BiRefNet general (OSS SOTA)", "intents": ["general", "product"],
             "needs": ["rembg"], "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-general"}},
            {"id": "birefnet-hrsod", "label": "BiRefNet HR (high-res detail)", "intents": ["high-res"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-hrsod"}},
            {"id": "birefnet-portrait", "label": "BiRefNet portrait", "intents": ["portrait"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-portrait"}},
            # Hair/fine-detail outcome: DIS5K-trained "massive" checkpoint (dichotomous seg of fine
            # structures) + alpha_matting edge refinement, switched on by the intent in one pick.
            {"id": "birefnet-massive", "label": "BiRefNet massive (DIS5K fine detail)", "intents": ["hair"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-massive", "alpha_matting": True}},
            {"id": "birefnet-general-lite", "label": "BiRefNet lite (swin-tiny)", "intents": ["general"], "needs": ["rembg"],
             "size_mb": 214, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-general-lite"}},
            {"id": "u2net", "label": "U²-Net general (lighter)", "intents": ["general"], "needs": ["rembg"], "size_mb": 176,
             "invoke": {"removebg_method": "ai", "cutout_model": "u2net"}},
        ],
    },
    "upscale": {
        "label": "Upscale", "kind": "raster", "op": "upscale",
        "intents": ["photo", "clean", "anime"],
        "models": [
            {"id": "realesrgan-x4plus", "label": "Real-ESRGAN ×4 (photo)", "intents": ["photo"], "needs": ["realesrgan"],
             "invoke": {"model": "realesrgan-x4plus"}},
            {"id": "realesrnet-x4plus", "label": "Real-ESRNet ×4 (cleaner)", "intents": ["clean"], "needs": ["realesrgan"],
             "invoke": {"model": "realesrnet-x4plus"}},
            {"id": "realesr-animevideov3", "label": "Anime / line-art ×4", "intents": ["anime"], "needs": ["realesrgan"],
             "invoke": {"model": "realesr-animevideov3"}},
        ],
    },
    "vectorize": {
        "label": "Vectorize", "kind": "svg", "op": None,
        "intents": ["logo-flat", "colour-photo", "bw-silhouette", "pixel-art"],
        "models": [
            {"id": "clean", "label": "Clean — flat logo (planar)", "intents": ["logo-flat"], "needs": ["vtracer"],
             "invoke": {"engine": "clean"}},
            {"id": "vtracer", "label": "VTracer — colour / B&W", "intents": ["colour-photo", "bw-silhouette"],
             "needs": ["vtracer"], "invoke": {"engine": "vtracer"}},
            {"id": "pixel", "label": "Pixel-art — recover grid", "intents": ["pixel-art"], "needs": [],
             "invoke": {"engine": "pixel"}},
        ],
    },
    # ---- P3 capabilities: declared so router ids resolve; models land with their tasks ----
    "dejpeg": {"label": "Remove JPEG artifacts", "kind": "raster", "op": None, "intents": ["default"],
               "models": [{"id": "fbcnn", "label": "FBCNN", "intents": ["default"], "needs": ["fbcnn"], "size_mb": 280, "invoke": {}}]},
    "denoise": {"label": "Denoise", "kind": "raster", "op": None, "intents": ["blind"],
                "models": [{"id": "scunet", "label": "SCUNet", "intents": ["blind"], "needs": ["scunet"], "size_mb": 70, "invoke": {}}]},
    "deblur": {"label": "Deblur", "kind": "raster", "op": None, "intents": ["default"],
               "models": [{"id": "nafnet", "label": "NAFNet", "intents": ["default"], "needs": ["nafnet"], "size_mb": 260, "invoke": {}}]},
    "cleanup": {"label": "Cleanup / object removal", "kind": "raster", "op": None, "intents": ["object-removal"],
                "models": [{"id": "lama", "label": "LaMa (IOPaint)", "intents": ["object-removal"], "needs": ["iopaint"], "size_mb": 200, "invoke": {}}]},
    "face": {"label": "Face restore", "kind": "raster", "op": None, "intents": ["restore"],
             "models": [{"id": "gfpgan", "label": "GFPGAN v1.4", "intents": ["restore"], "needs": ["gfpgan"], "size_mb": 340, "invoke": {}}]},
}


def _need_available(need: str) -> bool:
    """Whether an install dependency is present. P3 tools (fbcnn/scunet/nafnet/iopaint/
    gfpgan) have no integration yet → False until their task lands."""
    if need == "realesrgan":
        return REALESRGAN_BIN.exists()
    if need == "vtracer":
        return VTRACER_BIN.exists()
    if need == "rembg":
        return rembg_installed()
    return False


def _model_available(model: dict) -> bool:
    return all(_need_available(n) for n in model.get("needs", []))


def resolve_capability_step(cap_id: str, model_id: str | None) -> dict | None:
    """Resolve a router decision (capability, model) to its plugin: availability, the
    install needs, and the `invoke` params that drive the existing execution path."""
    c = CAPABILITIES.get(cap_id)
    if not c:
        return None
    for m in c["models"]:
        if m["id"] == model_id:
            return {"label": m.get("label", model_id), "available": _model_available(m),
                    "needs": m.get("needs", []), "invoke": m.get("invoke", {}),
                    "size_mb": m.get("size_mb")}
    return None


def resolve_intent(cap_id: str, intent: str) -> dict | None:
    """Given a capability + a chosen intent (the outcome the user picked, or the router's),
    pick the best AVAILABLE model serving it — preferring installed, else the first model
    that serves the intent so the UI can offer install. Models are ordered best-first, so
    'general' cutout resolves to BiRefNet over u2net. Drives the intent picker / overrides."""
    c = CAPABILITIES.get(cap_id)
    if not c:
        return None
    serving = [m for m in c["models"] if intent in m.get("intents", [])]
    if not serving:
        return None
    chosen = next((m for m in serving if _model_available(m)), serving[0])
    return {"model": chosen["id"], "label": chosen.get("label"), "available": _model_available(chosen),
            "needs": chosen.get("needs", []), "invoke": chosen.get("invoke", {}), "size_mb": chosen.get("size_mb")}


def capabilities_info() -> list[dict]:
    """Serializable capability/model registry for the client (the intent-first UI source
    of truth). Each model carries `available` (install state) + `size_mb` for the
    install-on-demand UX (#51)."""
    out = []
    for cid, c in CAPABILITIES.items():
        models = [{**m, "available": _model_available(m)} for m in c["models"]]
        out.append({"id": cid, "label": c["label"], "kind": c["kind"], "op": c.get("op"),
                    "intents": c["intents"], "models": models,
                    "implemented": any(m["available"] for m in models)})
    return out


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
    if not (up or rb or vec):
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
    total = sum((up, rb, vec)) + 1   # +1 for the closing "Done" tick
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

            # --- 1) Upscale ---
            if up:
                tick("Upscale")
                if source_has_alpha(src):
                    log(f"Alpha-aware source detected for {src.name}; using deterministic upscale.")
                    deterministic_upscale(src, upscale_dest, scale)
                else:
                    ensure_tools_ready("realesrgan")
                    lines = run_subprocess(
                        [str(REALESRGAN_BIN), "-i", str(src), "-o", str(upscale_dest),
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


def run_selftest(payload: dict) -> dict:
    targets = payload.get("inputs") or ["bridge.png", "buybot.png", "ci.png", "forcefield.png", "scanner.png"]

    def worker(log) -> None:
        processes = ["upscale", "cutout", "chromakey", "vectorize", "pipeline"]
        models = ["realesrgan-x4plus", "realesrnet-x4plus", "realesr-animevideov3"]
        scales = ["2", "4"]
        smooth_values = ["3.5", "6.5", "10"]
        total = 0
        failed = 0

        def wait_for_child_jobs(before_ids: set[str]) -> list[dict]:
            deadline = time.time() + 300
            while time.time() < deadline:
                with jobs_lock:
                    new_jobs = [job for jid, job in jobs.items() if jid not in before_ids and job["kind"] != "selftest"]
                running = [job for job in new_jobs if job["status"] == "running"]
                if not running:
                    return new_jobs
                time.sleep(0.5)
            return new_jobs

        def validate_outputs_for(proc: str, out_dir: str | None, selected: list[str]) -> None:
            if not out_dir:
                return
            folder = Path(out_dir)
            if proc == "cutout":
                for name in selected:
                    validate_cutout_png(folder / f"{Path(name).stem}.cutout.png")
            elif proc == "vectorize":
                for name in selected:
                    validate_mask_png(folder / f"{Path(name).stem}.mask.png")
                    validate_svg_file(folder / f"{Path(name).stem}.svg")
            elif proc == "pipeline":
                for name in selected:
                    validate_cutout_png(folder / f"{Path(name).stem}.cutout.png")
                    validate_mask_png(folder / f"{Path(name).stem}.mask.png")
                    validate_svg_file(folder / f"{Path(name).stem}.svg")

        for proc in processes:
            if proc == "upscale":
                combos = [(m, s, "10") for m in models for s in scales]
            elif proc == "pipeline":
                combos = [(m, s, sm) for m in models for s in scales for sm in smooth_values]
            elif proc == "vectorize":
                combos = [("realesrgan-x4plus", "4", sm) for sm in smooth_values]
            else:
                combos = [("realesrgan-x4plus", "4", "10")]

            for mode in ["single", "batch"]:
                cases = targets if mode == "single" else [None]
                for target in cases:
                    for model, scale, smooth in combos:
                        total += 1
                        payload_case = {
                            "model": model,
                            "scale": scale,
                            "trace_mode": "spline",
                            "filter_speckle": "12",
                            "corner_threshold": "170",
                            "segment_length": smooth,
                            "splice_threshold": "120",
                            "path_precision": "2",
                            "inputs": [target] if target else targets,
                        }
                        before_ids = set(jobs.keys())
                        result = globals()[f"run_{proc}"](payload_case)
                        new_jobs = wait_for_child_jobs(before_ids)
                        case_failures = [job for job in new_jobs if job["status"] == "failed"]
                        validation_error = None
                        try:
                            validate_outputs_for(proc, result.get("output_dir"), payload_case["inputs"])
                        except Exception as exc:  # noqa: BLE001
                            validation_error = str(exc)
                        if case_failures or validation_error:
                            failed += 1
                            details = "; ".join(
                                f"{job['summary']}: {' | '.join(job['log_lines'][-2:])}" for job in case_failures
                            )
                            if validation_error:
                                details = "; ".join(part for part in [details, validation_error] if part)
                            log(f"FAIL {proc} {mode} {target or 'all'} {model} {scale} {smooth} :: {details}")
                        else:
                            log(f"OK {proc} {mode} {target or 'all'} {model} {scale} {smooth} :: {result.get('message')}")
        log(f"SELFTEST COMPLETE total={total} failed={failed}")

    job = launch_internal_job("selftest", "Stress test combinations", worker, immediate=True)
    return {"message": "Started selftest job.", "job_id": job["id"]}


def run_supir(payload: dict) -> dict:
    if not SUPIR_WRAPPER.exists():
        raise ValueError("SUPIR hook not installed. Drop a wrapper at tools/supir/run_supir.sh first.")
    out_dir = output_dir("supir")
    jobs_started = []
    for src in resolve_inputs(payload):
        cmd = [str(SUPIR_WRAPPER), str(src), str(out_dir)]
        jobs_started.append(
            launch_job(
                "supir",
                cmd,
                cwd=SUPIR_WRAPPER.parent,
                summary=f"SUPIR {src.name}",
                source_name=src.name,
                output_dir=str(out_dir),
            )
        )
    return {"message": f"Started {len(jobs_started)} SUPIR job(s).", "output_dir": str(out_dir)}


def _unique_input_path(name: str) -> Path:
    target_dir = source_dir()
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValueError(f"Cannot write to source folder: {exc}")
    base = target_dir / name
    if not base.exists():
        return base
    stem = base.stem
    suffix = base.suffix
    n = 2
    while True:
        candidate = target_dir / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def _iter_multipart_parts(body: bytes, boundary: bytes):
    delim = b"--" + boundary
    start = body.find(delim)
    if start < 0:
        return
    cursor = start + len(delim)
    while cursor < len(body):
        if body[cursor:cursor + 2] == b"--":
            return
        if body[cursor:cursor + 2] == b"\r\n":
            cursor += 2
        next_delim = body.find(b"\r\n" + delim, cursor)
        if next_delim < 0:
            return
        part = body[cursor:next_delim]
        cursor = next_delim + 2 + len(delim)
        try:
            header_blob, content = part.split(b"\r\n\r\n", 1)
        except ValueError:
            continue
        headers: dict[str, str] = {}
        for header_line in header_blob.split(b"\r\n"):
            if b":" not in header_line:
                continue
            key, _, value = header_line.decode("utf-8", errors="replace").partition(":")
            headers[key.strip().lower()] = value.strip()
        yield headers, content


def _filename_from_disposition(disposition: str) -> str | None:
    if not disposition:
        return None
    match = re.search(r'filename\*=([^;]+)', disposition)
    if match:
        value = match.group(1).strip()
        if "''" in value:
            _, _, encoded = value.partition("''")
            try:
                return urllib.parse.unquote(encoded)
            except Exception:  # noqa: BLE001
                return None
    match = re.search(r'filename="((?:[^"\\]|\\.)*)"', disposition)
    if match:
        return match.group(1).replace('\\"', '"')
    match = re.search(r'filename=([^;]+)', disposition)
    if match:
        return match.group(1).strip()
    return None


def save_uploaded_files(handler: SimpleHTTPRequestHandler) -> dict:
    content_type = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        raise ValueError("Expected multipart form upload.")
    boundary_match = re.search(r'boundary=("?)([^";]+)\1', content_type)
    if not boundary_match:
        raise ValueError("Multipart boundary missing.")
    boundary = boundary_match.group(2).encode("ascii")

    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        raise ValueError("Empty upload.")
    body = handler.rfile.read(length)

    saved: list[str] = []
    skipped: list[str] = []
    for headers, content in _iter_multipart_parts(body, boundary):
        filename = _filename_from_disposition(headers.get("content-disposition", ""))
        if not filename:
            continue
        clean = Path(filename).name
        if not clean or Path(clean).suffix.lower() not in IMAGE_EXTENSIONS:
            if clean:
                skipped.append(clean)
            continue
        dest = _unique_input_path(clean)
        dest.write_bytes(content)
        saved.append(dest.name)
    if not saved:
        if skipped:
            raise ValueError(f"Unsupported file type(s): {', '.join(skipped[:3])}")
        raise ValueError("No supported image files were uploaded.")
    message = f"Added {len(saved)} image(s)."
    if skipped:
        message += f" Skipped {len(skipped)} unsupported file(s)."
    return {"message": message, "files": saved}


def remove_work_item(payload: dict) -> dict:
    name = payload.get("name", "").strip()
    if not name:
        raise ValueError("Missing image name.")
    path = resolve_work_item(name)
    if path is None:
        raise ValueError(f"Image not found: {name}")
    try:
        path.unlink()
    except OSError as exc:
        raise ValueError(f"Cannot remove {path.name}: {exc}")
    return {"message": f"Removed {path.name}."}


def _safe_stem(raw: str) -> str:
    """Reduce a caller-supplied name to a single safe filename stem (no ext)."""
    stem = Path(raw).name
    stem = re.sub(r"\.[A-Za-z0-9]{1,8}$", "", stem)  # drop a trailing extension
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.")
    return stem


def rename_work_item(payload: dict) -> dict:
    """Rename a source image in place, preserving its extension. Powers the
    raster detail view's rename action."""
    name = (payload.get("name") or "").strip()
    new_raw = (payload.get("new_name") or "").strip()
    if not name:
        raise ValueError("Missing image name.")
    if not new_raw:
        raise ValueError("Missing new name.")
    path = resolve_work_item(name)
    if path is None:
        raise ValueError(f"Image not found: {name}")
    stem = _safe_stem(new_raw)
    if not stem:
        raise ValueError("New name is empty after sanitising.")
    target = path.with_name(stem + path.suffix)
    if target == path:
        return {"name": path.name, "url": f"/work-items/{urllib.parse.quote(path.name)}", "message": "Name unchanged."}
    if target.exists():
        raise ValueError(f"A file named {target.name} already exists.")
    try:
        path.rename(target)
    except OSError as exc:
        raise ValueError(f"Cannot rename {path.name}: {exc}")
    return {
        "name": target.name,
        "url": f"/work-items/{urllib.parse.quote(target.name)}",
        "message": f"Renamed to {target.name}.",
    }


def _resolve_output(rel_or_url: str) -> Path:
    """Resolve an outputs-relative path (or a /outputs/… URL) to a real file
    that lives inside OUTPUTS_DIR. Raises ValueError on traversal or miss."""
    raw = urllib.parse.unquote((rel_or_url or "").strip())
    raw = raw.removeprefix("/outputs/").lstrip("/")
    if not raw:
        raise ValueError("Missing output path.")
    path = (OUTPUTS_DIR / Path(raw)).resolve()
    try:
        path.relative_to(OUTPUTS_DIR.resolve())
    except ValueError:
        raise ValueError("Path is outside the outputs directory.")
    if not path.is_file():
        raise ValueError(f"File not found: {path.name}")
    return path


def rename_output(payload: dict) -> dict:
    """Rename a file under outputs/ in place, preserving its extension. Powers
    the vector and project (.hv) detail views' rename action. For .hv projects
    the JSON's internal `name` field is rewritten too so re-opening is clean."""
    rel = payload.get("url") or payload.get("path") or payload.get("name") or ""
    new_raw = (payload.get("new_name") or "").strip()
    if not new_raw:
        raise ValueError("Missing new name.")
    path = _resolve_output(rel)
    stem = _safe_stem(new_raw)
    if not stem:
        raise ValueError("New name is empty after sanitising.")
    target = path.with_name(stem + path.suffix)
    if target == path:
        relname = path.relative_to(OUTPUTS_DIR.resolve()).as_posix()
        return {"name": path.name, "url": f"/outputs/{urllib.parse.quote(relname)}", "message": "Name unchanged."}
    if target.exists():
        raise ValueError(f"A file named {target.name} already exists.")
    # Keep a .hv document's embedded name in sync with its filename.
    if path.suffix.lower() == ".hv":
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            doc["name"] = target.name
            path.write_text(json.dumps(doc), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    try:
        path.rename(target)
    except OSError as exc:
        raise ValueError(f"Cannot rename {path.name}: {exc}")
    invalidate_outputs_cache()
    relname = target.relative_to(OUTPUTS_DIR.resolve()).as_posix()
    return {
        "name": target.name,
        "url": f"/outputs/{urllib.parse.quote(relname)}",
        "message": f"Renamed to {target.name}.",
    }


def remove_output(payload: dict) -> dict:
    """Delete a file under outputs/ (vector .svg/.png or project .hv). Powers the
    vector and project detail views' delete action."""
    rel = payload.get("url") or payload.get("path") or payload.get("name") or ""
    path = _resolve_output(rel)
    name = path.name
    try:
        path.unlink()
    except OSError as exc:
        raise ValueError(f"Cannot remove {name}: {exc}")
    invalidate_outputs_cache()
    return {"message": f"Removed {name}."}


_EXIF_TAG_NAMES = {v: k for k, v in ExifTags.TAGS.items()}
_EXIF_ALLOWED = {
    "Make", "Model", "Orientation", "DateTime", "DateTimeOriginal",
    "Software", "ImageWidth", "ImageLength", "ExifImageWidth", "ExifImageHeight",
    "ColorSpace", "Artist", "Copyright",
}


def work_item_info(name: str) -> dict:
    path = resolve_work_item(name)
    if path is None:
        raise ValueError(f"Image not found: {name}")
    with Image.open(path) as im:
        width, height = im.size
        mode = im.mode
        fmt = im.format or path.suffix.lstrip(".").upper()
        has_alpha = ("A" in mode) or ("transparency" in im.info)
        icc_bytes = im.info.get("icc_profile")
        icc_name = ""
        if icc_bytes:
            try:
                from PIL import ImageCms

                profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes))
                icc_name = ImageCms.getProfileDescription(profile).strip()
            except Exception:  # noqa: BLE001
                icc_name = f"{len(icc_bytes)} bytes"
        dpi = im.info.get("dpi")
        dpi_text = ""
        if dpi:
            try:
                dpi_text = f"{int(round(dpi[0]))}×{int(round(dpi[1]))}"
            except Exception:  # noqa: BLE001
                dpi_text = ""
        exif: dict[str, str] = {}
        orientation = 0
        try:
            raw_exif = im.getexif()
        except Exception:  # noqa: BLE001
            raw_exif = None
        if raw_exif:
            for tag_id, value in raw_exif.items():
                tag_name = ExifTags.TAGS.get(tag_id)
                if tag_name == "Orientation":
                    try:
                        orientation = int(value)
                    except Exception:  # noqa: BLE001
                        pass
                if tag_name and tag_name in _EXIF_ALLOWED:
                    try:
                        text = str(value)
                    except Exception:  # noqa: BLE001
                        continue
                    if len(text) > 120:
                        text = text[:117] + "..."
                    exif[tag_name] = text
    stat = path.stat()
    return {
        "name": path.name,
        "path": str(path),
        "width": width,
        "height": height,
        "mode": mode,
        "format": fmt,
        "size_bytes": stat.st_size,
        "modified_at": stat.st_mtime,
        "has_alpha": has_alpha,
        "icc_profile": icc_name,
        "dpi": dpi_text,
        "orientation": orientation,
        "exif": exif,
    }


def get_source_info() -> dict:
    current = source_dir()
    return {
        "source_dir": str(current),
        "default_dir": str(DEFAULT_SOURCE_DIR),
        "is_default": current.resolve() == DEFAULT_SOURCE_DIR.resolve(),
    }


def set_source_dir_api(payload: dict) -> dict:
    requested = (payload.get("path") or "").strip()
    if not requested:
        with _config_lock:
            cfg = _load_config()
            cfg.pop("source_dir", None)
            _save_config(cfg)
        return {"message": f"Source reset to default ({DEFAULT_SOURCE_DIR}).", **get_source_info()}
    new_path = set_source_dir(requested)
    return {"message": f"Source set to {new_path}.", **get_source_info()}


def reveal_path(payload: dict) -> dict:
    requested = (payload.get("path") or "").strip()
    if not requested:
        raise ValueError("Missing 'path'.")
    target = Path(requested).expanduser().resolve()
    allowed_roots = [OUTPUTS_DIR.resolve(), source_dir().resolve(), WORKSPACE_DIR.resolve()]
    inside = False
    for root in allowed_roots:
        try:
            target.relative_to(root)
            inside = True
            break
        except ValueError:
            continue
    if not inside:
        raise ValueError(f"Path is outside allowed workspaces: {target}")
    if not target.exists():
        raise ValueError(f"Path does not exist: {target}")
    folder = target if target.is_dir() else target.parent
    opener = shutil.which("xdg-open") or shutil.which("open") or shutil.which("explorer.exe")
    if not opener:
        raise ValueError("No file manager opener found (xdg-open / open / explorer.exe).")
    try:
        subprocess.Popen(
            [opener, str(folder)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        raise ValueError(f"Failed to launch file manager: {exc}")
    return {"message": f"Opened {folder}"}


def clear_finished_jobs() -> dict:
    with jobs_lock:
        done = [job_id for job_id, job in jobs.items() if job["status"] in TERMINAL_JOB_STATES]
        for job_id in done:
            jobs.pop(job_id, None)
            job_internals.pop(job_id, None)
    return {"message": f"Cleared {len(done)} finished job(s)."}


def shlex_quote(value: str) -> str:
    import shlex

    return shlex.quote(value)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
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
            with jobs_lock:
                data = list(reversed(list(jobs.values())))
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

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/upload":
                result = save_uploaded_files(self)
                self.send_json(result)
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
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
            elif parsed.path == "/api/bootstrap":
                result = bootstrap_tools()
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
            elif parsed.path == "/api/run/selftest":
                result = run_selftest(payload)
            elif parsed.path == "/api/run/supir":
                result = run_supir(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
                return
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
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
        if not path.exists():
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
    port = int(os.environ.get("PORT", "2002"))
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"hector-vector UI: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
