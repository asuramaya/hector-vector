#!/usr/bin/env python3
"""Cheap face-count for analyzer gating: prints `faces=N`. opencv YuNet only.

    <venv-python> tools/detect_faces.py <image> <yunet.onnx>

Used by plan_image() to decide whether to OFFER face restoration. Detection runs on
a downscaled copy so it stays fast enough for the debounced auto-analyze.
"""
import sys

try:
    import cv2
except ImportError:
    print("faces=0")
    sys.exit(0)


def main() -> int:
    if len(sys.argv) < 3:
        print("faces=0")
        return 0
    img = cv2.imread(sys.argv[1])
    if img is None:
        print("faces=0")
        return 0
    h, w = img.shape[:2]
    s = 1024.0 / max(h, w) if max(h, w) > 1024 else 1.0
    if s < 1.0:
        img = cv2.resize(img, (int(w * s), int(h * s)))
        h, w = img.shape[:2]
    det = cv2.FaceDetectorYN.create(sys.argv[2], "", (w, h), 0.7, 0.3, 50)
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    print(f"faces={0 if faces is None else len(faces)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
