// Cloudflare Pages Function — host-based root routing, no build step, one deployment.
//
// One Pages project (hector-vector) answers three custom domains: hector-vector.com,
// www.hector-vector.com, and app.hector-vector.com, plus *.pages.dev previews. All of them
// serve the exact same static bundle; only what "/" resolves to differs:
//   - app.hector-vector.com and *.pages.dev  -> app.html   (the editor itself)
//   - everything else (hector-vector.com, www.)  -> index.html (the marketing/landing page)
// This is a REWRITE (env.ASSETS.fetch on a modified URL), not a redirect — the address bar
// still shows "/". Every other path (/download, /style.css, /src/*, /assets/*) is identical
// on every domain and falls through to next() untouched.
export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/") {
    const host = url.hostname;
    const isApp = host === "app.hector-vector.com" || /\.pages\.dev$/.test(host);
    if (isApp) {
      // Pages' static-asset server 308-redirects /app.html -> /app (its "clean URLs" extension
      // strip) instead of serving it, so fetch the clean path directly rather than the .html one.
      url.pathname = "/app";
      return env.ASSETS.fetch(new Request(url, request));
    }
  }

  return next();
}
