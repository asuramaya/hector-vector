// hv core — CSS colour normalisation. Uses a throwaway canvas 2d context to
// resolve any CSS colour to a canonical #rrggbb / rgba() string (browser-only).

const _colorCtx = document.createElement("canvas").getContext("2d");

export function normalizeColor(c) {
  if (c == null) return null;
  c = String(c).trim();
  if (!c || c === "none" || c === "transparent" || c === "currentColor" || c.startsWith("url(")) return null;
  _colorCtx.fillStyle = "#000000"; _colorCtx.fillStyle = c; const a = _colorCtx.fillStyle;
  _colorCtx.fillStyle = "#ffffff"; _colorCtx.fillStyle = c; const b = _colorCtx.fillStyle;
  return a === b ? a : null;   // invalid colours don't change the seed → reject
}

export function toHexColor(c) {
  const n = normalizeColor(c);
  if (!n) return null;
  if (n[0] === "#") return n;
  const m = n.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const [r, g, b] = m[1].split(",").map((s) => parseInt(s, 10) || 0);
  return "#" + [r, g, b].map((v) => (v & 255).toString(16).padStart(2, "0")).join("");
}
