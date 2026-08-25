# Roadmap: AI Image-Processing Roll-Up

Research scan of free / freemium online AI image tools, the OSS models that power them, and what hector-vector should adopt to become the one self-hosted alternative.

## Executive summary

Across the categories we care about, the OSS ecosystem is now strong. Most closed offerings are thin wrappers over OSS, internal forks of OSS architectures (BiRefNet, Real-ESRGAN, LaMa, RRDBNet), or marginal wins that don't justify a paid API. The clear exception is **AI vectorization** (Vectorizer.ai, Recraft): `vtracer` is the best OSS option, but it uses classical clustering rather than learned shape priors.

**Licensing landmines.** Performant but commercially restricted: CodeFormer, SUPIR, StableSR, BRIA RMBG-1.4/2.0, MAT, BEN2-Big.

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
| img.ly background-removal-js | Quantized U²-Net (silueta) | High (itself OSS) | Itself (MIT) |
| Cleanup.pictures / Magic Eraser | LaMa | High | LaMa |
| Fotor / MagicStudio / Imagine.art / Picsart Cleanup | Proprietary; functionally equivalent to BiRefNet/LaMa | Medium | BiRefNet + LaMa |

**OSS SOTA picks** (in order of preference):

- **BiRefNet** (MIT), `ZhengPeng7/BiRefNet`. Current OSS SOTA. Variants: general 1024², HR 2048², dynamic multi-res, portrait, matting, lite (Swin-Tiny, CPU). FP16 ~57ms on a 4090 at 1024², 3.5GB VRAM.
- **BEN2** (MIT), `PramaLLC/BEN2`. Confidence-Guided Matting refiner. Best at hair edges and 4K. The base model is OSS; the "Big" variant is commercial API only.
- **InSPyReNet** (MIT), `plemeri/InSPyReNet`. Image pyramid SOD. Fast, well-supported by `transparent-background`.
- **BRIA RMBG-2.0** (CC BY-NC). BiRefNet arch plus BRIA's proprietary 15k-image set. Best in many benchmarks, and **unusable commercially without a paid agreement.**
- **U²-Net / IS-Net / silueta / MODNet** (Apache). Older, &lt;100MB, near-realtime on CPU.
- **SAM 2 / SAM 3** (Apache). Promptable; combine with SDMatte / SAMA / Matte-Anything for matting refinement.

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
| AuraSR (fal.ai) | Open reproduction of GigaGAN, 600M params, 4× one-shot | High (open-sourced) | Itself (CC-BY-SA weights / Apache code) |

**OSS SOTA picks:**

- **General photo, balanced.** **Real-ESRGAN x4plus** (BSD), the default, with NCNN/Vulkan everywhere. `RealESRGAN-General-WDN-4xV3` is a 5MB CPU variant.
- **Quality-first.** **DAT-2** or **HAT** (Apache). DAT-2 is 11M params at 27.86 PSNR on Urban100×4; HAT is 20.8M at 27.97. Both beat SwinIR. Phhofm's `4xRealWebPhoto_v4_dat2` and `4xNomos2_hq_dat2` are exceptional on web-degraded inputs.
- **Diffusion (commercially usable).** **DiffBIR** (Apache), the closest OSS to Magnific/SUPIR that allows commercial use. SUPIR and StableSR are research-only.
- **Anime / line art.** **Real-CUGAN** (MIT), fastest and sharpest. Fall back to Real-ESRGAN_anime_6B or waifu2x.
- **JPEG-degraded inputs.** `4xRealWebPhoto_v4_dat2` or `1xDeJPG_realplksr_otf`, both trained with recompression in the degradation pipeline.
- **Generative / synthetic.** **AuraSR-v2** (CC-BY-SA weights / Apache code), designed for upscaling AI-generated imagery.
- **Lightweight / real-time / CPU.** **SPAN** (Apache, NTIRE 2024 winner) or **SAFMN++**.

Use **spandrel** (`chaiNNer-org/spandrel`, MIT) as the runtime. It auto-detects Real-ESRGAN/SwinIR/HAT/DAT/SPAN/OmniSR/RealPLKSR/MOSR/ATD weights, so a model swap is config-only.

