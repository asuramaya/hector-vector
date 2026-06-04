"""Image analyzer + processing planner — the "knows how to process without being told"
brain. Pure numpy/PIL, milliseconds, offline, deterministic. No model, no LLM.

Two stages:
  analyze(path) -> dict    cheap signals: content class, palette, edges, degradation
                           (JPEG blocking / noise / blur), alpha, resolution.
  plan(analysis) -> dict   an AFFORDANCE-only processing chain (what the image
                           obviously NEEDS) + a list of OFFERED steps (what you might
                           WANT but the pixels can't decide — cutout, photo→vector).

Design line (the "is vs want" boundary): the auto-plan only includes steps the image
itself justifies — de-JPEG if it's blocky, denoise if it's noisy, upscale if it's
low-res, vectorize if it's clearly a graphic in a vector editor. Cutout and stylistic
conversions are OFFERED, never auto-applied, because intent isn't in the image.

Generalizes server.py's trace-only suggest_trace_settings into a cross-capability
detector. The model ids referenced in a plan are the router's *intent* — availability
(install state) is layered on by the caller.
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image

# Native crop the degradation metrics run on — must be native-scale so the JPEG 8px grid
# survives; centre crop keeps it cheap on huge inputs.
_DEG_CROP = 512
_STAT_DIM = 256          # downscale for colour/palette/edge stats (fast, scale-robust)


def _flatten_rgb(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def _has_alpha(path: Path) -> bool:
    im = Image.open(path)
    if im.mode not in ("RGBA", "LA", "PA") and "transparency" not in im.info:
        return False
    a = np.asarray(im.convert("RGBA"))[..., 3]
    return bool((a < 250).mean() > 0.01)        # >1% non-opaque = meaningful alpha


def _luma(arr: np.ndarray) -> np.ndarray:
    return 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]


def _center_crop_native(rgb: Image.Image, n: int) -> np.ndarray:
    w, h = rgb.size
    if w <= n and h <= n:
        a = np.asarray(rgb, np.float32)
    else:
        l, t = max(0, (w - n) // 2), max(0, (h - n) // 2)
        a = np.asarray(rgb.crop((l, t, min(w, l + n), min(h, t + n))), np.float32)
    return _luma(a)


def _jpeg_blockiness(luma: np.ndarray) -> float:
    """Ratio of mean abs gradient ON the 8px block grid vs OFF it. ~1.0 = clean; >1.15
    = visible JPEG blocking. Boundary between pixel i|i+1 is diff index i, so the grid
    sits at i%8 == 7."""
    if luma.shape[1] < 16 or luma.shape[0] < 16:
        return 1.0
    dh = np.abs(np.diff(luma, axis=1)); ch = np.arange(dh.shape[1]) % 8 == 7
    dv = np.abs(np.diff(luma, axis=0)); cv = np.arange(dv.shape[0]) % 8 == 7
    on = (dh[:, ch].mean() + dv[cv, :].mean())
    off = (dh[:, ~ch].mean() + dv[~cv, :].mean()) + 1e-6
    return float(on / off)


def _noise_sigma(luma: np.ndarray) -> float:
    """Immerkaer's fast noise estimate — a Laplacian mask that cancels smooth structure
    and most edges, leaving noise. Returns an approx sigma in 0–255 units."""
    H, W = luma.shape
    if H < 5 or W < 5:
        return 0.0
    a = luma
    c = (a[:-2, :-2] - 2 * a[:-2, 1:-1] + a[:-2, 2:]
         - 2 * a[1:-1, :-2] + 4 * a[1:-1, 1:-1] - 2 * a[1:-1, 2:]
         + a[2:, :-2] - 2 * a[2:, 1:-1] + a[2:, 2:])
    return float(np.abs(c).sum() * np.sqrt(np.pi / 2) / (6 * (W - 2) * (H - 2)))


def _blur_ratio(luma: np.ndarray) -> float:
    """Variance of the 4-neighbour Laplacian normalised by image contrast. Low = soft/
    out-of-focus; high = crisp. Normalising by luma variance makes it contrast-robust."""
    if luma.shape[0] < 3 or luma.shape[1] < 3:
        return 1.0
    lap = (-4 * luma[1:-1, 1:-1] + luma[:-2, 1:-1] + luma[2:, 1:-1]
           + luma[1:-1, :-2] + luma[1:-1, 2:])
    return float(lap.var() / (luma.var() + 1e-6))


def analyze(path: Path) -> dict:
    path = Path(path)
    rgb = _flatten_rgb(path)
    w, h = rgb.size
    max_dim = max(w, h)
    mp = (w * h) / 1e6

    # --- colour / palette / edge stats on a fast downscaled copy ---
    s = rgb.copy(); s.thumbnail((_STAT_DIM, _STAT_DIM), Image.Resampling.LANCZOS)
    arr = np.asarray(s, np.float32)
    px_chroma = arr.max(2) - arr.min(2)
    chroma = float(px_chroma.mean())
    colorful_frac = float((px_chroma > 60).mean())
    q = s.quantize(colors=32, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    frac = np.bincount(np.asarray(q).ravel(), minlength=32).astype(np.float32)
    frac = frac / max(1.0, frac.sum())
    significant = int((frac > 0.02).sum())
    top6 = float(np.sort(frac)[::-1][:6].sum())
    luma_s = _luma(arr)
    if luma_s.shape[0] >= 2 and luma_s.shape[1] >= 2:   # np.gradient needs ≥2 per axis;
        gy, gx = np.gradient(luma_s)                    # a 1px-wide/tall input has no edges
        edge_frac = float((np.hypot(gx, gy) > 24).mean())
    else:
        edge_frac = 0.0
    extremes = float(((luma_s < 48) | (luma_s > 208)).mean())
    near_binary = chroma < 40 and extremes > 0.82

    # --- degradation on a NATIVE-scale centre crop (preserves the JPEG grid) ---
    luma_n = _center_crop_native(rgb, _DEG_CROP)
    blockiness = _jpeg_blockiness(luma_n)
    noise = _noise_sigma(luma_n)
    blur = _blur_ratio(luma_n)

    # --- content class (mirrors the validated suggest_trace_settings split) ---
    if colorful_frac < 0.03:
        content = "line_art" if near_binary else "photo_gray"
    elif significant <= 6:
        content = "flat_graphic"
    else:
        content = "photo"

    return {
        "width": w, "height": h, "max_dim": max_dim, "megapixels": round(mp, 2),
        "low_res": max_dim < 700 or mp < 0.3,
        "has_alpha": _has_alpha(path),
        "content_class": content,
        "color": {"chroma": round(chroma, 1), "colorful_frac": round(colorful_frac, 3),
                  "significant_colors": significant, "top6_coverage": round(top6, 3)},
        "edge_frac": round(edge_frac, 3),
        "near_binary": near_binary,
        "degradation": {"jpeg_blockiness": round(blockiness, 3),
                        "noise_sigma": round(noise, 2),
                        "blur_ratio": round(blur, 4)},
        "is_jpeg": path.suffix.lower() in (".jpg", ".jpeg"),
    }


# ---- thresholds (one place to tune) ----
T_BLOCKY = 1.18
T_NOISE = 3.2
T_BLUR_SOFT = 0.015      # below = soft/blurry (offer deblur, don't auto-apply)


def plan(a: dict) -> dict:
    """Compose the affordance-only auto chain + the offered (intent) steps from analysis."""
    steps, offered, notes = [], [], []
    deg = a["degradation"]
    content = a["content_class"]
    is_photo = content in ("photo", "photo_gray")
    is_graphic = content in ("flat_graphic", "line_art")

    # Decide the terminal vectorize step first — it changes whether an upscale is worth it.
    vec = None
    if content == "flat_graphic":
        k = max(2, min(8, a["color"]["significant_colors"]))
        vec = {"capability": "vectorize", "intent": "logo-flat", "model": "clean",
               "params": {"color_precision": k, "trace_simplify": "medium"}, "weight": "cheap",
               "why": f"Flat graphic, {a['color']['significant_colors']} dominant colours → Clean engine, {k} colours."}
    elif content == "line_art":
        vec = {"capability": "vectorize", "intent": "bw-silhouette", "model": "vtracer",
               "params": {"trace_colormode": "bw", "trace_simplify": "medium"}, "weight": "cheap",
               "why": "Near-2-tone → B&W silhouette trace."}

    # 1. de-JPEG — only when the 8px grid is actually ringing
    if deg["jpeg_blockiness"] > T_BLOCKY:
        steps.append({"capability": "dejpeg", "intent": "default", "model": "fbcnn", "weight": "heavy",
                      "why": f"JPEG 8px blocking detected (ratio {deg['jpeg_blockiness']})."})

    # 2. denoise — PHOTO ONLY. Flat/line art reads 'noisy' to Immerkaer because of AA fringe;
    #    the right fix there is palette quantisation (the trace engine), not a denoiser.
    if is_photo and deg["noise_sigma"] > T_NOISE:
        steps.append({"capability": "denoise", "intent": "blind", "model": "scunet", "weight": "heavy",
                      "why": f"Noise estimate σ≈{deg['noise_sigma']} above clean floor."})

    # 3. upscale — low-res IS a true affordance, but a pre-vectorize upscale is wasted:
    #    vector output is resolution-independent, so only upscale when the result stays raster.
    if a["low_res"] and vec is None:
        model, intent = ("realesrgan-x4plus", "photo")
        steps.append({"capability": "upscale", "intent": intent, "model": model,
                      "params": {"scale": "4"}, "weight": "heavy",
                      "why": f"Low resolution ({a['max_dim']}px) — {intent} upscale ×4."})
    elif a["low_res"] and vec is not None:
        notes.append(f"low-res ({a['max_dim']}px) but terminal is vectorize → upscale skipped (resolution-independent)")

    # 4. vectorize — the app-context affordance, ONLY for clear graphics/line art.
    if vec is not None:
        steps.append(vec)
    elif is_photo:
        offered.append({"capability": "vectorize", "intent": "colour-photo", "model": "vtracer",
                        "why": "Could vectorize as a colour/photo trace (stylistic — not auto)."})

    # 5. wants the pixels can't decide → always offered, never auto
    if not a["has_alpha"]:
        offered.append({"capability": "cutout", "intent": "general", "model": "birefnet-general",
                        "why": "Remove background (intent-dependent — offered)."})
    # deblur is PHOTO ONLY — blur_ratio is unstable on flat art (low Laplacian + low contrast).
    if is_photo and deg["blur_ratio"] < T_BLUR_SOFT:
        offered.append({"capability": "deblur", "intent": "default", "model": "nafnet",
                        "why": f"Looks soft (blur ratio {deg['blur_ratio']}) — deblur if intended."})
        notes.append("soft/low-detail")

    summary = " → ".join(s["capability"] for s in steps) or "(no automatic processing)"
    return {"auto": steps, "offered": offered, "notes": notes, "summary": summary}


def _main(folder: str) -> None:
    import sys
    paths = sorted(Path(folder).iterdir())
    for p in paths:
        if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
            continue
        try:
            a = analyze(p)
            pl = plan(a)
        except Exception as exc:                         # noqa: BLE001
            print(f"{p.name[:38]:40} ERROR {exc}")
            continue
        d = a["degradation"]
        tag = f"{a['content_class']:12} {a['max_dim']:>5}px a={int(a['has_alpha'])} " \
              f"blk={d['jpeg_blockiness']:.2f} noi={d['noise_sigma']:.1f} blr={d['blur_ratio']:.3f}"
        print(f"{p.name[:38]:40} {tag}")
        print(f"{'':40} AUTO: {pl['summary']}")
        for s in pl["auto"]:
            print(f"{'':44} • {s['capability']}/{s['intent']} ({s['weight']}) — {s['why']}")
        if pl["offered"]:
            print(f"{'':44} offer: {', '.join(o['capability'] for o in pl['offered'])}")


if __name__ == "__main__":
    import sys
    _main(sys.argv[1] if len(sys.argv) > 1 else "inputs")
