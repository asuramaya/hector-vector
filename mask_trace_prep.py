#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

from engine import build_monochrome_assets


def main() -> int:
    if len(sys.argv) == 3:
        build_monochrome_assets(Path(sys.argv[1]), mask_output=Path(sys.argv[2]))
        return 0
    if len(sys.argv) == 4:
        build_monochrome_assets(
            Path(sys.argv[1]), mask_output=Path(sys.argv[2]), cutout_output=Path(sys.argv[3])
        )
        return 0
    print("usage: mask_trace_prep.py INPUT MASK_OUTPUT [CUTOUT_OUTPUT]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
