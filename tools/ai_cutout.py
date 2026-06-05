#!/usr/bin/env python3
"""AI background removal via rembg.

Invoked from server.py as:
    <venv-python> tools/ai_cutout.py <input> <output> [--model MODEL] [--alpha-matting]

Stdout: one '[k/total] step-name' line per phase so the host can stream progress.
Models supported (downloaded on first use into ~/.u2net; sizes verified via HEAD):
  u2net                 — default, 176MB, general subjects
  u2netp                — 5MB, faster/lighter
  u2net_human_seg       — humans only
  isnet-general-use     — ~170MB, sharper than u2net for general
  birefnet-general      — 928MB, current OSS SOTA quality
  birefnet-general-lite — 214MB swin-tiny BiRefNet (much lighter)
  birefnet-portrait     — 928MB, portrait-tuned
  birefnet-hrsod        — 928MB, high-resolution salient-object detail
  silueta               — quantized U²-Net (~40MB)

BYO-ONNX sessions (rembg's *_custom slots) need a local weight via --model-path:
  ben_custom            — BEN2 (Confidence-Guided Matting; hair/4K), --model-path <onnx>
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
        "--model-path",
        default=None,
        help="Local ONNX weight for a BYO-ONNX session (e.g. ben_custom). "
             "rembg requires it to live under the u2net home dir (~/.u2net).",
    )
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

    session_kwargs = {}
    if args.model_path:
        # BYO-ONNX slots (ben_custom/u2net_custom/dis_custom) take an explicit weight path.
        session_kwargs["model_path"] = args.model_path
    session = new_session(model_name=args.model, **session_kwargs)

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
