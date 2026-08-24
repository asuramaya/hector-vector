"""MCP server for hector-vector (Phase 1: drawing-engine parity — see docs/mcp-server.md).

Attaches to an already-running hector-vector tab over the Chrome DevTools Protocol; it
never launches or owns its own browser process. Every tool below is a thin, hand-named
wrapper around a call already exercised by a human's click — `window.editor` for the
command layer, `window.hv` for the pure geometry/shape-generation library underneath it.
That's deliberate: the tool NAMES here are a stable contract this file owns and versions;
the `editor.*`/`hv.*` calls behind them are an internal implementation detail the rest of
the app is free to refactor.

Optional dependency: `playwright` (`pip install playwright && playwright install
chromium` — the browser download is unnecessary here since we only ever ATTACH, but the
Python package alone is enough for `connect_over_cdp`). Not in the base requirements —
same "installed on demand" treatment as cairosvg/uharfbuzz elsewhere in this app; the rest
of hector-vector runs fine without it.

Run: `python -m hvserver.mcp_server` (stdio transport — an MCP client launches this as a
subprocess and talks to it over stdin/stdout, the standard MCP shape).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import json as _json

from hvserver.paths import AGENT_PORT_FILE, OUTPUTS_DIR
from hvserver.files import discover_work_items, work_item_record, work_item_info, list_outputs
from hvserver.documents import list_projects, save_hv

try:
    from mcp.server.mcpserver import MCPServer
except ImportError as e:  # pragma: no cover - exercised via the top-of-file docstring
    raise ImportError(
        "hvserver.mcp_server needs the optional `mcp` package: pip install mcp"
    ) from e

try:
    from playwright.async_api import Page, async_playwright
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "hvserver.mcp_server needs the optional `playwright` package: pip install playwright"
    ) from e

mcp = MCPServer("hector-vector", version="0.1.0")

# One attached page, lazily connected and reused across tool calls within a session —
# reconnecting per call would both be slow and defeat the point of "the agent and the
# human are looking at the same live canvas" (a fresh connect_over_cdp call is cheap, but
# re-resolving WHICH page is the right one on every single tool call is wasted work and a
# race if the human has multiple tabs open).
_state: dict[str, Any] = {"playwright": None, "browser": None, "page": None}


def _cdp_port() -> int:
    """Resolve the CDP debug port to attach to, in priority order:
    1. HV_MCP_PORT env var — explicit override, e.g. for manual testing against a
       Chromium launched by hand with --remote-debugging-port=<N>.
    2. AGENT_PORT_FILE (~/.cache/hector-vector/agent-port) — written by the app-window's
       "Allow agent access" toggle (Halcyon's half of docs/mcp-server.md) once that
       exists. Absence means the toggle is off, not an error — surfaced as a clear
       RuntimeError below, not a silent wrong-port guess.
    """
    env = os.environ.get("HV_MCP_PORT")
    if env:
        try:
            return int(env)
        except ValueError:
            raise RuntimeError(f"HV_MCP_PORT={env!r} is not a valid port number.")
    if AGENT_PORT_FILE.exists():
        raw = AGENT_PORT_FILE.read_text(encoding="utf-8").strip()
        try:
            return int(raw)
        except ValueError:
            raise RuntimeError(
                f"{AGENT_PORT_FILE} exists but doesn't contain a valid port ({raw!r})."
            )
    raise RuntimeError(
        "No hector-vector instance is offering agent access. Turn on "
        "Settings → \"Allow agent access\" in the app, or set HV_MCP_PORT to a "
        "Chromium debug port for manual testing."
    )


async def _get_page() -> Page:
    """The attached hector-vector page, connecting (or reconnecting, if the prior
    attachment died) on demand. Never launches a browser — CONNECTS to one that must
    already be running; see the module docstring for why."""
    page = _state.get("page")
    if page is not None and not page.is_closed():
        return page
    port = _cdp_port()
    pw = _state.get("playwright")
    if pw is None:
        pw = await async_playwright().start()
        _state["playwright"] = pw
    browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
    _state["browser"] = browser
    for ctx in browser.contexts:
        for candidate in ctx.pages:
            try:
                is_hv = await candidate.evaluate("() => !!(window.editor && window.hv)")
            except Exception:
                continue  # a page mid-navigation, a devtools/extension page, etc.
            if is_hv:
                _state["page"] = candidate
                return candidate
    raise RuntimeError(
        f"Connected to the browser on port {port}, but no open tab is running "
        "hector-vector. Open the app (or the app-window) first."
    )


async def _eval(js: str, arg: Any = None) -> Any:
    """Run one `(arg) => ...` expression against the attached page's real `editor`/`hv`
    globals and return its JSON-serializable result. The single choke point every tool
    below goes through — mutations happen through the SAME editor.* calls a human's click
    triggers, never through raw DOM surgery, so agent and human stay on one code path."""
    page = await _get_page()
    return await page.evaluate(js, arg)


# ---------------------------------------------------------------------------
# Document / selection — state introspection. First-class, not a debugging afterthought:
# an agent reasoning about what to do next needs to SEE state as much as mutate it.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_get_document() -> dict:
    """The current document: its artboard viewBox and every top-level artwork node
    (id, tag, fill, stroke) in z-order back-to-front — a `text` node also carries its
    plain-text `content` (via the same read used to reopen it for editing). Use this to see
    what's already on the canvas before adding to or editing it."""
    return await _eval(
        """() => {
            const vb = editor.stage.viewBox.baseVal;
            const nodes = [...editor.stage.querySelectorAll(':scope > [data-hv-id]')]
                .map(n => {
                    const tag = n.tagName.toLowerCase();
                    const o = {
                        id: n.getAttribute('data-hv-id'), tag,
                        fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke'),
                    };
                    if (tag === 'text') o.content = editor._readTextContent(n);
                    return o;
                });
            return { viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height }, nodes };
        }"""
    )


@mcp.tool()
async def hv_get_selection() -> dict:
    """The currently selected node ids and each one's bounding box (x0/y0/x1/y1, in
    document user-units). Empty list if nothing's selected."""
    return await _eval(
        """() => ({
            ids: [...editor.selection],
            boxes: editor.selectedNodes().map(n => editor._nodeBBoxUser(n)),
        })"""
    )


@mcp.tool()
async def hv_select(ids: list[str]) -> dict:
    """Select the given node ids (replaces the current selection; pass an empty list to
    clear it). Most tools below act on the CURRENT selection, so this is how you point
    them at something you already created or found via hv_get_document."""
    return await _eval(
        """(ids) => {
            editor.selection = new Set(ids); editor.artboardSelected = false;
            editor._renderSelection(); editor._renderInspector();
            return { ids: [...editor.selection] };
        }""",
        ids,
    )


# ---------------------------------------------------------------------------
# Shapes — the base primitives every other tool composes.
# ---------------------------------------------------------------------------

_SHAPE_KINDS = {"rect", "ellipse", "poly", "star"}


@mcp.tool()
async def hv_create_shape(
    kind: str, x: float, y: float, w: float, h: float,
    fill: str = "#000000", params: dict | None = None,
) -> str:
    """Create a live parametric shape (rect/ellipse/poly/star) at bounding box (x,y,w,h)
    and return its new id. `params` holds kind-specific fields: rect takes `r` (corner
    radius, one number or 4 for per-corner); poly/star take `sides`/`points`, `rot`
    (degrees), `corner` (rounding); star also takes `inset` (0..1, inner-radius ratio).
    Same shapes a human draws with the Rectangle/Ellipse tool — resize/recolor them
    afterward with hv_set_shape_param / hv_apply_fill, don't recreate to tweak."""
    if kind not in _SHAPE_KINDS:
        raise ValueError(f"kind must be one of {sorted(_SHAPE_KINDS)}, got {kind!r}")
    return await _eval(
        """(a) => {
            editor.push('Create shape');
            const n = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const id = 'n' + (++editor.idSeq);
            n.setAttribute('data-hv-id', id);
            n.setAttribute('data-hv-shape', a.kind);
            n.setAttribute('data-hv-bx', a.x); n.setAttribute('data-hv-by', a.y);
            n.setAttribute('data-hv-bw', a.w); n.setAttribute('data-hv-bh', a.h);
            for (const [k, v] of Object.entries(a.params || {})) n.setAttribute('data-hv-' + k, v);
            hv.regenShape(n);
            n.setAttribute('fill', a.fill);
            editor.stage.insertBefore(n, editor._overlayEl());
            editor.selection = new Set([id]); editor.artboardSelected = false;
            editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
            return id;
        }""",
        {"kind": kind, "x": x, "y": y, "w": w, "h": h, "fill": fill, "params": params or {}},
    )


@mcp.tool()
async def hv_set_shape_param(id: str, key: str, value: Any) -> dict:
    """Set one parametric field (e.g. `r`, `sides`, `rot`, `corner`, `inset`) on an
    existing live shape and regenerate its geometry. `key` is the bare name, without the
    `data-hv-` prefix hector-vector stores it under."""
    return await _eval(
        """(a) => {
            const n = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!n || !hv.isLiveShape(n)) return { ok: false, reason: 'not a live shape' };
            editor.push('Shape param');
            hv.setShapeParam(n, a.key, a.value);
            editor._renderSelection(); editor._renderInspector();
            return { ok: true };
        }""",
        {"id": id, "key": key, "value": value},
    )


# ---------------------------------------------------------------------------
# Paint
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_apply_fill(ids: list[str], color: str | None) -> dict:
    """Set a flat fill colour (hex, e.g. "#e07a2f") on the given nodes, or pass color=null
    for no fill. For gradients/patterns, use hv_apply_gradient — this tool is solid-colour
    only, matching the Colour panel's own Solid tab."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.push('Apply fill');
            editor.applyPaint('fill', a.color == null ? { kind: 'none' } : { kind: 'solid', color: a.color });
            return { ok: true };
        }""",
        {"ids": ids, "color": color},
    )


