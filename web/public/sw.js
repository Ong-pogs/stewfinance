/*
 * StewFi service worker — minimal, install-only PWA shell.
 *
 * Goals (deliberately conservative):
 *   - Make the app installable + give a basic offline shell.
 *   - NEVER cache on-chain / API responses (prices, pool reads, draws, faucet,
 *     tracking) — those must always be fresh, so anything under /api/* and all
 *     non-GET requests bypass the SW entirely.
 *   - Navigations are network-first (always try the live page; only fall back to
 *     the cached shell when truly offline) so users never see a stale app.
 *
 * Registered only in production from components/register-sw.tsx.
 */

const CACHE = "stewfi-shell-v1";

// The minimal shell to pre-cache. Keep tiny: the install target page + the
// generated app icon. Next's hashed build assets are cached lazily on demand.
const SHELL = ["/app", "/icon"];

self.addEventListener("install", (event) => {
  // Take over as soon as installed (paired with clients.claim on activate).
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Best-effort: don't fail the whole install if one URL 404s.
      cache.addAll(SHELL).catch(() => undefined),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Cross-origin (RPC, wallet, Supabase, OG
  // crawlers) and any write request go straight to the network, untouched.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Never cache dynamic data: API routes + the dynamically generated OG image.
  // These must always hit the network so on-chain / tracking data stays fresh.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Navigations (HTML pages): network-first, fall back to cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(
        () =>
          caches.match(req).then((hit) => hit || caches.match("/app")) ||
          Response.error(),
      ),
    );
    return;
  }

  // Static assets (Next's hashed JS/CSS/fonts, generated icons): cache-first,
  // populate lazily. Hashed filenames make stale-cache risk negligible.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Only cache successful, basic (same-origin) responses.
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});
