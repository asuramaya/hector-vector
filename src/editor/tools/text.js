// Text tool (#48-#52, T1-T5 + T8/T9) — click to place a <text>, type into an HTML
// overlay editor, commit to the SVG on blur/Escape. Extracted as an Object.assign
// MIXIN, so every method runs with `this === editor` (reaching this.stage / this.style /
// beginCoalesce / _renderSelection by identity). Only module-level helpers are imported.
//
// WHY an HTML overlay (the locked fork): SVG has no native text editing — no caret, no
// selection, no IME. So while editing we HIDE the <text> and float a contentEditable div
// over the canvas. The wrapper carries the stage's full screen CTM as a CSS matrix, so the
// inner editable works in plain LOCAL user-units (font-size in px == user-units, left/top ==
// the text's x/y) and still lands pixel-exact under any zoom / pan / rotation. On commit we
// read the typed string back and write it into the <text> as a tspan-per-line. The
// contentEditable also gates every global editor shortcut for free (app.js keydown handlers
// all early-return on isContentEditable), so typing "v" inserts a letter, not the select tool.
import { SVG_NS, bakeMatrixInto } from "../../hv/index.js";
import { setStatus } from "../../app.js";
import { api } from "../../ui/api.js";
import { numRow, selectRow, inspRow } from "../ui-rows.js";

