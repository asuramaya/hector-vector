// Cloud text→outlines adapter — the platform.textOutline impl for the serverless build.
// The desktop app shapes with HarfBuzz + extracts glyphs with fontTools on the server; the
// browser build now does the SAME shaping with harfbuzzjs (HarfBuzz compiled to WASM, lazy-loaded
// only when someone actually converts text), so ligatures, kerning, and complex-script reordering
// (Arabic joining, Indic reordering, etc.) all work — this is real GSUB/GPOS shaping, not a
// per-character advance-width approximation. One HarfBuzz Font object does both the shaping AND
// the glyph→path extraction (font.glyphToPath / a custom DrawFuncs for the coordinate transform),
// so there's no second font-parsing library needed.
//
// The one real gap left vs. desktop: a run is shaped against a SINGLE font file, picked by the
// text's DOMINANT script (detectSubset below). Desktop can in principle mix scripts within one
// object via per-glyph font substitution; a browser text object with mixed scripts (e.g. an
// English label with one Arabic word) will shape correctly for the dominant script and fall back
// to .notdef-style boxes for glyphs the chosen font's subset doesn't cover. Real multi-script runs
// within one object are a bigger feature (segment text into script runs, shape+font each
// separately, stitch the paths together) — not attempted here.
//
// Returns the exact shape text.js expects: { d } for a text block, { glyphs:[{d,w,adv}] } for an
// on-path run.

const HB_URL = "https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.0/dist/index.mjs";
let _hbPromise = null;
function ensureHarfbuzz() {
  if (!_hbPromise) _hbPromise = import(HB_URL);
  return _hbPromise;
}

// Unicode-block -> Fontsource/Google subset name. Checked per character; the subset with the most
// hits across the text wins (detectSubset). Deliberately not exhaustive — covers the scripts
// Fontsource actually ships as their own subset files (see FALLBACK_FAMILY below).
const SCRIPT_RANGES = [
  ["cyrillic", [[0x0400, 0x04FF], [0x0500, 0x052F]]],
  ["greek", [[0x0370, 0x03FF], [0x1F00, 0x1FFF]]],
  ["armenian", [[0x0530, 0x058F]]],
  ["hebrew", [[0x0590, 0x05FF]]],
  ["arabic", [[0x0600, 0x06FF], [0x0750, 0x077F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]]],
  ["devanagari", [[0x0900, 0x097F]]],
  ["bengali", [[0x0980, 0x09FF]]],
  ["gurmukhi", [[0x0A00, 0x0A7F]]],
  ["gujarati", [[0x0A80, 0x0AFF]]],
  ["oriya", [[0x0B00, 0x0B7F]]],
  ["tamil", [[0x0B80, 0x0BFF]]],
  ["telugu", [[0x0C00, 0x0C7F]]],
  ["kannada", [[0x0C80, 0x0CFF]]],
  ["malayalam", [[0x0D00, 0x0D7F]]],
  ["sinhala", [[0x0D80, 0x0DFF]]],
  ["thai", [[0x0E00, 0x0E7F]]],
  ["lao", [[0x0E80, 0x0EFF]]],
  ["georgian", [[0x10A0, 0x10FF]]],
  ["ethiopic", [[0x1200, 0x137F]]],
  ["myanmar", [[0x1000, 0x109F]]],
  ["khmer", [[0x1780, 0x17FF]]],
  ["korean", [[0xAC00, 0xD7A3], [0x1100, 0x11FF]]],   // Hangul syllables + jamo
  ["japanese", [[0x3040, 0x309F], [0x30A0, 0x30FF]]],  // hiragana + katakana (kana implies JA even amid Han)
  ["chinese-simplified", [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]]],   // bare Han: default to simplified
];

function detectSubset(text) {
  const counts = Object.create(null);
  for (const ch of Array.from(String(text || ""))) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) continue;   // ASCII (incl. plain digits/punctuation) carries no script signal
    for (const [subset, ranges] of SCRIPT_RANGES) {
      if (ranges.some(([a, b]) => cp >= a && cp <= b)) {
        counts[subset] = (counts[subset] || 0) + 1;
        break;
      }
    }
  }
  let best = "latin", bestN = 0;
  for (const [subset, n] of Object.entries(counts)) if (n > bestN) { best = subset; bestN = n; }
  return best;
}

// Every non-Latin subset above has its own single-script Noto family on Fontsource (verified:
// noto-sans-arabic, noto-sans-devanagari, ... one per script) — the base "noto-sans" family only
// covers the Latin-adjacent subsets (latin, latin-ext, cyrillic, greek, vietnamese) plus
// devanagari. Used as the fallback when the REQUESTED family doesn't ship the detected subset.
const FALLBACK_FAMILY = {
  arabic: "noto-sans-arabic", hebrew: "noto-sans-hebrew", thai: "noto-sans-thai",
  lao: "noto-sans-lao", tamil: "noto-sans-tamil", telugu: "noto-sans-telugu",
  kannada: "noto-sans-kannada", malayalam: "noto-sans-malayalam", bengali: "noto-sans-bengali",
  gujarati: "noto-sans-gujarati", gurmukhi: "noto-sans-gurmukhi", oriya: "noto-sans-oriya",
  sinhala: "noto-sans-sinhala", myanmar: "noto-sans-myanmar", khmer: "noto-sans-khmer",
  georgian: "noto-sans-georgian", armenian: "noto-sans-armenian", ethiopic: "noto-sans-ethiopic",
  korean: "noto-sans-kr", japanese: "noto-sans-jp", "chinese-simplified": "noto-sans-sc",
};
const fontsourceId = (family) => String(family || "").trim().toLowerCase().replace(/\s+/g, "-");

