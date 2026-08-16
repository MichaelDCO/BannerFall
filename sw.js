// Bannerfall service worker — offline-capable PWA cache.
// Strategy: network-first for app shell/code (always fresh online, cache fallback offline);
// cache-first for the pinned vendor bundle (immutable at three@0.170.0).
const VERSION = 'bannerfall-__BUILD__';
const SHELL = [
  './', 'index.html', 'css/main.css?v=__BUILD__', 'js/game.js?v=__BUILD__', 'manifest.webmanifest',
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
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([...SHELL, ...VENDOR])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const isVendor = url.pathname.includes('/js/vendor/');
  if (isVendor) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
    })));
  } else {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') })));
  }
});
