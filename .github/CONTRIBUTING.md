# Contributing to hector-vector

Thanks for your interest. This is a small, dependency-light project, and contributions that keep it that way are very welcome.

## Setup

```bash
git clone https://github.com/asuramaya/hector-vector
cd hector-vector
pip install -r requirements.txt
./run.sh        # http://localhost:2002
```

The external tools (Real-ESRGAN, VTracer, rembg) install themselves on first run. You don't need to vendor anything.

## Where things live

- **`src/`** is the frontend: `src/hv/` (a pure geometry/colour library), `src/editor.js` plus per-tool mixins under `src/editor/tools/` (the live-SVG editing core), and `src/app.js` plus `src/ui/` (app shell, dockable panels, colour picker, menus, pipeline UI, touch shells).
- **`web/`** is the eight files the browser asks for: `index.html`, `compare.html`, `style.css`, `sw.js`, the manifest, `_headers`, `robots.txt`, `llms.txt`. It doubles as the deploy root, so its contents land at the top of `dist/`. The URLs are unchanged by that, and they need to stay unchanged: `sw.js` in particular must be served from the origin root, or the service worker's scope quietly shrinks to its own directory.
- **`server.py`** is a façade over the `hvserver/` package. **`tools/`** holds the standalone worker scripts. **`scripts/`** holds maintainer tooling (release, cloud deploy).

## Ground rules

- **No build step, no frameworks.** The backend is stdlib `http.server`; the frontend is hand-written ES modules served as-is. Keep it that way unless there's a strong reason.
- **New worker scripts** go in `tools/` as standalone, CLI-testable modules (see `pixelvec.py`, `svg_render.py`). Pure `numpy`/`Pillow` is preferred, so they run without a venv.
- **Adding a processing stage?** Processing is one generalized pipeline (`run_pipeline`), and the old per-process endpoints are gone. Extend `_pipeline_stages`/`run_pipeline` on the backend and the Processor stage strip on the frontend (`PIPELINE_STAGES` + `renderStageSettings`/`buildProcessorRail` in `src/app.js`). A new vectorize engine or background-removal backend is just a new entry in the `VECTORIZE_ENGINES` / `RASTER_OPS` registry, and the resolver and schema endpoints pick it up from there.
- **Don't commit** anything under `inputs/`, `outputs/`, `.venv/`, or the vendored binaries. `.gitignore` already covers them. Don't commit personal images.

## Before you open a PR

```bash
python3 tests/test_imports.py                                  # server import guard (CI gate)
ESLINT_USE_FLAT_CONFIG=false npx --yes eslint@8.57.1 --no-eslintrc -c tests/eslintrc.json --ext .js src/   # JS no-undef (CI gate)
python3 tests/test_smoke.py                                    # backend smoke suite
python3 tests/test_capabilities.py                             # capability + analyzer/router suite
python3 tests/test_text.py                                     # text → outlines guard
./run.sh &                                                     # the E2E suite needs the app running
.venv-e2e/bin/python tests/e2e/editor_e2e.py                   # editor end-to-end (real browser)
```

The **CI gates** are cheap and build-free, and they catch the god-file-split regression class, so run them before pushing. `tests/test_imports.py` finds a name used but never imported on the Python side; the eslint `no-undef` run does the same for JS. Both are wired into `.github/workflows/ci.yml`.

The full editor E2E stays a **local** gate, because it needs the ML toolchain that is deliberately kept out of `requirements.txt`. It drives a real headless browser through Playwright against a running server, so set up a one-time `.venv-e2e` with `playwright` if you don't have one. Regenerate the README screenshots with `tests/e2e/screenshots.py` when the UI changes; note that the phone shots need a real emulated phone context (`is_mobile` + `has_touch`), since a desktop page resized to 390px is not the shell a phone actually gets. For algorithm changes, such as the pixel-grid detector, add or update a quick check against the `examples/` sprites.

## Reporting issues

Include the image (or its dimensions and format), the process and settings used, and the job log from the **Jobs** panel. For "wrong output" reports, the input image is usually essential.
