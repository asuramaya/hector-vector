// Header dropdown menus + right-click context menus — extracted from app.js (#28).
// Two surfaces share one item-rendering core (populateMenuList): the header File/Edit/…
// dropdowns (openMenu, driven by the injected menuItems map) and the floating context
// menus (showContextMenu / showRichContextMenu). The eval-time DOM wiring (trigger
// clicks, outside-click/Esc/blur dismissal) stays in app.js and reads the openMenuEl /
// ctxMenuEl live bindings exported here.
let setStatus, menuItems;
export function configureMenus(deps) {
  ({ setStatus, menuItems } = deps);
}

// Currently-open header dropdown element (null when none). Live binding: app.js's
// trigger wiring reads it to toggle; only ever reassigned inside this module.
export let openMenuEl = null;
export function closeMenus() {
  if (!openMenuEl) return;
  const list = openMenuEl.querySelector(".menu-list");
  const trigger = openMenuEl.querySelector(".menu-trigger");
  if (list) list.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  openMenuEl.classList.remove("open");
  openMenuEl = null;
}
// Render menu items into a list element. Shared by the header dropdowns (openMenu) and
// the right-click rich context menu (showRichContextMenu). `dismiss` closes the host menu
// on activation; `refresh` rebuilds it in place (used by the manageable profile rows after
// a rename/delete so the list reflects the mutation).
function populateMenuList(list, items, opts = {}) {
  const dismiss = opts.dismiss || (() => {});
  const refresh = opts.refresh || (() => {});
  list.innerHTML = "";
  for (const item of items) {
    if (item.type === "sep") { const sep = document.createElement("div"); sep.className = "menu-sep"; list.appendChild(sep); continue; }
    // a manageable row: a label that activates the item + inline rename / delete buttons
    // (used by the Layout profiles). Refresh the menu after a mutation so the list updates.
    const badgeHTML = item.badge ? `<span class="menu-badge">${item.badge}</span>` : "";
    if (item.onRename || item.onDelete) {
      const row = document.createElement("div"); row.className = "menu-item menu-row" + (item.checked ? " checked" : "");
      const lab = document.createElement("button"); lab.type = "button"; lab.className = "menu-rowlabel" + (item.checked ? " checked" : ""); lab.setAttribute("role", "menuitemradio"); lab.setAttribute("aria-checked", item.checked ? "true" : "false");
      lab.innerHTML = `<span class="menu-check">${item.checked ? "✓" : ""}</span><span class="menu-label"></span>${badgeHTML}`;
      lab.querySelector(".menu-label").textContent = item.label;
      lab.addEventListener("click", async () => { dismiss(); try { await item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); } });
      row.appendChild(lab);
      const reopen = (mut) => { try { mut(); } catch (e) { setStatus(e.message || String(e), 3000); } refresh(); };
      if (item.onRename) { const r = document.createElement("button"); r.type = "button"; r.className = "menu-rowbtn"; r.textContent = "✎"; r.title = "Rename"; r.addEventListener("click", (e) => { e.stopPropagation(); reopen(item.onRename); }); row.appendChild(r); }
      if (item.onDelete) { const d = document.createElement("button"); d.type = "button"; d.className = "menu-rowbtn"; d.textContent = "✕"; d.title = "Delete"; d.addEventListener("click", (e) => { e.stopPropagation(); reopen(item.onDelete); }); row.appendChild(d); }
      list.appendChild(row); continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (item.type === "toggle" ? " menu-toggle" : "") + (item.checked ? " checked" : "");
    btn.disabled = !!item.disabled;
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<span class="menu-check">${item.checked ? "✓" : ""}</span><span class="menu-label"></span>${badgeHTML}`;
    btn.querySelector(".menu-label").textContent = item.label;
    btn.addEventListener("click", async () => {
      dismiss();
      try { await item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); }
    });
    list.appendChild(btn);
  }
}
export function openMenu(menuEl) {
  closeMenus();
  const itemsFn = menuItems[menuEl.dataset.menu];
  const list = menuEl.querySelector(".menu-list");
  if (!itemsFn || !list) return;
  populateMenuList(list, itemsFn(), { dismiss: closeMenus, refresh: () => { const m = openMenuEl; closeMenus(); if (m) openMenu(m); } });
  list.hidden = false;
  const trigger = menuEl.querySelector(".menu-trigger");
  if (trigger) trigger.setAttribute("aria-expanded", "true");
  menuEl.classList.add("open");
  openMenuEl = menuEl;
}

// ---------- right-click context menu (canvas + objects) ----------
// Live binding: app.js's click-away/Esc/blur dismissal reads it; only reassigned here.
export let ctxMenuEl = null;
export function hideContextMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
function appendMenuItems(menu, items, afterClick) {
  for (const item of items) {
    if (item.type === "sep") { const s = document.createElement("div"); s.className = "menu-sep"; menu.appendChild(s); continue; }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "menu-item"; btn.disabled = !!item.disabled; btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<span class="menu-check"></span><span class="menu-label"></span>`;
    btn.querySelector(".menu-label").textContent = item.label;
    btn.addEventListener("click", () => {
      try { item.onClick(); } catch (e) { setStatus(e.message || String(e), 3000); }
      if (afterClick) afterClick(); else hideContextMenu();
    });
    menu.appendChild(btn);
  }
}
function placeAt(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + "px";
  el.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + "px";
}
export function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu menu-list";
  menu.setAttribute("role", "menu");
  appendMenuItems(menu, items, null);
  document.body.appendChild(menu);
  placeAt(menu, x, y);
  ctxMenuEl = menu;
}
// Rich right-click menu — the full menu vocabulary (toggles, badges, manageable rows with
// rename/delete). `itemsFn` is re-evaluated when a row mutates so the list stays current.
// This is how the Layout menu (formerly a header button) now reaches the user: right-click
// the blank space of any frame toolbar.
export function showRichContextMenu(x, y, itemsFn) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu menu-list";
  menu.setAttribute("role", "menu");
  populateMenuList(menu, itemsFn(), { dismiss: hideContextMenu, refresh: () => showRichContextMenu(x, y, itemsFn) });
  document.body.appendChild(menu);
  placeAt(menu, x, y);
  ctxMenuEl = menu;
}
