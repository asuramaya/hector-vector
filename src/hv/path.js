// hv core — SVG path `d` parsing/serialization + pen-anchor path building. Pure.

export function nfmt(v) { return (Math.round(v * 1000) / 1000).toString(); }

// --- path d parsing → absolute, normalised to M/L/C/Q/A/Z ---
export function parsePath(d) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  const toks = []; let mm;
  while ((mm = re.exec(d))) toks.push(mm[1] || mm[2]);
  let i = 0; const num = () => parseFloat(toks[i++]);
  const segs = []; let cx = 0, cy = 0, sx = 0, sy = 0, prevCtrl = null, cmd = "", last = "";
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === "M") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      cx = x; cy = y; sx = x; sy = y; segs.push({ t: "M", end: { x, y } });
      last = "M"; prevCtrl = null; cmd = rel ? "l" : "L";
    } else if (C === "L") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      cx = x; cy = y; segs.push({ t: "L", end: { x, y } }); last = "L"; prevCtrl = null;
    } else if (C === "H") {
      let x = num(); if (rel) x += cx; cx = x; segs.push({ t: "L", end: { x, y: cy } }); last = "L"; prevCtrl = null;
    } else if (C === "V") {
      let y = num(); if (rel) y += cy; cy = y; segs.push({ t: "L", end: { x: cx, y } }); last = "L"; prevCtrl = null;
    } else if (C === "C") {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      segs.push({ t: "C", c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, end: { x, y } });
      prevCtrl = { x: x2, y: y2 }; cx = x; cy = y; last = "C";
    } else if (C === "S") {
      let x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
      const refl = (last === "C" || last === "S") && prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : { x: cx, y: cy };
      segs.push({ t: "C", c1: refl, c2: { x: x2, y: y2 }, end: { x, y } });
      prevCtrl = { x: x2, y: y2 }; cx = x; cy = y; last = "S";
    } else if (C === "Q") {
      let x1 = num(), y1 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
      segs.push({ t: "Q", c1: { x: x1, y: y1 }, end: { x, y } });
      prevCtrl = { x: x1, y: y1 }; cx = x; cy = y; last = "Q";
    } else if (C === "T") {
      let x = num(), y = num(); if (rel) { x += cx; y += cy; }
      const refl = (last === "Q" || last === "T") && prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : { x: cx, y: cy };
      segs.push({ t: "Q", c1: refl, end: { x, y } });
      prevCtrl = refl; cx = x; cy = y; last = "T";
    } else if (C === "A") {
      let rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      segs.push({ t: "A", rx, ry, rot, laf, sf, end: { x, y } });
      cx = x; cy = y; last = "A"; prevCtrl = null;
    } else if (C === "Z") {
      segs.push({ t: "Z" }); cx = sx; cy = sy; last = "Z"; prevCtrl = null;
    } else { i++; }
  }
  return segs;
}

export function serializeSegs(segs) {
  return segs.map((s) => {
    if (s.t === "M") return `M${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "L") return `L${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "C") return `C${nfmt(s.c1.x)} ${nfmt(s.c1.y)} ${nfmt(s.c2.x)} ${nfmt(s.c2.y)} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "Q") return `Q${nfmt(s.c1.x)} ${nfmt(s.c1.y)} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "A") return `A${nfmt(s.rx)} ${nfmt(s.ry)} ${nfmt(s.rot)} ${s.laf} ${s.sf} ${nfmt(s.end.x)} ${nfmt(s.end.y)}`;
    if (s.t === "Z") return "Z";
    return "";
  }).join(" ");
}