@mcp.tool()
async def hv_apply_gradient(
    ids: list[str], type: str, stops: list[dict],
    cx: float = 0.5, cy: float = 0.5, r: float = 0.5,
    x1: float = 0.0, y1: float = 0.0, x2: float = 1.0, y2: float = 0.0,
) -> dict:
    """Apply a linear or radial gradient fill. `type` is "linear" or "radial". `stops` is
    an ordered list of {"offset": 0..1, "color": "#hex", "opacity"?: 0..1}. Geometry is in
    the shape's own 0..1 bounding-box space (SVG objectBoundingBox), same as the app's own
    gradient editor: for radial, cx/cy/r place the centre and radius; for linear, x1/y1 to
    x2/y2 sets the axis (defaults to left-to-right)."""
    spec: dict[str, Any] = {"type": type, "stops": stops}
    if type == "radial":
        spec.update(cx=cx, cy=cy, r=r)
    else:
        spec.update(x1=x1, y1=y1, x2=x2, y2=y2)
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.push('Apply gradient');
            for (const id of a.ids) {
                editor.selection = new Set([id]);
                editor.applyPaint('fill', { kind: 'gradient', spec: a.spec });
            }
            editor.selection = new Set(a.ids);
            return { ok: true };
        }""",
        {"ids": ids, "spec": spec},
    )


# ---------------------------------------------------------------------------
# Boolean / Pathfinder — the region-combination engine.
# ---------------------------------------------------------------------------

_BOOLEAN_OPS = {"union", "subtract", "intersect"}
_PATHFINDER_OPS = {"divide", "trim", "merge", "crop", "minus-back", "outline"}


@mcp.tool()
async def hv_boolean_op(ids: list[str], op: str) -> str:
    """Combine 2+ filled shapes with a boolean operation: "union" (merge into one),
    "subtract" (front shapes cut from the back one), "intersect" (keep only the overlap).
    Returns the new combined shape's id; the inputs are consumed."""
    if op not in _BOOLEAN_OPS:
        raise ValueError(f"op must be one of {sorted(_BOOLEAN_OPS)}, got {op!r}")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.booleanOp(a.op);
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids, "op": op},
    )


