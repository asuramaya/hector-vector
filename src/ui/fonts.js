// Font service — client half (#58-#61, T11-T14). The server fetches + caches Google Fonts
// and owns the canonical files; this module is the in-app registry + loader + the searchable
// browser popover that fronts "font website" discovery/download. Flow: search the catalogue
// (/api/fonts/catalog) → pick → /api/fonts/load caches the .woff2 server-side and hands back a
// URL → we register a FontFace so the canvas renders it live. On save we embed the used faces
// as base64 @font-face so the .svg is portable; on PNG export we await document.fonts.ready.
//
// No editor/DOM-graph coupling here (pure UI + fetch); app.js exposes it as window.__fonts and
// the text inspector calls openFontBrowser(). System stacks render instantly + offline.
import { api } from "./api.js";

// Always-available stacks (no download) shown atop the browser. Value = the font-family the
// <text> gets; label = what the user sees. Mirrors the curated list in editor/tools/text.js.
export const SYSTEM_FONTS = [
  ["Helvetica, Arial, sans-serif", "Helvetica / Arial", "sans-serif"],
  ["Georgia, 'Times New Roman', serif", "Georgia", "serif"],
  ["'Times New Roman', Times, serif", "Times New Roman", "serif"],
  ["'Courier New', monospace", "Courier", "monospace"],
  ["Verdana, Geneva, sans-serif", "Verdana", "sans-serif"],
  ["'Trebuchet MS', sans-serif", "Trebuchet", "sans-serif"],
  ["Impact, Charcoal, sans-serif", "Impact", "display"],
  ["'Comic Sans MS', cursive", "Comic Sans", "cursive"],
];

// Registry of LOADED web fonts: family → { variants:{ "w|i": url }, source, category }. Drives
// save-embedding (only faces we fetched), the "Installed" list, source-aware outline conversion,
// and dedupes repeat loads.
const loaded = new Map();
const variantKey = (weight, italic) => `${weight}|${italic ? 1 : 0}`;
function _slot(family) { let s = loaded.get(family); if (!s) { s = { variants: {}, source: "", category: "sans-serif" }; loaded.set(family, s); } return s; }

// Which source a loaded family came from (so outline conversion fetches the same file). "" if
// not loaded this session — the server then resolves across sources by family name.
export function webFontSource(family) { const s = loaded.get(family); return s ? s.source : ""; }
// Families downloaded this session — the in-app "Installed" library (friendly names, instant reuse).
export function installedFamilies() { return [...loaded.entries()].map(([family, s]) => ({ family, source: s.source, category: s.category })); }

// The font-family string a <text> gets for a web font: quoted family + a generic fallback,
// so it degrades gracefully before the face finishes loading / off a machine without it.
export function webFontStack(family, category) {
  const q = /[^a-z0-9]/i.test(family) ? `"${family}"` : family;
  return `${q}, ${category || "sans-serif"}`;
}

