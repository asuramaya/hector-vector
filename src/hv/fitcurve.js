// hv core — fit a dense polyline to its MINIMAL cubic-bezier representation. Pure.
//
// This is the single curve-approximation core for the editor. It's a faithful JS
// port of Philip J. Schneider's least-squares curve fitting (Graphics Gems, 1990)
// — the SAME algorithm `tools/simplify_svg.py` runs on the trace pipeline, so the
// boolean/contour engine and the raster trace now produce congruent output: a few
// smooth cubics where the geometry is smooth, crisp single anchors at real corners,
// and a node count that tracks the tolerance instead of the sample density.
//
// Consumers: contour.js (marching-squares booleans + invert-space) refit each
// stitched loop here instead of emitting raw `L` polylines; any future client-side
// vectorizer should fit through this too. Points are [x, y] arrays throughout.

// ---- tiny 2D vector helpers (operate on [x, y]) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const hyp = (v) => Math.hypot(v[0], v[1]);
const neg = (v) => [-v[0], -v[1]];
function unit(v) { const n = Math.hypot(v[0], v[1]); return n > 1e-9 ? [v[0] / n, v[1] / n] : [0, 0]; }

// Evaluate a cubic bezier (ctrl = [P0,C1,C2,P3]) at parameter t → [x, y].
function bez(ctrl, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * ctrl[0][0] + b * ctrl[1][0] + c * ctrl[2][0] + d * ctrl[3][0],
    a * ctrl[0][1] + b * ctrl[1][1] + c * ctrl[2][1] + d * ctrl[3][1],
  ];
}

