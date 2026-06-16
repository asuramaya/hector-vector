"""Capabilities taxonomy + router resolution (#29 split from server.py). A DESCRIPTIVE
layer over the apply/trace registries: what OUTCOMES (capability × intent) exist and
which model achieves each, plus resolving a router decision to a real plugin. Depends
only on the paths layer (tool/model presence probes). server.py re-exports this, so
`server.CAPABILITIES` / `server.resolve_intent(...)` etc. keep working."""
from __future__ import annotations

from hvserver.paths import (
    REALESRGAN_BIN, VTRACER_BIN, rembg_installed, spandrel_installed, _venv_has,
)


# ---------------------------------------------------------------- capabilities (taxonomy)
# A DESCRIPTIVE layer over the apply/trace registries (RASTER_OPS / VECTORIZE_ENGINES):
# what OUTCOMES (capabilities × intents) exist and which model achieves each. The auto
# router (tools/analyze.plan) emits (capability, intent, model) decisions; this resolves
# them to a real plugin — install needs + the `invoke` params that select it on the EXISTING
# execution path (RASTER_OPS[op].apply for kind "raster"; vectorize_svg with engine= for
# "svg"). Adding a model is a line here, not a new panel or new plumbing. P3 capabilities
# are declared (so the router's ids resolve) with models that aren't installed yet →
# available:false until their task lands. See [[auto-routing-classical-not-vlm]].