@mcp.tool()
async def hv_pathfinder(ids: list[str], op: str) -> list[str]:
    """Region-decompose 2-6 overlapping filled shapes: "divide" (every distinct
    membership face, as separate pieces), "trim" (each shape minus what's in front of
    it), "merge" (trim, then unite touching same-colour pieces), "crop" (keep only what's
    inside the frontmost shape), "minus-back" (frontmost shape minus everything behind
    it), "outline" (divide's faces, as unfilled strokes instead of fills). Returns the new
    node id(s); the inputs are consumed."""
    if op not in _PATHFINDER_OPS:
        raise ValueError(f"op must be one of {sorted(_PATHFINDER_OPS)}, got {op!r}")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.pathfinder(a.op);
            const sel = editor.selectedNodes();
            if (sel.length === 1 && sel[0].tagName.toLowerCase() === 'g')
                return [...sel[0].children].map(c => c.getAttribute('data-hv-id'));
            return sel.map(n => n.getAttribute('data-hv-id'));
        }""",
        {"ids": ids, "op": op},
    )


# ---------------------------------------------------------------------------
# Structure — grouping, duplication, arrangement.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_duplicate(ids: list[str]) -> list[str]:
    """Duplicate the given nodes (offset by 12,12 user-units, matching Ctrl/Cmd+D).
    Returns the new nodes' ids. A duplicated named-text-style or symbol instance keeps its
    shared link — that's intentional, matching what Duplicate does for a human."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.duplicate();
            return [...editor.selection];
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_group(ids: list[str]) -> str:
    """Group the given nodes into one `<g>`. Returns the new group's id."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.group();
            return [...editor.selection][0];
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_move(ids: list[str], dx: float, dy: float) -> dict:
    """Translate the given nodes by (dx, dy) in document user-units."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            const bb = editor._bboxUnion(editor.selectedNodes());
            editor.setSelectionPos(bb.x0 + a.dx, bb.y0 + a.dy);
            return { ok: true };
        }""",
        {"ids": ids, "dx": dx, "dy": dy},
    )


_ALIGN_MODES = {"left", "hcenter", "right", "top", "vmiddle", "bottom"}


@mcp.tool()
async def hv_align(ids: list[str], mode: str) -> dict:
    """Align the given nodes to the artboard edges/centre. `mode` is one of left/hcenter/
    right (horizontal) or top/vmiddle/bottom (vertical) — each node moves independently to
    that artboard edge/centre line, same as the Properties panel's align bar."""
    if mode not in _ALIGN_MODES:
        raise ValueError(f"mode must be one of {sorted(_ALIGN_MODES)}, got {mode!r}")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.align(a.mode);
            return { ok: true };
        }""",
        {"ids": ids, "mode": mode},
    )


@mcp.tool()
async def hv_distribute(ids: list[str], axis: str) -> dict:
    """Even out the gaps between 3+ selected nodes along one axis. `axis` is "h"
    (horizontal spacing) or "v" (vertical spacing). The two extreme nodes (by bbox centre)
    anchor the span and don't move; the ones between get equal edge-to-edge gaps."""
    if axis not in ("h", "v"):
        raise ValueError(f'axis must be "h" or "v", got {axis!r}')
    if len(ids) < 3:
        raise ValueError("distribute needs 3+ node ids")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.distribute(a.axis);
            return { ok: true };
        }""",
        {"ids": ids, "axis": axis},
    )


@mcp.tool()
async def hv_reflect(ids: list[str], axis: str, copy: bool = False) -> list[str]:
    """Reflect the given nodes across their own combined centre. `axis` is "horizontal"
    (flips vertically) or "vertical" (flips horizontally — the one you want for mirroring
    left/right, e.g. a matching pair of ears). If `copy` is true, reflects a duplicate and
    leaves the originals untouched (returns the copy's ids); otherwise reflects in place
    (returns the same ids)."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.reflectSelection(a.axis, { copy: a.copy });
            return [...editor.selection];
        }""",
        {"ids": ids, "axis": axis, "copy": copy},
    )


# ---------------------------------------------------------------------------
# Text — first-class content, not a debugging afterthought (widget-parity scope,
# decision a542832a): creates/edits go through the same headless path _commitText uses on
# blur (_writeContent dispatches point/area/on-path correctly), skipping only the
# interactive contentEditable overlay itself, which has no meaning for an agent caller.
# ---------------------------------------------------------------------------

_TEXT_STYLE_KEYS = {
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "textAnchor",
    "letterSpacing", "lineHeight",
}


@mcp.tool()
async def hv_create_text(
    x: float, y: float, text: str, w: float | None = None, h: float | None = None,
    fill: str = "#000000", style: dict | None = None,
) -> str:
    """Create a text node and return its new id. Point text (no `w`) anchors at (x, y);
    area text (`w` given, `h` optional) is a wrap-flowed box like the Text tool's
    click-drag. `style` overrides any of fontFamily/fontSize/fontWeight/fontStyle/
    textAnchor/letterSpacing/lineHeight for this node only (unset fields inherit the
    current text-style default, same as a human starting a new text object)."""
    bad = set(style) - _TEXT_STYLE_KEYS if style else set()
    if bad:
        raise ValueError(f"style has unknown keys {sorted(bad)}, expected a subset of {sorted(_TEXT_STYLE_KEYS)}")
    return await _eval(
        """(a) => {
            editor.push('Add text');
            const ts = Object.assign({}, editor._textStyle(), a.style || {});
            const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            const id = 'n' + (++editor.idSeq);
            t.setAttribute('data-hv-id', id);
            t.setAttribute('xml:space', 'preserve');
            t.setAttribute('x', String(a.x));
            if (a.w > 0) {
                t.setAttribute('y', String(a.y + ts.fontSize * 0.8));
                t.setAttribute('data-hv-text-width', String(a.w));
                if (a.h > 0) t.setAttribute('data-hv-text-height', String(a.h));
                editor._applyTextStyleAttrs(t, ts);
                t.removeAttribute('text-anchor');   // area text is left-flowed
            } else {
                t.setAttribute('y', String(a.y));
                editor._applyTextStyleAttrs(t, ts);
            }
            t.setAttribute('fill', a.fill);
            editor._artHome().insertBefore(t, editor._artBefore());
            editor._writeContent(t, a.text || '');
            editor.selection = new Set([id]); editor.artboardSelected = false;
            editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
            return id;
        }""",
        {"x": x, "y": y, "w": w, "h": h, "text": text, "fill": fill, "style": style or {}},
    )


@mcp.tool()
async def hv_set_text_content(id: str, text: str) -> dict:
    """Replace a text node's content. Dispatches correctly for point text (one tspan per
    "\\n"), area text (re-wraps to its box width), and text-on-path (a single flowing run,
    newlines collapse to spaces) — same as committing an edit in the app."""
    return await _eval(
        """(a) => {
            const n = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!n || n.tagName.toLowerCase() !== 'text') return { ok: false, reason: 'not a text node' };
            editor.push('Edit text');
            editor._writeContent(n, a.text);
            editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
            return { ok: true };
        }""",
        {"id": id, "text": text},
    )


@mcp.tool()
async def hv_set_text_style(ids: list[str], style: dict) -> dict:
    """Set font/text styling on the given text nodes in one undo step. `style` keys:
    fontFamily (CSS stack string), fontSize (number), fontWeight ("300".."900"), fontStyle
    ("normal"/"italic"), textAnchor ("start"/"middle"/"end" — left/centre/right), letter
    Spacing (number), lineHeight (number, ratio of fontSize). Pass null for a key to clear
    it back to default. Unlisted keys are left untouched."""
    bad = set(style) - _TEXT_STYLE_KEYS
    if bad:
        raise ValueError(f"style has unknown keys {sorted(bad)}, expected a subset of {sorted(_TEXT_STYLE_KEYS)}")
    return await _eval(
        """(a) => {
            const texts = a.ids
                .map(id => editor.stage.querySelector('[data-hv-id="' + id + '"]'))
                .filter(n => n && n.tagName.toLowerCase() === 'text');
            if (!texts.length) return { ok: false, reason: 'no text nodes' };
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.push('Text style');
            const ATTR = {
                fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight',
                fontStyle: 'font-style', textAnchor: 'text-anchor', letterSpacing: 'letter-spacing',
            };
            const DEFAULT_CLEAR = { fontWeight: '400', fontStyle: 'normal', textAnchor: 'start', letterSpacing: 0 };
            const REFLOW = new Set(['fontSize', 'textAnchor', 'lineHeight']);
            for (const [k, v] of Object.entries(a.style)) {
                for (const n of texts) {
                    if (k === 'lineHeight') {
                        if (v == null) n.removeAttribute('data-hv-line-height');
                        else n.setAttribute('data-hv-line-height', String(v));
                    } else {
                        const attr = ATTR[k];
                        if (v == null || v === DEFAULT_CLEAR[k]) n.removeAttribute(attr);
                        else n.setAttribute(attr, String(v));
                    }
                    if (REFLOW.has(k)) editor._reflowText(n);
                    editor._syncTextStyleFrom(n);
                }
                if (v != null) editor._textStyle()[k] = v;
            }
            editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
            return { ok: true };
        }""",
        {"ids": ids, "style": style},
    )


@mcp.tool()
async def hv_set_text_box(id: str, w: float | None = None, h: float | None = None) -> dict:
    """Resize an area text's wrap box. `w` (wrap width) re-flows the text live; `h` (frame
    height) only re-checks overflow, the wrap stays the same. Pass null for `h` to clear
    the height bound (no overflow limit). No-op on point text (has no box)."""
    return await _eval(
        """(a) => {
            editor.selection = new Set([a.id]); editor.artboardSelected = false;
            const texts = editor.selectedNodes().filter(n => n.tagName.toLowerCase() === 'text');
            if (!texts.length) return { ok: false, reason: 'not a text node' };
            editor.push('Text box');
            if (a.w != null) editor._setAreaWidth(a.w);
            if (a.h !== undefined) editor._setAreaHeight(a.h == null ? 0 : a.h);
            editor._renderSelection(); editor._renderInspector();
            return { ok: true };
        }""",
        {"id": id, "w": w, "h": h},
    )


# ---------------------------------------------------------------------------
# Symbols — reusable masters (widget-parity scope, decision a542832a). A symbol is a
# `<g class="hv-symbol">` living in <defs>; each instance on the stage is a live `<use>`
# referencing it, so editing the master updates every instance for free (SVG-native, no
# app-level bookkeeping to keep in sync). editSymbol's interactive isolation-mode editing
# session is NOT wrapped here — it's a stateful multi-step UI mode, not a single atomic
# mutation, and out of scope for this slice; an agent can already edit a master's rendered
# content indirectly (create/select/paint tools operate on whatever's on the stage).
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_list_symbols() -> list[dict]:
    """Every symbol master defined in the document: its def-id (pass to
    hv_place_symbol_instance) and display name. Empty if none exist yet."""
    return await _eval(
        """() => [...editor.stage.querySelectorAll('defs .hv-symbol')].map(sym => ({
            id: sym.getAttribute('id'), name: editor._symbolName(sym),
        }))"""
    )


@mcp.tool()
async def hv_make_symbol(ids: list[str]) -> str:
    """Turn the given nodes into a reusable symbol master (moved into <defs>) and replace
    them on the stage with one instance (a `<use>`) in their place. Returns the new
    instance's node id. Duplicate the instance (hv_duplicate) or hv_place_symbol_instance
    for more copies — every instance updates live if the master is edited later."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.makeSymbol();
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_break_symbol_link(id: str) -> str:
    """Replace a symbol instance with an independent concrete copy of its master's content
    (no longer updates if the master changes later). Returns the new group's node id."""
    return await _eval(
        """(a) => {
            const use = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!use || !editor.isSymbolInstance(use)) return null;
            editor.breakSymbolLink(use);
            return [...editor.selection][0] || null;
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_place_symbol_instance(symbol_id: str, x: float | None = None, y: float | None = None) -> str:
    """Place a NEW instance of an existing symbol master (from hv_list_symbols' `id`) at
    (x, y) — its own centre in document user-units, defaulting to the artboard's centre.
    Distinct from hv_duplicate, which copies an existing instance instead of the master."""
    return await _eval(
        """(a) => {
            editor.placeSymbolInstance(a.symbol_id, a.x, a.y);
            return [...editor.selection][0] || null;
        }""",
        {"symbol_id": symbol_id, "x": x, "y": y},
    )


@mcp.tool()
async def hv_edit_symbol(id: str) -> list[dict]:
    """Enter symbol-master editing (Isolation mode): surface the instance's master onto the
    stage so its content becomes directly selectable/editable by the other hv_* tools
    (paint, move, set_shape_param, etc.) — every OTHER instance updates live as you edit.
    Returns the master's now-editable content nodes (same shape as hv_get_document's
    `nodes`). Call hv_finish_symbol_edit when done, before editing anything else.

    CAVEAT: hv_create_shape and hv_create_text insert at the TOP-LEVEL stage regardless of
    an active symbol edit (they don't route through isolation-aware insertion), so they
    will NOT land inside the master — a known limitation, not silently worked around. To
    add new content to a master while editing it, hv_duplicate one of the returned content
    nodes instead of creating a fresh shape."""
    return await _eval(
        """(a) => {
            const use = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!use || !editor.isSymbolInstance(use)) return [];
            editor.editSymbol(use);
            const root = editor.nodeById(editor._isoStack[editor._isoStack.length - 1]);
            if (!root) return [];
            return [...root.querySelectorAll(':scope > [data-hv-id]')].map(n => {
                const tag = n.tagName.toLowerCase();
                const o = { id: n.getAttribute('data-hv-id'), tag, fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke') };
                if (tag === 'text') o.content = editor._readTextContent(n);
                return o;
            });
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_finish_symbol_edit() -> dict:
    """Finish the current symbol-master edit (started by hv_edit_symbol) and return the
    master to <defs> — every instance (including the one originally clicked) reflects the
    edit from here on. No-op if no edit is in progress."""
    return await _eval(
        """() => {
            if (!editor._isoStack || !editor._isoStack.length) return { ok: false, reason: 'no edit in progress' };
            editor.exitIsolation();
            return { ok: true };
        }"""
    )


# ---------------------------------------------------------------------------
# Multi-fill / Appearance — an ordered stack of fill layers on one shape (widget-parity
# scope, decision a542832a), fills-only per this app's own scoped v1 (no strokes/blend
# modes/per-layer effects yet — see multifill.js's own comment). setFillLayer is wrapped
# with an explicit editor.push() here: the underlying method itself doesn't take history
# (the live colour-picker caller doesn't coalesce it either — a pre-existing gap outside
# this tool's own scope, flagged to Halcyon rather than silently patched in their lane),
# so a single MCP call stays a single real undo step regardless.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_make_multi_fill(id: str) -> str:
    """Turn one filled shape into a 2-layer fill stack (Illustrator's Appearance panel,
    fills only) — the current fill duplicated into both layers. Returns the new group's
    id. Add/reorder/edit layers with the other hv_*_fill_layer tools."""
    return await _eval(
        """(a) => {
            editor.selection = new Set([a.id]); editor.artboardSelected = false;
            editor.makeMultiFill();
            return [...editor.selection][0] || null;
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_get_fill_layers(id: str) -> list[dict] | None:
    """The ordered fill-layer stack on a multi-fill group (index 0 = bottom/first-painted).
    Each entry is {"fill": "#hex", "opacity": 0..1}. None if `id` isn't a multi-fill group."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            return g && editor.isMultiFillGroup(g) ? editor._fillLayers(g) : null;
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_add_fill_layer(id: str) -> dict:
    """Add a new top layer to a fill stack, cloning the current top layer's colour/opacity."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMultiFillGroup(g)) return { ok: false, reason: 'not a multi-fill group' };
            editor.addFillLayer(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_remove_fill_layer(id: str, index: int) -> dict:
    """Remove one layer from a fill stack by index. Refuses (no-op) on the last remaining
    layer — a stack always keeps at least 1."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMultiFillGroup(g)) return { ok: false, reason: 'not a multi-fill group' };
            const before = (editor._fillLayers(g) || []).length;
            editor.removeFillLayer(g, a.index);
            const after = (editor._fillLayers(g) || []).length;
            return { ok: after < before };
        }""",
        {"id": id, "index": index},
    )


@mcp.tool()
async def hv_set_fill_layer(id: str, index: int, fill: str | None = None, opacity: float | None = None) -> dict:
    """Set one fill layer's colour and/or opacity (only the given fields change)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMultiFillGroup(g)) return { ok: false, reason: 'not a multi-fill group' };
            const layers = editor._fillLayers(g);
            if (!layers || !layers[a.index]) return { ok: false, reason: 'no such layer index' };
            editor.push('Fill layer');
            const patch = {};
            if (a.fill != null) patch.fill = a.fill;
            if (a.opacity != null) patch.opacity = a.opacity;
            editor.setFillLayer(g, a.index, patch);
            editor._renderInspector();
            return { ok: true };
        }""",
        {"id": id, "index": index, "fill": fill, "opacity": opacity},
    )


@mcp.tool()
async def hv_move_fill_layer(id: str, index: int, direction: str) -> dict:
    """Reorder a fill layer up (toward the top/last-painted) or down. `direction` is "up"
    or "down". No-op at either end of the stack."""
    if direction not in ("up", "down"):
        raise ValueError(f'direction must be "up" or "down", got {direction!r}')
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMultiFillGroup(g)) return { ok: false, reason: 'not a multi-fill group' };
            editor.moveFillLayer(g, a.index, a.direction === 'up' ? 1 : -1);
            return { ok: true };
        }""",
        {"id": id, "index": index, "direction": direction},
    )


@mcp.tool()
async def hv_expand_multi_fill(id: str) -> dict:
    """Expand a fill stack into its independent, plain <path> layers (no longer a linked
    stack — each layer becomes its own editable shape)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMultiFillGroup(g)) return { ok: false, reason: 'not a multi-fill group' };
            editor.expandMultiFill(g);
            return { ok: true };
        }""",
        {"id": id},
    )


