// hv core — contour extraction from a region predicate (marching squares) +
// loop stitching + Douglas-Peucker simplification. Pure.
//
// Booleans (union / subtract / intersect) and invert-space all reduce to "trace
// the boundary of the region where predicate(x,y) is true". Marching squares over
// a grid gives the topology; bisecting each crossing edge (predicate is an exact
// inside-test) snaps the boundary to ~7 bits, so coarse grids still trace smoothly.
// Robust for any overlap, winding, or shape count — and always yields valid loops.

import { nfmt } from "./path.js";

export function marchingSquares(predicate, bbox, res) {
  const W = bbox.x1 - bbox.x0, H = bbox.y1 - bbox.y0;
  if (W <= 0 || H <= 0) return "";
  const big = Math.max(W, H);
  const nx = Math.max(2, Math.round(res * W / big));
  const ny = Math.max(2, Math.round(res * H / big));
  const dx = W / nx, dy = H / ny;
  const X = (i) => bbox.x0 + i * dx, Y = (j) => bbox.y0 + j * dy;
  const grid = [];
  for (let j = 0; j <= ny; j++) { grid[j] = []; for (let i = 0; i <= nx; i++) grid[j][i] = predicate(X(i), Y(j)); }
  const bisect = (ax, ay, aIn, bx, by) => {           // boundary between an in/out pair
    let lo = 0, hi = 1;
    for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (predicate(ax + (bx - ax) * m, ay + (by - ay) * m) === aIn) lo = m; else hi = m; }
    const m = (lo + hi) / 2; return { x: ax + (bx - ax) * m, y: ay + (by - ay) * m };
  };
  const segs = [], add = (p, q) => segs.push([p, q]);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const tl = grid[j][i], tr = grid[j][i + 1], br = grid[j + 1][i + 1], bl = grid[j + 1][i];
    const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
    if (code === 0 || code === 15) continue;
    const top = () => bisect(X(i), Y(j), tl, X(i + 1), Y(j));
    const right = () => bisect(X(i + 1), Y(j), tr, X(i + 1), Y(j + 1));
    const bottom = () => bisect(X(i + 1), Y(j + 1), br, X(i), Y(j + 1));
    const left = () => bisect(X(i), Y(j + 1), bl, X(i), Y(j));
    const center = () => predicate(X(i) + dx / 2, Y(j) + dy / 2);
    switch (code) {
      case 1: add(left(), bottom()); break;
      case 2: add(bottom(), right()); break;
      case 3: add(left(), right()); break;
      case 4: add(right(), top()); break;
      case 5: if (center()) { add(left(), top()); add(right(), bottom()); } else { add(left(), bottom()); add(right(), top()); } break;
      case 6: add(bottom(), top()); break;
      case 7: add(left(), top()); break;
      case 8: add(top(), left()); break;
      case 9: add(top(), bottom()); break;
      case 10: if (center()) { add(top(), right()); add(bottom(), left()); } else { add(top(), left()); add(bottom(), right()); } break;
      case 11: add(top(), right()); break;
      case 12: add(right(), left()); break;
      case 13: add(right(), bottom()); break;
      case 14: add(bottom(), left()); break;
    }
  }
  return segs.length ? chainSegments(segs, Math.max(dx, dy) * 0.4) : "";
}

// Stitch marching-squares segments into closed loops. The segments are DIRECTED
// (each case emits them with the filled region on the left), so every crossing
// point has exactly one out-edge — following them never crosses strands at a
// junction, and holes come out wound opposite to outer boundaries (correct for
// nonzero fill). Collinear vertices are dropped so straight runs collapse.
export function chainSegments(segs, tol) {
  const K = (p) => Math.round(p.x * 100) / 100 + "," + Math.round(p.y * 100) / 100;
  const out = new Map();   // startKey -> { endKey, pt }
  for (const [a, b] of segs) { const ka = K(a), kb = K(b); if (ka === kb || out.has(ka)) continue; out.set(ka, { endKey: kb, pt: a }); }
  const used = new Set();
  let d = "";
  for (const startKey of out.keys()) {
    if (used.has(startKey)) continue;
    const coords = []; let cur = startKey, guard = 0;
    while (cur && !used.has(cur) && guard++ < out.size + 5) {
      const e = out.get(cur); if (!e) break;
      used.add(cur); coords.push(e.pt); cur = e.endKey;
      if (cur === startKey) break;
    }
    const simp = simplifyLoop(coords, tol);
    if (simp.length >= 3) d += " M" + simp.map((p) => nfmt(p.x) + " " + nfmt(p.y)).join(" L") + " Z";
  }
  return d.trim();
}

// Douglas-Peucker on a closed loop: collapses straight runs to their endpoints
// while keeping enough curve points to stay within `tol`. (A per-triple collinear
// test fails on gentle curves — each step's deviation is sub-tolerance, so the
// whole arc would wrongly flatten to a chord.) Split at the point farthest from
// coords[0] so DP gets stable endpoints on the loop.
export function simplifyLoop(coords, tol) {
  const n = coords.length; if (n < 4) return coords;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (coords[i].x - coords[0].x) ** 2 + (coords[i].y - coords[0].y) ** 2; if (d > fd) { fd = d; far = i; } }
  const r = dpSimplify(coords.slice(0, far + 1), tol).slice(0, -1)
    .concat(dpSimplify(coords.slice(far).concat([coords[0]]), tol).slice(0, -1));
  return r.length >= 3 ? r : coords;
}

export function dpSimplify(pts, tol) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = pointSegDist(pts[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
  if (dmax > tol) return dpSimplify(pts.slice(0, idx + 1), tol).slice(0, -1).concat(dpSimplify(pts.slice(idx), tol));
  return [a, b];
}

export function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (L < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
}
