#!/usr/bin/env python3
"""Capability + router unit suite: the classical auto-router brain (tools/analyze.py
+ the CAPABILITIES registry) and intent→model resolution. Split out of the smoke
suite so a failure here names the routing brain, not "smoke". Pure numpy/PIL.

Run standalone:  python3 tests/test_capabilities.py
(also run as the final group of tests/test_smoke.py, so CI covers it either way)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check_analyzer_router() -> None:
    """The classical auto-router brain (tools/analyze.py + the capability registry): analyze()
    extracts the right signals and plan() makes the is-vs-want call — AUTO only what the image
    NEEDS (vectorize a graphic, de-JPEG a blocky one, upscale a low-res photo), cutout/photo-vec
    OFFERED (wants the pixels can't decide). And resolve_intent/resolve_capability_step map an
    outcome → the right model. Pure numpy/PIL — the regression guard for the routing brain (#48)."""
    sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
    import tempfile
    import numpy as np
    import analyze
    import server
    from PIL import Image, ImageDraw

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)

        # (1) flat graphic — a few solid saturated blocks, crisp, opaque, 800px (not low-res):
        #     the in-app affordance is a CLEAN flat-logo vectorize (auto); cutout is OFFERED.
        flat = Image.new("RGB", (800, 800), (255, 255, 255))
        fd = ImageDraw.Draw(flat)
        fd.rectangle([60, 60, 380, 740], fill=(220, 30, 30))
        fd.rectangle([420, 60, 740, 740], fill=(30, 60, 220))
        fp = d / "flat.png"; flat.save(fp)
        a = analyze.analyze(fp); pl = analyze.plan(a)
        assert a["content_class"] == "flat_graphic", f"few solid colours → flat_graphic, got {a['content_class']}"
        assert not a["has_alpha"] and not a["low_res"], a
        assert [s["capability"] for s in pl["auto"]] == ["vectorize"], f"flat graphic auto = vectorize only, got {pl['auto']}"
        assert pl["auto"][0]["model"] == "clean" and pl["auto"][0]["intent"] == "logo-flat", pl["auto"][0]
        assert "cutout" in [s["capability"] for s in pl["offered"]], "an opaque image should OFFER cutout"

        # (2) alpha present → cutout is NOT offered (the subject is already isolated)
        rgba = flat.convert("RGBA")
        amask = Image.new("L", rgba.size, 255); ImageDraw.Draw(amask).rectangle([0, 0, 40, 799], fill=0)
        rgba.putalpha(amask)
        ap = d / "flat_alpha.png"; rgba.save(ap)
        a2 = analyze.analyze(ap); pl2 = analyze.plan(a2)
        assert a2["has_alpha"], "a transparent margin must read as alpha"
        assert "cutout" not in [s["capability"] for s in pl2["offered"]], "an alpha image must not offer cutout"

        # a genuinely smooth gradient = a clean 'photo' (many colours, no degradation)
        g = np.zeros((800, 800, 3), np.uint8)
        xs = np.linspace(0, 255, 800).astype(np.uint8)
        g[:, :, 0] = xs[None, :]; g[:, :, 1] = xs[::-1][None, :]; g[:, :, 2] = 128
        photo = Image.fromarray(g, "RGB")

        # (3) clean photo → NO auto processing; OFFERS photo-vectorize + cutout (never auto)
        pp = d / "photo.png"; photo.save(pp)
        a3 = analyze.analyze(pp); pl3 = analyze.plan(a3)
        assert a3["content_class"] == "photo", f"a smooth gradient → photo, got {a3['content_class']}"
        assert not pl3["auto"], f"a clean photo needs no auto processing, got {[s['capability'] for s in pl3['auto']]}"
        o3 = [s["capability"] for s in pl3["offered"]]
        assert "vectorize" in o3 and "cutout" in o3, o3

        # (4) JPEG blocking → AUTO de-JPEG (the 8px grid survives because it's measured on a
        #     NATIVE centre crop, not a downscale)
        jp = d / "blocky.jpg"; photo.save(jp, "JPEG", quality=5)
        a4 = analyze.analyze(jp); pl4 = analyze.plan(a4)
        assert a4["degradation"]["jpeg_blockiness"] > analyze.T_BLOCKY, \
            f"a q5 JPEG should ring above {analyze.T_BLOCKY}, got {a4['degradation']['jpeg_blockiness']}"
        assert "dejpeg" in [s["capability"] for s in pl4["auto"]], "a blocky JPEG must auto de-JPEG"

        # (5) low-res photo, no vectorize terminal → AUTO upscale (a true affordance)
        sp = d / "small.png"; photo.resize((220, 220), Image.Resampling.LANCZOS).save(sp)
        a5 = analyze.analyze(sp); pl5 = analyze.plan(a5)
        assert a5["low_res"], a5
        assert "upscale" in [s["capability"] for s in pl5["auto"]], "a low-res photo must auto upscale"

        # (5b) a pixel-clean UI render (flat fills + crisp edges, no sensor noise) is a
        #      SCREENSHOT, not a photo — many colours would otherwise mislabel it 'photo' and
        #      drag it into the photographic restoration chain (denoise/deblur/dejpeg) (#47).
        ss = np.full((900, 900, 3), 238, np.uint8)
        ss[:60, :] = (91, 52, 217); ss[60:, :210] = (250, 250, 252)        # top bar + sidebar
        cards = [(235, 245, 255), (255, 240, 235), (240, 255, 242), (252, 240, 255)]
        hdr = [(52, 120, 246), (220, 90, 40), (40, 167, 90), (150, 60, 200)]
        for i in range(4):
            x = 250 + i * 160; ss[90:300, x:x + 140] = cards[i]; ss[100:140, x + 10:x + 90] = hdr[i]
        for i in range(24):
            h = 40 + (i * 7 % 200); ss[520 - h:520, 250 + i * 26:268 + i * 26] = (60 + i * 5 % 150, 120, 200)
        for y in range(330, 500, 24):
            ss[y:y + 9, 250:760] = (70, 74, 80)                            # text-like bars
        shot = d / "screenshot.png"; Image.fromarray(ss, "RGB").save(shot)
        a6 = analyze.analyze(shot); pl6 = analyze.plan(a6)
        assert a6["content_class"] == "screenshot", \
            f"a clean UI render must read as screenshot, not {a6['content_class']}"
        autos6 = [s["capability"] for s in pl6["auto"]]
        assert not ({"dejpeg", "denoise", "deblur"} & set(autos6)), \
            f"a screenshot must skip photographic restoration, got {autos6}"
        # and the PNG's straight-edge lattice must NOT fake a JPEG-ringing dejpeg trigger
        assert "dejpeg" not in autos6, "a lossless screenshot is not a blocky JPEG"

    # (6) router: an outcome resolves to the right model. Install-AGNOSTIC — when nothing is
    #     installed it still picks the first model serving the intent (so the UI can offer install),
    #     and models are ordered best-first so SOTA wins a shared intent.
    assert server.resolve_intent("cutout", "fast")["model"] == "classical"
    assert server.resolve_intent("cutout", "portrait")["model"] == "birefnet-portrait"
    assert server.resolve_intent("cutout", "high-res")["model"] == "birefnet-hrsod", "HR detail → BiRefNet-HRSOD (#52)"
    hair = server.resolve_intent("cutout", "hair")
    assert hair["model"] == "birefnet-massive" and hair["invoke"].get("alpha_matting") is True, \
        f"hair → BiRefNet-massive + alpha_matting matte-refine (#53), got {hair}"
    assert server.resolve_intent("cutout", "general")["model"] == "birefnet-general", "SOTA wins 'general' (best-first)"
    assert server.resolve_intent("upscale", "anime")["model"] == "realesr-animevideov3"
    assert server.resolve_intent("upscale", "photo")["model"] == "realesrgan-x4plus", \
        "photo stays on the lighter installed ncnn binary even with the spandrel alt present (#54)"
    # #55 spandrel tiers behind dedicated intents
    assert server.resolve_intent("upscale", "detail")["model"] == "dat2-realweb-x4", "detail → DAT-2"
    assert server.resolve_intent("upscale", "lite")["model"] == "span-nomos-x4", "lite → SPAN"
    assert server.resolve_intent("upscale", "gan")["model"] == "aurasr-v2", "gan → AuraSR v2"
    assert server.resolve_intent("upscale", "anime")["model"] == "realesr-animevideov3", \
        "anime stays on the installed ncnn model; Real-CUGAN is the spandrel alternative (#55)"
    # spandrel universal SR loader (#54): every spandrel-backed upscale model must have a
    # downloadable SR_MODELS entry, or the dispatch in _op_upscale can't run it.
    sr_ids = set(server.SR_MODELS)
    for m in server.CAPABILITIES["upscale"]["models"]:
        if "spandrel" in m.get("needs", []):
            assert m["invoke"].get("model") in sr_ids, \
                f"spandrel upscale model {m['id']} has no SR_MODELS entry"
    assert "realesrgan-x4-spandrel" in sr_ids and "url" in server.SR_MODELS["realesrgan-x4-spandrel"]
    assert server.resolve_intent("vectorize", "pixel-art")["model"] == "pixel"
    assert server.resolve_intent("cutout", "no-such-intent") is None
    # resolve_capability_step → the invoke params that drive the EXISTING execution path
    assert server.resolve_capability_step("vectorize", "clean")["invoke"] == {"engine": "clean"}
    assert server.resolve_capability_step("cutout", "birefnet-portrait")["invoke"] == \
        {"removebg_method": "ai", "cutout_model": "birefnet-portrait"}
    # every router-resolvable cutout model is a model the executor actually accepts (no dead picks)
    for m in server.CAPABILITIES["cutout"]["models"]:
        cm = m["invoke"].get("cutout_model")
        assert cm is None or cm in server.AI_CUTOUT_MODELS, f"cutout model {cm} isn't executable"
    # BEN2 (#60): BYO-ONNX cutout. Registered, executable, and its weight spec points at the
    # rembg ben_custom slot + the hosted Apache-2.0 ONNX (build_ai_cutout maps id→ben_custom).
    assert "ben2" in server.AI_CUTOUT_MODELS
    assert server.BEN2_MODEL["session"] == "ben_custom" and "BEN2" in server.BEN2_MODEL["url"]
    ben2 = next(m for m in server.CAPABILITIES["cutout"]["models"] if m["id"] == "ben2")
    assert set(ben2["intents"]) == {"hair", "high-res"} and ben2["invoke"]["cutout_model"] == "ben2"
    ids = {c["id"] for c in server.capabilities_info()}
    assert {"cutout", "upscale", "vectorize"} <= ids, ids
    # cleanup (#56) + face restore (#57): in-stack ONNX, real capabilities (not iopaint/gfpgan stubs)
    cleanup = next(c for c in server.capabilities_info() if c["id"] == "cleanup")
    assert cleanup["models"][0]["needs"] == ["onnxruntime"], cleanup
    assert "LaMa-ONNX" in server.LAMA_MODEL["url"]
    face = next(c for c in server.capabilities_info() if c["id"] == "face")
    assert face["models"][0]["needs"] == ["onnxruntime", "opencv"], face
    assert "GFPGANv1.4" in server.GFPGAN_MODEL["url"] and server.YUNET_MODEL["file"] == "yunet.onnx"
    # degradation fixers (#58): real, spandrel-backed (no new dep). invoke is EMPTY — the stage's
    # model is fixed via RESTORE_STAGE_MODELS (so the auto-plan can't clobber upscale's settings.model).
    for cid, mid in (("denoise", "scunet-denoise"), ("dejpeg", "fbcnn-dejpeg"), ("deblur", "nafnet-deblur")):
        cap = next(c for c in server.capabilities_info() if c["id"] == cid)
        m = cap["models"][0]
        assert m["needs"] == ["spandrel"] and m["invoke"] == {}, cap
        assert server.RESTORE_STAGE_MODELS[cid] == mid and mid in server.SR_MODELS, cid
    # auto-apply (#47 follow-up): the analyzer plans these with registry ids → resolve_capability_step
    # annotates them (available + invoke), so the auto-pipeline can compose them as stages.
    info = server.resolve_capability_step("denoise", "scunet-denoise")
    assert info and info["available"] and info["invoke"] == {}, info
    # face-OFFER gating (#47): detect_face_count is robust (returns an int; 0 on a faceless synthetic)
    import tempfile as _tempfile
    import numpy as _np
    from PIL import Image as _Image
    with _tempfile.TemporaryDirectory() as _td:
        _p = Path(_td) / "flat.png"
        _Image.fromarray(_np.full((64, 64, 3), 120, _np.uint8)).save(_p)
        assert isinstance(server.detect_face_count(_p), int)
    print("ok: analyzer signals + plan (is-vs-want auto/offered) + intent→model router (#48)")


def main() -> int:
    check_analyzer_router()
    print("\nALL CAPABILITY TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