# ---------------------------------------------------------------------------
# Deform: Envelope, Gradient Mesh, Warp (widget-parity scope, decision a542832a). All three
# hold their live spec as a JSON attribute (data-hv-env/-mesh/-warp) regenerated on every
# edit — same "regen from spec" shape as multi-fill. The per-point setters (setEnvelopePoint/
# setMeshPoint/setMeshColor/setWarpParam) don't self-manage undo (scrubbable-drag callers
# coalesce them in the live UI), so each is wrapped with an explicit editor.push() here, same
# fix pattern as hv_set_fill_layer. Row/col are validated against the spec's own grid size
# before calling through — the underlying setters silently no-op on an out-of-range index
# (hit this as a false "bug" during the tools audit; real bug was the test's own bad index).
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_make_envelope(ids: list[str]) -> str:
    """Wrap the given filled shapes in a draggable deform grid over their combined bounds
    (Illustrator's Envelope Distort). Returns the new group's id."""
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.makeEnvelope();
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_make_envelope_with_top_object(ids: list[str]) -> str:
    """Same as hv_make_envelope, but the TOPMOST shape in `ids` lends its own silhouette as
    the grid's rest shape (and is consumed) — the rest of the selection warps to fit inside
    where it was. Needs 2+ ids. Returns the new group's id."""
    if len(ids) < 2:
        raise ValueError("needs 2+ ids — the topmost lends its bounds, the rest get warped")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.makeEnvelopeWithTopObject();
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_get_envelope(id: str) -> dict | None:
    """An envelope group's grid: {rows, cols, pts} where pts[row][col] = {x, y} in document
    user-units. None if `id` isn't an envelope group."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isEnvelopeGroup(g)) return null;
            const spec = editor._envSpec(g);
            return { rows: spec.rows, cols: spec.cols, pts: spec.pts };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_set_envelope_point(id: str, row: int, col: int, x: float, y: float) -> dict:
    """Move one grid point of an envelope, deforming the wrapped content. `row`/`col` must
    be within the grid returned by hv_get_envelope."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isEnvelopeGroup(g)) return { ok: false, reason: 'not an envelope group' };
            const spec = editor._envSpec(g);
            if (!spec.pts[a.row] || !spec.pts[a.row][a.col]) return { ok: false, reason: `row/col out of range (grid is ${spec.rows}x${spec.cols})` };
            editor.push('Envelope point');
            editor.setEnvelopePoint(g, a.row, a.col, a.x, a.y);
            editor._renderSelection();
            return { ok: true };
        }""",
        {"id": id, "row": row, "col": col, "x": x, "y": y},
    )


@mcp.tool()
async def hv_reset_envelope(id: str) -> dict:
    """Reset an envelope's grid points to its rest shape (the silhouette for a
    with-top-object envelope, or a plain rectangle otherwise)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isEnvelopeGroup(g)) return { ok: false, reason: 'not an envelope group' };
            editor.resetEnvelope(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_expand_envelope(id: str) -> dict:
    """Expand an envelope into its plain, independently-editable deformed geometry."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isEnvelopeGroup(g)) return { ok: false, reason: 'not an envelope group' };
            editor.expandEnvelope(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_make_gradient_mesh(id: str) -> str:
    """Wrap one filled shape in a draggable colour+geometry mesh grid (Illustrator's
    Gradient Mesh). Every grid point starts at the shape's current fill colour and an
    evenly-spaced position — vary hv_set_mesh_color/hv_set_mesh_point per point from there.
    Returns the new group's id."""
    return await _eval(
        """(a) => {
            editor.selection = new Set([a.id]); editor.artboardSelected = false;
            editor.makeGradientMesh();
            return [...editor.selection][0] || null;
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_get_gradient_mesh(id: str) -> dict | None:
    """A gradient-mesh group's grid: {rows, cols, colors, pts} — colors[row][col] is a hex
    string, pts[row][col] is {x, y} in document user-units. None if not a mesh group."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMeshGroup(g)) return null;
            const spec = editor._meshSpec(g);
            return { rows: spec.rows, cols: spec.cols, colors: spec.colors, pts: spec.pts };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_set_mesh_color(id: str, row: int, col: int, color: str) -> dict:
    """Set one gradient-mesh grid point's colour. `row`/`col` must be within the grid
    returned by hv_get_gradient_mesh."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMeshGroup(g)) return { ok: false, reason: 'not a mesh group' };
            const spec = editor._meshSpec(g);
            if (!spec.colors[a.row] || spec.colors[a.row][a.col] == null) return { ok: false, reason: `row/col out of range (grid is ${spec.rows}x${spec.cols})` };
            editor.push('Mesh colour');
            editor.setMeshColor(g, a.row, a.col, a.color);
            editor._renderSelection();
            return { ok: true };
        }""",
        {"id": id, "row": row, "col": col, "color": color},
    )


@mcp.tool()
async def hv_set_mesh_point(id: str, row: int, col: int, x: float, y: float) -> dict:
    """Move one gradient-mesh grid point, deforming the mesh's geometry (independent of its
    colour). `row`/`col` must be within the grid returned by hv_get_gradient_mesh."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMeshGroup(g)) return { ok: false, reason: 'not a mesh group' };
            const spec = editor._meshSpec(g);
            if (!spec.pts[a.row] || !spec.pts[a.row][a.col]) return { ok: false, reason: `row/col out of range (grid is ${spec.rows}x${spec.cols})` };
            editor.push('Mesh point');
            editor.setMeshPoint(g, a.row, a.col, a.x, a.y);
            editor._renderSelection();
            return { ok: true };
        }""",
        {"id": id, "row": row, "col": col, "x": x, "y": y},
    )


