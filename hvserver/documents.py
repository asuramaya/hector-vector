"""Documents layer (#29 split): document persistence endpoints — save a browser-rendered
PNG export next to its source SVG (save_render), write an edited SVG (save_svg), save/list
full editor projects as .hv JSON (save_hv / list_projects), and the Save-As path for new
canvases (save_svg_as). All confined to the OUTPUTS_DIR tree. Pure down-deps: paths +
files.invalidate_outputs_cache + jobs._register_output. Re-exported behind the server facade.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import urllib.parse
from pathlib import Path

from hvserver.paths import OUTPUTS_DIR, MAX_SVG_SAVE_BYTES
from hvserver.files import invalidate_outputs_cache
from hvserver.jobs import _register_output


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
