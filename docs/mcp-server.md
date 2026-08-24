# hector-vector MCP server: design doc

**Status: SHIPPED.** ~90 `hv_*` tools are live in `hvserver/mcp_server.py`, giving an AI
agent widget-level parity with a human via an "Allow agent access" toggle in Settings.
This remains the shared reference Ferryman and Halcyon built the implementation from.
Operator-authorized (2026-08-18):
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

**BUILT (Halcyon, 2026-08-18).** An explicit "Allow agent access" toggle, off by default,
in Settings — not an ambient always-on flag. A CDP debug port isn't scoped to hector-
vector's own document, it's full control of that renderer (arbitrary JS execution,
cookies, everything), and Chromium binding it to `127.0.0.1` only stops the *network*,
not other local processes; an always-open port would let any other local process running
as the same user — a bad npm postinstall script, a compromised browser extension,
anything — attach and drive the document too, silently. That's a materially bigger local
attack surface than "an MCP client can drive HV," and it gets the same treatment any
sensitive local capability does: an explicit opt-in.

The toggle persists **server-side** (`.hector-config.json`, via
`hvserver.paths.agent_access_enabled/set_agent_access`, surfaced as `GET`/`POST
/api/agent-access`) rather than in `localStorage` — `launch.sh` has to read it before the
page itself has loaded. It takes effect **on the next restart**: this app-window can't
relaunch itself into a different Chromium process from inside the page (same reason the
existing "Update & restart" flow in Settings doesn't auto-restart either), so the
Settings row says so and the human opens a fresh window and closes the old one.

`launch.sh` is the sole thing that opens (or closes) the actual debug port. When the
preference is on, it binds a scratch socket to `127.0.0.1:0` to get a free local port,
immediately releases it, and passes that as `--remote-debugging-port=<port>` — a small,
accepted bind/release race, not literally Chromium's own `--remote-debugging-port=0`
stderr-parsed handshake (that needs `exec` to NOT replace the shell process, which this
script deliberately still does). The resolved port is written to `AGENT_PORT_FILE`
(`~/.cache/hector-vector/agent-port`, already defined in `hvserver/paths.py` for
`mcp_server.py` to read — correcting this doc's earlier, wrong `~/.hector-vector/...`
path). Every launch where the preference is off clears that file, so a stale port from a
previous agent-enabled session can never outlive a restart.

A **persistent status-bar badge** ("Agent access: on") shows for as long as a debug port
is actually live — driven by `GET /api/agent-access`'s `active` field (is `AGENT_PORT_FILE`
present), not just the `enabled` preference, so it never claims a port is open when the
current window doesn't actually have one yet (freshly toggled on, restart still pending).
This is the consent model: the badge *is* the ongoing prompt, durable and visibly
discoverable, not a modal dismissed once and forgotten. Answers the doc's own open
question on auth: yes to a visible signal, no to a repeated prompt.

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

## Scope principle: action/state parity, not widget parity

The operator's scope answer was explicit: **full parity including UI-only features**, not
just the drawing engine. Read literally, that could mean a tool for every widget — drag
this panel into a locking-bezel group, trim the mobile toolbar, switch the theme. It
shouldn't mean that, and the line is worth stating once, up front, so it governs every
phase rather than getting re-litigated per tool:

**In scope: anything that changes or reads DOCUMENT or PROJECT state.** New/open/save/
save-as/export in every format, running a Processor pipeline stage and reading its
result, browsing and loading from the Library, reading the current selection and its
properties, reading document structure. An agent reasoning about what to do next needs to
*see* state as much as it needs to mutate it — introspection tools are not an
afterthought alongside the write tools, they're the other half of the same contract. This
is why `hv_get_selection`/`hv_get_document` sit in Phase 1 as first-class tools alongside
the write operations, not a debugging afterthought.

**Out of scope for v1: anything that only changes how the chrome LOOKS.** Panel position/
float/dock state, theme, toolbar layout, mobile-shell ergonomics. An agent has no eyes to
appreciate a docked-vs-floated panel and no thumb that benefits from a trimmed mobile
toolbar — those affordances exist *because* a human has a screen and a hand with limited
reach. Building MCP coverage for them is effort spent modeling ergonomics nobody but a
human needs.

If a demo/narration use case later wants an agent to literally drive panel layout (e.g.
"open the Colour panel" as a recorded walkthrough step), that's a small, mechanical
addition once the state-introspection tools below exist — the registries
(`window.__docks`'s panel state, `layout.js`'s bar arrangement) are already structured
data, so it's a few more thin wrapper tools, not a redesign. Deliberately not building it
into v1 on spec. Open question back to the operator: does "full parity including UI-only
features" mean the action/state reading above, or does it deliberately want widget-level
coverage too? The reading above is our shared best guess at what's actually useful;
additive, not a rework, if the answer is "yes, literally that too."

## Phase 2+ (UI/workspace/library/pipeline parity) — Halcyon's half

That's squarely shell/platform territory, scoped against the principle above.

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
- Whether "full parity including UI-only features" means the action/state reading in
  "Scope principle" above, or deliberately wants widget-level coverage too — see that
  section; needs the operator's read.
