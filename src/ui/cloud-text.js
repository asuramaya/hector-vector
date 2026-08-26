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
// Returns the exact shape text.js expects: { colors:[{color,d}] } for a text block (one path per
// distinct run color — SVG can't mix fills within one <path>; color:null means "caller's own
// default fill"), { glyphs:[{d,w,adv}] } for an on-path run (on-path stays single-style, v1 —
// see text.js's own header comment on why rich runs are scoped to point/area text only).
//
// Rich runs (v1: per-run bold/italic/color, one family/size for the whole object — see text.js):
// `payload.lines`, when given, REPLACES `text`: [{runs:[{text,bold,italic,color}]}], one entry
// per paragraph. Every run loads its OWN (weight,italic) font via loadOutlineFont (already
// cached there per family+subset+weight+style, so a repeated combo across runs/lines is free)
// and is shaped independently, but all runs on one line share ONE continuous pen position (in
// px, not font units — different runs can be different UPM-scaled fonts) so glyphs sit flush
// across a run boundary, matching the desktop server's identical approach in text_to_outline.

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
    // ASCII letters must vote for "latin" too, not be silently skipped — otherwise a single
    // stray non-Latin character (a pasted accented name, a smart quote outside 0x80... this
    // still catches real script chars, curly quotes/em-dashes are outside SCRIPT_RANGES and
    // fall through to the ignored branch below) in an otherwise-Latin string would outvote the
    // dominant script 1-to-0 and hijack the WHOLE run onto the wrong font, not just leave that
    // one character unmapped — found live via a "Test क" test case that shaped the entire word
    // "Test" as missing glyphs instead of just the trailing Devanagari character.
    if (/[A-Za-z]/.test(ch)) { counts.latin = (counts.latin || 0) + 1; continue; }
    const cp = ch.codePointAt(0);
    if (cp < 0x80) continue;   // digits/punctuation/whitespace carry no script signal
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

// System/undownloadable-face -> metric-compatible OFL stand-in, mirrored from desktop's
// _FONT_SUBSTITUTES (hvserver/fonts.py) so a document that names "Arial" gets the SAME reported
// substitute on both builds, not just a fallback that happens to also work.
const FONT_SUBSTITUTES = {
  arial: "Arimo", helvetica: "Arimo", "helvetica neue": "Arimo", "liberation sans": "Arimo",
  times: "Tinos", "times new roman": "Tinos", "liberation serif": "Tinos",
  courier: "Cousine", "courier new": "Cousine", "liberation mono": "Cousine",
  georgia: "Gelasio",
  "sans-serif": "Arimo", serif: "Tinos", monospace: "Cousine", "ui-sans-serif": "Arimo",
  verdana: "Arimo", tahoma: "Arimo", "trebuchet ms": "Arimo", "segoe ui": "Arimo",
  calibri: "Arimo", "system-ui": "Arimo", "ui-serif": "Tinos", "ui-monospace": "Cousine",
};

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
  // Reported to the caller as `substituted` whenever the family that actually loaded isn't the
  // one asked for — a named system-font stand-in (Arial -> Arimo, same table desktop uses) tried
  // first so the user sees the SAME substitute name on both builds, then the generic script
  // fallback for anything else that doesn't ship the detected subset.
  const namedSub = FONT_SUBSTITUTES[fontsourceId(family).replace(/-/g, " ")];
  const ids = [{ id: fontsourceId(family), label: null }];
  if (namedSub) ids.push({ id: fontsourceId(namedSub), label: namedSub });
  if (FALLBACK_FAMILY[subset]) ids.push({ id: FALLBACK_FAMILY[subset], label: FALLBACK_FAMILY[subset] });
  else if (subset !== "latin") ids.push({ id: "noto-sans", label: "Noto Sans" });

  let buf = null, substituted = null;
  outer: for (const { id, label } of ids) {
    for (const u of urlsFor(id)) {
      try {
        const r = await fetch(u);
        if (r.ok) { buf = await r.arrayBuffer(); substituted = label; break outer; }
      } catch { /* try next */ }
    }
  }
  if (!buf) throw new Error(`No outline font available for “${family}” (${subset}).`);

  const face = new hb.Face(new hb.Blob(buf));
  const font = new hb.Font(face);
  const result = { font, upem: face.upem, substituted };
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

