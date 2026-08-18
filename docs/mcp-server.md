# hector-vector MCP server — design doc

**Status: PROPOSED, not built.** This is the shared reference Ferryman and Halcyon are
building implementation from — nothing here is live yet. Operator-authorized (2026-08-18):
"worth scoping and building the mcp and making it fully fledged for agent/human parity
loop... would take hector-vector to the next level and differentiate it from a cool
looking Adobe Illustrator clone."

## Why this, and why now

hector-vector's whole engine is already exercised through one clean surface —
`window.editor` (the app's own command layer: every button, shortcut, and menu item is a
thin wrapper over an `editor.*` call) plus `window.hv` (the pure geometry/shape-generation
library the editor is built on). That's not an accident of this audit; it's how the app
is *architected* — no build step, one live object graph, the same code path whether a
click or a script drives it. An MCP server doesn't have to invent a new way to manipulate
documents. It has to expose the one that already exists, honestly, as a stable contract.

"Agent/human parity" falls out of that almost for free — if the agent's tool calls run
through the exact same `editor.*` functions a button click does, on the exact canvas a
human has open, there is no second code path to keep in sync and no second document model
to drift from the real one.

## Architecture

### Attach, don't spawn

The MCP server **attaches to an already-running hector-vector tab** via Chrome DevTools
Protocol (`chromium.connect_over_cdp` in Playwright, or a raw CDP client) — it does not
launch and own a private headless Chromium instance.

Two reasons, not one:

1. **Parity is literal, not just architectural.** Attaching to the human's own open
   app-window means the agent and the human are looking at the *same* canvas in real
   time — the same sense in which you watched the fox get drawn. A spawned, unseen
   instance is parity in name only.
2. **This project has a documented risk class this sidesteps entirely.** Three prior
   incidents (up to 701% CPU / ~15GB RSS, twice took the whole machine down) are why
   `scripts/capped-run.sh` — a hard, `systemd-run`-enforced memory ceiling — is now
   mandatory for every Playwright-driven test in this repo. An MCP server that spawns and
   owns its own Chromium process would reintroduce that exact risk as a **standing
   feature**, not a supervised one-off test run. Attaching to a tab a human already
   opened (and is presumably watching) has no such lifecycle to mismanage.

If a genuinely headless / no-human-tab-open workflow turns out to be needed later (a pure
background batch agent), it gets the fallback path — and that fallback path launches its
Chromium under the same `capped-run.sh`-style hard ceiling from day one, never a bare
`chromium.launch()`. Not in v1.

### Desktop-only, localhost-bound

v1 is reachable only from the local machine, matching `server.py`'s existing
`127.0.0.1`-only binding and the same trust boundary the local AI-pipeline job queue
already operates in. **Not** exposed to the cloud/browser build. "Free in the browser,
nothing leaves the tab" is a real privacy claim this architecture currently earns —
cloud-exposing a document-manipulation surface would trade that for "a remote agent can
drive arbitrary document edits and potentially chain into the pipeline's file/model
APIs," a materially different security posture. If cloud exposure is ever wanted, it's
its own proposal with its own auth model — not folded into this one.

### Where it lives, how it starts

Proposed home: `hvserver/mcp_server.py`, a new stdio MCP server (Python, using the `mcp`
SDK) — a sibling to `server.py`, not a mode of it. Two live processes, two lifecycles,
explicitly:

- `server.py` — the existing local job-queue/API server, launched by `run.sh` /
  app-window mode, tied to the UI's own heartbeat.
- `mcp_server.py` — launched by whatever MCP client wants to drive hector-vector (Claude
  Code, another agent harness), reads the debug port hector-vector's own Chromium is
  listening on, attaches, and exposes the tool surface below.

**Halcyon owns the rest of this section** — exact launch mechanism (does the app-window
always open with `--remote-debugging-port` so a server can attach opportunistically, or
is there an explicit "enable agent access" toggle?), and the heartbeat-watchdog
integration: `HV_IDLE_SHUTDOWN` currently spins the server down after ~90s of UI silence,
and MCP-driven activity needs to count as "alive" the same way the UI's own keep-alive
does — a long-running agent task must not get the server yanked out from under it
mid-edit.

### Tool-naming contract

MCP tools wrap `editor.*`/`hv.*` calls; they do **not** expose those internal names
directly. `window.editor`'s API is an implementation detail this project refactors
freely (its own naming, e.g. `_setTextAttr`, `_commitBoolean`, is explicitly private-by-
convention) — an MCP tool surface that's just those names re-exported would break on
every internal refactor. Every tool below gets its own stable name, a JSON-schema input,
and a hand-written mapping to whatever internal calls implement it *today* — the mapping
is free to change; the tool contract is not.

