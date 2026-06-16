"""Pipeline layer (#29 split): the multi-stage process orchestration + the analyzer
endpoints. _stage_on/_pipeline_stages/_pipeline_summary (stage parsing), suggest_trace_settings
+ plan_image (the classical analyze→plan brain's HTTP surface), trace_preview (live one-shot
vectorize), and run_pipeline (the batch/focused executor that chains restore→upscale→cutout→
vectorize across the selected inputs as queued internal jobs).

Top of the compute stack: imports engines (vectorize_svg + trace/mask config + validators),
models (build_* + ensure_tools_ready + detect_face_count + SR_MODELS/RESTORE_STAGE_MODELS +
_skip_message), files (select_inputs/output_dir/_safe_stem/resolve_source_url/is_pipeline_processed),
jobs (run_subprocess/_report_progress/launch_internal_job/_register_output/log_subprocess_lines/
_prune_focused_pipeline_dirs), paths, and the external analyze brain. Only the HTTP handler sits
above it. Re-exported behind the server facade.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image

import analyze   # noqa: E402  (classical analyze→plan brain; resolved via paths' sys.path insert)

from hvserver.paths import REALESRGAN_BIN, REALESRGAN_DIR
from hvserver.jobs import (
    run_subprocess, _report_progress, launch_internal_job, _register_output,
    log_subprocess_lines, _prune_focused_pipeline_dirs,
)
from hvserver.models import (
    build_ai_cutout, build_upscale_spandrel, ensure_tools_ready, _skip_message,
    detect_face_count, SR_MODELS, RESTORE_STAGE_MODELS,
)
from hvserver.files import (
    select_inputs, output_dir, _safe_stem, resolve_source_url, is_pipeline_processed,
)
from hvserver.engines import (
    vectorize_svg, trace_config, mask_config, derive_mask_from_alpha,
    build_mask_with_overrides, clean_color_trace, validate_svg_file,
    validate_cutout_png, validate_mask_png, VECTORIZE_ENGINES,
    deterministic_upscale, source_has_alpha,
)


def _stage_on(value: object) -> bool:
    """Coerce a stage flag (JSON bool, or a stringy "true"/"1"/"on") to bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return False


def _pipeline_stages(payload: dict) -> dict:
    """Resolve the enabled stages + their methods from a pipeline payload.

    A payload with NO `stage_*` keys is the classic all-three Production SVG
    pipeline (back-compat for `/api/run/pipeline` callers that predate the strip).
    Methods fall back to the legacy single-purpose settings so an old payload
    still routes the way it used to."""
    stage_keys = ("stage_upscale", "stage_removebg", "stage_vectorize",
                  "stage_dejpeg", "stage_denoise", "stage_deblur")
    explicit = any(k in payload for k in stage_keys)
    up = _stage_on(payload.get("stage_upscale")) if explicit else True
    rb = _stage_on(payload.get("stage_removebg")) if explicit else True
    vec = _stage_on(payload.get("stage_vectorize")) if explicit else True
    # Restoration stages default OFF (legacy all-three payloads had no concept of them).
    fixes = {sid: _stage_on(payload.get(f"stage_{sid}")) for sid in RESTORE_STAGE_MODELS}

    rb_method = (payload.get("removebg_method") or "").strip().lower()
    if rb_method not in ("classical", "ai", "green"):
        rb_method = "ai" if (payload.get("cutout_backend") == "ai") else "classical"
    vec_method = (payload.get("vectorize_method") or "").strip().lower()
    if vec_method not in ("trace", "pixel"):
        vec_method = "pixel" if (payload.get("trace_mode") == "pixel") else "trace"
    return {"upscale": up, "removebg": rb, "vectorize": vec,
            "removebg_method": rb_method, "vectorize_method": vec_method, **fixes}


