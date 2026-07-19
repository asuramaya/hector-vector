"""EPS export (Epic O.2): convert an exported SVG to EPS, server-side.

cairosvg has no direct svg2eps — EPS gets built as PDF (the existing, already-verified
Epic O.1 path: cairosvg + client-side text-outlining for font fidelity) plus one more hop
through Ghostscript's `eps2write` device, which turns a single-page PDF into a clean, valid
EPS. This deliberately reuses svg_to_pdf_bytes rather than a second, independent SVG-to-EPS
renderer that could silently disagree with the PDF path on gradients/masks/filters/fonts —
same reasoning export_pdf.py's own docstring gives for not re-deriving PNG's render path.

Ghostscript is a real system binary, not a pip package like cairosvg — standard on most
Linux distros (`apt install ghostscript`) and installable via brew/choco elsewhere. Same
treatment as cairosvg: resolved lazily via PATH, a plain actionable error if missing, no
AI-tools install-registry entry (this is ordinary system software, not a model download).
"""
from __future__ import annotations

import base64
import shutil
import subprocess
import tempfile
from pathlib import Path

from hvserver.export_pdf import svg_to_pdf_bytes, validated_svg_and_bg

_GS_TIMEOUT = 30.0  # a single-page vector PDF converts in well under a second normally


def export_eps(payload: dict) -> dict:
    """{svg, background?} -> {eps_base64}."""
    svg_text, bg = validated_svg_and_bg(payload)
    pdf_bytes = svg_to_pdf_bytes(svg_text, bg)

    gs = shutil.which("gs")
    if not gs:
        raise ValueError(
            "EPS export needs Ghostscript — install it with `apt install ghostscript` "
            "(or `brew install ghostscript` on macOS, or from ghostscript.com on Windows) "
            "and restart the server."
        )
    with tempfile.TemporaryDirectory() as td:
        pdf_path = Path(td) / "in.pdf"
        eps_path = Path(td) / "out.eps"
        pdf_path.write_bytes(pdf_bytes)
        try:
            result = subprocess.run(
                [gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=eps2write",
                 f"-sOutputFile={eps_path}", str(pdf_path)],
                capture_output=True, timeout=_GS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            raise ValueError("Ghostscript timed out converting this document to EPS.")
        except OSError as exc:
            raise ValueError(f"Couldn't run Ghostscript: {exc}")
        if result.returncode != 0 or not eps_path.exists():
            err = (result.stderr or b"").decode("utf-8", "replace").strip()
            raise ValueError(f"Ghostscript couldn't convert this to EPS: {err or 'unknown error'}")
        eps_bytes = eps_path.read_bytes()
    if not eps_bytes:
        raise ValueError("EPS render produced no output.")
    return {"eps_base64": base64.b64encode(eps_bytes).decode("ascii")}
