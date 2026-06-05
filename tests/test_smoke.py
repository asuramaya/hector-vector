#!/usr/bin/env python3
"""Smoke tests: every module parses, and the core pixel-art -> SVG -> PNG path
works on the bundled example sprite. Run with `python3 tests/test_smoke.py`
(needs Pillow + numpy; no pytest required)."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def check_parses() -> None:
    for rel in ["server.py", "engine.py", "mask_trace_prep.py",
                "tools/pixelvec.py", "tools/svg_render.py", "tools/ai_cutout.py"]:
        ast.parse((ROOT / rel).read_text())
    print("ok: all Python modules parse")


def check_pixelvec() -> None:
    import pixelvec
    src = ROOT / "examples" / "fire_h_x11.png"   # 264x330 nearest upscale of a 24x30 sprite
    out = ROOT / "tests" / "_out.svg"
    info = pixelvec.vectorize_pixel_art(src, out, mode="merged")
    assert info["grid"] == [24, 30], f"expected native grid 24x30, got {info['grid']}"
    assert info["shapes"] > 0, "no shapes emitted"
    svg = out.read_text()
    assert "<svg" in svg and ("<rect" in svg or "<path" in svg), "SVG missing shapes"
    print(f"ok: pixelvec recovered {info['grid']} grid, {info['shapes']} shapes")
    return out


def check_render(svg: Path) -> None:
    import svg_render
    from PIL import Image
    out = ROOT / "tests" / "_out.png"
    info = svg_render.render_svg(svg, out, scale=4)   # 24x30 -> 96x120
    assert info["backend"] == "builtin", f"expected builtin backend, got {info['backend']}"
    with Image.open(out) as im:
        assert im.size == (96, 120), f"expected 96x120 render, got {im.size}"
    print(f"ok: svg_render produced {info['size']} PNG via {info['backend']}")


def check_color_simplify() -> None:
    """Color-trace simplification: near-binary art is detected, and poster style
    collapses anti-aliasing fringes to a real palette (the staircase/fill-spam fix)
    while photo style leaves the gradient intact. Pure PIL/numpy — no vtracer."""
    sys.path.insert(0, str(ROOT))
    import server
    from PIL import Image, ImageDraw

    # a near-binary anti-aliased wedge (the case that fill-spams in naive color trace)
    big = Image.new("L", (800, 800), 255)
    ImageDraw.Draw(big).polygon([(400, 40), (120, 760), (680, 760)], fill=0)
    nb = ROOT / "tests" / "_nb.png"
    big.resize((300, 300), Image.Resampling.LANCZOS).convert("RGB").save(nb)
    # a genuine horizontal gradient (must NOT be treated as near-binary)
    col = Image.new("RGB", (300, 300))
    dc = ImageDraw.Draw(col)
    for i in range(300):
        dc.line([(i, 0), (i, 300)], fill=(i % 256, (i * 2) % 256, 200))
    cf = ROOT / "tests" / "_col.png"
    col.save(cf)

    assert server.image_is_near_binary(nb), "AA 2-tone wedge should read as near-binary"
    assert not server.image_is_near_binary(cf), "a gradient must not read as near-binary"

    tr = server.trace_config({"trace_colormode": "color", "trace_color_style": "poster", "color_precision": "3"})
    assert tr["poster_colors"] == 4, f"cp=3 should map to a 4-colour palette, got {tr['poster_colors']}"

    pflat = ROOT / "tests" / "_pflat.png"
    server.prepare_color_input(nb, pflat, tr)
    pcolors = len(Image.open(pflat).convert("RGB").getcolors(maxcolors=1 << 20) or [])
    assert 0 < pcolors <= tr["poster_colors"] + 1, f"poster left {pcolors} colours (palette {tr['poster_colors']})"

    photo = server.trace_config({"trace_colormode": "color", "trace_color_style": "photo", "color_precision": "6"})
    fflat = ROOT / "tests" / "_fflat.png"
    server.prepare_color_input(nb, fflat, photo)
    fcolors = len(Image.open(fflat).convert("RGB").getcolors(maxcolors=1 << 20) or [])
    assert fcolors > pcolors, "photo style must keep the AA ramp (no quantize)"
    print(f"ok: color simplify — near-binary detected, poster {fcolors}->{pcolors} colours, photo preserved")
    for t in ["_nb.png", "_col.png", "_pflat.png", "_fflat.png"]:
        (ROOT / "tests" / t).unlink(missing_ok=True)


def check_clean_trace() -> None:
    """Clean planar colour trace (the flat-logo path): hard k-means palette + per-colour
    B&W mask trace drops the background → transparent, keeps the pure ink colours, and
    preserves holes (letter counters). The fix for vtracer-stacked halos / lost counters."""
    sys.path.insert(0, str(ROOT))
    import re
    import server
    if not server.VTRACER_BIN.exists():
        print("skip: clean trace (vtracer not installed)")
        return
    from PIL import Image, ImageDraw

    # synthetic 3-colour logo: black ring outline, red ring fill, white counter (a hole)
    im = Image.new("RGB", (240, 240), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.ellipse([30, 30, 210, 210], fill=(0, 0, 0))           # black outer
    d.ellipse([48, 48, 192, 192], fill=(255, 0, 0))         # red fill
    d.ellipse([96, 96, 144, 144], fill=(0, 0, 0))           # black inner
    d.ellipse([110, 110, 130, 130], fill=(255, 255, 255))   # white counter (hole)
    src = ROOT / "tests" / "_logo.png"
    im.save(src)
    svg = server.clean_color_trace(src, n=3, simplify="medium")
    fills = sorted(set(re.findall(r'fill="([^"]*)"', svg)))
    assert fills == ["#000000", "#ff0000"], f"clean trace should be pure red+black (bg dropped), got {fills}"
    black_d = re.search(r'<path d="([^"]*)" fill="#000000"', svg).group(1)
    assert black_d.count("Z") >= 2, f"black layer should keep holes/counters, got {black_d.count('Z')} subpaths"

    # engine registry + dispatch: one resolver, explicit wins, legacy derives
    assert {"clean", "vtracer", "pixel"} <= set(server.VECTORIZE_ENGINES)
    assert server.resolve_engine({"trace_colormode": "color", "trace_color_style": "clean"}) == "clean"
    assert server.resolve_engine({"vectorize_method": "pixel"}) == "pixel"
    assert server.resolve_engine({"trace_colormode": "bw"}) == "vtracer"
    assert server.resolve_engine({"engine": "pixel", "trace_colormode": "bw"}) == "pixel", "explicit engine must win"
    info = server.vectorize_engines_info()
    assert len(info) == 3 and all("schema" in e and "caps" in e for e in info), "engine info must carry schema+caps"

    # raster-op registry mirrors the engine registry: pluggable ops + schema endpoint
    assert {"upscale", "removebg"} <= set(server.RASTER_OPS)
    rinfo = server.raster_ops_info()
    assert len(rinfo) == 2 and all("schema" in o and "available" in o for o in rinfo), "raster-op info must carry schema+available"
    assert all(callable(server.RASTER_OPS[o]["apply"]) for o in server.RASTER_OPS), "each raster op needs an apply callable"
    assert "nope" not in server.RASTER_OPS
    try:
        server.apply_raster_op({"input_url": "/outputs/does-not-exist.png", "op": "nope"})
        assert False, "a bad raster-op request must raise ValueError"
    except ValueError:
        pass
    print(f"ok: clean trace — {fills}, counters preserved ({black_d.count('Z')} black subpaths); engine + raster-op registries OK")
    src.unlink(missing_ok=True)


def check_path_simplify() -> None:
    """Post-trace refit collapses over-segmented paths to minimal cubics, preserves
    structure, and is RESOLUTION-STABLE — the same shape at 3x scale simplifies to
    the same node count (node density tracks geometry, not pixels). Pure numpy."""
    import math
    sys.path.insert(0, str(ROOT / "tools"))
    import simplify_svg

    def circle_svg(dim, cx, cy, r, n=200):
        p = [f"{cx + r*math.cos(2*math.pi*i/n):.2f},{cy + r*math.sin(2*math.pi*i/n):.2f}" for i in range(n)]
        d = "M" + p[0] + " " + " ".join("L" + q for q in p[1:]) + " Z"
        return f'<svg width="{dim}" height="{dim}"><path d="{d}" fill="#123abc"/></svg>'

    new, st = simplify_svg.simplify_svg_text(circle_svg(1000, 500, 500, 300), frac=0.02)
    assert st["nodes_after"] <= st["nodes_before"] // 10, f"weak reduction: {st}"
    assert 2 <= st["nodes_after"] <= 12, f"a circle should need a handful of cubics, got {st['nodes_after']}"
    assert new.count("<path") == 1 and 'fill="#123abc"' in new, "lost the path or its fill"

    _, st3 = simplify_svg.simplify_svg_text(circle_svg(3000, 1500, 1500, 900), frac=0.02)
    assert st3["nodes_after"] == st["nodes_after"], \
        f"not resolution-stable: {st['nodes_after']} at 1x vs {st3['nodes_after']} at 3x"
    print(f"ok: simplify {st['nodes_before']}->{st['nodes_after']} nodes, resolution-stable across 3x")


def check_pipeline_stages() -> None:
    """The generalized pipeline resolves stage flags + methods from a payload, and
    a flag-less payload stays back-compatible (all three stages). Pure logic."""
    sys.path.insert(0, str(ROOT))
    import server

    # explicit flags honored, with method strings
    st = server._pipeline_stages({"stage_upscale": False, "stage_removebg": True,
                                  "stage_vectorize": True, "removebg_method": "green",
                                  "vectorize_method": "pixel"})
    assert st["upscale"] is False and st["removebg"] and st["vectorize"], st
    assert st["removebg_method"] == "green" and st["vectorize_method"] == "pixel", st

    # stringy booleans coerce; the bare (legacy) payload is all-three Production SVG
    assert server._stage_on("true") and server._stage_on(1) and not server._stage_on("0")
    legacy = server._pipeline_stages({})
    assert legacy["upscale"] and legacy["removebg"] and legacy["vectorize"], legacy

    # methods fall back to the old single-purpose settings when unspecified
    fb = server._pipeline_stages({"stage_vectorize": True, "cutout_backend": "ai", "trace_mode": "pixel"})
    assert fb["removebg_method"] == "ai" and fb["vectorize_method"] == "pixel", fb

    summ = server._pipeline_summary("logo.png", st)
    assert "Greenscreen" in summ and "Pixel trace" in summ and "logo.png" in summ, summ
    print("ok: pipeline stage flags resolve (explicit, legacy all-three, method fallbacks)")


def check_pipeline_skip() -> None:
    """Stage-aware skip-detection: the terminal output a stage-set emits (SVG /
    cutout PNG / upscale PNG) and 'already processed' track the ACTUAL stages, not
    a fixed 'pipeline -> .svg' — so an upscale-only run is skipped on its PNG and a
    vectorize run isn't falsely skipped by a leftover upscale PNG. Pure logic + a
    throwaway pipeline-* folder."""
    sys.path.insert(0, str(ROOT))
    import server

    on = {"upscale": True, "removebg": True, "vectorize": True}
    assert server.pipeline_expected_output(on, "img") == "img.svg"
    assert server.pipeline_expected_output({"upscale": True, "removebg": True, "vectorize": False}, "img") == "img.cutout.png"
    assert server.pipeline_expected_output({"upscale": True, "removebg": False, "vectorize": False}, "img") == "img.png"
    assert server.pipeline_expected_output({"upscale": False, "removebg": False, "vectorize": False}, "img") is None

    folder = server.OUTPUTS_DIR / "pipeline-_skiptest"
    folder.mkdir(parents=True, exist_ok=True)
    try:
        # only the upscale PNG exists on disk
        (folder / "_skipstem.png").write_text("")
        up_only = {"upscale": True, "removebg": False, "vectorize": False}
        vec = {"upscale": True, "removebg": True, "vectorize": True}
        assert server.is_pipeline_processed(up_only, "_skipstem"), "upscale-only must skip on its PNG"
        assert not server.is_pipeline_processed(vec, "_skipstem"), "a vectorize run must NOT skip on a leftover upscale PNG"
        # now the SVG exists too -> the vectorize run is genuinely done
        (folder / "_skipstem.svg").write_text("<svg/>")
        assert server.is_pipeline_processed(vec, "_skipstem"), "vectorize must skip once its SVG exists"
        assert not server.is_pipeline_processed(vec, "_other"), "unrelated stem must not skip"
    finally:
        for child in folder.glob("*"):
            child.unlink()
        folder.rmdir()
    print("ok: stage-aware skip — expected output + is_pipeline_processed track the live stage-set")


def check_trace_ceiling() -> None:
    """The trace ceiling honours an explicit 'Max trace size' (target_max_dim) opt-in so
    large clean art can be traced at full fidelity, falls back to the safety default when
    unset, and clamps a pathological value to the absolute bound."""
    sys.path.insert(0, str(ROOT))
    import server

    assert server._trace_ceiling({"target_max_dim": None}) == server.TRACE_MAX_DIM, "unset → safety default"
    assert server._trace_ceiling({}) == server.TRACE_MAX_DIM, "missing → safety default"
    # an explicit value ABOVE the default is honoured (the whole point — opt-in fidelity)
    hi = server.TRACE_MAX_DIM + 800
    assert server._trace_ceiling({"target_max_dim": hi}) == hi, "explicit > default must be honoured"
    assert server._trace_ceiling({"target_max_dim": 900}) == 900, "explicit < default honoured too"
    # a pathological value is clamped to the absolute bound
    assert server._trace_ceiling({"target_max_dim": 99999}) == server.TRACE_ABS_MAX_DIM, "clamp to abs bound"
    # mask_config parses the raw payload field into target_max_dim (range-clamped)
    assert server.mask_config({"target_max_dim": "2400"})["target_max_dim"] == 2400
    print("ok: trace ceiling honours the Max-trace-size override + clamps to the safety bound")


def check_validation_guards() -> None:
    """Simple-but-legitimate trace/cutout outputs pass; only genuinely empty/blank ones are
    rejected — so a single small shape no longer errors as 'too small' (#38)."""
    sys.path.insert(0, str(ROOT))
    import server, tempfile
    from PIL import Image

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        # a tiny single-shape SVG (well under the old 256-byte floor) is VALID
        ok_svg = d / "small.svg"
        ok_svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0 L4 0 L4 4 Z" fill="#000"/></svg>')
        server.validate_svg_file(ok_svg)                       # must NOT raise
        # an "empty" trace — a path with only a moveto, no geometry — is INVALID
        empty_svg = d / "empty.svg"
        empty_svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>')
        try:
            server.validate_svg_file(empty_svg); assert False, "moveto-only must fail"
        except ValueError:
            pass
        # a single-rect pixel SVG (tiny) is VALID (the byte floor is gone; shapes suffice)
        pv = d / "pv.svg"
        pv.write_text('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1" height="1" fill="#000"/></svg>')
        server.validate_pixelvec_svg(pv)                       # must NOT raise
        # a small-but-real cutout passes; a blank one fails clearly
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        for y in range(22, 32):
            for x in range(22, 32):
                img.putpixel((x, y), (255, 0, 0, 255))         # 100 opaque px
        cut = d / "cut.png"; img.save(cut)
        server.validate_cutout_png(cut)                        # must NOT raise
        blank = d / "blank.png"; Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(blank)
        try:
            server.validate_cutout_png(blank); assert False, "blank cutout must fail"
        except ValueError:
            pass
    print("ok: validation guards accept simple outputs, reject only empty/blank (#38)")


def check_trace_downscale() -> None:
    """The trace ceiling actually downscales: an image above the cap is resized to it (longest
    side), one at/under it is passed through untouched (#42 / TRACE_MAX_DIM behaviour)."""
    sys.path.insert(0, str(ROOT))
    import server, tempfile
    from PIL import Image

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        big = d / "big.png"; Image.new("RGB", (2400, 1200), (200, 30, 30)).save(big)
        out = server.apply_preprocess(big, d / "big.small.png", target_max_dim=1600)
        w, h = Image.open(out).size
        assert max(w, h) == 1600 and (w, h) == (1600, 800), f"expected 1600x800, got {w}x{h}"
        # at/under the cap → untouched (returns the source unchanged)
        small = d / "small.png"; Image.new("RGB", (800, 400), (30, 30, 200)).save(small)
        same = server.apply_preprocess(small, d / "small.small.png", target_max_dim=1600)
        assert Image.open(same).size == (800, 400), "image under the cap must pass through"
    print("ok: trace ceiling downscales above the cap, passes through at/under it (#42)")


def check_dense_subpath_bounded() -> None:
    """A pathologically dense subpath (the upscaled-raster / huge-path case) is decimated to a
    bound before the O(n^2) refit, so simplify stays fast and reduces node count (#42 / #2)."""
    sys.path.insert(0, str(ROOT))
    import simplify_svg as S, math, time

    # one closed subpath with ~9000 points around a SMOOTH circle (far over the max_pts cap):
    # a smooth feature must collapse to a handful of cubics, fast, despite the dense input.
    n = 9000
    pts = [(400 + 180 * math.cos(2 * math.pi * i / n), 400 + 180 * math.sin(2 * math.pi * i / n)) for i in range(n)]
    d = "M %.2f %.2f " % pts[0] + "".join("L %.2f %.2f " % p for p in pts[1:]) + "Z"
    t = time.time(); out, segs = S.simplify_d(d, frac=0.02); dt = time.time() - t
    assert segs and segs < 200, f"dense smooth subpath must collapse to few segments, got {segs}"
    assert dt < 5.0, f"dense subpath refit should be fast (bounded), took {dt:.2f}s"
    print(f"ok: dense {n}-pt smooth subpath bounded → {segs} segments in {dt:.2f}s (#42)")


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
    assert server.resolve_intent("cutout", "general")["model"] == "birefnet-general", "SOTA wins 'general' (best-first)"
    assert server.resolve_intent("upscale", "anime")["model"] == "realesr-animevideov3"
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
    ids = {c["id"] for c in server.capabilities_info()}
    assert {"cutout", "upscale", "vectorize"} <= ids, ids
    print("ok: analyzer signals + plan (is-vs-want auto/offered) + intent→model router (#48)")


def main() -> int:
    check_parses()
    svg = check_pixelvec()
    check_render(svg)
    check_color_simplify()
    check_clean_trace()
    check_path_simplify()
    check_pipeline_stages()
    check_pipeline_skip()
    check_trace_ceiling()
    check_validation_guards()
    check_trace_downscale()
    check_dense_subpath_bounded()
    check_analyzer_router()
    for tmp in ["_out.svg", "_out.png"]:
        (ROOT / "tests" / tmp).unlink(missing_ok=True)
    print("\nALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
