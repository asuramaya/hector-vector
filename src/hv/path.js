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

// Build a path `d` from pen anchors. Each anchor is {x,y,out} where `out` is the
// outgoing bezier handle (smooth point) or null (corner); the incoming handle is
// the mirror of the previous anchor's `out`. `preview` adds a trailing corner
// point at the cursor (rubber-band); `closed` appends the wrap-around + Z.
export function penPathD(pts, closed, preview) {
  const all = preview ? pts.concat([{ x: preview.x, y: preview.y, out: null }]) : pts;
  if (!all.length) return "";
  const inOf = (a) => (a.out ? { x: 2 * a.x - a.out.x, y: 2 * a.y - a.out.y } : null);
  const seg = (a, b) => {
    const c1 = a.out, c2 = inOf(b);
    if (!c1 && !c2) return ` L${nfmt(b.x)} ${nfmt(b.y)}`;
    const p1 = c1 || { x: a.x, y: a.y }, p2 = c2 || { x: b.x, y: b.y };
    return ` C${nfmt(p1.x)} ${nfmt(p1.y)} ${nfmt(p2.x)} ${nfmt(p2.y)} ${nfmt(b.x)} ${nfmt(b.y)}`;
  };
  let d = `M${nfmt(all[0].x)} ${nfmt(all[0].y)}`;
  for (let i = 1; i < all.length; i++) d += seg(all[i - 1], all[i]);
  if (closed && all.length >= 2) { d += seg(all[all.length - 1], all[0]) + " Z"; }
  return d;
}
