// The PLATFORM BOUNDARY.
//
// The editor's handful of server-touching features (fonts, text→outlines, and — later —
// document persistence) call THESE methods instead of the server directly. That's what lets the
// exact same editor code run two ways from one codebase:
//   • the local desktop app injects SERVER adapters (POST to the Python backend), and
//   • a serverless cloud build injects CLIENT adapters (public-CDN fonts, WASM/degraded shaping,
//     download/IndexedDB persistence).
// The editor never says `if (CLOUD)` — it just calls `platform.loadFont(...)`. One implementation
// object is injected once at boot via `configurePlatform`, the same dependency-injection pattern
// as configureColorPicker / configureMenus / configureLibrary.
//
// Contract (every method is async and may reject — callers already handle failure):
//   fontCatalog(qs: string)                    -> { fonts: [...], total?: number }
//   loadFont({ family, weight, italic, source }) -> { url, source? }   // url usable by FontFace + fetch()
//   installedFonts()                           -> { families: [...] }
//   textOutline(payload)                       -> { ... glyph-outline result ... }
//
// `platform` is a live binding: consumers `import { platform }` and call `platform.method(...)`
// (never destructure — destructuring would capture the null before configurePlatform runs).
export let platform = null;
export function configurePlatform(impl) { platform = impl; }
