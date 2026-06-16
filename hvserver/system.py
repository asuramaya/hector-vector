"""System layer (#29 split): non-compute server endpoints — workspace seeding
(seed_inputs), the tool/capability status report (tool_status), and the git-pull
self-update surface (version_info / check_update / apply_update). Pure down-deps:
paths + files.discover_work_items + jobs (has_running_job/launch_job) + svg_render.
Re-exported behind the server facade.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import svg_render   # noqa: E402  (cairosvg-availability probe for tool_status)

from hvserver.paths import (
    APP_DIR, DEFAULT_SOURCE_DIR, INPUTS_DIR, OUTPUTS_DIR, WORKSPACE_DIR,
    VENV_DIR, VENV_PYTHON, REALESRGAN_BIN, VTRACER_BIN, APP_VERSION, GITHUB_REPO,
    IMAGE_EXTENSIONS, source_dir, is_derivative_name, command_exists, shlex_quote,
    rembg_installed, spandrel_installed,
)
from hvserver.files import discover_work_items
from hvserver.jobs import has_running_job, launch_job


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
