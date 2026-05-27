# Editor end-to-end tests

`editor_e2e.py` drives the vector editor in a **real browser** (Playwright) using
genuine pointer + keyboard input, then reads back live `editor` state to assert
outcomes. This covers what unit tests and screenshots can't: click-to-select,
drag-to-move (the `getScreenCTM` screen→geometry mapping, including under
zoom/pan), undo/redo, the inspector (fill / stroke / opacity), artboard resize,
the node tool, save, and `serialize()` cleanliness.

This is **dev-only tooling** — Playwright is not a runtime dependency of the app
(which needs only Pillow + numpy).

## Setup (once)

```bash
python3 -m venv .venv-e2e          # from the repo root
.venv-e2e/bin/pip install -r tests/e2e/requirements-dev.txt
.venv-e2e/bin/python -m playwright install chromium
```

## Run

```bash
./run.sh                            # in one terminal: serves http://localhost:2002
.venv-e2e/bin/python tests/e2e/editor_e2e.py
# or point at another origin:
.venv-e2e/bin/python tests/e2e/editor_e2e.py http://localhost:8080
```

Exit code is non-zero if any check fails; each check prints PASS/FAIL with detail.

## What it checks

- **Selection** — click selects, shift-click multi-selects, empty click selects the artboard.
- **Move** — drag maps screen delta to geometry correctly, including under zoom + pan;
  multi-selection moves together; each gesture is one undo step.
- **Undo/redo** — restores/replays position; a mixed batch of ops fully undoes back to an
  identical baseline; the undo button disables at the bottom of the stack.
- **Inspector** — fill (and "no fill"), stroke colour + width (and width 0 = no stroke),
  opacity; each edit is undoable.
- **Artboard** — resize rewrites the viewBox.
- **Node tool** — mounts draggable anchor handles on small docs, refuses to spray
  thousands of handles on large docs, and anchor drags are undoable.
- **Save / Open** — Save persists an `.edited.svg`; Open lists vectors.
- **Object ops** — duplicate (undoable), z-order (send-to-back / bring-to-front reorder the
  DOM), invert-space (one even-odd compound path bounded by the artboard, undoable).
- **History coalescing** — a whole colour-picker drag is a single undo entry, not dozens.
- **Side panels** — rail sections collapse/expand; the Library `⋯` popup menu opens
  without collapsing its section.
- **serialize()** — output contains no overlay/handle/`data-hv-id` scaffolding.

## Notes

- Uses the app's own Chromium-equivalent via Playwright; it does **not** rely on the
  system (snap) Chromium, whose DevTools port is blocked in this environment.
- The harness mounts its own deterministic 3-rect document for the precise interaction
  checks, and exercises the large auto-loaded document for the handle-count guard.