@mcp.tool()
async def hv_reset_mesh_points(id: str) -> dict:
    """Reset a gradient mesh's grid points to their rest positions (geometry only, colours
    are untouched)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMeshGroup(g)) return { ok: false, reason: 'not a mesh group' };
            editor.resetMeshPoints(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_expand_gradient_mesh(id: str) -> dict:
    """Expand a gradient mesh into a plain, clipped raster image (no longer editable as a
    grid)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isMeshGroup(g)) return { ok: false, reason: 'not a mesh group' };
            editor.expandGradientMesh(g);
            return { ok: true };
        }""",
        {"id": id},
    )


_WARP_TYPES = {"arc", "bulge", "flag", "fisheye"}


@mcp.tool()
async def hv_make_warp(ids: list[str], type: str) -> str:
    """Apply a parametric preset deformation over the combined bounds of the given filled
    shapes. `type` is one of arc/bulge/flag/fisheye. Returns the new group's id; adjust the
    effect afterward with hv_set_warp_param (key="amount", -1..1)."""
    if type not in _WARP_TYPES:
        raise ValueError(f"type must be one of {sorted(_WARP_TYPES)}, got {type!r}")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.makeWarp(a.type);
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids, "type": type},
    )


@mcp.tool()
async def hv_set_warp_param(id: str, key: str, value: Any) -> dict:
    """Change a warp group's `type` (arc/bulge/flag/fisheye) or `amount` (-1..1) and
    regenerate its geometry."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWarpGroup(g)) return { ok: false, reason: 'not a warp group' };
            editor.push('Warp param');
            editor.setWarpParam(g, a.key, a.value);
            return { ok: true };
        }""",
        {"id": id, "key": key, "value": value},
    )


@mcp.tool()
async def hv_expand_warp(id: str) -> dict:
    """Expand a warp group into its plain, independently-editable deformed geometry."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWarpGroup(g)) return { ok: false, reason: 'not a warp group' };
            editor.expandWarp(g);
            return { ok: true };
        }""",
        {"id": id},
    )


# ---------------------------------------------------------------------------
# Stroke — colour/width via applyStroke (Object Properties panel's Width row); the rest of
# the panel (align/join/cap/dash/miter) bundles into one hv_set_stroke_style call so an
# agent doesn't need 5 round-trips for what's one visual "Stroke" group to a human. None of
# the underlying setters self-manage undo (the panel coalesces them live), so each tool
# takes exactly one editor.push() regardless of how many fields it touches — setStrokeAlign
# is deliberately NOT called here even though it exists (it self-pushes internally, which
# would split one MCP call into two undo steps); its own align/_syncStrokeAlign logic is
# inlined instead. Widget-parity scope, decision a542832a.
# ---------------------------------------------------------------------------

_STROKE_ALIGNS = {"inside", "center", "outside"}
_STROKE_JOINS = {"miter", "round", "bevel"}
_STROKE_CAPS = {"butt", "round", "square"}


@mcp.tool()
async def hv_set_stroke(ids: list[str], color: str | None = None, width: float | None = None) -> dict:
    """Set stroke colour and/or width (Object Properties' Width row). Pass width=0 (or
    color=null with no stroke already present) to remove the stroke entirely — clears
    every other stroke property (align/join/cap/dash) with it, matching the panel. Passing
    only one of color/width keeps the other at its current value on each node (falls back
    to black / 1 if the node had no stroke yet)."""
    return await _eval(
        """(a) => {
            const nodes = a.ids.map(id => editor.stage.querySelector('[data-hv-id="' + id + '"]')).filter(Boolean);
            if (!nodes.length) return { ok: false, reason: 'no such nodes' };
            editor.push('Stroke');
            for (const n of nodes) {
                if (editor.isRaster(n)) continue;
                const curColor = n.getAttribute('stroke') && n.getAttribute('stroke') !== 'none' ? n.getAttribute('stroke') : '#000000';
                const curWidth = parseFloat(n.getAttribute('stroke-width')) || 1;
                editor.selection = new Set([n.getAttribute('data-hv-id')]); editor.artboardSelected = false;
                editor.applyStroke(a.color != null ? a.color : curColor, a.width != null ? a.width : curWidth);
            }
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor._renderSelection(); editor._renderInspector();
            return { ok: true };
        }""",
        {"ids": ids, "color": color, "width": width},
    )


@mcp.tool()
async def hv_apply_stroke_gradient(
    ids: list[str], type: str, stops: list[dict],
    cx: float = 0.5, cy: float = 0.5, r: float = 0.5,
    x1: float = 0.0, y1: float = 0.0, x2: float = 1.0, y2: float = 0.0,
) -> dict:
    """Apply a linear or radial gradient to the STROKE (same shape as hv_apply_gradient,
    which is fill-only). Needs each node to already have a stroke width — set one first
    with hv_set_stroke if it doesn't."""
    spec: dict[str, Any] = {"type": type, "stops": stops}
    if type == "radial":
        spec.update(cx=cx, cy=cy, r=r)
    else:
        spec.update(x1=x1, y1=y1, x2=x2, y2=y2)
    return await _eval(
        """(a) => {
            editor.push('Apply stroke gradient');
            for (const id of a.ids) {
                editor.selection = new Set([id]); editor.artboardSelected = false;
                editor.applyPaint('stroke', { kind: 'gradient', spec: a.spec });
            }
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            return { ok: true };
        }""",
        {"ids": ids, "spec": spec},
    )