// Pull the primary family name out of a font-family stack ("Roboto", sans-serif → Roboto).
export function primaryFamily(stack) {
  const first = String(stack || "").split(",")[0].trim();
  return first.replace(/^["']|["']$/g, "");
}

export async function searchCatalog(q = "", source = "") {
  try {
    const qs = `q=${encodeURIComponent(q)}` + (source ? `&source=${encodeURIComponent(source)}` : "");
    return (await api(`/api/fonts/catalog?${qs}`)).fonts || [];
  } catch { return []; }
}

// The provider list for the browser's source filter (label + id). Fetched lazily; falls back.
export async function fontSources() {
  try { const r = await api("/api/fonts/catalog?q=__none__"); return r.sources || []; }
  catch { return ["Fontsource", "Fontshare", "Google Fonts"]; }
}

// Ensure a web font is cached server-side (from `source`, or resolved across sources) AND
// registered as a live FontFace. Idempotent; records the source + category for reuse/embedding.
export async function loadWebFont(family, weight = 400, italic = false, source = "", category = "sans-serif") {
  const vk = variantKey(weight, italic);
  const have = loaded.get(family);
  if (have && have.variants[vk]) return have.variants[vk];
  const res = await api("/api/fonts/load", "POST", { family, weight, italic, source });
  if (!res || !res.url) throw new Error("Font load failed");
  if (typeof FontFace === "function" && document.fonts) {
    try {
      const ff = new FontFace(family, `url(${res.url}) format("woff2")`,
        { weight: String(weight), style: italic ? "italic" : "normal" });
      await ff.load();
      document.fonts.add(ff);
    } catch { /* fall back to whatever the stack resolves to */ }
  }
  const slot = _slot(family);
  slot.variants[vk] = res.url;
  slot.source = res.source || source || slot.source;
  if (category) slot.category = category;
  return res.url;
}

export function isWebFontLoaded(family, weight = 400, italic = false) {
  const slot = loaded.get(family);
  return !!(slot && slot.variants[variantKey(weight, italic)]);
}

// Re-populate the registry from the on-disk cache after a page reload: the in-memory `loaded`
// Map is wiped on navigation, so without this the Installed list is empty AND saved docs can't
// re-embed their fonts (embedFontFaceCSS only sees registered faces). Family names come from the
// server manifest; each cached variant is registered as a FontFace so existing document text
// renders in its real face again. Idempotent + best-effort (never throws).
export async function hydrateInstalled() {
  let res;
  try { res = await api("/api/fonts/installed"); } catch { return; }
  for (const f of (res && res.families) || []) {
    if (!f.family) continue;
    const slot = _slot(f.family);
    if (f.source) slot.source = f.source;
    for (const v of f.variants || []) {
      const w = v.weight || 400, ital = !!v.italic;
      if (slot.variants[variantKey(w, ital)]) continue;
      slot.variants[variantKey(w, ital)] = v.url;
      if (typeof FontFace === "function" && document.fonts) {
        try {
          const ff = new FontFace(f.family, `url(${v.url}) format("woff2")`,
            { weight: String(w), style: ital ? "italic" : "normal" });
          ff.load().then((face) => document.fonts.add(face)).catch(() => {});
        } catch { /* unsupported url/format → skip */ }
      }
    }
  }
}

// Await the browser's font pipeline (used before PNG rasterise so glyphs aren't dropped).
export async function fontsReady() {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch { /* best effort */ }
}

// ---- save-time embedding (T13) --------------------------------------------
// Build a <style> with base64 @font-face blocks for every LOADED web face that the SVG
// actually uses, so the saved file renders correctly off-machine. Returns "" if none apply.
export async function embedFontFaceCSS(svgText) {
  // which (family, weight, italic) appear, scoped to web fonts we loaded
  const wanted = new Map();   // family -> Set(vk)
  for (const [family, slot] of loaded) {
    const q = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`font-family\\s*[:=]\\s*["']?${q}`, "i").test(svgText)) continue;
    for (const vk of Object.keys(slot.variants)) (wanted.get(family) || wanted.set(family, new Set()).get(family)).add(vk);
  }
  if (!wanted.size) return "";
  const blocks = [];
  for (const [family, vks] of wanted) {
    for (const vk of vks) {
      const url = loaded.get(family).variants[vk];
      const [weight, ital] = vk.split("|");
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const b64 = base64FromBuffer(buf);
        blocks.push(`@font-face{font-family:'${family}';font-weight:${weight};font-style:${ital === "1" ? "italic" : "normal"};`
          + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
      } catch { /* skip a face that won't fetch rather than fail the whole save */ }
    }
  }
  return blocks.length ? `<style type="text/css">${blocks.join("")}</style>` : "";
}

function base64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;   // avoid String.fromCharCode arg-count blowups on big files
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// ---- the browser popover (T11) --------------------------------------------
let openEl = null;
export function closeFontBrowser() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener("pointerdown", onDocDown, true); document.removeEventListener("keydown", onDocKey, true); } }
function onDocDown(e) { if (openEl && !openEl.contains(e.target)) closeFontBrowser(); }
function onDocKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeFontBrowser(); } }

// Source filter chips: id (server-side `source` param) + label. "" = all sources.
const SOURCE_FILTERS = [["", "All"], ["fontsource", "Fontsource"], ["fontshare", "Fontshare"], ["google", "Google"]];