// Chord-length parameterisation of the sample points → u[] in [0, 1].
function chordParam(P) {
  const n = P.length, u = new Array(n); u[0] = 0;
  for (let i = 1; i < n; i++) u[i] = u[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const total = u[n - 1];
  if (total > 0) for (let i = 0; i < n; i++) u[i] /= total;
  else for (let i = 0; i < n; i++) u[i] = i / (n - 1);
  return u;
}

// Least-squares fit one cubic to P with fixed end tangents t1 (at P0) / t2 (at Pn).
function generateBezier(P, u, t1, t2) {
  const p0 = P[0], pl = P[P.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < P.length; i++) {
    const ui = u[i], mt = 1 - ui;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * ui, b2 = 3 * mt * ui * ui, b3 = ui * ui * ui;
    const a0 = [t1[0] * (3 * mt * mt * ui), t1[1] * (3 * mt * mt * ui)];
    const a1 = [t2[0] * (3 * mt * ui * ui), t2[1] * (3 * mt * ui * ui)];
    const fpx = p0[0] * (b0 + b1) + pl[0] * (b2 + b3), fpy = p0[1] * (b0 + b1) + pl[1] * (b2 + b3);
    const rx = P[i][0] - fpx, ry = P[i][1] - fpy;
    c00 += a0[0] * a0[0] + a0[1] * a0[1];
    c01 += a0[0] * a1[0] + a0[1] * a1[1];
    c11 += a1[0] * a1[0] + a1[1] * a1[1];
    x0 += a0[0] * rx + a0[1] * ry;
    x1 += a1[0] * rx + a1[1] * ry;
  }
  const det = c00 * c11 - c01 * c01;
  const chord = Math.hypot(pl[0] - p0[0], pl[1] - p0[1]);
  let alpha0, alpha1;
  if (Math.abs(det) < 1e-12) { alpha0 = alpha1 = chord / 3; }
  else { alpha0 = (x0 * c11 - x1 * c01) / det; alpha1 = (c00 * x1 - c01 * x0) / det; }
  if (alpha0 < 1e-6 || alpha1 < 1e-6) alpha0 = alpha1 = chord / 3;
  return [p0, [p0[0] + t1[0] * alpha0, p0[1] + t1[1] * alpha0], [pl[0] + t2[0] * alpha1, pl[1] + t2[1] * alpha1], pl];
}

// Max deviation of the fitted curve from the samples → [error, worstIndex].
function maxError(P, ctrl, u) {
  let dmax = 0, idx = 0;
  for (let i = 0; i < P.length; i++) {
    const q = bez(ctrl, u[i]);
    const d2 = (q[0] - P[i][0]) ** 2 + (q[1] - P[i][1]) ** 2;
    if (d2 > dmax) { dmax = d2; idx = i; }
  }
  return [Math.sqrt(dmax), idx];
}

// One Newton-Raphson step refining each u toward the closest point on the curve.
function reparam(P, ctrl, u) {
  const out = u.slice();
  for (let i = 0; i < u.length; i++) {
    const ui = u[i], mt = 1 - ui, q = bez(ctrl, ui);
    const d1 = [
      3 * mt * mt * (ctrl[1][0] - ctrl[0][0]) + 6 * mt * ui * (ctrl[2][0] - ctrl[1][0]) + 3 * ui * ui * (ctrl[3][0] - ctrl[2][0]),
      3 * mt * mt * (ctrl[1][1] - ctrl[0][1]) + 6 * mt * ui * (ctrl[2][1] - ctrl[1][1]) + 3 * ui * ui * (ctrl[3][1] - ctrl[2][1]),
    ];
    const d2 = [
      6 * mt * (ctrl[2][0] - 2 * ctrl[1][0] + ctrl[0][0]) + 6 * ui * (ctrl[3][0] - 2 * ctrl[2][0] + ctrl[1][0]),
      6 * mt * (ctrl[2][1] - 2 * ctrl[1][1] + ctrl[0][1]) + 6 * ui * (ctrl[3][1] - 2 * ctrl[2][1] + ctrl[1][1]),
    ];
    const num = (q[0] - P[i][0]) * d1[0] + (q[1] - P[i][1]) * d1[1];
    const den = d1[0] * d1[0] + d1[1] * d1[1] + (q[0] - P[i][0]) * d2[0] + (q[1] - P[i][1]) * d2[1];
    const nu = Math.abs(den) < 1e-12 ? ui : ui - num / den;
    out[i] = Math.min(1, Math.max(0, nu));
  }
  return out;
}

// Recursively fit P (with end tangents t1/t2) to cubics within `tol`, splitting at
// the worst point when one curve can't hold the whole run. Returns [[P0,C1,C2,P3]…].
function fitCubic(P, t1, t2, tol, depth = 0) {
  if (P.length === 2) {
    const d = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) / 3;
    return [[P[0], [P[0][0] + t1[0] * d, P[0][1] + t1[1] * d], [P[1][0] + t2[0] * d, P[1][1] + t2[1] * d], P[1]]];
  }
  let u = chordParam(P);
  let ctrl = generateBezier(P, u, t1, t2);
  let [err, split] = maxError(P, ctrl, u);
  if (err < tol) return [ctrl];
  if (err < tol * 4 && depth < 24) {
    for (let k = 0; k < 4; k++) {
      u = reparam(P, ctrl, u);
      ctrl = generateBezier(P, u, t1, t2);
      [err, split] = maxError(P, ctrl, u);
      if (err < tol) return [ctrl];
    }
  }
  if (depth > 28 || split <= 0 || split >= P.length - 1) return [ctrl];
  const tc = unit(sub(P[split - 1], P[split + 1]));
  const left = fitCubic(P.slice(0, split + 1), t1, tc, tol, depth + 1);
  const right = fitCubic(P.slice(split), neg(tc), t2, tol, depth + 1);
  return left.concat(right);
}

// RDP keep-mask over an open polyline (iterative). true = keep this vertex.
function rdpMask(P, eps) {
  const n = P.length, keep = new Array(n).fill(false);
  if (n === 0) return keep;
  keep[0] = keep[n - 1] = true;
  if (n < 3) return keep;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const A = P[a], B = P[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    let imax = a, dmax = -1;
    for (let i = a + 1; i < b; i++) {
      const dist = L < 1e-9
        ? Math.hypot(P[i][0] - A[0], P[i][1] - A[1])
        : Math.abs((dx / L) * (P[i][1] - A[1]) - (dy / L) * (P[i][0] - A[0]));
      if (dist > dmax) { dmax = dist; imax = i; }
    }
    if (dmax > eps) { keep[imax] = true; stack.push([a, imax]); stack.push([imax, b]); }
  }
  return keep;
}