CAPABILITIES = {
    "cutout": {
        "label": "Cutout / remove background", "kind": "raster", "op": "removebg",
        "intents": ["general", "product", "portrait", "high-res", "hair", "fast", "greenscreen"],
        "models": [
            {"id": "classical", "label": "Classical (edge/threshold)", "intents": ["fast"], "needs": [],
             "invoke": {"removebg_method": "classical"}},
            {"id": "green", "label": "Greenscreen key", "intents": ["greenscreen"], "needs": [],
             "invoke": {"removebg_method": "green"}},
            # Ordered best-first per intent: the intent resolver picks the first available
            # model serving the chosen outcome, so SOTA (BiRefNet) wins "general" over u2net.
            # Sizes are the actual ONNX weights pooch fetches on first use (verified via HEAD):
            # the full BiRefNet checkpoints are 928MB each; the swin-tiny lite is 214MB.
            {"id": "birefnet-general", "label": "BiRefNet general (OSS SOTA)", "intents": ["general", "product"],
             "needs": ["rembg"], "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-general"}},
            {"id": "birefnet-hrsod", "label": "BiRefNet HR (high-res detail)", "intents": ["high-res"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-hrsod"}},
            {"id": "birefnet-portrait", "label": "BiRefNet portrait", "intents": ["portrait"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-portrait"}},
            # Hair/fine-detail outcome: DIS5K-trained "massive" checkpoint (dichotomous seg of fine
            # structures) + alpha_matting edge refinement, switched on by the intent in one pick.
            {"id": "birefnet-massive", "label": "BiRefNet massive (DIS5K fine detail)", "intents": ["hair"], "needs": ["rembg"],
             "size_mb": 928, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-massive", "alpha_matting": True}},
            # BEN2 (#60): Confidence-Guided Matting, SOTA hair/4K. Same rembg runtime (ben_custom
            # BYO-ONNX), 213MB Apache-2.0 weight auto-fetched on first use. Listed after the
            # BiRefNet defaults so existing hair/high-res resolution is unchanged — BEN2 is the
            # explicit "best matting" alternative, not a silent default swap.
            {"id": "ben2", "label": "BEN2 (CGM hair / 4K matting)", "intents": ["hair", "high-res"], "needs": ["rembg"],
             "size_mb": 213, "invoke": {"removebg_method": "ai", "cutout_model": "ben2", "alpha_matting": True}},
            {"id": "birefnet-general-lite", "label": "BiRefNet lite (swin-tiny)", "intents": ["general"], "needs": ["rembg"],
             "size_mb": 214, "invoke": {"removebg_method": "ai", "cutout_model": "birefnet-general-lite"}},
            {"id": "u2net", "label": "U²-Net general (lighter)", "intents": ["general"], "needs": ["rembg"], "size_mb": 176,
             "invoke": {"removebg_method": "ai", "cutout_model": "u2net"}},
        ],
    },
    "upscale": {
        "label": "Upscale", "kind": "raster", "op": "upscale",
        "intents": ["photo", "clean", "anime", "detail", "lite", "gan"],
        "models": [
            {"id": "realesrgan-x4plus", "label": "Real-ESRGAN ×4 (photo)", "intents": ["photo"], "needs": ["realesrgan"],
             "invoke": {"model": "realesrgan-x4plus"}},
            {"id": "realesrnet-x4plus", "label": "Real-ESRNet ×4 (cleaner)", "intents": ["clean"], "needs": ["realesrgan"],
             "invoke": {"model": "realesrnet-x4plus"}},
            {"id": "realesr-animevideov3", "label": "Anime / line-art ×4", "intents": ["anime"], "needs": ["realesrgan"],
             "invoke": {"model": "realesr-animevideov3"}},
            # Universal-loader path (#54): spandrel/torch runs any SR checkpoint. Listed after
            # the Vulkan ncnn model so "photo" still resolves to the lighter installed binary.
            {"id": "realesrgan-x4-spandrel", "label": "Real-ESRGAN ×4 (spandrel/torch)", "intents": ["photo"],
             "needs": ["spandrel"], "size_mb": 64, "invoke": {"model": "realesrgan-x4-spandrel"}},
            # #55 spandrel tiers behind dedicated intents (arch/scale confirmed by load+run).
            {"id": "dat2-realweb-x4", "label": "DAT-2 — detail / real photo (×4)", "intents": ["detail"],
             "needs": ["spandrel"], "size_mb": 134, "invoke": {"model": "dat2-realweb-x4"}},
            {"id": "span-nomos-x4", "label": "SPAN — fast / lightweight (×4)", "intents": ["lite"],
             "needs": ["spandrel"], "size_mb": 5, "invoke": {"model": "span-nomos-x4"}},
            {"id": "realcugan-up2x", "label": "Real-CUGAN — anime (×2)", "intents": ["anime"],
             "needs": ["spandrel"], "size_mb": 5, "invoke": {"model": "realcugan-up2x"}},
            {"id": "aurasr-v2", "label": "AuraSR v2 — GAN / creative (×4)", "intents": ["gan"],
             "needs": ["spandrel"], "size_mb": 2470, "invoke": {"model": "aurasr-v2"}},
        ],
    },
    "vectorize": {
        "label": "Vectorize", "kind": "svg", "op": None,
        "intents": ["logo-flat", "colour-photo", "bw-silhouette", "pixel-art"],
        "models": [
            {"id": "clean", "label": "Clean — flat logo (planar)", "intents": ["logo-flat"], "needs": ["vtracer"],
             "invoke": {"engine": "clean"}},
            {"id": "vtracer", "label": "VTracer — colour / B&W", "intents": ["colour-photo", "bw-silhouette"],
             "needs": ["vtracer"], "invoke": {"engine": "vtracer"}},
            {"id": "pixel", "label": "Pixel-art — recover grid", "intents": ["pixel-art"], "needs": [],
             "invoke": {"engine": "pixel"}},
        ],
    },
    # ---- P3 capabilities: declared so router ids resolve; models land with their tasks ----
    # #58 degradation fixers — real, one-shot ops via /api/restore (model = the SR_MODELS id).
    # spandrel restoration archs (no new dep); the analyzer plans these, the user applies them.
    # invoke is EMPTY on purpose: the stage's model is fixed per-capability (RESTORE_STAGE_MODELS),
    # so the auto-plan just flips the stage on — it must NOT set settings.model (that's upscale's).
    "dejpeg": {"label": "Remove JPEG artifacts", "kind": "raster", "op": None, "intents": ["default"],
               "models": [{"id": "fbcnn-dejpeg", "label": "FBCNN", "intents": ["default"], "needs": ["spandrel"], "size_mb": 275, "invoke": {}}]},
    "denoise": {"label": "Denoise", "kind": "raster", "op": None, "intents": ["blind"],
                "models": [{"id": "scunet-denoise", "label": "SCUNet", "intents": ["blind"], "needs": ["spandrel"], "size_mb": 69, "invoke": {}}]},
    "deblur": {"label": "Deblur", "kind": "raster", "op": None, "intents": ["default"],
               "models": [{"id": "nafnet-deblur", "label": "NAFNet", "intents": ["default"], "needs": ["spandrel"], "size_mb": 260, "invoke": {}}]},
    # Interactive (mask-based) op, not a pipeline stage: invoked via /api/cleanup from the
    # mask-paint tool, so `op` stays None. Runs big-LaMa on onnxruntime (already in-stack).
    "cleanup": {"label": "Cleanup / object removal", "kind": "raster", "op": None, "intents": ["object-removal"],
                "models": [{"id": "lama", "label": "LaMa big (ONNX)", "intents": ["object-removal"], "needs": ["onnxruntime"], "size_mb": 208, "invoke": {}}]},
    # One-shot op (detects faces internally, no mask): invoked via /api/face-restore from the
    # Processor "Restore faces" button, so `op` stays None. GFPGAN v1.4 runs as ONNX (the pip
    # package is dead on modern torchvision) with an opencv YuNet detect→align→paste-back wrap.
    "face": {"label": "Face restore", "kind": "raster", "op": None, "intents": ["restore"],
             "models": [{"id": "gfpgan", "label": "GFPGAN v1.4 (ONNX)", "intents": ["restore"], "needs": ["onnxruntime", "opencv"], "size_mb": 341, "invoke": {}}]},
}


def _need_available(need: str) -> bool:
    """Whether an install dependency is present. P3 tools (fbcnn/scunet/nafnet/iopaint/
    gfpgan) have no integration yet → False until their task lands."""
    if need == "realesrgan":
        return REALESRGAN_BIN.exists()
    if need == "vtracer":
        return VTRACER_BIN.exists()
    if need == "rembg":
        return rembg_installed()
    if need == "spandrel":
        return spandrel_installed()
    if need == "onnxruntime":
        return _venv_has("onnxruntime")
    if need == "opencv":
        return _venv_has("cv2")
    return False


def _model_available(model: dict) -> bool:
    return all(_need_available(n) for n in model.get("needs", []))


def resolve_capability_step(cap_id: str, model_id: str | None) -> dict | None:
    """Resolve a router decision (capability, model) to its plugin: availability, the
    install needs, and the `invoke` params that drive the existing execution path."""
    c = CAPABILITIES.get(cap_id)
    if not c:
        return None
    for m in c["models"]:
        if m["id"] == model_id:
            return {"label": m.get("label", model_id), "available": _model_available(m),
                    "needs": m.get("needs", []), "invoke": m.get("invoke", {}),
                    "size_mb": m.get("size_mb")}
    return None


def resolve_intent(cap_id: str, intent: str) -> dict | None:
    """Given a capability + a chosen intent (the outcome the user picked, or the router's),
    pick the best AVAILABLE model serving it — preferring installed, else the first model
    that serves the intent so the UI can offer install. Models are ordered best-first, so
    'general' cutout resolves to BiRefNet over u2net. Drives the intent picker / overrides."""
    c = CAPABILITIES.get(cap_id)
    if not c:
        return None
    serving = [m for m in c["models"] if intent in m.get("intents", [])]
    if not serving:
        return None
    chosen = next((m for m in serving if _model_available(m)), serving[0])
    return {"model": chosen["id"], "label": chosen.get("label"), "available": _model_available(chosen),
            "needs": chosen.get("needs", []), "invoke": chosen.get("invoke", {}), "size_mb": chosen.get("size_mb")}


def capabilities_info() -> list[dict]:
    """Serializable capability/model registry for the client (the intent-first UI source
    of truth). Each model carries `available` (install state) + `size_mb` for the
    install-on-demand UX (#51)."""
    out = []
    for cid, c in CAPABILITIES.items():
        models = [{**m, "available": _model_available(m)} for m in c["models"]]
        out.append({"id": cid, "label": c["label"], "kind": c["kind"], "op": c.get("op"),
                    "intents": c["intents"], "models": models,
                    "implemented": any(m["available"] for m in models)})
    return out
