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

// --- RGB / HSV / hex conversions (for the colour picker) ---------------------
// All channels integer where natural: rgb 0-255, h 0-360, s/v 0-100.

export function hexToRgb(hex) {
  const h = String(hex || "").trim().replace(/^#/, "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// HSL (the colour panel's HSL tab). Hue 0–360, S/L 0–100.
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