// Which decimated vertices turn sharper than `angDeg` (a genuine corner, not a
// gentle curve) — these become split points so corners stay crisp.
function cornerFlags(K, angDeg) {
  const n = K.length, thr = Math.cos((angDeg * Math.PI) / 180), out = [];
  for (let i = 0; i < n; i++) {
    const a = unit(sub(K[i], K[(i - 1 + n) % n]));
    const b = unit(sub(K[(i + 1) % n], K[i]));
    const aAny = a[0] || a[1], bAny = b[0] || b[1];
    out.push(!!(aAny && bAny && dot(a, b) < thr));
  }
  return out;
}

// Drop consecutive duplicate points (a fit needs distinct samples).
function dedup(run) {
  if (run.length < 2) return run;
  const out = [run[0]];
  for (let i = 1; i < run.length; i++) {
    if (Math.abs(run[i][0] - run[i - 1][0]) + Math.abs(run[i][1] - run[i - 1][1]) > 1e-6) out.push(run[i]);
  }
  return out;
}

// Fit a CLOSED loop of dense points to minimal cubics. Corners are located on an
// RDP-decimated copy (so spike tips stay single crisp vertices), then cubics are
// fit to the *dense* points in each run between corners — accurate curves, minimal
// segments. A fully smooth loop is seamed at its sharpest vertex and fit in one go.
// `P` = array of [x, y] (NOT closed). Returns [[P0,C1,C2,P3]…] (empty if degenerate).
export function fitLoop(P, tol, cornerAng = 42) {
  if (P.length < 3) return [];
  const dense = P.concat([P[0]]);            // close the loop
  const mask = rdpMask(dense, tol);
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  if (idx.length < 3) return [];
  let K = idx.map((i) => dense[i]);
  let idxArr = idx.slice();
  if (Math.abs(K[0][0] - K[K.length - 1][0]) < 1e-9 && Math.abs(K[0][1] - K[K.length - 1][1]) < 1e-9) {
    K = K.slice(0, -1); idxArr = idxArr.slice(0, -1);
  }
  const flags = cornerFlags(K, cornerAng);
  const cuts = [];
  for (let i = 0; i < idxArr.length; i++) if (flags[i]) cuts.push(idxArr[i]);
  cuts.sort((a, b) => a - b);

  if (!cuts.length) {
    // Smooth closed loop: seam at the sharpest decimated vertex, then fit once.
    const m = K.length; let si = 0, best = Infinity;
    for (let i = 0; i < m; i++) {
      const v = dot(unit(sub(K[i], K[(i - 1 + m) % m])), unit(sub(K[(i + 1) % m], K[i])));
      if (v < best) { best = v; si = i; }
    }
    const s = idxArr[si];
    const Q = dedup(dense.slice(s).concat(dense.slice(1, s + 1)));
    if (Q.length < 2) return [];
    return fitCubic(Q, unit(sub(Q[1], Q[0])), unit(sub(Q[Q.length - 2], Q[Q.length - 1])), tol);
  }

  let segs = [];
  for (let j = 0; j < cuts.length; j++) {
    const a = cuts[j], b = cuts[(j + 1) % cuts.length];
    let run = b > a ? dense.slice(a, b + 1) : dense.slice(a).concat(dense.slice(0, b + 1));
    run = dedup(run);
    if (run.length < 2) continue;
    segs = segs.concat(fitCubic(run, unit(sub(run[1], run[0])), unit(sub(run[run.length - 2], run[run.length - 1])), tol));
  }
  return segs;
}

// Emit a fitted CLOSED loop as an SVG path substring. A near-straight cubic (both
// controls within 0.25u of the chord) collapses to an `L`, mirroring the trace
// emitter. `fmt` formats a coordinate (defaults to 3-dp like nfmt).
export function cubicsToPath(segs, fmt = (v) => (Math.round(v * 1000) / 1000).toString()) {
  if (!segs.length) return "";
  const p = (xy) => fmt(xy[0]) + " " + fmt(xy[1]);
  let out = "M" + p(segs[0][0]);
  for (const s of segs) {
    const chord = sub(s[3], s[0]), cl = hyp(chord);
    let dev = 1;
    if (cl > 1e-6) {
      const cdir = [chord[0] / cl, chord[1] / cl];
      dev = Math.max(Math.abs(cross(cdir, sub(s[1], s[0]))), Math.abs(cross(cdir, sub(s[2], s[0]))));
    }
    out += dev < 0.25 ? "L" + p(s[3]) : "C" + p(s[1]) + " " + p(s[2]) + " " + p(s[3]);
  }
  return out + "Z";
}
