// Thin JSON-over-HTTP client for the local compute server. Every /api/* call in
// the shell goes through here: it serialises a JSON body when one is given,
// parses the JSON response, and turns a non-2xx (or an unparseable body) into a
// thrown Error carrying the server's `error` message when present.
//
// Extracted from app.js (#26). No app/DOM/editor dependencies — pure fetch.
export async function api(url, method = "GET", payload) {
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
