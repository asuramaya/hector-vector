// Dockable panel system: every rail panel (History, Layers, Library, Processor,
// Properties, Colour, Info, Jobs) is the same object — drag its header to
// detach/float, drop on a dock to attach, reorder within a dock; one toggle
// folds both side docks; empty docks auto-close and fill auto-opens; floating
// panels can snap into locking-bezel groups. Collapse carets, the shelf (parked
// panels), and contextual auto-shelving all live here too.
//
// Extracted from app.js (#25). Pure shell-UI module: receives the editor, the
// viewport fit helpers, and the two panel re-render hooks through the factory,
// and returns the control object the rest of the shell drives via window.__docks.
// Behaviour-identical to the original inline block (reconcile() still runs before
// the control object is published, exactly as before).
import { showContextMenu } from "./menus.js";   // shelf-square right-click options menu

export function createDocks({ editor, measureFit, viewports, renderProcessorPanel, renderLibrary, renderJobsPanel, processorRelevant, cycleBg }) {
  function wireSectionCollapse(section) {
    const head = section.querySelector(".section-head"); if (!head || head._collapseWired) return;
    head._collapseWired = true;
    const key = "hv-sec-" + section.dataset.section;
    if (localStorage.getItem(key) === "1") section.classList.add("collapsed");
    head.addEventListener("click", (e) => {
      // action clicks or a just-finished drag don't collapse — but a plain click does,
      // whether the panel is docked OR floating (a drag sets head._docking to opt out).
      if (e.target.closest(".panel-actions") || head._docking) return;
      const c = section.classList.toggle("collapsed");
      try { localStorage.setItem(key, c ? "1" : "0"); } catch {}
      const win = head.closest(".dock-window");
      if (win) win.style.height = c ? "auto" : "";   // floating: shrink to the header when collapsed
      if (window.__docks) { window.__docks.relayout(); window.__docks.reflowGroups(); }   // docks split + grouped (snapped) members hug
    });
  }
  document.querySelectorAll(".rail-section[data-section]").forEach(wireSectionCollapse);

  // ---- Dockable panels: drag a panel's header to detach/float, drop on a dock to attach;
  //      panels reorder within a dock; History/Layers/Properties are all the same object;
  //      one toggle folds BOTH side docks; empty docks auto-close, fill auto-opens. ----
  {
    const leftDock = document.querySelector("#leftdock");
    const rightDock = document.querySelector("#rightdock");
    const grid = document.querySelector(".editor-grid");
    const railToggle = document.querySelector("#rail-toggle");
    const DOCKS_KEY = "hector-vector:docks", FOLD_KEY = "hector-vector:sides-folded";
    const ORDER = ["history", "layers", "library", "processor", "properties", "color", "info", "jobs"];   // home identity order
    const dockElFor = (side) => (side === "left" ? leftDock : rightDock);
    let folded = localStorage.getItem(FOLD_KEY) === "1";

    // Properties + Colour aren't in the HTML — build their sections once (same chrome as
    // History/Layers: caret-collapsible, drag header to detach/dock, × only while floating).
    // Default header action tile: Colour → cycle-background, Object → invert-space. The
    // header's action area is a customize-layout RECEIVER (drag toolbar tiles into it),
    // so the remaining width is a blank slot you can drop another tool into.
    const HDR_SLOTS = {
      color: { id: "hdr-bg", g: "◧", t: "Cycle background (b)", fn: () => cycleBg("output") },
      properties: { id: "hdr-invert", g: "⊠", t: "Invert space — fill the gaps", fn: () => editor.invertSpace() },
    };
    const mkPanel = (name, label, extraClass) => {
      const s = document.createElement("div");
      s.className = "rail-section " + name + (extraClass ? " " + extraClass : ""); s.dataset.section = name;
      s.innerHTML = `<div class="panel-head section-head"><span class="caret">▾</span>`
        + `<span class="sec-label fp-title">${label}</span><span class="sec-count"></span>`
        + `<div class="panel-actions hdr-slots"></div></div>`
        + `<div class="section-body fp-body"></div>`
        + (name === "properties" ? `<div class="insp-foot"></div>` : "");   // pinned chin: align-to-artboard bar
      const actions = s.querySelector(".panel-actions");
      const slot = HDR_SLOTS[name];
      if (slot) { const b = document.createElement("button"); b.type = "button"; b.id = slot.id; b.className = "tool-button"; b.title = slot.t; b.textContent = slot.g; b.addEventListener("click", (e) => { e.stopPropagation(); slot.fn(); }); actions.appendChild(b); }
      const x = document.createElement("button"); x.type = "button"; x.className = "tool-button fp-close panel-x"; x.title = "Dock to rail"; x.textContent = "×";
      x.addEventListener("click", (e) => { e.stopPropagation(); close(name); });
      actions.appendChild(x);
      bindHeaderDrag(s); wireSectionCollapse(s);
      if (window.__layout && window.__layout.registerBar) window.__layout.registerBar("hdr-" + name, actions);
      return s;
    };
    let propsSection = null, colorSection = null, infoSection = null;
    function ensureProps() { if (!propsSection) propsSection = mkPanel("properties", "Properties", "context-panel"); return propsSection; }
    function ensureColor() { if (!colorSection) colorSection = mkPanel("color", "Colour"); return colorSection; }
    function ensureInfo() { if (!infoSection) infoSection = mkPanel("info", "Info"); return infoSection; }   // a standard panel object (no ghostly context-panel chrome)
    const sectionEl = (name) => name === "properties" ? propsSection : name === "color" ? colorSection : name === "info" ? infoSection : document.querySelector(`.rail-section[data-section="${name}"]`);
    const isFloat = (name) => { const s = sectionEl(name); return !!(s && s.closest(".dock-window")); };
    const curLoc = (name) => { if (state[name] && state[name].loc === "shelf") return "shelf"; if (groupOf(name)) return "float"; const s = sectionEl(name); if (!s || !s.parentElement) return null; if (s.closest(".dock-window")) return "float"; return s.parentElement === leftDock ? "left" : "right"; };

    const DEFAULT_LOC = { history: "right", layers: "right", library: "right", processor: "right", properties: "right", color: "right", info: "shelf", jobs: "right" };
    // Shelf squares: a glyph + label per panel (parked/unused panels show as these).
    const SHELF_GLYPH = { history: "⟲", layers: "▤", library: "⊞", processor: "▸", properties: "☰", color: "◧", info: "ⓘ", jobs: "☷" };
    const PANEL_LABEL = { history: "History", layers: "Layers", library: "Library", processor: "Processor", properties: "Properties", color: "Colour", info: "Info", jobs: "Jobs" };
    let state = {};
    ORDER.forEach((n, i) => state[n] = { loc: DEFAULT_LOC[n], order: i, rect: null, visible: false });
    try { const s = JSON.parse(localStorage.getItem(DOCKS_KEY) || "null"); if (s) for (const n of ORDER) if (s[n]) state[n] = { ...state[n], ...s[n] }; } catch {}
    // Properties + Colour are permanent panel items now — a previously CLOSED one (float +
    // invisible) returns to its dock so panels can never go missing.
    for (const n of ["properties", "color"]) if (state[n].loc === "float" && !state[n].visible) state[n].loc = DEFAULT_LOC[n] || "right";
    // Locking-bezel groups: snapped floating panels tiled in one container (one axis).
    //   gid -> { axis:"row"|"col", members:[name…], rect:{x,y,w,h}, frac:[n…] (sums to 1) }
    const GROUPS_KEY = "hector-vector:dock-groups";
    let groups = {};
    try { const g = JSON.parse(localStorage.getItem(GROUPS_KEY) || "null"); if (g && typeof g === "object") groups = g; } catch {}
    // Drop members that no longer exist / empties / singletons (a group needs ≥2 panels).
    for (const gid of Object.keys(groups)) {
      const gp = groups[gid];
      if (!gp || !Array.isArray(gp.members)) { delete groups[gid]; continue; }
      gp.members = gp.members.filter((n) => ORDER.includes(n));
      if (gp.members.length < 2) delete groups[gid];
    }
    const groupOf = (name) => Object.keys(groups).find((gid) => groups[gid].members.includes(name)) || null;
    let gidSeq = 0;
    // Panels the Manage screen has BORROWED out of the dock into its own roomy grid. While
    // a panel is "away" the dock leaves it alone — reconcile() won't yank it back, relayout
    // skips it (it isn't a dock child anymore), and contextual auto-shelving ignores it.
    // The Manage controller reparents the actual section element; docks only tracks intent.
    const away = new Set();
    const persist = () => { try { localStorage.setItem(DOCKS_KEY, JSON.stringify(state)); localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); localStorage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch {} };
    const isShown = (name) => { const l = state[name].loc; if (l === "left" || l === "right") return true; if (l === "float") return state[name].visible; return false; };   // "shelf" / anything else → not shown
    const propsVisible = () => isShown("properties");

    function renderProps() {
      if (!propsSection || !propsSection.parentElement || !propsVisible()) return;
      const title = propsSection.querySelector(".fp-title"), body = propsSection.querySelector(".fp-body");
      if (!body) return;
      // Preserve scroll across the rebuild. The raster Process stages live in this
      // body, and toggling live-preview / changing a stage setting re-renders the
      // whole panel — without this, scrollTop snaps to 0 and the content jumps out
      // from under the cursor (the reported "pressing buttons jumps the scroll" bug).
      const keepScroll = body.scrollTop;
      body.innerHTML = "";
      // Bottom chin: the align-to-artboard bar (null unless a non-artboard object is selected).
      const foot = propsSection.querySelector(".insp-foot");
      if (foot) { foot.innerHTML = ""; const bar = editor._alignBar && editor._alignBar(); if (bar) foot.appendChild(bar); }
      if (!editor.stage) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">No canvas.</div>`; return; }
      if (editor.artboardSelected) { title.textContent = "Artboard"; body.appendChild(editor._artboardPanel()); body.scrollTop = keepScroll; return; }
      let nodes = editor._effectiveLeaves(); if (!nodes.length) nodes = editor.selectedNodes();
      if (!nodes.length) { title.textContent = "Properties"; body.innerHTML = `<div class="insp-empty">Select an object, or right-click the canvas for the artboard.</div>`; return; }
      title.textContent = editor._selectionIsRaster()
        ? (nodes.length === 1 ? "Raster" : `${nodes.length} rasters`)
        : (nodes.length === 1 ? "Object" : `${nodes.length} objects`);
      body.appendChild(editor._objectPanel(nodes));
      body.scrollTop = keepScroll;
    }
    // Colour panel hosts the live duo editor (built by the swatch block). Only rebuild on a
    // real selection-SET change — colour edits don't change the set, so the editor isn't
    // torn down mid-interaction.
    let lastColorKey = null;
    function renderColor() {
      if (!colorSection || !colorSection.parentElement || !isShown("color") || typeof editor._renderColorPanel !== "function") return;
      const body = colorSection.querySelector(".section-body"); if (!body) return;
      const key = [...(editor.selection || [])].sort().join(",") + "|" + !!editor.artboardSelected;
      if (key === lastColorKey && body.querySelector(".cp-window")) return;
      lastColorKey = key; editor._renderColorPanel(body);
    }
    function renderPanels() { renderProps(); renderColor(); if (typeof renderLibrary === "function") renderLibrary(); if (typeof renderJobsPanel === "function") renderJobsPanel(); if (typeof renderProcessorPanel === "function") renderProcessorPanel(); }

    // Hidden holding area for parked (shelved / contextually-hidden) sections. They stay
    // in the DOM here (display:none) so HTML panels remain querySelector-able and can be
    // re-homed later — removing them outright orphans them (the disappearing-panel class).
    let attic = null;
    const theAttic = () => { if (!attic) { attic = document.createElement("div"); attic.id = "dock-attic"; attic.style.display = "none"; document.body.appendChild(attic); } return attic; };
    function detachFromWindow(name) {
      const s = sectionEl(name); if (!s) return;
      const w = s.closest(".dock-window");
      theAttic().appendChild(s);   // park (keeps it in the DOM) instead of removing
      if (w) { if (w._ro) w._ro.disconnect(); w.remove(); }
    }
    const SUMMONED = new Set(["properties", "color", "info"]);   // built on demand, summon/close-able
    function ensureSection(name) { return name === "properties" ? ensureProps() : name === "color" ? ensureColor() : name === "info" ? ensureInfo() : sectionEl(name); }
    // Preferred height to FIT the panel's content (header + full body + chin), so a panel
    // dragged out of a dock floats at a size that matches its content rather than whatever
    // slice of the rail it happened to occupy. Falls back to a sane default when collapsed.
    function contentHeight(s) {
      const head = s.querySelector(".panel-head, .section-head");
      const body = s.querySelector(".section-body, .fp-body");
      const chin = s.querySelector(".library-chin, .insp-foot, .layers-foot, .processor-chin");
      let h = 10;
      if (head) h += head.offsetHeight;
      h += (body && body.scrollHeight > 20) ? body.scrollHeight : 280;
      if (chin && chin.offsetHeight) h += chin.offsetHeight;
      return h;
    }
    // Footprints of every currently-floating panel/group (to place new floats clear of them).
    function floatingRects() {
      const out = [];
      document.querySelectorAll(".dock-window, .dock-group").forEach((el) => { const r = el.getBoundingClientRect(); out.push({ x: r.left, y: r.top, w: r.width, h: r.height }); });
      return out;
    }
    const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    // An ideal spot for a fresh float: start right-of-centre (clear of the canvas + left
    // tools), cascade down-right until it doesn't overlap an existing float, clamp on-screen.
    function idealFloatPlacement(w, h) {
      const existing = floatingRects();
      const baseX = Math.max(8, Math.round((innerWidth - w) * 0.6));
      const baseY = 72, step = 30;
      let fallback = null;
      for (let i = 0; i < 8; i++) {
        const x = Math.min(baseX + i * step, Math.max(8, innerWidth - w - 8));
        const y = Math.min(baseY + i * step, Math.max(8, innerHeight - h - 8));
        if (!fallback) fallback = { x, y };
        if (!existing.some((e) => rectsOverlap({ x, y, w, h }, e))) return { x, y };
      }
      return fallback || { x: baseX, y: baseY };
    }
    function ensureFloatWin(name, atX, atY) {
      const s = ensureSection(name); if (!s) return null;
      let w = s.closest(".dock-window"); if (w) return w;
      const r = s.getBoundingClientRect(), prev = state[name].rect, detaching = atX != null;
      // SIZE — remembered float size wins (memory); otherwise fit the content: a sane panel
      // width + the content's natural height. Always clamp to the viewport so a tall panel
      // (e.g. the Library) opens on-screen and scrolls inside instead of running off.
      const naturalW = r.width > 40 ? r.width : 280;
      const ww = Math.min((detaching ? Math.max(240, naturalW) : (prev?.w || Math.max(240, naturalW))), innerWidth - 16);
      // Fit the content, but soft-cap a FRESH float to 80% of the viewport so a long panel
      // (e.g. the Library) opens at a workable size and scrolls inside — not pinned to full
      // height. A remembered float size (prev) always wins.
      const fit = Math.max(180, contentHeight(s));
      const fresh = Math.min(fit, Math.round(innerHeight * 0.8));
      const wh = Math.min((prev?.h || fresh), innerHeight - 16);
      // POSITION — an explicit drop point wins, then remembered position (memory), then an
      // algorithmically ideal slot: right-of-centre, cascading to avoid overlapping panels.
      let x, y;
      if (atX != null) { x = atX; y = atY; }
      else if (prev) { x = prev.x; y = prev.y; }
      else { const p = idealFloatPlacement(ww, wh); x = p.x; y = p.y; }
      x = Math.max(0, Math.min(x, innerWidth - ww));   // keep fully on-screen
      y = Math.max(0, Math.min(y, innerHeight - wh));
      w = document.createElement("div");
      w.className = "dock-window" + (SUMMONED.has(name) ? " float-panel" : "");
      w.dataset.dockWindow = name;
      w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = ww + "px"; w.style.height = wh + "px";
      document.body.appendChild(w); w.appendChild(s);
      s.style.flex = "";   // shed the docked flex (inline 0 0 Npx) so the section fills the float window instead of staying fixed-height
      s.classList.remove("collapsed");
      addResizeHandles(w, name);
      w._ro = new ResizeObserver(() => { const b = w.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); });
      w._ro.observe(w);
      return w;
    }
    // 8-way resize: thin edge + corner handles adjust left/top/width/height, clamped to
    // min size and the viewport, then persist the rect.
    function addResizeHandles(win, name) {
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        const h = document.createElement("div");
        h.className = "dock-rs dock-rs-" + dir;
        h.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const r = win.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY, x0 = r.left, y0 = r.top, w0 = r.width, h0 = r.height;
          const MINW = 190, MINH = 120;
          const mv = (ev) => {
            let x = x0, y = y0, ww = w0, wh = h0;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (dir.includes("e")) ww = Math.max(MINW, w0 + dx);
            if (dir.includes("s")) wh = Math.max(MINH, h0 + dy);
            if (dir.includes("w")) { ww = Math.max(MINW, w0 - dx); x = x0 + (w0 - ww); }
            if (dir.includes("n")) { wh = Math.max(MINH, h0 - dy); y = y0 + (h0 - wh); }
            ww = Math.min(ww, innerWidth - 8); wh = Math.min(wh, innerHeight - 8);
            x = Math.max(0, Math.min(x, innerWidth - ww)); y = Math.max(0, Math.min(y, innerHeight - wh));
            win.style.left = x + "px"; win.style.top = y + "px"; win.style.width = ww + "px"; win.style.height = wh + "px";
          };
          const up = () => {
            window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
            const b = win.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist();
          };
          window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
        });
        win.appendChild(h);
      }
    }

    // ====================== Locking-bezel groups (floating only) ======================
    const SNAP = 16;   // px proximity to snap a dragged panel flush to another's edge
    const normFrac = (gp) => { const s = gp.frac.reduce((a, b) => a + b, 0) || 1; gp.frac = gp.frac.map((f) => f / s); };

    // The seam between two adjacent members: drag to redistribute, double-click to split.
    function mkBezel(gid, i) {
      const bz = document.createElement("div");
      bz.className = "dock-bezel";
      bz.title = "Drag to resize · double-click to detach";
      bz.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); splitGroup(gid, i); });
      bz.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const gp = groups[gid]; if (!gp) return;
        const cont = bezelContainer(gid); if (!cont) return;
        const row = gp.axis === "row";
        const total = row ? cont.getBoundingClientRect().width : cont.getBoundingClientRect().height;
        const f0 = gp.frac[i - 1], f1 = gp.frac[i], sum = f0 + f1;
        const start = row ? e.clientX : e.clientY;
        const mv = (ev) => {
          const d = ((row ? ev.clientX : ev.clientY) - start) / Math.max(1, total);
          const lo = 0.12 * sum;   // keep both members usefully sized
          const a = Math.max(lo, Math.min(sum - lo, f0 + d));
          gp.frac[i - 1] = a; gp.frac[i] = sum - a; applyFracs(gid);
        };
        const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); persist(); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
      return bz;
    }
    const bezelContainer = (gid) => document.querySelector(`.dock-group[data-group="${gid}"]`);
    // Collapsed members hug their header (flex 0 0 auto) so they don't reserve a blank
    // slot; expanded members share the space by fraction. With ALL members collapsed the
    // container folds to the stacked headers (height auto), else it keeps its rect height.
    function applyFracs(gid) {
      const gp = groups[gid], cont = bezelContainer(gid); if (!gp || !cont) return;
      let allCollapsed = true;
      gp.members.forEach((name, i) => {
        const s = sectionEl(name); if (!s) return;
        const col = s.classList.contains("collapsed");
        if (!col) allCollapsed = false;
        s.style.flex = col ? "0 0 auto" : (gp.frac[i] * gp.members.length).toFixed(4) + " 1 0%";
      });
      cont.style.height = allCollapsed ? "auto" : ((gp.rect && gp.rect.h) ? gp.rect.h + "px" : "");
    }

    // 8-way resize of the whole group container — flex children scale together.
    function addGroupResize(cont, gid) {
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        const h = document.createElement("div"); h.className = "dock-rs dock-rs-" + dir;
        h.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
          const r = cont.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY, x0 = r.left, y0 = r.top, w0 = r.width, h0 = r.height;
          const MINW = 280, MINH = 210;   // fit ≥2 members at their per-member floors (see .dock-group min-width/height)
          const mv = (ev) => {
            let x = x0, y = y0, ww = w0, wh = h0; const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (dir.includes("e")) ww = Math.max(MINW, w0 + dx);
            if (dir.includes("s")) wh = Math.max(MINH, h0 + dy);
            if (dir.includes("w")) { ww = Math.max(MINW, w0 - dx); x = x0 + (w0 - ww); }
            if (dir.includes("n")) { wh = Math.max(MINH, h0 - dy); y = y0 + (h0 - wh); }
            ww = Math.min(ww, innerWidth - 8); wh = Math.min(wh, innerHeight - 8);
            x = Math.max(0, Math.min(x, innerWidth - ww)); y = Math.max(0, Math.min(y, innerHeight - wh));
            cont.style.left = x + "px"; cont.style.top = y + "px"; cont.style.width = ww + "px"; cont.style.height = wh + "px";
          };
          const up = () => {
            window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
            const b = cont.getBoundingClientRect(); if (groups[gid]) { groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); }
          };
          window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
        });
        cont.appendChild(h);
      }
    }

    // Drag any member's header to MOVE the whole group (bound once per container).
    function bindGroupMove(cont, gid) {
      cont.addEventListener("pointerdown", (e) => {
        const head = e.target.closest(".section-head"); if (!head || e.button !== 0) return;
        if (e.target.closest(".panel-actions")) return;   // × / header tiles keep their own handlers
        const gp = groups[gid]; if (!gp) return;
        const r = cont.getBoundingClientRect(); const offX = e.clientX - r.left, offY = e.clientY - r.top;
        const sx = e.clientX, sy = e.clientY; let moved = false;
        const mv = (ev) => {
          if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          moved = true; cont.classList.add("dragging"); head._docking = true;
          const x = Math.max(0, Math.min(ev.clientX - offX, innerWidth - 60));
          const y = Math.max(0, Math.min(ev.clientY - offY, innerHeight - 30));
          cont.style.left = x + "px"; cont.style.top = y + "px";
        };
        const up = () => {
          window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
          cont.classList.remove("dragging");
          if (moved && groups[gid]) { const b = cont.getBoundingClientRect(); groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; persist(); setTimeout(() => { head._docking = false; }, 0); }
        };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
    }

    // (Re)build every group container from `groups`: tile the member sections along the
    // group axis with a draggable bezel between each pair; scale via flex.
    function renderGroups() {
      // Build/populate live group containers FIRST — moving member sections into them
      // while they're still in the DOM — THEN remove stale containers. (HTML panels are
      // located by querySelector, so a stale container removed first would take its child
      // sections with it and orphan them — the disappearing-panel bug.)
      for (const gid of Object.keys(groups)) {
        const gp = groups[gid];
        if (!gp.frac || gp.frac.length !== gp.members.length) gp.frac = gp.members.map(() => 1 / gp.members.length);
        normFrac(gp);
        let cont = bezelContainer(gid);
        if (!cont) {
          cont = document.createElement("div"); cont.className = "dock-group"; cont.dataset.group = gid;
          document.body.appendChild(cont); addGroupResize(cont, gid); bindGroupMove(cont, gid);
          cont._ro = new ResizeObserver(() => { const b = cont.getBoundingClientRect(); if (groups[gid]) { groups[gid].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; } });
          cont._ro.observe(cont);
        }
        cont.classList.toggle("col", gp.axis === "col");
        const rc = gp.rect || { x: 80, y: 80, w: 520, h: 320 };
        cont.style.left = rc.x + "px"; cont.style.top = rc.y + "px"; cont.style.width = rc.w + "px"; cont.style.height = rc.h + "px";
        // Re-order children: section, bezel, section, … (appendChild moves existing nodes).
        cont.querySelectorAll(":scope > .dock-bezel").forEach((b) => b.remove());
        const handles = [...cont.querySelectorAll(":scope > .dock-rs")];
        gp.members.forEach((name, i) => {
          const s = ensureSection(name); if (!s) return;
          const w = s.closest(".dock-window"); if (w && w !== cont) { if (w._ro) w._ro.disconnect(); w.remove(); }
          if (i > 0) cont.appendChild(mkBezel(gid, i));
          cont.appendChild(s);
        });
        handles.forEach((h) => cont.appendChild(h));   // keep resize handles on top
        applyFracs(gid);   // size members by fraction (collapsed ones hug their header)
      }
      // now-empty stale containers (their sections were re-homed above or floated by reconcile)
      document.querySelectorAll(".dock-group").forEach((c) => { if (!groups[c.dataset.group]) { if (c._ro) c._ro.disconnect(); c.remove(); } });
    }

    // Pull a floating panel (or a whole group) into a group with `target` on `side`.
    // target: a panel name (standalone float) OR a gid (string starting "g:"). side:
    // "left"|"right" → row, "top"|"bottom" → col.
    function joinGroup(dragName, target, side) {
      const axis = (side === "left" || side === "right") ? "row" : "col";
      const before = (side === "left" || side === "top");
      const dragRect = winRect(dragName);
      const along = axis === "row" ? "w" : "h";
      let gid = (typeof target === "string" && groups[target]) ? target : null;
      if (gid) {
        const gp = groups[gid]; if (gp.axis !== axis) return false;
        const share = Math.max(0.12, Math.min(0.6, (dragRect[along]) / (gp.rect[along] + dragRect[along])));
        gp.frac = gp.frac.map((f) => f * (1 - share));
        if (before) { gp.members.unshift(dragName); gp.frac.unshift(share); }
        else { gp.members.push(dragName); gp.frac.push(share); }
        if (axis === "row") gp.rect.w += dragRect.w; else gp.rect.h += dragRect.h;
      } else {
        // target is a standalone panel → make a new 2-member group
        const tname = target; const tRect = winRect(tname);
        gid = "g:" + (++gidSeq) + ":" + Date.now().toString(36);
        const members = before ? [dragName, tname] : [tname, dragName];
        const fa = dragRect[along], fb = tRect[along], sum = fa + fb || 1;
        const frac = before ? [fa / sum, fb / sum] : [fb / sum, fa / sum];
        const rect = axis === "row"
          ? { x: Math.min(dragRect.x, tRect.x), y: tRect.y, w: dragRect.w + tRect.w, h: Math.max(dragRect.h, tRect.h) }
          : { x: tRect.x, y: Math.min(dragRect.y, tRect.y), w: Math.max(dragRect.w, tRect.w), h: dragRect.h + tRect.h };
        groups[gid] = { axis, members, frac, rect };
      }
      // both panels are now grouped → mark float + drop their standalone windows
      for (const n of [dragName, target].filter((n) => state[n])) { state[n].loc = "float"; if (SUMMONED.has(n)) state[n].visible = true; }
      reconcile(); persist();
      return true;
    }
    const winRect = (name) => { const s = sectionEl(name); const w = s && s.closest(".dock-window"); const r = (w || s)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 80, y: 80, w: 260, h: 300 }; };

    // Split a group at member index `i`: members [0..i) stay, [i..) leave. A side that
    // ends up with a single member becomes a standalone floating window again.
    function splitGroup(gid, i) {
      const gp = groups[gid]; if (!gp || i <= 0 || i >= gp.members.length) return;
      const leftNames = gp.members.slice(0, i), rightNames = gp.members.slice(i);
      const rc = gp.rect, row = gp.axis === "row";
      const cont = bezelContainer(gid);
      const total = cont ? (row ? cont.getBoundingClientRect().width : cont.getBoundingClientRect().height) : (row ? rc.w : rc.h);
      const leftFrac = gp.frac.slice(0, i).reduce((a, b) => a + b, 0);
      const sizeL = Math.round(total * leftFrac), sizeR = (row ? rc.w : rc.h) - sizeL;
      delete groups[gid];
      const mkSide = (names, offset, size) => {
        if (names.length === 1) {
          const n = names[0];
          state[n].rect = row ? { x: rc.x + offset, y: rc.y, w: size, h: rc.h } : { x: rc.x, y: rc.y + offset, w: rc.w, h: size };
          state[n].loc = "float"; if (SUMMONED.has(n)) state[n].visible = true;
        } else {
          const ngid = "g:" + (++gidSeq) + ":" + Date.now().toString(36);
          const fr = names.map((n) => gp.frac[gp.members.indexOf(n)]);
          const rect = row ? { x: rc.x + offset, y: rc.y, w: size, h: rc.h } : { x: rc.x, y: rc.y + offset, w: rc.w, h: size };
          groups[ngid] = { axis: gp.axis, members: names, frac: fr, rect };
          normFrac(groups[ngid]);
        }
      };
      mkSide(leftNames, 0, sizeL);
      mkSide(rightNames, sizeL + 8, sizeR - 8);
      reconcile(); persist();
    }

    // While dragging window `rect` (excluding `self`), find a flush-snap target: the
    // nearest standalone-float panel or group whose opposite edge is within SNAP and
    // overlaps on the perpendicular axis. Returns { target, side } or null.
    function snapTarget(rect, self) {
      const cands = [];
      document.querySelectorAll(".dock-window").forEach((w) => {
        const s = w.querySelector(".rail-section"); const n = s && s.dataset.section;
        if (n && n !== self && !groupOf(n)) cands.push({ kind: "panel", id: n, r: w.getBoundingClientRect() });
      });
      for (const gid of Object.keys(groups)) { const c = bezelContainer(gid); if (c) cands.push({ kind: "group", id: gid, axis: groups[gid].axis, r: c.getBoundingClientRect() }); }
      let best = null;
      const overlapY = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const overlapX = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const R = { left: rect.x, right: rect.x + rect.w, top: rect.y, bottom: rect.y + rect.h };
      for (const c of cands) {
        const cr = c.r;
        // horizontal adjacency (row): drag's right↔target left, or drag's left↔target right
        if (overlapY(R, cr) > 24) {
          if (Math.abs(R.right - cr.left) <= SNAP) best = pick(best, { target: c.id, side: "left", d: Math.abs(R.right - cr.left), kind: c.kind, axis: c.axis });
          if (Math.abs(R.left - cr.right) <= SNAP) best = pick(best, { target: c.id, side: "right", d: Math.abs(R.left - cr.right), kind: c.kind, axis: c.axis });
        }
        if (overlapX(R, cr) > 24) {
          if (Math.abs(R.bottom - cr.top) <= SNAP) best = pick(best, { target: c.id, side: "top", d: Math.abs(R.bottom - cr.top), kind: c.kind, axis: c.axis });
          if (Math.abs(R.top - cr.bottom) <= SNAP) best = pick(best, { target: c.id, side: "bottom", d: Math.abs(R.top - cr.bottom), kind: c.kind, axis: c.axis });
        }
      }
      if (best && best.kind === "group") { const want = (best.side === "left" || best.side === "right") ? "row" : "col"; if (best.axis !== want) return null; }
      return best;
    }
    const pick = (a, b) => (!a || b.d < a.d) ? b : a;
    let snapEl = null;
    const snapInd = () => { if (!snapEl) { snapEl = document.createElement("div"); snapEl.className = "dock-snapline hidden"; document.body.appendChild(snapEl); } return snapEl; };
    function showSnap(t, rect) {
      if (!t) { if (snapEl) snapEl.classList.add("hidden"); return; }
      const tr = t.kind === "group" ? bezelContainer(t.target).getBoundingClientRect() : (sectionEl(t.target).closest(".dock-window")).getBoundingClientRect();
      const ind = snapInd(); ind.classList.remove("hidden");
      const vert = (t.side === "left" || t.side === "right");
      const x = t.side === "left" ? tr.left : t.side === "right" ? tr.right : tr.left;
      const y = t.side === "top" ? tr.top : t.side === "bottom" ? tr.bottom : tr.top;
      ind.style.left = (vert ? x - 2 : tr.left) + "px";
      ind.style.top = (vert ? tr.top : y - 2) + "px";
      ind.style.width = (vert ? "4px" : tr.width + "px");
      ind.style.height = (vert ? tr.height + "px" : "4px");
    }

    // Reconcile the DOM from `state` (placement + ordering + dock visibility + grid).
    function reconcile() {
      for (const name of ORDER) {
        const st = state[name];
        if (away.has(name)) continue;   // borrowed by the Manage screen — leave it where it put it
        if (st.loc === "shelf") { detachFromWindow(name); continue; }   // parked on the shelf
        if (groupOf(name)) continue;   // grouped members are placed by renderGroups()
        if (SUMMONED.has(name) && st.loc === "float" && !st.visible) { detachFromWindow(name); continue; }
        if (st.loc === "float") ensureFloatWin(name);
      }
      for (const side of ["left", "right"]) {
        const dock = dockElFor(side);
        const items = ORDER.filter((n) => state[n].loc === side && !isFloatWanted(n) && !groupOf(n) && !away.has(n)).sort((a, b) => (state[a].order || 0) - (state[b].order || 0));
        for (const n of items) { const s = ensureSection(n); if (!s) continue; detachWinKeepSection(n); s.style.flex = ""; dock.appendChild(s); }
      }
      renderGroups();
      renderShelf();
      syncChrome();
      renderPanels();   // (re)fill Properties / Colour bodies for their current state
      // Re-clamp on ANY layout change (boot/state-restore, fold, dock/float/shelve), not just
      // window resize — a persisted rect saved on a bigger screen, or a programmatic move, can
      // strand a float/group off-screen. In a normally-sized window this only repositions
      // (width/height are kept unless the element genuinely overflows), so group internals
      // and split fractions stay pristine.
      clampFloatsOnResize();
    }
    const isFloatWanted = (n) => state[n].loc === "float";
    function detachWinKeepSection(name) { const s = sectionEl(name); const w = s && s.closest(".dock-window"); if (w) { if (w._ro) w._ro.disconnect(); w.remove(); document.body.appendChild(s); } }

    // ---- Manage screen: lend panels out of the dock and take them back ----
    // borrow() hands the Manage screen the bare section elements for a set of panels and
    // marks them "away" so the dock stops managing them; the caller reparents them into its
    // own grid. A borrowed panel is first pulled out of any group/float and pointed at a
    // dock home (so restore() reliably re-docks it, even if it was idle-shelved). restore()
    // clears "away" and reconciles — which physically moves the sections back into the dock.
    function borrowSections(names) {
      const out = [];
      for (const n of names) {
        removeFromGroup(n);
        detachWinKeepSection(n);   // floating → bare section in the body
        if (state[n].loc !== "left" && state[n].loc !== "right") state[n].loc = DEFAULT_LOC[n] === "left" ? "left" : "right";
        state[n].autoShelved = false;
        away.add(n);
        const s = ensureSection(n);
        if (!s) continue;
        s.style.flex = "";
        s.classList.remove("collapsed");   // open it in the roomy Manage grid
        out.push([n, s]);
      }
      syncChrome();   // the dock lost panels — recompute its columns / fold state
      return out;
    }
    function restoreSections(names) {
      for (const n of names) away.delete(n);
      reconcile();   // re-docks the sections (appendChild moves them out of the Manage grid)
    }

    // Resize between stacked docked panels: every section but the last in a dock gets an
    // explicit height + a drag handle below it; the last fills the remainder.
    function relayoutDock(side) {
      const dock = dockElFor(side);
      dock.querySelectorAll(".dock-vsep").forEach((s) => s.remove());
      const secs = [...dock.querySelectorAll(":scope > .rail-section")];
      const dockH = dock.getBoundingClientRect().height || 600;
      const even = Math.round(dockH / Math.max(1, secs.length));
      // Minimum height each section needs so the stack can never overflow the dock (open =
      // CSS min-height, shut ≈ header; a non-last open section also carries a 7px resize
      // separator). Used to reserve room for the sections that follow.
      const MIN_OPEN = 96, MIN_SHUT = 32, VSEP = 7, lastIdx = secs.length - 1;
      const needOf = (s, idx) => (s.classList.contains("collapsed") ? MIN_SHUT : MIN_OPEN)
        + (idx < lastIdx && !s.classList.contains("collapsed") ? VSEP : 0);
      let used = 0;
      secs.forEach((sec, i) => {
        const name = sec.dataset.section, collapsed = sec.classList.contains("collapsed");
        if (i < lastIdx && !collapsed) {
          // A user-resized panel keeps its explicit height; an untouched one opens at its
          // CONTENT height (so a small panel shrinks to fit instead of claiming a full even
          // slice of empty space). CAP it to whatever's left after reserving the minimum for
          // every following section (+ its separator), so a height persisted at a taller window
          // (or a big manual resize) can't push the stack past the dock and spill off-screen.
          let reserve = 0; for (let j = i + 1; j < secs.length; j++) reserve += needOf(secs[j], j);
          const cap = Math.max(MIN_OPEN, dockH - used - reserve);
          const wanted = state[name].h != null ? state[name].h : Math.max(110, Math.min(even, contentHeight(sec)));
          const h = Math.max(MIN_OPEN, Math.min(wanted, cap));
          sec.style.flex = "0 0 " + h + "px";
          used += h + VSEP;
          const sep = document.createElement("div"); sep.className = "dock-vsep"; sep.title = "Drag to resize";
          bindVSep(sep, sec, name); sec.after(sep);
        } else { sec.style.flex = collapsed ? "0 0 auto" : "1 1 auto"; used += collapsed ? MIN_SHUT : 0; }
      });
    }
    function bindVSep(sep, sec, name) {
      sep.addEventListener("pointerdown", (e) => {
        e.preventDefault(); sep.setPointerCapture(e.pointerId);
        const startY = e.clientY, startH = sec.getBoundingClientRect().height;
        const mv = (ev) => { const h = Math.max(80, startH + (ev.clientY - startY)); sec.style.flex = "0 0 " + h + "px"; state[name].h = h; };
        const up = () => { sep.removeEventListener("pointermove", mv); sep.removeEventListener("pointerup", up); persist(); };
        sep.addEventListener("pointermove", mv); sep.addEventListener("pointerup", up);
      });
    }

    function syncChrome() {
      const leftHas = !!leftDock.querySelector(".rail-section"), rightHas = !!rightDock.querySelector(".rail-section");
      const leftShown = leftHas && !folded, rightShown = rightHas && !folded;
      leftDock.style.display = leftShown ? "flex" : "none";
      rightDock.style.display = rightShown ? "flex" : "none";
      const cols = [];
      if (leftShown) cols.push("auto");
      cols.push("auto", "minmax(0, 1fr)", "auto");
      if (rightShown) cols.push("auto");
      grid.style.gridTemplateColumns = cols.join(" ");
      relayoutDock("left"); relayoutDock("right");
      if (railToggle) { railToggle.classList.toggle("on", folded); railToggle.title = folded ? "Show side panels" : "Hide side panels"; }
      requestAnimationFrame(() => measureFit(viewports.output));
    }

    // Pull a panel out of its group (if any). A group left with one member dissolves —
    // that member becomes a standalone floating window at the group's current footprint.
    function removeFromGroup(name) {
      const gid = groupOf(name); if (!gid) return;
      const gp = groups[gid], i = gp.members.indexOf(name);
      gp.members.splice(i, 1); gp.frac.splice(i, 1);
      if (gp.members.length < 2) {
        const last = gp.members[0];
        if (last) { const r = (bezelContainer(gid) || {}).getBoundingClientRect ? bezelContainer(gid).getBoundingClientRect() : null; state[last].rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : gp.rect; state[last].loc = "float"; if (SUMMONED.has(last)) state[last].visible = true; }
        delete groups[gid];
      } else { normFrac(gp); }
    }

    function setLoc(name, loc, beforeName) {
      removeFromGroup(name);
      if (loc === "float") { state[name].loc = "float"; if (SUMMONED.has(name)) state[name].visible = true; }
      else {
        // insert into `side`, ordered: before `beforeName` (or at the end)
        const others = ORDER.filter((n) => n !== name && state[n].loc === loc).sort((a, b) => (state[a].order || 0) - (state[b].order || 0));
        const idx = beforeName ? others.indexOf(beforeName) : others.length;
        others.splice(idx < 0 ? others.length : idx, 0, name);
        others.forEach((n, i) => state[n].order = i);
        state[name].loc = loc; if (SUMMONED.has(name)) state[name].visible = true;
      }
      reconcile(); persist();
    }

    // ---- drop targeting + indicator ----
    let dropEl = null;
    const dropInd = () => { if (!dropEl) { dropEl = document.createElement("div"); dropEl.className = "dock-droplines hidden"; document.body.appendChild(dropEl); } return dropEl; };
    const hideDrop = () => { if (dropEl) dropEl.classList.add("hidden"); };
    function dropTarget(x, y) {
      for (const side of ["left", "right"]) {
        const dock = dockElFor(side), r = dock.getBoundingClientRect();
        const shown = dock.style.display !== "none" && r.width > 4;
        const inEdge = side === "left" ? x < Math.max(r.right, 64) : x > Math.min(shown ? r.left : innerWidth, innerWidth - 64);
        if (!inEdge || y < 8 || y > innerHeight - 36) continue;
        const secs = shown ? [...dock.querySelectorAll(":scope > .rail-section")] : [];
        let before = null, lineY = null;
        for (const sec of secs) { const sr = sec.getBoundingClientRect(); if (y < sr.top + sr.height / 2) { before = sec.dataset.section; lineY = sr.top; break; } }
        if (before == null && secs.length) lineY = secs[secs.length - 1].getBoundingClientRect().bottom;   // append → line at the bottom edge
        return { side, before, rect: r, shown, lineY, empty: secs.length === 0 };
      }
      return null;
    }
    function showDrop(t) {
      if (!t) { hideDrop(); return; }
      const ind = dropInd(); ind.classList.remove("hidden");
      const w = t.shown && t.rect.width > 8 ? t.rect.width : 270;
      const left = t.side === "left" ? 0 : innerWidth - w;
      if (t.lineY != null) {   // insertion line between / below existing panels
        ind.classList.add("line"); ind.style.left = left + "px"; ind.style.top = (t.lineY - 2) + "px"; ind.style.width = w + "px"; ind.style.height = "4px";
      } else {                 // empty (or hidden) dock → outline the whole drop zone
        ind.classList.remove("line"); ind.style.left = left + "px"; ind.style.top = (t.shown ? t.rect.top : 56) + "px"; ind.style.width = w + "px"; ind.style.height = (t.shown ? t.rect.height : innerHeight - 120) + "px";
      }
    }

    // ---- unified header drag: works whether the panel is docked or already floating ----
    function bindHeaderDrag(section) {
      const head = section.querySelector(".section-head"); if (!head || head._dragBound) return;
      head._dragBound = true;
      // Right-click a panel header → close it to the shelf (contextual close). Away panels
      // (Manage-screen citizens) aren't dock panels — they don't shelve.
      head.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); if (!away.has(section.dataset.section)) shelve(section.dataset.section); });
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".panel-actions") || e.button !== 0) return;
        const name = section.dataset.section;
        if (groupOf(name) || away.has(name)) return;   // grouped → container drives the move; away → it lives in the Manage grid, not draggable into a dock
        const sx = e.clientX, sy = e.clientY;
        let moved = false, win = section.closest(".dock-window"), offX = 24, offY = 12, snap = null;
        if (win) { const r = win.getBoundingClientRect(); offX = sx - r.left; offY = sy - r.top; }
        const onMove = (ev) => {
          if (!moved) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
            moved = true; head._docking = true;
            if (!win) { win = ensureFloatWin(name, ev.clientX - offX, ev.clientY - offY); state[name].loc = "float"; if (SUMMONED.has(name)) state[name].visible = true; syncChrome(); }
            if (win) win.classList.add("dragging");
          }
          if (!win) return;
          win.style.left = Math.max(0, Math.min(ev.clientX - offX, innerWidth - 60)) + "px";
          win.style.top = Math.max(0, Math.min(ev.clientY - offY, innerHeight - 30)) + "px";
          // Prefer snapping to a floating panel/group edge; fall back to the dock drop zones.
          const r = win.getBoundingClientRect();
          snap = snapTarget({ x: r.left, y: r.top, w: r.width, h: r.height }, name);
          if (snap) { hideDrop(); showSnap(snap, r); }
          else { showSnap(null); showDrop(dropTarget(ev.clientX, ev.clientY)); }
        };
        const onUp = (ev) => {
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          hideDrop(); showSnap(null); if (win) win.classList.remove("dragging");
          if (moved) {
            state[name].pinned = true;   // user placed it by hand → exempt from contextual auto-shelving
            if (snap && joinGroup(name, snap.target, snap.side)) { /* grouped */ }
            else {
              const t = dropTarget(ev.clientX, ev.clientY);
              if (t) setLoc(name, t.side, t.before);
              else { state[name].loc = "float"; if (win) { const b = win.getBoundingClientRect(); state[name].rect = { x: b.left, y: b.top, w: b.width, h: b.height }; } reconcile(); persist(); }
            }
            setTimeout(() => { head._docking = false; }, 0);
          }
        };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
      });
    }
    document.querySelectorAll(".rail-section[data-section]").forEach(bindHeaderDrag);

    // Summon / close a summoned panel (Properties, Colour). Show makes it visible (floating
    // it at x,y if it has no home); close fully hides it (undocking if needed).
    function show(name, x, y) {
      ensureSection(name);
      if (state[name].loc === "shelf") { unshelve(name); }   // bring it off the shelf to a dock
      else if (state[name].loc === "float") {
        state[name].visible = true;
        if (!sectionEl(name).closest(".dock-window")) ensureFloatWin(name, (x != null ? x + 6 : null), (y != null ? y + 6 : null));
      }
      const sec = sectionEl(name);
      if (sec) { sec.classList.remove("collapsed"); try { localStorage.setItem("hv-sec-" + name, "0"); } catch {} }   // focusing a panel expands it
      syncChrome();
      if (name === "color") { lastColorKey = null; renderColor(); }
      else if (name === "info") { /* content set by showInfo */ }
      else renderProps();
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "nearest" });
    }
    // Closing ANY panel parks it on the shelf (as a square). Reopen by clicking the square
    // or summoning it (e.g. ⓘ for Info, the swatch for Colour). Remembers its dock side.
    function close(name) { shelve(name); }
    // shelve(name, auto): a MANUAL close (auto falsy) is sticky — it clears the pin and
    // won't auto-return. An AUTO shelve (the contextual sync parking an unused panel) sets
    // autoShelved so it pops back the moment it's relevant again.
    function shelve(name, auto) {
      removeFromGroup(name);
      const cur = state[name].loc;
      // Remember the FULL prior placement (dock side OR float) so reopening restores it
      // exactly — float panels keep their remembered rect (state.rect) too.
      if (cur === "left" || cur === "right" || cur === "float") state[name].lastLoc = cur;
      state[name].loc = "shelf";
      state[name].autoShelved = !!auto;
      if (!auto) state[name].pinned = false;   // manual close → no longer user-pinned
      if (SUMMONED.has(name)) state[name].visible = false;
      reconcile(); persist();
    }
    function unshelve(name) {
      state[name].autoShelved = false;   // it's shown now; back under contextual management
      const last = state[name].lastLoc;
      if (last === "float") {   // restore it floating (ensureFloatWin uses the remembered rect)
        state[name].loc = "float";
        if (SUMMONED.has(name)) state[name].visible = true;
        reconcile(); persist();
        return;
      }
      const back = (last === "left" || last === "right") ? last
        : ((DEFAULT_LOC[name] === "left" || DEFAULT_LOC[name] === "right") ? DEFAULT_LOC[name] : "right");
      setLoc(name, back);   // setLoc clears the group + reconciles + persists
    }
    // Contextual auto-shelving. A contextual panel parks itself into a shelf square when
    // there's nothing for it to act on, and pops back when it's relevant again — but only
    // the ones the SYSTEM parked (autoShelved) return automatically, and a panel the user
    // explicitly dragged into place (pinned) is never auto-parked (it stays put / dims).
    const CTX_RELEVANT = {
      processor: () => (typeof processorRelevant === "function" ? processorRelevant() : true),
      color: () => !!(editor && (editor.artboardSelected || (editor.selection && editor.selection.size > 0))),
    };
    let syncingCtx = false;
    function syncContextual() {
      if (syncingCtx) return;   // shelve()/unshelve() reconcile → guard against re-entry
      syncingCtx = true;
      try {
        for (const name of Object.keys(CTX_RELEVANT)) {
          if (!state[name] || away.has(name)) continue;   // borrowed by Manage → not under dock contextual control
          const relevant = !!CTX_RELEVANT[name]();
          if (relevant) {
            if (state[name].loc === "shelf" && state[name].autoShelved) unshelve(name);
          } else if (isShown(name) && !state[name].pinned) {
            shelve(name, true);
          }
        }
      } finally { syncingCtx = false; }
    }
    // Bring a panel off the shelf. Info is special: its body is content-driven, so we
    // refill it with the current context (last-inspected item, else a help state) rather
    // than reopening whatever stale element it last held.
    function openFromShelf(name) { unshelve(name); unshelveInfoCtx(name); }
    function unshelveInfoCtx(name) { if (name === "info" && typeof window.refillInfoContext === "function") window.refillInfoContext(); }
    // Render the shelf squares (one per shelved panel) into the header tray. A shelved
    // contextual panel that isn't currently relevant reads as dimmed.
    function renderShelf() {
      const shelf = document.querySelector("#panel-shelf"); if (!shelf) return;
      shelf.innerHTML = "";
      for (const name of ORDER) {
        if (state[name].loc !== "shelf") continue;
        const b = document.createElement("button"); b.type = "button";
        b.className = "shelf-sq" + (state[name].autoShelved ? " auto" : "");   // auto = parked-by-context (idle), reads muted
        b.dataset.shelf = name;
        b.textContent = SHELF_GLYPH[name] || (PANEL_LABEL[name] || name)[0];
        const label = PANEL_LABEL[name] || name;
        b.title = `${label}${state[name].autoShelved ? " (idle — nothing to act on)" : ""} — click to open, right-click for options`;
        b.addEventListener("click", () => openFromShelf(name));
        // Right-click → choose where it opens (restore / float / dock either side).
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: `Open ${label}`, onClick: () => openFromShelf(name) },
            { label: "Open floating", onClick: () => { state[name].lastLoc = "float"; state[name].rect = null; openFromShelf(name); } },
            { type: "sep" },
            { label: "Dock left", onClick: () => { unshelveInfoCtx(name); setLoc(name, "left"); state[name].pinned = true; } },
            { label: "Dock right", onClick: () => { unshelveInfoCtx(name); setLoc(name, "right"); state[name].pinned = true; } },
          ]);
        });
        shelf.appendChild(b);
      }
    }
    // Fill the Info panel with a built content element and summon it (floating by default).
    function showInfo(title, el) {
      ensureInfo();
      const t = infoSection.querySelector(".fp-title"); if (t) t.textContent = title || "Info";
      const body = infoSection.querySelector(".fp-body"); if (body) { body.innerHTML = ""; if (el) body.appendChild(el); }
      show("info");
    }
    const summonProps = (x, y) => show("properties", x, y);
    const showColor = () => show("color");

    // Fold BOTH side docks in/out with one control.
    if (railToggle) railToggle.addEventListener("click", () => { folded = !folded; reconcile(); persist(); });
    // Left dock width resizer (mirrors the right one).
    {
      const lh = document.querySelector("#leftdock-resizer");
      if (lh) lh.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startX = e.clientX, startW = leftDock.getBoundingClientRect().width;
        lh.setPointerCapture(e.pointerId);
        const mv = (ev) => { leftDock.style.width = Math.max(200, Math.min(560, startW + (ev.clientX - startX))) + "px"; };
        const up = () => { lh.removeEventListener("pointermove", mv); lh.removeEventListener("pointerup", up); requestAnimationFrame(() => measureFit(viewports.output)); };
        lh.addEventListener("pointermove", mv); lh.addEventListener("pointerup", up);
      });
    }

    // Floating panels + groups carry absolute pixel rects. The window can SHRINK below
    // those coords (e.g. moving a 4K layout onto a 1080p screen, or just narrowing the
    // window), which would strand a float off-screen — and off-screen means its drag
    // handle is gone too, so it's unreachable. On resize, clamp every float/group back
    // into the viewport (and re-store its rect so the position sticks + persists).
    function clampFloatsOnResize() {
      let changed = false;
      const fit = (el, store) => {
        const r = el.getBoundingClientRect();
        const w = Math.min(r.width, innerWidth - 8);
        const h = Math.min(r.height, innerHeight - 8);
        const x = Math.max(0, Math.min(r.left, innerWidth - w));
        const y = Math.max(0, Math.min(r.top, innerHeight - h));
        if (x === r.left && y === r.top && w === r.width && h === r.height) return;
        el.style.left = x + "px"; el.style.top = y + "px";
        el.style.width = w + "px"; el.style.height = h + "px";
        if (store) store({ x, y, w, h });
        changed = true;
      };
      document.querySelectorAll(".dock-window").forEach((el) => {
        const name = el.dataset.dockWindow;
        fit(el, (rect) => { if (state[name]) state[name].rect = rect; });
      });
      document.querySelectorAll(".dock-group").forEach((el) => {
        const gid = el.dataset.group;
        fit(el, (rect) => { if (groups[gid]) groups[gid].rect = rect; });
      });
      if (changed) persist();
    }
    let _clampRAF = 0;
    window.addEventListener("resize", () => {
      if (_clampRAF) return;
      _clampRAF = requestAnimationFrame(() => { _clampRAF = 0; clampFloatsOnResize(); });
    });

    reconcile();
    return {
      float: (n) => setLoc(n, "float"), dock: (n, side, before) => setLoc(n, side || "right", before),
      clampFloats: clampFloatsOnResize,
      loc: curLoc, isFolded: () => folded, toggleFold: () => { folded = !folded; reconcile(); persist(); },
      summonProps, showColor, showInfo, close, shelve, unshelve, syncContextual, renderProps, renderPanels, renderColor, propsVisible,
      // Manage screen borrows panels out of the dock into its own grid, then hands them back.
      borrow: borrowSections, restore: restoreSections, isAway: (n) => away.has(n),
      relayout: () => { relayoutDock("left"); relayoutDock("right"); },
      reflowGroups: () => { for (const gid of Object.keys(groups)) applyFracs(gid); },
      state: () => state,
      // Locking-bezel groups (floating panels). join/split are also driven by drag + the
      // bezel; these expose the same operations for scripting + E2E.
      groups: () => groups,
      groupOf,
      joinGroup: (drag, target, side) => joinGroup(drag, target, side),
      splitGroup: (gid, i) => splitGroup(gid, i),
    };
  }
}
