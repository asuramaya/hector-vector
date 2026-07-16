"""PDF export (Epic O.1): convert an exported SVG to a real vector PDF, server-side, via
cairosvg — the one output format the browser genuinely can't produce on its own. Export PNG
stays fully client-side (a <canvas> rasterises the live SVG — no cairosvg, see
[[export-client-side-render]]) because that reuses the browser's OWN paint pipeline instead
of a second, different renderer that could silently disagree on gradients/masks/filters
(see tools/svg_render.py's own docstring for why that swap was rejected there too). PDF is
different: there is no browser API that turns an SVG into real PDF vector drawing commands
(as opposed to a rasterised page), so this is the one place server-side conversion earns
its keep.

cairosvg is an EXISTING optional dependency (tools/svg_render.py already uses it, for
rasterising vtracer's curved output) — imported lazily so a server without it still boots.
Missing it here is a plain, actionable ValueError, the same class svg_render.py's own
_render_cairosvg already raises for the identical library — this is a small, ordinary
pip package, not a multi-hundred-MB AI model, so it doesn't need the AI-tools install
registry's progress-bar UX (see hvserver/capabilities.py CAPABILITIES).
"""
from __future__ import annotations

import base64

from hvserver.paths import MAX_SVG_SAVE_BYTES


def export_pdf(payload: dict) -> dict:
    """{svg, background?} -> {pdf_base64}. background is transparent/white/black, same
    vocabulary as the Export modal's PNG path; cairosvg leaves the page transparent when
    it's omitted (PDF supports alpha, unlike a printed page, so this is a legitimate output,
    not just a preview convenience)."""
    svg_text = payload.get("svg")
    if not isinstance(svg_text, str) or "<svg" not in svg_text.lower():
        raise ValueError("Missing or invalid 'svg' markup.")
    if len(svg_text) > MAX_SVG_SAVE_BYTES:
        raise ValueError(f"SVG is too large to export (>{MAX_SVG_SAVE_BYTES // 1_000_000} MB).")
    bg = payload.get("background") or None
    if bg not in (None, "white", "black"):
        bg = None
    try:
        import cairosvg  # type: ignore
    except ImportError:
        raise ValueError(
            "PDF export needs cairosvg — install it with `.venv/bin/pip install cairosvg` "
            "(or `pip install cairosvg`; needs the system libcairo library) and restart the server."
        )
    try:
        pdf_bytes = cairosvg.svg2pdf(bytestring=svg_text.encode("utf-8"), background_color=bg)
    except Exception as exc:  # noqa: BLE001 — cairosvg raises its own assorted parse/render errors
        raise ValueError(f"Couldn't render this SVG to PDF: {exc}")
    if not pdf_bytes:
        raise ValueError("PDF render produced no output.")
    return {"pdf_base64": base64.b64encode(pdf_bytes).decode("ascii")}