@mcp.tool()
async def hv_set_stroke_style(
    ids: list[str], align: str | None = None, join: str | None = None,
    cap: str | None = None, dasharray: str | None = None, miter_limit: float | None = None,
) -> dict:
    """Set stroke align/join/cap/dash/miter-limit in one undo step (only the given fields
    change). `align` is inside/center/outside; `join` is miter/round/bevel; `cap` is
    butt/round/square; `dasharray` is an SVG dash-pattern string (e.g. "4 4", or "" to
    clear it back to solid); `miter_limit` only matters when join is "miter"."""
    if align is not None and align not in _STROKE_ALIGNS:
        raise ValueError(f"align must be one of {sorted(_STROKE_ALIGNS)}, got {align!r}")
    if join is not None and join not in _STROKE_JOINS:
        raise ValueError(f"join must be one of {sorted(_STROKE_JOINS)}, got {join!r}")
    if cap is not None and cap not in _STROKE_CAPS:
        raise ValueError(f"cap must be one of {sorted(_STROKE_CAPS)}, got {cap!r}")
    return await _eval(
        """(a) => {
            const nodes = a.ids.map(id => editor.stage.querySelector('[data-hv-id="' + id + '"]')).filter(Boolean);
            if (!nodes.length) return { ok: false, reason: 'no such nodes' };
            editor.push('Stroke style');
            for (const n of nodes) {
                if (editor.isRaster(n)) continue;
                if (a.align != null) {
                    if (a.align === 'center') n.removeAttribute('data-hv-stroke-align');
                    else n.setAttribute('data-hv-stroke-align', a.align);
                    editor._syncStrokeAlign(n);
                }
                if (a.join != null) n.setAttribute('stroke-linejoin', a.join);
                if (a.cap != null) n.setAttribute('stroke-linecap', a.cap);
                if (a.dasharray != null) { if (a.dasharray === '') n.removeAttribute('stroke-dasharray'); else n.setAttribute('stroke-dasharray', a.dasharray); }
                if (a.miter_limit != null) n.setAttribute('stroke-miterlimit', String(a.miter_limit));
            }
            editor._renderSelection(); editor._renderInspector();
            return { ok: true };
        }""",
        {"ids": ids, "align": align, "join": join, "cap": cap, "dasharray": dasharray, "miter_limit": miter_limit},
    )


# ---------------------------------------------------------------------------
# Effects — a per-object stack of live filter effects (blur / drop shadow / glow), widget-
# parity scope. addEffect/removeEffect self-manage undo; updateEffect (the per-param live-
# drag setter) doesn't, so it's wrapped with an explicit push() here, same pattern as every
# other scrubbable-field tool in this file.
# ---------------------------------------------------------------------------

_EFFECT_TYPES = {"blur", "shadow", "glow"}


@mcp.tool()
async def hv_get_effects(id: str) -> list[dict]:
    """The effect stack on one node, in apply order: {"type": "blur", "amount": n} |
    {"type": "shadow"|"glow", "dx", "dy", "blur", "color", "opacity"} (dx/dy omitted for
    glow — it's a shadow with zero offset). Empty list if the node has no effects."""
    return await _eval(
        """(a) => {
            const n = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            return n ? editor.effectsOf(n) : [];
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_add_effect(ids: list[str], type: str) -> dict:
    """Add a new effect to the given nodes' stacks, each with its usual default params.
    `type` is blur/shadow/glow. Tune it afterward with hv_update_effect."""
    if type not in _EFFECT_TYPES:
        raise ValueError(f"type must be one of {sorted(_EFFECT_TYPES)}, got {type!r}")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.addEffect(a.type);
            return { ok: true };
        }""",
        {"ids": ids, "type": type},
    )


@mcp.tool()
async def hv_update_effect(id: str, index: int, patch: dict) -> dict:
    """Change params on one node's effect at `index` (from hv_get_effects). `patch` keys
    match the effect's own shape: "amount" for blur; "dx"/"dy"/"blur"/"color"/"opacity" for
    shadow/glow. Only the given keys change."""
    return await _eval(
        """(a) => {
            const n = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!n) return { ok: false, reason: 'no such node' };
            const fx = editor.effectsOf(n);
            if (!fx[a.index]) return { ok: false, reason: 'no such effect index' };
            editor.push('Effect');
            editor.updateEffect(n, a.index, a.patch);
            editor._renderInspector();
            return { ok: true };
        }""",
        {"id": id, "index": index, "patch": patch},
    )


@mcp.tool()
async def hv_remove_effect(id: str, index: int) -> dict:
    """Remove one effect from a node's stack by index."""
    return await _eval(
        """(a) => {
            const n = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!n) return { ok: false, reason: 'no such node' };
            const before = editor.effectsOf(n).length;
            editor.removeEffect(n, a.index);
            const after = editor.effectsOf(n).length;
            return { ok: after < before };
        }""",
        {"id": id, "index": index},
    )


# ---------------------------------------------------------------------------
# Blend — interpolated steps between two shapes (widget-parity scope, decision a542832a).
# makeBlend/expandBlend/makeReplaceSpine/removeSpine self-manage undo; setBlendParam (the
# scrubbable Steps/Reverse control) doesn't, wrapped here same as every other such setter.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_make_blend(ids: list[str]) -> str:
    """Blend exactly 2 filled shapes into an interpolated step-sequence between them (step
    count auto-picked from their distance/size). Returns the new group's id."""
    if len(ids) != 2:
        raise ValueError("blend needs exactly 2 ids")
    return await _eval(
        """(a) => {
            editor.selection = new Set(a.ids); editor.artboardSelected = false;
            editor.makeBlend();
            return [...editor.selection][0] || null;
        }""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_set_blend_param(id: str, key: str, value: Any) -> dict:
    """Change a blend's `steps` (integer, step count) or `reverse` (bool, swap which
    endpoint is treated as the start) and regenerate."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isBlendGroup(g)) return { ok: false, reason: 'not a blend group' };
            editor.push('Blend param');
            editor.setBlendParam(g, a.key, a.value);
            return { ok: true };
        }""",
        {"id": id, "key": key, "value": value},
    )


@mcp.tool()
async def hv_expand_blend(id: str) -> dict:
    """Expand a blend into its plain, independently-editable step shapes."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isBlendGroup(g)) return { ok: false, reason: 'not a blend group' };
            editor.expandBlend(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_make_replace_spine(blend_id: str, spine_id: str) -> dict:
    """Make a blend follow a path instead of a straight line: `spine_id`'s outline becomes
    the blend's motion path and is consumed (removed). Steps space evenly by arc length
    along it."""
    return await _eval(
        """(a) => {
            editor.selection = new Set([a.blend_id, a.spine_id]); editor.artboardSelected = false;
            editor.makeReplaceSpine();
            return { ok: true };
        }""",
        {"blend_id": blend_id, "spine_id": spine_id},
    )


@mcp.tool()
async def hv_remove_spine(id: str) -> dict:
    """Release a blend back to a straight-line motion path (undoes hv_make_replace_spine)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isBlendGroup(g)) return { ok: false, reason: 'not a blend group' };
            editor.removeSpine(g);
            return { ok: true };
        }""",
        {"id": id},
    )


# ---------------------------------------------------------------------------
# Width tool — a variable-width stroke ribbon (widget-parity scope). makeWidthStroke/
# releaseWidthStroke/expandWidthStroke/resetWidthUniform self-manage undo; setWidthBase
# (scrubbable) is wrapped here. hv_set_width_profile_point reimplements _widthDown's
# grab-or-insert-a-stop + set-its-half-width logic as a single-shot call — the source
# doesn't factor that out into its own directly-callable core (unlike shapeBuilderPaint/
# scissorsCut/knifeCut/eraseSweep), so it's mirrored here rather than driving a pointer drag.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_make_width_stroke(ids: list[str]) -> list[str]:
    """Convert the given stroked paths into variable-width-stroke groups (each keeps its
    current width uniformly at first — vary it with hv_set_width_base or the interactive
    Width tool). Returns the new group ids (nodes with no stroke are skipped)."""
    return await _eval(
        """(a) => editor.makeWidthStroke(a.ids)""",
        {"ids": ids},
    )


