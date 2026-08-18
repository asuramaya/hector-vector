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

**Launch mechanism: an explicit toggle, not always-on.** A CDP debug port isn't scoped to
hector-vector's own document — it's full control of that renderer (arbitrary JS
execution, cookies, everything), and Chromium binding it to `127.0.0.1` only stops the
*network*, not other local processes. Always launching the app-window with
`--remote-debugging-port` open would mean any other local process running as the same
user — a bad npm postinstall script, a compromised browser extension, anything — could
attach and drive the document too, silently. That's a materially bigger local attack
surface than "an MCP client can drive HV," and it should require the same thing any
sensitive local capability does: an explicit opt-in, not an ambient default.

Proposed: a Settings toggle, **off by default**, "Allow agent access." Turning it on
relaunches (or launches) the app-window with `--remote-debugging-port=0` (OS-assigned
ephemeral port — never a fixed, guessable one) bound to `127.0.0.1`, writes the resolved
port to a small local file (`~/.hector-vector/agent-port`, same idea as the existing
`.hector-config.json`, readable only by the local user) for `mcp_server.py` to discover
on attach, and shows a **persistent, impossible-to-miss status-bar indicator** ("Agent
access: on") for as long as it's active. This doubles as the consent model — the toggle
*is* the one-time consent, durable and visibly discoverable rather than a modal a human
dismisses once and forgets is still in effect. Answers the doc's own open question on
auth: yes to a visible signal, no to a repeated prompt — the badge **is** the prompt,
continuously.

**Heartbeat integration: reuse the existing endpoint, don't build a second watchdog.**
`mcp_server.py` pings the existing `/api/heartbeat` on a short interval (matching the
UI's own cadence) for as long as it holds a live CDP attachment, and stops when it
detaches. Zero changes needed to `_idle_watchdog`/`_touch_heartbeat` in `hvserver/jobs.py`
— they already treat any heartbeat call as "alive" regardless of caller. This also means
a crashed or killed `mcp_server.py` that never cleanly detaches self-heals for free: the
existing 90s idle timeout reclaims the server exactly as it does today for an abandoned
UI tab, no orphan-process risk introduced.

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

### Scoping principle: action/state parity, not widget parity

Before the table — a distinction worth making explicit, since "full parity including
UI-only features" can be read two ways, and they lead to very different tool lists.

**Widget parity** would mean a tool for every gesture a human hand can make on the
chrome: `hv_dock_panel`, `hv_float_panel`, `hv_reorder_toolbar`, `hv_shelve_panel`. An
agent has no eyes to appreciate a panel being docked left vs. floated, and no thumb that
benefits from a trimmed mobile toolbar — those affordances exist *because* a human has a
screen and a hand with limited reach. Building MCP coverage for them is real effort spent
modeling ergonomics nobody but a human needs.

**Action/state parity** — the reading this section actually uses — means: everything a
human can do that changes what's *in* the document, the project, or a pipeline job, plus
everything they can *see* that isn't already covered by Phase 1's document/selection
tools. Library browsing changes what's available to load. Running a pipeline stage
changes what raster exists. Switching Edit↔Manage changes what an agent (or a human
narrating an agent's work) is looking at. None of that is chrome — it's real state, same
category as everything Phase 1 already covers.

Net effect: **panel dock/float/shelve, toolbar customization, and theme are out of scope
for this table.** If a demo/narration use case later wants an agent to literally drive
panel layout (e.g. "open the Colour panel" as a recorded walkthrough step), that's a
small, mechanical addition once this table's state-introspection tools exist — the
registries (`window.__docks`'s panel state, `layout.js`'s bar arrangement) are already
structured data, so it's a few more thin wrapper tools, not a redesign. Deliberately not
building it into v1 on spec.

### Tool vocabulary

| Category | Tools | Maps to |
|---|---|---|
| **Library** | `hv_library_list` (rasters/vectors/canvases, filter/search), `hv_library_load` (place an item onto the canvas, or open a `.hv` project), `hv_library_info` (dimensions/size/path/element+colour counts) | `ui/library.js`, the Info panel's own data source |
| **Pipeline** | `hv_pipeline_plan` (the Auto analyzer's classical read → proposed stages + *why*, no side effect), `hv_pipeline_configure` (set which stages are on + their params for a given raster's `data-hv-id`), `hv_pipeline_run` (foreground live-preview on one raster, or background job against the Library batch), `hv_job_status`/`hv_job_list`, `hv_job_cancel` | `tools/analyze.py` via `/api/plan`, `ui/processor.js`, `ui/jobs.js` |
| **Document view** | `hv_get_view` (current tool, zoom/pan, Edit-vs-Manage mode), `hv_set_view_mode` (switch Edit↔Manage — a real navigation action, not chrome positioning), `hv_fit_view`, `hv_set_zoom` | `app.js` view-swap, `editor.fitToView`/viewport tools |
| **Project/session** | `hv_open_project` (`.hv`, preserves history), `hv_save_project` | doc I/O beyond Phase 1's plain-SVG `hv_save` |

### Explicitly deferred, not forgotten

- **Theme** is a genuine borderline case under the scoping principle above — it's a
  document-adjacent *preference*, not document content, so it's excluded by the same
  logic as panel layout. Flagging rather than silently dropping: if the operator's
  "UI-only features" phrasing was aimed partly at this (e.g. an agent setting up a
  themed screenshot), it's a one-tool addition (`hv_set_theme`), not a scope fight.
- **Settings beyond theme** (source folder, startup behaviour, smart-guides default) —
  same reasoning, excluded for the same reason, flagged for the same reason.
- Mobile/touch-shell-specific state (which form factor is active, rail contents) has no
  agent-facing use I can construct — a CDP-attached agent isn't holding a phone. Not
  listed above; revisit only if a concrete use case surfaces.

Open question back to Ferryman/operator: does "full parity including UI-only features"
mean the state/action table above, or does it deliberately want widget-level coverage
too (e.g. for a literal screen-recording/narration product feature)? The table above is
my read of what's actually useful; happy to add the widget layer if the answer is "yes,
literally that too" — it's additive, not a rework.

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
- ~~Auth/consent model even for localhost~~ — answered in "Where it lives, how it
  starts" above: an off-by-default "Allow agent access" toggle that also relaunches with
  an ephemeral debug port, doubling as durable, visible consent (the status-bar badge
  *is* the ongoing prompt).
- Whether `hv_get_document` should return the live SVG text, a structured JSON node
  tree, or both — a tree is easier for an agent to reason about; raw SVG is ground truth.
- Batching: does a multi-step illustration (like the fox) issue one tool call per shape,
  or does the vocabulary want a `hv_batch` tool that takes an ordered command list,
  cutting round-trip overhead for a long build sequence.
- Raised in Phase 2+ above: does "full parity including UI-only features" mean
  action/state parity (this doc's Phase 2+ table) or literal widget-level coverage
  (panel dock/float, toolbar reorder, theme)? Needs the operator's or Ferryman's read.
