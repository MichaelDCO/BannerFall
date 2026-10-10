// Bannerfall service worker — offline-capable PWA cache.
// AUDIT-1 PERF-3 — three strategies, two caches:
//   · STAMPED shell files (`?v=<sha>`, stamped by pages.yml): CACHE-FIRST. The URL itself changes on
//     every deploy, so a cached copy can never be stale, and the 3.4 MB game.js stops crossing the
//     network on every launch (it used to be refetched with `no-store`).
//   · navigations / index.html / manifest / icons, and the UNSTAMPED `?v=__BUILD__` local-dev URLs:
//     NETWORK-FIRST with `cache: 'no-cache'` (an ETag/Last-Modified revalidation, usually a 304),
//     raced against a 3 s timeout that falls back to the cached copy — a lie-fi connection no
//     longer hangs the boot.
//   · IMMUTABLE payload — the pinned vendor bundles (three@0.170.0, trystero@0.25.4) and the baked
//     detail tiles: CACHE-FIRST from their own cache, which is NOT wiped by a deploy. Its name is
//     stamped by pages.yml with a hash of that payload (`__IMM__`), so it turns over exactly when
//     a vendor file or a tile changes, and only then.
const VERSION = 'bannerfall-__BUILD__';
const IMM = 'bannerfall-imm-__IMM__';
const SHELL = [
  './', 'index.html', 'css/main.css?v=__BUILD__', 'js/game.js?v=__BUILD__',
  // GAME_SPEC_9 A - the co-op lobby module. Shell, not vendor: it carries the `?v=` stamp
  // because it is ours and it changes when we change it.
  // GAME_SPEC_9 §B - the lockstep transport. Shell for the same reason as lobby.js: ours, and
  // it changes when we change it, so it carries the `?v=` stamp rather than riding VENDOR.
  'js/lobby.js?v=__BUILD__', 'js/net.js?v=__BUILD__', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];
const VENDOR = [
  'js/vendor/three.module.js',
  'js/vendor/addons/postprocessing/EffectComposer.js',
  'js/vendor/addons/postprocessing/RenderPass.js',
  'js/vendor/addons/postprocessing/UnrealBloomPass.js',
  'js/vendor/addons/postprocessing/ShaderPass.js',
  'js/vendor/addons/postprocessing/MaskPass.js',
  'js/vendor/addons/postprocessing/Pass.js',
  'js/vendor/addons/shaders/CopyShader.js',
  'js/vendor/addons/shaders/LuminosityHighPassShader.js',
  // GAME_SPEC_9 §A — the co-op netlib (Trystero, Nostr strategy), vendored and pinned exactly
  // like three above. Precached with the rest of VENDOR rather than fetched on demand: co-op
  // is the one feature that is useless without the network, so the ONE moment it must not be
  // waiting on a download is the moment a player clicks CO-OP. It is never IMPORTED on the
  // solo path (no modulepreload hint for it, and game.js only reaches for "trystero" when a
  // session is actually being created or joined), so precaching costs a boot fetch and zero
  // parse/execute — the solo code path is byte-for-byte what it was.
  'js/vendor/trystero-nostr.min.js',
];
// GAME_SPEC_10 §B — the baked tri-planar detail tiles. Listed bare, exactly like VENDOR and
// unlike SHELL: their content is immutable by construction (seeded bake), so they ride the
// IMM cache, whose stamped name changes only when this payload does.
const TEXTURES = [
  'textures/rock_strata_a.png', 'textures/rock_strata_n.png',
  'textures/granite_a.png', 'textures/granite_n.png',
  'textures/grass_a.png', 'textures/grass_n.png',
  'textures/snow_a.png', 'textures/snow_n.png',
  'textures/sand_a.png', 'textures/sand_n.png',
  'textures/road_dirt_a.png', 'textures/road_dirt_n.png',
  'textures/moor_heath_a.png', 'textures/moor_heath_n.png',
];
const NET_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    // The unstamped shell entries (the page, manifest, icons) are fetched fresh — `reload` skips
    // the HTTP cache, so index.html cannot be a 10-minute-old Pages copy pointing at the previous
    // build's stamps. A stamped URL is immutable by construction, so the copy the page has just
    // loaded is taken from the HTTP cache instead of crossing the network a second time.
    caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => (u.includes('?v=') ? u : new Request(u, { cache: 'reload' }))))),
    // The immutable set: only what this IMM cache does not already hold — a deploy that changed
    // no vendor file and no tile downloads none of the ~3.6 MB again.
    caches.open(IMM).then((c) => Promise.all([...VENDOR, ...TEXTURES].map((u) =>
      c.match(u).then((hit) => hit || c.add(u))))),
  ]).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMM).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const put = (name, req, r) => {
  if (r && r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(name).then((c) => c.put(req, copy)); }
  return r;
};
const cacheFirst = (req, name) => caches.match(req).then((hit) => hit || fetch(req).then((r) => put(name, req, r)));
function networkFirst(req, url) {
  const opts = { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') };
  return new Promise((resolve, reject) => {
    let done = false;
    const fromCache = () => caches.match(req, opts);
    const timer = setTimeout(() => fromCache().then((hit) => {
      if (hit && !done) { done = true; resolve(hit); }
    }), NET_TIMEOUT);
    fetch(req, { cache: 'no-cache' }).then((r) => {
      put(VERSION, req, r);
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    }, (err) => {
      clearTimeout(timer);
      fromCache().then((hit) => {
        if (done) return;
        done = true;
        if (hit) resolve(hit); else reject(err);
      });
    });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.includes('/js/vendor/') || url.pathname.includes('/textures/')) {
    e.respondWith(cacheFirst(e.request, IMM));
    return;
  }
  const v = url.searchParams.get('v');
  // `'__BUILD_' + '_'` so pages.yml's stamp (a global replace of the token) cannot rewrite the
  // test itself: an unstamped local tree must stay network-first, or a dev reload would serve
  // yesterday's game.js.
  if (v && v !== '__BUILD_' + '_') {
    e.respondWith(cacheFirst(e.request, VERSION));
    return;
  }
  e.respondWith(networkFirst(e.request, url));
});