// Anchor a search-as-you-type, multi-source font browser under `anchorEl`. Sections: your
// Installed fonts (downloaded this session, instant), System stacks, then live web results
// from every source with a per-row source badge. onPick(stack, {family,category,web,source}).
export function openFontBrowser(anchorEl, current, onPick) {
  closeFontBrowser();
  const pop = document.createElement("div");
  pop.className = "font-browser";
  pop.innerHTML = '<input class="font-search" type="text" placeholder="Search fonts — Fontsource · Fontshare · Google…" spellcheck="false">'
    + '<div class="font-srcbar"></div><div class="font-results"></div>';
  document.body.appendChild(pop);
  openEl = pop;
  const r = anchorEl ? anchorEl.getBoundingClientRect() : { left: 200, bottom: 120, width: 200 };
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 312)) + "px";
  pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 392) + "px";
  const input = pop.querySelector(".font-search");
  const srcbar = pop.querySelector(".font-srcbar");
  const list = pop.querySelector(".font-results");
  const curFam = primaryFamily(current);
  let srcFilter = "";

  const pick = async (stack, meta) => {
    if (meta.web) {
      const row = meta.row; if (row) row.classList.add("loading");
      try { await loadWebFont(meta.family, 400, false, meta.source, meta.category); }
      catch { if (row) { row.classList.remove("loading"); row.classList.add("err"); } return; }
    }
    onPick(stack, meta);
    closeFontBrowser();
  };

  // source filter chips
  for (const [id, label] of SOURCE_FILTERS) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "font-chip" + (id === srcFilter ? " active" : ""); chip.textContent = label; chip.dataset.src = id;
    chip.addEventListener("click", () => { srcFilter = id; srcbar.querySelectorAll(".font-chip").forEach((c) => c.classList.toggle("active", c.dataset.src === id)); run(); });
    srcbar.appendChild(chip);
  }

  const webRow = (f) => {
    const row = document.createElement("button");
    row.type = "button"; row.className = "font-row" + (f.family === curFam ? " active" : "");
    // textContent, not innerHTML — family/source come from a remote catalogue and a name with
    // <, &, or " would otherwise inject markup into the popover.
    const name = document.createElement("span"); name.className = "font-row-name"; name.textContent = f.family;
    const src = document.createElement("span"); src.className = "font-row-src";
    src.setAttribute("data-s", f.source || ""); src.textContent = f.sourceLabel || f.source || "";
    row.append(name, src);
    if (isWebFontLoaded(f.family)) row.style.fontFamily = webFontStack(f.family, f.category);
    const meta = { family: f.family, category: f.category, web: true, source: f.source, row };
    row.addEventListener("click", () => pick(webFontStack(f.family, f.category), meta));
    return row;
  };

  const render = (webFonts, failed, total) => {
    list.innerHTML = "";
    const section = (title) => { const h = document.createElement("div"); h.className = "font-sec"; h.textContent = title; list.appendChild(h); };
    const q = input.value.trim().toLowerCase();
    // Installed (downloaded this session) — instant reuse, the in-app "library".
    const inst = installedFamilies().filter((f) => !q || f.family.toLowerCase().includes(q));
    if (inst.length && !srcFilter) {
      section("Installed");
      for (const f of inst) list.appendChild(webRow({ ...f, sourceLabel: "Installed" }));
    }
    const sys = SYSTEM_FONTS.filter(([, label]) => !q || label.toLowerCase().includes(q));
    if (sys.length && !srcFilter) {
      section("System");
      for (const [stack, label, cat] of sys) {
        const row = document.createElement("button");
        row.type = "button"; row.className = "font-row" + (primaryFamily(stack) === curFam ? " active" : "");
        row.innerHTML = `<span class="font-row-name">${label}</span>`; row.style.fontFamily = stack;
        row.addEventListener("click", () => pick(stack, { family: primaryFamily(stack), category: cat, web: false }));
        list.appendChild(row);
      }
    }
    // A family shown under Installed shouldn't also repeat in the Web list below. Only dedupe when
    // the Installed section is actually visible (it's hidden under a source filter, where the web
    // list is the only place the family can appear).
    const shown = (!srcFilter) ? new Set(inst.map((f) => f.family.toLowerCase())) : null;
    const webShow = shown ? webFonts.filter((f) => !shown.has(f.family.toLowerCase())) : webFonts;
    if (webShow.length) {
      section(srcFilter ? SOURCE_FILTERS.find(([id]) => id === srcFilter)[1] : "Web fonts · all sources");
      for (const f of webShow) list.appendChild(webRow(f));
      // The server caps how many it returns; if there are more matches, say so rather than imply
      // this is the whole list — refining the query narrows it down to what fits.
      if (total && total > webFonts.length) {
        const more = document.createElement("div"); more.className = "font-empty";
        more.textContent = `Showing ${webFonts.length} of ${total} matches — type more to narrow it down.`;
        list.appendChild(more);
      }
    } else if (failed) {
      // The catalogue fetch failed (offline / sources down) — say so rather than imply "no fonts
      // exist". Installed + System above still work; downloads just can't resolve right now.
      section("Web fonts");
      const e = document.createElement("div"); e.className = "font-empty";
      e.textContent = "Font sources unreachable — offline? Installed + System fonts still work.";
      list.appendChild(e);
    }
    if (!inst.length && !sys.length && !webFonts.length && !failed) { const e = document.createElement("div"); e.className = "font-empty"; e.textContent = "No matches."; list.appendChild(e); }
  };

  let seq = 0;
  async function run() {
    const mine = ++seq;
    // Fetch directly (not via searchCatalog) so we can tell a FAILED fetch (offline) from an empty
    // result and surface the difference. searchCatalog stays the swallow-errors helper for others.
    // A typed query asks for a big page (so search is effectively complete); the empty browse view
    // asks for a smaller one (popular-first + a scroll's worth), since the full catalogue is 2000+.
    let web = [], failed = false, total = 0;
    try {
      const q = input.value.trim();
      const lim = q ? 500 : 150;
      const qs = `q=${encodeURIComponent(q)}&limit=${lim}` + (srcFilter ? `&source=${encodeURIComponent(srcFilter)}` : "");
      const r = await api(`/api/fonts/catalog?${qs}`);
      web = r.fonts || []; total = r.total || web.length;
    } catch { failed = true; }
    if (mine === seq && openEl === pop) render(web, failed, total);
  }
  let t = null;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 200); });
  input.addEventListener("keydown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onDocKey, true);
  run();
  setTimeout(() => input.focus(), 0);
}
