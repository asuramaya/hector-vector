// Raster processing engine: the live-preview state machines (live vectorize +
// live raster-ops upscale/remove-bg) plus the schema/data layer they share
// (engine + raster-op + capability registries, payload assembly, source checks).
// The Processor dock panel's view builders stay in app.js and drive this engine
// through the exported API; the engine never reaches back into the view.
//
// Extracted from app.js (#27). editor + api are imported directly; the rest of
// the shell seam (status line, the persisted settings object, and the form-row
// builders the schema panel emits) inject once via configureProcessor().
import { editor } from "../editor.js";
import { api } from "./api.js";

// Injected shell seams (set once by configureProcessor at boot).
let setStatus = () => {};
let settings = {};
let persistSettings = () => {};
let makeRange, makeNumber, makeSelect, fieldRow;
export function configureProcessor(deps) {
  ({ setStatus, settings, persistSettings, makeRange, makeNumber, makeSelect, fieldRow } = deps);
}

export let rasterStageBusy = false;     // an upscale/bg job in flight (disables buttons)

export function rasterHref(node) { return (node && (node.getAttribute("href") || node.getAttribute("xlink:href"))) || ""; }
export function rasterName(node) { return (node && (node.getAttribute("data-hv-name") || "")).replace(/^Image:\s*/, "") || "trace"; }
// True native pixel size of a placed raster. The node's width/height attributes are the
// artboard-fit DISPLAY size (placeImage bakes the fit scale in), and an SVG <image> has no
// naturalWidth — so we load the actual source bytes. (mediaNaturalSize() on an <image> node
// returns 1×1, which made the cleanup mask 1×1.) Falls back to the display box if load fails.
export function rasterNaturalSize(node) {
  return new Promise((resolve) => {
    const href = rasterHref(node);
    const fallback = () => resolve({
      w: Math.max(1, Math.round(parseFloat(node.getAttribute("width")) || 1)),
      h: Math.max(1, Math.round(parseFloat(node.getAttribute("height")) || 1)),
    });
    if (!href) { fallback(); return; }
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
    im.onerror = fallback;
    im.src = href;
  });
}

// ---- engine schema (single source of truth: /api/vectorize/engines) -------------
// The vectorize panel is rendered PURELY from each engine's param schema, so a
// control is shown iff that engine actually consumes it (no phantom knobs) and every
// control is wired identically. Fetched once and cached; prefetched at startup.
export let engineSchemas = null;
export async function ensureEngineSchemas() {
  if (engineSchemas) return engineSchemas;
  try { const r = await api("/api/vectorize/engines"); if (Array.isArray(r)) engineSchemas = r; }
  catch { /* leave null so the next render retries — don't poison the cache */ }
  return engineSchemas || [];
}
// Which engine the current settings resolve to — mirrors server resolve_engine:
// explicit `engine` wins, else legacy-derive from method / colormode / style.
export function currentEngineId() {
  if ((engineSchemas || []).some((e) => e.id === settings.engine && e.available !== false)) return settings.engine;
  if (settings.vectorize_method === "pixel") return "pixel";
  if (settings.trace_colormode === "color" && settings.trace_color_style === "clean") return "clean";
  return "vtracer";
}
// Pick an engine: set the explicit key AND keep the legacy fields coherent, so the
// Process workspace + the payload stay consistent and the server resolves the same.
export function setEngine(id) {
  settings.engine = id;
  if (id === "pixel") settings.vectorize_method = "pixel";
  else {
    settings.vectorize_method = "trace";
    if (id === "clean") { settings.trace_colormode = "color"; settings.trace_color_style = "clean"; }
    else if (settings.trace_color_style === "clean") settings.trace_color_style = "poster";
  }
  persistSettings();
}
// A schema param's `when` guard: render only when every condition key matches.
export function schemaWhenOk(param) {
  if (!param.when) return true;
  return Object.entries(param.when).every(([k, v]) => String(settings[k]) === String(v));
}
// Build ONE control from a schema param, wired to a debounced live re-trace. A param
// that other params' `when` depends on rebuilds the panel on change (to show/hide the
// dependents); every plain value control only kicks the trace — NO panel rebuild, so
// dragging a slider never destroys the thumb mid-drag (the old half-wired failure).
export function schemaControl(param, whenKeys, liveKick, structural) {
  const k = param.key;
  if (settings[k] === undefined && param.default !== undefined && param.default !== null) settings[k] = param.default;
  const onChange = whenKeys.has(k) ? structural : liveKick;
  let control;
  if (param.type === "range") {
    control = makeRange(k, param.min, param.max, param.step || 1);
    control.addEventListener("input", liveKick);          // continuous → live only, never structural
  } else if (param.type === "checkbox") {
    control = document.createElement("input"); control.type = "checkbox"; control.checked = !!settings[k];
    control.addEventListener("change", () => { settings[k] = control.checked; persistSettings(); onChange(); });
  } else if (param.type === "number") {
    control = makeNumber(k, { min: param.min, max: param.max, step: param.step || 1, placeholder: param.placeholder || "" });
    control.addEventListener("input", liveKick);
  } else {
    control = makeSelect(k, param.options || []);          // [value, label] pairs from the schema
    control.addEventListener("change", onChange);
  }
  return fieldRow(param.label || k, control, param.hint);
}