@mcp.tool()
async def hv_set_width_base(id: str, width: float) -> dict:
    """Scale a width-stroke's whole profile proportionally to a new base width (keeps any
    variation already applied)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return { ok: false, reason: 'not a width-stroke group' };
            editor.push('Width base');
            editor.setWidthBase(g, a.width);
            editor._renderInspector();
            return { ok: true };
        }""",
        {"id": id, "width": width},
    )


@mcp.tool()
async def hv_reset_width_uniform(id: str) -> dict:
    """Reset a width-stroke's profile back to uniform (no variation), keeping its base width."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return { ok: false, reason: 'not a width-stroke group' };
            editor.resetWidthUniform(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_release_width_stroke(id: str) -> dict:
    """Release a width-stroke group back to a plain stroked path (drops the profile,
    keeps the current uniform-equivalent width)."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return { ok: false, reason: 'not a width-stroke group' };
            editor.releaseWidthStroke(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_expand_width_stroke(id: str) -> dict:
    """Expand a width-stroke group into its plain, independently-editable ribbon/fill paths."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return { ok: false, reason: 'not a width-stroke group' };
            editor.expandWidthStroke(g);
            return { ok: true };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_get_width_profile(id: str) -> dict | None:
    """A width-stroke's profile: {"base_width", "stops": [{"t", "l", "r"}]} — `t` is
    position along the spine (0..1), `l`/`r` are the half-width on each side of the spine
    at that stop (independent, so a profile can be asymmetric). None if `id` isn't a
    width-stroke group."""
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return null;
            const spec = editor._wsSpec(g);
            return { base_width: spec.w, stops: (spec.profile || []).map(s => ({ t: s.t, l: s.l, r: s.r })) };
        }""",
        {"id": id},
    )


@mcp.tool()
async def hv_set_width_profile_point(id: str, t: float, half_width: float, side: str = "both") -> dict:
    """Set the width profile at position `t` (0..1 along the spine) — grabs the nearest
    existing stop within 3% of `t`, or inserts a new one there (seeded from the profile's
    current width at that point, same as clicking down with the Width tool). `side` is
    "both" (symmetric), "left", or "right" (only that side of the spine changes, the
    Alt-drag behaviour). `half_width` must be >= 0."""
    if half_width < 0:
        raise ValueError("half_width must be >= 0")
    if side not in ("both", "left", "right"):
        raise ValueError(f'side must be "both", "left", or "right", got {side!r}')
    return await _eval(
        """(a) => {
            const g = editor.stage.querySelector('[data-hv-id="' + a.id + '"]');
            if (!g || !editor.isWidthStroke(g)) return { ok: false, reason: 'not a width-stroke group' };
            const spec = editor._wsSpec(g);
            editor.push('Width');
            let stop = (spec.profile || []).find(s => Math.abs(s.t - a.t) < 0.03);
            if (!stop) {
                const w0 = editor._wsWidthAt(spec)(a.t);
                stop = { t: a.t, l: w0.l, r: w0.r };
                spec.profile.push(stop);
                spec.profile.sort((x, y) => x.t - y.t);
            }
            if (a.side === 'left') stop.l = a.half_width;
            else if (a.side === 'right') stop.r = a.half_width;
            else { stop.l = a.half_width; stop.r = a.half_width; }
            editor._wsSet(g, spec); editor._regenWidthStroke(g);
            editor._renderSelection(); editor._renderInspector();
            return { ok: true, t: stop.t };
        }""",
        {"id": id, "t": t, "half_width": half_width, "side": side},
    )


# ---------------------------------------------------------------------------
# Shape Builder / Scissors / Knife / Eraser (widget-parity scope) — path-construction
# gesture tools. Each interactive drag/click already delegates to a pure, directly-callable
# CORE (shapeBuilderPaint / scissorsCut / knifeCut / eraseSweep) built exactly so a caller
# doesn't need to simulate pointer events — this is that same seam, just reached from MCP
# instead of a `_xDown` pointer handler. All four self-manage undo, including an internal
# undo-on-no-op when the gesture didn't actually change anything (a miss, not a failure) —
# each tool below reports that as ok:false via a before/after export diff rather than
# reaching into the history stack.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_shape_builder_paint(points: list[dict], subtract: bool = False) -> dict:
    """Shape Builder: paint over 2+ overlapping, already-selected filled shapes with a
    polyline of points (each {"x", "y"} in document user-units) to merge the regions it
    crosses into one shape. `subtract=True` removes the painted regions instead (Alt-drag
    in the app). Select the shapes first with hv_select."""
    return await _eval(
        """(a) => {
            const before = editor.stage.outerHTML;
            editor.shapeBuilderPaint(a.points, a.subtract);
            return { ok: editor.stage.outerHTML !== before, selection: [...editor.selection] };
        }""",
        {"points": points, "subtract": subtract},
    )


@mcp.tool()
async def hv_scissors_cut(x: float, y: float, tolerance: float = 4.0) -> dict:
    """Scissors: cut the nearest editable path at (x, y) — reopens a closed path, splits an
    open one into two objects. `tolerance` is the click-radius in document user-units.
    Fails harmlessly (ok:false) if nothing editable is within tolerance."""
    return await _eval(
        """(a) => {
            const before = editor.stage.outerHTML;
            editor.scissorsCut(a.x, a.y, a.tolerance);
            return { ok: editor.stage.outerHTML !== before, selection: [...editor.selection] };
        }""",
        {"x": x, "y": y, "tolerance": tolerance},
    )


@mcp.tool()
async def hv_knife_cut(points: list[dict], straight: bool = False) -> dict:
    """Knife: cut every filled shape crossed by a polyline (each {"x", "y"} in document
    user-units), splitting each into two separate objects along the cut. `straight=True`
    uses only the first/last points (a straight cut, Alt-drag in the app) instead of the
    full polyline. Acts on the current selection if any, else every filled shape."""
    return await _eval(
        """(a) => {
            const before = editor.stage.outerHTML;
            editor.knifeCut(a.points, a.straight);
            return { ok: editor.stage.outerHTML !== before, selection: [...editor.selection] };
        }""",
        {"points": points, "straight": straight},
    )


@mcp.tool()
async def hv_erase_sweep(points: list[dict], radius: float = 14.0) -> dict:
    """Eraser: subtract a round brush swept along a polyline (each {"x", "y"} in document
    user-units, `radius` in the same units) from every filled shape it crosses. Acts on the
    current selection if any, else every filled shape."""
    return await _eval(
        """(a) => {
            const before = editor.stage.outerHTML;
            editor.eraseSweep(a.points, a.radius);
            return { ok: editor.stage.outerHTML !== before, selection: [...editor.selection] };
        }""",
        {"points": points, "radius": radius},
    )


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_export_svg() -> str:
    """The current document's full SVG source, ready to hand back to a caller or write to
    a file. Ground truth — if you need to double-check exactly what a sequence of tool
    calls produced, this is more reliable than reasoning about it from the calls alone."""
    return await _eval("() => editor.stage.outerHTML")


# ---------------------------------------------------------------------------
# Library — Halcyon's Phase 2+ slice (docs/mcp-server.md), first piece: read-only
# browsing. Answered straight from the same Python helpers server.py's own
# /api/work-items etc. endpoints already use — this process and server.py share one
# filesystem and one hvserver package, so there's no second source of truth to keep
# in sync, and no need to round-trip through the page/HTTP layer for a pure read.
# hv_library_load (place an item on the canvas / open a .hv project) and full
# project I/O are a follow-up slice — see thread opened alongside this one.
# ---------------------------------------------------------------------------

_LIBRARY_KINDS = {"all", "raster", "vector", "canvas"}


@mcp.tool()
async def hv_library_list(kind: str = "all", q: str | None = None) -> list[dict]:
    """Browse the local Library: raster source images ("raster"), rendered vector/PNG
    outputs ("vector"), or saved .hv canvases ("canvas") — or "all" (default) for
    everything. `q`, if given, filters by a case-insensitive substring of the name. Each
    item carries `source` (which of the three it is) plus `name`/`url`/`modified_at`; use
    hv_library_info for a raster's full dimensions/colour-profile detail."""
    if kind not in _LIBRARY_KINDS:
        raise ValueError(f"kind must be one of {sorted(_LIBRARY_KINDS)}, got {kind!r}")
    items: list[dict] = []
    if kind in ("all", "raster"):
        for path in discover_work_items():
            rec = dict(work_item_record(path)); rec["source"] = "raster"
            items.append(rec)
    if kind in ("all", "vector"):
        for rec in list_outputs():
            rec = dict(rec); rec["source"] = "vector"
            items.append(rec)
    if kind in ("all", "canvas"):
        for rec in list_projects():
            rec = dict(rec); rec["source"] = "canvas"
            items.append(rec)
    if q:
        needle = q.lower()
        items = [it for it in items if needle in (it.get("name") or "").lower()]
    return items