const _fontCache = new Map();
async function loadOutlineFont(hb, family, weight, italic, subset) {
  const style = italic ? "italic" : "normal";
  const key = `${fontsourceId(family)}-${subset}-${weight}-${style}`;
  if (_fontCache.has(key)) return _fontCache.get(key);

  const urlsFor = (id) => [
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-${weight}-${style}.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-400-${style}.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-400-normal.ttf`,
  ];
  const ids = [fontsourceId(family)];
  if (FALLBACK_FAMILY[subset]) ids.push(FALLBACK_FAMILY[subset]);   // requested family lacks the script
  else if (subset !== "latin") ids.push("noto-sans");                // latin-adjacent subset, base Noto covers it

  let buf = null;
  outer: for (const id of ids) {
    for (const u of urlsFor(id)) {
      try {
        const r = await fetch(u);
        if (r.ok) { buf = await r.arrayBuffer(); break outer; }
      } catch { /* try next */ }
    }
  }
  if (!buf) throw new Error(`No outline font available for “${family}” (${subset}).`);

  const face = new hb.Face(new hb.Blob(buf));
  const font = new hb.Font(face);
  const result = { font, upem: face.upem };
  _fontCache.set(key, result);
  return result;
}

// One shared DrawFuncs: each call site passes drawData = {scale, tx, ty, out} and the callbacks
// apply (scale, 0, 0, -scale, tx, ty) — the same "scale + flip font-Y-up to SVG-Y-down + place at
// this glyph's origin" transform the desktop's fontTools TransformPen uses — while appending
// SVG path commands to `out`. r() keeps output at 2-decimal precision, matching the desktop path.
const r = (n) => Math.round(n * 100) / 100;
let _drawFuncs = null;
function drawFuncs(hb) {
  if (_drawFuncs) return _drawFuncs;
  const df = new hb.DrawFuncs();
  const tx = (x, y, d) => [x * d.scale + d.tx, -y * d.scale + d.ty];
  df.setMoveToFunc((x, y, d) => { const [X, Y] = tx(x, y, d); d.out.push(`M${r(X)},${r(Y)}`); });
  df.setLineToFunc((x, y, d) => { const [X, Y] = tx(x, y, d); d.out.push(`L${r(X)},${r(Y)}`); });
  df.setCubicToFunc((c1x, c1y, c2x, c2y, x, y, d) => {
    const [X1, Y1] = tx(c1x, c1y, d), [X2, Y2] = tx(c2x, c2y, d), [X, Y] = tx(x, y, d);
    d.out.push(`C${r(X1)},${r(Y1)} ${r(X2)},${r(Y2)} ${r(X)},${r(Y)}`);
  });
  df.setQuadraticToFunc((cx, cy, x, y, d) => {
    const [CX, CY] = tx(cx, cy, d), [X, Y] = tx(x, y, d);
    d.out.push(`Q${r(CX)},${r(CY)} ${r(X)},${r(Y)}`);
  });
  df.setClosePathFunc((d) => { d.out.push("Z"); });
  _drawFuncs = df;
  return df;
}
function glyphPath(hb, font, gid, scale, tx, ty) {
  const d = { scale, tx, ty, out: [] };
  font.drawGlyph(gid, drawFuncs(hb), d);
  return d.out.join("");
}

function shapeLine(hb, font, text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  buffer.destroy?.();
  return infos.map((info, i) => ({ gid: info.codepoint, pos: positions[i] }));
}

export async function cloudTextOutline(payload) {
  const hb = await ensureHarfbuzz();
  const {
    text = "", family, weight = 400, italic = false, fontSize = 16,
    letterSpacing = 0, lineHeight = fontSize * 1.2, anchor = "start", x = 0, y = 0, perGlyph = false,
  } = payload || {};
  const subset = detectSubset(text);
  const { font, upem } = await loadOutlineFont(hb, family, weight, italic, subset);
  const scale = fontSize / (upem || 1000);

  if (perGlyph) {
    // One line (a textPath run): each glyph at local origin (0,0), text.js lays them along the
    // curve. Real shaping can merge characters into ligatures, so the output array's length may
    // be shorter than the input string's — that's correct, not a bug.
    const glyphs = shapeLine(hb, font, String(text).replace(/\n/g, " "));
    return {
      glyphs: glyphs.map(({ gid, pos }) => {
        const w = pos.xAdvance * scale;
        const d = glyphPath(hb, font, gid, scale, pos.xOffset * scale, -pos.yOffset * scale);
        return { d, w, adv: w + letterSpacing };
      }),
    };
  }

  // A text block: lay out each visual line, apply the anchor, concat into one absolute-coords path.
  const parts = [];
  String(text).split("\n").forEach((line, li) => {
    const shaped = shapeLine(hb, font, line);
    let lw = shaped.reduce((s, { pos }) => s + pos.xAdvance * scale + letterSpacing, 0);
    if (shaped.length) lw -= letterSpacing;   // no trailing tracking
    let cx = x - (anchor === "middle" ? lw / 2 : anchor === "end" ? lw : 0);
    const ly = y + li * lineHeight;
    for (const { gid, pos } of shaped) {
      const d = glyphPath(hb, font, gid, scale, cx + pos.xOffset * scale, ly - pos.yOffset * scale);
      if (d) parts.push(d);
      cx += pos.xAdvance * scale + letterSpacing;
    }
  });
  return { d: parts.join(" ") || null };
}