// The settings payload the pipeline/preview endpoints read — the whole settings
// object (server picks the keys it knows) + the raster's source URL + overrides.
export function stagePayload(node, overrides) {
  return Object.assign({}, settings, { input_url: rasterHref(node) }, overrides || {});
}

export function rasterSourceUsable(node) {
  const href = rasterHref(node);
  if (!href) { setStatus("This image has no file source to process.", 3200); return false; }
  if (href.startsWith("data:")) { setStatus("Import this image to the library first, then process it.", 3800); return false; }
  return true;
}

// ---- raster-op schema (single source of truth: /api/raster-ops) ----------------
// Upscale + Remove-bg are rendered + live-wired from this, exactly like the vectorize
// engines — so all three pipeline stages share one schema-driven panel mechanism.
export let rasterOpSchemas = null;
export async function ensureRasterOpSchemas() {
  if (rasterOpSchemas) return rasterOpSchemas;
  try { const r = await api("/api/raster-ops"); if (Array.isArray(r)) rasterOpSchemas = r; }
  catch { /* leave null so the next render retries — don't poison the cache */ }
  return rasterOpSchemas || [];
}
export function rasterOpById(id) { return (rasterOpSchemas || []).find((o) => o.id === id) || null; }

// ---- capability registry (intent-first source of truth: /api/capabilities) -------------
// The descriptive taxonomy (capability × intent × model) the server exposes. Drives the
// stage cards' Outcome picker: pick what you WANT, the router picks the model. Adding a
// model is a server registry line — it shows up here automatically, no new panel (#49).
export let capsInfo = null;
export let capsBusy = false;    // a fetch is in flight — don't pile on parallel requests
export let capsTried = false;   // we've completed at least one fetch attempt (success OR failure)
export async function ensureCapsInfo() {
  if (capsInfo) return capsInfo;
  if (capsBusy) return [];                 // already loading — let that one settle
  capsBusy = true;
  try { const r = await api("/api/capabilities"); if (Array.isArray(r)) capsInfo = r; }
  catch { /* a genuine failure (e.g. a stale server that predates this endpoint → 404).
             We mark it tried below so callers STOP re-requesting on every render — that
             retry-forever loop is what spun the panel into a click-eating rebuild storm.
             A reload (or restarting the server) retries cleanly. */ }
  finally { capsBusy = false; capsTried = true; }
  return capsInfo || [];
}
export function capById(id) { return (capsInfo || []).find((c) => c.id === id) || null; }

// The resolution at which BOTH the live preview and a focused on-canvas vectorize trace.
// It's the WYSIWYG number: what you preview is what you commit, so they must match. It is
// deliberately tighter than the server's batch overproduction ceiling (TRACE_MAX_DIM) —
// the focused/interactive path favours a clean, fast, preview-identical result. Mirrors
// the server's TRACE_PREVIEW_DIM (the server clamps the request to 64..2048 regardless).
export const TRACE_PREVIEW_DIM = 1000;

// ===== Unified live-preview state machine (#27 Phase B) ==========================
// ONE machine drives BOTH live previews — live vectorize (raster → vector overlay)
// and live raster-ops (raster → raster href swap, upscale / remove-bg). The two
// used to be near-identical twin machines (duplicated debounce + seq-guard +
// teardown); now they share that machinery and differ only in a per-kind STRATEGY
// (endpoint, how the preview is applied, how it commits, debounce delay). Only one
// preview is ever active — starting either kind tears the other down.
//
// `live` is the single source of truth. The legacy module exports the rest of the
// shell reads (rasterLive / rasterOp / rasterLiveNode / rasterOpNode / rasterOpName)
// are a read-only projection kept in sync by _sync(), so app.js is untouched.
const live = {
  kind: null,   // null | "vectorize" | "op"
  op: null,     // "upscale" | "removebg"  (when kind === "op")
  node: null,   // the <image> being previewed
  svg: null,    // vectorize: last previewed SVG (commit fallback)
  orig: null,   // op: original href — revert target AND the re-run source
  seq: 0,       // guards out-of-order debounced runs (shared: one machine)
  timer: null,
};

