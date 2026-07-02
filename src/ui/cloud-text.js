// Cloud text→outlines adapter — the platform.textOutline impl for the serverless build.
// The desktop app shapes with HarfBuzz + extracts glyphs with fonttools on the server; in the
// browser we lazy-load opentype.js (only when someone converts text) and pull a parseable TTF for
// the family straight from the jsDelivr Fontsource CDN (the Google CSS2 API only serves woff2,
// which opentype.js can't decompress). This is a Latin-grade path — basic per-glyph advances, no
// complex-script shaping — matching the desktop's no-HarfBuzz fallback tier. Returns the exact
// shape text.js expects: { d } for a text block, { glyphs:[{d,w,adv}] } for an on-path run.

const OPENTYPE_URL = "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js";
let _otPromise = null;
function ensureOpentype() {
  if (typeof window !== "undefined" && window.opentype) return Promise.resolve(window.opentype);
  if (!_otPromise) _otPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = OPENTYPE_URL;
    s.onload = () => (window.opentype ? resolve(window.opentype) : reject(new Error("outline engine failed to load")));
    s.onerror = () => reject(new Error("Couldn't load the outline engine (opentype.js)."));
    document.head.appendChild(s);
  });
  return _otPromise;
}

const _fontCache = new Map();
const fontsourceId = (family) => String(family || "").trim().toLowerCase().replace(/\s+/g, "-");

async function loadOutlineFont(ot, family, weight, italic) {
  const id = fontsourceId(family);
  if (!id) throw new Error("No font family.");
  const style = italic ? "italic" : "normal";
  const key = `${id}-${weight}-${style}`;
  if (_fontCache.has(key)) return _fontCache.get(key);
  // Try the requested variant, then the same style at 400, then plain 400-normal.
  const urls = [
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-${style}.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-400-${style}.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-400-normal.ttf`,
  ];
  let font = null;
  for (const u of urls) {
    try { const r = await fetch(u); if (!r.ok) continue; font = ot.parse(await r.arrayBuffer()); break; }
    catch { /* try next */ }
  }
  if (!font) throw new Error(`No outline font available for “${family}”.`);
  _fontCache.set(key, font);
  return font;
}

export async function cloudTextOutline(payload) {
  const ot = await ensureOpentype();
  const {
    text = "", family, weight = 400, italic = false, fontSize = 16,
    letterSpacing = 0, lineHeight = fontSize * 1.2, anchor = "start", x = 0, y = 0, perGlyph = false,
  } = payload || {};
  const font = await loadOutlineFont(ot, family, weight, italic);
  const scale = fontSize / font.unitsPerEm;
  const advOf = (g) => g.advanceWidth * scale;

  if (perGlyph) {
    // One line (a textPath run). Glyphs at origin (0,0 baseline); text.js lays them along the curve.
    const glyphs = [];
    for (const ch of Array.from(String(text))) {
      const g = font.charToGlyph(ch);
      const w = advOf(g);
      glyphs.push({ d: g.getPath(0, 0, fontSize).toPathData(2), w, adv: w + letterSpacing });
    }
    return { glyphs };
  }

  // A text block: lay out each visual line, apply the anchor, concat into one absolute-coords path.
  const parts = [];
  String(text).split("\n").forEach((line, li) => {
    const chars = Array.from(line);
    const gs = chars.map((ch) => { const g = font.charToGlyph(ch); return { g, w: advOf(g) }; });
    let lw = gs.reduce((s, o) => s + o.w + letterSpacing, 0);
    if (chars.length) lw -= letterSpacing;   // no trailing tracking
    let cx = x - (anchor === "middle" ? lw / 2 : anchor === "end" ? lw : 0);
    const ly = y + li * lineHeight;
    for (const { g, w } of gs) {
      const d = g.getPath(cx, ly, fontSize).toPathData(2);
      if (d) parts.push(d);
      cx += w + letterSpacing;
    }
  });
  return { d: parts.join(" ") || null };
}
