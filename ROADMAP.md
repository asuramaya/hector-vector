# Roadmap — AI Image-Processing Roll-Up

Research scan of free / freemium online AI image tools, the OSS models that power them, and what hector-vector should adopt to become the one self-hosted alternative.

## Executive summary

Across the categories we care about, the OSS ecosystem is now strong — most closed offerings are thin wrappers over OSS, internal forks of OSS architectures (BiRefNet, Real-ESRGAN, LaMa, RRDBNet), or marginal wins over OSS that don't justify a paid API. The clear exception is **AI vectorization** (Vectorizer.ai, Recraft) — `vtracer` is the best OSS option but uses classical clustering rather than learned shape priors.

**Licensing landmines** — performant but commercially restricted: CodeFormer, SUPIR, StableSR, BRIA RMBG-1.4/2.0, MAT, BEN2-Big.

**Permissive (MIT/Apache/BSD)**: BiRefNet, Real-ESRGAN, HAT, DAT, NAFNet, Restormer, SCUNet, LaMa, MI-GAN, BEN2 (base), InSPyReNet, GFPGAN, FBCNN, vtracer, IOPaint.

---

## Tool-by-tool inventory

### Background removal / cutout

| Tool | Believed model | Confidence | OSS equivalent |
|---|---|---|---|
| remove.bg | Proprietary; BiRefNet/U²-Net class encoder-decoder + specialist heads | Medium-high | BiRefNet, BEN2 |
| Photoroom Remove BG | Proprietary "V4" (larger encoder + higher input res) | Medium | BiRefNet |
| Clipdrop Remove Background | Custom segmentation net (cutout) + SD for replacement | Medium | BiRefNet |
| Cutout.pro / PixelCut / PicWish / Slazzer / Erase.bg / Removal.ai | Various; PixelCut explicitly exposes BRIA | Low-medium | BiRefNet / BEN2 / RMBG-2.0 (NC) |
| img.ly background-removal-js | Quantized U²-Net (silueta) | High — itself OSS | Itself (MIT) |
| Cleanup.pictures / Magic Eraser | LaMa | High | LaMa |
| Fotor / MagicStudio / Imagine.art / Picsart Cleanup | Proprietary; functionally equivalent to BiRefNet/LaMa | Medium | BiRefNet + LaMa |

**OSS SOTA picks** (in order of preference):

- **BiRefNet** (MIT) — `ZhengPeng7/BiRefNet`. Current OSS SOTA. Variants: general 1024², HR 2048², dynamic multi-res, portrait, matting, lite (Swin-Tiny, CPU). FP16 ~57ms on 4090 at 1024², 3.5GB VRAM.
- **BEN2** (MIT) — `PramaLLC/BEN2`. Confidence-Guided Matting refiner. Best at hair edges and 4K. Base model OSS; "Big" variant is commercial API only.
- **InSPyReNet** (MIT) — `plemeri/InSPyReNet`. Image pyramid SOD. Fast, well-supported by `transparent-background`.
- **BRIA RMBG-2.0** (CC BY-NC) — BiRefNet arch + BRIA's proprietary 15k-image set. Best in many benchmarks; **unusable commercially without a paid agreement.**
- **U²-Net / IS-Net / silueta / MODNet** (Apache) — older, &lt;100MB, near-realtime CPU.
- **SAM 2 / SAM 3** (Apache) — promptable; combine with SDMatte / SAMA / Matte-Anything for matting refinement.

### Upscaling / super-resolution

| Tool | Believed model | Confidence | OSS equivalent |
|---|---|---|---|
| Upscayl | Real-ESRGAN + 4x-UltraSharp, Remacri, NMKD Superscale, HFA2k | High (open source) | Itself OSS (AGPL frontend) |
| waifu2x | Original upconv_7 / vgg_7 CNN | High (open source) | Real-CUGAN, Real-ESRGAN_anime_6B |
| bigjpg | Claims "waifu2x-based"; output suggests ESRGAN | Medium | Real-ESRGAN |
| Topaz Gigapixel / Photo AI | Proprietary CNN/transformer ensemble; latest "Redefine" uses diffusion | Low arch / High "diffusion" | None matches all modes; SUPIR (NC) + HAT/DAT mix is closest |
| Vance.ai / Deep-Image.ai / Let's Enhance / Claid / Neural.love | ESRGAN family + diffusion stages; Neural.love admits "open-source algorithms" | Medium | Real-ESRGAN + GFPGAN + StableSR/DiffBIR |
| Clipdrop Image Upscaler | Custom; likely on SD/SDXL upscaling stack | Medium | StableSR / DiffBIR / SUPIR |
| Magnific.ai | Diffusion-based upscaling-as-img2img with SD prior | High (confirmed) | SUPIR (NC) or DiffBIR (Apache) |
| AuraSR (fal.ai) | Open reproduction of GigaGAN, 600M params, 4× one-shot | High — open-sourced | Itself (CC-BY-SA weights / Apache code) |

