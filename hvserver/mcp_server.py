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
    (id, tag, fill, stroke) in z-order back-to-front. Use this to see what's already on
    the canvas before adding to or editing it."""
    return await _eval(
        """() => {
            const vb = editor.stage.viewBox.baseVal;
            const nodes = [...editor.stage.querySelectorAll(':scope > [data-hv-id]')]
                .map(n => ({
                    id: n.getAttribute('data-hv-id'), tag: n.tagName.toLowerCase(),
                    fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke'),
                }));
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
