#!/usr/bin/env python3
"""AI background removal via rembg.

Invoked from server.py as:
    <venv-python> tools/ai_cutout.py <input> <output> [--model MODEL] [--alpha-matting]

Stdout: one '[k/total] step-name' line per phase so the host can stream progress.
Models supported (downloaded on first use into ~/.u2net):
  u2net                 — default, 175MB, general subjects
  u2netp                — 5MB, faster/lighter
  u2net_human_seg       — humans only
  isnet-general-use     — ~170MB, sharper than u2net for general
  birefnet-general      — ~440MB, current OSS SOTA quality
  birefnet-general-lite — smaller BiRefNet
  birefnet-portrait     — portrait-tuned
  silueta               — quantized U²-Net (~40MB)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="AI background removal (rembg).")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", default="u2net")
    parser.add_argument(
        "--alpha-matting",
        action="store_true",
        help="Refine edges using alpha matting. Slower, better hair/edges.",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    print(f"[1/3] load rembg + model: {args.model}", flush=True)
    try:
        from rembg import new_session, remove  # type: ignore
    except ImportError as exc:
        print(f"error: rembg not installed in this interpreter ({exc})", file=sys.stderr)
        return 3

    session = new_session(model_name=args.model)

    print("[2/3] read input", flush=True)
    data = args.input.read_bytes()

    print(f"[3/3] segment ({args.input.name})", flush=True)
    kwargs = {}
    if args.alpha_matting:
        kwargs.update({
            "alpha_matting": True,
            "alpha_matting_foreground_threshold": 240,
            "alpha_matting_background_threshold": 20,
            "alpha_matting_erode_size": 10,
        })
    result = remove(data, session=session, **kwargs)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    print(f"wrote {args.output}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
