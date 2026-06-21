// Sky Glider service worker — network-first so updates always win, with a
// cached app shell for offline play. (Network-first avoids the stale-cache
// trap where an old worker keeps serving a previous build's game.js.)
const CACHE = "skyglider-3d-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./game.js",
  "./mp.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./vendor/babylon.js",
  "./vendor/HavokPhysics_umd.js",
  "./vendor/HavokPhysics.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(ASSETS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Network-first: always try the live network, fall back to cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(
          (cached) => cached || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
      )
  );
});