**OSS SOTA picks:**

- **General photo, balanced** — **Real-ESRGAN x4plus** (BSD). The default; NCNN/Vulkan everywhere. `RealESRGAN-General-WDN-4xV3` is a 5MB CPU variant.
- **Quality-first** — **DAT-2** or **HAT** (Apache). DAT-2 11M / 27.86 PSNR Urban100×4; HAT 20.8M / 27.97. Both beat SwinIR. Phhofm's `4xRealWebPhoto_v4_dat2` and `4xNomos2_hq_dat2` are exceptional for web-degraded inputs.
- **Diffusion (commercially-usable)** — **DiffBIR** (Apache). Closest OSS to Magnific/SUPIR that allows commercial use. SUPIR & StableSR are research-only.
- **Anime / line art** — **Real-CUGAN** (MIT). Fastest, sharpest. Fallback: Real-ESRGAN_anime_6B, waifu2x.
- **JPEG-degraded inputs** — `4xRealWebPhoto_v4_dat2` or `1xDeJPG_realplksr_otf` (trained with recompression in degradation pipeline).
- **Generative / synthetic** — **AuraSR-v2** (CC-BY-SA weights / Apache code) — designed for upscaling AI-generated imagery.
- **Lightweight / real-time / CPU** — **SPAN** (Apache, NTIRE 2024 winner) or **SAFMN++**.

Use **spandrel** (`chaiNNer-org/spandrel`, MIT) as the runtime — auto-detects Real-ESRGAN/SwinIR/HAT/DAT/SPAN/OmniSR/RealPLKSR/MOSR/ATD weights, so model swap is config-only.

### Vectorization (raster → SVG)

| Tool | Approach | Confidence | OSS equivalent |
|---|---|---|---|
| Vectorizer.ai | "Deep Vector Engine": learned shape priors + classical geometry; fits circles, ellipses, rounded rects natively | High (documented) | vtracer + custom postprocessing (no learned OSS) |
| Recraft (vectorize) | Proprietary; likely Vectorizer.ai-style hybrid | Medium | vtracer |
| AI Vector / aivector.ai / kittl / svgconverter / vectorizer.io | Mostly thin wrappers; many proxy vtracer or potrace | Medium-high | vtracer itself |

**OSS pick**: **vtracer** (MIT, Rust) — only viable OSS for color vectorization. Linear-time clustering, full-color photos, three curve-fitting modes (pixel/polygon/spline). Rust crate / PyPI / WASM / CLI. Output ~30-70% smaller than Illustrator's Image Trace.

- **potrace** (GPL) — best for B&W / line art / logos.
- **AutoTrace** (GPL) — rarely better than vtracer.
- **DeepSVG / PyTorch-SVGRender** — research-grade, not production-ready.

**This is the one category where there is no good OSS replacement for the SOTA closed product.**

### Inpainting / cleanup / object removal

| Tool | Model | Confidence | OSS |
|---|---|---|---|
| Clipdrop Cleanup | Originally LaMa (cleanup.pictures acquisition); now likely SD-based for hard cases | High (LaMa heritage) | LaMa, MI-GAN, MAT |
| Magic Eraser, Inpaint.io, cleanup.pictures | LaMa | High | LaMa |
| Photoroom retouch, PicWish remove object, Picsart Cleanup | Proprietary; functionally LaMa or LaMa+SD | Medium | LaMa |

**OSS pick**: Vendor **IOPaint** (Apache, formerly lama-cleaner) as the service backend — already wraps LaMa, MI-GAN, MAT, SD-based models behind one API.

