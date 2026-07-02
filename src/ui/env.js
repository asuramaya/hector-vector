// Deploy-target flag. `CLOUD` is true in the serverless cloud build (static hosting, no Python
// backend): the vector editor runs fully in the browser, while the Processor pipeline, disk
// Library, batch Jobs, and server font/shaping proxy are gated off behind a "download the desktop
// app" CTA. Set by the cloud index.html (`window.__HV_CLOUD__ = true`) or via `?cloud` for testing
// against a normal server. This is a dependency-free leaf — safe to import from anywhere,
// including the low-level api() client.
export const CLOUD = typeof window !== "undefined" && (() => {
  const q = new URLSearchParams(window.location.search);
  if (q.has("nocloud")) return false;              // force the full app (e.g. testing on a cloud host)
  if (q.has("cloud")) return true;                 // force the cloud build (e.g. testing against a local server)
  return window.__HV_CLOUD__ === true;             // set by index.html's host auto-detect
})();
if (CLOUD && typeof document !== "undefined") document.documentElement.classList.add("cloud");
