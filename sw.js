// Bannerfall service worker — offline-capable PWA cache.
// Strategy: network-first for app shell/code (always fresh online, cache fallback offline);
// cache-first for immutable payload — the pinned vendor bundles (three@0.170.0,
// trystero@0.25.4) and the baked
// detail tiles (seeded bake, content changes only when the tool is re-run under a new seed).
const VERSION = 'bannerfall-__BUILD__';
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
// unlike SHELL: pages.yml stamps `__BUILD__` into index.html and sw.js only, so a `?v=` on
// these would be a cache-buster on content that is immutable by construction. They ride the
// VERSION cache name instead, which already turns over on every deploy.
const TEXTURES = [
  'textures/rock_strata_a.png', 'textures/rock_strata_n.png',
  'textures/granite_a.png', 'textures/granite_n.png',
  'textures/grass_a.png', 'textures/grass_n.png',
  'textures/snow_a.png', 'textures/snow_n.png',
  'textures/sand_a.png', 'textures/sand_n.png',
  'textures/road_dirt_a.png', 'textures/road_dirt_n.png',
  'textures/moor_heath_a.png', 'textures/moor_heath_n.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([...SHELL, ...VENDOR, ...TEXTURES])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const isImmutable = url.pathname.includes('/js/vendor/') || url.pathname.includes('/textures/');
  if (isImmutable) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
    })));
  } else {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') })));
  }
});
