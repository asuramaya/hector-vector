"""Text-feature server-side guards — no network, CI-friendly.

Locks in the dependency + logic contract the Text tool's "Convert to outlines" relies on. The
full browser e2e (editor_e2e.py "Text:" section, which downloads fonts + drives the canvas) stays
a local gate because it needs Playwright + the font CDNs; this file is the part that can run in CI.

Most important guard: fontTools + Brotli. text_to_outline reads the cached .woff2 fonts, and
DECODING woff2 needs Brotli — so requirements.txt pins `fonttools[woff]`. If that regresses,
convert-to-outlines 500s on a clean install; this test fails first.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # repo root → hvserver importable


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

# 1) The convert-to-outlines dependency chain: fontTools (shape/trace) + Brotli (woff2 decode).
try:
    from fontTools.ttLib import TTFont  # noqa: F401
    from fontTools.pens.qu2cuPen import Qu2CuPen  # noqa: F401
    import brotli  # noqa: F401  — required to DECODE the cached .woff2 fonts
    check("fontTools + Brotli importable (text->outlines deps)", True)
except Exception as e:  # noqa: BLE001
    check(f"fontTools + Brotli importable -> {e}", False)

# 2) The font service module imports cleanly.
from hvserver import fonts  # noqa: E402

# 3) System-font substitution: metric-compatible OFL stand-ins for outlining undownloadable faces.
check("Arial -> Arimo", fonts._font_substitute("Arial") == "Arimo")
check("Times New Roman -> Tinos", fonts._font_substitute("Times New Roman") == "Tinos")
check("Courier New -> Cousine", fonts._font_substitute("Courier New") == "Cousine")
check("serif generic -> Tinos", fonts._font_substitute("serif") == "Tinos")
check("unknown face -> no substitute", fonts._font_substitute("Totally Made Up Face") is None)

# 4) Complex-script detection (the guardrail used when uharfbuzz isn't installed).
check("Arabic detected", fonts._complex_script("مرحبا") == "Arabic")
check("Devanagari detected", fonts._complex_script("नमस्ते") == "Devanagari")
check("Hebrew detected", fonts._complex_script("שלום") == "Hebrew")
check("Latin is not complex", fonts._complex_script("hello world") is None)

# 5) Public text endpoints exist (contract the HTTP layer dispatches to).
for fn in ("text_to_outline", "font_catalog", "load_font", "installed_fonts"):
    check(f"hvserver.fonts.{fn} present", callable(getattr(fonts, fn, None)))

if check.failed:
    print("TEXT GUARD: FAIL")
    sys.exit(1)
print("TEXT GUARD: ok")
