// PDF/.ai import — real vector geometry, not a raster trace. Universal: this module runs
// identically on both surfaces (desktop's app window IS a Chromium tab too, same as any
// browser — there's no separate server-side PDF-import path to route around), so it isn't
// CLOUD-gated the way fonts/text-outlines are.
//
// pdf.js's DOCUMENTED API (getTextContent, canvas rendering) doesn't expose path geometry.
// page.getOperatorList() does: pdf.js normalizes the whole PDF content-stream grammar (m/l/c/
// v/y/h/re, all the fill/stroke paint variants, the q/Q/cm transform stack) down to a small,
// stable internal encoding before handing it back — verified empirically against pdf.js
// 6.2.108's own source and a real exported PDF (see the session's own round-trip test):
//   - constructPath's args are [paintOpCode, [ [flatSubpath...], ... ], bbox]. paintOpCode is
//     itself a real OPS value (OPS.fill/eoFill/stroke/fillStroke/.../endPath) — path
//     construction and paint are FUSED into one op when pdf.js can see they're adjacent, so
//     there's no separate "fill"/"stroke" operator to also watch for.
//   - each flatSubpath is [code, ...args, code, ...args, ...] using pdf.js's own internal
//     DrawOPS encoding: 0=moveTo(x,y) 1=lineTo(x,y) 2=curveTo(c1x,c1y,c2x,c2y,x,y)
//     3=quadraticCurveTo(cx,cy,x,y) 4=closePath(). Rectangles (`re`) are pre-decomposed into
//     moveTo+lineTo+lineTo+lineTo+closePath by pdf.js itself, so there's no separate code for
//     them either — 5 primitives is the whole alphabet.
// Coordinates in that flat array are in CURRENT USER SPACE at construction time (like Canvas
// path commands under an active ctx.transform) — this module tracks its own CTM stack via
// save/restore/transform and bakes each point through the CTM immediately, emitting absolute
// SVG path data (already flipped to SVG's Y-down convention via the seed matrix below).
//
// Text: reconstructed from the DOCUMENTED getTextContent() (string + position + size) as real
// editable <text> objects, not traced glyph outlines — deliberately NOT font-matched to
// whatever the source PDF embedded (that's a much bigger problem: extracting/identifying
// embedded font programs). In practice this rarely fires on OUR OWN exports anyway, since
// editor.outlineTextForExport already bakes text to paths before any vector export — it
// matters for third-party PDFs/.ai files that carry live text objects.
//
// Explicitly out of scope for v1 (unsupported operators are skipped, not silently wrong):
// patterns, gradients/shading, clipping paths (the clip region itself is dropped; content
// inside it still imports, just unclipped), blend modes, inline/XObject raster images.

const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs";
let _pdfjsPromise = null;
function ensurePdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import(PDFJS_URL).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
  }
  return _pdfjsPromise;
}

