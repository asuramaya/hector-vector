#!/usr/bin/env python3
"""Face restoration via GFPGAN v1.4 (ONNX, onnxruntime) — self-contained pipeline.

Invoked from server.py as:
    <venv-python> tools/face_restore.py <input> <output> --gfpgan <gfpgan.onnx> --detector <yunet.onnx>

The gfpgan pip package is unusable on modern torch/torchvision (basicsr imports the
removed torchvision.transforms.functional_tensor), so we run GFPGAN as ONNX and supply
our own detect→align→restore→paste-back, mirroring facexlib's FaceRestoreHelper:
  1. YuNet (opencv) detects faces + 5 landmarks
  2. similarity-align each face to the 512² FFHQ template
  3. GFPGAN-ONNX restores the aligned crop
  4. inverse-warp + feathered blend back into the original (only the face region changes)

No torch — onnxruntime + opencv only. Prints '[k/total] step' progress lines.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

# facexlib's FFHQ 512 template: [left eye, right eye, nose, left mouth, right mouth]
FACE_TEMPLATE = np.array([
    [192.98138, 239.94708],
    [318.90277, 240.19360],
    [256.63416, 314.01935],
    [201.26117, 371.41043],
    [313.08905, 371.15118],
], dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser(description="GFPGAN face restoration (ONNX).")
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--gfpgan", required=True, type=Path)
    ap.add_argument("--detector", required=True, type=Path)
    args = ap.parse_args()
    for p in (args.input, args.gfpgan, args.detector):
        if not p.exists():
            print(f"error: not found: {p}", file=sys.stderr)
            return 2

    print("[1/4] load onnxruntime + GFPGAN + detector", flush=True)
    try:
        import onnxruntime as ort
    except ImportError as exc:
        print(f"error: onnxruntime not installed ({exc})", file=sys.stderr)
        return 3
    bgr = cv2.imread(str(args.input), cv2.IMREAD_COLOR)
    if bgr is None:
        print(f"error: could not read image: {args.input}", file=sys.stderr)
        return 2
    h, w = bgr.shape[:2]
    det = cv2.FaceDetectorYN.create(str(args.detector), "", (w, h), 0.6, 0.3, 50)
    det.setInputSize((w, h))
    sess = ort.InferenceSession(str(args.gfpgan), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name

    print("[2/4] detect faces", flush=True)
    _, faces = det.detect(bgr)
    if faces is None or len(faces) == 0:
        print("no faces detected — writing original unchanged", flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(args.output), bgr)
        print(f"wrote {args.output} (faces=0)", flush=True)
        return 0

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    result = rgb.copy()
    # a feathered 512 mask so paste-back has no hard seams
    base_mask = np.ones((512, 512), np.float32)
    base_mask = cv2.erode(base_mask, np.ones((11, 11), np.uint8))
    base_mask = cv2.GaussianBlur(base_mask, (0, 0), sigmaX=12)

    print(f"[3/4] restore {len(faces)} face(s)", flush=True)
    for f in faces:
        # YuNet landmark cols: 4,5 right-eye  6,7 left-eye  8,9 nose  10,11 right-mouth  12,13 left-mouth
        src = np.array([[f[6], f[7]], [f[4], f[5]], [f[8], f[9]],
                        [f[12], f[13]], [f[10], f[11]]], dtype=np.float32)
        M, _ = cv2.estimateAffinePartial2D(src, FACE_TEMPLATE, method=cv2.LMEDS)
        if M is None:
            continue
        aligned = cv2.warpAffine(rgb, M, (512, 512), flags=cv2.INTER_LINEAR)
        inp = ((aligned / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None].astype(np.float32)
        out = sess.run(None, {in_name: inp})[0][0]                 # 3,512,512 in [-1,1]
        restored = np.clip((out.transpose(1, 2, 0) * 0.5 + 0.5), 0, 1) * 255.0
        # inverse-warp the restored face + its feather mask back into the full image
        M_inv = cv2.invertAffineTransform(M)
        back = cv2.warpAffine(restored, M_inv, (w, h), flags=cv2.INTER_LINEAR)
        mask = cv2.warpAffine(base_mask, M_inv, (w, h), flags=cv2.INTER_LINEAR)[..., None]
        result = result * (1.0 - mask) + back * mask

    print("[4/4] write output", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    out_bgr = cv2.cvtColor(np.clip(result, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    cv2.imwrite(str(args.output), out_bgr)
    print(f"wrote {args.output} (faces={len(faces)})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