// Read-only projection of `live` for the view layer + test seam (live bindings).
export let rasterLive = false;
export let rasterOp = false;
export let rasterLiveNode = null;
export let rasterOpNode = null;
export let rasterOpName = null;
export let rasterLiveKicks = 0;   // test-observable: a vectorize control fired a re-run
export let rasterOpKicks = 0;     // test-observable: a raster-op control fired a re-run
function _sync() {
  rasterLive = live.kind === "vectorize";
  rasterOp = live.kind === "op";
  rasterLiveNode = rasterLive ? live.node : null;
  rasterOpNode = rasterOp ? live.node : null;
  rasterOpName = rasterOp ? live.op : null;
}

// Per-kind behaviour: the only places the two previews genuinely diverge.
const STRATEGY = {
  vectorize: {
    debounce: (immediate) => immediate ? 30 : 250,   // traces are ~1.5s now → short debounce feels live
    status: () => "Tracing preview…",
    async run(node, seq) {
      const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
      if (seq !== live.seq || live.kind !== "vectorize") return;   // superseded or cancelled mid-flight
      if (res.svg) { live.svg = res.svg; editor.showRasterPreview(node, res.svg); setStatus(`Preview — ${res.nodes} nodes`, 1800); }
    },
    onError(e) {
      // 404 = a server predating the /api/trace-preview route → ask for a restart.
      const stale = /\b404\b/.test(e.message || "");
      setStatus(stale ? "Restart the local server (server.py) — the live-trace endpoint is new." : `Preview failed: ${e.message}`, 4500);
    },
    revert() { editor.clearRasterPreview(true); },
  },
  op: {
    debounce: (immediate) => immediate ? 30 : 500,   // ops are heavier → longer debounce
    status: () => `${live.op === "upscale" ? "Upscaling" : "Removing background"}… (a few seconds)`,
    async run(node, seq) {
      const op = live.op;
      // Re-run from the ORIGINAL source (not the current preview href) — no compounding.
      const res = await api("/api/raster-op", "POST", Object.assign({}, settings, { input_url: live.orig, op }));
      if (seq !== live.seq || live.kind !== "op") return;   // superseded or cancelled mid-flight
      if (!res.url) throw new Error(res.message || res.error || "No result produced.");
      node.setAttribute("href", res.url);
      setStatus(`Preview — ${op === "upscale" ? "upscaled" : "background removed"} (not saved).`, 1800);
    },
    onError(e) {
      const op = live.op;
      const stale = /\b404\b/.test(e.message || "");
      setStatus(stale ? "Restart the local server (server.py) — the raster-op endpoint is new."
                      : `${op === "upscale" ? "Upscale" : "Remove background"} failed: ${e.message}`, 5000);
    },
    revert() { if (live.node && live.orig != null) live.node.setAttribute("href", live.orig); },
  },
};

// Shared machinery -----------------------------------------------------------------
function _schedule(immediate) {
  if (!live.kind || !live.node) return;
  if (live.kind === "vectorize") rasterLiveKicks++; else rasterOpKicks++;
  if (live.timer) clearTimeout(live.timer);
  live.timer = setTimeout(_run, STRATEGY[live.kind].debounce(immediate));   // superseded in-flight runs drop via the seq guard
}
async function _run() {
  if (!live.kind || !live.node) return;
  const node = live.node, seq = ++live.seq, strat = STRATEGY[live.kind];
  setStatus(strat.status(), 0);
  try {
    await strat.run(node, seq);
  } catch (e) {
    if (seq !== live.seq) return;   // a newer run/teardown superseded this one — stay quiet
    strat.onError(e);
  }
}
// Drop the live state (invalidate any in-flight run via seq++, kill the debounce timer).
function _teardown() {
  live.seq++;
  if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  live.kind = null; live.op = null; live.node = null; live.svg = null; live.orig = null;
}
function _end(revert) {
  if (revert && live.kind) STRATEGY[live.kind].revert();   // revert reads live.node/orig → before teardown
  _teardown();
  _sync();
}

// ---- live vectorize: debounced trace → swap the canvas to the vector ----
export function startRasterLive(node) {
  if (!rasterSourceUsable(node)) return;
  if (live.kind) _end(true);   // one live preview at a time
  live.kind = "vectorize"; live.node = node; live.svg = null;
  _sync();
  editor._renderInspector();
  _schedule(true);
}
export function endRasterLive(revert) { if (live.kind === "vectorize") _end(revert); }
export function scheduleRasterLive(immediate) { if (live.kind === "vectorize") _schedule(immediate); }