// Curated font stacks for the MVP picker (T6). The real registry + Google-Fonts search
// (T11/#58) replaces this list with a searchable, on-demand-loaded catalogue; the current
// stack is always injected as an option so a later-loaded family still shows selected.
export const FONT_CHOICES = [
  ["Helvetica, Arial, sans-serif", "Helvetica / Arial"],
  ["Georgia, 'Times New Roman', serif", "Georgia"],
  ["'Times New Roman', Times, serif", "Times New Roman"],
  ["'Courier New', monospace", "Courier"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["'Trebuchet MS', sans-serif", "Trebuchet"],
  ["Impact, Charcoal, sans-serif", "Impact"],
  ["'Comic Sans MS', cursive", "Comic Sans"],
];
const FONT_WEIGHTS = [["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["900", "Black"]];

// New-text defaults; edits in the inspector fold back into here so the next text inherits
// the last-used styling (mirrors how this.style carries fill/stroke between shapes).
export const DEFAULT_TEXT = {
  fontFamily: "Helvetica, Arial, sans-serif",
  fontSize: 48,
  fontWeight: "400",
  fontStyle: "normal",
  textAnchor: "start",   // start | middle | end  (left / centre / right)
  letterSpacing: 0,
  lineHeight: 1.2,
};

export const textMixin = {
  _textStyle() { return (this.textStyle = this.textStyle || { ...DEFAULT_TEXT }); },

  // ---------- placing / entering edit ----------
  _textDown(e) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // A click anywhere finishes the edit in progress first (clicks inside the text box hit
    // the overlay, not the stage, so reaching here means "elsewhere" → commit then act).
    if (this._textEdit) this._commitText();
    const hit = e.target.closest && e.target.closest("text[data-hv-id]");
    if (hit && this.stage.contains(hit) && hit.getAttribute("data-hv-locked") !== "1") { this._editText(hit, false); return; }
    // Click = point text (grows freely). Drag = AREA text: the dragged box sets the wrap width
    // (Illustrator's two text modes). We disambiguate on pointerup by how far the pointer moved.
    const start = this._textStagePoint(e);
    const ov = this._overlayEl();
    let box = null;
    const move = (ev) => {
      const cur = this._textStagePoint(ev);
      const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
      const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
      if (!box && (w > 3 || h > 3) && ov) { box = document.createElementNS(SVG_NS, "rect"); box.setAttribute("class", "hv-textbox-preview"); box.setAttribute("fill", "none"); ov.appendChild(box); }
      if (box) { box.setAttribute("x", x); box.setAttribute("y", y); box.setAttribute("width", w); box.setAttribute("height", h); }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (box) box.remove();
      const cur = this._textStagePoint(ev);
      const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
      if (w > 8 && h > 8) this._createTextBox(Math.min(start.x, cur.x), Math.min(start.y, cur.y), w, h);
      else this._createTextAt(start.x, start.y);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },
  // Area/box text (T10): a <text> carrying data-hv-text-width — its content word-wraps to that
  // width (SVG has no native flow text, so we break lines ourselves on commit/edit). First
  // baseline sits one ascent below the box top; anchor is always start (left).
  _createTextBox(x, y, w, h) {
    const ts = this._textStyle();
    this.beginCoalesce();
    const t = document.createElementNS(SVG_NS, "text");
    const id = "n" + (++this.idSeq);
    t.setAttribute("data-hv-id", id);
    t.setAttribute("x", String(Math.round(x * 100) / 100));
    t.setAttribute("y", String(Math.round((y + ts.fontSize * 0.8) * 100) / 100));
    t.setAttribute("xml:space", "preserve");
    t.setAttribute("data-hv-text-width", String(Math.round(w * 100) / 100));
    if (h > 0) t.setAttribute("data-hv-text-height", String(Math.round(h * 100) / 100));
    this._applyTextStyleAttrs(t, ts);
    t.removeAttribute("text-anchor");   // area text is left-flowed
    t.setAttribute("fill", this.style.fill && this.style.fill !== "none" ? this.style.fill : "#000000");
    this.stage.insertBefore(t, this._overlayEl());
    this.selection = new Set([id]); this.artboardSelected = false;
    this._editText(t, true);
  },
  // Double-click a text node from ANY tool (typically Select) to drop straight into
  // editing it — the Illustrator/Figma gesture. Non-text dbl-clicks are ignored here.
  _onDblClick(e) {
    if (e.button !== 0 || !this.stage) return;
    const hit = e.target.closest && e.target.closest("text[data-hv-id]");
    if (!hit || !this.stage.contains(hit) || hit.getAttribute("data-hv-locked") === "1") return;
    e.stopPropagation(); e.preventDefault();
    this.setTool("text");
    this._editText(hit, false);
  },
  _textStagePoint(e) {
    const m = this.stage.getScreenCTM();
    const sp = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: sp.x, y: sp.y };
  },
  _createTextAt(x, y) {
    const ts = this._textStyle();
    this.beginCoalesce();
    const t = document.createElementNS(SVG_NS, "text");
    const id = "n" + (++this.idSeq);
    t.setAttribute("data-hv-id", id);
    t.setAttribute("x", String(Math.round(x * 100) / 100));
    t.setAttribute("y", String(Math.round(y * 100) / 100));
    t.setAttribute("xml:space", "preserve");
    this._applyTextStyleAttrs(t, ts);
    t.setAttribute("fill", this.style.fill && this.style.fill !== "none" ? this.style.fill : "#000000");
    this.stage.insertBefore(t, this._overlayEl());
    this.selection = new Set([id]); this.artboardSelected = false;
    this._editText(t, true);
  },
  _applyTextStyleAttrs(t, ts) {
    t.setAttribute("font-family", ts.fontFamily);
    t.setAttribute("font-size", String(ts.fontSize));
    if (ts.fontWeight && ts.fontWeight !== "400") t.setAttribute("font-weight", ts.fontWeight);
    if (ts.fontStyle && ts.fontStyle !== "normal") t.setAttribute("font-style", ts.fontStyle);
    if (ts.textAnchor && ts.textAnchor !== "start") t.setAttribute("text-anchor", ts.textAnchor);
    if (ts.letterSpacing) t.setAttribute("letter-spacing", String(ts.letterSpacing));
    if (ts.lineHeight && ts.lineHeight !== 1.2) t.setAttribute("data-hv-line-height", String(ts.lineHeight));
  },

  // ---------- the overlay editor ----------
  _editText(node, isNew) {
    if (this._textEdit) this._commitText();
    this.tool = "text";
    const wrap = document.createElement("div");
    wrap.className = "hv-text-overlay-wrap";
    const ed = document.createElement("div");
    ed.className = "hv-text-overlay";
    ed.contentEditable = "true";
    ed.spellcheck = false;
    ed.textContent = this._readTextContent(node);   // textContent (not innerHTML) → no markup injection
    wrap.appendChild(ed);
    document.body.appendChild(wrap);
    // On-path text stays VISIBLE while editing so the curve re-renders live as you type (the
    // overlay is transparent — just a caret); point/area text hides behind its flat overlay.
    if (!this._hasTextPath(node)) node.classList.add("hv-text-editing");
    this._textEdit = { node, id: node.getAttribute("data-hv-id"), el: ed, wrap, isNew, before: this._readTextContent(node) };
    this._positionTextOverlay();
    ed.focus();
    this._caretToEnd(ed);
    ed.addEventListener("keydown", (e) => this._textKey(e));
    ed.addEventListener("input", () => this._onTextInput());
    ed.addEventListener("blur", () => this._commitText());
    setStatus("Type your text · Esc or click away to finish · Enter for a new line", 0);
  },
  // Carry the stage's screen CTM onto the wrapper so the inner editable can use plain
  // local user-units; reposition on every zoom/pan so the box tracks the canvas live.
  _positionTextOverlay() {
    const te = this._textEdit; if (!te || !this.stage) return;
    const { node, el, wrap } = te;
    const m = this.stage.getScreenCTM(); if (!m) return;
    const x = parseFloat(node.getAttribute("x")) || 0;
    const y = parseFloat(node.getAttribute("y")) || 0;
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const anchor = node.getAttribute("text-anchor") || "start";
    const lh = this._lineHeightOf(node);
    const boxW = parseFloat(node.getAttribute("data-hv-text-width")) || 0;
    wrap.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
    // text-on-path: edit the run in a FLAT overlay anchored at the rendered bounds (the curved
    // layout is re-applied on commit). x/y don't exist on a textPath text, so use the bbox.
    if (this._hasTextPath(node)) {
      let bb; try { bb = node.getBBox(); } catch { bb = { x: x || 20, y: y || 20 }; }
      el.style.left = (bb.x || 20) + "px"; el.style.top = (bb.y || 20) + "px";
      el.style.width = ""; el.style.whiteSpace = "pre"; el.style.textAlign = "left"; el.style.transform = "none";
      el.style.fontSize = fs + "px"; el.style.fontFamily = node.getAttribute("font-family") || "sans-serif";
      el.style.fontWeight = node.getAttribute("font-weight") || "400"; el.style.fontStyle = node.getAttribute("font-style") || "normal";
      // The visible curved <textPath> is the live preview; the overlay supplies only the caret.
      el.style.color = "transparent"; el.style.caretColor = node.getAttribute("fill") || "#000"; el.style.lineHeight = String(lh);
      return;
    }
    // <text> y is the BASELINE; an HTML box top sits an ascent above it. Nudge up by a
    // typical ascent so the typed glyphs sit where the committed <text> will.
    el.style.left = x + "px";
    el.style.top = (y - fs * 0.8) + "px";
    el.style.fontSize = fs + "px";
    el.style.fontFamily = node.getAttribute("font-family") || "sans-serif";
    el.style.fontWeight = node.getAttribute("font-weight") || "400";
    el.style.fontStyle = node.getAttribute("font-style") || "normal";
    el.style.letterSpacing = (parseFloat(node.getAttribute("letter-spacing")) || 0) + "px";
    el.style.lineHeight = String(lh);
    el.style.color = node.getAttribute("fill") || "#000";
    if (boxW > 0) {
      // AREA text: fixed width so the editable wraps exactly like the committed tspans will.
      el.style.width = boxW + "px";
      el.style.whiteSpace = "pre-wrap";
      el.style.overflowWrap = "break-word";
      el.style.textAlign = "left"; el.style.transform = "none";
    } else {
      // POINT text: grows freely; text-anchor → align + shift so the anchor edge sits on x.
      el.style.width = "";
      el.style.whiteSpace = "pre";
      if (anchor === "middle") { el.style.textAlign = "center"; el.style.transform = "translateX(-50%)"; }
      else if (anchor === "end") { el.style.textAlign = "right"; el.style.transform = "translateX(-100%)"; }
      else { el.style.textAlign = "left"; el.style.transform = "none"; }
    }
  },
  _textKey(e) {
    e.stopPropagation();   // belt-and-suspenders: keep editor shortcuts out (contentEditable already gates them)
    if (e.key === "Escape") { e.preventDefault(); this._commitText(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this._commitText(); }
    // plain Enter falls through → contentEditable inserts a newline (multi-line text)
  },
  // Live preview for text-on-path: rewrite the <textPath> run as you type so the curved layout
  // re-renders each keystroke (a textPath is one line, so newlines collapse to spaces). Point
  // and area text keep the commit-on-blur model (their flat overlay already shows the text).
  _onTextInput() {
    const te = this._textEdit; if (!te) return;
    const { node, el } = te;
    if (!this._hasTextPath(node)) return;
    const tp = node.querySelector(":scope > textPath");
    if (tp) tp.textContent = this._readEditable(el).replace(/\n/g, " ");
  },
  _commitText() {
    const te = this._textEdit; if (!te) return;
    this._textEdit = null;   // null FIRST so the blur handler can't re-enter mid-commit
    const { node, el, wrap, isNew, before } = te;
    const str = this._readEditable(el);
    wrap.remove();
    node.classList.remove("hv-text-editing");
    const empty = !str.trim();
    if (isNew) {
      if (empty) { node.remove(); this.cancelCoalesce(); this.selection = new Set(); }
      else { this._writeContent(node, str); this.commitCoalesce("Add text"); this.selection = new Set([node.getAttribute("data-hv-id")]); }
    } else {
      if (empty) { this.push("Delete text"); node.remove(); this.selection = new Set(); }
      else if (str !== before) { this.push("Edit text"); this._writeContent(node, str); }
    }
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    this._showHint();
  },

  // ---------- content <-> tspans ----------
  // Read the editable as plain text. innerText reflects rendered line breaks as "\n"
  // (whatever <div>/<br> the browser inserted on Enter); strip a trailing blank line.
  _readEditable(el) { return (el.innerText || "").replace(/ /g, " ").replace(/\n$/, ""); },
  // Read a <text> back to a string for the editor. Point text → one tspan per line ("\n").
  // Area text → rebuild the FLOW: soft-wrapped lines re-join with a space, hard-break starts
  // (data-hv-br) with "\n", so the editor re-wraps faithfully instead of freezing the wrap.
  _readTextContent(node) {
    const tp = node.querySelector(":scope > textPath");
    if (tp) return tp.textContent || "";   // text-on-path: a single run flows along the path
    const tspans = node.querySelectorAll(":scope > tspan");
    if (!tspans.length) return node.textContent || "";
    if (parseFloat(node.getAttribute("data-hv-text-width")) > 0) {
      let s = "";
      tspans.forEach((t, i) => { if (i > 0) s += t.getAttribute("data-hv-br") ? "\n" : " "; s += t.textContent || ""; });
      return s;
    }
    return [...tspans].map((t) => t.textContent || "").join("\n");
  },
  // The literal on-screen lines (one per tspan) — area text already wrapped. Used by
  // convert-to-outlines so the outline matches the rendered wrapping exactly.
  _literalLines(node) {
    const tp = node.querySelector(":scope > textPath");
    if (tp) return tp.textContent || "";
    const tspans = node.querySelectorAll(":scope > tspan");
    if (tspans.length) return [...tspans].map((t) => t.textContent || "").join("\n");
    return node.textContent || "";
  },
  _hasTextPath(node) { return !!(node && node.querySelector && node.querySelector(":scope > textPath")); },
  // The <path> element a text node is bound to via its <textPath href>, or null.
  _boundPathEl(node) {
    const tp = node && node.querySelector && node.querySelector(":scope > textPath");
    if (!tp) return null;
    const href = tp.getAttribute("href") || tp.getAttribute("xlink:href") || "";
    return href ? this.stage.querySelector("#" + CSS.escape(href.slice(1))) : null;
  },
  // Dispatch: on-path → single run; AREA (has a wrap width) → word-wrap; POINT → hard breaks only.
  _writeContent(node, str) {
    const tp = node.querySelector(":scope > textPath");
    if (tp) { tp.textContent = str.replace(/\n/g, " "); return; }   // path text is one flowing run
    if (parseFloat(node.getAttribute("data-hv-text-width")) > 0) this._writeAreaContent(node, str);
    else this._writeTextContent(node, str);
  },
  // A reusable canvas 2D context for text measurement (the font is loaded → metrics are real).
  _measureCtx() { return (this._measCtx = this._measCtx || document.createElement("canvas").getContext("2d")); },
  // Greedy word-wrap `text` to `width` user-units using the node's actual font metrics. Each
  // \n paragraph wraps independently. Returns [{text, br}] where `br` flags a line that starts
  // a hard-break paragraph (so re-editing can reconstruct the user's breaks, not just the flow).
  _wrapLines(node, text, width) {
    const ctx = this._measureCtx();
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    ctx.font = `${node.getAttribute("font-style") || "normal"} ${node.getAttribute("font-weight") || "400"} ${fs}px ${node.getAttribute("font-family") || "sans-serif"}`;
    // Match the live overlay's CSS wrap (white-space:pre-wrap; overflow-wrap:break-word). Canvas
    // measureText ignores letter-spacing, so add it (≈ ls per char) — otherwise tracked text wraps
    // at a different column than the overlay showed. And char-break a token too long to fit any
    // line (a long URL/word), like break-word — else it wraps in the overlay but overflows the box.
    const ls = parseFloat(node.getAttribute("letter-spacing")) || 0;
    const w = (s) => (s ? ctx.measureText(s).width + ls * s.length : 0);
    const fitPrefix = (s) => { let lo = 1, hi = s.length, n = 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w(s.slice(0, m)) <= width) { n = m; lo = m + 1; } else hi = m - 1; } return n; };
    const out = [];
    String(text).split("\n").forEach((para, pi) => {
      if (!para.trim()) { out.push({ text: "", br: pi > 0 }); return; }
      let line = "", first = true;
      const push = (t) => { out.push({ text: t, br: pi > 0 && first }); first = false; };
      // Emit full-width chunks of an overlong token; return the trailing remainder that fits.
      const charBreak = (s) => { let rest = s; while (w(rest) > width) { const n = fitPrefix(rest); push(rest.slice(0, n)); rest = rest.slice(n); } return rest; };
      for (const tok of para.split(/(\s+)/)) {
        if (line.trim() && w(line + tok) > width) { push(line.replace(/\s+$/, "")); line = ""; }
        if (!line.trim()) { const head = tok.replace(/^\s+/, ""); line = (w(head) > width) ? charBreak(head) : head; }
        else line += tok;
      }
      push(line.replace(/\s+$/, ""));
    });
    return out;
  },
  // Write wrapped area text: always tspan-per-line (stable x/dy for re-wrap). Paragraph-start
  // lines carry data-hv-br so _readTextContent can rebuild the hard breaks on re-edit.
  _writeAreaContent(node, str) {
    const width = parseFloat(node.getAttribute("data-hv-text-width")) || 200;
    const lines = this._wrapLines(node, str, width);
    while (node.firstChild) node.removeChild(node.firstChild);
    const x = node.getAttribute("x") || "0";
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    lines.forEach((ln, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? "0" : String(Math.round(fs * lh * 100) / 100));
      ts.setAttribute("xml:space", "preserve");
      if (i > 0 && ln.br) ts.setAttribute("data-hv-br", "1");
      ts.textContent = ln.text;
      node.appendChild(ts);
    });
    // Flag vertical overflow against the box height so the inspector + canvas frame can warn:
    // the wrapped lines occupy (n-1)·lineHeight + one line; if that exceeds the box, it overflows.
    if (this._areaOverflows(node, lines.length)) node.setAttribute("data-hv-overflow", "1");
    else node.removeAttribute("data-hv-overflow");
  },
  // True when the wrapped area text is taller than its box height (0/unset height never overflows).
  _areaOverflows(node, lineCount) {
    const boxH = parseFloat(node.getAttribute("data-hv-text-height")) || 0;
    if (!(boxH > 0)) return false;
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    const n = lineCount != null ? lineCount : (node.querySelectorAll(":scope > tspan").length || 1);
    return ((n - 1) * fs * lh + fs) > boxH + 0.5;
  },
  // Write a string into a <text>: single line → textContent; multi-line → a tspan per
  // line, each re-anchored to x with a dy of fontSize*lineHeight (first line dy 0).
  _writeTextContent(node, str) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const lines = str.split("\n");
    if (lines.length <= 1) { node.textContent = lines[0] || ""; return; }
    const x = node.getAttribute("x") || "0";
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    lines.forEach((ln, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? "0" : String(Math.round(fs * lh * 100) / 100));
      ts.setAttribute("xml:space", "preserve");
      ts.textContent = ln;
      node.appendChild(ts);
    });
  },
  // Line-height ratio for a text node. data-hv-line-height holds the authored value while
  // editing; it's stripped by serialize() on save, so on a re-opened doc we recover the
  // ratio from the baked dy of the second line (falling back to the default).
  _lineHeightOf(node) {
    const attr = parseFloat(node.getAttribute("data-hv-line-height"));
    if (attr > 0) return attr;
    const second = node.querySelector(":scope > tspan:nth-of-type(2)");
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    if (second) { const dy = parseFloat(second.getAttribute("dy")); if (dy > 0 && fs > 0) return Math.round((dy / fs) * 100) / 100; }
    return (this.textStyle && this.textStyle.lineHeight) || DEFAULT_TEXT.lineHeight;
  },
  // Re-flow after a font-size / line-height / width change. Area text RE-WRAPS to its width
  // (new metrics → new line breaks); point text just re-spaces its existing tspans.
  _reflowText(node) {
    if (parseFloat(node.getAttribute("data-hv-text-width")) > 0) {
      this._writeAreaContent(node, this._readTextContent(node));
      return;
    }
    const tspans = node.querySelectorAll(":scope > tspan");
    if (tspans.length < 2) return;
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    const x = node.getAttribute("x") || "0";
    tspans.forEach((t, i) => { t.setAttribute("x", x); t.setAttribute("dy", i === 0 ? "0" : String(Math.round(fs * lh * 100) / 100)); });
  },
  // ---------- text on a path (T19) ----------
  // True when a 2-object selection is exactly one <text> + one <path> — the bind candidates.
  _canPutOnPath(nodes) {
    if (!nodes || nodes.length !== 2) return false;
    const text = nodes.find((n) => n.tagName.toLowerCase() === "text" && !this._hasTextPath(n));
    const path = nodes.find((n) => n.tagName.toLowerCase() === "path");
    return !!text && !!path && text !== path;
  },
  // Bind the selected text to the selected path: the text becomes a <textPath href="#id"> run
  // that flows along the curve (the browser lays out the glyphs; SVG-native, serialises cleanly).
  putTextOnPath() {
    const nodes = this.selectedNodes();
    const text = nodes.find((n) => n.tagName.toLowerCase() === "text");
    const path = nodes.find((n) => n.tagName.toLowerCase() === "path");
    if (!text || !path) { setStatus("Select one text and one path to put the text on the path.", 3500); return; }
    const content = this._literalLines(text).replace(/\n/g, " ").trim();
    if (!content) { setStatus("This text is empty — type something into it before putting it on the path.", 3000); return; }
    this.push("Text on path");
    let pid = path.getAttribute("id");
    if (!pid) { pid = "hvpath-" + (path.getAttribute("data-hv-id") || ("n" + (++this.idSeq))); path.setAttribute("id", pid); }
    while (text.firstChild) text.removeChild(text.firstChild);
    text.removeAttribute("x"); text.removeAttribute("y"); text.removeAttribute("data-hv-text-width");
    const tp = document.createElementNS(SVG_NS, "textPath");
    tp.setAttribute("href", "#" + pid);
    tp.setAttribute("xml:space", "preserve");
    tp.textContent = content;
    text.appendChild(tp);
    this.selection = new Set([text.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Text bound to the path — set the offset/side in the inspector, or Detach.", 3200);
  },
  // Unwrap: text leaves the path and lands as plain point text at the path's start point.
  detachTextFromPath() {
    const text = this.selectedNodes().find((n) => this._hasTextPath(n));
    if (!text) return;
    this.push("Detach from path");
    const tp = text.querySelector(":scope > textPath");
    const content = tp.textContent || "";
    let px = 20, py = 40;
    try { const href = tp.getAttribute("href") || tp.getAttribute("xlink:href") || ""; const p = this.stage.querySelector("#" + CSS.escape(href.slice(1))); const pt = p.getPointAtLength(0); px = Math.round(pt.x * 100) / 100; py = Math.round(pt.y * 100) / 100; } catch { /* fallback coords */ }
    while (text.firstChild) text.removeChild(text.firstChild);
    text.setAttribute("x", String(px)); text.setAttribute("y", String(py));
    this._writeTextContent(text, content);
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Text detached from the path.", 2200);
  },
  // Set a <textPath> attribute (startOffset / side) on the selected on-path text, live.
  _setTextPathAttr(name, value, label) {
    const text = this.selectedNodes().find((n) => this._hasTextPath(n));
    if (!text) return;
    const tp = text.querySelector(":scope > textPath");
    if (!this._coalescing) this.push(label || "Text path");
    if (value == null || value === "" || value === "start") tp.removeAttribute(name);
    else tp.setAttribute(name, String(value));
    this._renderSelection();
  },

  // Inspector: change an area-text box's wrap width (re-wraps live). No-op for point text.
  _setAreaWidth(v) {
    if (!(v > 0)) return;
    const texts = this.selectedNodes().filter((n) => parseFloat(n.getAttribute("data-hv-text-width")) > 0);
    for (const n of texts) { n.setAttribute("data-hv-text-width", String(v)); this._reflowText(n); }
    this._textStyle();
    this._renderSelection();
  },
  // Inspector: change an area-text box's frame height (re-checks overflow live; width unchanged
  // so the wrap is the same, but the overflow flag is recomputed). 0 clears the bound.
  _setAreaHeight(v) {
    const texts = this.selectedNodes().filter((n) => parseFloat(n.getAttribute("data-hv-text-width")) > 0);
    for (const n of texts) {
      if (v > 0) n.setAttribute("data-hv-text-height", String(v));
      else n.removeAttribute("data-hv-text-height");
      this._reflowText(n);   // re-runs _writeAreaContent → recomputes data-hv-overflow
    }
    this._renderSelection();
  },
  _caretToEnd(el) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  },

  // ---------- inspector setters (T6) ----------
  // Set a font/text attribute across the selected text nodes, remember it as the new
  // default, and re-flow multi-line nodes when the change affects line spacing.
  _setTextAttr(name, value, { styleKey, label, reflow } = {}) {
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    if (!texts.length) return;
    this.push(label || "Text style");
    for (const n of texts) {
      if (value == null || value === "" || value === false) n.removeAttribute(name);
      else n.setAttribute(name, String(value));
      if (reflow) this._reflowText(n);
    }
    if (styleKey) this._textStyle()[styleKey] = value;
    if (name === "font-weight" || name === "font-style") this._ensureTextFonts();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  // ---------- inspector: the Text group (T6) ----------
  // Built from the selected text nodes via the same `common()` mixed-state reader the rest
  // of _objectPanel uses, so a multi-selection with differing fonts shows "Mixed". Discrete
  // controls (family/weight/style/align) push once; scrubbable numerics (size/spacing/line)
  // coalesce into one undo step. Returns the rows; editor.js wraps them in an inspGroup.
  _textPanel(reads, common) {
    const r2 = (v) => Math.round(v * 100) / 100;
    const famC = common((n) => n.getAttribute("font-family") || DEFAULT_TEXT.fontFamily);
    const sizeC = common((n) => parseFloat(n.getAttribute("font-size")) || DEFAULT_TEXT.fontSize);
    const weightC = common((n) => n.getAttribute("font-weight") || "400");
    const styleC = common((n) => n.getAttribute("font-style") || "normal");
    const anchorC = common((n) => n.getAttribute("text-anchor") || "start");
    const lsC = common((n) => parseFloat(n.getAttribute("letter-spacing")) || 0);
    const lhC = common((n) => this._lineHeightOf(n));
    const rows = [];
    // Inject the current stack as an option if it's outside the curated list (e.g. a font
    // loaded by the registry later) so it still shows selected rather than blank.
    rows.push(this._fontRow(famC));
    rows.push(numRow("Size", sizeC.mixed ? "" : r2(sizeC.value), 1, 1,
      (v) => { this.beginCoalesce(); this._applyTextNum("font-size", v, { reflow: true, styleKey: "fontSize" }); },
      null, () => { this.commitCoalesce("Font size"); this._renderInspector(); }, !!sizeC.mixed));
    rows.push(selectRow("Weight", weightC.mixed ? "" : String(weightC.value), FONT_WEIGHTS,
      (v) => this._setTextAttr("font-weight", v === "400" ? null : v, { styleKey: "fontWeight", label: "Weight" })));
    rows.push(this._segRow("Style", styleC.mixed ? null : styleC.value, [["normal", "N"], ["italic", "I"]],
      { normal: "Regular", italic: "Italic" }, (v) => this._setTextAttr("font-style", v === "normal" ? null : v, { styleKey: "fontStyle", label: "Style" })));
    rows.push(this._segRow("Align", anchorC.mixed ? null : anchorC.value, [["start", "↤"], ["middle", "↔"], ["end", "↦"]],
      { start: "Left", middle: "Centre", end: "Right" }, (v) => this._setTextAttr("text-anchor", v === "start" ? null : v, { styleKey: "textAnchor", label: "Align" })));
    rows.push(numRow("Spacing", lsC.mixed ? "" : r2(lsC.value), null, 0.5,
      (v) => { this.beginCoalesce(); this._applyTextNum("letter-spacing", v, { styleKey: "letterSpacing" }); },
      null, () => { this.commitCoalesce("Letter spacing"); }, !!lsC.mixed));
    rows.push(numRow("Line", lhC.mixed ? "" : r2(lhC.value), 0, 0.05,
      (v) => { this.beginCoalesce(); this._applyTextLineHeight(v); },
      null, () => { this.commitCoalesce("Line height"); }, !!lhC.mixed));
    // Area-text box (only when every selection is a text box): wrap Width + frame Height, scrub
    // to re-wrap/re-check live. An overflow note appears when the text is taller than the box.
    if (reads.every((n) => parseFloat(n.getAttribute("data-hv-text-width")) > 0)) {
      const wC = common((n) => parseFloat(n.getAttribute("data-hv-text-width")) || 0);
      rows.push(numRow("Width", wC.mixed ? "" : r2(wC.value), 1, 1,
        (v) => { this.beginCoalesce(); this._setAreaWidth(v); },
        null, () => { this.commitCoalesce("Text box width"); this._renderInspector(); }, !!wC.mixed));
      const hC = common((n) => parseFloat(n.getAttribute("data-hv-text-height")) || 0);
      rows.push(numRow("Height", hC.mixed ? "" : r2(hC.value), 0, 1,
        (v) => { this.beginCoalesce(); this._setAreaHeight(v); },
        null, () => { this.commitCoalesce("Text box height"); this._renderInspector(); }, !!hC.mixed));
      if (reads.some((n) => n.getAttribute("data-hv-overflow") === "1")) {
        const note = document.createElement("div");
        note.className = "insp-note insp-note-warn";
        note.textContent = "Text overflows the box — enlarge the height or trim the text.";
        rows.push(inspRow("", note));
      }
    }
    // On-path controls (T19): a single text bound to a path gets offset / side / detach.
    if (reads.length === 1 && this._hasTextPath(reads[0])) {
      const tp = reads[0].querySelector(":scope > textPath");
      // startOffset may be saved as a percentage (e.g. "50%"). The inspector edits in px, so
      // resolve a % against the bound path length first — otherwise scrubbing would silently
      // reinterpret "50%" as 50px and jump the text. After this, the row always reads/writes px.
      const soRaw = (tp.getAttribute("startOffset") || "").trim();
      let off = parseFloat(soRaw) || 0;
      if (soRaw.endsWith("%")) { const pe = this._boundPathEl(reads[0]); const L = (pe && pe.getTotalLength) ? pe.getTotalLength() : 0; if (L) off = (off / 100) * L; }
      const side = tp.getAttribute("side") || "left";
      rows.push(numRow("Offset", r2(off), null, 1,
        (v) => { this.beginCoalesce(); this._setTextPathAttr("startOffset", v, "Path offset"); },
        null, () => { this.commitCoalesce("Path offset"); }, false));
      rows.push(this._segRow("Side", side, [["left", "Out"], ["right", "In"]],
        { left: "Outside the curve", right: "Inside the curve" }, (v) => this._setTextPathAttr("side", v === "left" ? null : v, "Path side")));
      const detach = document.createElement("button");
      detach.type = "button"; detach.className = "insp-action"; detach.textContent = "Detach from path";
      detach.addEventListener("click", () => this.detachTextFromPath());
      rows.push(inspRow("Path", detach));
    }
    // Seamless text → vector: replace with exact glyph outlines (then boolean/node like any path).
    const outBtn = document.createElement("button");
    outBtn.type = "button"; outBtn.className = "insp-action";
    outBtn.textContent = "Convert to outlines";
    outBtn.title = "Replace this text with editable vector paths (system fonts use a free metric-compatible stand-in)";
    outBtn.addEventListener("click", () => this.convertSelectedTextToOutlines());
    rows.push(inspRow("Vector", outBtn));
    return rows;
  },

  // The Font row is a button that opens the searchable Google-Fonts browser (window.__fonts),
  // rather than a fixed <select> — that's the "font website discovery/download" surface. On
  // pick the chosen face is already loaded (the browser awaits it), so we just set the stack.
  _fontRow(famC) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "font-pick";
    btn.textContent = famC.mixed ? "Mixed" : (famC.value ? famC.value.split(",")[0].replace(/['"]/g, "") : "Default");
    if (!famC.mixed && famC.value) btn.style.fontFamily = famC.value;
    btn.addEventListener("click", () => {
      if (!window.__fonts) return;
      window.__fonts.openFontBrowser(btn, famC.mixed ? "" : famC.value, (stack, meta) => {
        this._setTextAttr("font-family", stack, { styleKey: "fontFamily", label: "Font" });
        if (meta && meta.web) this._ensureTextFonts();   // load the actual weight/style face too
      });
    });
    return inspRow("Font", btn);
  },
  // Make sure the real weight/style face of any web font in the selection is loaded (the
  // browser only fetches the regular 400 on pick). No-op for system fonts (we only chase a
  // family already known to the registry, so this never blindly hits the server).
  _ensureTextFonts() {
    if (!window.__fonts) return;
    for (const n of this.selectedNodes()) {
      if (n.tagName.toLowerCase() !== "text") continue;
      const fam = window.__fonts.primaryFamily(n.getAttribute("font-family") || "");
      if (!fam || !window.__fonts.isWebFontLoaded(fam, 400, false)) continue;
      const w = parseInt(n.getAttribute("font-weight") || "400", 10) || 400;
      const ital = (n.getAttribute("font-style") || "") === "italic";
      if (w !== 400 || ital) window.__fonts.loadWebFont(fam, w, ital, window.__fonts.webFontSource(fam)).then(() => this._renderSelection()).catch(() => {});
    }
  },

  // ---------- text → outlines (T16) ----------
  // Replace each selected <text> with an exact glyph-outline <path>, computed server-side
  // from the real font file (the keystone of "seamless text → vector"). Needs a web font —
  // the server only has files for fonts it can fetch (Google), not arbitrary system fonts.
  // Fetches ALL outlines before mutating, so a failure aborts cleanly with the doc intact.
  // Lay per-glyph outlines (each emitted at a LOCAL origin, baseline y=0) along the bound
  // path, matching how SVG <textPath> renders: each glyph is centred on the curve at its
  // mid-advance distance and rotated to the tangent there. startOffset (px or %), text-anchor
  // and side=right are honoured; glyphs whose centre falls off the path are dropped (as SVG
  // does). Every glyph's place+rotate is baked into ONE editable all-cubic path.
  _layoutGlyphsOnPath(node, glyphs) {
    const tp = node.querySelector(":scope > textPath");
    if (!tp || !glyphs || !glyphs.length) return null;
    const pathEl = this._boundPathEl(node);
    if (!pathEl || !pathEl.getTotalLength) return null;
    const L = pathEl.getTotalLength();
    if (!(L > 0)) return null;
    const total = glyphs.reduce((s, g) => s + (g.adv || 0), 0);
    const anchor = node.getAttribute("text-anchor") || "start";
    const soRaw = (tp.getAttribute("startOffset") || "").trim();
    let start = soRaw.endsWith("%") ? (parseFloat(soRaw) / 100) * L : (parseFloat(soRaw) || 0);
    if (anchor === "middle") start -= total / 2;
    else if (anchor === "end") start -= total;
    const side = (tp.getAttribute("side") || "left") === "right" ? "right" : "left";
    const eps = Math.max(0.01, Math.min(0.75, L / 2000));   // tangent sample half-step
    const tmp = document.createElementNS(SVG_NS, "path");
    const out = [];
    let cum = 0;
    for (const g of glyphs) {
      const w = g.w || 0;
      const startD = start + cum;          // the glyph's left-edge distance along the path
      const mid = startD + w / 2;          // its mid-advance — used for the rotation angle
      cum += (g.adv || w);                 // advance + tracking → next pen position
      if (!g.d) continue;
      if (mid < 0 || mid > L) continue;    // centre off the path → SVG drops it; so do we
      // SVG <textPath>: the glyph's ORIGIN (left edge, baseline) sits at its start distance,
      // rotated by the tangent at its MID-advance. side=right walks the path in reverse, so
      // the origin lands at the END of the glyph's span and the run is flipped 180°.
      const posD = side === "right" ? L - (startD + w) : startD;
      const angD = side === "right" ? L - mid : mid;
      const p = pathEl.getPointAtLength(Math.max(0, Math.min(L, posD)));
      const a = pathEl.getPointAtLength(Math.max(0, angD - eps));
      const b = pathEl.getPointAtLength(Math.min(L, angD + eps));
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (side === "right") ang += Math.PI;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      // m = translate(p) · rotate(ang): drop the glyph origin onto p, baseline on the curve,
      // rotated to the tangent. Baked straight into the glyph geometry → one editable path.
      const m = { a: cos, b: sin, c: -sin, d: cos, e: p.x, f: p.y };
      tmp.setAttribute("d", g.d);
      bakeMatrixInto(tmp, m, 0, 0);
      out.push(tmp.getAttribute("d"));
    }
    return out.length ? out.join(" ") : null;
  },

  async convertSelectedTextToOutlines() {
    if (this._textEdit) this._commitText();   // flush in-progress typing so we outline live content, not the stale pre-edit text
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    if (!texts.length || !window.__fonts) return;
    const jobs = [];
    for (const node of texts) {
      const onPath = this._hasTextPath(node);
      const text = onPath ? (node.querySelector(":scope > textPath").textContent || "")
                          : this._literalLines(node);   // VISUAL lines (area text already wrapped)
      if (!text.trim()) continue;
      const fam = window.__fonts.primaryFamily(node.getAttribute("font-family") || "");
      jobs.push({ node, onPath, payload: {
        text: onPath ? text.replace(/\n/g, " ") : text,   // a textPath run is a single line
        family: fam,
        source: window.__fonts.webFontSource(fam),   // same source the family loaded from (else server resolves by name)
        weight: parseInt(node.getAttribute("font-weight") || "400", 10) || 400,
        italic: (node.getAttribute("font-style") || "") === "italic",
        fontSize: parseFloat(node.getAttribute("font-size")) || 16,
        letterSpacing: parseFloat(node.getAttribute("letter-spacing")) || 0,
        lineHeight: this._lineHeightOf(node),
        anchor: node.getAttribute("text-anchor") || "start",
        x: parseFloat(node.getAttribute("x")) || 0,
        y: parseFloat(node.getAttribute("y")) || 0,
        perGlyph: onPath,   // on-path → per-glyph outlines, laid along the curve client-side
      } });
    }
    if (!jobs.length) return;
    setStatus("Converting text to outlines…", 0);
    let results;
    try { results = await Promise.all(jobs.map((j) => api("/api/text-outline", "POST", j.payload))); }
    catch (e) { setStatus(`Couldn't outline this text — it needs a web font (pick one from the font browser). ${e.message}`, 6000); this._showHint(); return; }
    this.push("Text to outlines");
    const newIds = [];
    jobs.forEach((j, i) => {
      const res = results[i] || {};
      const d = j.onPath ? this._layoutGlyphsOnPath(j.node, res.glyphs || []) : res.d;
      if (!d) return;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      // Carry over EVERYTHING that isn't text-layout-specific, so paint (fill/stroke/opacity)
      // plus masks, filters, clip-path and custom data-* survive the conversion. x/y/transform
      // are dropped for on-path geometry (already baked into the glyph coords via getPointAtLength).
      const drop = new Set(["x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
        "font-style", "font-stretch", "text-anchor", "letter-spacing", "word-spacing", "xml:space",
        "data-hv-id", "data-hv-name", "data-hv-line-height", "data-hv-text-width", "data-hv-br"]);
      if (j.onPath) drop.add("transform");
      for (const at of [...j.node.attributes]) {
        if (!drop.has(at.name)) path.setAttribute(at.name, at.value);
      }
      if (!path.getAttribute("fill")) path.setAttribute("fill", j.node.getAttribute("fill") || "#000000");
      // Glyph counters (the holes in o/e/a/8) are cut by OPPOSITE contour winding — explicit
      // nonzero so they render as holes regardless of the document/boolean-engine default.
      path.setAttribute("fill-rule", "nonzero");
      const id = j.node.getAttribute("data-hv-id") || ("n" + (++this.idSeq));
      path.setAttribute("data-hv-id", id);
      const nm = this.nodeName(j.node); if (nm && nm !== "Text") path.setAttribute("data-hv-name", nm.length > 40 ? nm.slice(0, 40) : nm);
      j.node.replaceWith(path);
      newIds.push(id);
    });
    // Selection is preserved by REUSING each text's data-hv-id on its new path, so a caller
    // that converted a mixed selection (e.g. booleanOp's guard rail) keeps every member.
    this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    // Report two things the user should know: a metric-compatible OFL stand-in used for a system
    // font that can't be downloaded, and any characters the font has no glyph for (skipped, so
    // without this they'd silently vanish from the outline).
    const missing = [...new Set(results.flatMap((r) => (r && r.missing) || []))];
    const subs = [...new Set(results.flatMap((r) => (r && r.substituted) ? [r.substituted] : []))];
    const complex = [...new Set(results.flatMap((r) => (r && r.complexScript) ? [r.complexScript] : []))];
    let msg = `Converted ${newIds.length} text object${newIds.length > 1 ? "s" : ""} to outlines — now editable as paths.`;
    if (subs.length) msg = `Converted to outlines with the free metric-compatible ${subs.join(", ")} (system fonts can't be downloaded to vectorise).`;
    if (missing.length) {
      const show = missing.slice(0, 8).join(" ");
      msg += ` ${missing.length} character${missing.length > 1 ? "s" : ""} (${show}${missing.length > 8 ? "…" : ""}) aren't in this font and were skipped.`;
    }
    // Complex scripts (Arabic/Indic/…) need a real shaping engine; the fallback may mis-order or
    // mis-position them, so flag it loudly rather than ship a wrong-looking outline silently.
    if (complex.length) msg += ` ⚠ This text contains ${complex.join(", ")} — advanced shaping isn't available, so check the outline's letterforms/order before relying on it.`;
    setStatus(msg, (subs.length || missing.length || complex.length) ? 7500 : 3000);
    return newIds;
  },

  // Coalesced numeric apply (no push) — for scrubbable inspector fields (size, spacing).
  // History is taken once on beginCoalesce and committed once on drag end, so a scrub is
  // a single undo step. `reflow` re-spaces multi-line tspans after a size change.
  _applyTextNum(name, v, { reflow, styleKey } = {}) {
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    for (const n of texts) {
      if (v == null || v === "" || isNaN(v)) n.removeAttribute(name);
      else n.setAttribute(name, String(v));
      if (reflow) this._reflowText(n);
    }
    if (styleKey && v != null && !isNaN(v)) this._textStyle()[styleKey] = v;
    this._renderSelection();
  },
  // Line-height is computed (drives tspan dy), not a native attribute — store the ratio on
  // data-hv-line-height for live re-editing + re-flow. Coalesced like the numeric fields.
  _applyTextLineHeight(v) {
    if (v == null || isNaN(v) || v <= 0) return;
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    for (const n of texts) { n.setAttribute("data-hv-line-height", String(v)); this._reflowText(n); }
    this._textStyle().lineHeight = v;
    this._renderSelection();
  },
};