Naming convention: `hv_<verb>_<noun>` (`hv_create_shape`, `hv_apply_fill`,
`hv_boolean_op`), grouped by the categories below. Every mutating tool returns the
resulting node's `data-hv-id` (or list of ids) so a caller can chain — the same idea
`editor.selection` already gives a human via the Layers panel.

## Tool vocabulary — Phase 1 (drawing-engine parity)

This is Ferryman's half — everything just audited clean this session, so it's the
lowest-risk, fastest-to-ship phase. Maps directly onto the six areas from the tools audit
plus the base primitives underneath them.

| Category | Tools | Maps to |
|---|---|---|
| **Document** | `hv_get_document` (full SVG + a structured node tree), `hv_new_document`, `hv_save`, `hv_export` (svg/png/pdf/eps) | `editor.stage`, save/export flow |
| **Shapes** | `hv_create_shape` (rect/ellipse/poly/star/line, kind + bbox + params), `hv_set_shape_param`, `hv_create_path` (pen-style anchor list → real path) | `hv.makeShapeNode`/`regenShape`/`setShapeParam`, `penPathD` |
| **Selection** | `hv_select`, `hv_get_selection`, `hv_get_bbox` | `editor.selection`, `_nodeBBoxUser` |
| **Paint** | `hv_apply_fill`/`hv_apply_stroke` (solid, gradient, pattern, global colour), `hv_recolor_shift` | `applyPaint`, `_harvestColors`/`recolorShift` |
| **Boolean/Pathfinder** | `hv_boolean_op` (union/subtract/intersect), `hv_pathfinder` (divide/trim/merge/crop/minus-back), `hv_invert_space` | `booleanOp`, `pathfinder`, `invertSpace` |
| **Transform** | `hv_move`, `hv_resize`, `hv_rotate`, `hv_reflect`, `hv_transform_each` | `setSelectionPos/Size`, `rotateSelectionBy`, `reflectSelection` |
| **Structure** | `hv_group`/`hv_ungroup`, `hv_duplicate`, `hv_align`, `hv_distribute`, `hv_arrange` (z-order) | `group`/`ungroup`, `duplicate`, `align`, `distribute` |
| **Text** | `hv_create_text` (point/box/on-path), `hv_set_text_style`, `hv_make_text_style`/`hv_apply_text_style` | text.js / textstyles.js mixins |
| **Effects/distort** | `hv_make_envelope`, `hv_make_gradient_mesh`, `hv_make_warp`, `hv_add_effect` (shadow/blur/glow) | envelope.js, mesh.js, warp.js, effects |
| **Symbols** | `hv_make_symbol`, `hv_break_symbol_link` | symbols.js |
| **Appearance** | `hv_make_multi_fill`, `hv_add_fill_layer`/`hv_set_fill_layer`/`hv_move_fill_layer` | multifill.js |

Every row here maps to something this session's audit already exercised and confirmed
correct — that's deliberate. Phase 1 ships on top of *verified* engine behavior, not
hopeful behavior.

## Phase 2+ (UI/workspace/library/pipeline parity) — Halcyon's half

The operator's scope answer was explicit: **full parity including UI-only features**, not
just the drawing engine — panel/workspace manipulation, Library browsing, batch pipeline
control. That's squarely shell/platform territory. Halcyon to detail this section:
candidates visible from the tools audit and the app's own feature surface include panel
dock/float/shelve state, the Library (browse/search/drag-to-place), Processor pipeline
jobs (upscale/remove-bg/vectorize as MCP-triggerable operations, not just UI clicks), and
Manage-screen batch control. Left deliberately unscoped here — not mine to design.

## What "verify parity" means for either phase

Same bar the tools audit itself proved out: don't trust a tool call as "wired" until it's
been checked against the RESULT, not just the absence of a thrown error. The audit's own
method — `isPointInFill` region sampling, bbox comparison before/after, real e2e checks
under `scripts/capped-run.sh` — is the right verification pattern for MCP tools too, and
should extend into this project's own test suite once implementation starts (an MCP tool
that silently no-ops, the way a few of this session's own test mistakes did, is exactly
the class of bug this bar exists to catch).

## Open questions for implementation time (not blocking this doc)

- Exact `mcp` Python SDK version/dependency footprint, and whether it lands in the base
  `requirements.txt` or stays optional (matching the existing pattern for `uharfbuzz`
  etc. — optional capabilities the app degrades gracefully without).
- Auth/consent model even for localhost: should a human get a one-time visible prompt
  the first time an agent session attaches, or is "you already have the app-window open"
  consent enough? Worth a security-conscious default even inside the desktop trust
  boundary.
- Whether `hv_get_document` should return the live SVG text, a structured JSON node
  tree, or both — a tree is easier for an agent to reason about; raw SVG is ground truth.
- Batching: does a multi-step illustration (like the fox) issue one tool call per shape,
  or does the vocabulary want a `hv_batch` tool that takes an ordered command list,
  cutting round-trip overhead for a long build sequence.
