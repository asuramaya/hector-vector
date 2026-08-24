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
from typing import Any

from hvserver.paths import AGENT_PORT_FILE

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
# Persistence
# ---------------------------------------------------------------------------


@mcp.tool()
async def hv_export_svg() -> str:
    """The current document's full SVG source, ready to hand back to a caller or write to
    a file. Ground truth — if you need to double-check exactly what a sequence of tool
    calls produced, this is more reliable than reasoning about it from the calls alone."""
    return await _eval("() => editor.stage.outerHTML")


if __name__ == "__main__":
    mcp.run()
