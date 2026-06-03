// hv core — contour extraction from a region predicate (marching squares) +
// loop stitching + cubic-bezier refit. Pure.
//
// Booleans (union / subtract / intersect) and invert-space all reduce to "trace
// the boundary of the region where predicate(x,y) is true". Marching squares over
// a grid gives the topology; bisecting each crossing edge (predicate is an exact
// inside-test) snaps the boundary to ~7 bits, so coarse grids still trace smoothly.
// Robust for any overlap, winding, or shape count — and always yields valid loops.
//
// The stitched boundary is dense (one point per grid crossing). Rather than emit
// that as a heavy `L` polyline — wasteful, and incongruent with the trace pipeline
// — each loop is refit to its minimal cubics through the shared fitcurve core (the
// same Schneider fit tools/simplify_svg.py runs server-side). So a boolean result
// comes out as a handful of smooth cubics with crisp corners, not hundreds of segs.

import { nfmt } from "./path.js";
import { fitLoop, cubicsToPath } from "./fitcurve.js";

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
    // Refit the dense boundary to minimal cubics (shared fitcurve core) — the fit
    // tolerance is the same grid-relative budget DP used, so corners stay crisp and
    // smooth runs collapse to a few curves instead of a long `L` chain.
    if (coords.length >= 3) {
      const segs = fitLoop(coords.map((p) => [p.x, p.y]), tol);
      if (segs.length) d += " " + cubicsToPath(segs, nfmt);
    }
  }
  return d.trim();
}
