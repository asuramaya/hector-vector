#!/usr/bin/env python3
"""Object removal / cleanup via big-LaMa (ONNX, onnxruntime).

Invoked from server.py as:
    <venv-python> tools/inpaint_lama.py <input> <mask> <output> --model <lama.onnx>

LaMa erase-and-infills the region marked white in the mask (1 = remove). The
Carve/LaMa-ONNX export has a fixed 512×512 input, so we run at 512 and composite
the inpainted pixels back over the FULL-resolution original (unmasked areas keep
their original detail). onnxruntime only — no torch, no new deps.

Stdout: one '[k/total] step-name' line per phase so the host can stream progress.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SIZE = 512


def main() -> int:
    parser = argparse.ArgumentParser(description="LaMa object removal (ONNX).")
    parser.add_argument("input", type=Path)
    parser.add_argument("mask", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", required=True, type=Path)
    args = parser.parse_args()

    for p in (args.input, args.mask, args.model):
        if not p.exists():
            print(f"error: not found: {p}", file=sys.stderr)
            return 2

    print("[1/4] load onnxruntime + LaMa", flush=True)
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError as exc:
        print(f"error: onnxruntime/numpy/PIL not installed ({exc})", file=sys.stderr)
        return 3
    sess = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    # Map inputs by channel count: the 1-channel input is the mask, the 3-channel is the image.
    in_meta = sess.get_inputs()
    img_name = next(i.name for i in in_meta if i.shape[1] == 3)
    mask_name = next(i.name for i in in_meta if i.shape[1] == 1)

    print("[2/4] read input + mask", flush=True)
    img = Image.open(args.input).convert("RGB")
    w, h = img.size
    mask_full = Image.open(args.mask).convert("L")
    img512 = np.asarray(img.resize((SIZE, SIZE), Image.Resampling.LANCZOS), np.float32) / 255.0
    m512 = np.asarray(mask_full.resize((SIZE, SIZE), Image.Resampling.NEAREST), np.float32)
    m512 = (m512 > 127).astype(np.float32)
    img_t = img512.transpose(2, 0, 1)[None]                      # 1,3,512,512
    mask_t = m512[None, None]                                    # 1,1,512,512

    print("[3/4] inpaint", flush=True)
    out = sess.run(None, {img_name: img_t, mask_name: mask_t})[0][0]   # 3,512,512
    out = out.transpose(1, 2, 0)
    out = out / 255.0 if out.max() > 1.5 else out                # export may emit [0,255] or [0,1]
    out = np.clip(out, 0.0, 1.0)
    inpainted = Image.fromarray((out * 255.0 + 0.5).astype("uint8"), "RGB").resize((w, h), Image.Resampling.LANCZOS)

    print("[4/4] composite + write", flush=True)
    # Composite only the masked region back over the original at full resolution.
    comp_mask = mask_full.resize((w, h), Image.Resampling.NEAREST).point(lambda v: 255 if v > 127 else 0)
    result = Image.composite(inpainted, img, comp_mask)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output)
    print(f"wrote {args.output}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
