#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
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
# `.webmanifest` is not in the stdlib mime table; Chromium wants a JSON-ish type.
mimetypes.add_type("application/manifest+json", ".webmanifest")
OUTPUTS_DIR = APP_DIR / "outputs"
INPUTS_DIR = APP_DIR / "inputs"
ASSETS_DIR = APP_DIR / "assets"
SRC_DIR = APP_DIR / "src"          # ES-module tree: hv/ library + editor + app shell
WORKSPACE_DIR = APP_DIR
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
    if not VENV_PYTHON.exists():
        return False
    try:
        result = subprocess.run(
            [str(VENV_PYTHON), "-c", "import rembg"],
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


def output_dir(label: str) -> Path:
    stamp = time.strftime('%Y%m%d-%H%M%S')
    base = OUTPUTS_DIR / f"{label}-{stamp}-{int(time.time() * 1000) % 1000:03d}"
    out = base
    suffix = 1
    while out.exists():
        out = OUTPUTS_DIR / f"{base.name}-{suffix}"
        suffix += 1
    out.mkdir(parents=True, exist_ok=False)
    return out


def build_trace_mask(input_path: Path, output_path: Path) -> None:
    build_monochrome_assets(input_path, mask_output=output_path)


def build_cutout(input_path: Path, output_path: Path) -> None:
    build_alpha_cutout(input_path, output_path)


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
        raise ValueError(f"Blank cutout: {path.name}")
    opaque = sum(1 for value in alpha.getdata() if value >= 8)
    if opaque < max(32, rgba.width * rgba.height // 4000):
        raise ValueError(f"Cutout too sparse: {path.name}")


def validate_mask_png(path: Path) -> None:
    mask = Image.open(path).convert("L")
    black = sum(1 for value in mask.getdata() if value < 128)
    if black < max(32, mask.width * mask.height // 4000):
        raise ValueError(f"Mask too sparse: {path.name}")


def validate_svg_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="ignore")
    if "<svg" not in text or "<path" not in text:
        raise ValueError(f"SVG missing paths: {path.name}")
    if len(text) < 256:
        raise ValueError(f"SVG too small: {path.name}")


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
    return {
        "mode": mode,
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


def work_item_record(path: Path) -> dict:
    return {
        "name": path.name,
        "url": f"/work-items/{urllib.parse.quote(path.name)}",
        "path": str(path),
        "origin": "source",
        "removable": True,
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
        (folder for folder in OUTPUTS_DIR.glob("*") if folder.is_dir()),
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
            items.append(
                {
                    "name": path.name,
                    "folder": folder.name,
                    "url": f"/outputs/{urllib.parse.quote(folder.name)}/{urllib.parse.quote(path.name)}",
                    "kind": path.suffix.lower().lstrip("."),
                    "path": str(path),
                }
            )
    with _outputs_cache_lock:
        _outputs_cache["sig"] = sig
        _outputs_cache["items"] = items
    return items[:limit]


def invalidate_outputs_cache() -> None:
    with _outputs_cache_lock:
        _outputs_cache["sig"] = None


def expected_outputs_for(kind: str, stem: str) -> list[str]:
    if kind == "upscale":
        return [f"{stem}.png"]
    if kind == "cutout":
        return [f"{stem}.cutout.png"]
    if kind == "chromakey":
        return [f"{stem}.chromakey.png"]
    if kind == "vectorize":
        return [f"{stem}.svg"]
    if kind == "pipeline":
        return [f"{stem}.svg"]
    if kind == "pixelvec":
        return [f"{stem}.svg"]
    return []


def is_processed_for(kind: str, stem: str) -> bool:
    expected = expected_outputs_for(kind, stem)
    if not expected:
        return False
    for folder in OUTPUTS_DIR.glob(f"{kind}-*"):
        if not folder.is_dir():
            continue
        for name in expected:
            if (folder / name).exists():
                return True
    return False


def select_inputs(payload: dict, kind: str | None = None) -> tuple[list[Path], list[str]]:
    """Returns (input_paths, skipped_names). Explicit selections and explicit input_path bypass skip-detection."""
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
    if kind and not payload.get("force"):
        kept: list[Path] = []
        skipped: list[str] = []
        for f in files:
            if is_processed_for(kind, f.stem):
                skipped.append(f.name)
            else:
                kept.append(f)
        return kept, skipped
    return files, []


def resolve_inputs(payload: dict, kind: str | None = None) -> list[Path]:
    return select_inputs(payload, kind)[0]


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


def ensure_tools_ready(*required: str) -> None:
    status = tool_status()
    missing = set(status["missing_tools"])
    needed_missing = [name for name in required if name in missing]
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


def run_upscale(payload: dict) -> dict:
    ensure_tools_ready("realesrgan")
    model = payload.get("model", "realesrgan-x4plus")
    scale = str(payload.get("scale", "4"))
    targets, skipped = select_inputs(payload, "upscale")
    if not targets:
        return {"message": _skip_message("upscale", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("upscale")
    jobs_started = []
    for src in targets:
        dest = out_dir / f"{src.stem}.png"
        cmd = [
            str(REALESRGAN_BIN),
            "-i",
            str(src),
            "-o",
            str(dest),
            "-n",
            model,
            "-s",
            scale,
        ]
        jobs_started.append(
            launch_job(
                "upscale",
                cmd,
                cwd=REALESRGAN_DIR,
                summary=f"Upscale {src.name}",
                source_name=src.name,
                output_dir=str(out_dir),
                expected_outputs=[dest],
            )
        )
    msg = f"Started {len(jobs_started)} upscale job(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started), "skipped": skipped}


AI_CUTOUT_MODELS = {
    "u2net", "u2netp", "u2net_human_seg",
    "isnet-general-use", "isnet-anime",
    "birefnet-general", "birefnet-general-lite",
    "birefnet-portrait", "birefnet-massive",
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


def run_cutout(payload: dict) -> dict:
    backend = (payload.get("backend") or "classical").strip()
    targets, skipped = select_inputs(payload, "cutout")
    if not targets:
        return {"message": _skip_message("cutout", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("cutout")

    if backend == "ai":
        if not rembg_installed():
            raise ValueError("rembg is not installed. Click 'Install rembg' in Settings (one-time, ~500MB).")
        model = (payload.get("cutout_model") or "u2net").strip()
        alpha_matting = bool(payload.get("alpha_matting"))
        jobs_started = []
        total = len(targets)
        for i, src in enumerate(targets, 1):
            dest = out_dir / f"{src.stem}.cutout.png"
            def worker(log, src=src, dest=dest, i=i) -> None:
                _report_progress(i, total, f"cutout {src.name}")
                build_ai_cutout(src, dest, model, alpha_matting, log)
                validate_cutout_png(dest)
                _register_output(dest)
            jobs_started.append(
                launch_internal_job(
                    "cutout", f"AI cutout ({model}) {src.name}", worker,
                    source_name=src.name, output_dir=str(out_dir),
                )
            )
        msg = f"Queued {len(jobs_started)} AI cutout job(s) using {model}."
        if skipped:
            msg += f" Skipped {len(skipped)} already processed."
        return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started), "skipped": skipped}

    # classical (synchronous, fast)
    results = []
    for src in targets:
        dest = out_dir / f"{src.stem}.cutout.png"
        build_cutout(src, dest)
        validate_cutout_png(dest)
        results.append(dest)
    msg = f"Created {len(results)} cutout PNG(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(results), "skipped": skipped}


def run_chromakey(payload: dict) -> dict:
    targets, skipped = select_inputs(payload, "chromakey")
    if not targets:
        return {"message": _skip_message("chromakey", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("chromakey")
    results = []
    for src in targets:
        dest = out_dir / f"{src.stem}.chromakey.png"
        build_chromakey_cutout(src, dest)
        results.append(dest)
    msg = f"Created {len(results)} color-key PNG(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(results), "skipped": skipped}


def run_vectorize(payload: dict) -> dict:
    ensure_tools_ready("vtracer")
    targets, skipped = select_inputs(payload, "vectorize")
    if not targets:
        return {"message": _skip_message("vectorize", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("vectorize")
    jobs_started = []
    trace = trace_config(payload)
    mask_cfg = mask_config(payload)
    for src in targets:
        mask_path = out_dir / f"{src.stem}.mask.png"
        dest = out_dir / f"{src.stem}.svg"
        def worker(log, src=src, mask_path=mask_path, dest=dest) -> None:
            _report_progress(1, 3, "Preprocess")
            staged = src
            if mask_cfg["target_max_dim"] is not None:
                staged_preview = out_dir / f"{src.stem}.preview.png"
                staged = apply_preprocess(src, staged_preview, target_max_dim=mask_cfg["target_max_dim"])
                if staged is not src:
                    log(f"Resized to max dim {mask_cfg['target_max_dim']}.")
                    _register_output(staged_preview)
            _report_progress(2, 3, "Build mask")
            build_mask_with_overrides(staged, mask_path, None, mask_cfg)
            validate_mask_png(mask_path)
            _register_output(mask_path)
            _report_progress(3, 3, "Trace SVG")
            trace_mask_to_svg(mask_path, dest, trace, log)
            validate_svg_file(dest)
            _register_output(dest)

        jobs_started.append(
            launch_internal_job(
                "vectorize", f"Vectorize {src.name}", worker,
                source_name=src.name, output_dir=str(out_dir),
            )
        )
    msg = f"Started {len(jobs_started)} vector job(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started), "skipped": skipped}


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
    if len(text) < 80:
        raise ValueError(f"Pixel SVG too small: {path.name}")


def run_pixelvec(payload: dict) -> dict:
    targets, skipped = select_inputs(payload, "pixelvec")
    if not targets:
        return {"message": _skip_message("pixel-trace", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("pixelvec")
    cfg = pixelvec_config(payload)
    results = []
    grids = []
    for src in targets:
        dest = out_dir / f"{src.stem}.svg"
        info = pixelvec.vectorize_pixel_art(
            src, dest,
            mode=cfg["mode"], sample=cfg["sample"],
            gridx=cfg["gridx"], gridy=cfg["gridy"],
            quantize=cfg["quantize"], key_corner=cfg["key_corner"],
        )
        validate_pixelvec_svg(dest)
        _register_output(dest)
        results.append(dest)
        grids.append(f"{info['grid'][0]}×{info['grid'][1]}")
    sample_grid = grids[0] if len(set(grids)) == 1 else "varied"
    msg = f"Traced {len(results)} pixel SVG(s) at {sample_grid} native grid ({cfg['mode']})."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(results), "skipped": skipped}


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


def render_output(payload: dict) -> dict:
    svg = _resolve_output_svg(payload)

    def num(key):
        v = payload.get(key)
        if v in (None, "", 0, "0"):
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    scale = num("scale")
    width = num("width")
    height = num("height")
    if scale is None and width is None and height is None:
        scale = 1.0
    background = (payload.get("background") or "transparent").strip()
    if background not in ("transparent", "white", "black"):
        background = "transparent"

    # render to a provisional name, then rename to encode the size so repeated
    # exports at different sizes don't clobber each other
    provisional = svg.with_name(f"{svg.stem}.__render__.png")
    try:
        peek = svg_render.render_svg(
            svg, provisional, scale=scale, width=int(width) if width else None,
            height=int(height) if height else None, background=background,
        )
    except (RuntimeError, ValueError) as exc:
        raise ValueError(str(exc))
    info_size = peek["size"]
    final = svg.with_name(f"{svg.stem}@{info_size[0]}x{info_size[1]}.png")
    if final.exists():
        final.unlink()
    provisional.replace(final)
    _register_output(final)
    return {
        "message": f"Rendered {svg.stem} at {info_size[0]}×{info_size[1]} ({peek['backend']}).",
        "output_dir": str(svg.parent),
        "output": str(final),
        "folder": svg.parent.name,
        "name": final.name,
        "native": peek["native"],
        "size": info_size,
        "backend": peek["backend"],
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
    if len(svg_text) > 16_000_000:
        raise ValueError("SVG is too large to save (>16 MB).")
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


def derive_mask_from_alpha(cutout_path: Path, mask_path: Path, threshold: int = 128) -> None:
    rgba = Image.open(cutout_path).convert("RGBA")
    alpha = rgba.getchannel("A")
    binary = alpha.point(lambda v, t=threshold: 0 if v >= t else 255)
    binary.convert("L").save(mask_path)


def run_pipeline(payload: dict) -> dict:
    ensure_tools_ready("vtracer")
    model = payload.get("model", "realesrgan-x4plus")
    scale = int(payload.get("scale", "4"))
    cutout_backend = (payload.get("cutout_backend") or "classical").strip()
    cutout_model = (payload.get("cutout_model") or "u2net").strip()
    alpha_matting = bool(payload.get("alpha_matting"))
    if cutout_backend == "ai" and not rembg_installed():
        raise ValueError("AI cutout requested but rembg is not installed. Install it from Settings, or set cutout backend to classical.")
    trace = trace_config(payload)
    mask_cfg = mask_config(payload)
    targets, skipped = select_inputs(payload, "pipeline")
    if not targets:
        return {"message": _skip_message("run pipeline on", skipped), "started": 0, "skipped": skipped}
    out_dir = output_dir("pipeline")
    jobs_started = []
    for src in targets:
        upscale_dest = out_dir / f"{src.stem}.png"
        mask_dest = out_dir / f"{src.stem}.mask.png"
        cutout_dest = out_dir / f"{src.stem}.cutout.png"
        vector_dest = out_dir / f"{src.stem}.svg"
        def worker(log, src=src, upscale_dest=upscale_dest, mask_dest=mask_dest, cutout_dest=cutout_dest, vector_dest=vector_dest) -> None:
            _report_progress(1, 5, "Upscale")
            if source_has_alpha(src):
                log(f"Alpha-aware source detected for {src.name}; using deterministic upscale.")
                deterministic_upscale(src, upscale_dest, scale)
            else:
                ensure_tools_ready("realesrgan", "vtracer")
                lines = run_subprocess(
                    [
                        str(REALESRGAN_BIN),
                        "-i",
                        str(src),
                        "-o",
                        str(upscale_dest),
                        "-n",
                        model,
                        "-s",
                        str(scale),
                    ],
                    cwd=REALESRGAN_DIR,
                )
                log_subprocess_lines(log, lines)
            _register_output(upscale_dest)
            _report_progress(2, 5, "Preprocess")
            staged = upscale_dest
            if mask_cfg["target_max_dim"] is not None:
                preview_path = out_dir / f"{src.stem}.preview.png"
                staged = apply_preprocess(upscale_dest, preview_path, target_max_dim=mask_cfg["target_max_dim"])
                if staged is not upscale_dest:
                    log(f"Resized intermediate to max dim {mask_cfg['target_max_dim']}.")
                    _register_output(preview_path)
            _report_progress(3, 5, "Build mask + cutout")
            if cutout_backend == "ai":
                log(f"AI cutout via rembg ({cutout_model}).")
                build_ai_cutout(staged, cutout_dest, cutout_model, alpha_matting, log)
                validate_cutout_png(cutout_dest)
                derive_mask_from_alpha(cutout_dest, mask_dest)
                validate_mask_png(mask_dest)
            else:
                build_mask_with_overrides(staged, mask_dest, cutout_dest, mask_cfg)
                validate_mask_png(mask_dest)
                validate_cutout_png(cutout_dest)
            _register_output(mask_dest)
            _register_output(cutout_dest)
            _report_progress(4, 5, "Trace SVG")
            trace_mask_to_svg(mask_dest, vector_dest, trace, log)
            validate_svg_file(vector_dest)
            _register_output(vector_dest)
            _report_progress(5, 5, "Done")

        jobs_started.append(
            launch_internal_job(
                "pipeline", f"Production SVG {src.name}", worker,
                source_name=src.name, output_dir=str(out_dir),
            )
        )
    msg = f"Started {len(jobs_started)} pipeline job(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started), "skipped": skipped}


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


_TRANSFORM_OPS = {
    "rotate90", "rotate180", "rotate270",
    "flip-h", "flip-v",
    "auto-orient", "strip-metadata",
}


def transform_work_item(payload: dict) -> dict:
    name = (payload.get("name") or "").strip()
    op = (payload.get("op") or "").strip()
    path = resolve_work_item(name)
    if path is None:
        raise ValueError(f"Image not found: {name}")
    if op not in _TRANSFORM_OPS:
        raise ValueError(f"Unsupported transform: {op}")
    fmt_lower = path.suffix.lower()
    with Image.open(path) as im:
        im.load()
        preserve_icc = im.info.get("icc_profile")
        if op == "rotate90":
            new_im = im.transpose(Image.Transpose.ROTATE_270)  # CW 90
        elif op == "rotate180":
            new_im = im.transpose(Image.Transpose.ROTATE_180)
        elif op == "rotate270":
            new_im = im.transpose(Image.Transpose.ROTATE_90)  # CCW 90
        elif op == "flip-h":
            new_im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        elif op == "flip-v":
            new_im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        elif op == "auto-orient":
            try:
                orient = (im.getexif() or {}).get(0x0112, 1)
            except Exception:  # noqa: BLE001
                orient = 1
            if orient in (0, 1):
                return {"message": f"No EXIF orientation on {path.name}.", **work_item_info(path.name)}
            new_im = ImageOps.exif_transpose(im)
        else:  # strip-metadata
            new_im = Image.new(im.mode, im.size)
            new_im.paste(im)
            preserve_icc = None
        save_kwargs = {}
        if fmt_lower in {".jpg", ".jpeg"}:
            save_kwargs.update({"quality": 95, "subsampling": 0, "progressive": True})
        if op != "strip-metadata" and preserve_icc:
            save_kwargs["icc_profile"] = preserve_icc
        new_im.save(path, **save_kwargs)
    return {"message": f"Applied {op} to {path.name}.", **work_item_info(path.name)}


def clean_derivative_inputs() -> dict:
    removed = 0
    base = source_dir()
    if base.is_dir():
        for path in list(base.iterdir()):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS and is_derivative_name(path.name):
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
    return {"message": f"Removed {removed} derivative file(s)."}


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
        if parsed.path.startswith("/work-items/"):
            path = resolve_work_item(parsed.path.removeprefix("/work-items/"))
            if path is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
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
            elif parsed.path == "/api/work-items/remove":
                result = remove_work_item(payload)
            elif parsed.path == "/api/work-items/clean-derivatives":
                result = clean_derivative_inputs()
            elif parsed.path == "/api/work-items/transform":
                result = transform_work_item(payload)
            elif parsed.path == "/api/render":
                result = render_output(payload)
            elif parsed.path == "/api/save-svg":
                result = save_svg(payload)
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
            elif parsed.path == "/api/run/upscale":
                result = run_upscale(payload)
            elif parsed.path == "/api/run/cutout":
                result = run_cutout(payload)
            elif parsed.path == "/api/run/chromakey":
                result = run_chromakey(payload)
            elif parsed.path == "/api/run/vectorize":
                result = run_vectorize(payload)
            elif parsed.path == "/api/run/pixelvec":
                result = run_pixelvec(payload)
            elif parsed.path == "/api/run/pipeline":
                result = run_pipeline(payload)
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
