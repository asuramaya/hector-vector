// Minimal service worker. Its only job is to make hector-vector installable as
// a PWA (which unlocks the borderless Window-Controls-Overlay window). It does
// NOT cache: the editor needs the live local server, so every request goes to
// the network as usual. Keeping a fetch listener present satisfies the install
// criteria without taking ownership of responses.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* passthrough — default network handling */ });
