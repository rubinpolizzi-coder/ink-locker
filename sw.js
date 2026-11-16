/* Ink Locker service worker: app works offline; card pictures are kept after you've seen them once. */
const SHELL = "ink-locker-shell-v1";
const IMAGES = "ink-locker-images-v1";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== IMAGES).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // card pictures: use the saved copy if there is one
  if (url.hostname.endsWith("lorcast.io")) {
    e.respondWith(caches.open(IMAGES).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const res = await fetch(e.request); if (res.ok || res.type === "opaque") c.put(e.request, res.clone()); return res;
    }));
    return;
  }
  // card list API: always ask the network (the app stores its own copy)
  if (url.hostname.startsWith("api.")) return;
  // app files: network first so updates arrive, saved copy when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
  }
});
