// Bump this when you change any cached file so phones pick up the update.
const CACHE_NAME = "barp-v29";
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

// Cache-first for everything, network fallback if it's not cached yet. Sound
// files are fetched via the Web Audio API now (fetch + decodeAudioData), not
// streamed through an <audio> element, so there's no byte-range/seeking
// concern anymore — they're safe to cache like any other static asset, and
// doing so means the buzzer/horn load instantly from disk instead of
// waiting on the network (especially useful on flaky venue wifi).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
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
