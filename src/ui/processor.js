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

export let rasterLive = false;          // live-vectorize preview active?
export let rasterLiveNode = null;       // the <image> being previewed
export let rasterLiveSvg = null;        // last previewed SVG (commit fallback)
export let rasterLiveSeq = 0;           // guards out-of-order debounced traces
export let rasterLiveTimer = null;
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

// ---- live raster ops (upscale / remove-bg): debounced transform → swap the canvas
// image href to the result (keep / revert). Same shape as live vectorize, but the
// preview is a transient href swap (raster→raster), not a vector overlay. ALWAYS
// re-runs from the ORIGINAL href so settings never compound on a prior preview. ----
export let rasterOp = false;       // a raster-op live preview active?
export let rasterOpNode = null;
export let rasterOpName = null;    // "upscale" | "removebg"
export let rasterOpOrig = null;    // original href — revert target AND the re-run source
export let rasterOpSeq = 0;
export let rasterOpTimer = null;
export let rasterOpKicks = 0;      // test-observable: a control fired a re-run

export function startRasterOpLive(node, op) {
  if (!rasterSourceUsable(node)) return;
  if (rasterLive) endRasterLive(true);     // one live preview at a time
  if (rasterOp) endRasterOpLive(true);
  rasterOp = true; rasterOpNode = node; rasterOpName = op; rasterOpOrig = rasterHref(node);
  editor._renderInspector();
  scheduleRasterOpLive(true);
}
export function endRasterOpLive(revert) {
  if (revert && rasterOpNode && rasterOpOrig != null) rasterOpNode.setAttribute("href", rasterOpOrig);
  rasterOp = false; rasterOpNode = null; rasterOpName = null; rasterOpOrig = null;
  rasterOpSeq++;
  if (rasterOpTimer) { clearTimeout(rasterOpTimer); rasterOpTimer = null; }
}
export function scheduleRasterOpLive(immediate) {
  if (!rasterOp || !rasterOpNode) return;
  rasterOpKicks++;
  if (rasterOpTimer) clearTimeout(rasterOpTimer);
  rasterOpTimer = setTimeout(doRasterOpLive, immediate ? 30 : 500);   // ops are heavier → longer debounce
}
export async function doRasterOpLive() {
  if (!rasterOp || !rasterOpNode) return;
  const node = rasterOpNode, op = rasterOpName, seq = ++rasterOpSeq;
  setStatus(`${op === "upscale" ? "Upscaling" : "Removing background"}… (a few seconds)`, 0);
  try {
    // Re-run from the ORIGINAL source (not the current preview href) — no compounding.
    const res = await api("/api/raster-op", "POST", Object.assign({}, settings, { input_url: rasterOpOrig, op }));
    if (seq !== rasterOpSeq || !rasterOp) return;   // superseded or cancelled mid-flight
    if (!res.url) throw new Error(res.message || res.error || "No result produced.");
    node.setAttribute("href", res.url);
    setStatus(`Preview — ${op === "upscale" ? "upscaled" : "background removed"} (not saved).`, 1800);
  } catch (e) {
    if (seq !== rasterOpSeq) return;
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the raster-op endpoint is new."
                    : `${op === "upscale" ? "Upscale" : "Remove background"} failed: ${e.message}`, 5000);
  }
}
// Keep: the canvas IS the preview (href already points at the scratch result) — just
// push history. Revert: restore the original href.
export function commitRasterOpLive() {
  const node = rasterOpNode;
  if (!node) return;
  if (rasterOpOrig != null && rasterHref(node) === rasterOpOrig) { setStatus("Adjust a setting to generate a preview first.", 2800); return; }
  rasterOp = false; rasterOpNode = null; rasterOpName = null; rasterOpOrig = null; rasterOpSeq++;
  if (rasterOpTimer) { clearTimeout(rasterOpTimer); rasterOpTimer = null; }
  editor.push("Process raster");
  editor._renderSelection(); editor._renderInspector(); editor._renderLayers();
  setStatus("Applied on canvas (not saved to library).", 3000);
}

// The resolution at which BOTH the live preview and a focused on-canvas vectorize trace.
// It's the WYSIWYG number: what you preview is what you commit, so they must match. It is
// deliberately tighter than the server's batch overproduction ceiling (TRACE_MAX_DIM) —
// the focused/interactive path favours a clean, fast, preview-identical result. Mirrors
// the server's TRACE_PREVIEW_DIM (the server clamps the request to 64..2048 regardless).
export const TRACE_PREVIEW_DIM = 1000;