### Vectorization (raster → SVG)

| Tool | Approach | Confidence | OSS equivalent |
|---|---|---|---|
| Vectorizer.ai | "Deep Vector Engine": learned shape priors + classical geometry; fits circles, ellipses, rounded rects natively | High (documented) | vtracer + custom postprocessing (no learned OSS) |
| Recraft (vectorize) | Proprietary; likely Vectorizer.ai-style hybrid | Medium | vtracer |
| AI Vector / aivector.ai / kittl / svgconverter / vectorizer.io | Mostly thin wrappers; many proxy vtracer or potrace | Medium-high | vtracer itself |

**OSS pick: vtracer** (MIT, Rust), the only viable OSS for colour vectorization. Linear-time clustering, full-colour photos, three curve-fitting modes (pixel/polygon/spline). Ships as a Rust crate, PyPI package, WASM build and CLI. Output runs ~30-70% smaller than Illustrator's Image Trace.

- **potrace** (GPL). Best for B&W, line art and logos.
- **AutoTrace** (GPL). Rarely better than vtracer.
- **DeepSVG / PyTorch-SVGRender.** Research-grade, not production-ready.

**This is the one category where there is no good OSS replacement for the SOTA closed product.**

### Inpainting / cleanup / object removal

| Tool | Model | Confidence | OSS |
|---|---|---|---|
| Clipdrop Cleanup | Originally LaMa (cleanup.pictures acquisition); now likely SD-based for hard cases | High (LaMa heritage) | LaMa, MI-GAN, MAT |
| Magic Eraser, Inpaint.io, cleanup.pictures | LaMa | High | LaMa |
| Photoroom retouch, PicWish remove object, Picsart Cleanup | Proprietary; functionally LaMa or LaMa+SD | Medium | LaMa |

**OSS pick:** vendor **IOPaint** (Apache, formerly lama-cleaner) as the service backend. It already wraps LaMa, MI-GAN, MAT and SD-based models behind one API.

- **LaMa** (Apache). The default: fast, good up to ~2K, no GPU required.
- **MI-GAN** (MIT). Mobile-grade, ~10× smaller and faster than LaMa at comparable FID.
- **MAT** (CC BY-NC). Large masks; non-commercial only.
- **PowerPaint / BrushNet.** Diffusion-based, needed for semantic completion but heavy.

### Face restoration

| Tool | Model | OSS |
|---|---|---|
| Remini, Reface.ai, every "AI photo restorer" | GFPGAN or CodeFormer + Real-ESRGAN for background | GFPGAN v1.4 (Apache), CodeFormer (NC), RestoreFormer++ (MIT-ish), GPEN (Apache) |

**OSS pick: GFPGAN v1.4** (Apache, TencentARC) as the primary. It's conservative, preserves identity, and runs about 6s/face on a consumer GPU. Pair it with Real-ESRGAN for non-face regions, as the official GFPGAN repo does.

CodeFormer handles extreme blur reconstruction, *only if* non-commercial is acceptable. **RestoreFormer++** is the permissive alternative.

### Denoise / artifact removal / deblur

