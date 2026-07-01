// Thin JSON-over-HTTP client for the local compute server. Every /api/* call in
// the shell goes through here: it serialises a JSON body when one is given,
// parses the JSON response, and turns a non-2xx (or an unparseable body) into a
// thrown Error carrying the server's `error` message when present.
//
// Extracted from app.js (#26). No app/DOM/editor dependencies — pure fetch.
import { CLOUD } from "./env.js";
export async function api(url, method = "GET", payload) {
  // Cloud build has no backend. Fail fast + clean so a stray server call can't 404-storm the UI
  // into a render loop (the exact class of bug the stale-server incident caused). Editor features
  // route through platform.js adapters; the server-only panels are gated off — this is the net.
  if (CLOUD) throw new Error("This needs the hector-vector desktop app.");
  const res = await fetch(url, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      throw new Error("Unexpected server response.");
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}