// ---- live raster ops (upscale / remove-bg): debounced transform → href swap (keep/revert).
// ALWAYS re-runs from the ORIGINAL href so settings never compound on a prior preview. ----
export function startRasterOpLive(node, op) {
  if (!rasterSourceUsable(node)) return;
  if (live.kind) _end(true);   // one live preview at a time
  live.kind = "op"; live.op = op; live.node = node; live.orig = rasterHref(node);
  _sync();
  editor._renderInspector();
  _schedule(true);
}
export function endRasterOpLive(revert) { if (live.kind === "op") _end(revert); }
export function scheduleRasterOpLive(immediate) { if (live.kind === "op") _schedule(immediate); }

// Commit (vectorize): keep exactly what's previewed — replace the raster with a real
// vector layer built from the live preview SVG (the canvas IS the preview, so the kept
// result matches it 1:1, and it's instant — no second trace round-trip).
export function commitRasterLive() {
  if (live.kind !== "vectorize" || !live.node) return;
  const node = live.node, svg = live.svg;
  if (!svg) { setStatus("Adjust a setting to generate a trace first.", 2800); return; }
  const name = rasterName(node);
  _teardown(); _sync();
  editor.commitRasterToVector(node, svg, name);
}

// Commit (raster-op): the canvas IS the preview (href already points at the scratch
// result) — just push history. (Revert restores the original href via _end.)
export function commitRasterOpLive() {
  if (live.kind !== "op" || !live.node) return;
  const node = live.node;
  if (live.orig != null && rasterHref(node) === live.orig) { setStatus("Adjust a setting to generate a preview first.", 2800); return; }
  _teardown(); _sync();
  editor.push("Process raster");
  editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
  setStatus("Applied on canvas (not saved to library).", 3000);
}

// Single source of truth for a focused vectorize: trace ONCE at the live-preview
// resolution and commit that exact SVG in place. If a live preview is already showing for
// this node, reuse its SVG (instant, and byte-identical to "Keep vector"); otherwise do a
// single synchronous /api/trace-preview at the same resolution. This is what the chin
// "Run → canvas" calls for a vectorize-only run, so previewing and committing can never
// disagree and no second job re-traces at the batch ceiling.
export async function commitFocusedVectorize(node) {
  let svg = (live.kind === "vectorize" && live.node === node && live.svg) ? live.svg : null;
  if (!svg) {
    setStatus("Tracing…", 0);
    const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
    if (!res.svg) throw new Error(res.message || res.error || "No vector produced.");
    svg = res.svg;
  }
  // Tear down any live-preview state for this node first, so its seq-guard / debounce
  // timer / Revert can't fire against the node we're about to replace.
  if (live.kind === "vectorize" && live.node === node) { _teardown(); _sync(); }
  const ok = editor.commitRasterToVector(node, svg, rasterName(node));
  if (!ok) setStatus("Couldn't place the traced vector.", 3500);
  return ok;
}

// T1 "Auto": ask the server to recommend vectorize settings from image stats,
// apply them to the panel, and (if live) re-trace so the canvas updates at once.
export async function autoSuggestTrace(node) {
  if (!rasterSourceUsable(node)) return;
  setStatus("Analyzing image…", 0);
  try {
    const res = await api("/api/trace-suggest", "POST", { input_url: rasterHref(node) });
    // Apply the derived params, then the explicit engine — the panel now has an Engine
    // selector, so reflecting the suggestion there (instead of leaving it implicit) is
    // exactly what the user expects. setEngine keeps the legacy fields coherent too.
    for (const k of ["vectorize_method", "trace_colormode", "trace_color_style", "color_precision", "trace_simplify"]) {
      if (res[k] !== undefined) settings[k] = res[k];
    }
    if (res.engine && (engineSchemas || []).some((e) => e.id === res.engine)) setEngine(res.engine);
    persistSettings();
    editor._renderInspector();
    if (live.kind === "vectorize") _schedule(false);
    setStatus(res.reason || "Applied suggested settings.", 4500);
  } catch (e) {
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the auto-detect endpoint is new." : `Auto-detect failed: ${e.message}`, 4500);
  }
}

// Arm hooks for the editor test-seam (window.app): set the live target without
// kicking a trace — the editor drives the actual preview render separately.
export function armLive(node) { live.kind = "vectorize"; live.node = node; live.svg = null; live.op = null; live.orig = null; _sync(); }
export function armOp(node, op) { live.kind = "op"; live.op = op; live.node = node; live.orig = rasterHref(node); live.svg = null; _sync(); }
