// Cloud PDF export adapter — the platform-level counterpart to hvserver/export_pdf.py's
// cairosvg render, for the serverless build. That file's own docstring used to say "there is
// no browser API that turns an SVG into real PDF vector drawing commands" — true of native
// browser APIs, but jsPDF + svg2pdf.js (lazy-loaded, only when a PDF/.ai export is actually
// requested) does exactly that: it walks the live SVG DOM and emits real PDF vector drawing
// operators, not a rasterised page. Desktop keeps cairosvg (renderSvgToPdfBlob in export.js) —
// it's already good and this doesn't need to replace it. Same {svgText, background} contract
// and same output shape (a PDF Blob) either way, so VECTOR_FORMATS in export.js just points at
// whichever one the build actually has.
//
// .ai reuses this verbatim: a PDF-compatible .ai file IS a PDF (see docs/pdf-ai-io.md if that
// ever gets written) — same bytes, different extension/label in VECTOR_FORMATS.

// The .es.min.js builds carry a bare `@babel/runtime/...` import that only resolves under a
// bundler — dead on arrival for a plain dynamic import() with no build step. The .umd.min.js
// builds are fully self-contained (no external specifiers), so they're loaded as classic
// <script> tags instead — svg2pdf's UMD build attaches its .svg() method onto jsPDF's prototype
// as a side effect once both are on the page, reading the global exactly like an old-style
// two-<script> jsPDF + plugin setup.
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js";
const SVG2PDF_URL = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.7.0/dist/svg2pdf.umd.min.js";
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}.`));
    document.head.appendChild(s);
  });
}
let _libsPromise = null;
function ensureLibs() {
  if (!_libsPromise) {
    _libsPromise = (async () => {
      if (!window.jspdf) await loadScript(JSPDF_URL);
      if (!window.jspdf?.jsPDF?.API?.svg) await loadScript(SVG2PDF_URL);
      return window.jspdf.jsPDF;
    })();
  }
  return _libsPromise;
}

function svgDims(svgEl) {
  const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) && n > 0 ? n : null; };
  let w = num(svgEl.getAttribute("width"));
  let h = num(svgEl.getAttribute("height"));
  if (!w || !h) {
    const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4) { w = w || vb[2]; h = h || vb[3]; }
  }
  return [w || 512, h || 512];
}

const BG_COLOR = { white: "#ffffff", black: "#000000" };

export async function cloudRenderSvgToPdfBlob(svgText, background) {
  const jsPDF = await ensureLibs();
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svgEl = parsed.documentElement;
  if (svgEl.nodeName === "parsererror" || !svgEl || svgEl.tagName.toLowerCase() !== "svg") {
    throw new Error("Couldn't parse this document's SVG markup.");
  }
  const [w, h] = svgDims(svgEl);

  // svg2pdf needs real layout (getBBox/computed text metrics) to measure the tree, which a
  // fully detached (never-inserted) element doesn't have — parked off-screen instead of
  // display:none (that removes layout) or the visible page (that would flash the canvas).
  svgEl.style.position = "fixed";
  svgEl.style.left = "-100000px";
  svgEl.style.top = "-100000px";
  document.body.appendChild(svgEl);
  try {
    const doc = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "pt", format: [w, h] });
    if (background && BG_COLOR[background]) {
      doc.setFillColor(BG_COLOR[background]);
      doc.rect(0, 0, w, h, "F");
    }
    await doc.svg(svgEl, { x: 0, y: 0, width: w, height: h });
    return doc.output("blob");
  } finally {
    svgEl.remove();
  }
}
