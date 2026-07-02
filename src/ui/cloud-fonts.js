// Cloud fonts adapter — the platform.fontCatalog / loadFont / installedFonts implementations for
// the serverless build. There's no backend proxy, so:
//   • discovery uses a bundled curated catalog of popular Google Fonts families (no API key), and
//   • loading fetches the family's woff2 straight from the Google Fonts CSS2 API (CORS-open) and
//     hands the URL back to fonts.js, which registers it as a live FontFace exactly as on desktop.
// Latin subset only (v1) — good for the common design-tool case; the desktop app remains the full
// multi-source + complex-script path.

// A curated slice of Google Fonts (family + category). Kept deliberately small + hand-picked;
// expand freely. fontCatalog filters this by the search query.
const CATALOG = [
  ["Inter", "sans-serif"], ["Roboto", "sans-serif"], ["Open Sans", "sans-serif"], ["Lato", "sans-serif"],
  ["Montserrat", "sans-serif"], ["Poppins", "sans-serif"], ["Raleway", "sans-serif"], ["Nunito", "sans-serif"],
  ["Nunito Sans", "sans-serif"], ["Work Sans", "sans-serif"], ["Rubik", "sans-serif"], ["Mulish", "sans-serif"],
  ["DM Sans", "sans-serif"], ["Manrope", "sans-serif"], ["Karla", "sans-serif"], ["Barlow", "sans-serif"],
  ["Source Sans 3", "sans-serif"], ["Figtree", "sans-serif"], ["Plus Jakarta Sans", "sans-serif"],
  ["Outfit", "sans-serif"], ["Sora", "sans-serif"], ["Space Grotesk", "sans-serif"], ["Kanit", "sans-serif"],
  ["Oswald", "sans-serif"], ["Josefin Sans", "sans-serif"], ["Quicksand", "sans-serif"], ["Comfortaa", "sans-serif"],
  ["Archivo", "sans-serif"], ["Archivo Narrow", "sans-serif"], ["Bebas Neue", "sans-serif"], ["Anton", "sans-serif"],
  ["Fira Sans", "sans-serif"], ["PT Sans", "sans-serif"], ["Cabin", "sans-serif"], ["Titillium Web", "sans-serif"],
  ["Hind", "sans-serif"], ["Heebo", "sans-serif"], ["Assistant", "sans-serif"], ["Signika", "sans-serif"],
  ["Merriweather", "serif"], ["Playfair Display", "serif"], ["PT Serif", "serif"], ["Lora", "serif"],
  ["Roboto Slab", "serif"], ["Noto Serif", "serif"], ["Bitter", "serif"], ["Crimson Text", "serif"],
  ["EB Garamond", "serif"], ["Cormorant Garamond", "serif"], ["Libre Baskerville", "serif"], ["Zilla Slab", "serif"],
  ["Domine", "serif"], ["Spectral", "serif"], ["Source Serif 4", "serif"], ["Frank Ruhl Libre", "serif"],
  ["Roboto Mono", "monospace"], ["Source Code Pro", "monospace"], ["JetBrains Mono", "monospace"],
  ["Fira Code", "monospace"], ["IBM Plex Mono", "monospace"], ["Space Mono", "monospace"], ["Inconsolata", "monospace"],
  ["Ubuntu Mono", "monospace"], ["Courier Prime", "monospace"],
  ["Pacifico", "handwriting"], ["Caveat", "handwriting"], ["Dancing Script", "handwriting"], ["Lobster", "handwriting"],
  ["Shadows Into Light", "handwriting"], ["Satisfy", "handwriting"], ["Great Vibes", "handwriting"],
  ["Sacramento", "handwriting"], ["Kalam", "handwriting"], ["Permanent Marker", "handwriting"],
  ["Abril Fatface", "display"], ["Righteous", "display"], ["Fredoka", "display"], ["Alfa Slab One", "display"],
  ["Bungee", "display"], ["Passion One", "display"], ["Titan One", "display"], ["Bangers", "display"],
  ["Cinzel", "display"], ["Philosopher", "display"], ["Orbitron", "display"], ["Audiowide", "display"],
];

export async function cloudFontCatalog(qs) {
  const params = new URLSearchParams(qs || "");
  const q = (params.get("q") || "").toLowerCase().trim();
  const limit = parseInt(params.get("limit") || "150", 10) || 150;
  let fonts = CATALOG.map(([family, category]) => ({
    family, category, source: "google", weights: [400, 700], subsets: ["latin"],
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