def _pipeline_summary(name: str, st: dict) -> str:
    parts = []
    for sid, label in (("dejpeg", "De-JPEG"), ("denoise", "Denoise"), ("deblur", "Deblur")):
        if st.get(sid):
            parts.append(label)
    if st["upscale"]:
        parts.append("Upscale")
    if st["removebg"]:
        parts.append({"green": "Greenscreen", "ai": "AI cutout"}.get(st["removebg_method"], "Cutout"))
    if st["vectorize"]:
        parts.append("Pixel trace" if st["vectorize_method"] == "pixel" else "Trace")
    return f"{' + '.join(parts) or 'Pipeline'} {name}"


# (#29 engines layer -> hvserver/engines.py: clean_color_trace + raster ops + VECTORIZE_ENGINES dispatch)
# (capabilities taxonomy + router resolution extracted -> hvserver/capabilities.py)

def suggest_trace_settings(payload: dict) -> dict:
    """T1 "Auto": recommend vectorize settings from cheap image statistics — no
    model, milliseconds, pure numpy/PIL. Mirrors what a human does eyeballing the
    image: silhouette vs colour, flat poster art vs photographic gradients, and how
    many colours to keep. The client fills the panel from this; the user can still
    override. (A VLM recommender or a neural vectorizer would be the heavier T2/T3.)"""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image.")
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    rgb = bg.convert("RGB")
    rgb.thumbnail((200, 200), Image.Resampling.LANCZOS)   # downscale for fast stats
    arr = np.asarray(rgb, dtype=np.float32)
    px_chroma = arr.max(2) - arr.min(2)                       # per-pixel saturation
    chroma = float(px_chroma.mean())                          # mean colourfulness 0–255
    # A MINORITY saturated colour (e.g. a red logo on B/W) barely moves the mean, so
    # also measure the SHARE of vivid pixels — that's what says "this needs colour".
    colorful_frac = float((px_chroma > 60).mean())
    # palette: median-cut to 32, how many colours actually hold real estate
    q = rgb.quantize(colors=32, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    frac = np.bincount(np.asarray(q).ravel(), minlength=32).astype(np.float32)
    frac = frac / max(1.0, frac.sum())
    significant = int((frac > 0.02).sum())                    # colours with >2% of pixels
    top6 = float(np.sort(frac)[::-1][:6].sum())               # coverage of the 6 biggest
    luma = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    gy, gx = np.gradient(luma)
    edge_frac = float((np.hypot(gx, gy) > 24).mean())         # share of hard-edge pixels
    near_binary = image_is_near_binary(src)
    has_alpha = source_has_alpha(src)

    if colorful_frac < 0.03:
        # No real colour: a 2-tone logo → B&W silhouette; a grayscale photo → photo
        # mode (it traces the gray levels; a silhouette would flatten the tones).
        if near_binary:
            out = {"engine": "vtracer", "trace_colormode": "bw", "trace_simplify": "medium"}
            reason = "Near-2-tone grayscale → B&W silhouette trace."
        else:
            simplify = "medium" if edge_frac > 0.2 else "light"
            out = {"engine": "vtracer", "trace_colormode": "color", "trace_color_style": "photo",
                   "color_precision": 6, "trace_simplify": simplify}
            reason = f"Grayscale, multi-tone → Colour · Photo · 6 levels · simplify {simplify}."
    else:
        # Real colour present. Few dominant colours → flat poster art; many → photo.
        # (Lean on the dominant-colour COUNT, not top-N coverage — AA fringe spreads a
        #  flat logo's 3 colours across many near-duplicate palette bins.)
        if significant <= 6:
            k = max(2, min(8, significant))
            out = {"engine": "clean", "trace_colormode": "color", "trace_color_style": "clean",
                   "color_precision": k, "trace_simplify": "medium"}
            reason = (f"Flat colour logo — {significant} dominant colours "
                      f"→ Clean engine (planar, no halos) · {k} colours · simplify medium.")
        else:
            simplify = "medium" if edge_frac > 0.2 else "light"
            out = {"engine": "vtracer", "trace_colormode": "color", "trace_color_style": "photo",
                   "color_precision": 6, "trace_simplify": simplify}
            reason = f"Photographic / gradient-rich ({significant} colours) → Colour · Photo · 6 colours · simplify {simplify}."
    out["vectorize_method"] = "trace"
    out["reason"] = reason
    out["stats"] = {"chroma": round(chroma, 1), "colorful_frac": round(colorful_frac, 3),
                    "significant_colors": significant, "top6_coverage": round(top6, 3),
                    "edge_frac": round(edge_frac, 3), "near_binary": near_binary, "has_alpha": has_alpha}
    return out


def plan_image(payload: dict) -> dict:
    """The auto-routing brain for a selected raster: classical analysis → an
    affordance-only processing plan + offered (intent) steps. No model, no LLM,
    deterministic (see tools/analyze.py and [[auto-routing-classical-not-vlm]]).
    The client drives the Auto-pipeline surface from this; the user can override.
    Model ids in the plan are intent — availability/fallback is layered by the caller."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image to analyze.")
    a = analyze.analyze(src)
    pl = analyze.plan(a)
    # Resolve each router decision against the capability registry → availability +
    # the invoke params the executor will use. Lets the UI show "needs install" / route
    # to an installed fallback instead of proposing a model that isn't there.
    for step in pl.get("auto", []) + pl.get("offered", []):
        info = resolve_capability_step(step.get("capability"), step.get("model"))
        if info:
            step["available"] = info["available"]
            step["needs"] = info["needs"]
            step["invoke"] = info["invoke"]
            if info.get("size_mb"):
                step["size_mb"] = info["size_mb"]
    # Face-restore is OFFERED (never auto) only when a face is actually present — the gate
    # the pixels can decide. Photographic content only (a flat graphic won't have a face).
    if a["content_class"] in ("photo", "photo_gray", "screenshot"):
        faces = detect_face_count(src)
        if faces > 0:
            step = {"capability": "face", "intent": "restore", "model": "gfpgan",
                    "why": f"{faces} face{'s' if faces != 1 else ''} detected — restore if low-quality."}
            info = resolve_capability_step("face", "gfpgan")
            if info:
                step["available"] = info["available"]
                step["needs"] = info["needs"]
                step["invoke"] = info["invoke"]
            pl["offered"].append(step)
    return {"analysis": a, "plan": pl}


def trace_preview(payload: dict) -> dict:
    """SYNCHRONOUS, resolution-capped vectorize for the raster panel's LIVE preview.
    Resolves the selected canvas raster (`input_url`) and runs it through the single
    `vectorize_svg` dispatch (same engine the commit/pipeline uses → no drift),
    returning SVG text directly. No job, no saved output. The cap keeps each trace
    fast enough to drive a debounced live preview as the user drags sliders."""
    src = resolve_source_url(payload.get("input_url", ""))
    if src is None:
        raise ValueError("Could not resolve the source image for preview.")
    cap = max(64, min(2048, int(payload.get("preview_max_dim") or TRACE_PREVIEW_DIM)))
    svg_text = vectorize_svg(src, payload, max_dim=cap)
    return {"svg": svg_text, "nodes": len(re.findall(r"[MLCZ]", svg_text)), "capped": cap}


def run_pipeline(payload: dict) -> dict:
    """Generalized pipeline: upscale → remove-bg → vectorize, each stage
    independently toggleable. The 6 old processes are just stage subsets of this
    one route (see `_pipeline_stages`). Disabled trailing stages early-stop the
    job at a PNG; the legacy single-purpose endpoints remain for back-compat."""
    st = _pipeline_stages(payload)
    up, rb, vec = st["upscale"], st["removebg"], st["vectorize"]
    rb_method, vec_method = st["removebg_method"], st["vectorize_method"]
    active_fixes = [sid for sid in RESTORE_STAGE_MODELS if st.get(sid)]   # dejpeg/denoise/deblur, in flow order
    if not (up or rb or vec or active_fixes):
        return {"message": "Enable at least one pipeline stage.", "started": 0, "skipped": []}

    model = payload.get("model", "realesrgan-x4plus")
    scale = int(payload.get("scale", "4"))
    cutout_model = (payload.get("cutout_model") or "u2net").strip()
    alpha_matting = bool(payload.get("alpha_matting"))
    trace = trace_config(payload)
    mask_cfg = mask_config(payload)
    pv_cfg = pixelvec_config(payload)

    # Fail fast on missing prerequisites for the stages that are actually on.
    if vec and vec_method == "trace":
        ensure_tools_ready("vtracer")
    if rb and rb_method == "ai" and not rembg_installed():
        raise ValueError("AI cutout requested but rembg is not installed. Install it from Settings, or use the classical method.")
    if (active_fixes or (up and model in SR_MODELS)) and not spandrel_installed():
        raise ValueError("This pipeline needs spandrel (denoise/de-JPEG/deblur or a spandrel upscale model). Install it from Settings.")

    # Skip-detection is stage-aware: skip a discovered image only when THIS
    # stage-set's terminal output already exists (see is_pipeline_processed).
    # Explicit selections (single mode) and input_path bypass skip by contract —
    # the client guards those — so we only filter the discover branch here.
    targets, _ = select_inputs(payload)
    skipped: list[str] = []
    explicit = bool(payload.get("inputs")) or bool(payload.get("input_path", "").strip()) \
        or bool(payload.get("input_url", "").strip())   # a canvas raster's href is an explicit single target
    if not explicit and not payload.get("force"):
        kept: list[Path] = []
        for f in targets:
            if is_pipeline_processed(st, f.stem):
                skipped.append(f.name)
            else:
                kept.append(f)
        targets = kept
    if not targets:
        return {"message": _skip_message("run pipeline on", skipped), "started": 0, "skipped": skipped}
    # A focused on-canvas run (input_url) is the interactive path: the canvas is the
    # destination, so its outputs are NOT library deliverables. Write them to a HIDDEN
    # output dir (dot-prefixed → excluded from list_outputs) under a friendly stem from the
    # raster's name (not the materialized inline-<hash> input), and trace at the same
    # resolution the live preview uses so a focused vectorize matches the preview (WYSIWYG).
    # A user-set target_max_dim already downscaled the intermediate above, so don't second-
    # guess it; batch/library runs (no input_url) keep the full ceiling and a visible dir.
    focused = bool(payload.get("input_url", "").strip())
    vec_dim = TRACE_PREVIEW_DIM if (focused and mask_cfg["target_max_dim"] is None) else None
    if focused:
        _prune_focused_pipeline_dirs()   # bound old hidden focused-run dirs BEFORE we mint a new one
    out_dir = output_dir("pipeline", hidden=focused)
    friendly = _safe_stem(payload.get("input_name")) if focused else None
    total = len(active_fixes) + sum((up, rb, vec)) + 1   # +1 for the closing "Done" tick
    jobs_started = []
    for src in targets:
        stem = friendly or src.stem
        job_name = (payload.get("input_name") or src.name) if focused else src.name
        upscale_dest = out_dir / f"{stem}.png"
        mask_dest = out_dir / f"{stem}.mask.png"
        cutout_dest = out_dir / f"{stem}.cutout.png"
        vector_dest = out_dir / f"{stem}.svg"
        def worker(log, src=src, stem=stem, upscale_dest=upscale_dest, mask_dest=mask_dest, cutout_dest=cutout_dest, vector_dest=vector_dest) -> None:
            step = {"n": 0}
            def tick(label):
                step["n"] += 1
                _report_progress(step["n"], total, label)
            current = src   # the image flowing between stages

            # --- 0) Degradation fixes (restoration prelude): dejpeg → denoise → deblur, BEFORE
            #        upscale (clean then enlarge). Each is a spandrel scale-1 model; chain them.
            #        When restoration is the ONLY work, the last fix writes the terminal PNG.
            restore_terminal = not (up or rb or vec)
            for i, sid in enumerate(active_fixes):
                tick({"dejpeg": "De-JPEG", "denoise": "Denoise", "deblur": "Deblur"}[sid])
                last = i == len(active_fixes) - 1
                dest = upscale_dest if (restore_terminal and last) else (out_dir / f"{stem}.fix-{sid}.png")
                log(f"{sid} via spandrel ({RESTORE_STAGE_MODELS[sid]}).")
                build_upscale_spandrel(current, dest, RESTORE_STAGE_MODELS[sid], 256, log)
                _register_output(dest)
                current = dest

            # --- 1) Upscale ---
            if up:
                tick("Upscale")
                if source_has_alpha(current):
                    log(f"Alpha-aware source detected for {current.name}; using deterministic upscale.")
                    deterministic_upscale(current, upscale_dest, scale)
                elif model in SR_MODELS:
                    log(f"Upscale via spandrel ({model}).")
                    build_upscale_spandrel(current, upscale_dest, model, 256, log)
                else:
                    ensure_tools_ready("realesrgan")
                    lines = run_subprocess(
                        [str(REALESRGAN_BIN), "-i", str(current), "-o", str(upscale_dest),
                         "-n", model, "-s", str(scale)],
                        cwd=REALESRGAN_DIR,
                    )
                    log_subprocess_lines(log, lines)
                _register_output(upscale_dest)
                current = upscale_dest

            # Optional downscale before the heavier stages, on whatever's current.
            if mask_cfg["target_max_dim"] is not None and (rb or vec):
                preview_path = out_dir / f"{stem}.preview.png"
                staged = apply_preprocess(current, preview_path, target_max_dim=mask_cfg["target_max_dim"])
                if staged is not current:
                    log(f"Resized intermediate to max dim {mask_cfg['target_max_dim']}.")
                    _register_output(preview_path)
                    current = staged

            # --- 2) Remove background ---
            if rb:
                tick({"green": "Greenscreen key", "ai": "AI cutout"}.get(rb_method, "Build mask + cutout"))
                if rb_method == "green":
                    build_chromakey_cutout(current, cutout_dest)
                    validate_cutout_png(cutout_dest)
                    derive_mask_from_alpha(cutout_dest, mask_dest)
                    validate_mask_png(mask_dest)
                elif rb_method == "ai":
                    log(f"AI cutout via rembg ({cutout_model}).")
                    build_ai_cutout(current, cutout_dest, cutout_model, alpha_matting, log)
                    validate_cutout_png(cutout_dest)
                    derive_mask_from_alpha(cutout_dest, mask_dest)
                    validate_mask_png(mask_dest)
                else:   # classical (writes both mask + cutout off `current`)
                    build_mask_with_overrides(current, mask_dest, cutout_dest, mask_cfg)
                    validate_mask_png(mask_dest)
                    validate_cutout_png(cutout_dest)
                _register_output(mask_dest)
                _register_output(cutout_dest)
                current = cutout_dest

            # --- 3) Vectorize (or early-stop at the PNG) ---
            # ONE dispatch (vectorize_svg) shared with the live preview — the engine
            # resolves from the payload (clean / vtracer-colour / vtracer-bw / pixel).
            if vec:
                tick("Pixel trace" if vec_method == "pixel" else "Trace SVG")
                vector_dest.write_text(vectorize_svg(current, payload, max_dim=vec_dim, log=log), encoding="utf-8")
                if vec_method == "pixel":
                    validate_pixelvec_svg(vector_dest)
                else:
                    validate_svg_file(vector_dest)
                _register_output(vector_dest)

            _report_progress(total, total, "Done")

        jobs_started.append(
            launch_internal_job(
                "pipeline", _pipeline_summary(job_name, st), worker,
                source_name=job_name, output_dir=str(out_dir),
            )
        )
    msg = f"Started {len(jobs_started)} pipeline job(s)."
    if skipped:
        msg += f" Skipped {len(skipped)} already processed."
    # Job ids let a single-target caller (the raster panel) await its job and then
    # swap the produced output onto the canvas.
    return {"message": msg, "output_dir": str(out_dir), "started": len(jobs_started),
            "skipped": skipped, "jobs": [j["id"] for j in jobs_started]}
