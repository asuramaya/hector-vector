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

# Models layer (hvserver/models.py, #29 split): tool/weight installers + bootstrap, the
# tool-readiness gate, atomic fetch_model, the per-capability model registries
# (AI_CUTOUT_MODELS / SR_MODELS / RESTORE_STAGE_MODELS), the build_* executors, and the
# transient cleanup/face/restore op endpoints. Engines + the pipeline call build_* /
# ensure_tools_ready / the registries from here. Re-exported so server.build_ai_cutout /
# SR_MODELS / cleanup_inpaint / etc. keep resolving (incl. _skip_message used by the pipeline).
from hvserver.models import *  # noqa: F401,F403,E402
from hvserver.models import _skip_message  # noqa: E402  (underscore; called from run_pipeline)

# Engines layer (hvserver/engines.py, #29 split): the vectorize / trace / raster-op core —
# trace+mask config, preprocessing, the vtracer bw/colour paths, the planar clean-colour
# tracer, pixelvec, raster ops, and the VECTORIZE_ENGINES / RASTER_OPS registries with their
# single dispatch entry points (vectorize_svg / apply_raster_op). The pipeline + HTTP handler
# call these from here. Re-exported so server.vectorize_svg / VECTORIZE_ENGINES / etc. resolve.
from hvserver.engines import *  # noqa: F401,F403,E402
from hvserver.engines import _trace_ceiling  # noqa: E402  (underscore; asserted by test_smoke)




# (#29 ensure_dirs relocated -> hvserver/paths.py)


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




# (#29 command_exists relocated -> hvserver/paths.py)


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


# (#29 engines layer -> hvserver/engines.py: validators + trace/mask config + preprocess + vtracer bw/colour paths)


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


# (#29 models layer -> hvserver/models.py: tool-readiness + fetch_model + registries + build_* + AI-op endpoints)


# (#29 engines layer -> hvserver/engines.py: pixelvec_config + validate_pixelvec_svg)
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


# (#29 engines layer -> hvserver/engines.py: derive_mask_from_alpha)
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


# (#29 engines layer -> hvserver/engines.py: clean_color_trace + raster ops + VECTORIZE_ENGINES dispatch)
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




# (#29 shlex_quote relocated -> hvserver/paths.py)


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
