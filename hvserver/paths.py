"""Foundational layer — paths, constants, on-disk config, and tool/model presence
probes (#29 split from server.py). Zero dependencies on the rest of the server:
everything else imports THIS. server.py re-exports it with `from hvserver.paths
import *`, so `server.OUTPUTS_DIR` / `server.source_dir()` etc. keep working."""
from __future__ import annotations

import json
import mimetypes
import subprocess
import sys
import threading
from pathlib import Path

# This module lives in hvserver/, so the app root is two parents up (not one).
APP_DIR = Path(__file__).resolve().parent.parent
TOOLS_DIR = APP_DIR / "tools"
sys.path.insert(0, str(TOOLS_DIR))   # so server.py + tools can `import pixelvec` etc.
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
VENV_DIR = APP_DIR / ".venv"
VENV_PYTHON = VENV_DIR / "bin" / "python3"
AI_CUTOUT_SCRIPT = TOOLS_DIR / "ai_cutout.py"
UPSCALE_SPANDREL_SCRIPT = TOOLS_DIR / "upscale_spandrel.py"
LAMA_SCRIPT = TOOLS_DIR / "inpaint_lama.py"
FACE_RESTORE_SCRIPT = TOOLS_DIR / "face_restore.py"
DETECT_FACES_SCRIPT = TOOLS_DIR / "detect_faces.py"
# Downloaded-on-demand model weights; kept in a user cache, not the repo tree.
SR_MODELS_DIR = Path.home() / ".cache" / "hector-vector" / "sr"
INPAINT_DIR = Path.home() / ".cache" / "hector-vector" / "inpaint"
FACE_DIR = Path.home() / ".cache" / "hector-vector" / "face"
LAMA_MODEL = {
    "file": "lama_fp32.onnx", "size_mb": 208,
    "url": "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx"}
GFPGAN_MODEL = {
    "file": "GFPGANv1.4.onnx", "size_mb": 340,
    "url": "https://huggingface.co/Neus/GFPGANv1.4/resolve/main/GFPGANv1.4.onnx"}
YUNET_MODEL = {
    "file": "yunet.onnx", "size_mb": 1,
    "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"}


def _venv_has(module: str) -> bool:
    """Cheap presence probe for a venv package via find_spec (no heavy import)."""
    if not VENV_PYTHON.exists():
        return False
    try:
        result = subprocess.run(
            [str(VENV_PYTHON), "-c",
             f"import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('{module}') else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def spandrel_installed() -> bool:
    """spandrel + torch present in the venv (the universal SR loader, #54)."""
    return _venv_has("spandrel")


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