@mcp.tool()
async def hv_library_info(name: str) -> dict:
    """Full detail for one raster source image in the Library: pixel dimensions, colour
    mode/alpha, format, ICC profile name, DPI, EXIF orientation — the same data the app's
    Info panel shows. Rasters only (from hv_library_list's "raster" source); vector
    outputs and .hv canvases have no equivalent metadata beyond what hv_library_list
    already returns."""
    return work_item_info(name)


# ---------------------------------------------------------------------------
# Document view — current tool, zoom/pan, Edit-vs-Manage mode. A real navigation
# action (hv_set_view_mode switches what's actually on screen for a human watching the
# same tab), not chrome positioning — in scope under the operator's widget-parity
# ruling (decision a542832a) same as everything else here.
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_get_view() -> dict:
    """Current view state: the active tool name, whether the app is in "edit" (the live
    canvas) or "manage" (the browse/batch-process grid) mode, and the editing canvas's
    zoom level + pan offset."""
    return await _eval(
        """() => ({
            tool: editor.tool,
            mode: (window.__manage && window.__manage.isManage()) ? 'manage' : 'edit',
            zoom: viewports.output.scale,
            pan: { x: viewports.output.x, y: viewports.output.y },
        })"""
    )


@mcp.tool()
async def hv_set_view_mode(mode: str) -> dict:
    """Switch between "edit" (the live canvas) and "manage" (the browse/batch-process
    grid — Library/Processor/Jobs). A real navigation action, not a cosmetic one — an
    agent working the Library or a batch pipeline run needs Manage mode the same way a
    human clicking the Edit/Manage toggle does."""
    if mode not in ("edit", "manage"):
        raise ValueError(f'mode must be "edit" or "manage", got {mode!r}')
    return await _eval(
        """(a) => {
            if (!window.__manage) return { ok: false, reason: 'Manage screen unavailable (cloud build)' };
            const isManage = window.__manage.isManage();
            if (a.mode === 'manage' && !isManage) window.__manage.enter();
            else if (a.mode === 'edit' && isManage) window.__manage.leave();
            return { ok: true, mode: window.__manage.isManage() ? 'manage' : 'edit' };
        }""",
        {"mode": mode},
    )


@mcp.tool()
async def hv_fit_view() -> dict:
    """Fit the editing canvas to frame (same as the Fit button / shortcut). Returns the
    resulting zoom level."""
    return await _eval(
        "() => { fitVp(viewports.output); return { zoom: viewports.output.scale }; }"
    )


@mcp.tool()
async def hv_set_zoom(zoom: float) -> dict:
    """Set the editing canvas's zoom to an absolute scale (1.0 = 100%). Clamped to the
    app's own 2%..4000% range. Returns the resulting zoom level (may differ from the
    requested value if clamped)."""
    return await _eval(
        """(a) => {
            const vp = viewports.output;
            zoomVp(vp, a.zoom / (vp.scale || 1));
            return { zoom: vp.scale };
        }""",
        {"zoom": zoom},
    )


# ---------------------------------------------------------------------------
# Library load + project I/O — Phase 2+ slice 2. Reads a .hv project's JSON straight
# off disk (this process shares a filesystem with server.py, same reasoning as the
# Library-browsing tools above) and hands its parts to the page; a raster/vector item
# goes through the exact client functions a click already uses (window.app.selectedName,
# mountStageFromText) so there's still one code path, just reached from Python instead
# of a pointer event.
# ---------------------------------------------------------------------------


def _resolve_canvas_project(name: str) -> Path:
    stem = Path(name).name
    if not stem.lower().endswith(".hv"):
        stem += ".hv"
    target = (OUTPUTS_DIR / "canvas" / stem).resolve()
    try:
        target.relative_to((OUTPUTS_DIR / "canvas").resolve())
    except ValueError:
        raise ValueError(f"Project name resolves outside the canvas folder: {name!r}")
    if not target.is_file():
        raise ValueError(f"Project not found: {stem} (see hv_library_list(kind='canvas'))")
    return target


def _read_canvas_project(name: str) -> dict:
    target = _resolve_canvas_project(name)
    try:
        data = _json.loads(target.read_text(encoding="utf-8"))
    except _json.JSONDecodeError:
        raise ValueError(f"{target.name} is not valid .hv JSON.")
    if not isinstance(data.get("svg"), str) or "<svg" not in data["svg"].lower():
        raise ValueError(f"{target.name} is missing valid svg markup.")
    return data


_OPEN_PROJECT_JS = """(a) => new Promise((resolve) => {
    mountStageFromText(a.svg, a.name);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        editor.history = Array.isArray(a.history) ? a.history : [];
        editor.redo = Array.isArray(a.redo) ? a.redo : [];
        if (editor._renderHistory) editor._renderHistory();
        if (editor._updateButtons) editor._updateButtons();
        resolve({ name: a.name, historyLength: editor.history.length });
    }));
})"""


@mcp.tool()
async def hv_open_project(name: str) -> dict:
    """Open a saved .hv project by name (from hv_library_list(kind='canvas')) — restores
    the canvas markup AND its undo/redo history, same as clicking it in the Library's
    Canvas tab. Replaces whatever's currently open."""
    data = _read_canvas_project(name)
    return await _eval(_OPEN_PROJECT_JS, {"svg": data["svg"], "name": name,
                                           "history": data.get("history") or [],
                                           "redo": data.get("redo") or []})


@mcp.tool()
async def hv_save_project(name: str, overwrite: bool = False) -> dict:
    """Save the current document as a .hv project (markup + full undo history) under
    `name`, into the Library's Canvas tab — same as File ▸ Save project. `overwrite=True`
    replaces an existing project with the same name instead of auto-suffixing."""
    doc = await _eval(
        """() => ({
            svg: editor._historyMarkup ? editor._historyMarkup() : editor.serialize(),
            history: editor.history || [],
            redo: editor.redo || [],
        })"""
    )
    if not doc.get("svg"):
        raise ValueError("Nothing to save — no document is open.")
    return save_hv({"name": name, "svg": doc["svg"], "history": doc["history"],
                     "redo": doc["redo"], "overwrite": overwrite})


@mcp.tool()
async def hv_library_load(name: str, source: str, folder: str | None = None) -> dict:
    """Load a Library item by `name` and `source` (as returned by hv_library_list — one
    of "raster"/"vector"/"canvas"). A raster becomes the active workspace item (same as
    clicking it in the Library, ready for hv_pipeline_* once those exist); a vector output
    opens as the live document (pass its `folder` from hv_library_list too); a canvas
    opens as a full project (markup + history) — identical to hv_open_project."""
    if source == "canvas":
        return await hv_open_project(name)
    if source == "raster":
        return await _eval(
            """(a) => {
                window.app.selectedName = a.name;
                window.app.manualOutputName = null;
                return { ok: true, selectedName: a.name };
            }""",
            {"name": name},
        )
    if source == "vector":
        target = (OUTPUTS_DIR / (folder or "") / Path(name).name).resolve()
        try:
            target.relative_to(OUTPUTS_DIR.resolve())
        except ValueError:
            raise ValueError(f"Item resolves outside the outputs folder: {name!r}")
        if not target.is_file():
            raise ValueError(f"Vector output not found: {name} (see hv_library_list(kind='vector'))")
        if target.suffix.lower() != ".svg":
            raise ValueError("hv_library_load(source='vector') only opens .svg outputs — a .png has nothing to edit as a document.")
        svg_text = target.read_text(encoding="utf-8")
        return await _eval(
            """(a) => { mountStageFromText(a.svg, a.name); return { ok: true, name: a.name }; }""",
            {"svg": svg_text, "name": name},
        )
    raise ValueError(f'source must be "raster", "vector", or "canvas", got {source!r}')


if __name__ == "__main__":
    mcp.run()
