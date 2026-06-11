#!/usr/bin/env python3
"""Universal super-resolution via spandrel.

Invoked from server.py as:
    <venv-python> tools/upscale_spandrel.py <input> <output> --model <checkpoint.pth> [--tile N]

spandrel loads almost any SR architecture (ESRGAN/Real-ESRGAN, DAT, SPAN, SwinIR,
HAT, Real-CUGAN, …) from a .pth/.safetensors checkpoint, so one loader covers the
whole model zoo (#54). The model's own scale is read from the checkpoint — no need
to pass it. Runs on CPU; large inputs are processed in overlapping tiles so memory
stays bounded regardless of image size.

Stdout: one '[k/total] step-name' line per phase so the host can stream progress.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Universal SR upscale (spandrel).")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", required=True, type=Path, help="Path to the SR checkpoint.")
    parser.add_argument("--tile", type=int, default=256,
                        help="Tile size in input px (0 = whole image). Overlap is added automatically.")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2
    if not args.model.exists():
        print(f"error: model not found: {args.model}", file=sys.stderr)
        return 2

    print(f"[1/4] load spandrel + model: {args.model.name}", flush=True)
    try:
        import numpy as np
        import torch
        from PIL import Image
        from spandrel import ModelLoader
    except ImportError as exc:
        print(f"error: spandrel/torch not installed in this interpreter ({exc})", file=sys.stderr)
        return 3

    device = torch.device("cpu")
    model = ModelLoader().load_from_file(str(args.model))
    model.to(device).eval()
    scale = getattr(model, "scale", 4) or 4

    print(f"[2/4] read input (scale ×{scale})", flush=True)
    img = Image.open(args.input).convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0          # H,W,C in [0,1]
    h, w, _ = arr.shape

    def run_tensor(t):                                       # t: [1,C,h,w] → [1,C,h*scale,w*scale]
        with torch.no_grad():
            # spandrel runs the model in InferenceMode → the result is an inference tensor;
            # clamp out-of-place (not clamp_) so we get a normal tensor we can copy from.
            return model(t).clamp(0.0, 1.0)

    print(f"[3/4] upscale ({w}×{h} → {w * scale}×{h * scale})", flush=True)
    tile = args.tile
    if tile and (h > tile or w > tile):
        overlap = 16                                         # context margin fed to the model, then cropped (hides tile seams)
        out = np.zeros((h * scale, w * scale, 3), dtype=np.float32)
        for y in range(0, h, tile):
            for x in range(0, w, tile):
                y0, x0 = max(0, y - overlap), max(0, x - overlap)
                y1, x1 = min(h, y + tile + overlap), min(w, x + tile + overlap)
                patch = arr[y0:y1, x0:x1, :]
                t = torch.from_numpy(patch.transpose(2, 0, 1)).unsqueeze(0).to(device)
                up = run_tensor(t)[0].cpu().numpy().transpose(1, 2, 0)
                # crop the overlap margin back off, in output coordinates
                ty, tx = (y - y0) * scale, (x - x0) * scale
                cy, cx = min(tile, h - y) * scale, min(tile, w - x) * scale
                out[y * scale:y * scale + cy, x * scale:x * scale + cx, :] = up[ty:ty + cy, tx:tx + cx, :]
    else:
        t = torch.from_numpy(arr.transpose(2, 0, 1)).unsqueeze(0).to(device)
        out = run_tensor(t)[0].cpu().numpy().transpose(1, 2, 0)

    print("[4/4] write output", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((out * 255.0 + 0.5).clip(0, 255).astype("uint8"), "RGB").save(args.output)
    print(f"wrote {args.output}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