| Use case | OSS pick | License |
|---|---|---|
| Blind real-world denoise | **SCUNet** (`scunet_color_real_psnr`) | Apache |
| Controllable noise level | **DRUNet** | MIT |
| JPEG artifacts (blind, no QF) | **FBCNN** | Apache |
| Motion/defocus deblur | **NAFNet** (SOTA on GoPro 33.69 dB, ~10% of Restormer's compute) | MIT |
| Multi-task (rain/snow/blur/noise) | **Restormer** | MIT |

### Colour / palette / white balance (mostly classical)

- **Palette extraction.** Classical k-means++ in LAB with ΔE2000. Use **kmeans-colors** (Rust, MIT) or **Pylette** (Python, MIT). No deep learning needed.
- **Auto white balance.** **Deep_White_Balance** (MIT, mahmoudnafifi), with **mixedillWB** for mixed illuminants. Research-grade but production-deployable.

### Alpha matte refinement (post-cutout)

- **BiRefNet-matting** (MIT). Drop-in.
- **SDMatte / SAMA / Matte-Anything.** SAM+matting hybrids, heavier.
- **VitMatte** (Apache). Trimap-based, high quality.

---

## Single-tool synthesis: one pick per category

| Category | Pick | License | GPU need | CPU OK? | Why |
|---|---|---|---|---|---|
| Cutout, general | **BiRefNet** | MIT | 3.5GB FP16 @ 1024² | Yes (lite) | OSS SOTA; multiple sizes/variants |
| Cutout, portrait/hair | **BiRefNet-portrait** or **BEN2** | MIT | 4-5GB | Yes (BEN2) | CGM refiner wins on hair |
| Upscale, default photo | **Real-ESRGAN x4plus** | BSD | 2GB | Yes (NCNN) | Proven; runs everywhere |
| Upscale, quality-first | **DAT-2** (Phhofm `4xRealWebPhoto_v4_dat2`) | Apache | 6-8GB | Slow | +0.4 dB PSNR vs SwinIR |
| Upscale, anime/line | **Real-CUGAN** | MIT | 2-4GB | Yes (NCNN) | Sharper than waifu2x |
| Upscale, light/realtime | **SPAN** | Apache | <1GB | Yes | NTIRE 2024 winner |
| Upscale, generative input | **AuraSR-v2** | CC-BY-SA | <5GB | No | Built for AI-gen imagery |
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

### Where SOTA closed beats OSS

1. **Photo vectorization.** Vectorizer.ai's Deep Vector Engine is meaningfully better than vtracer, and there is **no OSS learned vectorizer in production-ready shape**. DeepSVG and PyTorch-SVGRender are research only. **Suggestion: ship vtracer, with an optional paid-API fallback for a "quality" tier.**
2. **Generative SR with a commercial licence.** SUPIR is the OSS quality leader but is non-commercial. DiffBIR (Apache) is the best commercially usable diffusion upscaler, and it sits a clear step below SUPIR. **For commercial self-hosting: a DiffBIR + Real-ESRGAN/DAT-2 hybrid.**

### Suggested integration architecture

- **Runtime.** `spandrel` for all PyTorch SR weights (`.pth`/`.safetensors`), `onnxruntime` for browser/edge, and the `realesrgan-ncnn-vulkan` binary for the fast path on Vulkan GPUs.
- **Inpainting/cleanup.** Vendor IOPaint as a backend service.
- **Cutout.** BiRefNet via `transparent-background` or a direct HF load, with BEN2 as an opt-in "hair quality" toggle.
- **Vectorization.** The vtracer Rust crate, or WASM in-browser.
- **Face restoration.** GFPGAN v1.4 as a post-process after upscaling, gated by face detection.
- **JPEG/denoise pre-pass.** Optional FBCNN → SCUNet before upscaling, for low-quality inputs.

### Critical licensing avoid-list

For commercial self-hosting, **do not ship**: BRIA RMBG-1.4/2.0 (CC BY-NC), CodeFormer (NTU non-commercial), SUPIR (non-commercial), StableSR (NTU), MAT (some weights CC-BY-NC), BEN2-Big (commercial-API only).

---

## Architecture: download-and-local

> Supersedes the old "deliberate raster/vector boundary." That separation has been
> erased on purpose: the Process workspace ("Q") is dissolved into contextual editor
> panels, rasters are first-class canvas objects (`editor.placeImage()` gives you
> selectable, movable `<image>` nodes), mixed raster+vector documents work, and SVG
> export bakes `<image href>` to data-URIs to stay self-contained.

hector-vector is a **download-and-local app**. Clone it, run it on your own machine. It is two pieces welded at one **localhost HTTP seam**: a frontend (the editor, pure client-side ES modules, no build step) and a compute service (`server.py`, with Python, numpy/PIL/torch/spandrel, and native model binaries including the bundled vtracer). The browser is the UI. The Python server is where all compute lives, and it is the **canonical implementation of every stage**. The seam is always same-origin `127.0.0.1`, so there is no CORS, auth or transport complexity to speak of; the frontend just talks to localhost.

**This is deliberate, and it's the cheap way to stay one surface.** Every algorithm is implemented exactly once, in Python. The single-dispatch property holds, since `vectorize_svg` feeds both live-preview and commit, so the two cannot drift, and there is nothing to keep in parity because there is no second implementation. Mature libraries (numpy, PIL, torch, spandrel, native vtracer) are used as-is: no reimplementation, no cross-runtime determinism problems.

**Distribution.** Today it's clone-and-run: a Python env, `server.py`, and the editor in a browser. If a desktop-window feel is ever wanted, use **pywebview** or a **Tauri sidecar** wrapping the same Python backend, and *not* Electron, which ships a second Chromium to render what the browser already renders and still doesn't package Python and the models, which is the actual hard part. A packaged build would bundle the Python runtime plus weights, and that bundling is the real distribution work, not the UI shell.

**What staying local keeps simple:** schema authority stays server-side (`/api/raster-ops` and `/api/vectorize/engines` drive the UI from one source of truth); the no-build ethos survives, with no WASM/ONNX/Web-Worker plumbing client-side; the job queue, batch "Run library", and the self-update check all stay meaningful for a local install; and model licensing stays a *run/bundle* constraint (the avoid-list above) rather than a ship-weights-to-every-visitor *redistribution* one. The browser stays main-thread and thin.

### Why not the edge (considered and rejected, 2026-06-04)

A static-edge PWA (serve the frontend from Cloudflare R2/Pages, run compute client-side via WASM/ONNX, demote Python to an optional auto-discovered tier) was explored in depth and dropped:

- **The "seamless connection to your hardware" dies at the browser's security model.**
  Spike-confirmed on Chromium 148: a **public `https` origin cannot reach `http://localhost`**.
  Chrome's Local Network Access blocks it outright, and CORS plus `Access-Control-Allow-
  Private-Network: true` headers do **not** fix it, because it needs a user permission
  prompt rather than headers. So a cloud-hosted app can't silently use your local GPU box,
  and the marquee feature would need a tunnel or an "open the app from your own machine"
  mode-switch, which is precisely the thing it was supposed to avoid. ("Basically
  serverless" isn't clean either: a Worker would still have to broker remote-inference API
  keys, since secrets can't ship to the browser.)
- **Reaching even the browser-only floor is a full compute-stack rewrite** into a weaker
  substrate: vtracer→WASM, the clean engine and `_km_palette` k-means→JS, ESRGAN/rembg→
  onnxruntime-web, persistence→IndexedDB/OPFS, the schema registries→client. An enormous
  front-loaded bill whose payoff is a *distribution* change, not a single new capability.
- **The two-surface maintenance burden is *caused by* the edge.** "Rungs are
  interchangeable" needs either two byte-identical implementations, which is a per-algorithm
  parity treadmill, and byte-parity between numpy and a JS port isn't even portably
  achievable (`pow`/`hypot` aren't IEEE-correctly-rounded, so V8 and numpy diverge in the
  last ULP; on tiny or dense paths that ULP flips a discrete curve-fit split into a
  *different node count*, not merely sub-pixel jitter). Or it needs one implementation that
  every rung runs. Staying local already gives the one-implementation outcome, for free.

Net: the edge is a *distribution* ambition that costs a full rewrite and fights the browser to deliver its one differentiated feature. Not worth it; hector-vector stays local. The `sw.js` shell, browser-side PNG export, and the location-agnostic HTTP boundary all remain fine as they are. Nothing here requires undoing them. They just aren't a path to a serverless product.

### What shipped instead: the browser build (2026-07)

All of the above still stands, and **[hector-vector.com](https://hector-vector.com) does not contradict it**, because it moves no compute to the edge. The rejected idea was porting the *pipeline* (vtracer, k-means, ESRGAN, rembg) into WASM/ONNX so the cloud could do the AI work. That is still rejected, for every reason listed.

What shipped is the part that never needed Python at all. The **vector editor is already ~100% client-side**: SVG in the DOM, geometry in `src/hv/`, PNG export on a canvas. Serving it from Cloudflare Pages therefore costs *no rewrite*. Same `src/` tree, no build step, no second implementation, no parity treadmill. `app.html` detects the deployed host and gates the three server-backed panels (Processor / Library / Jobs) behind a "get the desktop app" CTA. Everything else just runs.

### Why not the companion bridge either (considered and rejected, 2026-08-25)

"Connect the desktop app from the browser" — the browser editor discovering and calling out to a companion server on your own machine over the local network — sat in the unfinished list with its spike already done: CORS/PNA headers work, the permission grant survives a reload. This is exactly the "open the app from your own machine" mode-switch the edge rejection above already named as the unsatisfying fallback, and pressed on directly, it didn't clear the bar:

- **It doesn't remove the install.** The only way the bridge has anything to connect to is a desktop install already running. The win it offers past that point is narrower than it sounds: not "the free browser build gets the AI pipeline," but "you don't have to alt-tab to the app window you already installed."
- **Desktop users who've already installed won't route through the browser to get to it.** If launching locally is one command away, going to hector-vector.com first just to bridge back to the thing sitting on your own machine is a longer path to the same place, not a shorter one.
- **Mobile is the one case where the browser build is genuinely the whole story** — no install path exists there at all — and mobile never touches this feature anyway; there's no local companion server to discover on a phone.
- **Building it properly grows the surface the free build was designed to avoid.** A bridge worth trusting eventually wants auth, a persistent notion of "this browser is paired with that machine," maybe account-level state — exactly the account/storage system the cloud-mode plan ([`docs/mcp-server.md`](mcp-server.md) sibling doc, and the original serverless-editor plan) deliberately kept out of scope to stay a static, no-account Pages deploy.

Net: same shape as the edge-compute rejection above, for the same underlying reason — it's a *distribution* convenience that costs real scope and doesn't move the free build's actual ceiling (the AI pipeline still needs a real machine to run on). Removed from the roadmap rather than left parked; the spike's findings (CORS/PNA headers, permission-grant persistence) still stand as a reference if a future case makes the trade worth it again.

So the split is clean, and it is the one this document argued for all along:

- **The browser** gets the editor, free, with nothing to install and nothing leaving the tab.
- **The desktop** keeps the compute, because that is where the compute belongs.

The one genuinely edge-shaped ambition, a cloud page driving your *local* GPU, remains blocked exactly where the spike left it, at Local Network Access. `tests/companion-spike.html` is the probe for whether that ever becomes viable.

## Key references

BiRefNet: github.com/ZhengPeng7/BiRefNet · BEN2: github.com/PramaLLC/BEN2 · BRIA RMBG-2.0: huggingface.co/briaai/RMBG-2.0 · rembg: github.com/danielgatis/rembg · InSPyReNet: github.com/plemeri/InSPyReNet · Real-ESRGAN: github.com/xinntao/Real-ESRGAN · DAT: github.com/zhengchen1999/DAT · HAT: github.com/XPixelGroup/HAT · SwinIR: github.com/JingyunLiang/SwinIR · SPAN: github.com/hongyuanyu/SPAN · Real-CUGAN: github.com/bilibili/ailab · AuraSR: github.com/fal-ai/aura-sr · DiffBIR: github.com/XPixelGroup/DiffBIR · SUPIR: github.com/Fanghua-Yu/SUPIR · StableSR: github.com/IceClear/StableSR · Phhofm models: github.com/Phhofm/models · Upscayl: github.com/upscayl/upscayl · spandrel: github.com/chaiNNer-org/spandrel · OpenModelDB: openmodeldb.info · vtracer: github.com/visioncortex/vtracer · potrace: potrace.sourceforge.net · DeepSVG: github.com/alexandre01/deepsvg · GFPGAN: github.com/TencentARC/GFPGAN · CodeFormer: github.com/sczhou/CodeFormer · IOPaint: github.com/Sanster/IOPaint · LaMa: github.com/advimman/lama · MI-GAN: github.com/Picsart-AI-Research/MI-GAN · FBCNN: github.com/jiaxi-jiang/FBCNN · SCUNet: github.com/cszn/SCUNet · NAFNet: github.com/megvii-research/NAFNet · Restormer: github.com/swz30/Restormer · Deep_White_Balance: github.com/mahmoudnafifi/Deep_White_Balance · kmeans-colors: github.com/okaneco/kmeans-colors · img.ly background-removal-js: github.com/imgly/background-removal-js
