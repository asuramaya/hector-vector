"""Files layer (#29 split): the on-disk workspace — source images ("work items"),
the outputs/ library, uploads, and rename/remove/info. Jobs-INDEPENDENT: nothing here
touches job state, so it sits below jobs in the import graph. Depends only on
hvserver.paths. server.py re-exports everything here behind its façade.

run_pipeline / the job GC / the HTTP handler (all still in server.py) call into this
module one-directionally — they import these names via `from hvserver.files import *`.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import mimetypes
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler
from pathlib import Path

from PIL import Image, ExifTags

from hvserver.paths import (
    APP_DIR, OUTPUTS_DIR, SCRATCH_DIR, WORKSPACE_DIR, DEFAULT_SOURCE_DIR,
    IMAGE_EXTENSIONS, source_dir, set_source_dir, is_derivative_name,
    _load_config, _save_config, _config_lock,
)


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
    """Cap the materialized `inline-*` data-URI scratch files AND the `pp-*` preprocess
    cache files so they don't accumulate across reopen-and-reprocess cycles. Keep the
    most-recently-modified `keep` of each; the file just written is always kept (exclude)."""
    for pattern in ("inline-*", "pp-*"):
        try:
            files = sorted(SCRATCH_DIR.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
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
    if any(st.get(sid) for sid in ("dejpeg", "denoise", "deblur")):
        return f"{stem}.png"   # restoration-only run → the fixed PNG
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


MAX_BODY_BYTES = 512 * 1024 * 1024   # 512MB ceiling on a single request body


class PayloadTooLarge(Exception):
    """Request body exceeds MAX_BODY_BYTES → answered with 413, not a 400/OOM."""


def _read_body(handler: SimpleHTTPRequestHandler, length: int) -> bytes:
    """Read exactly `length` bytes, looping until satisfied — a single rfile.read()
    can return a short chunk on a slow socket, silently truncating a large upload.
    Caps the total so an oversized body can't OOM the process."""
    if length < 0:
        raise ValueError("Bad Content-Length.")
    if length > MAX_BODY_BYTES:
        raise PayloadTooLarge(f"Request body too large ({length} bytes; max {MAX_BODY_BYTES}).")
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = handler.rfile.read(min(remaining, 1 << 20))
        if not chunk:
            break   # client closed early; return what we have (parsers will reject it)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


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
    body = _read_body(handler, length)

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


def _safe_stem(raw: str) -> str:  # noqa: F811  (intentionally overrides the lenient str|None variant above)
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
        proc = subprocess.Popen(
            [opener, str(folder)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        raise ValueError(f"Failed to launch file manager: {exc}")
    # xdg-open launches the file manager and exits promptly; reap it off-thread so each
    # Reveal click doesn't leave a zombie until the next subprocess call cleans it up.
    threading.Thread(target=proc.wait, daemon=True).start()
    return {"message": f"Opened {folder}"}
