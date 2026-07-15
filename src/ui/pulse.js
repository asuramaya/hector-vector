// A suggestion is a TRANSITION, not a state.
//
// src/ui/suggest.js used to say this a second way: a whole block of rows, each pairing a copy of a
// button's label with a "Do it" button that is, itself, a button — a third copy of controls that
// already exist twice (a toolbar tile, an Actions-menu row). The operator and a prior session argued
// this out and the ruling stuck: don't build a second surface, light up the FIRST one. The oracle
// (src/ui/actions.js) already recomputes every action's validity on every selection change; the news
// was never "here is what's valid now", it was "here is what JUST became valid that wasn't a moment
// ago" — a diff, not a list.
//
// This module NEVER reorders anything (that's adaptive.js's job, and still forbidden for the tools
// bar) and never adds a control that doesn't already exist. It adds one class, to a button that was
// already there, for a few seconds, and then takes it back off.
import { evaluate } from "./actions.js";
import { isTouchShell } from "./formfactor.js";

const CAP = 3;          // past this it reads as noise, not news
export const PULSE_MS = 2200;   // must match the CSS animation's duration (web/style.css .hl-pulse)

let getPref = () => "off";
export function configurePulse(deps) { ({ getPref } = deps); }
// The phone is fully adaptive regardless of the desktop preference (see adaptive.js's modeNow) — same
// call here: no muscle memory to protect there, and screen space is scarce enough that the news
// matters more, not less.
const on = () => isTouchShell() || (getPref() || "off") !== "off";

let prevValid = null;   // null until the first real call — nothing pulses before there's a "before"
const timers = new Map();

function pulseTile(key) {
  const el = document.querySelector(key);
  if (!el) return;
  clearTimeout(timers.get(key));
  el.classList.remove("hl-pulse");
  void el.offsetWidth;   // force reflow so a re-trigger restarts the animation instead of no-op-ing
  el.classList.add("hl-pulse");
  timers.set(key, setTimeout(() => el.classList.remove("hl-pulse"), PULSE_MS));
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// facts -> a sentence for the teaching strip, or null if there's nothing worth pulsing. Called on
// every selection change (src/app.js's refreshActionButtons, right beside syncAdaptive — same facts,
// same moment). Always advances its own baseline, even when `on()` is false, so flipping the pref
// back on doesn't replay stale history as if it just happened.
export function syncPulse(facts) {
  const st = facts ? evaluate(facts) : new Map();
  const prev = prevValid;
  prevValid = st;
  if (!on() || !prev || !facts) return null;

  const fresh = [];
  for (const [key, s] of st) {
    if (s.noisy || !s.valid) continue;
    const was = prev.get(key);
    if (was && was.valid) continue;   // already valid a moment ago — not news
    fresh.push({ key, label: s.label, why: s.why });
  }
  if (!fresh.length) return null;

  const chosen = fresh.slice(0, CAP);
  for (const f of chosen) pulseTile(f.key);
  // The test for whether a suggestion earns its pixels: would a competent user be surprised by it?
  // One newly-possible action gets to say WHY ("Unite — merge the shapes into one"); several at once
  // would make for a run-on sentence, so they just get named.
  return chosen.length === 1
    ? `${chosen[0].label} just became possible — ${lowerFirst(chosen[0].why)}.`
    : `${chosen.map((f) => f.label).join(", ")} just became possible.`;
}