- **LaMa** (Apache) — default, fast, good up to ~2K, no GPU required.
- **MI-GAN** (MIT) — mobile-grade; ~10× smaller/faster than LaMa with comparable FID.
- **MAT** (CC BY-NC) — large masks; non-commercial only.
- **PowerPaint / BrushNet** — diffusion-based; needed for semantic completion but heavy.

### Face restoration

| Tool | Model | OSS |
|---|---|---|
| Remini, Reface.ai, every "AI photo restorer" | GFPGAN or CodeFormer + Real-ESRGAN for background | GFPGAN v1.4 (Apache), CodeFormer (NC), RestoreFormer++ (MIT-ish), GPEN (Apache) |

**OSS pick**: **GFPGAN v1.4** (Apache, TencentARC) as primary — conservative, preserves identity, 6s/face on consumer GPU. Pair with Real-ESRGAN for non-face regions (the official GFPGAN repo does this).

CodeFormer for extreme blur reconstruction *only if* non-commercial is acceptable. **RestoreFormer++** is the permissive alternative.

### Denoise / artifact removal / deblur

| Use case | OSS pick | License |
|---|---|---|
| Blind real-world denoise | **SCUNet** (`scunet_color_real_psnr`) | Apache |
| Controllable noise level | **DRUNet** | MIT |
| JPEG artifacts (blind, no QF) | **FBCNN** | Apache |
| Motion/defocus deblur | **NAFNet** (SOTA on GoPro 33.69 dB, ~10% of Restormer's compute) | MIT |
| Multi-task (rain/snow/blur/noise) | **Restormer** | MIT |

### Color / palette / white balance (mostly classical)

- **Palette extraction** — classical k-means++ in LAB with ΔE2000. **kmeans-colors** (Rust, MIT) or **Pylette** (Python, MIT). No DL needed.
- **Auto white balance** — **Deep_White_Balance** (MIT, mahmoudnafifi). **mixedillWB** for mixed-illuminant. Research-grade but production-deployable.

### Alpha matte refinement (post-cutout)

- **BiRefNet-matting** (MIT) — drop-in.
- **SDMatte / SAMA / Matte-Anything** — SAM+matting hybrids, heavier.
- **VitMatte** (Apache) — trimap-based high quality.

---

## Single-tool synthesis — one pick per category

| Category | Pick | License | GPU need | CPU OK? | Why |
|---|---|---|---|---|---|
| Cutout — general | **BiRefNet** | MIT | 3.5GB FP16 @ 1024² | Yes (lite) | OSS SOTA; multiple sizes/variants |
| Cutout — portrait/hair | **BiRefNet-portrait** or **BEN2** | MIT | 4-5GB | Yes (BEN2) | CGM refiner wins on hair |
| Upscale — default photo | **Real-ESRGAN x4plus** | BSD | 2GB | Yes (NCNN) | Proven; runs everywhere |
| Upscale — quality-first | **DAT-2** (Phhofm `4xRealWebPhoto_v4_dat2`) | Apache | 6-8GB | Slow | +0.4 dB PSNR vs SwinIR |
| Upscale — anime/line | **Real-CUGAN** | MIT | 2-4GB | Yes (NCNN) | Sharper than waifu2x |
| Upscale — light/realtime | **SPAN** | Apache | <1GB | Yes | NTIRE 2024 winner |
| Upscale — generative input | **AuraSR-v2** | CC-BY-SA | <5GB | No | Built for AI-gen imagery |
| Vectorize | **vtracer** | MIT | None | Yes (fast) | Only viable OSS. **Flag: closed SOTA is meaningfully better on photos** |
| Face restore | **GFPGAN v1.4** | Apache | 4GB | Slow | ID-preserving; permissive |
| Cleanup / object remove | **LaMa** via **IOPaint** | Apache | 2GB | Yes | Reference impl |
| JPEG artifacts | **FBCNN** | Apache | <2GB | Yes | Blind, single model |
| Blind denoise | **SCUNet** | Apache | 2-4GB | Yes (small) | Best practical blind |
| Motion/defocus deblur | **NAFNet** | MIT | 4GB | Slow | SOTA, efficient |
| Multi-task restore | **Restormer** | MIT | 8GB | No | Only if needed |
| Matte refine | **BiRefNet-matting** | MIT | 4GB | Yes (lite) | Drop-in |
| Palette extraction | **kmeans-colors** / **Pylette** | MIT | Trivial | Yes | Classical |
| White balance | **Deep_White_Balance** | MIT | 2GB | Yes | Research-grade but stable |

### Where SOTA closed > OSS

1. **Photo vectorization** — Vectorizer.ai's Deep Vector Engine is meaningfully better than vtracer. There is **no OSS learned vectorizer in production-ready shape**. DeepSVG / PyTorch-SVGRender are research only. **Suggestion: ship vtracer; optional paid-API fallback for "quality" tier.**
2. **Generative SR with commercial license** — SUPIR is OSS quality leader but non-commercial. DiffBIR (Apache) is the best commercially-usable diffusion upscaler but is a clear step below SUPIR. **For commercial self-hosting: DiffBIR + Real-ESRGAN/DAT-2 hybrid.**

### Suggested integration architecture

- **Runtime** — `spandrel` for all PyTorch SR weights (`.pth`/`.safetensors`); `onnxruntime` for browser/edge; `realesrgan-ncnn-vulkan` binary for the fast path on Vulkan GPUs.
- **Inpainting/cleanup** — vendor IOPaint as a backend service.
- **Cutout** — BiRefNet via `transparent-background` or direct HF load. BEN2 as opt-in "hair quality" toggle.
- **Vectorization** — vtracer Rust crate (or WASM in-browser).
- **Face restoration** — GFPGAN v1.4 post-process after upscaling, gated by face detection.
- **JPEG/denoise pre-pass** — optional FBCNN → SCUNet before upscaling for low-quality inputs.

### Critical licensing avoid-list

For commercial self-hosting **do not ship**: BRIA RMBG-1.4/2.0 (CC BY-NC), CodeFormer (NTU non-commercial), SUPIR (non-commercial), StableSR (NTU), MAT (some weights CC-BY-NC), BEN2-Big (commercial-API only).

---

## Target architecture — one app, compute that resolves itself

> Supersedes the old "deliberate raster/vector boundary." That separation has been
> erased on purpose: the Process workspace ("Q") is dissolved into contextual editor
> panels, rasters are first-class canvas objects (`editor.placeImage()` → selectable/
> movable `<image>` nodes), mixed raster+vector documents work, and SVG export bakes
> `<image href>` to data-URIs to stay self-contained. The question is no longer "where
> does the pipeline live" but "where does the **compute** live."

The app is two things welded at one **HTTP API seam**: a deployment-agnostic frontend
(the editor — pure client-side ES modules, no build step) and a compute service (the
pipeline — Python + native model binaries). Because that seam is already HTTP, the
frontend doesn't care *where* the backend is. That single fact sets the whole shape.

**Shape: a full client app, served static, installable as a PWA.**

- **Hosting** — static on Cloudflare (Pages/R2). No *required* origin server. The `sw.js`
  PWA shell already exists; "install the app" = caching the frontend + model weights
  (offline-capable).
- **A full app, not a teaser** — persistence migrates server→browser (IndexedDB / OPFS /
  File System Access), so document / library / outputs / projects live client-side. This
  is the keystone that removes the origin. (Precedent: PNG export already rasterises in
  the browser via canvas.)
- **The compute "magic connection" = a client-side capability resolver.** Each stage
  declares a *capability* (vectorize / super-resolve / matte / inpaint); a resolver picks
  the provider automatically, best-first, across three rungs:

  1. **in-browser** — WASM (vtracer), ONNX / WebGPU (cutout, upscale). Always present,
     free, offline after install.
  2. **local power tier** — the existing Python `server.py` (full torch, batch, the tuned
     clean-engine + simplify refit), auto-discovered when it's running.
  3. **remote** — a hosted edge endpoint / Cloudflare Workers AI / bring-your-own-key
     (Replicate, fal, HF Inference).

  Same `apply(input, params)` contract at every rung, so the schema-driven UI never
  changes — only the provider behind a capability does.

**The Python server demotes** from "the product" to optional rung 2. It keeps everything
too heavy or too proprietary for a browser; it is no longer required for the core
experience.

**Why this is cheap to build on what exists** — the seams are already here: the
schema-driven stage registries (`RASTER_OPS` / `VECTORIZE_ENGINES`, each `{label, caps,
schema, apply}`), the location-agnostic HTTP boundary, and `sw.js`. The one genuinely new
piece is a thin **provider seam** in the client that resolves each capability to a
browser worker vs. a discovered backend vs. a remote. Registry, schema panels, and the
focused-run flow stay untouched.

**First slice (proves the shape):** (1) the provider seam + WASM vectorize — the signature
feature running with zero origin compute; (2) persistence → browser-local. Then ONNX
cutout, WebGPU upscale, and the remote rung plug into the same resolver.

**Honest constraints / open spikes:**

- **Local auto-discovery from the public origin is dead — RESOLVED BY SPIKE (2026-06-03,
  Chromium 148).** Findings: (a) mixed-content is *not* the wall — an `https://localhost`
  page reaches `http://localhost` fine (localhost is potentially-trustworthy; the request
  leaves as `opaque`), needing only CORS headers to *read* cross-port responses. (b) But a
  **public** `https` origin (the R2 case) reaching `http://localhost` is **blocked
  outright** — the request never leaves — and full CORS + `Access-Control-Allow-Private-
  Network: true` headers do **not** fix it. That's Chrome's newer **Local Network Access**
  permission model: a public site touching localhost needs a user *permission prompt*, not
  headers. So the R2 PWA can **not** silently discover/use a local backend.
  → **Design consequence:** rung 2 is not "cloud app finds your localhost." It's "**the
  local power tier serves the same frontend at `http://localhost`**" (server.py already
  does) — there, browser + local rungs all work *same-origin*, no CORS/PNA/LNA drama. The
  resolver simply detects "am I same-origin with a backend?" The R2 origin runs
  browser-rung + remote-rung only. (A tunnel/relay to an `https` public URL is the only way
  to bridge a cloud origin to your own box, and that's opt-in, not magic.)
- **Remote isn't free** — rung 3 is your GPU box (cost), Workers AI (per-call cost,
  limited catalog), or BYO-key. The browser rung is the free floor; remote is the opt-in
  ceiling.
