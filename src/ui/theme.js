// The theme, and the one colour the user gets to choose.
//
// Until now hector-vector had exactly one appearance — white paper, black ink — and no mechanism to
// have any other. That was not a design decision anybody defended; it was simply that the app's
// colours had never been named, so there was nothing to redefine. Naming them (see the --accent
// split in style.css) is what made this a twenty-line module instead of a rewrite.
//
// Applied to <html>, not <body>, and applied EARLY (index.html calls applyTheme before the module
// graph finishes) — a theme that lands after first paint is a white flash on a black app, which is
// worse than no dark theme at all.
const KEY = "hector-vector:theme";
const HL_KEY = "hector-vector:highlight";

export const THEMES = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["invert", "Inverted"],
  ["system", "Match the system"],
];

// A curated shelf, because "pick any of 16 million" is not a choice, it is a chore. Every one of
// these has been checked to hold up as text-on-fill in all three themes — the highlight is a
// BACKGROUND with knocked-out text at least as often as it is a line, so a colour that looks lovely
// as a 1px rule and turns to mud behind white letters is not actually usable here.
// The custom picker is still there for anyone who wants it; this is the fast path.
export const HIGHLIGHTS = [
  ["", "Default"],           // whatever the theme says — the way back
  ["#1b73e8", "Signal"],
  ["#0891b2", "Lagoon"],
  ["#059669", "Moss"],
  ["#d1651b", "Ember"],
  ["#c2185b", "Rose"],
  ["#7c3aed", "Iris"],
  ["#111111", "Ink"],        // monochrome: the highlight IS the ink. Sharp, and very hv.
];

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

// "system" is a CHOICE, not a theme: resolve it to a real one at paint time. Stored as "system" so
// it keeps tracking the OS if the user changes it later — resolving on save would freeze it.
const resolve = (t) => (t === "system" ? (systemDark() ? "dark" : "light") : t);

export function currentTheme() {
  try { return localStorage.getItem(KEY) || "light"; } catch { return "light"; }
}
export function currentHighlight() {
  try { return localStorage.getItem(HL_KEY) || ""; } catch { return ""; }
}

export function applyTheme(theme = currentTheme(), highlight = currentHighlight()) {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolve(theme));
  // A custom highlight overrides the theme's accent, and ONLY the accent — the five semantic roles
  // (hover / on / drop / edit) inherit from it, so one colour repaints all of them coherently, while
  // --hl-suggest deliberately stays put. If the user's colour became the suggestion colour too,
  // "this just became possible" would look identical to "you are hovering this" again, which is the
  // whole problem the token split exists to solve.
  if (highlight) root.style.setProperty("--accent", highlight);
  else root.style.removeProperty("--accent");
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: the theme is just not sticky */ }
  applyTheme(theme);
}
export function setHighlight(hex) {
  try {
    if (hex) localStorage.setItem(HL_KEY, hex);
    else localStorage.removeItem(HL_KEY);
  } catch { /* as above */ }
  applyTheme(currentTheme(), hex);
}

// Follow the OS while (and only while) the user has asked us to.
if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "system") applyTheme("system");
  });
}
