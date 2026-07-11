// "Customize bars" — the checklist that makes the toolbars customizable WITHOUT dragging.
//
// This exists because dragging is the wrong instrument on a phone. The bars sit at opposite ends of
// a 390px screen; the action bar lives inside the bottom sheet, which COVERS the tool strip when
// it's open; and both ends scroll horizontally. Dragging a tile from one to another would need a
// sheet auto-open dance plus cross-container auto-scroll. A list with checkboxes does the same job
// in one tap, is accessible, and works identically on a desktop.
//
// It's also the recovery path: if you hide something you needed, this is always reachable from
// Settings, which lives in the header menu and is never itself customizable.
import { sectionTitle } from "./widgets.js";
import { ghostBtn } from "../editor.js";

let openModal, closeModal, modalSearchEl, modalBodyEl, getLayout, setStatus;
export function configureLayoutPicker(deps) {
  ({ openModal, closeModal, modalSearchEl, modalBodyEl, getLayout, setStatus } = deps);
}

// Human labels straight off the existing title attributes — no markup changes needed.
// "Pen — click to add points (P)" -> "Pen";  "Bring to front (Ctrl/Cmd+Shift+])" -> "Bring to front".
const labelOf = (el) => ((el.title || "").split(/[—(]/)[0].trim()) || (el.textContent || "").trim() || "—";

const BAR_TITLES = {
  tools: "Tools", quick: "Quick bar", arrange: "Selection bar",
  actions: "Object actions", viewport: "View controls",
};
const BAR_HINTS = {
  quick: "Always visible, above the canvas.",
  arrange: "Only appears while something is selected.",
  actions: "In the Panels sheet on a phone.",
  viewport: "In the Panels sheet on a phone.",
};
const barTitle = (name) => BAR_TITLES[name] || (name.startsWith("hdr-") ? `${name.slice(4)} panel header` : name);

// The bars the adaptive engine rearranges by selection (see src/ui/adaptive.js). Only these get a
// pin control — anchoring a TOOL would be meaningless, since nothing ever moves or hides one.
const ADAPTIVE_BARS = new Set(["arrange", "actions"]);

export function openLayoutPicker() {
  const L = getLayout && getLayout();
  if (!L) return;
  // The modal is z-index 50 and the phone sheet is z-index 60, so an open sheet would render right
  // on top of this. Close it first.
  document.querySelector("main.app")?.classList.remove("sheet-open");

  openModal("Customize bars", true);
  if (modalSearchEl) modalSearchEl.hidden = true;
  const root = document.createElement("div");
  root.className = "form";
  const rerender = () => { modalBodyEl.innerHTML = ""; build(); modalBodyEl.appendChild(root); };

  function build() {
    root.innerHTML = "";
    const bars = L.listBars();
    const targets = bars.map((b) => [b.name, barTitle(b.name)]);

    for (const bar of bars) {
      if (!bar.tiles.length && bar.name.startsWith("hdr-")) continue;   // empty panel header: nothing to show
      const head = sectionTitle(barTitle(bar.name));
      // Live overflow readout, so you can watch the strip stop overflowing as you untick things —
      // this is the whole point of the feature on a phone.
      const over = bar.el.scrollWidth - bar.el.clientWidth;
      if (over > 1) {
        const tag = document.createElement("span");
        tag.className = "form-hint picker-over";
        tag.textContent = `${over}px doesn't fit — untick to trim`;
        head.appendChild(tag);
      }
      root.appendChild(head);
      if (BAR_HINTS[bar.name]) {
        const h = document.createElement("div"); h.className = "form-hint"; h.textContent = BAR_HINTS[bar.name];
        root.appendChild(h);
      }

      bar.tiles.forEach((tile, i) => {
        const row = document.createElement("div");
        row.className = "picker-row";
        row.dataset.key = tile.key;

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !tile.hidden;
        box.disabled = tile.alwaysOn;
        box.title = tile.alwaysOn ? "Always shown" : (tile.hidden ? "Show" : "Hide");
        box.addEventListener("change", () => { L.setHidden(tile.key, !box.checked); rerender(); });
        row.appendChild(box);

        const glyph = document.createElement("span");
        glyph.className = "picker-glyph";
        glyph.textContent = (tile.el.textContent || "").trim();
        row.appendChild(glyph);

        const name = document.createElement("span");
        name.className = "picker-name";
        name.textContent = labelOf(tile.el) + (tile.alwaysOn ? " (always on)" : "");
        row.appendChild(name);

        const nudge = (delta) => { L.move(tile.key, bar.name, i + delta); rerender(); };
        const up = ghostBtn("↑", () => nudge(-1)); up.disabled = i === 0; up.title = "Move up";
        const dn = ghostBtn("↓", () => nudge(+2));   // +2: the index skips over the tile's own slot
        dn.disabled = i === bar.tiles.length - 1; dn.title = "Move down";
        up.classList.add("picker-nudge"); dn.classList.add("picker-nudge");
        row.appendChild(up); row.appendChild(dn);

        // Anchor. Only meaningful on the bars the engine actually rearranges — pinning a TOOL is
        // meaningless, because nothing would ever move or hide it.
        if (ADAPTIVE_BARS.has(bar.name)) {
          const pin = ghostBtn(tile.pinned ? "📌" : "📍", () => { L.setPinned(tile.key, !tile.pinned); rerender(); });
          pin.classList.add("picker-nudge", "picker-pin");
          pin.classList.toggle("on", !!tile.pinned);
          pin.title = tile.pinned ? "Anchored — always shown, never reordered. Tap to release." : "Anchor this button in place";
          row.appendChild(pin);
        }

        // Cross-bar moves live here rather than in a drag — see the note at the top of the file.
        const to = document.createElement("select");
        to.className = "picker-move";
        to.title = "Move to another bar";
        for (const [val, text] of targets) {
          const o = document.createElement("option");
          o.value = val; o.textContent = text; o.selected = val === bar.name;
          to.appendChild(o);
        }
        to.addEventListener("change", () => { L.move(tile.key, to.value); rerender(); });
        row.appendChild(to);

        root.appendChild(row);
      });
    }

    const foot = document.createElement("div");
    foot.className = "picker-foot";
    foot.appendChild(ghostBtn(`Reset ${L.mode() === "phone" ? "phone" : "desktop"} bars`, () => {
      L.reset(); rerender();
    }));
    foot.appendChild(ghostBtn("Save as profile…", () => L.saveProfilePrompt()));
    const done = ghostBtn("Done", () => closeModal());
    done.classList.add("primary");
    foot.appendChild(done);
    root.appendChild(foot);

    const note = document.createElement("div");
    note.className = "form-hint";
    note.textContent = "Hiding a button only trims the bar — its keyboard shortcut keeps working. "
      + "The selection and object bars rearrange themselves to show what you can actually do right now; "
      + "anchor (📌) any button you want held in place. Phone and desktop keep separate layouts.";
    root.appendChild(note);
  }

  build();
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);
  if (setStatus) setStatus("Customize bars: tick to show, untick to hide. Saves as you go.", 4000);
}
