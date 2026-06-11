from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


ALPHA_THRESHOLD = 8


def estimate_background(gray: Image.Image) -> int:
    width, height = gray.size
    sample = max(8, min(width, height) // 12)
    boxes = [
        (0, 0, sample, sample),
        (width - sample, 0, width, sample),
        (0, height - sample, sample, height),
        (width - sample, height - sample, width, height),
    ]
    values = []
    for box in boxes:
        crop = gray.crop(box)
        values.append(int(sum(crop.getdata()) / max(1, len(crop.getdata()))))
    values.sort()
    return values[len(values) // 2]


def has_meaningful_alpha(rgba: Image.Image) -> bool:
    alpha = np.asarray(rgba.getchannel("A"))
    if alpha.max() <= ALPHA_THRESHOLD:
        return False
    if alpha.min() >= 250:
        return False
    coverage = float(np.count_nonzero(alpha >= ALPHA_THRESHOLD)) / float(alpha.size)
    border = np.concatenate([alpha[0, :], alpha[-1, :], alpha[:, 0], alpha[:, -1]])
    transparent_border = float(np.count_nonzero(border < 250)) / float(border.size)
    return coverage < 0.985 or transparent_border > 0.15


def otsu_threshold(values: np.ndarray) -> int:
    if values.size == 0:
        return 127
    hist = np.bincount(values, minlength=256).astype(np.float64)
    total = hist.sum()
    sum_total = np.dot(np.arange(256), hist)
    sum_bg = 0.0
    weight_bg = 0.0
    best_var = -1.0
    threshold = 127
    for i in range(256):
        weight_bg += hist[i]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += i * hist[i]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_total - sum_bg) / weight_fg
        between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if between > best_var:
            best_var = between
            threshold = i
    return threshold


def subject_mask_from_rgba(rgba: Image.Image) -> np.ndarray:
    rgba = rgba.convert("RGBA")
    gray_img = rgba.convert("L")
    gray = np.asarray(gray_img)
    alpha = np.asarray(rgba.getchannel("A"))

    if has_meaningful_alpha(rgba):
        solid = alpha >= ALPHA_THRESHOLD
        solid_values = gray[solid]
        if solid_values.size:
            threshold = max(64, min(208, otsu_threshold(solid_values)))
        else:
            threshold = 128
        return solid & (gray <= threshold)

    bg = max(estimate_background(gray_img), 64)
    threshold = max(96, int(bg * 0.85))
    mask = gray <= threshold
    if alpha.max() > ALPHA_THRESHOLD:
        mask &= alpha >= ALPHA_THRESHOLD
    return mask


def build_monochrome_assets(
    input_path: Path, mask_output: Path | None = None, cutout_output: Path | None = None
) -> np.ndarray:
    rgba = Image.open(input_path).convert("RGBA")
    mask = subject_mask_from_rgba(rgba)
    mask_u8 = (mask.astype(np.uint8) * 255)

    if mask_output is not None:
        traced = Image.new("L", rgba.size, 255)
        traced.paste(0, mask=Image.fromarray(mask_u8, mode="L"))
        traced.save(mask_output)

    if cutout_output is not None:
        build_alpha_cutout_from_rgba(rgba, cutout_output)

    return mask


def build_alpha_cutout_from_rgba(rgba: Image.Image, output_path: Path) -> None:
    rgba = rgba.convert("RGBA")
    gray_img = rgba.convert("L")
    gray = np.asarray(gray_img, dtype=np.int16)

    bg = max(estimate_background(gray_img), 64)

    diff = np.clip(bg - gray, 0, 255).astype(np.float32)
    alpha = np.clip(diff * (255.0 / bg), 0, 255).astype(np.uint8)

    if has_meaningful_alpha(rgba):
        src_alpha = np.asarray(rgba.getchannel("A"))
        alpha = np.minimum(alpha, src_alpha)

    h, w = alpha.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., 3] = alpha
    Image.fromarray(out, mode="RGBA").save(output_path)


def build_alpha_cutout(input_path: Path, output_path: Path) -> None:
    rgba = Image.open(input_path).convert("RGBA")
    build_alpha_cutout_from_rgba(rgba, output_path)
