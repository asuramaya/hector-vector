# Contributing to hector-vector

Thanks for your interest! This is a small, dependency-light project — contributions that keep it that way are very welcome.

## Setup

```bash
git clone https://github.com/asuramaya/hector-vector
cd hector-vector
pip install -r requirements.txt
./run.sh        # http://localhost:2002
```

The external tools (Real-ESRGAN, VTracer, rembg) install themselves on first run; you don't need to vendor anything.

## Ground rules

- **No build step, no frameworks.** The backend is stdlib `http.server` (split into `hvserver/` modules behind a `server.py` façade); the frontend is hand-written ES modules served as-is — `src/hv/` (pure geometry/colour library), `src/editor.js` + per-tool mixins under `src/editor/tools/` (the live-SVG editing core), and `src/app.js` + `src/ui/` (the app shell / dockable panels / colour picker / menus / pipeline UI). Keep it that way unless there's a strong reason.
- **New worker scripts** go in `tools/` as standalone, CLI-testable modules (see `pixelvec.py`, `svg_render.py`). Pure `numpy`/`Pillow` is preferred so they run without a venv.
- **Adding a processing stage?** Processing is one generalized pipeline (`run_pipeline` in `server.py`); the old per-process endpoints are gone. Extend `_pipeline_stages`/`run_pipeline` on the backend and the Processor stage strip on the frontend (`PIPELINE_STAGES` + `renderStageSettings`/`buildProcessorRail` in `src/app.js`). A new vectorize engine or background-removal backend is just a new entry in the `VECTORIZE_ENGINES` / `RASTER_OPS` registry in `server.py` — the resolver and schema endpoints pick it up.
- **Don't commit** anything under `inputs/`, `outputs/`, `.venv/`, or the vendored binaries — `.gitignore` already covers them. Don't commit personal images.

## Before you open a PR

```bash
python3 -c "import ast; ast.parse(open('server.py').read())"   # backend parses
python3 tests/test_imports.py                                  # server import guard (CI gate)
ESLINT_USE_FLAT_CONFIG=false npx --yes eslint@8.57.1 --no-eslintrc -c tests/eslintrc.json --ext .js src/   # JS no-undef (CI gate)
python3 tests/test_smoke.py                                    # backend smoke suite
./run.sh &                                                     # the E2E suite needs the app running
.venv-e2e/bin/python tests/e2e/editor_e2e.py                   # editor end-to-end (real browser)
```

The two **CI gates** (`tests/test_imports.py` + the eslint `no-undef` run, both wired into `.github/workflows/ci.yml`) are cheap, build-free, and catch the god-file-split regression class — run them before pushing. The full editor E2E is a local gate (it needs the ML toolchain that's deliberately kept out of `requirements.txt`).

The editor E2E (`tests/e2e/editor_e2e.py`) drives a real headless browser via Playwright against a running server — set up a one-time `.venv-e2e` with `playwright` if you don't have it. Regenerate the README screenshots with `tests/e2e/screenshots.py` when the UI changes. For algorithm changes (e.g. the pixel-grid detector), also add or update a quick check against the `examples/` sprites.

## Reporting issues

Include the image (or its dimensions/format), the process and settings used, and the job log from the **Jobs** panel. For "wrong output" reports, the input image is usually essential.
