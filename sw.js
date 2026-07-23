// Bump this when you change any cached file so phones pick up the update.
const CACHE_NAME = "barp-v49";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./sounds/start-horn.mp3",
  "./sounds/thirty-seconds.mp3",
  "./sounds/buzzer.mp3"
];
// The app shell changes often during active development — these get
// network-first treatment below so a normal reload actually picks up
// changes instead of serving whatever got cached first.
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Sound files aren't guaranteed to exist (copyrighted FLL audio isn't
      // shipped by default) — add them individually so a missing file
      // doesn't fail the whole install and take the rest of the app offline
      // with it.
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin && APP_SHELL.some((p) => url.pathname.endsWith(p.replace("./", "")) || (p === "./" && (url.pathname === "/" || url.pathname.endsWith("/"))));

  if (isAppShell) {
    // Network-first: always try to get the real current version. Only fall
    // back to the cached copy if there's no connection at all — this is what
    // makes a normal reload actually show new changes, not just a hard
    // reload (which was only ever "fixing" it for that one page load, since
    // the fetch handler kept intercepting every request afterward and
    // serving the same stale cached copy again).
    event.respondWith(
      fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (icons, sound files) rarely changes and benefits from
  // loading instantly off disk rather than waiting on the network.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