// Characters the font has no glyph for at all — checked BEFORE shaping (same as desktop's cmap
// check), independent of what GSUB substitution does afterward, since post-shaping glyph ids
// don't map 1:1 back to input characters (ligatures merge several into one). Matches desktop's
// `ch.strip()` filter: whitespace never counts as "missing".
function missingChars(font, text) {
  const missing = new Set();
  for (const ch of Array.from(String(text || ""))) {
    if (!ch.trim()) continue;
    if (font.nominalGlyph(ch.codePointAt(0)) === undefined) missing.add(ch);
  }
  return [...missing].sort();
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
    lines: rawLines = null,
  } = payload || {};
  // Subset (script) detection stays whole-object even with rich runs: every run shares one
  // family, and script picks which SUBSET/fallback of that family loads, not the family itself.
  const allText = rawLines ? rawLines.flatMap((l) => (l.runs || []).map((r) => r.text || "")).join("") : text;
  const subset = detectSubset(allText);
  const missing = new Set();
  let substituted = null;
  // Real HarfBuzz shaping runs unconditionally here (no optional-dependency fallback tier the
  // way desktop has for a missing uharfbuzz install), so there's no "the fallback shaper can't
  // handle this script" case to flag — always null, kept for contract parity with desktop's
  // { missing, substituted, complexScript } shape that text.js reads on both builds.
  const complexScript = null;
  const _loaded = new Map();   // (weight,italic) -> {font,upem,substituted}, this call only
  async function fontFor(bold, runItalic) {
    const w = bold ? 700 : weight, it = italic || runItalic;
    const key = w + "|" + it;
    if (_loaded.has(key)) return _loaded.get(key);
    const r = await loadOutlineFont(hb, family, w, it, subset);
    if (r.substituted && !substituted) substituted = r.substituted;
    _loaded.set(key, r);
    return r;
  }

  if (perGlyph) {
    // On-path text is scoped OUT of rich runs (v1, see text.js) — always single-style; `lines`
    // is never set here. One line (a textPath run): each glyph at local origin (0,0), text.js
    // lays them along the curve. Real shaping can merge characters into ligatures, so the output
    // array's length may be shorter than the input string's — that's correct, not a bug. gid 0
    // (.notdef, a character the font truly has no glyph for) draws nothing — a clean gap, same
    // as desktop's "skip it" — but still keeps its shaped advance so spacing doesn't collapse.
    const { font, upem } = await fontFor(false, false);
    const scale = fontSize / (upem || 1000);
    for (const ch of missingChars(font, text)) missing.add(ch);
    const glyphs = shapeLine(hb, font, String(text).replace(/\n/g, " "));
    return {
      glyphs: glyphs.map(({ gid, pos }) => {
        const w = pos.xAdvance * scale;
        const d = gid === 0 ? "" : glyphPath(hb, font, gid, scale, pos.xOffset * scale, -pos.yOffset * scale);
        return { d, w, adv: w + letterSpacing };
      }),
      missing: [...missing].sort(), substituted, complexScript,
    };
  }

  // lines: [{runs:[{text,bold,italic,color}]}] when rich; a plain `text` string becomes one
  // default-style run per \n-separated paragraph, so the loop below is the ONE code path either way.
  const lines = rawLines || String(text).split("\n").map((t) => ({ runs: [{ text: t, bold: false, italic: false, color: null }] }));
  // colors[key] accumulates this run-color's own path fragments across every line — one <path>
  // per distinct color on the client (a path has one fill). key=null is "no override, caller's
  // own default fill applies" — always present, even empty, so a plain text keeps returning a
  // single, familiar entry (color:null). Mirrors the desktop server's identical structure.
  const colors = new Map([[null, []]]);
  let glyphCount = 0, maxAdvance = 0;
  for (let li = 0; li < lines.length; li++) {
    const runShapes = [];   // {font, upem, scale, shaped, color}
    let totalPx = 0;
    for (const run of (lines[li].runs || [])) {
      const runText = run.text || ""; if (!runText) continue;
      const { font, upem } = await fontFor(!!run.bold, !!run.italic);
      const scale = fontSize / (upem || 1000);
      for (const ch of missingChars(font, runText)) missing.add(ch);
      const shaped = shapeLine(hb, font, runText);
      runShapes.push({ font, scale, shaped, color: run.color || null });
      totalPx += shaped.reduce((s, { pos }) => s + pos.xAdvance * scale + letterSpacing, 0) - (shaped.length ? letterSpacing : 0);
    }
    if (!runShapes.length) continue;
    maxAdvance = Math.max(maxAdvance, totalPx);
    let cx = x - (anchor === "middle" ? totalPx / 2 : anchor === "end" ? totalPx : 0);
    const ly = y + li * lineHeight;
    for (const { font, scale, shaped, color } of runShapes) {
      if (!colors.has(color)) colors.set(color, []);
      const parts = colors.get(color);
      for (const { gid, pos } of shaped) {
        if (gid !== 0) {   // .notdef: skip drawing (clean gap), still advance below
          const d = glyphPath(hb, font, gid, scale, cx + pos.xOffset * scale, ly - pos.yOffset * scale);
          if (d) parts.push(d);
          glyphCount++;
        }
        cx += pos.xAdvance * scale + letterSpacing;
      }
    }
  }
  const colorEntries = [...colors.entries()]
    .filter(([color, parts]) => parts.length || color === null)
    .map(([color, parts]) => ({ color, d: parts.join(" ") || null }));
  return {
    colors: colorEntries, d: colorEntries.length === 1 ? colorEntries[0].d : null,
    empty: glyphCount === 0, glyphs: glyphCount, advance: maxAdvance,
    missing: [...missing].sort(), substituted, complexScript,
  };
}
