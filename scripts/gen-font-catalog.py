#!/usr/bin/env python3
"""Regenerate assets/google-fonts-catalog.json — the browser build's font-search catalog.

Fetches https://fonts.google.com/metadata/fonts (Google's own public, keyless metadata endpoint —
the one fonts.google.com's own UI uses) and writes a slim [family, category, subsets[]] snapshot,
sorted by Google's popularity ranking. That endpoint has no CORS headers, so the browser can't
fetch it live; this script runs the fetch here instead and the result gets checked into the repo
as a static asset (src/ui/cloud-fonts.js reads it same-origin, no live dependency on Google at
runtime beyond the actual woff2 download when a font is picked).

Re-run this occasionally to pick up new/renamed families. No other input; no flags.
"""
import json
import urllib.request

SOURCE = "https://fonts.google.com/metadata/fonts"
OUT = "assets/google-fonts-catalog.json"
CATEGORY_MAP = {
    "Sans Serif": "sans-serif",
    "Serif": "serif",
    "Display": "display",
    "Handwriting": "handwriting",
    "Monospace": "monospace",
}


def main() -> None:
    with urllib.request.urlopen(SOURCE, timeout=30) as r:
        data = json.load(r)
    families = data["familyMetadataList"]
    families.sort(key=lambda f: f.get("popularity") or 99999)
    out = [
        [
            f["family"],
            CATEGORY_MAP.get(f["category"], "sans-serif"),
            [s for s in f.get("subsets", []) if s != "menu"],
        ]
        for f in families
    ]
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {len(out)} families to {OUT}")


if __name__ == "__main__":
    main()
