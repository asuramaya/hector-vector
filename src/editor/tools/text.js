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
import { SVG_NS, bakeMatrixInto, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";
import { platform } from "../../ui/platform.js";
import { numRow, selectRow, inspRow } from "../ui-rows.js";
import { showContextMenu } from "../../ui/menus.js";

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
    if (hit && this.stage.contains(hit) && hit.getAttribute("data-hv-locked") !== "1") {
      if (this._isThreadTarget(hit)) { this._selectThreadTarget(hit); return; }
      this._editText(hit, false); return;
    }
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
    this._artHome().insertBefore(t, this._artBefore());   // into the isolation when isolated (Epic I)
    this.selection = new Set([id]); this.artboardSelected = false;
    this._editText(t, true);
  },
  // Double-click a text node from ANY tool (typically Select) to drop straight into
  // editing it — the Illustrator/Figma gesture. Non-text dbl-clicks are ignored here.
  _onDblClick(e) {
    if (e.button !== 0 || !this.stage) return;
    const hit = e.target.closest && e.target.closest("text[data-hv-id]");
    if (hit && this.stage.contains(hit) && hit.getAttribute("data-hv-locked") !== "1") {
      e.stopPropagation(); e.preventDefault();
      if (this._isThreadTarget(hit)) { this._selectThreadTarget(hit); return; }
      this.setTool("text"); this._editText(hit, false); return;
    }
    if (this._isoDblClick) this._isoDblClick(e);   // not text → enter/exit isolation (Epic I)
  },
  // A threaded frame's content is system-derived (fed by the box before it in the chain),
  // so a click/double-click never opens it for typing — select it instead and point back
  // at the box that actually owns the text, same idea as clicking a symbol instance vs its
  // master (Epic Y).
  _selectThreadTarget(node) {
    this.selection = new Set([node.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    const src = this._threadPrevOf(node);
    setStatus(`This box is threaded — edit the text in ${src ? "“" + (this.nodeName(src) || "the linked box") + "”" : "the linked box"} instead.`, 3200);
  },
  _textStagePoint(e) {
    const m = this.stageCTM();
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
    this._artHome().insertBefore(t, this._artBefore());   // into the isolation when isolated (Epic I)
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
  // Rich runs (bold/italic/color) are scoped to POINT and AREA text only (v1) — on-path text
  // keeps its old flat single-line editor, since a <textPath> has no line-tspans to hang runs
  // off in the first place, and a curved run mixing styles mid-glyph-layout is real extra
  // engine work for a genuinely rare case. Its overlay is unchanged below.
  _editText(node, isNew) {
    if (this._textEdit) this._commitText();
    this.tool = "text";
    const rich = !this._hasTextPath(node);
    const wrap = document.createElement("div");
    wrap.className = "hv-text-overlay-wrap";
    const ed = document.createElement("div");
    ed.className = "hv-text-overlay";
    ed.contentEditable = "true";
    ed.spellcheck = false;
    if (rich) ed.innerHTML = this._runLinesToHTML(this._readTextParagraphs(node));
    else ed.textContent = this._readTextContent(node);   // textContent (not innerHTML) → no markup injection
    wrap.appendChild(ed);
    document.body.appendChild(wrap);
    // The toolbar is a SIBLING of wrap, appended straight to <body> — not a child of it. `wrap`
    // carries the stage's screen-CTM as a CSS transform (_positionTextOverlay), and a
    // `position:fixed` descendant of a transformed ancestor is positioned relative to THAT
    // ancestor's box, not the true viewport (CSS containing-block rules) — putting the toolbar
    // inside wrap would double-transform its viewport-rect-based left/top.
    let toolbar = null;
    if (rich) { toolbar = this._buildTextToolbar(ed); document.body.appendChild(toolbar); }
    // On-path text stays VISIBLE while editing so the curve re-renders live as you type (the
    // overlay is transparent — just a caret); point/area text hides behind its flat overlay.
    if (!this._hasTextPath(node)) node.classList.add("hv-text-editing");
    this._textEdit = { node, id: node.getAttribute("data-hv-id"), el: ed, wrap, toolbar, isNew, rich, beforeRuns: rich ? this._readTextParagraphs(node) : null, before: this._readTextContent(node) };
    this._positionTextOverlay();
    ed.focus();
    this._caretToEnd(ed);
    ed.addEventListener("keydown", (e) => this._textKey(e));
    ed.addEventListener("input", () => this._onTextInput());
    ed.addEventListener("blur", (e) => {
      // The color swatch is a real <input>, so clicking it (unlike the B/I buttons, which
      // preventDefault their own mousedown to keep focus on `ed` entirely) does blur the
      // editable — don't commit (and tear the overlay down) out from under that click.
      const te2 = this._textEdit;
      if (te2 && ((te2.wrap && te2.wrap.contains(e.relatedTarget)) || (te2.toolbar && te2.toolbar.contains(e.relatedTarget)))) return;
      this._commitText();
    });
    if (rich) {
      ed.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text/plain");
        document.execCommand("insertText", false, text);
      });
      document.addEventListener("selectionchange", this._textSelHandler = () => this._updateTextToolbar());
    }
    setStatus(rich ? "Type your text · select some to bold/italic/color it · Esc or click away to finish" : "Type your text · Esc or click away to finish · Enter for a new line", 0);
  },
  // Carry the stage's screen CTM onto the wrapper so the inner editable can use plain
  // local user-units; reposition on every zoom/pan so the box tracks the canvas live.
  _positionTextOverlay() {
    const te = this._textEdit; if (!te || !this.stage) return;
    const { node, el, wrap } = te;
    // The NODE's own screen CTM, not the stage's: a node can carry its own transform (the
    // Transform tool / W-H fields scale text via a matrix instead of baking, since font-size
    // is a scalar — see setSelectionSize's comment) or sit inside a nested group (isolation
    // mode, an artboard). Using only the stage's CTM ignored all of that and positioned the
    // overlay at the UNSCALED size/place — editing a scaled text opened a tiny, misplaced box.
    const m = node.getScreenCTM(); if (!m) return;
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
  // ---- rich overlay: HTML <-> runs, and the selection-aware format toolbar ----
  _escapeHTML(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; },
  _runHTML(r) {
    let s = this._escapeHTML(r.text || "");
    if (!s) return "";
    if (r.bold) s = `<b>${s}</b>`;
    if (r.italic) s = `<i>${s}</i>`;
    if (r.color) s = `<span style="color:${this._escapeHTML(r.color)}">${s}</span>`;
    return s;
  },
  // One <div> per line, contentEditable's own natural Enter-creates-a-new-block shape — reading
  // it back (_readOverlayRuns) walks exactly this same div-per-line structure. An empty line
  // needs a <br> inside its div or the browser collapses it to zero height and the caret can't
  // land there.
  _runLinesToHTML(lines) {
    return lines.map((ln) => {
      const inner = ln.runs.map((r) => this._runHTML(r)).join("");
      return `<div>${inner || "<br>"}</div>`;
    }).join("");
  },
  // Reverse of the above: each top-level <div> (or, before the first Enter, stray inline
  // content sitting directly under the editable) is one PARAGRAPH — CSS pre-wrap only visually
  // folds a long paragraph into several rows, it never touches the underlying markup, so a
  // div boundary here always means a real user Enter, matching data-hv-br's own meaning.
  _readOverlayRuns(el) {
    const kids = [...el.childNodes];
    const blocks = [];
    let loose = null;
    for (const n of kids) {
      if (n.nodeType === 1 && n.tagName === "DIV") { blocks.push(n); loose = null; }
      else if (n.nodeType === 1 && n.tagName === "BR" && !blocks.length) { blocks.push(loose = null); }
      else { if (!loose) { loose = document.createElement("div"); blocks.push(loose); } loose.appendChild(n.cloneNode(true)); }
    }
    if (!blocks.length) blocks.push(el);
    return blocks.map((b, i) => ({ runs: b ? this._inlineRuns(b) : [this._defaultRun("")], br: i > 0 }));
  },
  _inlineRuns(container) {
    const runs = [];
    const push = (text, bold, italic, color) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && !!last.bold === !!bold && !!last.italic === !!italic && (last.color || null) === (color || null)) last.text += text;
      else runs.push({ text, bold: !!bold, italic: !!italic, color: color || null });
    };
    const walk = (node, bold, italic, color) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { push(child.nodeValue, bold, italic, color); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (tag === "BR") continue;
        if (tag === "B" || tag === "STRONG") { walk(child, true, italic, color); continue; }
        if (tag === "I" || tag === "EM") { walk(child, bold, true, color); continue; }
        if (tag === "SPAN" || tag === "FONT") { walk(child, bold, italic, this._colorOf(child) || color); continue; }
        walk(child, bold, italic, color);   // an unrecognized wrapper — still walk its text plainly
      }
    };
    walk(container, false, false, null);
    return runs.length ? runs : [this._defaultRun("")];
  },
  _colorOf(el) {
    if (el.tagName === "FONT" && el.getAttribute("color")) return this._normalizeColor(el.getAttribute("color"));
    return el.style && el.style.color ? this._normalizeColor(el.style.color) : null;
  },
  // execCommand("foreColor") reports back as rgb(...); SVG fill wants hex, and this also
  // normalizes anything else the browser might hand back (named colors, hsl, …).
  _normalizeColor(c) {
    const probe = document.createElement("div"); probe.style.color = c;
    probe.style.display = "none"; document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color; probe.remove();
    const m = rgb.match(/\d+/g); if (!m) return null;
    return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  },
  // A small floating Bold/Italic/Color bar, shown only while there's a real (non-collapsed)
  // selection inside the overlay — mousedown (not click) with preventDefault so the button
  // press doesn't itself collapse the contentEditable selection before the command runs.
  _buildTextToolbar(ed) {
    const bar = document.createElement("div");
    bar.className = "hv-text-toolbar"; bar.hidden = true;
    const btn = (label, title, cmd) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "hv-text-tb-btn"; b.textContent = label; b.title = title;
      b.addEventListener("mousedown", (e) => { e.preventDefault(); document.execCommand(cmd); this._updateTextToolbar(); });
      bar.appendChild(b);
      return b;
    };
    this._tbBold = btn("B", "Bold", "bold");
    this._tbItalic = btn("I", "Italic", "italic");
    const swatch = document.createElement("input");
    swatch.type = "color"; swatch.className = "hv-text-tb-color"; swatch.title = "Color";
    swatch.addEventListener("mousedown", (e) => e.stopPropagation());
    // Unlike the B/I buttons (mousedown.preventDefault keeps focus on `ed` throughout), opening
    // the native color picker DOES steal focus onto this <input> — restore it afterward, or
    // `ed`'s own blur handler (the click-away-commits path for anything outside the canvas)
    // never fires again and the overlay can get stuck open.
    swatch.addEventListener("input", () => { document.execCommand("foreColor", false, swatch.value); ed.focus(); this._updateTextToolbar(); });
    bar.appendChild(swatch);
    this._tbColor = swatch;
    return bar;
  },
  // Reposition + show/hide the toolbar above the current selection; called on every
  // selectionchange while the rich overlay is open.
  _updateTextToolbar() {
    const te = this._textEdit; if (!te || !te.rich) return;
    const ed = te.el, bar = te.toolbar; if (!bar) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !ed.contains(sel.anchorNode)) { bar.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.style.left = (r.left + r.width / 2) + "px";
    bar.style.top = (r.top - 6) + "px";
    this._tbBold.classList.toggle("on", document.queryCommandState("bold"));
    this._tbItalic.classList.toggle("on", document.queryCommandState("italic"));
  },
  _commitText() {
    const te = this._textEdit; if (!te) return;
    this._textEdit = null;   // null FIRST so the blur handler can't re-enter mid-commit
    const { node, el, wrap, toolbar, isNew, rich, before, beforeRuns } = te;
    if (this._textSelHandler) { document.removeEventListener("selectionchange", this._textSelHandler); this._textSelHandler = null; }
    const input = rich ? this._readOverlayRuns(el) : this._readEditable(el);
    const str = rich ? input.map((l) => this._runsToPlain(l.runs)).join("\n") : input;
    wrap.remove();
    if (toolbar) toolbar.remove();
    node.classList.remove("hv-text-editing");
    const empty = !str.trim();
    const changed = rich ? JSON.stringify(input) !== JSON.stringify(beforeRuns) : str !== before;
    if (isNew) {
      if (empty) { node.remove(); this.cancelCoalesce(); this.selection = new Set(); }
      else { this._writeContent(node, input); this.commitCoalesce("Add text"); this.selection = new Set([node.getAttribute("data-hv-id")]); }
    } else {
      if (empty) { this.push("Delete text"); node.remove(); this.selection = new Set(); }
      else if (changed) { this.push("Edit text"); this._writeContent(node, input); }
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
  // ---- rich runs ("Rich text runs"): per-word bold/italic/color ----
  // A LINE is any element carrying its own `x` (always true for a multi-line point-text
  // tspan and every area-text line, per _writeTextContent/_renderAreaLines below), or the
  // <text>/<textPath> element itself when there's no line-tspan at all (an unwrapped
  // single-line doc). Within a line, plain textContent = one default run; nested <tspan>
  // children WITHOUT an `x` attribute (never present on a line-tspan) are explicit runs, one
  // per bold/italic/color span. That `x`-attribute test is the one thing distinguishing a
  // line-tspan from a run-tspan; both are otherwise the same element type.
  _defaultRun(text) { return { text: text || "", bold: false, italic: false, color: null }; },
  _runsOf(container) {
    const kids = [...container.childNodes].filter((n) => n.nodeType === 1 && n.tagName.toLowerCase() === "tspan" && !n.hasAttribute("x"));
    if (!kids.length) return [this._defaultRun(container.textContent)];
    return kids.map((k) => ({
      text: k.textContent || "",
      bold: (k.getAttribute("font-weight") || "") === "700",
      italic: (k.getAttribute("font-style") || "") === "italic",
      color: k.getAttribute("fill") || null,
    }));
  },
  // Read a <text> back to STRUCTURED lines: [{runs:[{text,bold,italic,color}], br}]. On-path
  // text is scoped OUT of rich runs (v1) — always one plain line, whatever markup is there.
  _readTextRuns(node) {
    const tp = node.querySelector(":scope > textPath");
    if (tp) return [{ runs: [this._defaultRun(tp.textContent)], br: false }];
    const lineEls = [...node.querySelectorAll(":scope > tspan[x]")];
    if (!lineEls.length) return [{ runs: this._runsOf(node), br: false }];
    return lineEls.map((t) => ({ runs: this._runsOf(t), br: !!t.getAttribute("data-hv-br") }));
  },
  // _readTextRuns, but for AREA text, soft-wrapped rendered lines are rejoined into their
  // original PARAGRAPHS first (via _linesToRuns) — the shape re-wrapping/re-editing actually
  // wants. Point text never soft-wraps (each rendered line IS a paragraph already), so it
  // passes through unchanged. Skipping this step for area text is exactly the bug that made a
  // re-wrap at a new width freeze the OLD wrap points as fake hard breaks.
  _readTextParagraphs(node) {
    const lines = this._readTextRuns(node);
    return parseFloat(node.getAttribute("data-hv-text-width")) > 0 ? this._linesToRuns(lines) : lines;
  },
  _runsToPlain(runs) { return runs.map((r) => r.text).join(""); },
  // Read a <text> back to a string for the editor. Point text -> one tspan per line ("\n").
  // Area text -> rebuild the FLOW: soft-wrapped lines re-join with a space, hard-break starts
  // (data-hv-br) with "\n", so the editor re-wraps faithfully instead of freezing the wrap.
  // Formatting-blind by design -- callers that need runs use _readTextRuns instead.
  _readTextContent(node) {
    const lines = this._readTextRuns(node);
    if (this._hasTextPath(node)) return this._runsToPlain(lines[0].runs);
    if (parseFloat(node.getAttribute("data-hv-text-width")) > 0) {
      let s = "";
      lines.forEach((ln, i) => { if (i > 0) s += ln.br ? "\n" : " "; s += this._runsToPlain(ln.runs); });
      return s;
    }
    return lines.map((ln) => this._runsToPlain(ln.runs)).join("\n");
  },
  // The literal on-screen lines (one per tspan) -- area text already wrapped. Used by
  // convert-to-outlines so the outline matches the rendered wrapping exactly. Formatting-blind
  // (plain text); run-aware outline conversion reads _readTextRuns directly instead.
  _literalLines(node) {
    const lines = this._readTextRuns(node);
    if (this._hasTextPath(node)) return this._runsToPlain(lines[0].runs);
    return lines.map((ln) => this._runsToPlain(ln.runs)).join("\n");
  },
  _hasTextPath(node) { return !!(node && node.querySelector && node.querySelector(":scope > textPath")); },
  // The <path> element a text node is bound to via its <textPath href>, or null. Searches
  // `root` (an Element with querySelector) if given, else the live stage — so this also works
  // against a DETACHED DOMParser clone (export's own copy of the markup, not the live document),
  // as long as the referenced <path> is present in that same clone.
  _boundPathEl(node, root) {
    const tp = node && node.querySelector && node.querySelector(":scope > textPath");
    if (!tp) return null;
    const href = tp.getAttribute("href") || tp.getAttribute("xlink:href") || "";
    return href ? (root || this.stage).querySelector("#" + CSS.escape(href.slice(1))) : null;
  },
  // Dispatch: on-path → single run; AREA (has a wrap width) → word-wrap; POINT → hard breaks only.
  // `input` is either a plain string (legacy callers — MCP's hv_set_text, thread-cascade
  // fallbacks) or a structured lines array from _readTextRuns/_wrapRunLines (the rich commit
  // path) — _plainToLines below normalizes either into one shape before rendering.
  _writeContent(node, input) {
    const tp = node.querySelector(":scope > textPath");
    if (tp) { tp.textContent = (typeof input === "string" ? input : this._runsToPlain(input.flatMap((l) => l.runs))).replace(/\n/g, " "); return; }
    if (parseFloat(node.getAttribute("data-hv-text-width")) > 0) this._writeAreaContent(node, input);
    else this._writeTextContent(node, input);
  },
  // A plain string -> one default-run "paragraph" per \n-separated line (br on every line
  // after the first, matching how a hard Enter always started a fresh paragraph before runs
  // existed). Already-structured input passes through unchanged.
  _plainToLines(input) {
    if (Array.isArray(input)) return input;
    return String(input).split("\n").map((t, i) => ({ runs: [this._defaultRun(t)], br: i > 0 }));
  },
  // A reusable canvas 2D context for text measurement (the font is loaded → metrics are real).
  _measureCtx() { return (this._measCtx = this._measCtx || document.createElement("canvas").getContext("2d")); },
  // Greedy word-wrap to `width` user-units using the node's own base font (family/size never
  // vary per run in v1 — only weight/style/color do) plus each RUN's own bold/italic, so a
  // bold run measures against its own metrics instead of the object's default. `input` is
  // either a plain string or already-structured paragraph lines (_readTextRuns' shape, before
  // wrapping). Returns [{runs, br}] — the SAME shape, now soft-wrapped to width; a run that
  // crosses a wrap point is split, its two halves keeping the same bold/italic/color.
  _wrapRunLines(node, input, width) {
    const paraLines = this._plainToLines(input);
    const ctx = this._measureCtx();
    const fam = node.getAttribute("font-family") || "sans-serif";
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const ls = parseFloat(node.getAttribute("letter-spacing")) || 0;
    const fontOf = (run) => `${run.italic ? "italic" : "normal"} ${run.bold ? "700" : "400"} ${fs}px ${fam}`;
    const w = (run, s) => { if (!s) return 0; ctx.font = fontOf(run); return ctx.measureText(s).width + ls * s.length; };
    const merge = (pieces) => {
      const runs = [];
      for (const p of pieces) {
        const last = runs[runs.length - 1];
        if (last && !!last.bold === !!p.run.bold && !!last.italic === !!p.run.italic && (last.color || null) === (p.run.color || null)) last.text += p.text;
        else runs.push({ text: p.text, bold: !!p.run.bold, italic: !!p.run.italic, color: p.run.color || null });
      }
      return runs.length ? runs : [this._defaultRun("")];
    };
    const out = [];
    paraLines.forEach((para, pi) => {
      const tokens = [];
      for (const run of para.runs) for (const t of String(run.text || "").split(/(\s+)/)) if (t) tokens.push({ text: t, run });
      if (!tokens.some((t) => t.text.trim())) { out.push({ runs: [this._defaultRun("")], br: pi > 0 }); return; }
      let pieces = [], lineW = 0, first = true, hasContent = false;
      const flush = () => {
        while (pieces.length && !pieces[pieces.length - 1].text.trim()) pieces.pop();
        out.push({ runs: merge(pieces), br: pi > 0 && first });
        first = false; pieces = []; lineW = 0; hasContent = false;
      };
      const fitPrefix = (run, s) => { let lo = 1, hi = s.length, n = 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (w(run, s.slice(0, m)) <= width) { n = m; lo = m + 1; } else hi = m - 1; } return n; };
      for (const tok of tokens) {
        const tw = w(tok.run, tok.text);
        if (hasContent && lineW + tw > width) flush();
        // A whitespace-only token opening a fresh line is dropped (matches the pre-runs
        // algorithm's `tok.replace(/^\s+/, "")`) — checked AFTER the flush above, not just at
        // the top of the loop: when the overflowing token IS the space itself (not the word
        // after it), flush() resets hasContent to false mid-iteration for THIS token, and only
        // a post-flush check catches it — otherwise that space lands as the new line's first
        // piece, e.g. "fox" / " jumps" instead of "fox" / "jumps".
        if (!hasContent && !tok.text.trim()) continue;
        if (!hasContent && tw > width && tok.text.trim()) {
          // Char-break an overlong token (a long word/URL), possibly across several lines —
          // same idea as break-word, generalized to this token's own run/font.
          let rest = tok.text;
          while (w(tok.run, rest) > width && rest.length > 1) {
            const n = fitPrefix(tok.run, rest);
            pieces.push({ text: rest.slice(0, n), run: tok.run }); flush();
            rest = rest.slice(n);
          }
          pieces.push({ text: rest, run: tok.run }); lineW = w(tok.run, rest); hasContent = !!rest.trim();
          continue;
        }
        pieces.push({ text: tok.text, run: tok.run }); lineW += tw;
        if (tok.text.trim()) hasContent = true;
      }
      flush();
    });
    return out;
  },
  // Legacy plain-string wrap — thin wrapper over _wrapRunLines, returns [{text, br}] the way
  // callers before runs existed expect (used nowhere internally anymore, kept for anyone
  // reaching in from outside, e.g. tests exercising the wrap directly).
  _wrapLines(node, text, width) {
    return this._wrapRunLines(node, text, width).map((l) => ({ text: this._runsToPlain(l.runs), br: l.br }));
  },
  // ---------- threaded text (Epic P.2/P.3) ----------
  // A chain is just a forward pointer: data-hv-text-next names the successor's data-hv-id.
  // Each box has at most one outbound link and at most one inbound one (no branching, no
  // cycles — enforced in linkTextFrames). Only the un-linked HEAD of a chain is ever typed
  // into directly; every downstream box is fed by _writeAreaContent's cascade below and
  // can't be edited on its own (see _selectThreadTarget). The link survives save/reopen via
  // editor.js's PERSIST_ATTRS/_captureLiveBlob mechanism — data-hv-text-next is the one entry
  // there whose VALUE is itself a cross-reference (another node's data-hv-id, unstable across
  // reopen), translated through a real minted id at capture time and back on rehydrate.
  _isAreaText(n) { return !!(n && n.tagName && n.tagName.toLowerCase() === "text" && parseFloat(n.getAttribute("data-hv-text-width")) > 0); },
  _threadNextOf(node) { const id = node && node.getAttribute("data-hv-text-next"); return id ? this.nodeById(id) : null; },
  _threadPrevOf(node) {
    if (!this.stage || !node) return null;
    const id = node.getAttribute("data-hv-id");
    for (const n of this.stage.querySelectorAll("text[data-hv-text-next]")) if (n.getAttribute("data-hv-text-next") === id) return n;
    return null;
  },
  _isThreadTarget(node) { return !!this._threadPrevOf(node); },
  // Thread the FIRST-selected box's overflow into the SECOND (selection order is click
  // order — select the overflowing box, then shift-click its destination, matching how
  // Illustrator's own "select source then destination" gesture reads).
  linkTextFrames() {
    const nodes = this.selectedNodes();
    if (nodes.length !== 2 || !nodes.every((n) => this._isAreaText(n))) { setStatus("Select two text boxes (the overflowing one first) to thread them.", 3000); return; }
    const [a, b] = nodes;
    if (a === b) return;
    const existingSource = this._threadPrevOf(b);
    if (existingSource && existingSource !== a) { setStatus("That box is already threaded from another box — unthread it first.", 3200); return; }
    let cur = b, guard = 0;   // cycle guard: walking forward from b must never reach a
    while (cur && guard++ < 500) { if (cur === a) { setStatus("That would thread the boxes in a loop.", 3200); return; } cur = this._threadNextOf(cur); }
    this.push("Thread text");
    a.setAttribute("data-hv-text-next", b.getAttribute("data-hv-id"));
    this._writeAreaContent(a, this._readTextParagraphs(a));   // cascades into b right away, formatting intact
    this._renderSelection(); this._renderInspector();
    setStatus("Threaded — overflow now flows from the first box into the second.", 2600);
  },
  // Unthread the link touching `node` (defaults to the selection): works from either end —
  // if node is a source, drop its own link; if it's a target, drop the link feeding it.
  unlinkTextFrames(node) {
    node = node || this.selectedNodes().find((n) => this._isAreaText(n) && (n.getAttribute("data-hv-text-next") || this._isThreadTarget(n)));
    if (!node) return;
    const source = node.getAttribute("data-hv-text-next") ? node : this._threadPrevOf(node);
    if (!source) return;
    this.push("Unthread text");
    source.removeAttribute("data-hv-text-next");
    this._writeAreaContent(source, this._readTextParagraphs(source));
    this._renderSelection(); this._renderInspector();
    setStatus("Unthreaded.", 2000);
  },
  // How many of `lineCount` wrapped lines fit this node's own box height — the same math
  // _areaOverflows uses, walked one line at a time. No height set → everything "fits"
  // (unbounded box), matching _areaOverflows treating boxH<=0 as never overflowing.
  _fitLineCount(node, lineCount) {
    const boxH = parseFloat(node.getAttribute("data-hv-text-height")) || 0;
    if (!(boxH > 0)) return lineCount;
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    for (let n = lineCount; n > 0; n--) if (((n - 1) * fs * lh + fs) <= boxH + 0.5) return n;
    return 0;
  },
  // Append `runs` as this LINE element's content: a single default (unbold/unitalic/no-color)
  // run renders as plain textContent (byte-identical to a pre-rich-runs document — no nested
  // tspan clutter for the common case); anything else becomes one nested run-tspan per run,
  // each carrying only the attributes that differ from the object's own default. A run-tspan
  // never gets an `x` — that's the exact marker _readTextRuns uses to tell a run apart from a
  // LINE (which always has one).
  _renderRunsInto(container, runs) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (runs.length === 1 && !runs[0].bold && !runs[0].italic && !runs[0].color) {
      container.textContent = runs[0].text;
      return;
    }
    for (const r of runs) {
      const rs = document.createElementNS(SVG_NS, "tspan");
      if (r.bold) rs.setAttribute("font-weight", "700");
      if (r.italic) rs.setAttribute("font-style", "italic");
      if (r.color) rs.setAttribute("fill", r.color);
      rs.textContent = r.text;
      container.appendChild(rs);
    }
  },
  // Render exactly these wrapped lines as tspans — the write half of _writeAreaContent,
  // split out so a threaded box can render only the prefix that fits its own height.
  _renderAreaLines(node, lines) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const boxX = parseFloat(node.getAttribute("x")) || 0;
    const boxW = parseFloat(node.getAttribute("data-hv-text-width")) || 0;
    // Every line's own tspan carries the anchor-adjusted x (not always the box's left edge):
    // text-anchor is set on the parent <text> and inherits down, so "middle"/"end" without this
    // just anchors each line ON the left edge instead of centring/right-aligning it IN the box —
    // the text visually spills past the box instead of aligning inside it.
    const anchor = node.getAttribute("text-anchor") || "start";
    const x = String(Math.round((anchor === "middle" ? boxX + boxW / 2 : anchor === "end" ? boxX + boxW : boxX) * 100) / 100);
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    lines.forEach((ln, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? "0" : String(Math.round(fs * lh * 100) / 100));
      ts.setAttribute("xml:space", "preserve");
      if (i > 0 && ln.br) ts.setAttribute("data-hv-br", "1");
      this._renderRunsInto(ts, ln.runs);
      node.appendChild(ts);
    });
  },
  // Reassemble a wrapped-lines array back into a logical RUNS array — soft-wrapped lines
  // rejoin with a space (appended as a plain-run token to whatever the last run was), hard
  // breaks (br) start a fresh paragraph. Mirrors _readTextRuns' own line loop, so a threaded
  // tail re-wraps at the next box's width — WITH its formatting intact — the same way
  // re-editing the source would.
  _linesToRuns(lines) {
    const out = [];
    lines.forEach((ln, i) => {
      const runs = ln.runs.map((r) => ({ ...r }));
      if (i === 0) { out.push({ runs, br: false }); return; }
      if (ln.br) { out.push({ runs, br: true }); return; }
      // Soft-wrapped continuation: glue onto the previous paragraph with a space, so re-wrapping
      // sees one flowing run of text rather than an artificial hard break at the old wrap point.
      const prev = out[out.length - 1];
      const lastRun = prev.runs[prev.runs.length - 1];
      const firstNew = runs[0];
      if (lastRun && !!lastRun.bold === !!firstNew.bold && !!lastRun.italic === !!firstNew.italic && (lastRun.color || null) === (firstNew.color || null)) {
        lastRun.text += " " + firstNew.text; prev.runs.push(...runs.slice(1));
      } else {
        prev.runs.push({ text: " ", bold: false, italic: false, color: null }, ...runs);
      }
    });
    return out;
  },
  // A dashed connector between threaded boxes, drawn only while one end is selected (a
  // permanent line per pair would clutter a canvas with several threads — Illustrator's own
  // thread-line view works the same way). Read-only overlay chrome, never in saved output.
  _renderThreadLinks() {
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    const pairs = [];
    for (const n of this.selectedNodes()) {
      if (!this._isAreaText(n)) continue;
      const next = this._threadNextOf(n); if (next) pairs.push([n, next]);
      const prev = this._threadPrevOf(n); if (prev) pairs.push([prev, n]);
    }
    if (!pairs.length) return;
    const ctm = this.stageCTM(); if (!ctm) return;
    const inv = ctm.inverse();
    const seen = new Set();
    for (const [a, b] of pairs) {
      const key = (a.getAttribute("data-hv-id") || "") + ">" + (b.getAttribute("data-hv-id") || "");
      if (seen.has(key)) continue; seen.add(key);
      let ra, rb; try { ra = a.getBoundingClientRect(); rb = b.getBoundingClientRect(); } catch { continue; }
      const p1 = new DOMPoint(ra.right, ra.bottom).matrixTransform(inv);
      const p2 = new DOMPoint(rb.left, rb.top).matrixTransform(inv);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "hv-thread-link");
      line.setAttribute("x1", nfmt(p1.x)); line.setAttribute("y1", nfmt(p1.y));
      line.setAttribute("x2", nfmt(p2.x)); line.setAttribute("y2", nfmt(p2.y));
      ov.appendChild(line);
      const dot = (p, cls) => { const c = document.createElementNS(SVG_NS, "circle"); c.setAttribute("class", cls); c.setAttribute("cx", nfmt(p.x)); c.setAttribute("cy", nfmt(p.y)); c.setAttribute("r", "3"); ov.appendChild(c); };
      dot(p1, "hv-thread-port hv-thread-port-out"); dot(p2, "hv-thread-port hv-thread-port-in");
    }
  },
  // Write wrapped area text: always tspan-per-line (stable x/dy for re-wrap). Paragraph-start
  // lines carry data-hv-br so _readTextContent can rebuild the hard breaks on re-edit.
  // Threaded (has data-hv-text-next): only the prefix that fits THIS box's own height is
  // rendered here; whatever's left over is reassembled and cascaded into the next box —
  // recursively, so a whole chain reflows from one edit at its head.
  _writeAreaContent(node, input) {
    const width = parseFloat(node.getAttribute("data-hv-text-width")) || 200;
    const lines = this._wrapRunLines(node, input, width);
    const next = this._threadNextOf(node);
    let shown = lines, tail = null;
    if (next) {
      const fit = this._fitLineCount(node, lines.length);
      if (fit < lines.length) { shown = lines.slice(0, fit); tail = lines.slice(fit); }
    }
    this._renderAreaLines(node, shown);
    // Unthreaded (or the tail end of a chain): keep flagging overflow the old way. Threaded
    // boxes with somewhere for the overflow to go aren't "overflowing" — they're flowing.
    if (!next && this._areaOverflows(node, lines.length)) node.setAttribute("data-hv-overflow", "1");
    else node.removeAttribute("data-hv-overflow");
    if (next) this._writeAreaContent(next, tail ? this._linesToRuns(tail) : "");
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
  // Write into a <text>: a single default-style line → plain textContent (or, with runs, run-
  // tspans directly under <text> itself — still no line-tspan, since there's only one line);
  // multiple lines → a line-tspan per line (x/dy as before), each carrying its own runs.
  _writeTextContent(node, input) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const lines = this._plainToLines(input);
    if (lines.length <= 1) { this._renderRunsInto(node, (lines[0] || { runs: [this._defaultRun("")] }).runs); return; }
    const x = node.getAttribute("x") || "0";
    const fs = parseFloat(node.getAttribute("font-size")) || 16;
    const lh = this._lineHeightOf(node);
    lines.forEach((ln, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? "0" : String(Math.round(fs * lh * 100) / 100));
      ts.setAttribute("xml:space", "preserve");
      this._renderRunsInto(ts, ln.runs);
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
      this._writeAreaContent(node, this._readTextParagraphs(node));
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
  // True when a 2-object selection is exactly one <text> + one shape with a real outline to
  // bind to. Originally literal-<path>-only; generalized to anything SVG's own <textPath>
  // can natively walk — circle/ellipse/line/polygon/polyline/rect all implement the same
  // SVGGeometryElement interface (getTotalLength/getPointAtLength) a <path> does, and
  // _layoutGlyphsOnPath below already only ever calls those two tag-agnostic methods. This
  // was purely a gating restriction, not an engine limitation — a <g> (no single well-defined
  // outline) correctly still fails the duck-type check and stays excluded.
  _canPutOnPath(nodes) {
    if (!nodes || nodes.length !== 2) return false;
    const text = nodes.find((n) => n.tagName.toLowerCase() === "text" && !this._hasTextPath(n));
    const shape = nodes.find((n) => n !== text && typeof n.getTotalLength === "function");
    return !!text && !!shape;
  },
  // Bind the selected text to the selected shape: the text becomes a <textPath href="#id"> run
  // that flows along the outline (the browser lays out the glyphs; SVG-native, serialises cleanly).
  putTextOnPath() {
    const nodes = this.selectedNodes();
    const text = nodes.find((n) => n.tagName.toLowerCase() === "text");
    const path = nodes.find((n) => n !== text && typeof n.getTotalLength === "function");
    if (!text || !path) { setStatus("Select one text and one shape (path/circle/ellipse/rect/line/polygon) to put the text on it.", 3500); return; }
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
      this._syncTextStyleFrom(n);   // Epic P.1: cascade to every other object sharing n's style
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
    rows.push(this._textStyleRow(reads));
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
      { start: "Left", middle: "Centre", end: "Right" }, (v) => this._setTextAttr("text-anchor", v === "start" ? null : v, { styleKey: "textAnchor", label: "Align", reflow: true })));
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
      // Threaded text (Epic P): link/unlink itself lives in the Actions menu (2-selection
      // "Thread text" / 1-selection "Unthread text") — this just surfaces the chain state so
      // it's never a silent, undiscoverable attribute, with a quick Unthread right here too.
      if (reads.length === 1) {
        const node = reads[0];
        const next = this._threadNextOf(node), prev = this._threadPrevOf(node);
        if (next || prev) {
          const box = document.createElement("div"); box.className = "insp-thread";
          const lab = document.createElement("span"); lab.className = "insp-note";
          const parts = [];
          if (prev) parts.push("← flows from “" + (this.nodeName(prev) || "a linked box") + "”");
          if (next) parts.push("→ overflow flows to “" + (this.nodeName(next) || "a linked box") + "”");
          lab.textContent = parts.join(" · ");
          const un = document.createElement("button"); un.type = "button"; un.className = "insp-action"; un.textContent = "Unthread";
          un.addEventListener("click", () => this.unlinkTextFrames(node));
          box.append(lab, un);
          rows.push(inspRow("Thread", box));
        }
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

  // The Style row (Epic P.1): apply/save/rename/detach/delete a named text style, via a
  // context menu off one button — mirrors the swatch-folder header's right-click menu.
  // Editing Font/Size/Weight/… below this row on a styled object propagates back into the
  // shared style automatically (_syncTextStyleFrom, wired into the setters above); there's
  // no separate "update style from selection" action to remember.
  _textStyleRow(reads) {
    const ids = new Set(reads.map((n) => this._styleIdOf(n)).filter(Boolean));
    const singleId = ids.size === 1 ? [...ids][0] : null;
    const singleDef = singleId ? this._textStyleDef(singleId) : null;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "insp-action";
    btn.textContent = singleDef ? singleDef.name : (ids.size > 1 ? "Mixed styles" : "No style");
    btn.title = "Apply, save, rename, detach or delete a named text style";
    btn.addEventListener("click", (e) => {
      const items = [];
      const styles = this._textStyles();
      for (const def of styles) {
        items.push({ label: (def.id === singleId ? "✓ " : "") + def.name, onClick: () => this.applyTextStyle(def.id) });
      }
      if (styles.length) items.push({ type: "sep" });
      items.push({
        label: "Save selection as new style…",
        onClick: () => this._promptTextStyleName("New text style", "", (nm) => this.makeTextStyle(nm)),
      });
      if (singleDef) {
        items.push({ type: "sep" });
        items.push({
          label: "Rename style…",
          onClick: () => this._promptTextStyleName("Rename text style", singleDef.name, (nm) => this.renameTextStyle(singleId, nm)),
        });
        items.push({ label: "Detach from style", onClick: () => this.detachTextStyle() });
        items.push({ label: "Delete style", onClick: () => this.deleteTextStyle(singleId) });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    return inspRow("Text style", btn);
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
  _layoutGlyphsOnPath(node, glyphs, root) {
    const tp = node.querySelector(":scope > textPath");
    if (!tp || !glyphs || !glyphs.length) return null;
    const pathEl = this._boundPathEl(node, root);
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

  // Shared job-payload builder for both convertSelectedTextToOutlines and outlineTextForExport.
  // Point/area text sends `lines` (WITH runs — one <path> per distinct run color comes back,
  // since a run's bold/italic/color needs its own font/fill and SVG can't mix fills within one
  // path); on-path text keeps sending a single flat `text` (rich runs are scoped OUT of on-path,
  // v1 — see this file's _editText comment) and still comes back as one path via perGlyph.
  _textOutlineJob(node) {
    const onPath = this._hasTextPath(node);
    const fam = window.__fonts.primaryFamily(node.getAttribute("font-family") || "");
    const base = {
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
    };
    if (onPath) {
      const t = node.querySelector(":scope > textPath").textContent || "";
      if (!t.trim()) return null;
      return { onPath, payload: { ...base, text: t.replace(/\n/g, " ") } };
    }
    const lines = this._readTextRuns(node);   // VISUAL lines (area text already wrapped), WITH runs
    if (!lines.some((ln) => this._runsToPlain(ln.runs).trim())) return null;
    return { onPath, payload: { ...base, lines: lines.map((ln) => ({ runs: ln.runs })) } };
  },
  // colors:[{color,d}] (run-aware result) or a lone d (perGlyph/legacy) -> one path spec per
  // distinct fill actually used. color:null means "this text's own fill", not "no path".
  _pathsFromOutlineResult(res) {
    if (res.colors && res.colors.length) return res.colors.filter((e) => e.d).map((e) => ({ d: e.d, color: e.color }));
    return res.d ? [{ d: res.d, color: null }] : [];
  },
  async convertSelectedTextToOutlines() {
    if (this._textEdit) this._commitText();   // flush in-progress typing so we outline live content, not the stale pre-edit text
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    if (!texts.length || !window.__fonts) return;
    const jobs = texts.map((node) => ({ node, ...(this._textOutlineJob(node) || {}) })).filter((j) => j.payload);
    if (!jobs.length) return;
    setStatus("Converting text to outlines…", 0);
    let results;
    try { results = await Promise.all(jobs.map((j) => platform.textOutline(j.payload))); }
    catch (e) { setStatus(`Couldn't outline this text — it needs a web font (pick one from the font browser). ${e.message}`, 6000); this._showHint(); return; }
    this.push("Text to outlines");
    const newIds = [];
    jobs.forEach((j, i) => {
      const res = results[i] || {};
      const paths = j.onPath
        ? [{ d: this._layoutGlyphsOnPath(j.node, res.glyphs || []), color: null }].filter((p) => p.d)
        : this._pathsFromOutlineResult(res);
      if (!paths.length) return;
      const drop = new Set(["x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
        "font-style", "font-stretch", "text-anchor", "letter-spacing", "word-spacing", "xml:space",
        "data-hv-id", "data-hv-name", "data-hv-line-height", "data-hv-text-width", "data-hv-br"]);
      if (j.onPath) drop.add("transform");
      const nm = this.nodeName(j.node); const nmTrim = nm && nm !== "Text" ? (nm.length > 40 ? nm.slice(0, 40) : nm) : null;
      let firstId = null;
      const made = paths.map((p) => {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", p.d);
        // Carry over EVERYTHING that isn't text-layout-specific, so paint (stroke/opacity) plus
        // masks, filters, clip-path and custom data-* survive the conversion — fill is set below
        // instead, per-path (a rich run's own color, when it has one). x/y/transform are dropped
        // for on-path geometry (already baked into the glyph coords via getPointAtLength).
        for (const at of [...j.node.attributes]) if (!drop.has(at.name)) path.setAttribute(at.name, at.value);
        path.setAttribute("fill", p.color || j.node.getAttribute("fill") || "#000000");
        // Glyph counters (the holes in o/e/a/8) are cut by OPPOSITE contour winding — explicit
        // nonzero so they render as holes regardless of the document/boolean-engine default.
        path.setAttribute("fill-rule", "nonzero");
        // Only the FIRST path of a multi-color conversion reuses the original data-hv-id (keeps
        // selection/undo continuity where there used to be exactly one node); the rest mint fresh.
        const id = firstId ? ("n" + (++this.idSeq)) : (j.node.getAttribute("data-hv-id") || ("n" + (++this.idSeq)));
        if (!firstId) firstId = id;
        path.setAttribute("data-hv-id", id);
        if (nmTrim) path.setAttribute("data-hv-name", nmTrim);
        return path;
      });
      for (const p of made) j.node.parentNode.insertBefore(p, j.node);
      j.node.remove();
      newIds.push(...made.map((p) => p.getAttribute("data-hv-id")));
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

  // PDF export (Epic O.1) needs pure vector paths, not <text> + an embedded @font-face: verified
  // that cairosvg (the server-side PDF renderer, hvserver/export_pdf.py) SILENTLY IGNORES a
  // base64 woff2 data: URI @font-face entirely — a document with cairosvg's fallback font
  // installed system-wide would render byte-identically whether the face is embedded or not, no
  // error or warning either way. Rather than risk visually-wrong text in the one export format
  // meant to be print-accurate, outline PLAIN text (point/area — the common case) on a DETACHED
  // clone of the export markup before it ever reaches cairosvg, reusing the same /api/text-outline
  // endpoint the manual "Convert to outlines" button already calls. Best-effort: on ANY outline
  // failure (offline, an unrecognised family, …) this returns the ORIGINAL text unchanged rather
  // than fail the whole export — the export still succeeds, just with cairosvg's own font
  // fallback, i.e. today's (imperfect but working) behaviour.
  // Text-ON-A-PATH is outlined here too (perGlyph, same as convertSelectedTextToOutlines's
  // on-path branch): _boundPathEl/_layoutGlyphsOnPath both take `root` now, so they resolve the
  // bound <path> within THIS detached clone instead of the live stage — the only piece that
  // was missing before. If the referenced <path> id isn't in `svgText` at all (shouldn't happen;
  // export serializes the whole document), _layoutGlyphsOnPath returns null and that one run is
  // left as <text>, same best-effort fallback as any other single-job failure below.
  async outlineTextForExport(svgText) {
    if (!window.__fonts) return svgText;
    // Best-effort end to end, not just around the network call: ANY failure here (a bad family
    // lookup, a parse error, …) returns the ORIGINAL markup unchanged rather than throwing —
    // the export still succeeds, just with cairosvg's own (imperfect but working) font fallback.
    try {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const root = doc.documentElement;
      if (root.tagName.toLowerCase() !== "svg") return svgText;
      const texts = [...root.querySelectorAll("text")];
      if (!texts.length) return svgText;
      // _textOutlineJob is pure DOM (no stage/live-document dependency), so it works unchanged
      // against this DETACHED clone's own <text> nodes.
      const jobs = texts.map((node) => ({ node, ...(this._textOutlineJob(node) || {}) })).filter((j) => j.payload);
      if (!jobs.length) return svgText;
      const results = await Promise.all(jobs.map((j) => platform.textOutline(j.payload)));
      const drop = new Set(["x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
        "font-style", "font-stretch", "text-anchor", "letter-spacing", "word-spacing", "xml:space",
        "data-hv-id", "data-hv-name", "data-hv-line-height", "data-hv-text-width", "data-hv-br"]);
      jobs.forEach((j, i) => {
        const res = results[i] || {};
        const paths = j.onPath
          ? [{ d: this._layoutGlyphsOnPath(j.node, res.glyphs || [], root), color: null }].filter((p) => p.d)
          : this._pathsFromOutlineResult(res);
        if (!paths.length) return;   // this one text run failed to outline — leave it as <text>, don't fail the export
        const nodeDrop = j.onPath ? new Set([...drop, "transform"]) : drop;
        const made = paths.map((p) => {
          const path = doc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", p.d);
          for (const at of [...j.node.attributes]) if (!nodeDrop.has(at.name)) path.setAttribute(at.name, at.value);
          path.setAttribute("fill", p.color || j.node.getAttribute("fill") || "#000000");
          path.setAttribute("fill-rule", "nonzero");
          return path;
        });
        for (const p of made) j.node.parentNode.insertBefore(p, j.node);
        j.node.remove();
      });
      return new XMLSerializer().serializeToString(root);
    } catch { return svgText; }
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
      this._syncTextStyleFrom(n);   // Epic P.1: cascade to every other object sharing n's style
    }
    if (styleKey && v != null && !isNaN(v)) this._textStyle()[styleKey] = v;
    this._renderSelection();
  },
  // Line-height is computed (drives tspan dy), not a native attribute — store the ratio on
  // data-hv-line-height for live re-editing + re-flow. Coalesced like the numeric fields.
  _applyTextLineHeight(v) {
    if (v == null || isNaN(v) || v <= 0) return;
    const texts = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "text");
    for (const n of texts) { n.setAttribute("data-hv-line-height", String(v)); this._reflowText(n); this._syncTextStyleFrom(n); }
    this._textStyle().lineHeight = v;
    this._renderSelection();
  },
};
