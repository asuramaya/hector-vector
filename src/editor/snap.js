// 45°-snap helpers for the editor tools (pen / curvature / node direction handles).
// Pure geometry; pulled out of editor.js so the per-tool mixins can share them (#31).

// Snap the vector from (ox,oy) to (px,py) onto the nearest 45° spoke, keeping its
// length — for direction handles, where the drag distance IS the handle length.
export function snap45(ox, oy, px, py) {
  const dx = px - ox, dy = py - oy, len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: px, y: py };
  const step = Math.PI / 4, a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: ox + Math.cos(a) * len, y: oy + Math.sin(a) * len };
}

// Snap a *movement* vector to the nearest 45° axis by PROJECTION, so a dragged
// point tracks the cursor along the constraint line instead of being flung out to
// the raw diagonal distance. This is the right feel for moving/placing points.
export function snapDelta(dx, dy) {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: 0, y: 0 };
  const step = Math.PI / 4, a = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(a), uy = Math.sin(a), proj = dx * ux + dy * uy;
  return { x: ux * proj, y: uy * proj };
}

export function snapPoint(ox, oy, px, py) { const s = snapDelta(px - ox, py - oy); return { x: ox + s.x, y: oy + s.y }; }
