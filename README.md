# hector-vector

**A browser-based SVG vector editor with a raster→vector pipeline folded right in.** Draw and edit vectors, *or* drop in a raster and upscale → cut out → trace it on the same canvas. Self-hosted and local — nothing is uploaded; everything runs on your machine.

![The hector-vector editor: a vectorized trace on the canvas with the Layers and Properties panels docked](docs/editor-hero.png)

It began as a batch "image studio" and grew a real editor — and now the canvas is the product. Pen and shape tools, boolean operations, direct node editing, layers, and a dockable-panel workspace; with the upscale / cutout / vectorize pipeline available as a **contextual panel** on any raster you place. It is *not* a Photoshop clone — it does vector editing and a tight set of raster↔vector jobs really well.

## Highlights

- **Vector editing** — rectangle/ellipse/polygon/star shape tools, a pen tool, direct **node & handle** editing, and **boolean ops** (union / subtract / intersect / exclude) built on a marching-squares engine that refits results to *minimal cubic béziers* with crisp corners — not heavy polylines. Plus layers & groups, align/distribute/arrange, and live fill/stroke/opacity.
- **Dockable workspace** — every panel docks left/right, tears off to **float**, snaps into **locking-bezel groups** (resize/move together), or parks on a **shelf** as a square. Contextual panels (Processor, Colour) auto-appear when there's something to act on and tuck away when there isn't.
- **Edits scale to huge paths** — the node tool LOD-culls handles, so a 10,000-anchor traced path stays editable (zoom in for more detail) instead of refusing to open.
- **In-canvas raster pipeline** — place a PNG, then compose **Upscale** (Real-ESRGAN) → **Remove BG** (`rembg` or classical) → **Vectorize** (clean colour trace / VTracer / pixel-exact) as a stage strip. It runs in the background with live progress and never mutates your live document until you load the result.
- **Pixel Art → SVG** — recover the *native pixel grid* of (even upscaled, odd-resolution) pixel art and emit exact axis-aligned squares. No smoothing. (See below — it's the standout.)
- **Resolution-independent export** — rasterize any SVG back to PNG at *any* size, in the browser.

## Screenshots

| Place a raster, process it in place | Edit nodes on a traced path | Float & snap panels |
|---|---|---|
| ![A raster placed on the canvas with the contextual Processor stage strip](docs/editor-processor.png) | ![The node tool editing bézier anchors on a path, LOD-limited on a dense trace](docs/editor-nodes.png) | ![Two panels snapped into a floating locking-bezel group over the canvas](docs/editor-panels.png) |
| The **Processor** appears on a selected raster: Upscale → Remove BG → Vectorize, run to canvas. | Direct anchor/handle editing; dense traces stay editable (*"14 of 21 anchors — zoom in for the rest"*). | Panels tear off, snap into bezel-locked groups, or shelve as squares. |

## Quick start

```bash
git clone https://github.com/asuramaya/hector-vector
cd hector-vector
./install.sh                      # creates .venv, installs deps, runs a smoke test
./run.sh                          # serves http://localhost:2002
```

`./install.sh --desktop` also installs the app-launcher shortcut; `--app` opens the standalone window when done. Prefer your own environment? `pip install -r requirements.txt` still works — `run.sh` uses `.venv` when present and otherwise falls back to system `python3`.

Open **http://localhost:2002**. Draw with the shape/pen tools, or drop an image onto the canvas (or into the Library), select it, and use the **Processor** panel to upscale / cut out / vectorize it.

> First run downloads the heavy external tools into `./tools` and `./.venv` automatically — see [How dependencies bootstrap](#how-dependencies-bootstrap). They are **not** vendored in this repo.

### Updating

`hector-vector` updates in place from this repo. In the app: **Settings → Updates → Check for updates**; if a newer release exists and your working tree is clean, hit **Update & restart** (runs `git pull` + re-syncs deps). Or `git pull && ./install.sh` yourself. Maintainers cut a release with `./scripts/release.sh X.Y.Z` (bumps `VERSION`, tags `vX.Y.Z`, pushes — the tag triggers the release workflow).

## The editor

The canvas is a live SVG document; everything you see is real DOM you can inspect.

- **Tools** — Select (move/scale/rotate via the bounding box), Node (direct anchor + bézier-handle editing), Pen (draw paths, Ctrl/Cmd for a temporary direct-select), and shape tools (rectangle, ellipse, polygon, star).
- **Booleans** — union / subtract / intersect / exclude on any selection. The engine traces the boundary of the combined region with marching squares (robust for any overlap or winding) and refits each loop to minimal cubics, so a boolean result is a handful of smooth curves rather than hundreds of segments.
- **Layers & structure** — a Layers panel with reorder, group/ungroup, rename, lock, and merge; even-odd vs nonzero fill control.
- **Panels** — Properties, Colour, Layers, History, Library, Processor, Jobs, and Info. Dock them, float them, snap them into groups, or shelve them. Right-click a panel header to shelve it; right-click a shelf square for open/float/dock options.
- **Undo/redo** — snapshot-based history over the whole document.

## The raster→vector pipeline

Drop a raster onto the canvas (it becomes a selectable, movable `<image>` node) and the **Processor** panel becomes relevant. It's a composable stage strip:

- **Upscale** — GPU super-resolution via Real-ESRGAN (NCNN/Vulkan), 2×/3×/4×, photo & anime models.
- **Remove BG** — background removal: classical (fast, numpy) **or** AI (`rembg`: U²-Net, ISNet, **BiRefNet**, silueta, portrait/anime). Greenscreen chroma-key keying too.
- **Vectorize** — one resolver picks the engine: a **clean colour trace** (hard k-means palette + per-colour mask trace — drops the background, keeps pure ink colours, preserves letter counters/holes), **VTracer** for general curves, or **pixel-exact** for pixel art.

Stages compose (toggle any on/off, reorder), run in a background job queue with live progress, and target either the selected raster or the whole Library (explicit batch toggle). A run writes outputs without disturbing your live canvas — you choose when to load the result back in.

## The standout: Pixel Art → SVG

Most "vectorizers" smooth pixel art into mush. This one does the opposite: it recovers the original pixel grid and emits perfect squares.

![A soft raster pixel sprite recovered to an exact vector](docs/demo.png)

1. **Grid recovery.** Block-consistency detection nails clean nearest-neighbour integer upscales exactly (e.g. a 16×16 Minecraft texture saved at 256×256 → recovered to 16×16). For odd, non-integer scales it uses a spectral (FFT) detector, and because upscaling is virtually always uniform, a confident axis lends its scale to a weak one. True gradients/photos are left untouched.
2. **Colour recovery.** Per cell: mode (default) / median / center, sampled over an eroded interior so anti-aliased borders don't leak. Optional palette quantization and corner-colour key-out.
3. **Square emission.** `merged` rects (default), per-colour `path` (fewest nodes), or one rect per pixel — all pixel-exact, with `shape-rendering="crispEdges"` and native-unit coordinates so they scale forever.

Heavily *bilinear*-resampled art is genuinely ambiguous; set **Native size (cells)** in the trace settings to force the grid.

```bash
# examples/fire_h_x11.png is a 264×330 nearest upscale of an original 24×30 sprite.
# Drop it on the canvas, open Processor → Vectorize (pixel), Run.
# Then Export the result to PNG at 512, 1024, 4096… — crisp at any size.
```

## Requirements

- **Python 3.10+** with `pip`. The base runtime (`Pillow`, `numpy`, `scipy`) is installed by `./install.sh` (or `pip install -r requirements.txt`).
- For **Upscale / Trace**: `curl` + `unzip` (Real-ESRGAN download) and `cargo` (builds VTracer). Installed on first launch or via the Settings buttons.
- For **AI Cutout**: nothing up front — click *Install rembg* in Settings to pull `rembg[cpu]` into a project-local `./.venv` (~500 MB, one-time).
- For **Export PNG of curved (VTracer) SVGs**: optional `cairosvg` (`pip install cairosvg`, needs system libcairo). Pixel-art SVG export needs nothing extra — it's pure Pillow.
- A Vulkan-capable GPU helps Real-ESRGAN but isn't mandatory.

### How dependencies bootstrap

`hector-vector` ships **code only**. On launch (and via retry buttons in Settings) it fetches what's missing:

| Tool | How it's obtained | License |
|------|-------------------|---------|
| Real-ESRGAN NCNN Vulkan | downloaded from the project's GitHub releases into `./tools` | BSD-3-Clause |
| VTracer | `cargo install vtracer --root ./tools/cargo` | MIT |
| rembg (+ ONNX models) | `pip install 'rembg[cpu]' onnxruntime` into `./.venv`; model weights download to `~/.u2net` on first use | MIT (models: Apache-2.0 / MIT) |
| cairosvg *(optional)* | `pip install cairosvg` | LGPL-3.0 |

## Architecture

No build step anywhere — the frontend is hand-written ES modules served as-is.

- **`src/`** — the dependency-free vanilla-JS frontend:
  - **`src/hv/`** — a pure, side-effect-free library: geometry & path math (`path`, `transform`, `shapes`, `shapegen`), colour (`color`), raster sampling (`raster`), and the marching-squares boolean/contour engine with its shared curve-fit core (`contour`, `fitcurve`).
  - **`src/editor.js`** — the live-SVG editing core: selection, the tools, snapshot undo, layers, and the boolean operations.
  - **`src/app.js`** — the app shell: the dockable-panels system (`window.__docks`), the Library, the Processor pipeline UI, Info, and client-side PNG export.
- **`server.py`** — a single-file backend on Python's stdlib `http.server`, with a threaded job queue and a JSON API (`/api/run/pipeline`, `/api/vectorize/engines`, `/api/raster-ops`, `/api/work-items`, `/api/install/*`, …). It's organized around two pluggable registries: **vectorize engines** (`clean` / `vtracer` / `pixel`) behind one resolver, and **raster ops** (`upscale` / `removebg`). No web framework.
- **`engine.py`, `mask_trace_prep.py`** — classical mask/cutout image ops.
- **`tools/`** — our worker scripts (`pixelvec.py`, `svg_render.py`, `ai_cutout.py`, `simplify_svg.py`); external binaries land here at runtime.
- Vector documents save as **`.hv` projects** under `outputs/canvas/`; pipeline outputs under `outputs/<process>-<timestamp>/`. Your source images live in `inputs/` (or any folder you point the Library at).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `2002` | Server port (`PORT=8080 ./run.sh`). |
| `HECTOR_CONCURRENCY` | `1` | Parallel jobs. Raise carefully — GPU/RAM bound. |

## Credits

Built on excellent open-source work: [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), [VTracer](https://github.com/visioncortex/vtracer), [rembg](https://github.com/danielgatis/rembg) & the U²-Net / [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) model families, [Pillow](https://python-pillow.org/), and [NumPy](https://numpy.org/). See [`ROADMAP.md`](ROADMAP.md) for the broader landscape and what's planned next.

## License

[MIT](LICENSE) © 2026 asuramaya. Bundled-at-runtime tools keep their own licenses (see the table above).