// ---------- 2D affine matrix helpers: PDF's [a,b,c,d,e,f] === SVG's matrix() convention ----------
const IDENTITY = [1, 0, 0, 1, 0, 0];
// multiply(outer, inner): apply `inner` first, then `outer` — matches PDF's `cm` semantics
// (CTM_new = M_params concatenated onto CTM_old, i.e. multiply(CTM_old, M_params)).
function multiply(o, i) {
  return [
    o[0] * i[0] + o[2] * i[1], o[1] * i[0] + o[3] * i[1],
    o[0] * i[2] + o[2] * i[3], o[1] * i[2] + o[3] * i[3],
    o[0] * i[4] + o[2] * i[5] + o[4], o[1] * i[4] + o[3] * i[5] + o[5],
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
const r = (n) => Math.round(n * 1000) / 1000;

// ---------- geometry: constructPath's flat subpath array -> an absolute SVG path fragment ----------
function subpathToD(flat, ctm) {
  const cmds = [];
  let i = 0;
  while (i < flat.length) {
    const code = flat[i++];
    if (code === 0) { const [x, y] = apply(ctm, flat[i], flat[i + 1]); i += 2; cmds.push(`M${r(x)},${r(y)}`); }
    else if (code === 1) { const [x, y] = apply(ctm, flat[i], flat[i + 1]); i += 2; cmds.push(`L${r(x)},${r(y)}`); }
    else if (code === 2) {
      const [x1, y1] = apply(ctm, flat[i], flat[i + 1]);
      const [x2, y2] = apply(ctm, flat[i + 2], flat[i + 3]);
      const [x, y] = apply(ctm, flat[i + 4], flat[i + 5]);
      i += 6; cmds.push(`C${r(x1)},${r(y1)} ${r(x2)},${r(y2)} ${r(x)},${r(y)}`);
    } else if (code === 3) {
      const [cx, cy] = apply(ctm, flat[i], flat[i + 1]);
      const [x, y] = apply(ctm, flat[i + 2], flat[i + 3]);
      i += 4; cmds.push(`Q${r(cx)},${r(cy)} ${r(x)},${r(y)}`);
    } else if (code === 4) { cmds.push("Z"); }
    else { break; }   // unrecognized code: bail on this subpath rather than misinterpret the rest
  }
  return cmds.join("");
}

async function interpretPage(page, pdfjsLib, seedCtm) {
  const { OPS } = pdfjsLib;
  const names = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
  const PAINT = {
    [OPS.stroke]: { stroke: true }, [OPS.closeStroke]: { stroke: true },
    [OPS.fill]: { fill: true }, [OPS.eoFill]: { fill: true, evenOdd: true },
    [OPS.fillStroke]: { fill: true, stroke: true }, [OPS.eoFillStroke]: { fill: true, stroke: true, evenOdd: true },
    [OPS.closeFillStroke]: { fill: true, stroke: true }, [OPS.closeEOFillStroke]: { fill: true, stroke: true, evenOdd: true },
  };

  const { fnArray, argsArray } = await page.getOperatorList();
  const shapes = [];
  const stack = [];
  let ctm = seedCtm;
  let fill = "#000000", stroke = "#000000", lineWidth = 1, fillAlpha = 1, strokeAlpha = 1;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i], args = argsArray[i];
    if (op === OPS.save) { stack.push({ ctm, fill, stroke, lineWidth, fillAlpha, strokeAlpha }); }
    else if (op === OPS.restore) {
      const s = stack.pop();
      if (s) ({ ctm, fill, stroke, lineWidth, fillAlpha, strokeAlpha } = s);
    } else if (op === OPS.transform) { ctm = multiply(ctm, args); }
    else if (op === OPS.setFillRGBColor) { fill = args[0]; }
    else if (op === OPS.setStrokeRGBColor) { stroke = args[0]; }
    else if (op === OPS.setLineWidth) { lineWidth = args[0]; }
    else if (op === OPS.setFillAlpha) { fillAlpha = args[0]; }
    else if (op === OPS.setStrokeAlpha) { strokeAlpha = args[0]; }
    else if (op === OPS.constructPath) {
      const [paintCode, subpaths] = args;
      const paint = PAINT[paintCode];   // undefined (e.g. endPath, a clip-only construction) -> not painted
      const d = subpaths.map((sp) => subpathToD(sp, ctm)).join(" ");
      if (paint && d) {
        // uniform scale approximation for stroke width under the current CTM (good enough for
        // the common no-skew case; a sheared/non-uniform CTM would need per-axis handling)
        const scale = Math.hypot(ctm[0], ctm[1]);
        shapes.push({
          d,
          fill: paint.fill ? fill : "none",
          fillOpacity: paint.fill ? fillAlpha : undefined,
          stroke: paint.stroke ? stroke : "none",
          strokeOpacity: paint.stroke ? strokeAlpha : undefined,
          strokeWidth: paint.stroke ? r(lineWidth * scale) : undefined,
          fillRule: paint.evenOdd ? "evenodd" : undefined,
        });
      }
    }
    // beginText/endText/showText/setFont/setTextMatrix/setLeading/dependency/clip/eoClip/
    // paintImageXObject/shadingFill/... intentionally no-ops here — text comes from
    // getTextContent() below; clip/shading/images are the documented v1 gaps.
    void names;
  }
  return shapes;
}

async function extractText(page, seedCtm) {
  const content = await page.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;   // [a,b,c,d,e,f] in PDF space, font size already baked in
    const [x, y] = apply(seedCtm, t[4], t[5]);
    const fontSize = r(Math.hypot(t[0], t[1]) * Math.hypot(seedCtm[0], seedCtm[1]));
    const angle = Math.atan2(seedCtm[1] * t[0] + seedCtm[3] * t[1], seedCtm[0] * t[0] + seedCtm[2] * t[1]);
    items.push({ text: it.str, x: r(x), y: r(y), fontSize: fontSize || 12, angle });
  }
  return items;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Returns an SVG markup string (same shape mountStageFromText already accepts for .svg/.hv
// open) built from the PDF's first page. Multi-page PDFs: only page 1 imports — a bigger
// document would need a multi-artboard mapping decision this doesn't make for you.
export async function pdfToSvgString(arrayBuffer) {
  const pdfjsLib = await ensurePdfjs();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await doc.getPage(1);
  const [, , pw, ph] = page.view;   // [x0, y0, x1, y1] in PDF points
  const seedCtm = [1, 0, 0, -1, 0, ph];   // PDF (Y-up, origin bottom-left) -> SVG (Y-down, origin top-left); self-inverse

  const [shapes, textItems] = await Promise.all([
    interpretPage(page, pdfjsLib, seedCtm),
    extractText(page, seedCtm),
  ]);

  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${r(pw)}" height="${r(ph)}" viewBox="0 0 ${r(pw)} ${r(ph)}">`];
  for (const s of shapes) {
    const attrs = [`d="${s.d}"`, `fill="${s.fill}"`, `stroke="${s.stroke}"`];
    if (s.strokeWidth != null) attrs.push(`stroke-width="${s.strokeWidth}"`);
    if (s.fillOpacity != null && s.fillOpacity < 1) attrs.push(`fill-opacity="${r(s.fillOpacity)}"`);
    if (s.strokeOpacity != null && s.strokeOpacity < 1) attrs.push(`stroke-opacity="${r(s.strokeOpacity)}"`);
    if (s.fillRule) attrs.push(`fill-rule="${s.fillRule}"`);
    parts.push(`<path ${attrs.join(" ")}/>`);
  }
  for (const t of textItems) {
    const rot = t.angle ? ` transform="rotate(${r((t.angle * 180) / Math.PI)} ${t.x} ${t.y})"` : "";
    parts.push(`<text x="${t.x}" y="${t.y}" font-size="${t.fontSize}"${rot}>${escapeXml(t.text)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
