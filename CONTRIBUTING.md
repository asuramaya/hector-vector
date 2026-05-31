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

- **No build step, no frameworks.** The backend is stdlib `http.server` (`server.py`); the frontend is vanilla JS (`app.js`). Keep it that way unless there's a strong reason.
- **New worker scripts** go in `tools/` as standalone, CLI-testable modules (see `pixelvec.py`, `svg_render.py`). Pure `numpy`/`Pillow` is preferred so they run without a venv.
- **Adding a processing stage?** Processing is one generalized pipeline (`run_pipeline` in `server.py`); the old per-process endpoints are gone. Extend `_pipeline_stages`/`run_pipeline` on the backend and the stage strip on the frontend (`PIPELINE_STAGES` + `stageBody` in `src/app.js`). A method that folds into an existing stage (e.g. a new background-removal backend) is just a new entry in that stage's method list.
- **Don't commit** anything under `inputs/`, `outputs/`, `.venv/`, or the vendored binaries — `.gitignore` already covers them. Don't commit personal images.

## Before you open a PR

```bash
python3 -c "import ast; ast.parse(open('server.py').read())"   # backend parses
node --check src/app.js                                        # frontend parses
python3 tests/test_smoke.py                                    # backend smoke suite
```

Run the relevant process end-to-end through the UI and confirm the output. For algorithm changes (e.g. the pixel-grid detector), add or update a quick check against the `examples/` sprites.

## Reporting issues

Include the image (or its dimensions/format), the process and settings used, and the job log from the **Jobs** panel. For "wrong output" reports, the input image is usually essential.
