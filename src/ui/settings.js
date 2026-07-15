// General app settings modal — extracted from app.js (#28). Preferences that don't
// belong to the pipeline (startup mode, smart guides, library source), the PWA install
// affordance, the model-inventory install hub (driven by the capability registry), the
// software-update flow, and About. Owns appSettingsOpen / pwaInstallPrompt / versionInfo
// as live bindings (the boot-time PWA event listeners + the modal close hook write them
// through the exported setters); the rest of its shell seams are injected.
import { editor, ghostBtn } from "../editor.js";
import { api } from "./api.js";
import { sectionTitle, fieldRow, makeSelectRaw } from "./widgets.js";
import { capsInfo, ensureCapsInfo } from "./processor.js";
import { loadJobs, installJobActive } from "./jobs.js";
import { CLOUD } from "./env.js";
import { getTouchDebugSnapshot, formatTouchDebugSnapshot, setTouchDebugVisual, isTouchDebugVisualOn } from "./touchdebug.js";
import { openLayoutPicker } from "./layout-picker.js";
import { THEMES, HIGHLIGHTS, currentTheme, setTheme, currentHighlight, setHighlight } from "./theme.js";

// The CURRENT theme's own accent, resolved to a hex an <input type="color"> will accept (it refuses
// "var(--accent)" and every other CSS form). Only ever called when there is NO custom highlight set
// — either at first render, or straight after the "Default" swatch has cleared the override — so
// what it reads back is the theme's own colour, which is exactly what the well should be showing.
function readAccent() {
  const probe = document.createElement("div");
  probe.style.color = "var(--accent)";
  probe.style.display = "none";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = rgb.match(/\d+/g);
  if (!m) return "#1b73e8";
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

let setStatus, openModal, closeModal, modalSearchEl, modalBodyEl,
    prefs, persistPrefs, getWorkspace, refreshAll, fetchStatus, applyStatusData;
export function configureSettings(deps) {
  ({ setStatus, openModal, closeModal, modalSearchEl, modalBodyEl,
     prefs, persistPrefs, getWorkspace, refreshAll, fetchStatus, applyStatusData } = deps);
}
// Setters for the live bindings written from app.js (PWA listeners + modal onAnyClose).
export function setAppSettingsOpen(v) { appSettingsOpen = v; }
export function setPwaInstallPrompt(v) { pwaInstallPrompt = v; }

// PWA install prompt is captured lazily (beforeinstallprompt) and surfaced in the
// general Settings modal (with live install-availability detection).
export let pwaInstallPrompt = null;
async function installPwa() {
  if (!pwaInstallPrompt) return;
  const p = pwaInstallPrompt; pwaInstallPrompt = null;
  p.prompt();
  try { await p.userChoice; } catch {}
  if (appSettingsOpen) openAppSettings();   // refresh the Install row
}
function isInstalledApp() {
  try {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || window.navigator.standalone === true
      || document.querySelector(".app.editor")?.classList.contains("app-window");
  } catch { return false; }
}

// Version comes from the server (/api/version, backed by the repo VERSION file) so
// there's a single source of truth shared with releases. Cached after first fetch.
export let versionInfo = { version: "…", isGit: false, commit: "", branch: "", dirty: false };
export async function loadVersion() {
  try { versionInfo = { ...versionInfo, ...(await api("/api/version")) }; } catch {}
  return versionInfo;
}
// General app settings: preferences that don't belong to the pipeline, plus the
// install affordance and an About section. (The per-process backend "Settings"
// form lives in the Process workspace.)
export let appSettingsOpen = false;
function prefToggleRow(label, checked, onChange, hint) {
  const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return fieldRow(label, inp, hint);
}
// Point the library at a different source folder. Re-fetches the whole workspace
// (refreshAll → fetchStatus → applyStatusData updates `workspace`), so the Settings
// section and the gallery both reflect the new source.
async function setSourceDir(next) {
  next = (next || "").trim();
  try {
    const data = await api("/api/source", "POST", { path: next });
    setStatus(data.message || "Source updated.", 2500);
    await refreshAll();
  } catch (error) { setStatus(error.message, 4000); }
}

// Install / configuration is consolidated in Settings → "AI models & tools". Stages never
// install inline; they point here so install prompts don't pop up scattered around the UI.
export function openToolsSettings() { openAppSettings({ focus: "tools" }); }
// installJobActive() lives in src/ui/jobs.js (imported above).

export function openAppSettings(opts = {}) {
  openModal("Settings", true);
  modalSearchEl.hidden = true;
  appSettingsOpen = true;
  const workspace = getWorkspace();
  const root = document.createElement("div"); root.className = "form";

  root.appendChild(sectionTitle("General"));
  root.appendChild(fieldRow("On launch",
    makeSelectRaw(prefs.startup, [["blank", "Blank canvas"], ["resume", "Resume last document"]],
      (v) => { prefs.startup = v; persistPrefs(); }),
    "What to show when the app opens. Blank starts fresh with an empty canvas."));
  root.appendChild(prefToggleRow("Smart guides", editor.smartGuides,
    (v) => { editor.smartGuides = v; prefs.smartGuides = v; persistPrefs(); }, "Snap to other objects' edges/centres while moving."));

  // ---- Appearance ----
  // The app had exactly one look and no way to have another, because its colours had never been
  // named. Now they are, so this is a picker rather than a project.
  root.appendChild(sectionTitle("Appearance"));
  root.appendChild(fieldRow("Theme",
    makeSelectRaw(currentTheme(), THEMES, (v) => setTheme(v)),
    "Inverted is pure black paper and white ink — the same hard edges, cut the other way."));

  // A shelf of curated swatches, then a custom well. "Pick any of 16 million" is not a choice, it is
  // a chore, and every preset here has been checked as text-on-fill in all three themes — the
  // highlight is a BACKGROUND with knocked-out text as often as it is a line.
  //
  // The custom well is a NATIVE <input type="color"> on purpose. The in-app picker is a rich panel
  // editor built to live inside a dock, and hosting it in a settings row is exactly the mistake that
  // produced the Recolor "rainbow bar" — a whole picker embedded into a 20px swatch, collapsing its
  // own fields into a sliver. One control, both platforms, and on a phone it opens the OS picker.
  const hlRow = document.createElement("div");
  hlRow.className = "hl-pick";
  const swatches = document.createElement("div");
  swatches.className = "hl-swatches";
  const hl = document.createElement("input");
  hl.type = "color";
  hl.title = "Any colour you like";

  const paint = () => {
    const cur = currentHighlight();
    for (const b of swatches.querySelectorAll(".hl-sw")) {
      b.classList.toggle("on", (b.dataset.hex || "") === cur);
    }
    hl.value = cur || readAccent();
  };
  for (const [hex, name] of HIGHLIGHTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hl-sw" + (hex ? "" : " hl-sw-default");
    b.dataset.hex = hex;
    b.title = name;
    b.setAttribute("aria-label", name);
    if (hex) b.style.background = hex;
    b.addEventListener("click", () => { setHighlight(hex); paint(); });
    swatches.appendChild(b);
  }
  hl.addEventListener("input", () => { setHighlight(hl.value); paint(); });
  hlRow.appendChild(swatches);
  hlRow.appendChild(hl);
  paint();
  root.appendChild(fieldRow("Highlight", hlRow,
    "Recolours everything the app uses to point at things: hover, what's switched on, what's selected, and the handles on the canvas."));

  // Where the library reads source images from (the backend /api/source endpoint) — desktop
  // only, there's no disk library in the pure-client cloud build.
  if (!CLOUD) {
    root.appendChild(sectionTitle("Library source"));
    const srcInput = document.createElement("input");
    srcInput.type = "text"; srcInput.value = (workspace && workspace.source_dir) || "";
    srcInput.placeholder = "/absolute/path/to/folder";
    const isDefaultSrc = !!(workspace && workspace.source_dir === workspace.default_source_dir);
    root.appendChild(fieldRow("Folder", srcInput,
      isDefaultSrc ? "Currently the default folder." : "The library scans this folder for source images."));
    const srcActions = document.createElement("div"); srcActions.className = "form-actions";
    srcActions.appendChild(ghostBtn("Set source", async () => { await setSourceDir(srcInput.value); if (appSettingsOpen) openAppSettings(); }));
    if (!isDefaultSrc) srcActions.appendChild(ghostBtn("Reset to default", async () => { await setSourceDir(""); if (appSettingsOpen) openAppSettings(); }));
    root.appendChild(srcActions);
  }

  root.appendChild(sectionTitle("Install"));
  const installWrap = document.createElement("div"); installWrap.className = "form-row";
  const installLabel = document.createElement("span"); installLabel.className = "form-label"; installLabel.textContent = "Desktop app";
  installWrap.appendChild(installLabel);
  if (isInstalledApp()) {
    const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Installed — running as an app. ✓"; installWrap.appendChild(s);
  } else if (pwaInstallPrompt) {
    installWrap.appendChild(ghostBtn("Install…", () => installPwa()));
  } else {
    const b = ghostBtn("Install unavailable", () => {}); b.disabled = true; installWrap.appendChild(b);
    const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Your browser hasn't offered an install yet (or it's already installed)."; installWrap.appendChild(s);
  }
  root.appendChild(installWrap);

  // The model inventory renders itself from the capability registry (GET /api/capabilities,
  // cached in capsInfo) so new models show up here without touching this panel — it scales
  // with the model count by construction. Per-model WEIGHTS download lazily on first use, so
  // the installable unit is the RUNTIME (rembg/realesrgan/vtracer), surfaced once per
  // capability whose models need it. Runtimes with no install path yet (the P3 dejpeg/denoise/
  // deblur/cleanup/face stack) read "coming soon" until their integration task lands.
  // Desktop only — the cloud build has no processing backend to install runtimes into.
  let toolsTitle = null;   // captured so the focus:"tools" deep-link below can scroll to it
  if (!CLOUD) {
  toolsTitle = sectionTitle("AI models & tools");
  root.appendChild(toolsTitle);
  const reopenTools = () => { if (appSettingsOpen) openAppSettings({ focus: "tools" }); };

  // need-token → its package installer. A model whose `needs` aren't all in here has no
  // install path yet (declared in the registry, integration still pending).
  const pkgInstallers = {
    rembg:      { kind: "install-rembg",      name: "rembg",       endpoint: "/api/install/rembg",      size: "~500MB",      ok: () => true },
    realesrgan: { kind: "install-realesrgan", name: "Real-ESRGAN", endpoint: "/api/install/realesrgan", size: "~25MB",       ok: (w) => w && w.curl_available && w.unzip_available, need: "Needs curl + unzip." },
    vtracer:    { kind: "install-vtracer",    name: "VTracer",     endpoint: "/api/install/vtracer",    size: "cargo build", ok: (w) => w && w.cargo_available, need: "Needs cargo (Rust toolchain)." },
    spandrel:   { kind: "install-spandrel",   name: "spandrel + torch", endpoint: "/api/install/spandrel", size: "~300MB", ok: () => true },
    opencv:     { kind: "install-opencv",     name: "opencv (face detect)", endpoint: "/api/install/opencv", size: "~60MB", ok: () => true },
  };
  const pkgInstalled = (need) => !!(workspace && pkgInstallers[need] && workspace[`${need}_installed`]);
  const installPkg = async (need, btn, reset) => {
    const spec = pkgInstallers[need]; if (!spec) return;
    btn.disabled = true; btn.textContent = "Starting…";
    try { const data = await api(spec.endpoint, "POST", {}); setStatus(data.message || "Install started.", 3000); await loadJobs(); reopenTools(); }
    catch (e) { setStatus(e.message, 3000); btn.disabled = false; btn.textContent = reset; }
  };

  if (!capsInfo) {
    const loading = document.createElement("div"); loading.className = "form-hint"; loading.textContent = "Loading model inventory…";
    root.appendChild(loading);
    ensureCapsInfo().then(reopenTools);   // re-render once the registry lands (cached after)
  } else {
    for (const cap of capsInfo) {
      const group = document.createElement("div"); group.className = "cap-group";
      const head = document.createElement("div"); head.className = "cap-group-head";
      const title = document.createElement("span"); title.className = "cap-group-title"; title.textContent = cap.label;
      const count = document.createElement("span"); count.className = "cap-group-count";
      count.textContent = `${cap.models.length} model${cap.models.length === 1 ? "" : "s"}`;
      head.appendChild(title); head.appendChild(count); group.appendChild(head);

      for (const m of cap.models) {
        const row = document.createElement("div"); row.className = "cap-model";
        const name = document.createElement("span"); name.className = "cap-model-name"; name.textContent = m.label;
        const meta = document.createElement("span"); meta.className = "cap-model-meta";
        meta.textContent = `${m.size_mb ? m.size_mb + "MB" : "no download"} · ${(m.intents || []).join(", ")}`;
        const state = document.createElement("span"); state.className = "cap-model-state";
        if (m.available) { state.textContent = "ready ✓"; state.classList.add("is-ready"); }
        else {
          const installable = (m.needs || []).find((n) => pkgInstallers[n] && !pkgInstalled(n));
          if (installable) { state.textContent = `needs ${pkgInstallers[installable].name}`; state.classList.add("is-need"); }
          else { state.textContent = "coming soon"; state.classList.add("is-soon"); }
        }
        row.appendChild(name); row.appendChild(meta); row.appendChild(state);
        group.appendChild(row);
      }

      // One install button per runtime this capability needs that isn't present yet.
      const needs = [...new Set(cap.models.flatMap((m) => m.needs || []))].filter((n) => pkgInstallers[n] && !pkgInstalled(n));
      for (const need of needs) {
        const spec = pkgInstallers[need];
        const act = document.createElement("div"); act.className = "cap-group-action";
        if (installJobActive(spec.kind)) {
          const b = ghostBtn("Installing…", () => {}); b.disabled = true; act.appendChild(b);
          const s = document.createElement("span"); s.className = "form-hint"; s.textContent = "Running in the background — watch Jobs."; act.appendChild(s);
        } else if (!spec.ok(workspace)) {
          const b = ghostBtn(`${spec.name} unavailable`, () => {}); b.disabled = true; act.appendChild(b);
          const s = document.createElement("span"); s.className = "form-hint"; s.textContent = spec.need; act.appendChild(s);
        } else {
          const reset = `Install ${spec.name} (${spec.size})`;
          const btn = ghostBtn(reset, () => installPkg(need, btn, reset));
          act.appendChild(btn);
        }
        group.appendChild(act);
      }
      root.appendChild(group);
    }
  }

  const refreshWrap = document.createElement("div"); refreshWrap.className = "form-actions";
  const missingNeeds = !capsInfo ? [] : [...new Set(capsInfo.flatMap((c) => c.models.flatMap((m) => m.needs || [])))]
    .filter((n) => pkgInstallers[n] && !pkgInstalled(n) && pkgInstallers[n].ok(workspace) && !installJobActive(pkgInstallers[n].kind));
  if (missingNeeds.length >= 2) {
    const reset = `Install all missing (${missingNeeds.length})`;
    const allBtn = ghostBtn(reset, async () => {
      allBtn.disabled = true; allBtn.textContent = "Starting…";
      try { for (const n of missingNeeds) await api(pkgInstallers[n].endpoint, "POST", {}); setStatus(`Started ${missingNeeds.length} installs — watch Jobs.`, 3500); await loadJobs(); reopenTools(); }
      catch (e) { setStatus(e.message, 3000); allBtn.disabled = false; allBtn.textContent = reset; }
    });
    refreshWrap.appendChild(allBtn);
  }
  refreshWrap.appendChild(ghostBtn("Refresh status", async () => {
    try { applyStatusData(await fetchStatus()); reopenTools(); }
    catch (e) { setStatus(e.message, 2500); }
  }));
  root.appendChild(refreshWrap);
  }   // !CLOUD (AI models & tools)

  // Software update flow — desktop only, the cloud build auto-deploys on push.
  if (!CLOUD) {
  root.appendChild(sectionTitle("Updates"));
  const updWrap = document.createElement("div"); updWrap.className = "form-row";
  const updLabel = document.createElement("span"); updLabel.className = "form-label"; updLabel.textContent = "Software update";
  updWrap.appendChild(updLabel);
  const updBox = document.createElement("div"); updBox.style.display = "flex"; updBox.style.flexDirection = "column"; updBox.style.gap = "6px";
  const updMsg = document.createElement("span"); updMsg.className = "form-hint";
  const checkBtn = ghostBtn("Check for updates", async () => {
    checkBtn.disabled = true; updMsg.textContent = "Checking…";
    try {
      const r = await api("/api/update/check", "POST", {});
      if (r.error) { updMsg.textContent = r.error; }
      else if (!r.latest) { updMsg.textContent = `On v${r.current}. No published releases yet.`; }
      else if (r.behind) {
        updMsg.textContent = `v${r.latest} is available (you're on v${r.current}).`;
        if (r.isGit && !r.dirty) updBox.appendChild(applyBtn);
        else updBox.appendChild(linkRow(r.url, r.dirty ? "Local changes present — update via git manually." : "Update via your package manager."));
      } else { updMsg.textContent = `Up to date — v${r.current}. ✓`; }
    } catch (e) { updMsg.textContent = `Check failed: ${e.message}`; }
    finally { checkBtn.disabled = false; }
  });
  const applyBtn = ghostBtn("Update & restart", async () => {
    applyBtn.disabled = true; updMsg.textContent = "Updating…";
    try {
      const r = await api("/api/update/apply", "POST", {});
      updMsg.textContent = (r.message || "Updating…") + " Restart hector-vector to finish.";
    } catch (e) { updMsg.textContent = `Update failed: ${e.message}`; applyBtn.disabled = false; }
  });
  const linkRow = (href, text) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.className = "form-hint"; a.textContent = text + " ↗"; return a; };
  updBox.appendChild(checkBtn); updBox.appendChild(updMsg);
  updWrap.appendChild(updBox);
  root.appendChild(updWrap);
  }   // !CLOUD (Updates)

  // The guaranteed way in. Settings lives in the header menu, which is never itself customizable,
  // so this door can't be hidden away — it's the recovery path if you switch off something you
  // needed, and on a phone it's the only entry point that doesn't rely on a right-click.
  root.appendChild(fieldRow("Adaptive toolbars",
    makeSelectRaw(prefs.adaptiveBars || "suggest-only", [
      ["off", "Off — bars never change"],
      ["suggest-only", "Suggestions only"],
      ["full", "Full — bars follow the selection"],
    ], (v) => { prefs.adaptiveBars = v; persistPrefs(); if (window.__adaptive) window.__adaptive.sync(); }),
    "The selection and object bars can rearrange to show only what you can do with what's selected, "
    + "best first. Anchor (\ud83d\udccc) any button in Customize bars to hold it in place — though it can still "
    + "shift sideways when a button before it disappears. A phone is always fully adaptive."));

  root.appendChild(sectionTitle("Layout"));
  const barsWrap = document.createElement("div"); barsWrap.className = "form-row";
  const barsBox = document.createElement("div"); barsBox.className = "form-actions";
  barsBox.appendChild(ghostBtn("Customize bars…", () => { closeModal(); openLayoutPicker(); }));
  const barsHint = document.createElement("div"); barsHint.className = "form-hint";
  barsHint.textContent = "Choose which buttons appear on each toolbar, and in what order. "
    + "Hiding a button only trims the bar — its keyboard shortcut keeps working. Phone and desktop keep separate layouts.";
  barsWrap.appendChild(barsBox); barsWrap.appendChild(barsHint);
  root.appendChild(barsWrap);

  root.appendChild(sectionTitle("Debug"));
  root.appendChild(prefToggleRow("Touch debug overlay", isTouchDebugVisualOn() || prefs.touchDebug,
    (v) => { prefs.touchDebug = v; persistPrefs(); setTouchDebugVisual(v); },
    "Red dot = your raw touch point. Blue dot = where the app actually rendered a probe there. " +
    "A mismatch is the iOS touch-coordinate bug. Same as adding ?touchdebug to the URL, but sticks across reloads."));
  const diagSnap = getTouchDebugSnapshot();
  const diagWrap = document.createElement("div"); diagWrap.className = "form-row";
  const diagLabel = document.createElement("span"); diagLabel.className = "form-label"; diagLabel.textContent = "Last touch";
  diagWrap.appendChild(diagLabel);
  const diagBox = document.createElement("div"); diagBox.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;";
  const diagPre = document.createElement("pre"); diagPre.className = "debug-diag";
  diagPre.textContent = formatTouchDebugSnapshot(diagSnap);
  const diagActions = document.createElement("div"); diagActions.className = "form-actions";
  const copyBtn = ghostBtn("Copy", () => {
    navigator.clipboard?.writeText(formatTouchDebugSnapshot(getTouchDebugSnapshot())).then(
      () => { copyBtn.textContent = "Copied ✓"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200); },
      () => {},
    );
  });
  if (!diagSnap) copyBtn.disabled = true;
  diagActions.appendChild(copyBtn);
  diagActions.appendChild(ghostBtn("Refresh", () => { if (appSettingsOpen) openAppSettings(); }));
  diagBox.appendChild(diagPre); diagBox.appendChild(diagActions);
  diagWrap.appendChild(diagBox);
  root.appendChild(diagWrap);

  root.appendChild(sectionTitle("About"));
  const about = document.createElement("div"); about.className = "about-block";
  const verStr = versionInfo.commit ? `v${versionInfo.version} · ${versionInfo.commit}${versionInfo.branch ? " (" + versionInfo.branch + ")" : ""}` : `v${versionInfo.version}`;
  about.innerHTML =
    `<div class="about-name">hector-vector <span class="about-ver"></span></div>`
    + `<div class="about-line">A local, browser-based SVG vector editor + image→vector pipeline.</div>`
    + `<div class="about-line">Runs against your local server; works offline as an installed app.</div>`;
  about.querySelector(".about-ver").textContent = verStr;
  root.appendChild(about);
  loadVersion().then(() => { if (appSettingsOpen) { const el = about.querySelector(".about-ver"); if (el) el.textContent = versionInfo.commit ? `v${versionInfo.version} · ${versionInfo.commit}${versionInfo.branch ? " (" + versionInfo.branch + ")" : ""}` : `v${versionInfo.version}`; } });

  const actions = document.createElement("div"); actions.className = "form-actions";
  actions.appendChild(ghostBtn("Close", () => closeModal()));
  root.appendChild(actions);

  modalBodyEl.innerHTML = ""; modalBodyEl.appendChild(root);
  // Deep-link: when opened from a stage that needs a missing tool, scroll to + briefly
  // highlight the tools section so the user lands exactly where they install it.
  if (opts.focus === "tools" && toolsTitle) {
    setTimeout(() => {
      try {
        toolsTitle.scrollIntoView({ block: "start", behavior: "smooth" });
        toolsTitle.classList.add("settings-focus");
        setTimeout(() => toolsTitle.classList.remove("settings-focus"), 1500);
      } catch {}
    }, 30);
  }
}