// ---- stroke-context geometry: is a Join / Cap control meaningful for this path? ----
const _sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
function _cornerInSub(items, closed, cosTol) {
  let last = items.length - 1;
  const eq = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  if (closed && last >= 1) {
    if (eq(items[last].pt, items[0].pt)) { items[0].in = items[last].in; last -= 1; }   // last pt == start
    else { const c = _sub(items[0].pt, items[last].pt); items[last].out = c; items[0].in = c; }   // straight close
  }
  for (let k = 0; k <= last; k++) {
    const it = items[k];
    if (!it.in || !it.out) continue;
    const li = Math.hypot(it.in.x, it.in.y), lo = Math.hypot(it.out.x, it.out.y);
    if (li < 1e-9 || lo < 1e-9) continue;
    if ((it.in.x * it.out.x + it.in.y * it.out.y) / (li * lo) < cosTol) return true;   // tangent break = corner
  }
  return false;
}
// True if the path has any "pointy" vertex (a tangent discontinuity > tolDeg). A stroke
// Join only matters where two segments meet at an angle — an all-curves shape has none.
export function pathHasCorner(d, tolDeg = 8) {
  const segs = parsePath(d);
  const cosTol = Math.cos(tolDeg * Math.PI / 180);
  let i = 0;
  while (i < segs.length) {
    if (segs[i].t !== "M") { i++; continue; }
    const items = [{ pt: segs[i].end, in: null, out: null }];
    let closed = false, j = i + 1;
    for (; j < segs.length; j++) {
      const s = segs[j];
      if (s.t === "M") break;
      if (s.t === "Z") { closed = true; j++; break; }
      const prev = items[items.length - 1];
      let outD, inD;
      if (s.t === "C") { outD = _sub(s.c1, prev.pt); inD = _sub(s.end, s.c2); }
      else if (s.t === "Q") { outD = _sub(s.c1, prev.pt); inD = _sub(s.end, s.c1); }
      else { outD = _sub(s.end, prev.pt); inD = outD; }   // L / A → chord direction
      prev.out = outD;
      items.push({ pt: s.end, in: inD, out: null });
    }
    if (_cornerInSub(items, closed, cosTol)) return true;
    i = j;
  }
  return false;
}
// True if any subpath is open (no Z). A stroke Cap only shows on open ends / dash ends.
export function pathOpenEnds(d) {
  const segs = parsePath(d);
  let i = 0;
  while (i < segs.length) {
    if (segs[i].t !== "M") { i++; continue; }
    let j = i + 1, closed = false;
    for (; j < segs.length && segs[j].t !== "M"; j++) if (segs[j].t === "Z") closed = true;
    if (!closed) return true;
    i = j;
  }
  return false;
}

// Build a path `d` from pen anchors. Each anchor is {x,y,in,out} where `out` is
// the outgoing bezier handle and `in` the incoming one (either null for a corner
// on that side). Smooth points keep `in`/`out` mirrored; a cusp has them
// independent. A segment is a line only when both adjacent handles are null.
// `preview` adds a trailing corner point at the cursor — the segment into it
// still honours the previous anchor's `out`, so the rubber-band shows the real
// outgoing curve. `closed` appends the wrap-around back to the first anchor + Z.
export function penPathD(pts, closed, preview) {
  const all = preview ? pts.concat([{ x: preview.x, y: preview.y, in: null, out: null }]) : pts;
  if (!all.length) return "";
  const seg = (a, b) => {
    const c1 = a.out, c2 = b.in;
    if (!c1 && !c2) return ` L${nfmt(b.x)} ${nfmt(b.y)}`;
    const p1 = c1 || { x: a.x, y: a.y }, p2 = c2 || { x: b.x, y: b.y };
    return ` C${nfmt(p1.x)} ${nfmt(p1.y)} ${nfmt(p2.x)} ${nfmt(p2.y)} ${nfmt(b.x)} ${nfmt(b.y)}`;
  };
  let d = `M${nfmt(all[0].x)} ${nfmt(all[0].y)}`;
  for (let i = 1; i < all.length; i++) d += seg(all[i - 1], all[i]);
  if (closed && all.length >= 2) { d += seg(all[all.length - 1], all[0]) + " Z"; }
  return d;
}

// Subpath-aware re-emit (#20): emit one M…Z per subpath so a compound path (rect-with-hole,
// traced glyph, boolean result) survives the pathToAnchors → edit → re-serialize round-trip
// without its subpaths fusing into one loop. `subs` is pathToAnchors' per-subpath metadata
// ({closed,start,count}); falls back to a single subpath when absent (single-path callers).
export function penAnchorsToD(anchors, subs) {
  if (!subs || subs.length <= 1) return penPathD(anchors, subs && subs[0] ? subs[0].closed : false);
  let d = "";
  for (const u of subs) {
    const a = anchors.slice(u.start, u.start + u.count);
    if (a.length) d += penPathD(a, u.closed);   // penPathD starts each group with "M…" → clean concat
  }
  return d;
}