- **Trace postprocessing is Python IP** — the clean engine (palette-quantize +
  `clean_color_trace`) and `tools/simplify_svg.py` refit need a JS port for full
  client-side *quality*; WASM vtracer alone is the lower-quality floor.

**Rejected packaging:** Electron (ships a second Chromium to render what the browser
already renders, and doesn't solve the Python+models packaging that is the actual hard
part). A downloadable binary (the static-edge PWA supersedes it). If a desktop-window
feel is ever wanted, pywebview / Tauri-sidecar beat Electron because the backend is
Python and the UI is already a webview's worth of HTML.

## Key references

BiRefNet — github.com/ZhengPeng7/BiRefNet · BEN2 — github.com/PramaLLC/BEN2 · BRIA RMBG-2.0 — huggingface.co/briaai/RMBG-2.0 · rembg — github.com/danielgatis/rembg · InSPyReNet — github.com/plemeri/InSPyReNet · Real-ESRGAN — github.com/xinntao/Real-ESRGAN · DAT — github.com/zhengchen1999/DAT · HAT — github.com/XPixelGroup/HAT · SwinIR — github.com/JingyunLiang/SwinIR · SPAN — github.com/hongyuanyu/SPAN · Real-CUGAN — github.com/bilibili/ailab · AuraSR — github.com/fal-ai/aura-sr · DiffBIR — github.com/XPixelGroup/DiffBIR · SUPIR — github.com/Fanghua-Yu/SUPIR · StableSR — github.com/IceClear/StableSR · Phhofm models — github.com/Phhofm/models · Upscayl — github.com/upscayl/upscayl · spandrel — github.com/chaiNNer-org/spandrel · OpenModelDB — openmodeldb.info · vtracer — github.com/visioncortex/vtracer · potrace — potrace.sourceforge.net · DeepSVG — github.com/alexandre01/deepsvg · GFPGAN — github.com/TencentARC/GFPGAN · CodeFormer — github.com/sczhou/CodeFormer · IOPaint — github.com/Sanster/IOPaint · LaMa — github.com/advimman/lama · MI-GAN — github.com/Picsart-AI-Research/MI-GAN · FBCNN — github.com/jiaxi-jiang/FBCNN · SCUNet — github.com/cszn/SCUNet · NAFNet — github.com/megvii-research/NAFNet · Restormer — github.com/swz30/Restormer · Deep_White_Balance — github.com/mahmoudnafifi/Deep_White_Balance · kmeans-colors — github.com/okaneco/kmeans-colors · img.ly background-removal-js — github.com/imgly/background-removal-js
