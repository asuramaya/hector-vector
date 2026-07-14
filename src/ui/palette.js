// The command palette: type what you want, in the words you'd use.
//
// This app has well over a hundred commands and exactly two ways to reach any of them — find its
// rune on a toolbar, or find its row in a menu. Both require you to already know where it lives, and
// the toolbars are runes. So the honest state of things is: if you don't know hector-vector, you
// cannot find anything in hector-vector, and no amount of rearranging glyphs fixes that. A newcomer
// does not think "I want Pathfinder ▸ Minus Back". They think "I want to cut a hole in this".
//
// So: one box, and you type at it. It searches the LABEL and the WHY together, which is the whole
// trick — "hole" finds Subtract, because Subtract's reason for existing is "cut the front shape out
// of the back", even though the word "hole" appears nowhere in its name.
//
// It enumerates the live registry (src/ui/actions.js) rather than a hand-kept list, so it cannot
// drift out of date: a tool added to the toolbar is in the palette the moment it has a sentence, and
// one that has no sentence is visibly missing rather than quietly absent.
//
// UNAVAILABLE COMMANDS ARE STILL LISTED, greyed, and say why. This is deliberate and it is the
// opposite of what a toolbar does. A greyed-out button teaches you nothing — you cannot even find
// it to wonder about it. A palette that hid everything you can't currently do would only ever show
// you what you already know how to reach; the entire value of searching "hole" while nothing is
// selected is being told that Subtract exists, and that it wants two overlapping shapes.
import { openModal, closeModal } from "./modal.js";
import { selectionFacts, everyTile, rankFor, findWords } from "./actions.js";

let modalSearchEl, modalBodyEl, modalRootEl, editor;
export function configurePalette(deps) {
  ({ modalSearchEl, modalBodyEl, modalRootEl, editor } = deps);
}

export const isPaletteOpen = () => !modalRootEl.hidden && modalBodyEl.firstChild
  && modalBodyEl.firstChild.classList && modalBodyEl.firstChild.classList.contains("palette");

// Every command, from the registry plus whatever the current selection can do.
function commands() {
  const f = selectionFacts(editor);
  const list = everyTile(f).map((t) => ({
    label: t.label,
    why: t.why,
    find: t.find,          // the newcomer vocabulary — without it "hole" never reaches Subtract
    available: t.available,
    run: () => t.el.click(),
  }));
  // The object verbs (Expand, Outline stroke, Pathfinder…) are computed from the selection and have
  // no tile at all — they live only in the Actions menu. They are commands like any other, and they
  // are precisely the ones somebody would search for without knowing they exist. rankFor() already
  // derives them from editor._objectActions with their reasons attached; read that rather than grow
  // a second path that can disagree with it.
  for (const v of rankFor(f).verbs) {
    list.push({ label: v.label, why: v.why, find: findWords(null, v.label), available: true, run: v.run });
  }
  return list;
}

// A typed word matches if some word in the haystack STARTS with it. Not `includes`.
//
// This is not fussiness. With a plain substring test the very first thing I typed, "hole", returned
// *Fit to view* — because "fit the w-HOLE canvas on screen" contains it — and did not return
// Subtract at all. Matching mid-word is how a search engine finds nonsense confidently: the shorter
// the query, the more garbage it drags in, and short queries are exactly what a beginner types.
const words = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
const hits = (hay, w) => hay.some((h) => h.startsWith(w));

// Search the name, the reason, AND the newcomer vocabulary (actions.js FIND) as one pool, so "hole"
// finds Subtract even though neither its name nor its description contains that word.
function search(list, q) {
  const qs = words(q);
  if (!qs.length) return list.slice();
  const scored = [];
  for (const c of list) {
    const label = words(c.label);
    const rest = [...words(c.why), ...words(c.find)];
    const hay = [...label, ...rest];
    if (!qs.every((w) => hits(hay, w))) continue;
    let score = 0;
    if (qs.every((w) => hits(label, w))) score += 10;                 // it's in the NAME
    if (label.length && label[0].startsWith(qs[0])) score += 5;       // ...and it opens the name
    if (c.available) score += 2;                                      // you can do it right now
    score -= Math.min(c.label.length / 20, 2);                        // tie-break toward the plainer name
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}

export function openPalette() {
  openModal("Commands", true);
  const all = commands();
  modalSearchEl.hidden = false;
  modalSearchEl.placeholder = "What do you want to do?";

  const root = document.createElement("div");
  root.className = "palette";
  const list = document.createElement("div");
  list.className = "palette-list";
  root.appendChild(list);
  const empty = document.createElement("p");
  empty.className = "form-hint";
  root.appendChild(empty);
  modalBodyEl.innerHTML = "";
  modalBodyEl.appendChild(root);

  let hits = [], active = 0;

  const render = () => {
    list.innerHTML = "";
    empty.textContent = hits.length ? "" : "Nothing matches that. Try plainer words — the search reads what each command is FOR, not just its name.";
    hits.forEach((c, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "palette-row" + (i === active ? " on" : "") + (c.available ? "" : " unavailable");
      const name = document.createElement("span");
      name.className = "palette-label";
      name.textContent = c.label;
      const why = document.createElement("span");
      why.className = "palette-why";
      why.textContent = c.available ? (c.why || "") : `${c.why || ""} (not available right now)`;
      row.appendChild(name);
      row.appendChild(why);
      // Mousedown, not click: the search box has focus, and a click would blur it first.
      row.addEventListener("mousedown", (e) => { e.preventDefault(); fire(c); });
      list.appendChild(row);
    });
    const on = list.children[active];
    if (on) on.scrollIntoView({ block: "nearest" });
  };

  const fire = (c) => {
    if (!c) return;
    // An unavailable command still EXPLAINS itself when you pick it, rather than doing nothing and
    // leaving you to guess. "Nothing happened" is the worst answer a UI can give.
    if (!c.available) {
      empty.textContent = `${c.label} needs something else selected first. ${c.why}.`;
      return;
    }
    closeModal();
    c.run();
  };

  const refilter = () => {
    hits = search(all, modalSearchEl.value.trim());
    active = 0;
    render();
  };

  modalSearchEl.oninput = refilter;
  modalSearchEl.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, hits.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); fire(hits[active]); }
    else if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    e.stopPropagation();   // the app's global keymap must not see the letters you're typing
  };
  refilter();
}
