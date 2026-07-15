#!/usr/bin/env python3
"""Every CSS custom property this stylesheet USES must be one it DEFINES.

The bug this exists to prevent, found 2026-07-13 while adding themes:

    .proc-auto { background: var(--paper, #fafafa); }

`--paper` was never declared. Anywhere. So that rule had been quietly painting a hardcoded
near-white for as long as it had existed, and no theme could ever move it — which is why the
suggestion block stayed a white card on a black app. Six more tokens were in the same state
(--panel, --hover, --field-bg, --border, --fg-muted, --danger). Somebody meant every one of them
to be themeable, wrote the var(), and never wrote the declaration.

A var() fallback is precisely what hides this: the page still renders, it just renders the wrong
thing, forever, and silently. The tell was --field-bg, whose fallback was #2a2a2e — a DARK value,
sitting in an app that had only ever had a light theme. Nobody could have spotted that by reading.

So two rules, both cheap, both static:

  1. Every var(--x) must have a matching `--x:` declaration.
  2. No COLOUR token may carry a fallback. Fallbacks are a safety net, and the safety net is the
     bug: a missing token should fail LOUDLY (the property drops, you see it) rather than quietly
     paint the light theme onto a dark one. Non-colour tokens are exempt and named below — a font
     stack and the window-controls-overlay insets are legitimately optional.

Run: python3 tests/test_css_tokens.py     (wired into ci.yml)
"""
import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "web" / "style.css"

# Tokens that are allowed to be absent, and therefore allowed a fallback. Both halves matter: these
# are the only ones exempt from BOTH rules below.
#   --ui-font ............ optional font-stack override; the fallback IS the design.
#   --wco-*-inset ........ set by the BROWSER, not by us, and only in a PWA window-controls-overlay
#                          titlebar. In a normal tab they are correctly undefined, and 0px is right.
OPTIONAL = {"--ui-font", "--wco-left-inset", "--wco-right-inset"}


def main() -> int:
    src = CSS.read_text()

    defined = set(re.findall(r"(--[a-zA-Z0-9-]+)\s*:", src))
    used = set(re.findall(r"var\(\s*(--[a-zA-Z0-9-]+)", src))

    missing = sorted(used - defined - OPTIONAL)
    with_fallback = sorted(
        {t for t in re.findall(r"var\(\s*(--[a-zA-Z0-9-]+)\s*,", src)} - OPTIONAL
    )

    ok = True
    if missing:
        ok = False
        print("FAIL: these custom properties are USED but never DEFINED.")
        print("      Each one is silently rendering its fallback — or nothing at all.")
        for t in missing:
            for i, line in enumerate(src.splitlines(), 1):
                if f"var({t}" in line or f"var( {t}" in line:
                    print(f"  {CSS.name}:{i}  {t}")
                    break
    if with_fallback:
        ok = False
        print("FAIL: these colour tokens carry a var() fallback.")
        print("      A fallback hides a missing token: the page renders, wrongly, forever, in silence.")
        print("      Define the token and drop the fallback.")
        for t in with_fallback:
            print(f"  {t}")

    if ok:
        print(f"ok: {len(used)} custom properties used, all {len(used)} defined; "
              f"no colour token hides behind a fallback")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
