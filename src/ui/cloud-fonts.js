// Cloud fonts adapter — the platform.fontCatalog / loadFont / installedFonts implementations for
// the serverless build. There's no backend proxy, so:
//   • discovery reads a bundled snapshot of the ENTIRE Google Fonts catalog (~1900 families, no
//     API key, no live cross-origin call — see below), and
//   • loading fetches the family's woff2 straight from the Google Fonts CSS2 API (CORS-open) and
//     hands the URL back to fonts.js, which registers it as a live FontFace exactly as on desktop.
// The per-family loader already worked for any family name; the catalog was the only thing
// artificially small. Latin-grade text-to-outlines shaping remains a separate limitation, handled
// in cloud-text.js.

// /assets/google-fonts-catalog.json: [family, category, subsets[]] tuples, ~1900 entries, sorted by
// Google's own popularity ranking. Generated from https://fonts.google.com/metadata/fonts (public,
// keyless, but no CORS headers — so it can't be fetched live from the browser at all; this snapshot
// is fetched server-side once and checked in instead). Regenerate by re-running that same fetch and
// re-deriving this shape; there's no live-refresh path by design (matches the no-build-step,
// static-assets-only cloud deploy). subsets is carried through for a future script-aware loader.
let _catalogPromise = null;
function loadBundledCatalog() {
  if (!_catalogPromise) {
    _catalogPromise = fetch("/assets/google-fonts-catalog.json")
      .then((r) => { if (!r.ok) throw new Error("font catalog fetch failed"); return r.json(); })
      .catch(() => []);   // offline/blocked: search just comes back empty rather than throwing
  }
  return _catalogPromise;
}

export async function cloudFontCatalog(qs) {
  const params = new URLSearchParams(qs || "");
  const q = (params.get("q") || "").toLowerCase().trim();
  const limit = parseInt(params.get("limit") || "150", 10) || 150;
  const raw = await loadBundledCatalog();
  let fonts = raw.map(([family, category, subsets]) => ({
    family, category, source: "google", weights: [400, 700], subsets,
  }));
  if (q) fonts = fonts.filter((f) => f.family.toLowerCase().includes(q));
  return { fonts: fonts.slice(0, limit), total: fonts.length, providers: ["google"] };
}

// Prefer the latin subset's woff2 (the CSS2 response carries several @font-face blocks, one per
// unicode subset, each preceded by a `/* latin */`-style comment); fall back to the first woff2.
function pickWoff2(css) {
  const afterLatin = css.split(/\/\*\s*latin\s*\*\//)[1];
  const scope = afterLatin || css;
  const m = scope.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  return m ? m[1] : null;
}

export async function cloudLoadFont({ family, weight = 400, italic = false }) {
  const fam = String(family || "").trim().replace(/\s+/g, "+");
  if (!fam) throw new Error("No font family.");
  const ital = italic ? "1" : "0";
  const specific = `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@${ital},${weight}&display=swap`;
  let css = "";
  try {
    const r = await fetch(specific);
    if (r.ok) css = await r.text();
  } catch { /* fall through to the bare request */ }
  if (!css || !/woff2/.test(css)) {
    // Family may not offer that weight/italic — ask for whatever it has.
    const r2 = await fetch(`https://fonts.googleapis.com/css2?family=${fam}&display=swap`);
    if (!r2.ok) throw new Error(`Google Fonts has no “${family}”.`);
    css = await r2.text();
  }
  const url = pickWoff2(css);
  if (!url) throw new Error(`Couldn't resolve a woff2 for “${family}”.`);
  return { url, source: "google" };
}

export async function cloudInstalledFonts() { return { families: [] }; }
