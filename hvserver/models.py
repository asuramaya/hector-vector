"""Models layer (#29 split): tool/weight installation + the AI raster compute ops.
Tool installers (realesrgan/vtracer/rembg/spandrel/opencv) + bootstrap, the
tool-readiness gate, atomic weight fetching (fetch_model), the per-capability model
registries (AI_CUTOUT_MODELS / SR_MODELS / RESTORE_STAGE_MODELS), the build_* executors
(ai-cutout/upscale/lama/face), and the transient *_op endpoints (cleanup/face/restore).

Sits above jobs (it launches install jobs + runs subprocesses) and files (the *_op
endpoints resolve source URLs); engines/pipeline/http call build_* / the registries /
ensure_tools_ready from here. Re-exported behind the server façade.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

from hvserver.paths import (
    REALESRGAN_BIN, REALESRGAN_DIR, REALESRGAN_RELEASE, VTRACER_BIN,
    TOOLS_DIR, VENV_DIR, VENV_PYTHON, SCRATCH_DIR, OUTPUTS_DIR,
    AI_CUTOUT_SCRIPT, UPSCALE_SPANDREL_SCRIPT, LAMA_SCRIPT,
    FACE_RESTORE_SCRIPT, DETECT_FACES_SCRIPT,
    SR_MODELS_DIR, INPAINT_DIR, FACE_DIR,
    LAMA_MODEL, GFPGAN_MODEL, YUNET_MODEL,
    ensure_dirs, command_exists, shlex_quote,
    rembg_installed, spandrel_installed, _venv_has,
)
from hvserver.jobs import has_running_job, launch_job, run_subprocess, log_subprocess_lines
from hvserver.files import resolve_source_url


# ---- tool installers -------------------------------------------------------
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


# ---- AI cutout (rembg / BEN2) ----------------------------------------------
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


# ---- upscale + restoration (spandrel zoo) ----------------------------------
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
        "url": "https://huggingface.co/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth"},
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


# ---- inpaint cleanup (LaMa) ------------------------------------------------
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


# ---- face restore (GFPGAN + YuNet) -----------------------------------------
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
