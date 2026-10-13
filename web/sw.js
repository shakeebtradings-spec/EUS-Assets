// Offline-first service worker: the whole app (including the scanner and barcode libraries) is cached on the device.
const CACHE = "eus-assets-v2";
const SHELL = ["./", "index.html", "app.js", "style.css", "config.js", "manifest.json", "icon.svg",
  "vendor/supabase.js", "vendor/html5-qrcode.min.js", "vendor/jsbarcode.min.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// Cache-first with a background refresh: opens instantly with no signal, and picks up updates on the next open.
// Data requests (Supabase) and the separate Workstations app are never handled here.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/workstations/")) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (e.request.mode === "navigate" ? c.match("index.html") : Response.error());
  }));
});