// ---- live vectorize: debounced trace → swap the canvas to the vector ----
export function startRasterLive(node) {
  if (!rasterSourceUsable(node)) return;
  rasterLive = true; rasterLiveNode = node; rasterLiveSvg = null;
  editor._renderInspector();
  scheduleRasterLive(true);
}
export function endRasterLive(revert) {
  rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null;
  rasterLiveSeq++;
  if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  if (revert) editor.clearRasterPreview(true);
}
export let rasterLiveKicks = 0;   // counts re-trace requests (a test-observable signal that a control is live-wired)
export function scheduleRasterLive(immediate) {
  if (!rasterLive || !rasterLiveNode) return;
  rasterLiveKicks++;
  if (rasterLiveTimer) clearTimeout(rasterLiveTimer);
  // 250ms settle: traces are ~1.5s now (was 11s), so a short debounce feels live
  // without spamming — superseded in-flight traces are dropped by the seq guard.
  rasterLiveTimer = setTimeout(doRasterLiveTrace, immediate ? 30 : 250);
}
export async function doRasterLiveTrace() {
  if (!rasterLive || !rasterLiveNode) return;
  const node = rasterLiveNode, seq = ++rasterLiveSeq;
  setStatus("Tracing preview…", 0);
  try {
    const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
    if (seq !== rasterLiveSeq || !rasterLive) return;   // superseded or cancelled mid-flight
    if (res.svg) { rasterLiveSvg = res.svg; editor.showRasterPreview(node, res.svg); setStatus(`Preview — ${res.nodes} nodes`, 1800); }
  } catch (e) {
    if (seq !== rasterLiveSeq) return;
    // 404 = a server predating the /api/trace-preview route → ask for a restart.
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the live-trace endpoint is new." : `Preview failed: ${e.message}`, 4500);
  }
}
// Commit: keep exactly what's previewed on the canvas — replace the raster with a
// real vector layer built from the live preview SVG (the canvas IS the preview, so
// the kept result matches it 1:1, and it's instant — no second trace round-trip).
export function commitRasterLive() {
  const node = rasterLiveNode, svg = rasterLiveSvg;
  if (!node) return;
  if (!svg) { setStatus("Adjust a setting to generate a trace first.", 2800); return; }
  const name = rasterName(node);
  rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null; rasterLiveSeq++;
  if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  editor.commitRasterToVector(node, svg, name);
}

// Single source of truth for a focused vectorize: trace ONCE at the live-preview
// resolution and commit that exact SVG in place. If a live preview is already showing for
// this node, reuse its SVG (instant, and byte-identical to "Keep vector"); otherwise do a
// single synchronous /api/trace-preview at the same resolution. This is what the chin
// "Run → canvas" calls for a vectorize-only run, so previewing and committing can never
// disagree and no second job re-traces at the batch ceiling.
export async function commitFocusedVectorize(node) {
  let svg = (rasterLive && rasterLiveNode === node && rasterLiveSvg) ? rasterLiveSvg : null;
  if (!svg) {
    setStatus("Tracing…", 0);
    const res = await api("/api/trace-preview", "POST", stagePayload(node, { preview_max_dim: TRACE_PREVIEW_DIM }));
    if (!res.svg) throw new Error(res.message || res.error || "No vector produced.");
    svg = res.svg;
  }
  // Tear down any live-preview state for this node first, so its seq-guard / debounce
  // timer / Revert can't fire against the node we're about to replace.
  if (rasterLive && rasterLiveNode === node) {
    rasterLive = false; rasterLiveNode = null; rasterLiveSvg = null; rasterLiveSeq++;
    if (rasterLiveTimer) { clearTimeout(rasterLiveTimer); rasterLiveTimer = null; }
  }
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
    if (rasterLive) scheduleRasterLive(false);
    setStatus(res.reason || "Applied suggested settings.", 4500);
  } catch (e) {
    const stale = /\b404\b/.test(e.message || "");
    setStatus(stale ? "Restart the local server (server.py) — the auto-detect endpoint is new." : `Auto-detect failed: ${e.message}`, 4500);
  }
}

// Arm hooks for the editor test-seam (window.app): set the live target without
// kicking a trace — the editor drives the actual preview render separately.
export function armLive(node) { rasterLive = true; rasterLiveNode = node; }
export function armOp(node, op) { rasterOp = true; rasterOpNode = node; rasterOpName = op; rasterOpOrig = rasterHref(node); }
