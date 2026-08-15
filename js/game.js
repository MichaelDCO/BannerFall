// ══════════════════════ SECTION: CORE (owner: architect — do not restructure) ══════════════════════
window.__errors = [];
const __err = (m) => { window.__errors.push(String(m)); document.title = 'ERROR'; };
window.onerror = (m, s, l) => __err(m + ' @' + (s||'').split('/').pop() + ':' + l);
window.addEventListener('unhandledrejection', e => __err('promise: ' + e.reason));
const _cerr = console.error.bind(console); console.error = (...a) => { __err(a.join(' ')); _cerr(...a); };

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const P = new URLSearchParams(location.search);
const SHOT = P.get('shot');                       // deterministic screenshot preset name
// A preset may belong to a map other than the Vale. MAP has to be resolved here in CORE,
// long before SHOT_PRESETS exists, so the binding lives in this one small table. `&map=`
// still wins, so any preset can be shot on any map.
const SHOT_MAPS = { overview2: 2, battle2: 2, overview3: 3, battle3: 3, _snow: 2, _ash: 3 };
// WORLD seed. The diorama's prop scatter (`_ws` in WORLD, `_as` in PATH) runs off this and
// nothing else, so the Vale is the same Vale on every run — which is what makes a map a
// place rather than a shuffle. It is a CONSTANT on purpose: it used to read `&seed=`, so a
// seeded run moved every tree and rock as well as the threat mix, and the §G anti-staleness
// sweep could have "passed" purely because the scenery had been reshuffled under it.
const SEED = 1337;
const TPS = 30, TICK = 1 / TPS;                   // fixed simulation rate
let _s = SEED >>> 0;
const rng = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0; let t = Math.imul(_s ^ _s >>> 15, 1 | _s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
// ── RUN SEED (SPEC3 §E) ───────────────────────────────────────────────────────
// Determinism now means "deterministic GIVEN (map, seed)". Entropy is captured EXACTLY
// once, here, at module scope — render-side, before any sim tick, never from Math.random
// or Date.now. `&seed=` names THE RUN and every shot preset pins it, so the harness and the
// balance matrix stay bit-identical; a real play session draws a fresh four-digit war seed.
// It then SEEDS THE SIM (`_s`), which is why a new run rolls a different column jitter.
const runSeed = P.has('seed') ? (parseInt(P.get('seed')) >>> 0)
  : (SHOT || !(globalThis.crypto && crypto.getRandomValues)) ? (SEED >>> 0)
  : (1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
_s = runSeed >>> 0;
// Run-level draws (elite swap slots, omen offers) must NOT consume the sim stream: they
// happen at wave boundaries, and pulling from rng() there would shift every lane jitter
// downstream of a choice the player made. Hash of (runSeed, salt, index) instead — same
// seed, same campaign, whatever the sim did in between.
const srng = (salt, i) => {
  let t = (runSeed ^ Math.imul(salt | 0, 0x9E3779B1) ^ Math.imul(i | 0, 0x85EBCA6B)) >>> 0;
  t = Math.imul(t ^ t >>> 15, 0x2C1B3C6D); t = Math.imul(t ^ t >>> 12, 0x297A2D39);
  return ((t ^ t >>> 15) >>> 0) / 4294967296;
};
const isTouch = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 900;
const tier = P.get('tier') || (SHOT ? 'ultra' : (isTouch ? 'mobile' : 'high'));
const Q = { // quality knobs — sections read these. HOOK: builders may add knobs.
  mobile: { px: 1.5, shadow: 1024, bloom: false, segs: 96,  density: 0.55 },
  high:   { px: 2,   shadow: 2048, bloom: true,  segs: 160, density: 1 },
  ultra:  { px: 2,   shadow: 4096, bloom: true,  segs: 224, density: 1 },
}[tier];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const G = { THREE, rng, srng, runSeed, tier, Q, TPS, TICK };       // shared namespace between sections
// ── MAPS: the campaign is data-driven (SPEC2 §E). Map 1 is the shipped Vale. This table
// carries everything a map is EXCEPT its wave list, which SECTION: SIM owns and attaches
// (`MAP.waves`); SECTION: PATH builds the road spline from `wps`. `&map=` selects.
// ROUTES (SPEC2 §E): a map is a LIST of road splines, not one. Route 0 always runs from a
// spawn gate to the keep. Any further route is a tributary or a branch, described by where
// it leaves and where it lands:
//   from: {route, tag}  — this route is entered FROM that route (tag = enemy.branch value
//                          that takes it; absent `from` = the route owns a spawn gate)
//   to:   route         — where this route hands its walkers back (absent = the keep)
// PATH turns those into per-route arc-length tables plus a handoff list; SIM's movement
// pass consumes them (enemy.pathId). The junction distances are FOUND from the geometry
// (nearest point on the target spline), so a waypoint tweak never desyncs the handoff.
const MAPS = [
  { id: 1, name: 'The Vale', blurb: 'A green valley road. Hold it and the realm holds.',
    interwave: 12, hpRamp: 0.14, palette: null, waves: null, finale: 'THE WARLORD',
    houses: [[-72, 31, 0.55], [-60, 27, 2.35], [-80, 40, -0.35], [-64, 42, 1.15]],
    wps: [[86, -56], [50, -40], [28, -14], [42, 10], [18, 32], [-14, 34], [-38, 18], [-54, -6], [-72, 4], [-92, 18]] },
  // ── 2. FROSTFELL PASS — two gates, one road ──────────────────────────────────
  // Both spawn splines run west and CONVERGE (they arrive on nearly the same bearing), so
  // the junction reads as a fork in a mountain road rather than a head-on collision. The
  // wedge of high ground between the two approaches is the map's whole tactical idea: one
  // tower line there covers both gates, anywhere else covers half a wave.
  { id: 2, name: 'Frostfell Pass', blurb: 'Two gates feed one frozen road. Cover the fork or lose half the wave.',
    interwave: 13, hpRamp: 0.13, waves: null, finale: 'THE FROST MATRIARCH',
    houses: [[-70, -24, 0.5], [-58, -20, 2.3], [-78, -32, -0.3], [-62, -38, 1.1]],
    routes: [
      { wps: [[94, -42], [70, -38], [54, -46], [40, -36], [30, -20], [22, -8], [16, -2],
              [-2, 6], [-20, -2], [-38, -14], [-54, -4], [-70, 10], [-86, 6], [-97, -8]] },
      { to: 0, wps: [[88, 44], [70, 40], [56, 32], [44, 24], [34, 12], [26, 4], [16, -2]] },
    ],
    palette: {
      // snow throws an enormous amount of light back up — this map keeps a fat ambient
      sun: 0xdfe8ff, sunI: 4.90, hemiSky: 0xa8c4e8, hemiGnd: 0x9aa6b2, hemiI: 1.00,
      fill: 0xbfd2e6, fillI: 0.46, haze: 0xc9d8e6, bg: 0xdce7f2, envI: 0.56,
      hazeV: [0.420, 0.470, 0.545],
      skyZen: [0.055, 0.150, 0.400], skyMid: [0.300, 0.470, 0.700], skyHi: [0.660, 0.720, 0.790],
      skyHor: [0.800, 0.845, 0.900], skyLow: [0.620, 0.665, 0.720], sunGlow: [1.0, 0.97, 0.92],
      ibl: ['#2a55a8', '#5d8fd0', '#b6c8de', '#dfe8f4', '#c2cede', '#8b95a2'],
      disc: ['rgba(246,251,255,1)', 'rgba(214,232,255,.55)', 'rgba(196,220,255,0)'],
      bgGrad: ['#8ea4bd', '#a9bccd', '#c3d1dd', '#dee7f0', '#c9d8e6', '#8f9aa6'],
      gDark: [0.0200, 0.0380, 0.0280], gMid: [0.0620, 0.0980, 0.0700], gLit: [0.1300, 0.1700, 0.1350],
      dry0: [0.1300, 0.1280, 0.1000], dry1: [0.3000, 0.3000, 0.2700], bare: [0.1000, 0.0980, 0.0920],
      dirt0: [0.1050, 0.1000, 0.0980], dirt1: [0.3000, 0.3000, 0.3100],
      rockA: [0.0280, 0.0310, 0.0380], rockB: [0.1700, 0.1850, 0.2100],
      rockWarm: [1.10, 1.02, 0.92], rockCool: [0.84, 0.93, 1.16],
      moss: [0.0480, 0.0700, 0.0600], scree: [0.1500, 0.1600, 0.1750],
      snow: 0.96, snowC: [0.700, 0.755, 0.865],
      lowG: [0.60, 0.72, 0.92], lowRiv: [0.120, 0.140, 0.175],
      ridge: [[0.070, 0.086, 0.108], [0.086, 0.104, 0.130], [0.100, 0.116, 0.142]],
      rockK: [0.92, 0.98, 1.14], tuftK: [0.94, 0.92, 0.98],
      blade: [138, 128, 110], bladeW: [40, 30, 20], tuftN: 0.52,
      treeMix: [0.10, 0.26],
      oakD: [0.0180, 0.0260, 0.0230], oakL: [0.1550, 0.1900, 0.1900],
      busD: [0.0170, 0.0230, 0.0225], busL: [0.1450, 0.1720, 0.1780],
      ashD: [0.0220, 0.0300, 0.0290], ashL: [0.1900, 0.2200, 0.2300],
      pinD: [0.0140, 0.0240, 0.0220], pinL: [0.0780, 0.1220, 0.1140],
      weather: { col: [1.85, 1.98, 2.20], fall: 3.1, dx: -1.9, dz: 0.8, size: 1.55, alpha: 1.15, floor: 0.58 },
    } },
  // ── 3. EMBER WASTES — the fork in the road ───────────────────────────────────
  // One gate, but the road splits: half the wave takes the canyon (short, arrives early,
  // arrives ALONE) and half walks the long northern loop. A build that only covers one
  // arm gets flanked by its own timing.
  { id: 3, name: 'Ember Wastes', blurb: 'The road forks. Half the horde takes the canyon — cover both or be flanked.',
    interwave: 13, hpRamp: 0.11, waves: null, finale: 'THE EMBER TWINS',
    houses: [[-70, -16, 0.4], [-58, -13, 2.2], [-79, -23, -0.4], [-63, -28, 1.2]],
    routes: [
      // The two arms run PARALLEL rather than enclosing a fat lens: the strip between them
      // narrows to about 15u at two waists (x≈-26 and x≈16) where a long-range tower
      // covers both roads at once, and swells to 35u in the middle where nothing does.
      // Choosing which waist to fortify is the map.
      { wps: [[96, -40], [78, -26], [62, -40], [48, -28], [36, -40], [24, -34],
              [18, -20], [16, -4], [12, 6], [-2, 8], [-16, 4], [-30, 1], [-40, -2],
              [-56, -8], [-72, 0], [-86, 10], [-96, 6]] },
      { from: { route: 0, tag: 1 }, to: 0,
        wps: [[24, -34], [12, -34], [-2, -28], [-18, -20], [-32, -10], [-40, -2]] },
    ],
    palette: {
      // Ember's problem was never saturation, it was that ground, haze, sky and the red
      // army all sat inside one 20°-wide hue wedge. The ash sky is now cool grey-violet
      // (a burnt sky IS cool — the warmth is in the ground), the hemisphere bounce is
      // violet-slate so shadowed sand gives a cool anchor, and the road bed drops well
      // below the flats in value. The tabard red then has somewhere to sit.
      // Ember is the one map that must NOT run a thin ambient: with a saturated orange key
      // and nothing else, every neutral surface in frame turns the same orange and the map
      // goes monochrome. The violet-slate hemisphere is doing load-bearing work here.
      sun: 0xffb884, sunI: 4.85, hemiSky: 0x8a76b4, hemiGnd: 0x5a4f66, hemiI: 1.22,
      fill: 0x8f9fd4, fillI: 0.62, haze: 0x8b7f9a, bg: 0xb0a6bc, envI: 0.58,
      hazeV: [0.235, 0.205, 0.285],
      skyZen: [0.150, 0.145, 0.270], skyMid: [0.330, 0.300, 0.400], skyHi: [0.520, 0.470, 0.560],
      skyHor: [0.700, 0.560, 0.540], skyLow: [0.430, 0.385, 0.470], sunGlow: [1.0, 0.62, 0.30],
      ibl: ['#463c66', '#6f6486', '#9a90a8', '#f0d3a0', '#a89ab0', '#5d5566'],
      disc: ['rgba(255,232,196,1)', 'rgba(255,176,110,.55)', 'rgba(255,140,70,0)'],
      bgGrad: ['#5a5170', '#7d7590', '#9b93a8', '#c2b2ae', '#8b7f9a', '#5f566b'],
      gDark: [0.0225, 0.0195, 0.0265], gMid: [0.0620, 0.0555, 0.0540], gLit: [0.1320, 0.1200, 0.1020],
      dry0: [0.0520, 0.0400, 0.0300], dry1: [0.3100, 0.2200, 0.1050], bare: [0.1150, 0.0820, 0.0520],
      dirt0: [0.0790, 0.0590, 0.0490], dirt1: [0.1560, 0.1250, 0.1030],
      // Rock is authored COOL on this map so it reads grey-violet under the orange key —
      // warm rock on warm sand was the single biggest contributor to the monochrome read.
      rockA: [0.0270, 0.0290, 0.0330], rockB: [0.1500, 0.1580, 0.1760],
      rockWarm: [1.06, 1.00, 0.92], rockCool: [0.80, 0.88, 1.14],
      moss: [0.0540, 0.0580, 0.0470], scree: [0.1300, 0.1220, 0.1180],
      lowG: [1.10, 0.82, 0.52], lowRiv: [0.145, 0.120, 0.110],
      ridge: [[0.062, 0.050, 0.052], [0.080, 0.064, 0.062], [0.098, 0.080, 0.076]],
      rockK: [0.80, 0.88, 1.10], tuftK: [1.05, 0.92, 0.72],
      blade: [118, 100, 74], bladeW: [52, 20, 2], tuftN: 0.46,
      // Weighted hard toward dark olive conifers (58%, was 26%): a wood of bright orange
      // autumn canopies sat in exactly the same hue wedge as the sand AND the enemy
      // tabard, so the horde had nowhere to read. The remaining broadleaves go deep
      // rust-brown rather than pumpkin.
      treeMix: [0.20, 0.42],
      oakD: [0.0280, 0.0140, 0.0080], oakL: [0.1400, 0.0620, 0.0280],
      busD: [0.0290, 0.0190, 0.0110], busL: [0.1420, 0.0980, 0.0520],
      ashD: [0.0330, 0.0190, 0.0090], ashL: [0.1750, 0.0980, 0.0460],
      pinD: [0.0165, 0.0205, 0.0135], pinL: [0.0720, 0.0880, 0.0520],
      weather: { col: [1.30, 0.92, 0.70], fall: 1.15, dx: -2.6, dz: 1.1, size: 1.25, alpha: 0.95, floor: 0.52 },
    } },
];
const MAP = MAPS[clamp((parseInt(P.get('map') || '') || SHOT_MAPS[SHOT] || 1) - 1, 0, MAPS.length - 1)];
G.MAPS = MAPS; G.MAP = MAP;
// ══════════════════════ END SECTION: CORE ══════════════════════

// ══════════════════════ SECTION: WORLD (owner: WORLD builder) ══════════════════════
// Sculpted diorama: heightfield meadow + carved road bed + granite cliff ring, splat-blended
// in a patched MeshStandardMaterial (fully lit & shadow-receiving). The heightfield has to
// carve the road spline and flatten build pads, so the heavy construction lives in
// World.build(), which SECTION: PATH invokes once the road spline exists.
// Public: G.scene, G.sun, G.groundY(x,z), G.groundNormal(x,z,out), G.roadSD(x,z), G.World.
const scene = new THREE.Scene();
// ── PALETTE (SPEC2 §E) ───────────────────────────────────────────────────────
// Every colour decision in this section reads from WPAL. WPAL_BASE holds the exact values
// the Vale shipped with, so map 1 renders byte-for-byte what it always did; a map's
// `palette` object in CORE's MAPS table overrides only what it wants to change.
const WPAL_BASE = {
  // Golden hour needs a warm/cool SPLIT, not just a warm tint: key goes warmer and much
  // stronger, hemisphere + fill go cool and thin, so lit grass and shadowed grass finally
  // separate in hue instead of only in brightness.
  sun: 0xffcf8f, sunI: 6.20, hemiSky: 0x9dc2f0, hemiGnd: 0x8a7a5a, hemiI: 0.50,
  fill: 0x8fa6c6, fillI: 0.20, haze: 0xd9c7a2, bg: 0xe6ddc4, envI: 0.40,
  hazeV: [0.395, 0.360, 0.288],
  skyZen: [0.070, 0.205, 0.500], skyMid: [0.335, 0.520, 0.745], skyHi: [0.700, 0.665, 0.560],
  skyHor: [0.900, 0.755, 0.510], skyLow: [0.700, 0.610, 0.470], sunGlow: [1.0, 0.80, 0.50],
  ibl: ['#2f63b4', '#6ea0d8', '#bcd2e4', '#f0dfbc', '#c9b998', '#7d7460'],
  disc: ['rgba(255,244,214,1)', 'rgba(255,214,150,.55)', 'rgba(255,200,140,0)'],
  bgGrad: ['#93a9c0', '#b3c0c6', '#d0c9b7', '#e4d8bd', '#d9c7a2', '#9c9078'],
  gDark: [0.0195, 0.0570, 0.0125], gMid: [0.0700, 0.1720, 0.0290], gLit: [0.1240, 0.3060, 0.0560],
  dry0: [0.1680, 0.1400, 0.0520], dry1: [0.3700, 0.3080, 0.1120], bare: [0.1200, 0.0930, 0.0580],
  dirt0: [0.1120, 0.0840, 0.0552], dirt1: [0.2620, 0.2080, 0.1370],
  rockA: [0.0290, 0.0295, 0.0300], rockB: [0.1980, 0.1950, 0.1840],
  rockWarm: [1.26, 1.03, 0.76], rockCool: [0.86, 0.93, 1.06],
  moss: [0.0520, 0.1020, 0.0270], scree: [0.1320, 0.1180, 0.0910],
  snow: 0, snowC: [0.62, 0.69, 0.81],
  lowG: [0.92, 1.00, 0.44], lowRiv: [0.150, 0.172, 0.190],
  ridge: [[0.046, 0.058, 0.062], [0.062, 0.074, 0.086], [0.078, 0.088, 0.104]],
  rockK: [1, 1, 1], tuftK: [1, 1, 1],
  blade: [78, 112, 44], bladeW: [68, 18, -12], tuftN: 1,
  treeMix: [0.42, 0.72],
  oakD: [0.0130, 0.0270, 0.0080], oakL: [0.1020, 0.1810, 0.0400],
  busD: [0.0140, 0.0270, 0.0080], busL: [0.0900, 0.1520, 0.0400],
  ashD: [0.0190, 0.0370, 0.0110], ashL: [0.1400, 0.2280, 0.0620],
  // conifers used to sit at roughly half the oak's albedo, which rendered them as
  // near-black holes at any distance. Dark, but readable.
  pinD: [0.0125, 0.0255, 0.0140], pinL: [0.0800, 0.1450, 0.0590],
  weather: null,
};
const WPAL = Object.assign({}, WPAL_BASE, MAP.palette || {});
G.WPAL = WPAL; G.weather = WPAL.weather;
const v3s = a => 'vec3(' + a[0] + ',' + a[1] + ',' + a[2] + ')';   // JS colour -> GLSL literal
const C_HAZE = WPAL.haze;                            // golden-hour haze (per map)
scene.background = new THREE.Color(WPAL.bg);
scene.fog = new THREE.Fog(C_HAZE, 168, 520);
G.scene = scene;

const WT = { value: 0 };                            // shared render-only time uniform
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// Dedicated deterministic stream for world scatter — keeps G.rng()'s sim stream untouched
// regardless of quality tier / prop counts.
let _ws = (SEED * 2654435761 + 0x51ed270b) >>> 0;
const wrng = () => { _ws |= 0; _ws = _ws + 0x6D2B79F5 | 0; let t = Math.imul(_ws ^ _ws >>> 15, 1 | _ws); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const wr = (a, b) => a + (b - a) * wrng();

// ── lighting: warm sun raking from screen-left, cool sky fill, faked bounce ──
// Golden hour, not midday. Elevation ~34° (was 48°): shadows roughly double in length and
// finally rake ACROSS the road instead of pooling under everything. The cliff ring does
// then throw a long shadow, which is why the rim's own contribution is kept out of the
// shadow frustum's far plane rather than by raising the sun back up.
const SUN_EL = 34 * Math.PI / 180, SUN_R = 132;
const sun = new THREE.DirectionalLight(WPAL.sun, WPAL.sunI);
// Azimuth from the lower-left of the game camera (SPEC §3). Swinging it further round to
// -x does make shadows rake more laterally, but it also lights the meadow flat-on and the
// terrain loses all its modelling — this bearing keeps the raking.
sun.position.set(-Math.cos(SUN_EL) * SUN_R * 0.857, Math.sin(SUN_EL) * SUN_R, Math.cos(SUN_EL) * SUN_R * 0.514);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
// Tight to the PLAYABLE box, not the whole diorama + cliff ring: the old ±118/±108
// frustum spread the map over 2.3x the area, which is why every shadow was a smear and
// the watchtower's leg lattice was unreadable in its own shadow.
sun.shadow.camera.left = -84; sun.shadow.camera.right = 84;
sun.shadow.camera.top = 62; sun.shadow.camera.bottom = -62;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.045; sun.shadow.radius = 2;
sun.shadow.camera.updateProjectionMatrix();   // ortho frustum was edited after construction
const hemi = new THREE.HemisphereLight(WPAL.hemiSky, WPAL.hemiGnd, WPAL.hemiI);
const fill = new THREE.DirectionalLight(WPAL.fill, WPAL.fillI);   // sky bounce from the shadow side
fill.position.set(84, 30, -58);
scene.add(sun, sun.target, hemi, fill);
G.sun = sun;
const SUNDIR = sun.position.clone().normalize();

// ── procedural gradient sky dome (also feeds the IBL environment) ──
const NOISE_GLSL = `
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x), mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x), f.y); }
float fbm2(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<FB_OCT;i++){ s+=a*vn2(p); p*=2.07; a*=0.5; } return s*FB_NRM; }
float fbm3(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*vn2(p); p*=2.11; a*=0.5; } return s/0.875; }
`.replace('FB_OCT', tier === 'mobile' ? '2' : '4').replace('FB_NRM', tier === 'mobile' ? '1.3333' : '1.0667');
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uSun: { value: SUNDIR } },
  vertexShader: 'varying vec3 vD;\nvoid main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  // NOTE: three's fragment prefix already defines the tonemapping + colorspace helpers for
  // ShaderMaterial — re-including their *_pars chunks redefines the functions (link error).
  fragmentShader: '#include <common>\nvarying vec3 vD;\nuniform vec3 uSun;\n' + NOISE_GLSL + `
void main(){
  vec3 d = normalize(vD); float y = d.y;
  vec3 zen = ` + v3s(WPAL.skyZen) + `;
  vec3 mid = ` + v3s(WPAL.skyMid) + `;
  vec3 hi  = ` + v3s(WPAL.skyHi) + `;             // pale band just above the haze
  vec3 hor = ` + v3s(WPAL.skyHor) + `;            // horizon glow
  vec3 col = mix(mid, zen, smoothstep(0.14,0.90,y));
  // narrow bands: the game camera only ever sees a sliver above the horizon, so the
  // blue has to arrive fast or every low-angle shot is a flat grey wash
  col = mix(hi, col, smoothstep(0.016,0.145,y));
  col = mix(hor, col, smoothstep(-0.010,0.042,y));
  float sd = max(dot(d,uSun),0.0);
  vec3 sg = ` + v3s(WPAL.sunGlow) + `;
  col += sg*pow(sd,240.0)*4.0;
  col += sg*vec3(1.0,0.975,0.92)*pow(sd,9.0)*0.44;
  col += sg*vec3(1.0,1.075,1.16)*pow(sd,1.6)*0.15;   // broad wash toward the sun
  float a = atan(d.z,d.x);
  float cl = fbm2(vec2(a*2.6, y*7.5)*1.25);
  cl = smoothstep(0.50,0.88,cl) * smoothstep(0.045,0.34,y) * smoothstep(0.92,0.42,y);
  // clouds pick up the low sun on their sunward flank
  vec3 clc = mix(vec3(1.16,1.05,0.96), vec3(1.55,1.28,0.98), pow(sd,1.4));
  col = mix(col, clc, cl*0.56);
  col = mix(col, ` + v3s(WPAL.skyLow) + `, smoothstep(0.04,-0.12,y));
  gl_FragColor = vec4(col,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(420, 40, 22), skyMat);
skyDome.frustumCulled = false; skyDome.renderOrder = -10; skyDome.name = 'SKY';
scene.add(skyDome);

// ══ geometry helpers (no external BufferGeometryUtils — keeps CORE imports untouched) ══
function idxd(g) {
  if (!g.index) { const n = g.attributes.position.count, a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = i; g.setIndex(new THREE.BufferAttribute(a, 1)); }
  return g;
}
const _pc = new THREE.Color();
function paint(g, fn) { // bake per-vertex colour (fake AO / mottling / strata)
  const P = g.attributes.position, N = g.attributes.normal, out = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    fn(_pc, P.getX(i), P.getY(i), P.getZ(i), N ? N.getY(i) : 1, i);
    out[i * 3] = _pc.r; out[i * 3 + 1] = _pc.g; out[i * 3 + 2] = _pc.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(out, 3));
  return g;
}
// parts: [{ g, m?, w?, leaf? }] — w(x,y,z) bakes a per-vertex "wave weight" in the part's
// local space; `leaf` marks the part as foliage and bakes its self-shadowing term.
// uvScale (units per texture tile) replaces per-face UVs with a box projection so a masonry /
// plank texture keeps the same texel density across every merged piece.
function mergeParts(parts, uvScale) {
  let vt = 0, it = 0;
  for (const p of parts) { idxd(p.g); if (!p.g.attributes.normal) p.g.computeVertexNormals(); vt += p.g.attributes.position.count; it += p.g.index.count; }
  const pos = new Float32Array(vt * 3), nor = new Float32Array(vt * 3), uvs = new Float32Array(vt * 2),
        col = new Float32Array(vt * 3), wav = new Float32Array(vt), lf = new Float32Array(vt * 2), idx = new Uint32Array(it);
  const nm = new THREE.Matrix3(), v = new THREE.Vector3(), w = new THREE.Vector3(), I4 = new THREE.Matrix4();
  let vo = 0, io = 0;
  for (const p of parts) {
    const g = p.g, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
    const m = p.m || I4; nm.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      const lx = P.getX(i), ly = P.getY(i), lz = P.getZ(i);
      v.set(lx, ly, lz).applyMatrix4(m);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      w.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor[(vo + i) * 3] = w.x; nor[(vo + i) * 3 + 1] = w.y; nor[(vo + i) * 3 + 2] = w.z;
      if (uvScale) {
        const ax = Math.abs(w.x), ay = Math.abs(w.y), az = Math.abs(w.z);
        let uu, vv;
        if (ay >= ax && ay >= az) { uu = v.x; vv = v.z; } else if (ax >= az) { uu = v.z; vv = v.y; } else { uu = v.x; vv = v.y; }
        uvs[(vo + i) * 2] = uu / uvScale; uvs[(vo + i) * 2 + 1] = vv / uvScale;
      } else if (U) { uvs[(vo + i) * 2] = U.getX(i); uvs[(vo + i) * 2 + 1] = U.getY(i); }
      if (C) { col[(vo + i) * 3] = C.getX(i); col[(vo + i) * 3 + 1] = C.getY(i); col[(vo + i) * 3 + 2] = C.getZ(i); }
      else { col[(vo + i) * 3] = 1; col[(vo + i) * 3 + 1] = 1; col[(vo + i) * 3 + 2] = 1; }
      wav[vo + i] = p.w ? p.w(lx, ly, lz) : 0;
      // aLeaf.x = foliage mask, aLeaf.y = baked lobe-underside AO (undersides self-shade)
      lf[(vo + i) * 2] = p.leaf ? 1 : 0;
      lf[(vo + i) * 2 + 1] = p.leaf ? 0.55 + 0.45 * sstep(-1.0, 0.6, w.y) : 1;
    }
    const IX = g.index; for (let i = 0; i < IX.count; i++) idx[io + i] = IX.getX(i) + vo;
    vo += P.count; io += IX.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aW', new THREE.BufferAttribute(wav, 1));
  out.setAttribute('aLeaf', new THREE.BufferAttribute(lf, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
// Weld a non-indexed geometry (IcosahedronGeometry & friends are unindexed, and
// computeVertexNormals on those can only ever produce FLAT facets). Welding first is what
// lets a displaced lobe carry smooth normals — the whole difference between a painterly
// leaf mass and a chrome-flat geodesic ball.
function weldG(g) {
  const P = g.attributes.position, n = P.count, map = new Map(), idx = new Uint32Array(n), keep = [];
  for (let i = 0; i < n; i++) {
    const k = Math.round(P.getX(i) * 4096) + '|' + Math.round(P.getY(i) * 4096) + '|' + Math.round(P.getZ(i) * 4096);
    let j = map.get(k);
    if (j === undefined) { j = keep.length; map.set(k, j); keep.push(i); }
    idx[i] = j;
  }
  const pos = new Float32Array(keep.length * 3);
  for (let j = 0; j < keep.length; j++) { const i = keep[j]; pos[j * 3] = P.getX(i); pos[j * 3 + 1] = P.getY(i); pos[j * 3 + 2] = P.getZ(i); }
  const o = new THREE.BufferGeometry();
  o.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  o.setIndex(new THREE.BufferAttribute(idx, 1));
  o.computeVertexNormals();
  g.dispose();
  return o;
}
// Push every vertex of a prop's bottom `frac` of its height toward the ground: the base
// then bleeds into the terrain instead of stopping dead at a razor-hard intersection.
function baseBleed(g, frac, k) {
  const P = g.attributes.position, C = g.attributes.color;
  if (!C) return g;
  let y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < P.count; i++) { const y = P.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const span = Math.max(1e-4, (y1 - y0) * frac);
  for (let i = 0; i < P.count; i++) {
    const t = clamp((P.getY(i) - y0) / span, 0, 1), f = lerp(1 - k, 1, t * t * (3 - 2 * t));
    C.setXYZ(i, C.getX(i) * f, C.getY(i) * f, C.getZ(i) * f);
  }
  return g;
}
const _M = new THREE.Matrix4(), _Q4 = new THREE.Quaternion(), _E = new THREE.Euler(), _S3 = new THREE.Vector3(), _P3 = new THREE.Vector3();
const trs = (x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(_P3.set(x, y, z), _Q4.setFromEuler(_E.set(rx, ry, rz)), _S3.set(sx, sy, sz));
const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ── value noise for the heightfield (hash-based: independent of any rng stream) ──
function h2i(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnz(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h2i(xi, yi), h2i(xi + 1, yi), u), lerp(h2i(xi, yi + 1), h2i(xi + 1, yi + 1), u), v);
}
function fbmz(x, y, oct) { let s = 0, a = 0.5, n = 0, f = 1; for (let i = 0; i < oct; i++) { s += a * vnz(x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }

// ── diorama footprint: rounded-rect (superellipse) cliff ring ──
const FW = 268, FD = 196;               // terrain plane extents
const CA = 103, CB = 75;                // playfield radii
function ringU(x, z) {
  const a = Math.abs(x) / CA, b = Math.abs(z) / CB;
  return Math.cbrt(a * a * a + b * b * b);
}
// point on the superellipse rim at azimuth a, radius factor u (inverse of ringU)
function seP(a, u) {
  const c = Math.cos(a), s = Math.sin(a);
  const cx = Math.sign(c) * Math.pow(Math.abs(c), 2 / 3), cz = Math.sign(s) * Math.pow(Math.abs(s), 2 / 3);
  return [CA * u * cx, CB * u * cz];
}
// The vale opens toward this bearing (screen-far with the game camera): the rim drops
// away there so the composition gets a hazy horizon and distant ranges instead of a
// wall of grey rubble across the top of frame.
const OPEN_ANG = -1.94;
function rimProfile(x, z) {              // per-azimuth cliff start / crest height
  const ang = Math.atan2(z / CB, x / CA), c = Math.cos(ang), s = Math.sin(ang);
  const n1 = fbmz(c * 3.1 + 20.5, s * 3.1 + 40.5, 3);
  const n2 = fbmz(c * 8.3 + 5.5, s * 8.3 + 71.5, 3);
  const n3 = fbmz(c * 26.0 + 13.5, s * 26.0 + 3.5, 2);   // buttresses / gullies
  const n4 = fbmz(c * 47.0 + 61.5, s * 47.0 + 29.5, 2);  // finer ribs
  let da = ang - OPEN_ANG; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const opn = sstep(0.92, 0.16, Math.abs(da));           // 1 = valley mouth
  return { start: 0.876 + (n1 - 0.5) * 0.074 + (n3 - 0.5) * 0.046 + (n4 - 0.5) * 0.020 - opn * 0.030,
           top: (16 + n1 * 17 + n2 * 10 + n3 * 7) * (1 - 0.44 * opn), open: opn };
}
function meadowH(x, z) {                 // gentle valley floor + foothills, no road, no cliff
  // enough relief that the low sun actually SHAPES the meadow — a near-flat plane reads
  // as a billiard table no matter how good the splat material is
  let h = 4.4 * (fbmz(x * 0.0128 + 7.3, z * 0.0128 - 3.1, 3) - 0.5) * 2;
  h += 1.85 * (fbmz(x * 0.047 + 31.7, z * 0.047 - 11.3, 3) - 0.5) * 2;
  h += 0.44 * (fbmz(x * 0.165 + 2.9, z * 0.165 + 5.7, 2) - 0.5) * 2;
  const u = ringU(x, z);
  h += 6.2 * sstep(0.34, 0.94, u);       // ground lifts toward the cliff feet
  h -= 1.5 * sstep(0.55, 0.05, u);       // shallow bowl in the middle
  return h;
}
function cliffH(x, z, notch) {
  const u = ringU(x, z), pr = rimProfile(x, z);
  // steep escarpment: short talus shoulder, then a near-vertical face, then the world ends
  const rise = Math.pow(sstep(pr.start, pr.start + 0.058, u), 0.66);
  const brk = 1 - notch;
  let h = pr.top * rise * (1 - 0.99 * notch);
  h += rise * brk * (fbmz(x * 0.052 + 70.1, z * 0.052 + 31.9, 4) - 0.5) * 20;   // ~19u masses
  h += rise * brk * (fbmz(x * 0.098 + 41.7, z * 0.098 + 7.3, 3) - 0.5) * 13;    // ~10u buttresses
  h += rise * brk * (fbmz(x * 0.165 + 12.3, z * 0.165 + 88.7, 3) - 0.5) * 12;   // ~6u ledges & ribs
  h += rise * brk * (fbmz(x * 0.44 + 5.1, z * 0.44 + 2.3, 2) - 0.5) * 4.2;      // ~2.3u breakage
  h += sstep(pr.start - 0.125, pr.start + 0.015, u) * 6.0 * brk;           // talus shoulder
  const d0 = pr.start + 0.078;
  // the map edge drops away into shadow — except inside the road notch, where the corridor
  // carries on through the gorge behind each gate (otherwise the gates sit on a void).
  h -= sstep(d0, d0 + 0.055, u) * (pr.top + 70) * (1 - 0.97 * notch);
  return h;
}
// past this the diorama simply ends; the drop above already sinks into near-black so the
// map edge reads as a dark frame rather than an exposed outer slope. The road corridor is
// never culled, so the gates always have ground under them.
const cullFar = (x, z, sd) => Math.abs(sd) > 15 && ringU(x, z) > rimProfile(x, z).start + 0.33;

// ══ heightfield grids (fixed resolution → groundY is tier-independent = sim-safe) ══
const GX = 225, GZ = 165, GSx = FW / (GX - 1), GSz = FD / (GZ - 1);
let HG = null, SDG = null, TDG = null, AOG = null;
function bi(grid, x, z) {
  const gx = (x + FW / 2) / GSx, gz = (z + FD / 2) / GSz;
  let ix = Math.floor(gx), iz = Math.floor(gz);
  ix = ix < 0 ? 0 : ix > GX - 2 ? GX - 2 : ix; iz = iz < 0 ? 0 : iz > GZ - 2 ? GZ - 2 : iz;
  const fx = clamp(gx - ix, 0, 1), fz = clamp(gz - iz, 0, 1), r0 = iz * GX + ix, r1 = r0 + GX;
  return lerp(lerp(grid[r0], grid[r0 + 1], fx), lerp(grid[r1], grid[r1 + 1], fx), fz);
}
G.groundY = (x, z) => HG ? bi(HG, x, z) : 0;
G.roadSD = (x, z) => SDG ? bi(SDG, x, z) : 99;      // signed lateral distance to road centre
G.groundNormal = (x, z, out) => {
  if (!HG) return (out || new THREE.Vector3()).set(0, 1, 0);
  const e = 1.3;
  return (out || new THREE.Vector3()).set(bi(HG, x - e, z) - bi(HG, x + e, z), 2 * e, bi(HG, x, z - e) - bi(HG, x, z + e)).normalize();
};

const World = { group: new THREE.Group(), pads: [], props: [] };
G.World = World;
scene.add(World.group);

// ── prop contact AO ───────────────────────────────────────────────────────────
// Every scattered prop stamps a radial darkening into one R8 field covering the whole
// diorama; the terrain shader multiplies it into albedo. Without this a rock is a sticker
// on the grass — the eye reads "no contact shadow" as "not touching". Cheap (1 texture,
// 1 lookup) and it buys more grounding than anything else in the section.
const PAO_N = 1024;
const paoData = new Uint8Array(PAO_N * PAO_N);
const paoTex = new THREE.DataTexture(paoData, PAO_N, PAO_N, THREE.RedFormat);
paoTex.minFilter = paoTex.magFilter = THREE.LinearFilter;
paoTex.wrapS = paoTex.wrapT = THREE.ClampToEdgeWrapping;
paoTex.unpackAlignment = 1; paoTex.needsUpdate = true;
// r = the prop's bounding radius; the stamp reaches 1.6x that.
G.stampAO = function (x, z, r, k) {
  const R = r * 1.6, A = 255 * (k === undefined ? 1 : k);
  const cx = (x + FW / 2) / FW * PAO_N, cz = (z + FD / 2) / FD * PAO_N;
  const rx = R / FW * PAO_N, rz = R / FD * PAO_N;
  const i0 = Math.max(0, Math.floor(cx - rx)), i1 = Math.min(PAO_N - 1, Math.ceil(cx + rx));
  const j0 = Math.max(0, Math.floor(cz - rz)), j1 = Math.min(PAO_N - 1, Math.ceil(cz + rz));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = (i + 0.5 - cx) / rx, dz = (j + 0.5 - cz) / rz, d = Math.hypot(dx, dz);
    if (d >= 1) continue;
    const q = j * PAO_N + i, v = paoData[q] + sstep(1.0, 0.35, d) * A;
    paoData[q] = v > 255 ? 255 : v;
  }
  paoTex.needsUpdate = true;
};

// ── canvas texture helpers ──────────────────────────────────────────────────────
function cnv(s) { const c = document.createElement('canvas'); c.width = c.height = s; return [c, c.getContext('2d')]; }
function tex(c, rep) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); }
  return t;
}
function bannerTex(main, dark, trim, glyph) {
  const [c, g] = cnv(256);
  const gr = g.createLinearGradient(0, 0, 256, 0);
  gr.addColorStop(0, dark); gr.addColorStop(0.38, main); gr.addColorStop(0.72, main); gr.addColorStop(1, dark);
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 260; i++) { g.fillStyle = 'rgba(0,0,0,' + (0.03 + wrng() * 0.05) + ')'; g.fillRect(wrng() * 256, wrng() * 256, 1 + wrng() * 3, 1 + wrng() * 22); }
  g.fillStyle = trim; g.fillRect(0, 0, 256, 12); g.fillRect(0, 236, 256, 6);
  g.strokeStyle = trim; g.lineWidth = 5; g.strokeRect(20, 26, 216, 206);
  g.fillStyle = trim; g.font = 'bold 150px Georgia'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.globalAlpha = 0.92; g.fillText(glyph, 128, 132); g.globalAlpha = 1;
  const gr2 = g.createLinearGradient(0, 0, 0, 256);
  gr2.addColorStop(0, 'rgba(255,255,255,.10)'); gr2.addColorStop(1, 'rgba(0,0,0,.30)');
  g.fillStyle = gr2; g.fillRect(0, 0, 256, 256);
  return tex(c);
}
const _rgb = (r, g, b) => 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
function stoneTex() {                                  // coursed rubble masonry, 1 tile = 2.4 u
  const S = 512, [c, g] = cnv(S);
  g.fillStyle = '#3c362c'; g.fillRect(0, 0, S, S);
  const rows = 7, rh = S / rows;
  for (let r = -1; r <= rows; r++) {
    const off = (r & 1) * 0.5, cols = 5, bw = S / cols;
    for (let i = -1; i <= cols; i++) {
      const x = (i + off) * bw + 3, y = r * rh + 3, w = bw - 6 + wrng() * 4, h = rh - 6;
      const l = 0.60 + wrng() * 0.62;
      g.fillStyle = _rgb(146 * l, 138 * l, 120 * l);
      g.beginPath(); g.moveTo(x + wrng() * 4, y + wrng() * 3);
      g.lineTo(x + w - wrng() * 4, y + wrng() * 3); g.lineTo(x + w - wrng() * 3, y + h - wrng() * 3);
      g.lineTo(x + wrng() * 3, y + h - wrng() * 4); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,250,235,.16)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x + 4, y + 3); g.lineTo(x + w - 4, y + 3); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.34)';
      g.beginPath(); g.moveTo(x + 4, y + h - 3); g.lineTo(x + w - 4, y + h - 3); g.stroke();
      for (let s = 0; s < 26; s++) {                  // pitting
        g.fillStyle = 'rgba(' + (wrng() < 0.5 ? '0,0,0,' : '255,255,240,') + (0.05 + wrng() * 0.10) + ')';
        g.fillRect(x + wrng() * w, y + wrng() * h, 1 + wrng() * 3, 1 + wrng() * 3);
      }
    }
  }
  for (let i = 0; i < 90; i++) {                      // weather streaks
    g.fillStyle = 'rgba(30,34,24,' + (0.03 + wrng() * 0.07) + ')';
    g.fillRect(wrng() * S, wrng() * S, 2 + wrng() * 6, 20 + wrng() * 90);
  }
  return tex(c, 1);
}
function plasterTex() {                                // wattle-and-daub render
  const S = 256, [c, g] = cnv(S);
  g.fillStyle = '#c8b696'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const l = wrng();
    g.fillStyle = 'rgba(' + (l < 0.5 ? '90,78,58,' : '235,224,200,') + (0.04 + wrng() * 0.10) + ')';
    g.fillRect(wrng() * S, wrng() * S, 2 + wrng() * 9, 2 + wrng() * 7);
  }
  for (let i = 0; i < 26; i++) {                       // stains & cracks
    g.strokeStyle = 'rgba(76,64,46,' + (0.10 + wrng() * 0.16) + ')'; g.lineWidth = 1 + wrng() * 2;
    g.beginPath(); let x = wrng() * S, y = wrng() * S; g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (wrng() - 0.5) * 46; y += wrng() * 34; g.lineTo(x, y); }
    g.stroke();
  }
  return tex(c, 1);
}
function woodTex() {                                   // sawn plank grain
  const S = 256, [c, g] = cnv(S);
  g.fillStyle = '#6b4d30'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 5; i++) {                        // plank bands
    const y = i * S / 5, l = 0.72 + wrng() * 0.5;
    g.fillStyle = _rgb(112 * l, 80 * l, 50 * l); g.fillRect(0, y, S, S / 5 - 2);
    g.fillStyle = 'rgba(0,0,0,.36)'; g.fillRect(0, y + S / 5 - 3, S, 3);
  }
  for (let i = 0; i < 260; i++) {                      // grain
    const l = wrng();
    g.strokeStyle = 'rgba(' + (l < 0.55 ? '48,32,18,' : '176,142,100,') + (0.06 + wrng() * 0.14) + ')';
    g.lineWidth = 1 + wrng() * 1.6;
    const y = wrng() * S; g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= S; x += 32) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 2.2);
    g.stroke();
  }
  return tex(c, 1);
}
function shingleTex(dark, light) {                     // overlapping shingle courses
  const S = 256, [c, g] = cnv(S);
  g.fillStyle = dark; g.fillRect(0, 0, S, S);
  const rows = 8, rh = S / rows;
  for (let r = -1; r <= rows; r++) {
    const off = (r & 1) * 0.5, cols = 7, bw = S / cols;
    for (let i = -1; i <= cols; i++) {
      const x = (i + off) * bw, y = r * rh;
      const l = 0.62 + wrng() * 0.62;
      g.fillStyle = light.replace('L', String(l));
      g.beginPath(); g.moveTo(x + 1, y); g.lineTo(x + bw - 1, y);
      g.lineTo(x + bw - 1, y + rh * 0.86); g.lineTo(x + bw * 0.5, y + rh);
      g.lineTo(x + 1, y + rh * 0.86); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.30)'; g.fillRect(x + 1, y + rh * 0.90, bw - 2, rh * 0.12);
    }
  }
  return tex(c, 1);
}
function tuftTex() {
  const S = 256, [c, g] = cnv(S);
  g.clearRect(0, 0, S, S);
  // dense clump of tapered blades; darker at the base so the tuft grounds itself
  for (let i = 0; i < 190; i++) {
    const x0 = 10 + wrng() * (S - 20), w = 3 + wrng() * 7, hh = S * (0.26 + wrng() * 0.66);
    const bend = (wrng() - 0.5) * S * 0.60;
    const lum = 0.38 + Math.pow(wrng(), 0.9) * 0.64;
    const warm = wrng() < 0.14 ? 1 : 0;                     // a few bleached / seeding blades
    const TB = WPAL.blade, TW = WPAL.bladeW;
    g.fillStyle = 'rgb(' + Math.round((TB[0] + warm * TW[0]) * lum) + ',' + Math.round((TB[1] + warm * TW[1]) * lum) + ',' + Math.round((TB[2] + warm * TW[2]) * lum) + ')';
    g.beginPath(); g.moveTo(x0 - w / 2, S); g.quadraticCurveTo(x0 + bend * 0.5, S - hh * 0.62, x0 + bend, S - hh);
    g.quadraticCurveTo(x0 + bend * 0.5 + w, S - hh * 0.6, x0 + w / 2, S); g.closePath(); g.fill();
  }
  const sh = g.createLinearGradient(0, S, 0, S * 0.45);
  sh.addColorStop(0, 'rgba(14,22,8,.52)'); sh.addColorStop(1, 'rgba(14,22,8,0)');
  g.globalCompositeOperation = 'source-atop'; g.fillStyle = sh; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  return tex(c);
}
function flameTex() {
  const [c, g] = cnv(64);
  const gr = g.createRadialGradient(32, 40, 1, 32, 40, 30);
  gr.addColorStop(0, 'rgba(255,248,214,1)'); gr.addColorStop(0.28, 'rgba(255,196,86,.92)');
  gr.addColorStop(0.62, 'rgba(226,104,26,.42)'); gr.addColorStop(1, 'rgba(120,40,8,0)');
  g.fillStyle = gr; g.beginPath(); g.ellipse(32, 38, 20, 30, 0, 0, 7); g.fill();
  return tex(c);
}

// ── material factory: vertex-coloured, sway-capable prop material ──────────────
function propMat(o) {
  const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.88, metalness: 0 }, o));
  return m;
}
// hex (sRGB) -> GLSL linear-working literal
const lin3 = (hex, k) => { const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return 'vec3(' + (c.r * k).toFixed(4) + ',' + (c.g * k).toFixed(4) + ',' + (c.b * k).toFixed(4) + ')'; };
function swayMat(o, amp, freq, key, leaf) {
  const m = propMat(o);
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uT = WT; sh.uniforms.uAmp = { value: amp }; sh.uniforms.uFrq = { value: freq };
    sh.vertexShader = 'uniform float uT;uniform float uAmp;uniform float uFrq;attribute float aW;\n'
      + (leaf ? 'attribute vec2 aLeaf;\nvarying vec2 vLeaf;\nvarying vec3 vWPf;\n' : '')
      + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      if (aW > 0.0001) {
        float ph = position.x*0.37 + position.z*0.51;
        #ifdef USE_INSTANCING
          ph += instanceMatrix[3].x*0.21 + instanceMatrix[3].z*0.17;
        #endif
        transformed.x += sin(uT*uFrq + ph)*uAmp*aW;
        transformed.z += cos(uT*uFrq*0.83 + ph*1.31)*uAmp*0.7*aW;
      }` + (leaf ? `
      vLeaf = aLeaf;
      vec4 _wp4 = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        _wp4 = instanceMatrix * _wp4;
      #endif
      vWPf = (modelMatrix * _wp4).xyz;` : ''));
    if (!leaf) return;
    sh.uniforms.uLeafTex = { value: LEAF_TEX };
    sh.uniforms.uSunDir = { value: SUNDIR };
    sh.fragmentShader = 'uniform sampler2D uLeafTex;\nuniform vec3 uSunDir;\nvarying vec2 vLeaf;\nvarying vec3 vWPf;\n'
      + sh.fragmentShader
        .replace('#include <map_fragment>', `
      {
        // Near-camera dissolve. A conifer growing out of the lens used to black out half
        // the frame; now it dithers away over 2..7u and the shot keeps its subject.
        float _d = length(vViewPosition);
        if (vLeaf.x > 0.5 && fract(sin(dot(gl_FragCoord.xy, vec2(12.99,78.23)))*43758.5) > smoothstep(2.0, 7.0, _d)) discard;
        // canopy albedo, projected on Y from world XZ at ~1.5 u/tile (a ~1.0 modulation)
        vec3 _lt = texture2D(uLeafTex, vWPf.xz * 0.6667).rgb * 2.0;
        diffuseColor.rgb *= mix(vec3(1.0), _lt, vLeaf.x * 0.85) * mix(1.0, vLeaf.y, vLeaf.x);
      }`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
      if (vLeaf.x > 0.5) {
        vec3 _N = normalize(normal * mat3(viewMatrix));
        vec3 _V = normalize(vWPf - cameraPosition);
        vec3 _alb = diffuseColor.rgb;
        // Backlit translucency: the read that says "leaves" instead of "painted plastic".
        // Gated on the leaf facing AWAY from the sun — without that gate a camera aimed
        // down-sun lights every canopy in frame uniformly and the whole wood washes out.
        gl_FragColor.rgb += ${lin3(WPAL.sun, 1)} * _alb * pow(max(0.0, dot(-uSunDir, _V)), 3.0)
                          * smoothstep(0.15, -0.55, dot(_N, uSunDir)) * 1.35;
        // explicit up-facing bounce: snowfields and pale sand throw a LOT of light back
        // into the underside of foliage, and the hemisphere term alone never delivered it
        gl_FragColor.rgb += ${lin3(WPAL.hemiGnd, 1)} * _alb * max(0.0, -_N.y) * 2.0;
        // rim: a close conifer now gets a lit edge instead of reading as a silhouette hole
        gl_FragColor.rgb += ${lin3(WPAL.sun, 1)} * pow(1.0 - max(0.0, dot(_N, -_V)), 2.5) * 0.11;
      }`);
  };
  return m;
}

// ══ rock / crag geometry ══
function rockGeo(detail, seed, ang) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const n = fbmz(x * 1.85 + seed, z * 1.85 + y * 1.3 + seed * 1.7, 3);
    const n2 = fbmz(x * 4.7 + seed * 2.3, z * 4.7 + y * 3.1, 2);
    let r = 0.70 + n * 0.55 + n2 * 0.14;
    if (ang) { // slabby / angular: quantise the radius into strata steps
      const step = 0.13; r = Math.round(r / step) * step;
      y = Math.round(y / 0.19) * 0.19 + y * 0.3;
    }
    P.setXYZ(i, x * r, y * r * 0.82, z * r);
  }
  g.computeVertexNormals();
  // A boulder and the cliff it sits on must be the SAME rock. Both now read from the map
  // palette's rockA/rockB with the same strata banding and the same moss colour — a
  // beige untextured facet next to a stratified brown heightfield reads as two materials
  // that cannot coexist in one world.
  const RA = WPAL.rockA, RB = WPAL.rockB, MO = WPAL.moss;
  _tmpMoss.setRGB(MO[0] * 1.35, MO[1] * 1.35, MO[2] * 1.35);
  return paint(g, (c, x, y, z, ny) => {
    const bnd = (y * 2.6 + fbmz(x * 0.8 + 12, z * 0.8, 2) * 2.2) % 1;
    const bs = sstep(0.42, 0.50, bnd);
    const joint = sstep(0.10, 0.0, bnd);                  // dark bedding plane
    const base = [lerp(RA[0] * 3.0, RB[0], bs), lerp(RA[1] * 3.0, RB[1], bs), lerp(RA[2] * 3.0, RB[2], bs)];
    const v = (0.66 + 0.42 * fbmz(x * 3.4 + 3, z * 3.4 + y * 2, 2)) * (1 - 0.30 * joint);
    const dn = 0.50 + 0.50 * clamp(y * 0.9 + 0.55, 0, 1);
    const moss = clamp((ny - 0.28) * 1.6, 0, 1) * clamp(fbmz(x * 1.1 + 44, z * 1.1 + 9, 2) * 1.9 - 0.66, 0, 1);
    c.setRGB(base[0] * v * dn, base[1] * v * dn, base[2] * v * dn);
    c.lerp(_tmpMoss, moss * 0.72);
  });
}
const _tmpMoss = new THREE.Color(0.070, 0.118, 0.036);

// Cliff crag: an irregular prism extruded through stepped tiers. The crisp vertical
// faces + horizontal ledges are what make a rim read as bedded rock; a displaced
// icosahedron only ever reads as a boulder no matter how it is scaled.
function cragGeo(sides, tiers, seed) {
  const TY = [0, 0.36, 0.64, 0.84, 0.95, 1.0].slice(0, tiers + 1);
  const TK = [1.00, 0.97, 0.90, 0.84, 0.79, 0.75].slice(0, tiers + 1);  // ledged, barely tapered
  const NV = (tiers + 1) * sides + 1;
  const pos = new Float32Array(NV * 3), col = new Float32Array(NV * 3);
  const idx = [];
  const rad = [], off = [];
  for (let i = 0; i < sides; i++) {
    rad.push(0.40 + Math.pow(fbmz(i * 4.3 + seed, seed * 2.7, 2), 0.85) * 1.00);
    off.push((fbmz(i * 7.1 + seed * 3.1, seed * 1.3, 2) - 0.5) * 0.34);
  }
  const put = (k, x, y, z, up, crev, hgt) => {
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    // Bake the read: sunlit caps, mid vertical faces, dark crevices and base.
    // NOTE: this is an ALBEDO, not a rendered value — 0.13 base already renders near
    // white under the 4.9-intensity sun. Anything higher blows out to sugar cubes.
    const v = (0.42 + 0.62 * Math.pow(hgt, 0.70)) * (up ? 1.22 : 0.82) * (1 - 0.40 * crev)
            * (0.70 + 0.62 * fbmz(x * 5.1 + seed, z * 5.1 + y * 4.2, 2));
    const moss = up ? clamp(fbmz(x * 2.2 + 19, z * 2.2 + 5, 2) * 2.2 - 1.10, 0, 1) * 0.62 : 0;
    const g0 = 0.108 * v;      // matched to the terrain granite so crags don't read as pasted-on
    col[k * 3] = lerp(g0, 0.062, moss); col[k * 3 + 1] = lerp(g0, 0.104, moss); col[k * 3 + 2] = lerp(g0 * 0.98, 0.032, moss);
  };
  let shx = 0, shz = 0;
  for (let t = 0; t <= tiers; t++) {
    const fy = TY[t], k = TK[t];
    if (t) { shx += (fbmz(t * 3.3 + seed, seed, 2) - 0.5) * 0.30; shz += (fbmz(t * 5.9 + seed * 2, seed * 3, 2) - 0.5) * 0.30; }
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2 + off[i] * 0.4;
      const r = rad[i] * k * (1 + (fbmz(i * 2.9 + t * 5.7 + seed, t * 1.7, 2) - 0.5) * 0.24);
      put(t * sides + i, Math.cos(a) * r + shx, fy * 2.0, Math.sin(a) * r + shz, false,
          Math.max(0, 1 - rad[i]), fy);
    }
  }
  for (let t = 0; t < tiers; t++) for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides, A = t * sides + i, B = t * sides + j, C = A + sides, D = B + sides;
    idx.push(A, C, B, B, C, D);
  }
  const top = (tiers + 1) * sides;                     // low crown, not a spike
  put(top, shx + 0.06, 2.0 + 0.16, shz, true, 0, 1.0);
  for (let i = 0; i < sides; i++) idx.push(tiers * sides + i, top, tiers * sides + (i + 1) % sides);
  const gi = new THREE.BufferGeometry();
  gi.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  gi.setAttribute('color', new THREE.BufferAttribute(col, 3));
  gi.setIndex(idx);
  // FLAT facets, not smooth: averaged normals turn an irregular prism into a rounded
  // box. Expanding to non-indexed and re-deriving normals gives crisp rock planes, and
  // lets each facet carry its own tint — the classic faceted-granite read.
  const g = gi.toNonIndexed();
  gi.dispose();
  g.computeVertexNormals();
  const C = g.attributes.color, N = g.attributes.normal, P = g.attributes.position;
  for (let t = 0; t < P.count; t += 3) {
    const ny = N.getY(t);
    const f = (0.80 + 0.42 * fbmz(P.getX(t) * 3.7 + seed * 2.3, P.getZ(t) * 3.7 + P.getY(t) * 2.9, 2))
            * (ny > 0.55 ? 1.16 : ny < -0.2 ? 0.62 : 0.94);       // ledges catch light, undercuts don't
    for (let k = 0; k < 3; k++) C.setXYZ(t + k, C.getX(t + k) * f, C.getY(t + k) * f, C.getZ(t + k) * f);
  }
  g.translate(0, -1.0, 0);
  return g;
}

// ══ tree species ══
// One canopy LOBE: a welded icosahedron displaced in and out along its own normals (a
// per-vertex hash plus a smooth lump term) and then re-smoothed. Several of these
// overlapping ARE the canopy. A single hull — however finely subdivided — can only ever
// present a convex silhouette, which is the flat-shaded-geodesic-ball read.
function lobeG(r, sq, seed) {
  const g = weldG(new THREE.IcosahedronGeometry(r, 1));
  const P = g.attributes.position, N = g.attributes.normal;
  const si = (seed * 8191) | 0;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    // hash keyed on the (welded) position, so shared vertices always agree
    const hs = (h2i(Math.round(x * 512) * 3 + si, Math.round(y * 512) * 7 - Math.round(z * 512) * 5) - 0.5) * 0.50;
    const lump = (fbmz(x * 1.7 + seed, z * 1.7 + y * 1.25 + seed, 2) - 0.5) * 0.46;
    const d = (hs + lump) * r;
    P.setXYZ(i, x + N.getX(i) * d,
             (y + N.getY(i) * d) * sq - (1 - Math.abs(y) / r) * r * 0.12,
             z + N.getZ(i) * d);
  }
  g.computeVertexNormals();
  return g;
}
// A conifer whorl. NOT a ConeGeometry: every ring's radius wobbles ±15%, the skirt sags
// unevenly between the boughs and the tip is offset, so a stack of these stops reading as
// hard concentric rings on a party hat.
function coneRingG(r, h, seed) {
  const SEG = 11, RINGS = 3, RY = [0.0, 0.44, 0.80], RR = [1.0, 0.66, 0.32];
  const NV = SEG * RINGS + 2, pos = new Float32Array(NV * 3), idx = [];
  const si = (seed * 131) | 0;
  for (let ri = 0; ri < RINGS; ri++) for (let i = 0; i < SEG; i++) {
    const a = i / SEG * Math.PI * 2;
    const rr = r * RR[ri] * (1 + (h2i(i * 13 + ri * 97, si) - 0.5) * 0.30);
    const sag = ri === 0 ? -0.26 * h * (0.35 + 0.65 * h2i(i * 29, si + 7)) : 0;
    const k = (ri * SEG + i) * 3;
    pos[k] = Math.cos(a) * rr; pos[k + 1] = RY[ri] * h + sag; pos[k + 2] = Math.sin(a) * rr;
  }
  const tip = SEG * RINGS, ctr = tip + 1;
  pos[tip * 3] = (h2i(si, 7) - 0.5) * r * 0.26; pos[tip * 3 + 1] = h; pos[tip * 3 + 2] = (h2i(11, si) - 0.5) * r * 0.26;
  pos[ctr * 3] = 0; pos[ctr * 3 + 1] = -0.10 * h; pos[ctr * 3 + 2] = 0;
  for (let ri = 0; ri < RINGS - 1; ri++) for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG, A = ri * SEG + i, B = ri * SEG + j, C = A + SEG, D = B + SEG;
    idx.push(A, C, B, B, C, D);
  }
  for (let i = 0; i < SEG; i++) idx.push((RINGS - 1) * SEG + i, tip, (RINGS - 1) * SEG + (i + 1) % SEG);
  for (let i = 0; i < SEG; i++) idx.push((i + 1) % SEG, ctr, i);   // closed underside
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// Canopy albedo: three green values plus dark speckle (leaf gaps) and pale sun flecks,
// sampled triplanar-on-Y from world XZ at ~1.5 u/tile. Deliberately NOT an sRGB texture —
// the shader uses it as a ~1.0 modulation so each map's palette keeps doing the colour work.
function canopyTex() {
  const S = 256, [c, g] = cnv(S);
  let s = 0x9e3779b9 >>> 0;
  const r = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  g.fillStyle = '#7f8577'; g.fillRect(0, 0, S, S);
  const TN = ['#96a07e', '#6c7565', '#88968a'];
  for (let i = 0; i < 900; i++) {
    g.fillStyle = TN[(r() * 3) | 0]; g.globalAlpha = 0.28 + r() * 0.50;
    g.beginPath(); g.ellipse(r() * S, r() * S, 3 + r() * 13, 2 + r() * 9, r() * 6.283, 0, 7); g.fill();
  }
  g.globalAlpha = 1;
  for (let i = 0; i < 2800; i++) {
    g.fillStyle = 'rgba(26,34,22,' + (0.10 + r() * 0.42) + ')';
    g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3);
  }
  for (let i = 0; i < 520; i++) {
    g.fillStyle = 'rgba(210,220,172,' + (0.08 + r() * 0.26) + ')';
    g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
const LEAF_TEX = canopyTex();
function trunkG(r0, r1, h, sides, lean) {
  const g = new THREE.CylinderGeometry(r1, r0, h, sides, 2, false);
  g.translate(0, h / 2, 0);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    P.setXYZ(i, x + lean * (y / h) * (y / h) * 1.0 + (vnz(x * 9, y * 2.2) - 0.5) * 0.06, y, z + lean * 0.4 * (y / h) * (y / h) + (vnz(z * 9 + 4, y * 2.2) - 0.5) * 0.06);
  }
  g.computeVertexNormals();
  return g;
}
const BARK = [0.155, 0.115, 0.080], BARK2 = [0.085, 0.062, 0.045];
function paintBark(g, h) {
  return paint(g, (c, x, y, z) => {
    const v = 0.62 + 0.75 * vnz(Math.atan2(z, x) * 5.5, y * 3.2);
    const dn = 0.55 + 0.45 * clamp(y / h * 1.4, 0, 1);
    c.setRGB(lerp(BARK2[0], BARK[0], v) * dn, lerp(BARK2[1], BARK[1], v) * dn, lerp(BARK2[2], BARK[2], v) * dn);
  });
}
// Flat-facet a mesh and give every triangle its own tint. Smooth-shaded noise spheres
// read as rubber balloons; faceted leaf masses with per-plane dapple read as painterly
// canopy — the single biggest quality lever on the foliage.
function facet(g, seed, amt) {
  // POLISH: several callers hand this an already-expanded geometry, and three.js logs a
  // console warning for a redundant toNonIndexed(). Work in place in that case.
  const o = g.index ? g.toNonIndexed() : g;
  if (o !== g) g.dispose();
  o.computeVertexNormals();
  const C = o.attributes.color, N = o.attributes.normal, P = o.attributes.position;
  if (!C) return o;
  for (let t = 0; t < P.count; t += 3) {
    const up = clamp(N.getY(t) * 0.5 + 0.5, 0, 1);
    const f = 1 + amt * ((fbmz(P.getX(t) * 4.1 + seed, P.getZ(t) * 4.1 + P.getY(t) * 3.3, 2) - 0.5) * 1.6
                         + (up - 0.5) * 1.10);
    for (let k = 0; k < 3; k++) C.setXYZ(t + k, C.getX(t + k) * f, C.getY(t + k) * f, C.getZ(t + k) * f);
  }
  return o;
}
function paintCanopy(g, cy, rad, deep, lit, warm) {
  return paint(g, (c, x, y, z, ny) => {
    const mot = fbmz(x * 2.6 + cy * 3.1, z * 2.6 + y * 1.9, 3);
    const mot2 = fbmz(x * 7.4 + 11, z * 7.4 + y * 5.5, 2);
    const up = clamp((y / rad) * 0.5 + 0.5, 0, 1);
    const shade = 0.20 + 0.80 * Math.pow(up, 1.15);
    const sunF = clamp(x * -0.34 + y * 0.30 + z * 0.22, 0, 1);
    const k = clamp(mot * 0.58 + mot2 * 0.18 + up * 0.30, 0, 1);
    c.setRGB(
      lerp(deep[0], lit[0], k) * shade + warm * sunF * 0.052,
      lerp(deep[1], lit[1], k) * shade + warm * sunF * 0.040,
      lerp(deep[2], lit[2], k) * shade + warm * sunF * 0.008);
  });
}
function treeOak(seed) {
  const h = 5.4, parts = [];
  parts.push({ g: paintBark(trunkG(0.46, 0.26, h, 7, 0.22), h) });
  for (let i = 0; i < 3; i++) {
    const a = seed * 2.3 + i * 2.1, br = 0.16;
    const bg = paintBark(trunkG(br, 0.09, 2.3, 5, 0.5), 2.3);
    parts.push({ g: bg, m: trs(Math.cos(a) * 0.25, h * 0.62, Math.sin(a) * 0.25, a, 1, 1, 1, 0.55 * Math.cos(a) + 0.4, 0.55 * Math.sin(a)) });
  }
  const OD = WPAL.oakD, OL = WPAL.oakL;
  const cy = [[0, 6.5, 0, 3.00, 0.62], [-2.5, 5.5, 1.3, 2.25, 0.58], [2.6, 5.75, -1.1, 2.15, 0.60],
              [0.6, 5.1, -2.7, 1.95, 0.56], [-0.9, 5.2, 2.8, 1.85, 0.56], [1.5, 7.6, 1.2, 1.75, 0.64],
              [-1.9, 7.1, -1.4, 1.60, 0.60], [2.1, 6.3, 2.0, 1.45, 0.58]];
  for (const [x, y, z, r, sq] of cy)
    parts.push({ g: paintCanopy(lobeG(r, sq, seed + x * 3 + z), y, r, OD, OL, 1), m: trs(x, y, z, seed + x), w: () => 1, leaf: 1 });
  return baseBleed(mergeParts(parts), 0.10, 0.45);
}
function treeAsh(seed) {
  const h = 8.0, parts = [];
  parts.push({ g: paintBark(trunkG(0.31, 0.15, h, 6, 0.16), h) });
  const AD = WPAL.ashD, AL = WPAL.ashL;
  const cy = [[0, 9.0, 0, 2.35, 0.98], [-1.5, 7.8, 0.9, 1.85, 0.88], [1.55, 8.2, -0.6, 1.70, 0.92],
              [0.3, 7.1, -1.7, 1.55, 0.82], [-0.7, 9.8, -0.8, 1.40, 0.90], [1.2, 6.6, 1.5, 1.30, 0.80]];
  for (const [x, y, z, r, sq] of cy)
    parts.push({ g: paintCanopy(lobeG(r, sq, seed + x * 5 + z), y, r, AD, AL, 1), m: trs(x, y, z, seed + z), w: () => 1, leaf: 1 });
  return baseBleed(mergeParts(parts), 0.09, 0.45);
}
function treePine(seed) {
  const parts = [];
  parts.push({ g: paintBark(trunkG(0.34, 0.16, 9.4, 6, 0.06), 9.4) });
  const PD = WPAL.pinD, PL = WPAL.pinL;
  for (let i = 0; i < 7; i++) {
    const y = 1.85 + i * 1.24, r = 2.95 - i * 0.335;
    const cg = coneRingG(r, 2.55, seed * 3.7 + i * 11.3);
    parts.push({ g: paintCanopy(cg, y, r, PD, PL, 0.5), m: trs(0, y, 0, i * 1.37 + seed * 2.1),
                 w: (x, yy) => clamp((y + yy - 3) / 8, 0, 1) * 0.7, leaf: 1 });
  }
  return baseBleed(mergeParts(parts), 0.08, 0.45);
}
function bushG(seed) {
  const parts = [];
  const BD = WPAL.busD, BL = WPAL.busL;
  // low sprawling mound, not a boulder: small lobes on a tight spread, well squashed
  for (let i = 0; i < 6; i++) {
    const a = i * 1.63 + seed, r = 0.40 + (i % 3) * 0.16;
    parts.push({ g: paintCanopy(lobeG(r, 0.60, seed + i * 2.7), r, r, BD, BL, 0.8),
      m: trs(Math.cos(a) * 0.36, r * 0.56, Math.sin(a) * 0.36, a), w: () => 1, leaf: 1 });
  }
  return baseBleed(mergeParts(parts), 0.18, 0.42);
}
// ══ built structures ══
// ── vertex-colour helpers ─────────────────────────────────────────────────────
// paintTex() bakes a ~1.0 MULTIPLIER (for meshes that carry a canvas texture);
// paintFlat() bakes an ABSOLUTE linear colour (for untextured pieces).
function paintTex(g, tint, jitter, aoK) {
  const t = tint === undefined ? 1 : tint, j = jitter === undefined ? 0.26 : jitter, a = aoK === undefined ? 0.30 : aoK;
  return paint(g, (c, x, y, z) => {
    const v = (1 - j * 0.5 + j * vnz(x * 3.4 + z * 1.9, y * 2.7)) * t;
    const dn = (1 - a) + a * clamp(y * 0.28 + 0.55, 0, 1);
    c.setRGB(v * dn, v * dn, v * dn);
  });
}
const paintWood = (g, tint) => paintTex(g, tint === undefined ? 1 : tint, 0.30, 0.22);
const paintStone = (g, tint) => paintTex(g, tint === undefined ? 1 : tint, 0.22, 0.34);
function paintFlat(g, col, jitter) {
  const j = jitter === undefined ? 0.16 : jitter;
  return paint(g, (c, x, y, z) => {
    const v = 1 - j * 0.5 + j * vnz(x * 6.2 + z * 2.7, y * 5.4);
    c.setRGB(col[0] * v, col[1] * v, col[2] * v);
  });
}
// gabled roof: two sloped slabs + ridge + gable ends (span across z, length along x)
function gableRoof(span, len, rise, tint) {
  const parts = [], ang = Math.atan2(rise, span / 2), slope = Math.hypot(span / 2, rise);
  for (const s of [-1, 1]) {
    parts.push({ g: paintTex(boxG(len, 0.26, slope * 1.03), tint, 0.20, 0.10),
      m: trs(0, rise / 2, s * span / 4, 0, 1, 1, 1, s * ang, 0) });
  }
  parts.push({ g: paintTex(boxG(len * 1.03, 0.34, 0.44), tint * 0.9, 0.16, 0.05), m: trs(0, rise + 0.10, 0) });  // ridge
  for (const s of [-1, 1]) {                                     // gable end boards
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -span / 2, 0, 0, span / 2, 0, rise, 0], 3));
    // the raw winding faces -x; flip it on the +x end or that gable is a backface and
    // you see straight through the roof into the (lit) interior
    tg.setIndex(s < 0 ? [0, 1, 2] : [0, 2, 1]); tg.computeVertexNormals();
    parts.push({ g: paintTex(tg, tint * 0.72, 0.10, 0.0), m: trs(s * len * 0.505, 0, 0) });
  }
  return parts;
}
function houseParts(w, d, h, seed) {
  const P = { plaster: [], timber: [], roof: [] };
  P.plaster.push({ g: paintTex(boxG(d, h, w), 1, 0.20, 0.34), m: trs(0, h / 2, 0) });
  // timber frame: sill, top plate, corner posts, studs, braces
  const T = 0.17;
  for (const s of [-1, 1]) {
    P.timber.push({ g: paintWood(boxG(d + 0.06, T * 1.5, T * 1.5)), m: trs(0, 0.12, s * w / 2) });
    P.timber.push({ g: paintWood(boxG(d + 0.06, T * 1.5, T * 1.5)), m: trs(0, h - 0.14, s * w / 2) });
    P.timber.push({ g: paintWood(boxG(T * 1.5, T * 1.5, w + 0.06)), m: trs(s * d / 2, 0.12, 0) });
    P.timber.push({ g: paintWood(boxG(T * 1.5, T * 1.5, w + 0.06)), m: trs(s * d / 2, h - 0.14, 0) });
    for (const s2 of [-1, 1]) P.timber.push({ g: paintWood(boxG(T * 1.4, h, T * 1.4)), m: trs(s * (d / 2 - 0.02), h / 2, s2 * (w / 2 - 0.02)) });
  }
  const studs = Math.max(2, Math.round(w / 1.5));
  for (let i = 1; i < studs; i++) {
    const zz = -w / 2 + i * (w / studs);
    for (const s of [-1, 1]) P.timber.push({ g: paintWood(boxG(T, h - 0.3, T)), m: trs(s * (d / 2 + 0.01), h / 2, zz) });
  }
  for (const s of [-1, 1]) P.timber.push({ g: paintWood(boxG(T, h * 0.95, T)), m: trs(s * (d / 2 + 0.02), h / 2, w * 0.2 * s, 0, 1, 1, 1, 0.55, 0) });
  // door + shutter
  P.timber.push({ g: paintWood(boxG(0.12, h * 0.54, 0.98), 0.62), m: trs(d / 2 + 0.06, h * 0.27, 0.1) });
  P.timber.push({ g: paintWood(boxG(0.10, 0.62, 0.78), 0.48), m: trs(-d / 2 - 0.05, h * 0.62, -w * 0.2) });
  for (const p of gableRoof(w + 1.1, d + 0.8, h * 0.60, 1))
    P.roof.push({ g: p.g, m: new THREE.Matrix4().multiplyMatrices(trs(0, h, 0), p.m) });
  // chimney
  P.plaster.push({ g: paintTex(boxG(0.66, h * 0.60 + 1.5, 0.66), 0.74, 0.24, 0.20), m: trs(-d * 0.28, h + (h * 0.60 + 1.5) / 2 - 0.4, w * 0.30) });
  return P;
}

// ══ terrain splat material (patched MeshStandardMaterial — keeps lights + shadows) ══
// Snow lies where the ground is level and unwalked: it drifts by the same noise the grass
// splat uses (so the patches follow the terrain's own shapes), thins on slopes, and is
// scraped off the road by traffic. Empty string on maps whose palette has snow: 0, which
// keeps the Vale's shader source untouched.
const SNOW_GLSL = WPAL.snow > 0 ? `
    {
      float lie = smoothstep(0.62, 0.97, vWN.y);
      float drift = smoothstep(0.30, 0.78, nM*0.46 + nL*0.34 + nS*0.20 + vWP.y*0.0090);
      float snw = lie * drift * (0.55 + 0.45*nF) * ${WPAL.snow};
      snw *= 1.0 - 0.86*tRoad;                       // wheels and boots keep the road bare
      vec3 sc = ${v3s(WPAL.snowC)} * (0.80 + 0.34*nG) * (0.90 + 0.22*nX);
      alb = mix(alb, sc, clamp(snw, 0.0, 1.0));
      // crust glitter: a few grains catch the low sun, which is what stops flat snow
      // reading as grey paper at overview zoom
      alb += vec3(0.055,0.060,0.070)*smoothstep(0.86,0.99, nG)*snw;
    }
` : '';
const TERRAIN_ALBEDO = `
  float tRock = 0.0, tRoad = 0.0;
  {
    vec2 wxz = vWP.xz;
    float nL = fbm2(wxz*0.0185 + 61.0);      // ~55u regions
    float nM = fbm2(wxz*0.082  + 17.0);      // ~12u patches
    float nS = fbm2(wxz*0.290  +  5.0);      // ~3.5u clumps (carries the read at gameplay zoom)
    float nF = vn2 (wxz*1.05   +  3.0);      // ~1u grain
    float nX = fbm3(wxz*2.60   + 23.0);      // ~0.4u micro
    // ~0.22u: coarse enough to survive at gameplay zoom instead of aliasing to mush
    float nG = vn2 (wxz*4.60   + 71.0);
    float slope = 1.0 - clamp(vWN.y, 0.0, 1.0);

    // rock by slope, PLUS by altitude — the escarpment crest is a rounded (low-slope)
    // surface, and leaving it grassy makes 50u granite cliffs read as green hills.
    float alt = smoothstep(13.0, 27.0, vWP.y) * (0.72 + 0.42*nM);
    tRock = max(smoothstep(0.26,0.50, slope + (nM-0.5)*0.26), clamp(alt,0.0,1.0));

    // ── meadow: saturated valley greens, luminance driven by the 3u clump layer ──
    vec3 gDark = ` + v3s(WPAL.gDark) + `;
    vec3 gMid  = ` + v3s(WPAL.gMid) + `;
    vec3 gLit  = ` + v3s(WPAL.gLit) + `;
    float gk = clamp(0.15 + 0.27*nS + 0.53*nM + 0.40*(nL-0.5), 0.0, 1.0);
    vec3 grass = gk < 0.5 ? mix(gDark, gMid, gk*2.0) : mix(gMid, gLit, (gk-0.5)*2.0);
    grass *= 0.76 + 0.48*nF;
    grass *= 0.88 + 0.24*nG;
    grass.r += 0.048*smoothstep(0.50,0.96,gk);            // sun-bleached tips warm up
    grass.b += 0.015*smoothstep(0.45,0.05,gk);            // deep grass goes cool

    // ── dry / grazed patches (the reference meadow is never one flat green) ──
    // Driven by a ~33u fBm (nB) so the patches arrive at MEADOW scale — big enough to
    // read as pasture, not as the 3u speckle the old mask produced. ~28% coverage.
    float nB = fbm2(wxz*0.030 + 133.0);
    vec3 dry = mix(` + v3s(WPAL.dry0) + `, ` + v3s(WPAL.dry1) + `, nM*0.6+nS*0.4);
    float dryM = smoothstep(0.44,0.72, nB*0.70 + nL*0.20 + nM*0.10) * (0.55 + 0.45*nS);
    vec3 soil = mix(grass, dry, clamp(dryM, 0.0, 1.0)*0.92);
    // bare earth showing through in the thinnest spots
    soil = mix(soil, ` + v3s(WPAL.bare) + `, smoothstep(0.74,0.95, dryM*0.6 + nS*0.4)*0.60);

    // ── worn dirt road: dark packed centre, cut ruts, earth verge ──
    // d = lateral distance normalised by the half width, so the centre/rut/verge bands
    // stay put wherever the spline wanders.
    float lat = abs(vRD.y);
    float dN = clamp(lat / 2.55, 0.0, 2.0);
    vec3 dirt = mix(` + v3s(WPAL.dirt0) + `, ` + v3s(WPAL.dirt1) + `, smoothstep(0.10,3.30,lat));
    float rut  = smoothstep(0.06,0.0, abs(dN-0.35));     // two cut wheel tracks
    float crown= smoothstep(0.95,0.10, lat);             // packed crown between them
    dirt *= mix(0.72, 1.0, smoothstep(0.0,0.45,dN));     // hard-packed, darker centre
    dirt *= 1.0 - 0.15*rut;
    dirt *= 1.0 + 0.10*crown;
    dirt *= 0.88 + 0.26*fbm2(wxz*0.40 + 41.0);          // slow patchiness
    dirt *= 0.88 + 0.26*vn2(vec2(vRD.y*6.4, 3.7));      // longitudinal wheel-wear streaks
    dirt *= 0.94 + 0.12*nS;
    dirt += vec3(0.028,0.025,0.020)*smoothstep(0.82,0.98, vn2(wxz*2.4));   // pebbles
    // dither the road/grass boundary with BOTH a fine and a macro octave — a single soft
    // ramp gives an airbrushed stripe, which is exactly what the road used to read as
    tRoad = smoothstep(0.10,0.74, clamp(vRD.x*1.36 - 0.14
              + (fbm2(wxz*0.62+9.0)-0.5)*0.78 + (fbm2(wxz*0.11+77.0)-0.5)*0.46, 0.0, 1.0));
    // trampled verge: grass thins into dust for a couple of metres either side
    soil = mix(soil, mix(soil*0.82, dry*1.00, 0.60), smoothstep(0.02,0.66,vRD.x));
    vec3 alb = mix(soil, dirt, tRoad);

    // ── layered granite, TRIPLANAR (an xz-only projection smears on vertical cliff faces) ──
    if (tRock > 0.004) {
      vec3 aw = abs(vWN); aw = pow(aw, vec3(3.5)); aw /= (aw.x + aw.y + aw.z + 1e-4);
      vec2 pA = vWP.zy, pB = vWP.xz, pC = vWP.xy;
      float w0 = fbm2(pA*0.050+21.0)*aw.x + fbm2(pB*0.050+21.0)*aw.y + fbm2(pC*0.050+21.0)*aw.z;
      float d1 = fbm2(pA*0.520)*aw.x + fbm2(pB*0.520)*aw.y + fbm2(pC*0.520)*aw.z;
      float d2 = fbm2(pA*1.850)*aw.x + fbm2(pB*1.850)*aw.y + fbm2(pC*1.850)*aw.z;
      float d3 = vn2 (pA*5.400)*aw.x + vn2 (pB*5.400)*aw.y + vn2 (pC*5.400)*aw.z;
      // strata: two interleaved band scales, heavily warped so they read as bedded
      // rock rather than contour lines where the heightfield goes smooth
      // Keep the warp UNDER about one band width. Beyond that the courses stop reading
      // as horizontal bedding and turn into marbled camouflage veins.
      float warp = (w0-0.5)*1.85 + (d1-0.5)*0.62 + (d2-0.5)*0.22;
      // bed SPACING varies by region too, or the whole rim reads as one corduroy sheet
      float bnd = fract(vWP.y*(0.086 + 0.062*w0) + warp);
      float bs  = smoothstep(0.14,0.42,bnd)*smoothstep(0.96,0.62,bnd);
      float joint = clamp(smoothstep(0.060,0.0,bnd) + smoothstep(0.940,1.0,bnd), 0.0, 1.0);
      float bn2 = fract(vWP.y*0.470 + warp*2.6 + (d3-0.5)*0.55);
      float bs2 = smoothstep(0.16,0.50,bn2)*smoothstep(0.96,0.58,bn2);
      vec3 rA = ` + v3s(WPAL.rockA) + `;              // shaded / weathered course
      vec3 rB = ` + v3s(WPAL.rockB) + `;              // exposed granite
      vec3 rock = mix(rA, rB, 0.20 + 0.80*bs);
      rock *= 0.84 + 0.32*bs2;                                          // fine bedding
      rock *= 1.0 - 0.34*joint;                                         // dark bedding planes
      rock *= 0.50 + 1.00*w0;                                           // buttress-scale masses
      rock *= 0.62 + 0.78*d1;
      rock *= 0.76 + 0.46*d2;
      rock *= 0.86 + 0.30*d3;
      rock += vec3(0.040,0.036,0.028)*smoothstep(0.72,0.97, d3);       // mica glints
      // rust / lichen staining in the gullies keeps the grey from going dead concrete
      rock = mix(rock, rock*` + v3s(WPAL.rockWarm) + `, smoothstep(0.50,0.84, fbm2(pB*0.42+31.0))*0.44);
      rock = mix(rock, rock*` + v3s(WPAL.rockCool) + `, smoothstep(0.52,0.86, fbm2(pC*0.115+13.0))*0.36);
      float moss = smoothstep(0.30,0.82, vWN.y) * smoothstep(0.34,0.68, fbm2(wxz*0.150+55.0));
      rock = mix(rock, ` + v3s(WPAL.moss) + `, moss*0.90);
      alb = mix(alb, rock, tRock);
    }
    // scree / dust apron where the slope steepens but rock hasn't taken over
    alb = mix(alb, mix(` + v3s(WPAL.scree) + `, alb, 0.50), smoothstep(0.16,0.34,slope)*(1.0-tRock)*0.60);
` + SNOW_GLSL + `
    alb *= 0.86 + 0.30*nX;
    // baked contact AO from every scattered prop — this is what puts them IN the ground
    {
      float pao = texture2D(uPAO, (vWP.xz + vec2(${(FW / 2).toFixed(1)}, ${(FD / 2).toFixed(1)})) / vec2(${FW.toFixed(1)}, ${FD.toFixed(1)})).r;
      alb *= 1.0 - 0.55*clamp(pao, 0.0, 1.0);
    }
    // the map edge falls away into shadow — keyed well below the valley floor so the
    // meadow's own hollows (which dip to about -5) never darken.
    alb *= 1.0 - 0.94*smoothstep(-15.0,-44.0,vWP.y);
    diffuseColor.rgb *= alb * (0.34 + 0.66*vAOf);
  }
`;
const terrainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
terrainMat.customProgramCacheKey = () => 'bf_terrain';
terrainMat.onBeforeCompile = (sh) => {
  sh.uniforms.uPAO = { value: paoTex };
  sh.vertexShader = 'attribute vec2 aRoad;\nattribute float aAO;\nvarying vec3 vWP;\nvarying vec3 vWN;\nvarying vec2 vRD;\nvarying float vAOf;\n' +
    sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n vWP = (modelMatrix*vec4(transformed,1.0)).xyz;\n vWN = normalize(mat3(modelMatrix)*normal);\n vRD = aRoad;\n vAOf = aAO;');
  sh.fragmentShader = 'varying vec3 vWP;\nvarying vec3 vWN;\nvarying vec2 vRD;\nvarying float vAOf;\nuniform sampler2D uPAO;\n' + NOISE_GLSL +
    sh.fragmentShader
      .replace('#include <map_fragment>', TERRAIN_ALBEDO)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * mix(1.0, 0.74, tRock) * mix(1.0, 0.63, tRoad);')
      // derivative bump: gives grass/dirt/rock real surface relief that catches the low sun
      .replace('#include <normal_fragment_maps>', `
      {
        vec2 q = vWP.xz;
        // NOTE: this is an xz-projected gradient, so it must stay near zero on the near-vertical
        // cliff faces (tRock) or it smears into vertical streaks. Rock relief comes from the
        // heightfield ribs + the triplanar albedo instead.
        float fk = 1.0 - tRock;                                // ('flat' is a reserved word)
        float wF = fk*(1.0-tRoad)*7.0 + tRoad*0.55;            // fine grass/soil relief
        float wC = fk*(0.75 + tRoad*0.95);                      // coarse ground undulation
        vec2 e = vec2(0.26, 0.0), E = vec2(1.7, 0.0);
        float f0 = fbm2(q*1.85) + 0.55*vn2(q*5.20) + 0.30*vn2(q*13.0);
        float fx = fbm2((q+e.xy)*1.85) + 0.55*vn2((q+e.xy)*5.20) + 0.30*vn2((q+e.xy)*13.0);
        float fz = fbm2((q+e.yx)*1.85) + 0.55*vn2((q+e.yx)*5.20) + 0.30*vn2((q+e.yx)*13.0);
        float c0 = fbm2(q*0.30 + 66.0), cx = fbm2((q+E.xy)*0.30 + 66.0), cz = fbm2((q+E.yx)*0.30 + 66.0);
        vec2 grad = vec2(fx-f0, fz-f0)*wF + vec2(cx-c0, cz-c0)*wC;
        vec3 wn = normalize(vWN - vec3(grad.x, 0.0, grad.y));
        normal = normalize((viewMatrix*vec4(wn,0.0)).xyz);
      }`);
};

// ══ sky-derived IBL (plain equirect canvas — the renderer PMREMs it internally) ══
{
  const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, H);
  const IB = WPAL.ibl, IST = [0.00, 0.30, 0.47, 0.52, 0.62, 1.00];
  for (let i = 0; i < 6; i++) gr.addColorStop(IST[i], IB[i]);
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  const phi = Math.atan2(SUNDIR.z, SUNDIR.x), th = Math.acos(clamp(SUNDIR.y, -1, 1));
  const sx = (phi + Math.PI) / (Math.PI * 2) * W, sy = th / Math.PI * H;
  const sg = g.createRadialGradient(sx, sy, 1, sx, sy, 46);
  const SD = WPAL.disc;
  sg.addColorStop(0, SD[0]); sg.addColorStop(0.35, SD[1]); sg.addColorStop(1, SD[2]);
  g.fillStyle = sg; g.fillRect(0, 0, W, H);
  const et = new THREE.CanvasTexture(c);
  et.colorSpace = THREE.SRGBColorSpace; et.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = et; scene.environmentIntensity = WPAL.envI;
  // POLISH: the visible sky is only the narrow band just above the cliff crest, and a flat
  // fill colour read there as dead paper. Same equirect trick, hazed down hard so it joins
  // the lowland band instead of announcing a blue sky behind an aerial-perspective vista.
  const bc = document.createElement('canvas'); bc.width = 8; bc.height = H;
  const bg2 = bc.getContext('2d'), bgr = bg2.createLinearGradient(0, 0, 0, H);
  const BG = WPAL.bgGrad, BST = [0.00, 0.26, 0.42, 0.50, 0.60, 1.00];
  for (let i = 0; i < 6; i++) bgr.addColorStop(BST[i], BG[i]);
  bg2.fillStyle = bgr; bg2.fillRect(0, 0, 8, H);
  const bt = new THREE.CanvasTexture(bc);
  bt.colorSpace = THREE.SRGBColorSpace; bt.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = bt;
}

// ══ the world beyond the diorama ══════════════════════════════════════════════
// The playfield sits on a plateau high above a hazy lowland. Everything here is
// unlit, unfogged, self-hazed vertex colour on MeshBasicMaterial — 3 draw calls that
// buy the whole aerial-perspective read and stop the map looking like a floating slab.
// (Scene fog is deliberately off on these: baking the haze by hand gives exact control
// over how each distance band separates.)
const FAR_Y = -122;                                  // lowland floor
const HAZE = WPAL.hazeV;
const farMat = () => new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
const hz = (out, base, k) => { for (let i = 0; i < 3; i++) out[i] = lerp(base[i], HAZE[i], k); };
const _c3 = [0, 0, 0];
{ // ── lowland floor: a wide annulus of hazed fields/woods far below the plateau ──
  const NR = 14, NA = 132, RAD = [88, 106, 126, 150, 176, 206, 240, 278, 320, 368, 424, 490, 560, 660];
  const pos = new Float32Array(NR * NA * 3), col = new Float32Array(NR * NA * 3);
  const idx = new Uint32Array((NR - 1) * NA * 6);
  let o = 0;
  for (let r = 0; r < NR; r++) for (let i = 0; i < NA; i++) {
    const a = i / NA * Math.PI * 2, R = RAD[r], k = i * NR + r;
    const x = R * Math.cos(a), z = R * Math.sin(a);
    pos[k * 3] = x; pos[k * 3 + 1] = FAR_Y - Math.max(0, 3 - r) * 9; pos[k * 3 + 2] = z;
    const wood = fbmz(x * 0.020 + 4.1, z * 0.020 - 7.3, 4);
    const fld = fbmz(x * 0.052 + 31.7, z * 0.052 + 11.9, 2);
    const rvr = sstep(0.46, 0.50, fbmz(x * 0.011 + 61.3, z * 0.011 - 19.7, 2)) * sstep(0.54, 0.50, fbmz(x * 0.011 + 61.3, z * 0.011 - 19.7, 2));
    const g0 = lerp(0.022, 0.135, sstep(0.28, 0.74, wood)) * (0.66 + 0.68 * fld);
    _c3[0] = g0 * WPAL.lowG[0]; _c3[1] = g0 * WPAL.lowG[1]; _c3[2] = g0 * WPAL.lowG[2];
    if (rvr > 0.05) for (let q = 0; q < 3; q++) _c3[q] = lerp(_c3[q], WPAL.lowRiv[q], rvr);
    hz(_c3, _c3, clamp(0.18 + (R - 88) / 400 * 0.56, 0, 0.74));
    col[k * 3] = _c3[0]; col[k * 3 + 1] = _c3[1]; col[k * 3 + 2] = _c3[2];
  }
  for (let r = 0; r < NR - 1; r++) for (let i = 0; i < NA; i++) {
    const j = (i + 1) % NA, A = i * NR + r, B = A + 1, C = j * NR + r, D = C + 1;
    idx[o++] = A; idx[o++] = B; idx[o++] = D; idx[o++] = A; idx[o++] = D; idx[o++] = C;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, farMat()); m.frustumCulled = false; m.name = 'LOWLAND';
  m.renderOrder = -8; scene.add(m);
}
// ── distant ridge bands rising out of the lowland ──
function ridgeBand(rad, N, yMin, yMax, seed, rock, haze) {
  const pos = new Float32Array(N * 6), col = new Float32Array(N * 6), idx = new Uint32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    let n = 0.46 * fbmz(ca * 2.1 + seed, sa * 2.1 + seed * 1.3, 3)
          + 0.34 * fbmz(ca * 6.3 + seed * 2.1, sa * 6.3 + seed * 0.7, 3)
          + 0.20 * fbmz(ca * 16.0 + seed * 3.3, sa * 16.0 + seed * 2.7, 2);
    n = clamp((n - 0.24) / 0.52, 0, 1);
    const h = yMin + (yMax - yMin) * Math.pow(n, 1.30);
    const r = rad * (0.86 + 0.26 * fbmz(ca * 1.35 + seed * 5.1, sa * 1.35 + seed * 4.3, 2));
    const sunF = clamp(0.86 * ca - 0.51 * sa, 0, 1);        // sun bears from -x / +z
    const b = i * 2, t = b + 1;
    pos[b * 3] = r * ca; pos[b * 3 + 1] = FAR_Y - 30; pos[b * 3 + 2] = r * sa;
    pos[t * 3] = r * ca; pos[t * 3 + 1] = h;              pos[t * 3 + 2] = r * sa;
    for (let k = 0; k < 3; k++) {
      _c3[k] = rock[k] * (0.62 + 0.55 * sunF) * (0.86 + 0.30 * n);
      col[t * 3 + k] = lerp(_c3[k], HAZE[k], haze);
      col[b * 3 + k] = lerp(_c3[k] * 0.72, HAZE[k], Math.min(0.97, haze + 0.16));
    }
    const j = (i + 1) % N, o = i * 6;
    idx[o] = b; idx[o + 1] = t; idx[o + 2] = j * 2 + 1;
    idx[o + 3] = b; idx[o + 4] = j * 2 + 1; idx[o + 5] = j * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, farMat());
  m.frustumCulled = false; m.name = 'RIDGE'; m.renderOrder = -7;
  return m;
}
// Tops sit well below the plateau: from the game's high camera the only sightlines
// that leave the valley are steeply downward, so ridges that rise above y=0 would
// never appear at all.
scene.add(
  ridgeBand(238, 150, -104, -44, 3.1, WPAL.ridge[0], 0.32),
  ridgeBand(322, 120, -110, -54, 8.7, WPAL.ridge[1], 0.54),
  ridgeBand(410, 96, -116, -46, 5.3, WPAL.ridge[2], 0.72));

// ══════════════════════════════ World.build() ══════════════════════════════
const ROAD_HALF = 2.55;
const HOUSE_SITES = MAP.houses;
World.build = function () {
  // ── 1. extended road centrelines, ALL routes (road continues out through each gate) ──
  // XP is every route's polyline laid end to end; XS records each route's span so tangents
  // and the road-bed height profile are never smoothed ACROSS a junction. A map with one
  // route produces exactly the array the Vale always built.
  const XP = [], XS = [];
  for (let r = 0; r < PTS.length; r++) {
    const T = PTS[r], stepL = T.len / PATH_N, EXT = Math.round(30 / stepL);
    const p0 = T.pos[0], t0 = T.tan[0], pN = T.pos[PATH_N], tN = T.tan[PATH_N];
    const start = XP.length;
    if (SPAWN_R.indexOf(r) >= 0)                      // only a real gate gets a run-out
      for (let i = EXT; i >= 1; i--) XP.push([p0.x - t0.x * stepL * i, p0.z - t0.z * stepL * i]);
    for (let i = 0; i <= PATH_N; i++) XP.push([T.pos[i].x, T.pos[i].z]);
    if (ROUTE_DEF[r].to === undefined)
      for (let i = 1; i <= EXT; i++) XP.push([pN.x + tN.x * stepL * i, pN.z + tN.z * stepL * i]);
    XS.push([start, XP.length - 1]);
  }
  const segOf = (i) => { for (let r = 0; r < XS.length; r++) if (i <= XS[r][1]) return XS[r]; return XS[XS.length - 1]; };
  const XN = XP.length, XT = [];
  for (let i = 0; i < XN; i++) {
    const sg = segOf(i);
    const a = XP[Math.max(sg[0], i - 1)], b = XP[Math.min(sg[1], i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1;
    XT.push([dx / l, dz / l]);
  }
  // ── 2. signed lateral distance + along-parameter fields ──────────────────────
  SDG = new Float32Array(GX * GZ); TDG = new Float32Array(GX * GZ);
  const RMG = new Float32Array(GX * GZ), BMG = new Float32Array(GX * GZ);
  const nearest = (x, z) => {
    let bi0 = 0, bq = 1e18;
    for (let i = 0; i < XN; i += 8) { const dx = x - XP[i][0], dz = z - XP[i][1], q = dx * dx + dz * dz; if (q < bq) { bq = q; bi0 = i; } }
    const lo = Math.max(0, bi0 - 9), hi = Math.min(XN - 1, bi0 + 9);
    for (let i = lo; i <= hi; i++) { const dx = x - XP[i][0], dz = z - XP[i][1], q = dx * dx + dz * dz; if (q < bq) { bq = q; bi0 = i; } }
    return bi0;
  };
  const halfW = (i) => ROAD_HALF + (fbmz(i * 0.026, 4.7, 3) - 0.5) * 1.5;
  for (let iz = 0; iz < GZ; iz++) for (let ix = 0; ix < GX; ix++) {
    const x = -FW / 2 + ix * GSx, z = -FD / 2 + iz * GSz, k = iz * GX + ix;
    const i = nearest(x, z), c = XP[i], t = XT[i];
    const sd = -t[1] * (x - c[0]) + t[0] * (z - c[1]);
    const dist = Math.hypot(x - c[0], z - c[1]);
    const hw = halfW(i);
    SDG[k] = clamp(Math.abs(sd) > dist ? Math.sign(sd) * dist : sd, -40, 40);
    TDG[k] = i;
    BMG[k] = sstep(hw + 2.7, hw - 0.5, dist);          // height-carving mask
    RMG[k] = sstep(hw + 3.5, hw - 0.7, dist);          // albedo paint mask
  }
  // ── 3. base heights, then a smoothed road-bed profile, then flattened pads ──
  const notchAt = (dist) => sstep(19.0, 7.0, dist);   // gorge wide enough to see the gates in
  const baseH = (x, z) => {
    const i = nearest(x, z), c = XP[i];
    const d = Math.hypot(x - c[0], z - c[1]);
    return meadowH(x, z) + cliffH(x, z, notchAt(d));
  };
  HG = new Float32Array(GX * GZ);
  for (let iz = 0; iz < GZ; iz++) for (let ix = 0; ix < GX; ix++) {
    const x = -FW / 2 + ix * GSx, z = -FD / 2 + iz * GSz, k = iz * GX + ix;
    const c = XP[TDG[k]], d = Math.hypot(x - c[0], z - c[1]);
    HG[k] = meadowH(x, z) + cliffH(x, z, notchAt(d));
  }
  const rawY = new Float32Array(XN), roadY = new Float32Array(XN);
  for (let i = 0; i < XN; i++) rawY[i] = bi(HG, XP[i][0], XP[i][1]);
  for (let i = 0; i < XN; i++) { const sg = segOf(i); let s = 0, n = 0; for (let j = -9; j <= 9; j++) { const k = clamp(i + j, sg[0], sg[1]); s += rawY[k]; n++; } roadY[i] = s / n; }
  for (let iz = 0; iz < GZ; iz++) for (let ix = 0; ix < GX; ix++) {
    const k = iz * GX + ix, m = BMG[k];
    if (m > 0.001) {
      // genuinely carved bed: the centre sits lower than the verges, so the road holds a
      // shadow of its own instead of being a stripe painted on flat ground
      const dN = clamp(Math.abs(SDG[k]) / ROAD_HALF, 0, 1);
      HG[k] = lerp(HG[k], roadY[TDG[k]] - 0.34 - 0.16 * (1 - dN * dN), m);
    }
  }
  // flat pads: house sites + gate aprons. (Free placement replaced the fixed build plots,
  // so the meadow is NOT pre-flattened for towers any more — G.canPlace() gates slope and
  // placeTower() sinks a tower to its footprint's lowest sample instead.)
  World.pads = [];
  for (const [hx, hz] of HOUSE_SITES) World.pads.push([hx, hz, 4.6, 3.0]);
  // Gates: one crag arch per SPAWN route, one keep barbican at route 0's far end.
  World.spawnG = SPAWN_R.map(r => {
    const T = PTS[r], g0 = T.pos[0], t0 = T.tan[0];
    return { x: g0.x - t0.x * 2.5, z: g0.z - t0.z * 2.5, rx: t0.x, rz: t0.z };
  });
  const gB = PT.pos[PATH_N], tB = PT.tan[PATH_N];
  World.gateIn = World.spawnG[0];                   // compat alias: the first spawn gate
  World.gateOut = { x: gB.x + tB.x * 4.5, z: gB.z + tB.z * 4.5, rx: tB.x, rz: tB.z };
  G.spawnGates = World.spawnG; G.keepGate = World.gateOut;
  for (const sg of World.spawnG) World.pads.push([sg.x, sg.z, 7, 4.5]);
  World.pads.push([World.gateOut.x, World.gateOut.z, 7.5, 4.5]);
  for (const [px, pz, pr, pf] of World.pads) {
    const py = bi(HG, px, pz);
    const i0 = Math.max(0, Math.floor((px - pr - pf + FW / 2) / GSx)), i1 = Math.min(GX - 1, Math.ceil((px + pr + pf + FW / 2) / GSx));
    const j0 = Math.max(0, Math.floor((pz - pr - pf + FD / 2) / GSz)), j1 = Math.min(GZ - 1, Math.ceil((pz + pr + pf + FD / 2) / GSz));
    for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) {
      const x = -FW / 2 + ix * GSx, z = -FD / 2 + iz * GSz, k = iz * GX + ix;
      const m = sstep(pr + pf, pr, Math.hypot(x - px, z - pz));
      if (m > 0.001) HG[k] = lerp(HG[k], py, m);
    }
  }
  // ── 4. vertex AO from the heightfield (grounding for cliffs, road cuts, pads) ──
  AOG = new Float32Array(GX * GZ);
  const RADS = [1.7, 4.0, 9.0, 19.0], DIRS = 10;
  for (let iz = 0; iz < GZ; iz++) for (let ix = 0; ix < GX; ix++) {
    const x = -FW / 2 + ix * GSx, z = -FD / 2 + iz * GSz, k = iz * GX + ix, h = HG[k];
    let occ = 0;
    for (let a = 0; a < DIRS; a++) {
      const ang = a / DIRS * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      let mx = 0;
      for (const r of RADS) mx = Math.max(mx, (bi(HG, x + cs * r, z + sn * r) - h) / r);
      occ += clamp(mx, 0, 1.1);
    }
    AOG[k] = clamp(1 - occ / DIRS * 1.05, 0.28, 1);
  }
  // ── 5. terrain mesh ─────────────────────────────────────────────────────────
  {
    const MX = Q.segs + 1, MZ = Math.round(Q.segs * FD / FW) + 1, NV = MX * MZ;
    const pos = new Float32Array(NV * 3), rd = new Float32Array(NV * 2), ao = new Float32Array(NV);
    const cull = new Uint8Array(NV);
    for (let iz = 0; iz < MZ; iz++) for (let ix = 0; ix < MX; ix++) {
      const x = -FW / 2 + ix / (MX - 1) * FW, z = -FD / 2 + iz / (MZ - 1) * FD, k = iz * MX + ix;
      pos[k * 3] = x; pos[k * 3 + 1] = bi(HG, x, z); pos[k * 3 + 2] = z;
      rd[k * 2] = bi(RMG, x, z); rd[k * 2 + 1] = clamp(bi(SDG, x, z), -9, 9);
      ao[k] = bi(AOG, x, z);
      cull[k] = cullFar(x, z, bi(SDG, x, z)) ? 1 : 0;
    }
    const idx = new Uint32Array((MX - 1) * (MZ - 1) * 6);
    let o = 0;
    for (let iz = 0; iz < MZ - 1; iz++) for (let ix = 0; ix < MX - 1; ix++) {
      const a = iz * MX + ix, b = a + 1, c = a + MX, d = c + 1;
      if (cull[a] && cull[b] && cull[c] && cull[d]) continue;      // beyond the diorama edge
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('aRoad', new THREE.BufferAttribute(rd, 2));
    tg.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    tg.setIndex(new THREE.BufferAttribute(idx.subarray(0, o), 1));
    tg.computeVertexNormals();
    const terrain = new THREE.Mesh(tg, terrainMat);
    terrain.name = 'GROUND'; terrain.receiveShadow = true; terrain.castShadow = true;
    World.group.add(terrain); World.terrain = terrain;
  }
  // ── 5b. diorama plinth ──────────────────────────────────────────────────────
  // Without this the heightfield simply STOPS just past the rim and the frame edges
  // show bare sky — the map reads as a floating island. This is a sheer stratified
  // wall hung off the crest that plunges out of frame, so every sightline that leaves
  // the playfield lands on rock falling into shadow. Baked shading (MeshBasicMaterial
  // + scene fog) = 1 draw call, no shadow-map cost.
  {
    const N = 288, ROWS = [0.5, -3, -8.5, -17, -30, -50, -82, -140, -230, -340], NR = ROWS.length;
    const pos = new Float32Array(N * NR * 3), col = new Float32Array(N * NR * 3);
    const idx = new Uint32Array(N * (NR - 1) * 6);
    let o = 0;
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2;
      const pr = rimProfile(...seP(a, 1));
      const p = seP(a, pr.start + 0.070), x = p[0], z = p[1];
      // hang the wall off the LOCAL CREST, not the sample point — otherwise grazing
      // sightlines skim over the top of the wall and hit bare sky beyond.
      let top = -1e9, lo = 1e9, sd = 1e9;
      for (let s = 0; s <= 5; s++) {
        const q = seP(a, pr.start + 0.018 + s * 0.016), hq = bi(HG, q[0], q[1]);
        top = Math.max(top, hq); lo = Math.min(lo, hq); sd = Math.min(sd, Math.abs(bi(SDG, q[0], q[1])));
      }
      // Inside the gate corridors the road continues out through the gorge, so the wall
      // has to be BURIED there — otherwise it stands up as a black bar across the road.
      top = sd < 17 ? lo - 9 : top + 0.6;
      const sunF = clamp(-0.86 * Math.cos(a) - 0.51 * Math.sin(a), 0, 1);  // faces the sun?
      for (let r = 0; r < NR; r++) {
        const k = i * NR + r, y = top + ROWS[r];
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        const dep = clamp(-ROWS[r] / 46, 0, 1);
        const st = fbmz(a * 34 + 3.3, ROWS[r] * 0.30 + 7.1, 3);      // strata mottle
        const jt = fbmz(a * 9 + 51.7, ROWS[r] * 0.09 + 2.3, 2);      // big shading blocks
        const v = (0.36 + 0.86 * st * (0.55 + 0.9 * jt)) * (1 - dep) * (1 - dep) * (0.55 + 0.45 * sunF);
        col[k * 3] = 0.034 * v; col[k * 3 + 1] = 0.034 * v; col[k * 3 + 2] = 0.037 * v;
      }
      const j = (i + 1) % N;
      for (let r = 0; r < NR - 1; r++) {
        const A = i * NR + r, B = A + 1, C = j * NR + r, D = C + 1;
        idx[o++] = A; idx[o++] = B; idx[o++] = D; idx[o++] = A; idx[o++] = D; idx[o++] = C;
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    pg.setIndex(new THREE.BufferAttribute(idx, 1));
    const pm = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    pm.frustumCulled = false; pm.name = 'PLINTH';
    World.group.add(pm);
  }
  // ── 6. scatter helpers ──────────────────────────────────────────────────────
  const blockers = [];   // [x,z,r] keep-out zones (houses, gates)
  for (const [hx, hz] of HOUSE_SITES) blockers.push([hx, hz, 6.2]);
  for (const sg of World.spawnG) blockers.push([sg.x, sg.z, 26]);
  blockers.push([World.gateOut.x, World.gateOut.z, 24]);
  // WORLD → SIM contract (SPEC2 §A): every big prop registers a footprint circle here as
  // it is scattered, so G.canPlace() can reject a tower that would grow out of a tree or
  // through a farmhouse wall. Gates are covered by the path-endpoint keep-outs instead.
  // Maps 2-3 must populate this the same way.
  const OBS = G.obstacles = [];
  for (const [hx, hz] of HOUSE_SITES) OBS.push({ x: hx, z: hz, r: 3.5 });
  // crags are placed straight onto the rim (they ignore `blockers`), so they need their
  // own gate keep-out or the gate structures end up walled in and invisible
  const gClear = (x, z) => {
    let m = Math.hypot(x - World.gateOut.x, z - World.gateOut.z);
    for (const sg of World.spawnG) m = Math.min(m, Math.hypot(x - sg.x, z - sg.z));
    return m > 26;
  };
  const freeAt = (x, z, pad, minRoad) => {
    if (Math.abs(bi(SDG, x, z)) < minRoad) return false;
    for (const [bx, bz, br] of blockers) if ((x - bx) ** 2 + (z - bz) ** 2 < (br + pad) ** 2) return false;
    return true;
  };
  const slopeAt = (x, z) => { const e = 1.6; return Math.hypot(bi(HG, x - e, z) - bi(HG, x + e, z), bi(HG, x, z - e) - bi(HG, x, z + e)) / (2 * e); };
  const iMesh = (geo, mat, list, cast, name) => {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    m.castShadow = !!cast; m.receiveShadow = false; m.name = name;
    m.count = list.length;
    const col = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      m.setMatrixAt(i, list[i].m);
      col.setRGB(list[i].c[0], list[i].c[1], list[i].c[2]); m.setColorAt(i, col);
    }
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    World.group.add(m); return m;
  };
  const RK = WPAL.rockK;
  const vary = (a) => { const l = wr(1 - a, 1 + a), w = wr(-0.045, 0.045); return [l * (1 + w) * RK[0], l * RK[1], l * (1 - w) * RK[2]]; };
  // shared structure textures (created before any scatter so the wrng order stays fixed)
  const TX = { stone: stoneTex(), plaster: plasterTex(), wood: woodTex(),
               slate: shingleTex('#22262c', 'rgba(108,118,132,L)'),
               shake: shingleTex('#2b1f14', 'rgba(126,92,58,L)') };
  const texMat = (map, o) => new THREE.MeshStandardMaterial(Object.assign({ map, vertexColors: true, roughness: 0.9, metalness: 0 }, o));
  // foliage varies in luminance AND hue (yellow-green ↔ blue-green) so a wood never reads flat
  const varyF = () => { const l = wr(0.52, 1.08), y = wr(-0.15, 0.15); return [l * (1 + y * 1.6), l, l * (1 - y * 1.0)]; };

  // ── 7. cliff crags + boulders (silhouette variation on the rim) ─────────────
  // Three registers so the rim reads as an escarpment rather than a boulder field:
  // (a) dense blocks fracturing the crest skyline, (b) big buttress slabs for scale,
  // (c) outcrops threaded down the face. Talus + field boulders stay rounded.
  const cragL = [[], [], []], bldL = [];
  let cragI = 0;
  const addCrag = (x, z, wide, tall, tilt, cv) => {
    // The camera bearing is fixed, so the +x/+z arc of the rim is always FOREGROUND.
    // Full-size crags there fill a third of the frame with grey; shrink them so the
    // near rim frames the shot instead of blocking it.
    const l = Math.hypot(x, z) || 1;
    const k = 1 - 0.36 * clamp((0.432 * x + 0.902 * z) / l, 0, 1);
    const sx = wide * k * wr(0.86, 1.16), sz = wide * k * wr(0.86, 1.16), sy = tall * k;
    cragL[cragI++ % 3].push({
      m: trs(x, bi(HG, x, z) - sy * wr(0.34, 0.72), z, wr(0, 6.28), sx, sy, sz, wr(-tilt, tilt), wr(-tilt, tilt)),
      c: vary(cv) });
    G.stampAO(x, z, Math.max(sx, sz) * 0.9, 0.9);
  };
  // `open` = the valley mouth; crags shrink away there so the vista stays open.
  for (let i = 0; i < 210; i++) {   // (a) broken crest
    const a = i / 210 * Math.PI * 2 + wr(-0.012, 0.012);
    const pr0 = rimProfile(...seP(a, 1));
    const [x, z] = seP(a, pr0.start + wr(0.010, 0.072));
    if (Math.abs(bi(SDG, x, z)) < 15 || !gClear(x, z) || wrng() < pr0.open * 0.92) continue;
    const s = wr(2.2, 6.4) * (1 - pr0.open * 0.6);
    addCrag(x, z, s * wr(0.85, 1.30), s * wr(0.62, 1.35), 0.13, 0.17);
  }
  for (let i = 0; i < 40; i++) {    // (b) buttress masses
    const a = wr(0, 6.283);
    const pr0 = rimProfile(...seP(a, 1));
    const [x, z] = seP(a, pr0.start + wr(0.002, 0.038));
    if (Math.abs(bi(SDG, x, z)) < 16 || !gClear(x, z) || wrng() < pr0.open * 0.95) continue;
    const s = wr(5.2, 8.8) * (1 - pr0.open * 0.7);
    addCrag(x, z, s * wr(0.80, 1.20), s * wr(0.85, 1.55), 0.08, 0.14);
  }
  for (let i = 0; i < 190; i++) {   // (c) outcrops down the face
    const a = wr(0, 6.283);
    const pr0 = rimProfile(...seP(a, 1));
    const [x, z] = seP(a, pr0.start + wr(-0.010, 0.042));
    if (Math.abs(bi(SDG, x, z)) < 14 || !gClear(x, z) || wrng() < pr0.open * 0.9) continue;
    const s = wr(1.6, 4.0) * (1 - pr0.open * 0.5);
    addCrag(x, z, s * wr(1.0, 1.7), s * wr(0.55, 1.10), 0.26, 0.18);
  }
  for (let i = 0; i < 380; i++) {   // talus at the cliff foot + field boulders
    const a = wr(0, 6.283);
    const pr0 = rimProfile(...seP(a, 1));
    const u = i < 260 ? pr0.start - wr(0.004, 0.150) : wr(0.15, 0.80);
    const [x, z] = seP(a, u);
    if (!freeAt(x, z, 1.0, i < 260 ? 4.6 : 6.4)) continue;
    const s = i < 260 ? wr(0.6, 2.7) : wr(0.35, 1.5);
    bldL.push({ m: trs(x, bi(HG, x, z) - s * 0.34, z, wr(0, 6.28), s * wr(0.8, 1.3), s * wr(0.55, 1.05), s * wr(0.8, 1.3), wr(-0.2, 0.2), wr(-0.2, 0.2)), c: vary(0.15) });
    G.stampAO(x, z, s * 1.05, 0.95);
    if (s > 1.15) OBS.push({ x, z, r: 1.2 });         // only the large boulders block building
  }
  // Rock roughness 0.86 (not 0.95): granite is not chalk, and a little specular is what
  // separates a boulder from a paper cut-out under a low sun.
  const rockMat = propMat({ roughness: 0.86 });
  iMesh(baseBleed(cragGeo(9, 5, 2.7), 0.42, 0.48), rockMat, cragL[0], true, 'CRAGS_A');
  iMesh(baseBleed(cragGeo(7, 4, 13.1), 0.42, 0.48), rockMat, cragL[1], true, 'CRAGS_B');
  iMesh(baseBleed(cragGeo(11, 5, 31.7), 0.42, 0.48), rockMat, cragL[2], true, 'CRAGS_C');
  iMesh(baseBleed(rockGeo(1, 11.3, false), 0.46, 0.50), rockMat, bldL, true, 'ROCKS');

  // ── 8. trees + bushes ───────────────────────────────────────────────────────
  const oakL = [], ashL = [], pineL = [], bushL = [];
  // FOCAL HIERARCHY: the centre of the plateau is where the road-to-keep read has to live,
  // and a wood parked on top of it owns the frame instead. Clusters that land inside the
  // central 60x40 box get pushed out to the fringe ring 55% of the time; the timber that
  // stays reads as scattered standards, not a canopy roof over the composition.
  const CORE_X = 30, CORE_Z = 20;
  const inCore = (x, z) => Math.abs(x) < CORE_X && Math.abs(z) < CORE_Z;
  const CLUSTERS = Math.round(46 * Q.density);
  for (let ci = 0; ci < CLUSTERS; ci++) {
    let cx = 0, cz = 0, ok = false;
    const fringeOnly = wrng() < 0.55;
    for (let tryI = 0; tryI < 40 && !ok; tryI++) {
      const a = wr(0, 6.283), u = fringeOnly ? wr(0.66, 1.02) : wr(0.30, 1.02);
      const p = seP(a, u); cx = p[0]; cz = p[1];
      ok = freeAt(cx, cz, 3, 8.5) && ringU(cx, cz) < 1.03 && slopeAt(cx, cz) < 0.62
           && !(fringeOnly && inCore(cx, cz));
    }
    if (!ok) continue;
    // per-cluster maturity: some stands are old timber, some are scrub. Without this
    // size hierarchy a wood reads as one repeated cauliflower.
    const kind = wrng(), n = 3 + Math.round(wr(0, 6)), mat = wr(0.66, 1.46);
    for (let i = 0; i < n; i++) {
      const x = cx + wr(-9, 9), z = cz + wr(-9, 9);
      if (!freeAt(x, z, 1.6, 7.2) || ringU(x, z) > 1.06 || slopeAt(x, z) > 0.72) continue;
      const y = bi(HG, x, z) - 0.25, s = (0.46 + Math.pow(wrng(), 2.0) * 1.24) * mat, ry = wr(0, 6.283);
      const t = { m: trs(x, y, z, ry, s * wr(0.9, 1.1), s * wr(0.9, 1.15), s * wr(0.9, 1.1)), c: varyF() };
      if (kind < WPAL.treeMix[0]) oakL.push(t); else if (kind < WPAL.treeMix[1]) ashL.push(t); else pineL.push(t);
      OBS.push({ x, z, r: 1.6 });
      G.stampAO(x, z, 1.5 * s, 0.9);
    }
    for (let i = 0; i < 3; i++) {
      const x = cx + wr(-13, 13), z = cz + wr(-13, 13);
      if (!freeAt(x, z, 1.0, 5.4) || ringU(x, z) > 1.04) continue;
      const s = wr(1.1, 2.3);
      bushL.push({ m: trs(x, bi(HG, x, z) - 0.16, z, wr(0, 6.283), s, s * wr(0.72, 1.1), s), c: varyF() });
      G.stampAO(x, z, s * 0.72, 0.85);
    }
  }
  // Hero standards: three deliberately placed old oaks near the left and right thirds of
  // the overview frame. They read as framing verticals instead of a mass in the middle.
  for (const [hx, hz] of [[-52, 8], [46, 26], [-30, -40]]) {
    if (!freeAt(hx, hz, 2.0, 8.0) || ringU(hx, hz) > 1.0) continue;
    const s = wr(1.85, 2.20);
    oakL.push({ m: trs(hx, bi(HG, hx, hz) - 0.3, hz, wr(0, 6.283), s, s * wr(1.0, 1.12), s), c: varyF() });
    OBS.push({ x: hx, z: hz, r: 2.2 });
    G.stampAO(hx, hz, 2.6 * s, 1.0);
  }
  for (let i = 0; i < Math.round(70 * Q.density); i++) {    // scrub on the valley shoulders only
    const a = wr(0, 6.283), u = wr(0.52, 1.0), p = seP(a, u);
    if (!freeAt(p[0], p[1], 0.8, 5.2) || ringU(p[0], p[1]) > 1.04) continue;
    const s = wr(0.9, 2.0);
    bushL.push({ m: trs(p[0], bi(HG, p[0], p[1]) - 0.16, p[1], wr(0, 6.283), s, s * wr(0.72, 1.1), s), c: varyF() });
    G.stampAO(p[0], p[1], s * 0.72, 0.85);
  }
  const foliMat = swayMat({ roughness: 0.94 }, 0.11, 1.05, 'bf_foliage', true);
  iMesh(treeOak(1.7), foliMat, oakL, true, 'TREE_OAK');
  iMesh(treeAsh(4.3), foliMat, ashL, true, 'TREE_ASH');
  iMesh(treePine(8.1), foliMat, pineL, true, 'TREE_PINE');
  iMesh(bushG(2.9), foliMat, bushL, true, 'BUSHES');

  // ── 9. grass tufts (ground clutter — reads at gameplay + closeup zoom) ──────
  {
    // A rosette of cards tipped outward: seen from the game's high camera each tuft
    // presents leaf AREA instead of the edge-on "asterisk" a vertical cross gives.
    const q = [];
    for (let i = 0; i < 3; i++) {
      const pg = new THREE.PlaneGeometry(0.96, 0.70);
      pg.translate(0, 0.43, 0); pg.rotateX(0.44); pg.translate(0, 0.02, 0.15);
      q.push({ g: paintFlat(pg, [1, 1, 1], 0.0), m: trs(0, 0, 0, i * 2.094) });
    }
    const tuftG = mergeParts(q);
    const tuftM = new THREE.MeshStandardMaterial({ map: tuftTex(), transparent: false, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9, vertexColors: true });
    // Clumped, not uniform: an even sprinkle at this density reads as screen noise.
    // Each patch shares a tint + scale bias so the meadow gets legible tonal shapes.
    const list = [], TK = WPAL.tuftK;
    const PATCHES = Math.round(300 * Q.density * WPAL.tuftN);
    const push = (x, z, sB, tint) => {
      if (ringU(x, z) > 1.03 || Math.abs(bi(SDG, x, z)) < 2.5 || slopeAt(x, z) > 0.85) return;
      const s = sB * wr(0.72, 1.30);
      list.push({ m: trs(x, bi(HG, x, z) - 0.06, z, wr(0, 6.283), s, s * wr(0.70, 1.36), s), c: tint });
    };
    for (let p = 0; p < PATCHES; p++) {
      const a = wr(0, 6.283), u = wr(0.05, 1.02), c0 = seP(a, u);
      // Tuft tints used to run up to 1.4x — at overview zoom that read as yellow confetti
      // sprinkled over the meadow rather than as ground cover. Kept close to the terrain's
      // own value so the clutter adds texture, not noise.
      const dryish = wrng() < 0.13, dark = !dryish && wrng() < 0.40;
      const sB = wr(0.72, 1.55), rad = wr(2.4, 7.0);
      const tint = dryish ? [wr(0.86, 1.10) * TK[0], wr(0.80, 0.96) * TK[1], wr(0.44, 0.62) * TK[2]]
                 : dark   ? [wr(0.40, 0.58) * TK[0], wr(0.46, 0.66) * TK[1], wr(0.34, 0.54) * TK[2]]
                          : [wr(0.60, 0.86) * TK[0], wr(0.68, 0.92) * TK[1], wr(0.48, 0.80) * TK[2]];
      const n = 3 + Math.round(wr(0, 5));
      for (let i = 0; i < n; i++) push(c0[0] + wr(-rad, rad), c0[1] + wr(-rad, rad), sB, tint);
    }
    // shoulders of EVERY road on the map, sampled by length share (identical draw order to
    // the single-spline version when a map has one route)
    const RTOT = PTS.reduce((a, T) => a + T.len, 0);
    for (let i = 0; i < Math.round(760 * Q.density * WPAL.tuftN); i++) {   // road shoulders
      let dd = wr(0, RTOT), rr = 0;
      while (rr < PTS.length - 1 && dd > PTS[rr].len) { dd -= PTS[rr].len; rr++; }
      const RT = PTS[rr];
      const sd = wrng() < 0.5 ? -1 : 1;
      const j = clamp(Math.round(dd / RT.len * PATH_N), 0, PATH_N);
      const p = RT.pos[j], t = RT.tan[j], off = sd * wr(2.7, 7.2);
      const dryish = wrng() < 0.34;
      push(p.x - t.z * off, p.z + t.x * off, wr(0.72, 1.42),
        dryish ? [wr(0.84, 1.08) * TK[0], wr(0.78, 0.94) * TK[1], wr(0.42, 0.62) * TK[2]]
               : [wr(0.52, 0.84) * TK[0], wr(0.60, 0.88) * TK[1], wr(0.44, 0.78) * TK[2]]);
    }
    iMesh(tuftG, tuftM, list, false, 'TUFTS');
  }

  // ── 10. fences along road stretches ─────────────────────────────────────────
  {
    const parts = [], T = 0.215;
    // Posts run 0.9u deeper than they show. A fence spans 3.1u but is anchored to the
    // ground height at its CENTRE, and 0.17u of burial is less than the drop a gentle roll
    // puts under the downhill post — buried timber merges into the same instance, so the
    // insurance is free. (Same reasoning as SECTION: TOWERS' SINK.)
    for (const px of [-1.55, 1.55]) parts.push({ g: paintWood(boxG(T, 2.52, T)), m: trs(px, 0.25, 0) });
    for (const py of [0.60, 1.10]) parts.push({ g: paintWood(boxG(3.25, 0.19, 0.15)), m: trs(0, py, 0, 0, 1, 1, 1, 0, wr(-0.03, 0.03)) });
    const fenceG = baseBleed(mergeParts(parts, 1.1), 0.46, 0.42);
    const list = [];
    const STRETCH = [[0.055, 0.145, 1], [0.30, 0.405, -1], [0.545, 0.635, 1], [0.735, 0.845, -1], [0.885, 0.955, 1]];
    for (const RT of PTS) for (const [a0, a1, side] of STRETCH) {
      for (let d = a0 * RT.len; d < a1 * RT.len; d += 3.2) {
        const j = clamp(Math.round(d / RT.len * PATH_N), 0, PATH_N);
        const p = RT.pos[j], t = RT.tan[j], off = side * wr(4.5, 5.4);
        const x = p.x - t.z * off, z = p.z + t.x * off;
        if (!freeAt(x, z, 0.5, 3.6)) continue;
        list.push({ m: trs(x, bi(HG, x, z) - 0.06, z, Math.atan2(t.x, t.z) + Math.PI / 2 + wr(-0.05, 0.05), 1, wr(0.92, 1.08), 1, 0, 0), c: vary(0.13) });
        G.stampAO(x, z, 1.5, 0.55);
      }
    }
    iMesh(fenceG, texMat(TX.wood, { roughness: 0.75 }), list, true, 'FENCES');
  }

  // ── 11. village near the keep gate ──────────────────────────────────────────
  {
    const buckets = { plaster: [], timber: [], roof: [] };
    let hi = 0;
    for (const [hx, hz, ry] of HOUSE_SITES) {
      const w = [5.6, 4.4, 6.2, 4.8][hi], d = [4.2, 3.8, 4.6, 4.0][hi], h = [3.4, 3.0, 3.6, 3.1][hi];
      const P = houseParts(w, d, h, hi + 1);
      const base = trs(hx, bi(HG, hx, hz) - 0.12, hz, ry);
      G.stampAO(hx, hz, 3.6, 1.0);
      for (const key of ['plaster', 'timber', 'roof'])
        for (const p of P[key]) buckets[key].push({ g: p.g, m: new THREE.Matrix4().multiplyMatrices(base, p.m) });
      hi++;
    }
    const add = (parts, mat, uvs, name) => { const m = new THREE.Mesh(mergeParts(parts, uvs), mat); m.castShadow = true; m.receiveShadow = true; m.name = name; World.group.add(m); };
    add(buckets.plaster, texMat(TX.plaster, { roughness: 0.95 }), 2.0, 'HOUSE_WALL');
    add(buckets.timber, texMat(TX.wood, { roughness: 0.75 }), 1.1, 'HOUSE_TIMBER');
    add(buckets.roof, texMat(TX.shake, { roughness: 0.68 }), 1.5, 'HOUSE_ROOF');
  }

  // ── 12. gates ───────────────────────────────────────────────────────────────
  const torchParts = (px, py, pz) => [
    { g: paintWood(boxG(0.24, 3.0, 0.24)), m: trs(px, py + 1.5, pz, wr(-0.05, 0.05)) },
    { g: paintWood(new THREE.CylinderGeometry(0.42, 0.26, 0.55, 8, 1, true), 0.34), m: trs(px, py + 3.1, pz) },
  ];
  const bannerMesh = (t, list, tx, speed) => {
    const bp = [];
    for (const [bx, by, bw, bh, bz] of list) {
      const pg = new THREE.PlaneGeometry(bw, bh, 3, 7); pg.translate(0, -bh / 2, 0);
      bp.push({ g: pg, m: trs(bx, by, bz), w: (x, y) => clamp(-y / bh, 0, 1) });
    }
    const bmat = new THREE.MeshStandardMaterial({ map: tx, side: THREE.DoubleSide, roughness: 0.90 });
    bmat.customProgramCacheKey = () => 'bf_banner';
    bmat.onBeforeCompile = (sh) => {
      sh.uniforms.uT = WT;
      sh.vertexShader = 'uniform float uT;attribute float aW;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n transformed.z += sin(uT*' + speed + ' + position.y*1.7 + position.x*1.1)*0.28*aW;\n transformed.x += cos(uT*' + (speed * 0.8).toFixed(2) + ' + position.y*1.3)*0.13*aW;');
    };
    const m = new THREE.Mesh(mergeParts(bp), bmat); m.castShadow = false; return m;
  };
  { // ── player keep gate: crenellated stone barbican, blue banners, timber hoarding ──
    const G0 = World.gateOut, ang = Math.atan2(G0.rx, G0.rz), gy = bi(HG, G0.x, G0.z);
    const stone = [], timber = [], slate = [];
    for (const s of [-1, 1]) {                        // flanking drum towers
      const tx = s * 7.2;
      stone.push({ g: paintStone(new THREE.CylinderGeometry(2.85, 3.30, 9.2, 16, 3)), m: trs(tx, 4.6, 0) });
      stone.push({ g: paintStone(new THREE.CylinderGeometry(3.36, 3.14, 0.55, 16, 1), 1.12), m: trs(tx, 8.4, 0) });
      stone.push({ g: paintStone(new THREE.CylinderGeometry(3.30, 3.36, 1.05, 16, 1), 1.05), m: trs(tx, 9.7, 0) });
      for (let c = 0; c < 11; c++) {                  // merlons
        const a = c / 11 * Math.PI * 2;
        stone.push({ g: paintStone(boxG(0.86, 1.10, 0.86), 1.14), m: trs(tx + Math.cos(a) * 2.92, 10.7, Math.sin(a) * 2.92, -a) });
      }
      slate.push({ g: paintTex(new THREE.ConeGeometry(3.72, 3.9, 16), 1, 0.16, 0.14), m: trs(tx, 13.0, 0, s * 0.2) });
      slate.push({ g: paintTex(new THREE.SphereGeometry(0.30, 8, 6), 1.3, 0.1, 0), m: trs(tx, 15.1, 0) });
      // curtain wall between tower and gate opening
      stone.push({ g: paintStone(boxG(3.5, 7.4, 2.5), 0.97), m: trs(s * 4.2, 3.7, 0) });
      for (let c = 0; c < 3; c++) stone.push({ g: paintStone(boxG(0.86, 1.05, 2.5), 1.14), m: trs(s * (2.85 + c * 1.30), 7.9, 0) });
      stone.push({ g: paintStone(boxG(0.55, 1.6, 2.7), 0.80), m: trs(s * 4.2, 5.3, 0) });   // arrow slit surround
    }
    stone.push({ g: paintStone(boxG(6.2, 2.5, 2.5), 1.0), m: trs(0, 7.1, 0) });             // lintel block
    stone.push({ g: paintStone(boxG(7.1, 0.62, 3.1), 1.16), m: trs(0, 8.6, 0) });           // string course
    for (let c = 0; c < 5; c++) stone.push({ g: paintStone(boxG(0.86, 1.10, 2.8), 1.14), m: trs(-2.6 + c * 1.30, 9.45, 0) });
    for (let c = 0; c < 11; c++) {                    // arch voussoirs over the road
      const a = Math.PI * (0.04 + c / 10 * 0.92);
      stone.push({ g: paintStone(boxG(1.00, 0.95, 2.8), 1.20), m: trs(-Math.cos(a) * 3.05, 5.5 + Math.sin(a) * 0.75, 0, 0, 1, 1, 1, 0, -Math.cos(a) * 0.52) });
    }
    timber.push({ g: paintWood(boxG(6.2, 0.32, 0.30)), m: trs(0, 6.05, -1.40) });           // hoarding rail
    for (let c = 0; c < 4; c++) timber.push({ g: paintWood(boxG(0.30, 0.30, 1.5), 0.7), m: trs(-2.4 + c * 1.6, 6.35, -2.05) });
    for (let c = 0; c < 7; c++) timber.push({ g: paintWood(boxG(0.26, 4.1, 0.26), 0.66), m: trs(-2.5 + c * 0.84, 3.3, -1.50) });  // portcullis
    for (let c = 0; c < 4; c++) timber.push({ g: paintWood(boxG(5.9, 0.24, 0.24), 0.66), m: trs(0, 1.6 + c * 1.26, -1.50) });
    timber.push(...torchParts(-10.4, 0, -3.2), ...torchParts(10.4, 0, -3.2));
    const gGrp = new THREE.Group();
    gGrp.position.set(G0.x, gy, G0.z); gGrp.rotation.y = ang;
    const mk = (parts, mat, uvs) => { const m = new THREE.Mesh(mergeParts(parts, uvs), mat); m.castShadow = true; m.receiveShadow = true; gGrp.add(m); };
    mk(stone, texMat(TX.stone, { roughness: 0.93 }), 2.6);
    mk(timber, texMat(TX.wood, { roughness: 0.75 }), 1.1);
    mk(slate, texMat(TX.slate, { roughness: 0.35 }), 1.1);
    // banners on BOTH faces \u2014 local +z is the outward (gorge) side, and which face the
    // player sees depends on where the camera has been panned to
    gGrp.add(bannerMesh(null, [[-1.85, 7.05, 2.05, 4.9, 1.62], [1.85, 7.05, 2.05, 4.9, 1.62],
      [-7.2, 10.1, 1.7, 4.0, 3.2], [7.2, 10.1, 1.7, 4.0, 3.2],
      [-1.85, 7.05, 2.05, 4.9, -1.62], [1.85, 7.05, 2.05, 4.9, -1.62],
      [-7.2, 10.1, 1.7, 4.0, -3.2], [7.2, 10.1, 1.7, 4.0, -3.2]],
      bannerTex('#2e5fa3', '#16305c', '#e8b64c', '\u2726'), 2.1));
    World.group.add(gGrp);
  }
  for (const G1 of World.spawnG) { // ── enemy spawn gate(s): dark crag arch, iron spikes, blood banners ──
    const ang = Math.atan2(G1.rx, G1.rz), gy = bi(HG, G1.x, G1.z);
    const dark = [], iron = [];
    // A leaning crag arch: stacked angular masses climbing each jamb and corbelling in
    // over the road. Rounded boulders here read as a rockslide, not a gateway.
    const JAMB = [[9.8, 0.0, 4.4, 5.4], [9.0, 5.0, 3.9, 5.2], [8.3, 9.6, 3.4, 4.6],
                  [7.5, 13.6, 2.9, 3.8], [6.0, 16.6, 2.6, 3.2]];
    // the spawn side is hostile ground: knock the granite down to near-black basalt
    const grim = (g) => { const C = g.attributes.color; for (let i = 0; i < C.count; i++) C.setXYZ(i, C.getX(i) * 0.30, C.getY(i) * 0.31, C.getZ(i) * 0.35); return g; };
    let ji = 0;
    for (const s of [-1, 1]) for (const [jx, jy, jw, jh] of JAMB) {
      dark.push({ g: grim(cragGeo(8 + (ji % 3), 5, 17.7 + ji * 5.3)),
        m: trs(s * jx, jy + jh, wr(-1.4, 2.6), wr(0, 6.28), jw * wr(0.9, 1.1), jh, jw * wr(0.9, 1.1),
               wr(-0.10, 0.10), s * wr(0.10, 0.24)) });
      ji++;
    }
    dark.push({ g: grim(cragGeo(10, 4, 71.3)), m: trs(0, 19.6, 0.6, 0.4, 5.4, 2.6, 4.2, 0.06, 0) });
    iron.push({ g: paintWood(boxG(14.2, 0.85, 0.9), 0.42), m: trs(0, 8.8, 0, 0, 1, 1, 1, 0, 0.035) });
    iron.push({ g: paintWood(boxG(13.2, 0.55, 0.6), 0.38), m: trs(0, 7.6, 0.15, 0, 1, 1, 1, 0, -0.03) });
    for (const s of [-1, 1]) iron.push({ g: paintWood(boxG(0.9, 9.1, 0.9), 0.38), m: trs(s * 6.5, 4.55, 0, 0, 1, 1, 1, 0, s * 0.03) });
    for (let i = 0; i < 9; i++)                       // impaled spikes along the lintel
      iron.push({ g: paintWood(new THREE.ConeGeometry(0.22, 1.6, 5), 0.30), m: trs(-6.0 + i * 1.5, 9.9, 0, 0, 1, 1, 1, wr(-0.1, 0.1), wr(-0.12, 0.12)) });
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++)   // spiked palisade wings
      iron.push({ g: paintWood(boxG(0.36, 3.2, 0.36), 0.34), m: trs(s * (8.6 + i * 1.7), 1.5, wr(-1.2, 1.2), 0, 1, 1, 1, wr(-0.12, 0.12), s * wr(0.03, 0.15)) });
    iron.push(...torchParts(-6.1, 1.2, 0), ...torchParts(6.1, 1.2, 0));
    const gGrp = new THREE.Group();
    gGrp.position.set(G1.x, gy, G1.z); gGrp.rotation.y = ang;
    const dm = new THREE.Mesh(mergeParts(dark), propMat({ roughness: 0.96 }));
    dm.castShadow = true; dm.receiveShadow = true; gGrp.add(dm);
    const im = new THREE.Mesh(mergeParts(iron, 1.1), texMat(TX.wood, { roughness: 0.8 }));
    im.castShadow = true; gGrp.add(im);
    gGrp.add(bannerMesh(null, [[-3.4, 8.4, 2.3, 5.6, 0.65], [3.4, 8.4, 2.3, 5.6, 0.65], [0, 8.4, 1.9, 4.6, 0.65],
      [-3.4, 8.4, 2.3, 5.6, -0.55], [3.4, 8.4, 2.3, 5.6, -0.55]],
      bannerTex('#8e2018', '#3d0d09', '#c8b48a', '\u2620'), 2.4));
    World.group.add(gGrp);
  }
  // ── 13. torch flames + gate glow (torch local coords mirror §12) ────────────
  {
    const faceY = Math.atan2(0.42, 0.9);
    const parts = [];
    const worldFlames = [];
    const gates = [World.gateOut].concat(World.spawnG);
    const KEEP_L = [[-10.4, 3.35, -3.2, 1], [10.4, 3.35, -3.2, 1]];
    const SPAWN_L = [[-6.1, 4.55, 0, 1.3], [6.1, 4.55, 0, 1.3]];
    for (let gi = 0; gi < gates.length; gi++) {
      const G0 = gates[gi], ang = Math.atan2(G0.rx, G0.rz), gy = bi(HG, G0.x, G0.z);
      for (const [lx, ly, lz, s] of (gi === 0 ? KEEP_L : SPAWN_L)) {
        const wx = G0.x + lx * Math.cos(ang) + lz * Math.sin(ang);
        const wz = G0.z - lx * Math.sin(ang) + lz * Math.cos(ang);
        worldFlames.push([wx, gy + ly, wz, s]);
      }
    }
    for (const [fx, fy, fz, s] of worldFlames) {
      const pg = new THREE.PlaneGeometry(1.5 * s, 2.1 * s);
      parts.push({ g: pg, m: trs(fx, fy + 0.5 * s, fz, faceY) });
    }
    const fm = new THREE.Mesh(mergeParts(parts), new THREE.MeshBasicMaterial({ map: flameTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, color: 0xffd090 }));
    fm.name = 'FLAMES'; fm.renderOrder = 4; World.group.add(fm);
    const pl1 = new THREE.PointLight(0xffa040, 26, 28, 2);
    pl1.position.set(worldFlames[0][0], worldFlames[0][1] + 1, worldFlames[0][2]);
    const pl2 = new THREE.PointLight(0xff5a24, 20, 26, 2);
    pl2.position.set(worldFlames[2][0], worldFlames[2][1] + 1, worldFlames[2][2]);
    World.group.add(pl1, pl2);
  }
  World.built = true;
};

// render-only animation driver (deterministic in shot mode)
scene.onBeforeRender = () => {
  WT.value = SHOT ? (G.vt ? G.vt() : 0) : performance.now() * 0.001;
};
// ══════════════════════ END SECTION: WORLD ══════════════════════

// ══════════════════════ SECTION: PATH (owner: WORLD builder) ══════════════════════
// Road spline + arc-length tables. The control points come from the ACTIVE map (CORE's
// MAPS table), so a new map is a data entry, not a code change. The PT table is
// load-bearing for SIM (enemy travel) and for G.canPlace()'s gate keep-outs.
const PATH_N = 512;
// One arc-length table per ROUTE. Route 0 is always spawn→keep; `PT` stays bound to it so
// every line of code written before maps 2-3 existed keeps meaning exactly what it meant.
const ROUTE_DEF = MAP.routes || [{ wps: MAP.wps }];
function buildPT(wps) {
  const V = wps.map(p => new THREE.Vector3(p[0], 0, p[1]));
  const cv = new THREE.CatmullRomCurve3(V, false, 'centripetal', 0.5);
  const T = { pos: [], tan: [], len: cv.getLength() };
  const pts = cv.getSpacedPoints(PATH_N);
  for (let i = 0; i <= PATH_N; i++) {
    T.pos.push(pts[i]);
    const t2 = pts[Math.min(i + 1, PATH_N)], t1 = pts[Math.max(i - 1, 0)];
    T.tan.push(new THREE.Vector3().subVectors(t2, t1).normalize());
  }
  return T;
}
const PTS = ROUTE_DEF.map(r => buildPT(r.wps));
const PT = PTS[0];
G.PTS = PTS;
// Junction distances are MEASURED, not authored: the nearest sample on the target spline to
// the joining route's endpoint. Move a waypoint and the handoff follows it.
function nearestD(T, x, z) {
  let bi0 = 0, bq = 1e18;
  for (let i = 0; i <= PATH_N; i++) { const dx = T.pos[i].x - x, dz = T.pos[i].z - z, q = dx * dx + dz * dz; if (q < bq) { bq = q; bi0 = i; } }
  return bi0 / PATH_N * T.len;
}
// HAND[r] = ordered handoffs to test once a walker on route r has advanced. `tag` gates a
// handoff on enemy.branch, which is how the Ember Wastes fork sends half the wave down the
// canyon; taking a tagged handoff clears the tag so the fork can never fire twice.
const HAND = PTS.map(() => []);
const SPAWN_R = [];                                  // routes that own a spawn gate
ROUTE_DEF.forEach((r, i) => {
  if (r.from === undefined) SPAWN_R.push(i);
  else {
    const p0 = r.wps[0];
    HAND[r.from.route].push({ at: nearestD(PTS[r.from.route], p0[0], p0[1]), to: i, d: 0, tag: r.from.tag });
  }
  if (r.to !== undefined) {
    const pN = r.wps[r.wps.length - 1];
    HAND[i].push({ at: PTS[i].len, to: r.to, d: nearestD(PTS[r.to], pN[0], pN[1]) });
  }
});
for (const h of HAND) h.sort((a, b) => a.at - b.at);
const HAS_FORK = ROUTE_DEF.some(r => r.from !== undefined && r.from.tag !== undefined);
G.HAND = HAND; G.spawnRoutes = SPAWN_R; G.hasFork = HAS_FORK;
if (SHOT && PTS.length > 1) {   // QA read-out: junction placement as a fraction of route 0
  for (let r = 0; r < PTS.length; r++)
    for (const h of HAND[r])
      console.log('ROUTE ' + r + ' len=' + PTS[r].len.toFixed(1) + ' -> route ' + h.to +
        ' at ' + h.at.toFixed(1) + ' (' + (h.at / PTS[r].len * 100).toFixed(0) + '% of its own road) lands d=' +
        h.d.toFixed(1) + ' (' + (h.d / PTS[h.to].len * 100).toFixed(0) + '% of route ' + h.to + ')' +
        (h.tag !== undefined ? ' [branch ' + h.tag + ']' : ''));
}
G.endRoute = ROUTE_DEF.findIndex(r => r.to === undefined);
G.pathLen = PT.len;
G.routeLen = p => PTS[p].len;
G.pathPos = (d, out, lane = 0, pid = 0) => { // d in world units along route `pid`
  const T = PTS[pid] || PT;
  const u = clamp(d / T.len, 0, 1) * PATH_N, i = Math.floor(u), f = u - i;
  const a = T.pos[i], b = T.pos[Math.min(i + 1, PATH_N)], tn = T.tan[i];
  out.set(lerp(a.x, b.x, f) - tn.z * lane, 0, lerp(a.z, b.z, f) + tn.x * lane);
  out.y = G.groundY(out.x, out.z);
  return out;
};
G.pathTan = (d, pid = 0) => { const T = PTS[pid] || PT; return T.tan[clamp(Math.round(clamp(d / T.len, 0, 1) * PATH_N), 0, PATH_N)]; };
// Nearest point across ALL routes — a barracks on the Frostfell wedge must rally onto the
// arm of the fork it actually stands beside, not onto route 0 by definition.
const _np3 = new THREE.Vector3();
G.nearestPath = (x, z) => {
  let bd = 0, bp = 0, best = 1e18;
  for (let p = 0; p < PTS.length; p++) {
    const L = PTS[p].len;
    for (let d = 0; d < L; d += 2) {          // same 2u stride the single-road version used
      G.pathPos(d, _np3, 0, p);
      const q = (_np3.x - x) ** 2 + (_np3.z - z) ** 2;
      if (q < best) { best = q; bd = d; bp = p; }
    }
  }
  return { d: bd, pid: bp, q: best };
};

const ROAD_W = 4.6;                                 // nominal road width (the visual road is
G.roadW = ROAD_W;                                   // painted + carved by the terrain shader)

// The heightfield carves this spline, so the world is built here — once the spline
// exists everything downstream can rely on a real G.groundY(). (The fixed build plots
// and their dashed markers are GONE: SPEC2 §A replaced them with free placement, and
// G.canPlace() in SECTION: SIM is now the single authority on where a tower may stand.)
World.build();
// ══════════════════════ END SECTION: PATH ══════════════════════

// ══════════════════════ SECTION: ARMIES (owner: ARMIES builder) ══════════════════════
// Procedural low-poly soldiers. One merged geometry per faction-archetype, one
// InstancedMesh each (SPEC2 §D: 8 red archetypes + knights + 1 health-bar system = 10
// scene draw calls at most, and a mesh whose count is 0 is skipped entirely by three, so
// a map that never fields ogres never pays for them). Gait / fight / death animation is
// GPU vertex skinning: per-vertex bone id + pivot attributes, per-instance
// (phase, gait rate, mode, death). Modes: 0 march · 1 fight · 2 guard · 3 bow draw ·
// 4 four-legged gallop · 5 ogre stomp (one-shot, re-phased by the CPU each frame).
// Contract: Armies.syncVisuals(vt) reads G.enemies/G.knights every frame. Sim fields
// are owned by SIM; this section never writes them (only render-only `_`-prefixed cache).
const KNIGHT_CAP = 64;
// SPEC2 §D roster of 8. One InstancedMesh per archetype; a mesh whose count is 0 costs
// no draw call, so the four new types only bill the frames they actually appear in.
// SPEC3 §B raises the roster to 13. A mesh whose count is 0 is skipped entirely by three,
// so the five newcomers cost nothing on the waves that never field them, and the caps are
// sized to the biggest group any wave table (or elite swap) can actually spawn.
const ACAP = { grunt: 560, runner: 380, brute: 140, boss: 8,
               shield: 200, hound: 260, marauder: 190, ogre: 14,
               ironclad: 48, ashwraith: 260, frostrevenant: 140, warshaman: 64, ram: 8 };
let ENEMY_CAP = 0; for (const k in ACAP) ENEMY_CAP += ACAP[k];
const BAR_CAP = 640;
// ── FORMATION LATTICE ─────────────────────────────────────────────────────────
// The horde used to draw its lateral offset from `(rng()+rng()-1)*2.35`, a triangular
// distribution whose mass sits inside ±1.4u. On a road nearly 8u across that is a 2-3
// abreast queue hugging the centre line, with road surface visible between every rank —
// a trickle, not the reference's crimson river. A deterministic six-file lattice spanning
// ~0.85 of the road puts the same head count shoulder to shoulder bank to bank, and the
// file ORDER zig-zags so consecutive spawns never march a visible diagonal stripe.
// SIM's spawnEnemy() is the only caller; it still burns exactly two rng() draws, so the
// sim stream — and every balance number tuned against it — is bit-identical.
// The outer files sit at ±2.30, INSIDE the ±2.35 the old jitter already reached, so no
// unit is ever further off the centre line (and therefore further from a tower) than the
// balance pass measured. All that changes is that the road is filled evenly instead of
// piling two thirds of the column into the middle 1.4u.
const LANE_FILES = 6, LANE_STEP = 0.92, FILE_ORDER = [0, 3, 1, 4, 2, 5];
G.laneOf = (n, r) => (FILE_ORDER[((n % LANE_FILES) + LANE_FILES) % LANE_FILES] - (LANE_FILES - 1) / 2) * LANE_STEP
                     + (r - 0.5) * 0.26;
const Armies = { enemyMesh: null, knightMesh: null, meshes: [] };
G.Armies = Armies;
G.subT = 0;                                  // sub-tick fraction, plumbed from MAIN
const _m4 = new THREE.Matrix4(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _sc = new THREE.Vector3();
const AM = {};                               // archetype key -> instanced record
let barMesh = null, barArr = null, KITM = null;   // KITM: boss-variant attachment meshes
const AT_U = { value: 0 };                   // shared animation clock (sim-time based)
{
  const TAU = Math.PI * 2, YAX = new THREE.Vector3(0, 1, 0);
  // deterministic build-time stream, independent of the sim + world scatter streams
  let _as = (SEED * 40503 + 0x1a2b3c4d) >>> 0;
  const arng = () => { _as |= 0; _as = _as + 0x6D2B79F5 | 0; let t = Math.imul(_as ^ _as >>> 15, 1 | _as); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const ar = (a, b) => a + (b - a) * arng();

  // ── 1. texture atlas: 4x5 tiles. albedo + a linear map with G=roughness, B=metalness ──
  // SPEC3 §B: a seventh tile row carries the newcomers' materials (rimed plate, grave
  // shroud, banked embers, shaman wool). Every UV is computed from AW/AH, so widening the
  // sheet re-maps the existing tiles identically — no unit changes appearance.
  const AGX = 4, AGY = 7, S = tier === 'mobile' ? 96 : 192, AW = AGX * S, AH = AGY * S, u = S / 192;
  const mkc = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
  const [acv, ag] = mkc(AW, AH), [mcv, mg] = mkc(AW, AH), [ecv, eg] = mkc(AW, AH);
  const T = { MAIL: 0, STEEL: 1, RED: 2, BLUE: 3, LEATH: 4, FACE: 5, SHR: 6, SHB: 7, WOOD: 8, BLADE: 9,
              BANN: 10, SKIN: 11, FUR: 12, GOLD: 13, SHBK: 14, IRON: 15, EYES: 16, PLUME: 17, CRIM: 18, BONE: 19,
              HAIR: 20, DIRT: 21, PAV: 22, HIDE: 23,     // 22/23: SPEC2 §D pavise face + ogre hide
              FROST: 24, SHROUD: 25, EMBER: 26, ROBE: 27 };   // SPEC3 §B newcomers
  eg.fillStyle = '#000'; eg.fillRect(0, 0, AW, AH);
  const tOX = t => (t % AGX) * S, tOY = t => ((t / AGX) | 0) * S;
  const tile = (t, rough, metal, fn) => {
    const x0 = tOX(t), y0 = tOY(t);
    ag.save(); ag.translate(x0, y0); ag.beginPath(); ag.rect(0, 0, S, S); ag.clip(); fn(ag); ag.restore();
    mg.fillStyle = 'rgb(0,' + Math.round(rough * 255) + ',' + Math.round(metal * 255) + ')';
    mg.fillRect(x0, y0, S, S);
  };
  const INS = 0.75;
  const rectUV = t => [(tOX(t) + INS) / AW, 1 - (tOY(t) + S - INS) / AH, (S - 2 * INS) / AW, (S - 2 * INS) / AH];
  const rgba = (r, g2, b, a) => 'rgba(' + (r | 0) + ',' + (g2 | 0) + ',' + (b | 0) + ',' + a + ')';
  const shade = (g, a, b) => { const vg = g.createLinearGradient(0, 0, 0, S); vg.addColorStop(0, a); vg.addColorStop(1, b); g.fillStyle = vg; g.fillRect(0, 0, S, S); };
  const blot = (g, n, dk, lt, amin, amax, rmin, rmax) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = (arng() < 0.5 ? dk : lt); g.globalAlpha = ar(amin, amax);
      g.beginPath(); g.ellipse(arng() * S, arng() * S, ar(rmin, rmax) * u, ar(rmin, rmax) * 0.8 * u, arng() * 3, 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  };

  tile(T.MAIL, 0.58, 0.62, g => {                      // riveted mail
    // same story as T.IRON: near-mirror mail turned every red torso into a cold blue-grey
    // plate that out-valued the tabard over it. Warm, half-metal, and a stop darker.
    g.fillStyle = '#33302c'; g.fillRect(0, 0, S, S);
    const r = 5.4 * u;
    for (let ry = -1; ry * r * 1.42 < S + r; ry++) for (let rx = -1; rx * r * 1.86 < S + r * 2; rx++) {
      const cx = rx * r * 1.86 + (ry & 1) * r * 0.93, cy = ry * r * 1.42;
      g.lineWidth = 1.9 * u; g.strokeStyle = rgba(112 + arng() * 46, 106 + arng() * 42, 96 + arng() * 40, 0.95);
      g.beginPath(); g.arc(cx, cy, r * 0.80, 0, 7); g.stroke();
      g.strokeStyle = 'rgba(238,228,206,.42)'; g.lineWidth = 1.1 * u;
      g.beginPath(); g.arc(cx, cy - r * 0.10, r * 0.60, 3.55, 5.95); g.stroke();
      g.strokeStyle = 'rgba(10,8,6,.58)'; g.lineWidth = 1.25 * u;
      g.beginPath(); g.arc(cx, cy + r * 0.12, r * 0.62, 0.45, 2.72); g.stroke();
    }
    blot(g, 70, '#161208', '#b8b0a4', 0.05, 0.15, 4, 20);
    shade(g, 'rgba(244,232,208,.13)', 'rgba(0,0,0,.32)');
  });
  tile(T.STEEL, 0.30, 1.0, g => {                      // polished plate
    const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, '#dbe2ea'); gr.addColorStop(0.42, '#a6b0bb'); gr.addColorStop(1, '#767e88');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 150; i++) { g.strokeStyle = rgba(arng() < 0.5 ? 255 : 44, arng() < 0.5 ? 255 : 50, arng() < 0.5 ? 255 : 58, ar(0.04, 0.13)); g.lineWidth = ar(0.7, 2.3) * u; const y = arng() * S; g.beginPath(); g.moveTo(0, y); g.lineTo(S, y + ar(-5, 5) * u); g.stroke(); }
    blot(g, 22, '#3c424a', '#eef4fa', 0.07, 0.17, 5, 15);
    g.fillStyle = 'rgba(198,218,240,.22)'; g.fillRect(0, S * 0.09, S, S * 0.15);
  });
  const clothTile = (t, base, dk, lt, rough) => tile(t, rough, 0.0, g => {
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    const st = 3.2 * u;
    for (let i = 0; i * st < S; i++) { g.fillStyle = (i & 1) ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)'; g.fillRect(i * st, 0, 1.7 * u, S); }
    for (let i = 0; i * st < S; i++) { g.fillStyle = (i & 1) ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.05)'; g.fillRect(0, i * st, S, 1.7 * u); }
    blot(g, 34, dk, lt, 0.06, 0.16, 8, 42);
    const vg = g.createRadialGradient(S * 0.40, S * 0.30, S * 0.06, S * 0.5, S * 0.5, S * 0.80);
    vg.addColorStop(0, 'rgba(255,242,222,.13)'); vg.addColorStop(1, 'rgba(0,0,0,.32)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);
  });
  // The horde's value mass lives in these two tiles. RED is the spec's #a42a22 exactly and
  // CRIM its #7e1e18 shade — the old pair sat a stop darker and, once steel highlights and
  // sun were added on top, the column squinted down to pink-grey gravel instead of crimson.
  clothTile(T.RED, '#a42a22', '#5d130e', '#d6583f', 0.88);
  clothTile(T.BLUE, '#2b5da1', '#153468', '#5d92d4', 0.86);
  clothTile(T.CRIM, '#7e1e18', '#3a0a07', '#ab4030', 0.90);
  clothTile(T.DIRT, '#4c4034', '#241d16', '#7a6a58', 0.92);
  tile(T.LEATH, 0.72, 0.0, g => {
    g.fillStyle = '#4a3423'; g.fillRect(0, 0, S, S);
    blot(g, 260, '#170f08', '#8a6a46', 0.05, 0.15, 2, 11);
    g.setLineDash([5 * u, 5 * u]); g.lineWidth = 1.6 * u; g.strokeStyle = 'rgba(206,186,148,.45)';
    for (const yy of [S * 0.10, S * 0.90]) { g.beginPath(); g.moveTo(0, yy); g.lineTo(S, yy); g.stroke(); }
    g.setLineDash([]);
    shade(g, 'rgba(255,232,196,.11)', 'rgba(0,0,0,.28)');
  });
  tile(T.SKIN, 0.66, 0.0, g => {
    g.fillStyle = '#a9754a'; g.fillRect(0, 0, S, S);
    blot(g, 220, '#6a4024', '#d6ac82', 0.05, 0.13, 2, 10);
    shade(g, 'rgba(255,232,200,.12)', 'rgba(52,24,10,.34)');
  });
  tile(T.HAIR, 0.80, 0.0, g => {
    g.fillStyle = '#2a1c11'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 420; i++) {
      const x = arng() * S, y = arng() * S, l = ar(8, 30) * u;
      g.strokeStyle = rgba(arng() < 0.5 ? 12 : 92, arng() < 0.5 ? 8 : 66, arng() < 0.5 ? 5 : 40, ar(0.10, 0.30));
      g.lineWidth = ar(0.9, 2.2) * u; g.beginPath(); g.moveTo(x, y); g.lineTo(x + ar(-5, 5) * u, y + l); g.stroke();
    }
    shade(g, 'rgba(190,166,136,.14)', 'rgba(0,0,0,.34)');
  });
  tile(T.FACE, 0.62, 0.0, g => {                       // stylised face: reads at 12px AND closeup.
    g.fillStyle = '#a9754a'; g.fillRect(0, 0, S, S);   // the helm covers the top ~38% of the box
    let vg = g.createLinearGradient(0, 0, 0, S);
    vg.addColorStop(0, 'rgba(255,236,206,.10)'); vg.addColorStop(0.62, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(48,22,10,.40)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);
    const sg = g.createLinearGradient(0, 0, 0, S * 0.46);
    sg.addColorStop(0, 'rgba(14,9,5,.86)'); sg.addColorStop(0.72, 'rgba(20,12,7,.62)'); sg.addColorStop(1, 'rgba(24,15,9,0)');
    g.fillStyle = sg; g.fillRect(0, 0, S, S * 0.46);   // helm interior shadow
    g.fillStyle = 'rgba(70,38,18,.48)'; g.fillRect(S * 0.08, S * 0.455, S * 0.84, S * 0.062);  // brow
    for (const sx of [-1, 1]) {
      const ex = S * 0.5 + sx * S * 0.180, ey = S * 0.585;
      g.fillStyle = 'rgba(44,24,12,.56)'; g.beginPath(); g.ellipse(ex, ey, S * 0.140, S * 0.078, 0, 0, 7); g.fill();
      g.fillStyle = '#d8ccb6'; g.beginPath(); g.ellipse(ex, ey + S * 0.006, S * 0.092, S * 0.046, 0, 0, 7); g.fill();
      g.fillStyle = '#241a10'; g.beginPath(); g.arc(ex - sx * S * 0.014, ey + S * 0.006, S * 0.036, 0, 7); g.fill();
      g.fillStyle = 'rgba(14,8,4,.88)'; g.fillRect(ex - S * 0.098, ey - S * 0.052, S * 0.196, S * 0.030);
    }
    g.fillStyle = 'rgba(88,50,26,.40)'; g.beginPath();
    g.moveTo(S * 0.5, S * 0.55); g.lineTo(S * 0.572, S * 0.775); g.lineTo(S * 0.428, S * 0.775); g.closePath(); g.fill();
    g.fillStyle = 'rgba(40,20,9,.60)';
    g.beginPath(); g.ellipse(S * 0.455, S * 0.780, S * 0.022, S * 0.014, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(S * 0.545, S * 0.780, S * 0.022, S * 0.014, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(78,34,26,.78)'; g.fillRect(S * 0.385, S * 0.862, S * 0.23, S * 0.034);
    g.fillStyle = 'rgba(255,214,182,.18)'; g.fillRect(S * 0.385, S * 0.845, S * 0.23, S * 0.014);
    for (let i = 0; i < 240; i++) { const y = S * (0.76 + arng() * 0.24); g.fillStyle = 'rgba(40,26,15,' + ar(0.08, 0.26) + ')'; g.fillRect(arng() * S, y, 1.6 * u, 1.6 * u); }
    g.fillStyle = 'rgba(0,0,0,.26)'; g.fillRect(0, S * 0.945, S, S * 0.055);
  });
  tile(T.EYES, 0.38, 0.85, g => {                      // boss visor
    g.fillStyle = '#22252b'; g.fillRect(0, 0, S, S);
    blot(g, 120, '#0a0b0d', '#6a7280', 0.08, 0.22, 3, 16);
    g.fillStyle = 'rgba(0,0,0,.85)'; g.fillRect(S * 0.10, S * 0.34, S * 0.80, S * 0.13);
    g.fillStyle = '#ff8a2a'; g.fillRect(S * 0.17, S * 0.365, S * 0.26, S * 0.075);
    g.fillStyle = '#ff8a2a'; g.fillRect(S * 0.57, S * 0.365, S * 0.26, S * 0.075);
    for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(20,22,26,.9)'; g.fillRect(S * 0.18, S * (0.56 + i * 0.075), S * 0.64, S * 0.028); }
    shade(g, 'rgba(190,206,226,.16)', 'rgba(0,0,0,.34)');
  });
  { // boss emissive: glowing slits, aligned with the EYES tile
    const x0 = tOX(T.EYES), y0 = tOY(T.EYES);
    eg.fillStyle = '#ffb04a'; eg.fillRect(x0 + S * 0.17, y0 + S * 0.365, S * 0.26, S * 0.075);
    eg.fillRect(x0 + S * 0.57, y0 + S * 0.365, S * 0.26, S * 0.075);
    eg.fillStyle = 'rgba(255,140,40,.45)'; eg.fillRect(x0 + S * 0.13, y0 + S * 0.33, S * 0.34, S * 0.145);
    eg.fillRect(x0 + S * 0.53, y0 + S * 0.33, S * 0.34, S * 0.145);
  }
  tile(T.WOOD, 0.80, 0.0, g => {                       // haft grain runs along V
    g.fillStyle = '#7a5836'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 60; i++) {
      const x = arng() * S; g.strokeStyle = rgba(arng() < 0.55 ? 54 : 178, arng() < 0.55 ? 36 : 144, arng() < 0.55 ? 20 : 102, ar(0.06, 0.20));
      g.lineWidth = ar(1, 3.4) * u; g.beginPath(); g.moveTo(x, 0);
      for (let y = 0; y <= S; y += S / 6) g.lineTo(x + Math.sin(y * 0.05 + i) * 2.6 * u, y);
      g.stroke();
    }
    const vg = g.createLinearGradient(0, 0, S, 0);
    vg.addColorStop(0, 'rgba(0,0,0,.32)'); vg.addColorStop(0.38, 'rgba(255,230,190,.12)'); vg.addColorStop(1, 'rgba(0,0,0,.34)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);
  });
  tile(T.BLADE, 0.16, 1.0, g => {
    const gr = g.createLinearGradient(0, 0, S, 0);
    gr.addColorStop(0, '#eff4f8'); gr.addColorStop(0.17, '#aab4bf'); gr.addColorStop(0.5, '#d8e0e8');
    gr.addColorStop(0.83, '#9fa9b4'); gr.addColorStop(1, '#f2f6fa');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(70,80,92,.32)'; g.fillRect(S * 0.44, 0, S * 0.12, S);
    for (let i = 0; i < 70; i++) { g.strokeStyle = rgba(arng() < 0.5 ? 255 : 58, arng() < 0.5 ? 255 : 68, arng() < 0.5 ? 255 : 80, ar(0.05, 0.13)); g.lineWidth = ar(0.7, 1.8) * u; const y = arng() * S; g.beginPath(); g.moveTo(arng() * S * 0.4, y); g.lineTo(S * 0.5 + arng() * S * 0.5, y + ar(-4, 4) * u); g.stroke(); }
  });
  // FACTION SEPARATION: iron is the RED army's metal. At 0.90 metalness it mirrored the
  // sky IBL and every kettle helm and brow plate came out #2e5fa3 — the blue army's own
  // colour — so red and blue units stopped being separable at gameplay zoom. Rough, warm
  // and only half metallic, it now reads as forged iron under a warm sun instead.
  tile(T.IRON, 0.62, 0.46, g => {
    g.fillStyle = '#3d3730'; g.fillRect(0, 0, S, S);
    blot(g, 190, '#120f0c', '#8b8175', 0.06, 0.17, 2, 14);
    shade(g, 'rgba(240,222,192,.18)', 'rgba(0,0,0,.34)');
  });
  tile(T.GOLD, 0.28, 1.0, g => {
    const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, '#ffeaab'); gr.addColorStop(0.40, '#e0ab3c'); gr.addColorStop(1, '#8a5f14');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 50; i++) { g.strokeStyle = rgba(arng() < 0.5 ? 255 : 92, arng() < 0.5 ? 250 : 62, arng() < 0.5 ? 214 : 14, ar(0.08, 0.18)); g.lineWidth = ar(0.8, 2.4) * u; const y = arng() * S; g.beginPath(); g.moveTo(0, y); g.lineTo(S, y + ar(-5, 5) * u); g.stroke(); }
  });
  tile(T.BONE, 0.56, 0.0, g => {
    const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, '#e6dcc2'); gr.addColorStop(0.6, '#c3b697'); gr.addColorStop(1, '#7d7259');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    blot(g, 90, '#6a5f46', '#f6efdc', 0.06, 0.16, 3, 16);
    for (let i = 0; i < 22; i++) { g.strokeStyle = 'rgba(84,74,54,' + ar(0.10, 0.24) + ')'; g.lineWidth = ar(0.8, 1.8) * u; const x = arng() * S; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + ar(-6, 6) * u, S); g.stroke(); }
  });
  tile(T.FUR, 0.92, 0.0, g => {
    g.fillStyle = '#3a2b1e'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 620; i++) {
      const x = arng() * S, y = arng() * S, l = ar(6, 26) * u, a = Math.PI * 0.5 + ar(-0.55, 0.55);
      g.strokeStyle = rgba(arng() < 0.42 ? 20 : 138, arng() < 0.42 ? 14 : 108, arng() < 0.42 ? 9 : 74, ar(0.10, 0.26));
      g.lineWidth = ar(0.8, 2.2) * u; g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + ar(-4, 4) * u, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    shade(g, 'rgba(226,206,176,.12)', 'rgba(0,0,0,.34)');
  });
  tile(T.PLUME, 0.86, 0.0, g => {
    g.fillStyle = '#e8eef4'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#2b5da1'; g.fillRect(0, 0, S, S * 0.42);
    for (let i = 0; i < 220; i++) {
      const y = arng() * S, x = arng() * S, l = ar(5, 20) * u;
      g.strokeStyle = y < S * 0.42 ? rgba(20 + arng() * 90, 50 + arng() * 90, 110 + arng() * 90, ar(0.12, 0.34)) : rgba(150 + arng() * 100, 150 + arng() * 100, 150 + arng() * 100, ar(0.12, 0.34));
      g.lineWidth = ar(0.8, 2) * u; g.beginPath(); g.moveTo(x, y); g.lineTo(x + ar(-4, 4) * u, y + l); g.stroke();
    }
    shade(g, 'rgba(255,255,255,.16)', 'rgba(0,0,0,.30)');
  });
  tile(T.SHBK, 0.74, 0.05, g => {                      // shield reverse: planks + straps
    g.fillStyle = '#6d4f31'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 6; i++) { const x = i * S / 6; g.fillStyle = 'rgba(0,0,0,' + (0.05 + (i & 1) * 0.07) + ')'; g.fillRect(x, 0, S / 12, S); g.fillStyle = 'rgba(0,0,0,.32)'; g.fillRect(x, 0, 1.8 * u, S); }
    blot(g, 60, '#28190c', '#a17c50', 0.06, 0.16, 4, 20);
    g.fillStyle = '#3a2a1a'; g.fillRect(0, S * 0.40, S, S * 0.16);
    g.fillStyle = 'rgba(255,232,196,.10)'; g.fillRect(0, S * 0.40, S, 2.4 * u);
    for (let i = 0; i < 5; i++) { g.fillStyle = '#8d949e'; g.beginPath(); g.arc(S * (0.12 + i * 0.19), S * 0.48, 4 * u, 0, 7); g.fill(); }
    shade(g, 'rgba(255,240,214,.08)', 'rgba(0,0,0,.34)');
  });
  tile(T.BANN, 0.86, 0.0, g => {
    g.fillStyle = '#a42a22'; g.fillRect(0, 0, S, S);
    blot(g, 30, '#560f0a', '#cf5a42', 0.06, 0.16, 8, 40);
    g.strokeStyle = '#d9a739'; g.lineWidth = 7 * u; g.strokeRect(S * 0.09, S * 0.06, S * 0.82, S * 0.88);
    g.fillStyle = 'rgba(12,8,8,.88)';                                          // claw sigil
    g.strokeStyle = 'rgba(12,8,8,.88)'; g.lineCap = 'round';
    for (let i = -1; i <= 1; i++) { g.lineWidth = (13 - Math.abs(i) * 3) * u; g.beginPath(); g.moveTo(S * (0.32 + i * 0.16), S * 0.22); g.quadraticCurveTo(S * (0.54 + i * 0.16), S * 0.52, S * (0.40 + i * 0.16), S * 0.80); g.stroke(); }
    shade(g, 'rgba(255,236,210,.14)', 'rgba(0,0,0,.36)');
  });
  { // round red shield face — the single largest facet a grunt turns to the camera, so it
    // carries #a42a22 edge to edge with the #7e1e18 shade on the underside. The rim was a
    // 13px band of cold steel and the boss a mirror cone: together they out-valued the
    // paint and the whole column sampled steel-dominant from the overview camera.
    const rimC = '#33281f';                            // dark warm iron: defines the disc's
    // edge without putting a ring of sky-mirroring steel on 160 shields at once
    tile(T.SHR, 0.64, 0.10, g => {
      g.fillStyle = rimC; g.fillRect(0, 0, S, S);
      g.save(); g.beginPath(); g.arc(S / 2, S / 2, S * 0.5, 0, 7); g.clip();
      g.fillStyle = '#a42a22'; g.fillRect(0, 0, S, S);
      const ug = g.createLinearGradient(0, S * 0.42, 0, S);           // #7e1e18 underside
      ug.addColorStop(0, 'rgba(126,30,24,0)'); ug.addColorStop(1, '#7e1e18');
      g.fillStyle = ug; g.fillRect(0, S * 0.42, S, S * 0.58);
      for (let i = 0; i < 7; i++) { const x = i * S / 7; g.fillStyle = 'rgba(0,0,0,' + (0.04 + (i & 1) * 0.05) + ')'; g.fillRect(x, 0, S / 14, S); g.fillStyle = 'rgba(255,222,196,.05)'; g.fillRect(x + S / 14, 0, 2 * u, S); }
      blot(g, 44, '#4a0e08', '#d0684e', 0.05, 0.14, 6, 30);
      g.strokeStyle = 'rgba(28,10,8,.78)'; g.lineCap = 'round';
      for (let i = -1; i <= 1; i++) { g.lineWidth = (15 - Math.abs(i) * 3) * u; g.beginPath(); g.moveTo(S * (0.30 + i * 0.15), S * 0.16); g.quadraticCurveTo(S * (0.52 + i * 0.16), S * 0.52, S * (0.38 + i * 0.16), S * 0.86); g.stroke(); }
      const vg = g.createRadialGradient(S * 0.38, S * 0.32, S * 0.05, S * 0.5, S * 0.5, S * 0.55);
      vg.addColorStop(0, 'rgba(255,222,186,.15)'); vg.addColorStop(0.68, 'rgba(0,0,0,.05)'); vg.addColorStop(1, 'rgba(0,0,0,.44)');
      g.fillStyle = vg; g.fillRect(0, 0, S, S);
      g.restore();
      g.strokeStyle = rimC; g.lineWidth = 10 * u; g.beginPath(); g.arc(S / 2, S / 2, S * 0.5 - 5 * u, 0, 7); g.stroke();
      g.strokeStyle = 'rgba(224,196,152,.30)'; g.lineWidth = 2.2 * u; g.beginPath(); g.arc(S / 2, S / 2, S * 0.5 - 9 * u, 3.55, 6.05); g.stroke();
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * TAU + 0.3, rr = S * 0.5 - 4.5 * u, cx = S / 2 + Math.cos(a) * rr, cy = S / 2 + Math.sin(a) * rr;
        g.fillStyle = '#6d6055'; g.beginPath(); g.arc(cx, cy, 3.4 * u, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,240,214,.34)'; g.beginPath(); g.arc(cx - 1.2 * u, cy - 1.2 * u, 1.4 * u, 0, 7); g.fill();
      }
    });
  }
  // kite shield outline, normalised to [-1,1]; shared by geometry and tile painter
  const KITE = [[-1.00, 0.72], [-0.78, 0.98], [0.78, 0.98], [1.00, 0.72], [0.94, 0.28],
                [0.70, -0.28], [0.36, -0.76], [0.00, -1.00], [-0.36, -0.76], [-0.70, -0.28], [-0.94, 0.28]];
  tile(T.SHB, 0.42, 0.55, g => {
    const px = n => (n * 0.5 + 0.5) * S, py = n => (1 - (n * 0.5 + 0.5)) * S;
    g.fillStyle = '#6a727c'; g.fillRect(0, 0, S, S);
    g.beginPath(); g.moveTo(px(KITE[0][0]), py(KITE[0][1]));
    for (let i = 1; i < KITE.length; i++) g.lineTo(px(KITE[i][0]), py(KITE[i][1]));
    g.closePath(); g.save(); g.clip();
    g.fillStyle = '#2b5da1'; g.fillRect(0, 0, S, S);
    blot(g, 26, '#14336a', '#5b90d2', 0.06, 0.15, 8, 40);
    g.fillStyle = '#e9eef4'; g.fillRect(px(-0.20), 0, px(0.20) - px(-0.20), S);   // cross
    g.fillStyle = '#e9eef4'; g.fillRect(0, py(0.42), S, py(0.02) - py(0.42));
    g.fillStyle = 'rgba(120,140,168,.34)'; g.fillRect(px(-0.20), 0, 3 * u, S); g.fillRect(px(0.20) - 3 * u, 0, 3 * u, S);
    const bg = g.createRadialGradient(px(-0.05), py(0.34), S * 0.03, px(0), py(0.22), S * 0.13);
    bg.addColorStop(0, '#f2f6fa'); bg.addColorStop(0.5, '#a8b0ba'); bg.addColorStop(1, '#5a6068');
    g.fillStyle = bg; g.beginPath(); g.arc(px(0), py(0.22), S * 0.115, 0, 7); g.fill();
    g.fillStyle = '#d9a739'; g.beginPath(); g.arc(px(0), py(0.22), S * 0.055, 0, 7); g.fill();
    const vg = g.createRadialGradient(px(-0.4), py(0.6), S * 0.05, px(0), py(0.1), S * 0.72);
    vg.addColorStop(0, 'rgba(255,244,226,.20)'); vg.addColorStop(0.7, 'rgba(0,0,0,.06)'); vg.addColorStop(1, 'rgba(0,0,0,.42)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);
    g.restore();
    g.lineWidth = 9 * u; g.strokeStyle = '#7e868f'; g.stroke();
    g.lineWidth = 2.4 * u; g.strokeStyle = 'rgba(226,236,246,.42)'; g.stroke();
  });

  // ── SPEC2 §D tiles ──
  tile(T.PAV, 0.68, 0.10, g => {                       // pavise face: banded planks + boss
    g.fillStyle = '#a42a22'; g.fillRect(0, 0, S, S);
    { const ug = g.createLinearGradient(0, S * 0.40, 0, S);
      ug.addColorStop(0, 'rgba(126,30,24,0)'); ug.addColorStop(1, '#7e1e18');
      g.fillStyle = ug; g.fillRect(0, S * 0.40, S, S * 0.60); }
    for (let i = 0; i < 5; i++) {                      // vertical boards with dark seams
      const x = i * S / 5;
      g.fillStyle = 'rgba(0,0,0,' + (0.05 + (i & 1) * 0.07) + ')'; g.fillRect(x, 0, S / 10, S);
      g.fillStyle = 'rgba(10,5,4,.55)'; g.fillRect(x, 0, 2.6 * u, S);
      g.fillStyle = 'rgba(255,214,186,.07)'; g.fillRect(x + 2.6 * u, 0, 1.8 * u, S);
    }
    blot(g, 54, '#3a0906', '#c05a42', 0.06, 0.16, 6, 30);
    for (const yy of [S * 0.14, S * 0.84]) {           // iron bands, riveted — warm, not steel
      g.fillStyle = '#42392f'; g.fillRect(0, yy, S, S * 0.070);
      g.fillStyle = 'rgba(240,224,196,.24)'; g.fillRect(0, yy, S, 2.4 * u);
      g.fillStyle = 'rgba(0,0,0,.44)'; g.fillRect(0, yy + S * 0.070 - 2.4 * u, S, 2.4 * u);
      for (let i = 0; i < 6; i++) { g.fillStyle = '#7d7264'; g.beginPath(); g.arc(S * (0.09 + i * 0.166), yy + S * 0.036, 3.6 * u, 0, 7); g.fill(); }
    }
    g.strokeStyle = 'rgba(14,9,9,.86)'; g.lineCap = 'round';   // the horde's claw
    for (let i = -1; i <= 1; i++) { g.lineWidth = (14 - Math.abs(i) * 3) * u; g.beginPath(); g.moveTo(S * (0.30 + i * 0.16), S * 0.30); g.quadraticCurveTo(S * (0.53 + i * 0.16), S * 0.54, S * (0.38 + i * 0.16), S * 0.74); g.stroke(); }
    const bg2 = g.createRadialGradient(S * 0.46, S * 0.44, S * 0.02, S * 0.5, S * 0.5, S * 0.10);
    bg2.addColorStop(0, '#d8cbb2'); bg2.addColorStop(0.55, '#7d7264'); bg2.addColorStop(1, '#3f382f');
    g.fillStyle = bg2; g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.082, 0, 7); g.fill();
    const vg = g.createRadialGradient(S * 0.36, S * 0.26, S * 0.05, S * 0.5, S * 0.5, S * 0.78);
    vg.addColorStop(0, 'rgba(255,236,208,.16)'); vg.addColorStop(0.7, 'rgba(0,0,0,.06)'); vg.addColorStop(1, 'rgba(0,0,0,.46)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);
  });
  tile(T.HIDE, 0.88, 0.0, g => {                       // ogre hide: grey-green, warty, scarred
    g.fillStyle = '#6f7a56'; g.fillRect(0, 0, S, S);
    blot(g, 240, '#3a4028', '#9aa676', 0.05, 0.14, 3, 18);
    for (let i = 0; i < 90; i++) {                     // warts, lit from above
      const x = arng() * S, y = arng() * S, r = ar(2.2, 6.4) * u;
      g.fillStyle = 'rgba(58,64,40,.42)'; g.beginPath(); g.arc(x, y + r * 0.3, r, 0, 7); g.fill();
      g.fillStyle = 'rgba(186,196,150,.34)'; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.3, r * 0.55, 0, 7); g.fill();
    }
    for (let i = 0; i < 7; i++) {                      // old scars
      const x = arng() * S, y = arng() * S, a = arng() * 3.14, l = ar(20, 64) * u;
      g.strokeStyle = 'rgba(196,176,150,.30)'; g.lineWidth = ar(1.6, 3.4) * u;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    shade(g, 'rgba(228,240,206,.13)', 'rgba(0,0,0,.36)');
  });
  // ══ SPEC3 §B materials ═══════════════════════════════════════════════════════
  // FROST: rimed plate. Cold and pale — the ONE place the red army is allowed a cool
  // value, because the frost revenant is a dead thing wearing armour the snow has eaten.
  tile(T.FROST, 0.44, 0.52, g => {
    const gr = g.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, '#cfe0ea'); gr.addColorStop(0.44, '#8ea4b4'); gr.addColorStop(1, '#4d6070');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    blot(g, 120, '#2e4050', '#e8f4fa', 0.06, 0.18, 3, 17);
    for (let i = 0; i < 46; i++) {                     // rime crystals along the plate edges
      const x = arng() * S, y = arng() * S, l = ar(6, 22) * u, a = ar(-1.2, -0.35);
      g.strokeStyle = 'rgba(232,246,255,' + ar(0.16, 0.44) + ')'; g.lineWidth = ar(1.2, 3.0) * u;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(226,242,252,.30)'; g.fillRect(0, S * (0.06 + i * 0.16), S, 2.6 * u); }
    shade(g, 'rgba(238,250,255,.20)', 'rgba(6,14,24,.40)');
  });
  // SHROUD: grave linen, rotted through. Nearly value-less on purpose — the wraith is a
  // hole in the road with two coals in it, and any texture louder than this fills it in.
  tile(T.SHROUD, 0.95, 0.0, g => {
    g.fillStyle = '#2a2930'; g.fillRect(0, 0, S, S);
    const st = 4.0 * u;
    for (let i = 0; i * st < S; i++) { g.fillStyle = (i & 1) ? 'rgba(206,200,196,.055)' : 'rgba(0,0,0,.10)'; g.fillRect(i * st, 0, 2.2 * u, S); }
    blot(g, 90, '#17161a', '#7d7a80', 0.06, 0.18, 6, 34);
    for (let i = 0; i < 30; i++) {                     // rents and moth-holes
      const x = arng() * S, y = arng() * S;
      g.fillStyle = 'rgba(8,7,10,' + ar(0.24, 0.60) + ')';
      g.beginPath(); g.ellipse(x, y, ar(2, 9) * u, ar(4, 20) * u, arng() * 3, 0, 7); g.fill();
    }
    shade(g, 'rgba(190,196,210,.10)', 'rgba(0,0,0,.52)');
  });
  // EMBER: charcoal cracked over a fire that has not gone out. Its cracks are painted into
  // the EMISSIVE sheet as well, so anything wearing this tile actually glows.
  tile(T.EMBER, 0.72, 0.10, g => {
    g.fillStyle = '#191512'; g.fillRect(0, 0, S, S);
    blot(g, 140, '#070605', '#4a3f36', 0.08, 0.22, 3, 16);
    for (let i = 0; i < 9; i++) {                      // glowing fissures
      let x = arng() * S, y = arng() * S;
      g.lineCap = 'round';
      for (let k = 0; k < 5; k++) {
        const nx = x + ar(-30, 30) * u, ny = y + ar(-30, 30) * u;
        g.strokeStyle = 'rgba(255,146,42,' + ar(0.40, 0.88) + ')'; g.lineWidth = ar(1.6, 4.6) * u;
        g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
        g.strokeStyle = 'rgba(255,226,150,.42)'; g.lineWidth = ar(0.7, 1.7) * u;
        g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
        x = nx; y = ny;
      }
    }
    shade(g, 'rgba(255,190,120,.10)', 'rgba(0,0,0,.42)');
  });
  { // the same fissure pattern, re-drawn additively into the emissive sheet
    const x0 = tOX(T.EMBER), y0 = tOY(T.EMBER);
    eg.save(); eg.beginPath(); eg.rect(x0, y0, S, S); eg.clip(); eg.translate(x0, y0);
    for (let i = 0; i < 9; i++) {
      let x = arng() * S, y = arng() * S;
      eg.lineCap = 'round';
      for (let k = 0; k < 5; k++) {
        const nx = x + ar(-30, 30) * u, ny = y + ar(-30, 30) * u;
        eg.strokeStyle = 'rgba(255,138,36,' + ar(0.45, 0.95) + ')'; eg.lineWidth = ar(2.4, 6.0) * u;
        eg.beginPath(); eg.moveTo(x, y); eg.lineTo(nx, ny); eg.stroke();
        x = nx; y = ny;
      }
    }
    eg.restore();
  }
  // ROBE: the war shaman's boiled wool — ochre and bone, no metal anywhere, so the healer
  // never gets mistaken for a line trooper at the range you have to pick him out at.
  clothTile(T.ROBE, '#6b5a2e', '#33290f', '#a89152', 0.93);

  const albedo = new THREE.CanvasTexture(acv); albedo.colorSpace = THREE.SRGBColorSpace; albedo.anisotropy = 8;
  const mrmap = new THREE.CanvasTexture(mcv); mrmap.colorSpace = THREE.NoColorSpace; mrmap.anisotropy = 4;
  const emmap = new THREE.CanvasTexture(ecv); emmap.colorSpace = THREE.SRGBColorSpace;

  // ── 2. geometry helpers (every part carries atlas UVs + bone id + pivots) ──
  const SEG = tier === 'mobile' ? 6 : 9;               // radial segments for rods / domes
  const DSEG = tier === 'mobile' ? 10 : 16;            // shield disc segments
  const uvAll = (g, t) => {                            // map a geometry's 0..1 UVs into a tile
    const [u0, v0, su, sv] = rectUV(t), U = g.attributes.uv;
    for (let i = 0; i < U.count; i++) U.setXY(i, u0 + U.getX(i) * su, v0 + U.getY(i) * sv);
    return g;
  };
  const boxA = (w, h, d, tiles) => {                   // box with a per-face tile: +x -x +y -y +z -z
    const g = new THREE.BoxGeometry(w, h, d), U = g.attributes.uv;
    for (let f = 0; f < 6; f++) {
      const [u0, v0, su, sv] = rectUV(tiles[Math.min(f, tiles.length - 1)]);
      for (let k = 0; k < 4; k++) { const i = f * 4 + k; U.setXY(i, u0 + U.getX(i) * su, v0 + U.getY(i) * sv); }
    }
    return g;
  };
  const tbox = (w, h, d, tiles, botS, topS) => {       // tapered box (bottom scale -> top scale)
    const g = boxA(w, h, d, tiles), P = g.attributes.position;
    const b = botS === undefined ? 1 : botS, t = topS === undefined ? 1 : topS;
    if (b !== 1 || t !== 1) {
      for (let i = 0; i < P.count; i++) { const s = lerp(b, t, (P.getY(i) + h / 2) / h); P.setX(i, P.getX(i) * s); P.setZ(i, P.getZ(i) * s); }
      g.computeVertexNormals();
    }
    return g;
  };
  const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vu = new THREE.Vector3(0, 1, 0);
  const spanM = (a, b) => {                            // matrix that maps a +y unit segment onto a->b
    _vb.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const L = _vb.length() || 1e-5; _vb.multiplyScalar(1 / L);
    return [new THREE.Matrix4().compose(_va.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
      new THREE.Quaternion().setFromUnitVectors(_vu, _vb), _sc.set(1, 1, 1)), L];
  };
  // plate: extrude a 2D polygon (CCW, fan-safe) — blades, banners, capes, shields
  const plateGeo = (pts, th, tF, tB, tS) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const N = pts.length, pos = [], nor = [], uvs = [], idx = [];
    let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; } cx /= N; cy /= N;
    for (const s of [1, -1]) {
      const [u0, v0, su, sv] = rectUV(s > 0 ? tF : (tB === undefined ? tF : tB));
      const uv = (x, y) => [u0 + ((x - x0) / (x1 - x0)) * su, v0 + ((y - y0) / (y1 - y0)) * sv];
      const base = pos.length / 3;
      pos.push(cx, cy, s * th / 2); nor.push(0, 0, s); uvs.push(...uv(cx, cy));
      for (const p of pts) { pos.push(p[0], p[1], s * th / 2); nor.push(0, 0, s); uvs.push(...uv(p[0], p[1])); }
      for (let i = 0; i < N; i++) { const a = base + 1 + i, b = base + 1 + (i + 1) % N; if (s > 0) idx.push(base, a, b); else idx.push(base, b, a); }
    }
    const [su0, sv0, ssu, ssv] = rectUV(tS === undefined ? (tB === undefined ? tF : tB) : tS);
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const nx = dy / L, ny = -dx / L, o = pos.length / 3;
      pos.push(a[0], a[1], th / 2, b[0], b[1], th / 2, b[0], b[1], -th / 2, a[0], a[1], -th / 2);
      for (let k = 0; k < 4; k++) nor.push(nx, ny, 0);
      uvs.push(su0 + ssu * 0.46, sv0 + ssv * 0.12, su0 + ssu * 0.46, sv0 + ssv * 0.88,
               su0 + ssu * 0.56, sv0 + ssv * 0.88, su0 + ssu * 0.56, sv0 + ssv * 0.12);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  };
  const polyC = (r, n, sq) => { const p = []; for (let i = 0; i < n; i++) { const a = i / n * TAU; p.push([Math.cos(a) * r, Math.sin(a) * r * (sq || 1)]); } return p; };

  // ── 3. merge: bakes bone id, pivot, parent pivot, cloth weight and vertex AO ──
  function mergeA(parts, H) {
    let vc = 0, ic = 0;
    for (const p of parts) { idxd(p.g); if (!p.g.attributes.normal) p.g.computeVertexNormals(); vc += p.g.attributes.position.count; ic += p.g.index.count; }
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uvs = new Float32Array(vc * 2),
          col = new Float32Array(vc * 3), bon = new Float32Array(vc), pv = new Float32Array(vc * 3),
          pv2 = new Float32Array(vc * 3), wgt = new Float32Array(vc), idx = new Uint32Array(ic);
    const nm = new THREE.Matrix3(), v = new THREE.Vector3(), w = new THREE.Vector3(), I4 = new THREE.Matrix4();
    let vo = 0, io = 0;
    for (const p of parts) {
      const g = p.g, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      const m = p.m || I4; nm.getNormalMatrix(m);
      const tint = p.tint === undefined ? 1 : p.tint;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m);
        const o3 = (vo + i) * 3;
        pos[o3] = v.x; pos[o3 + 1] = v.y; pos[o3 + 2] = v.z;
        w.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        nor[o3] = w.x; nor[o3 + 1] = w.y; nor[o3 + 2] = w.z;
        uvs[(vo + i) * 2] = U.getX(i); uvs[(vo + i) * 2 + 1] = U.getY(i);
        // vertex AO: light falls off toward the ground and into the body core
        const gr = 0.60 + 0.40 * clamp(v.y / (H * 0.80), 0, 1);
        const core = 1 - 0.10 * clamp(1 - Math.hypot(v.x, v.z) / (H * 0.14), 0, 1);
        const jt = 0.95 + 0.10 * vnz(v.x * 9 + v.y * 5, v.z * 9 + v.y * 3);
        const c = tint * gr * core * jt;
        col[o3] = c; col[o3 + 1] = c; col[o3 + 2] = c;
        bon[vo + i] = p.bone;
        pv[o3] = p.piv[0]; pv[o3 + 1] = p.piv[1]; pv[o3 + 2] = p.piv[2];
        const q = p.piv2 || p.piv;
        pv2[o3] = q[0]; pv2[o3 + 1] = q[1]; pv2[o3 + 2] = q[2];
        wgt[vo + i] = p.w ? p.w(v.x, v.y, v.z) : 0;
      }
      const IX = g.index; for (let i = 0; i < IX.count; i++) idx[io + i] = IX.getX(i) + vo;
      vo += P.count; io += IX.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aBone', new THREE.BufferAttribute(bon, 1));
    out.setAttribute('aPiv', new THREE.BufferAttribute(pv, 3));
    out.setAttribute('aPiv2', new THREE.BufferAttribute(pv2, 3));
    out.setAttribute('aW', new THREE.BufferAttribute(wgt, 1));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  // ── 4. archetype construction ──
  // Heroic proportions: ~6.5 heads. Bones: 0 root, 1/2 thigh L/R, 3/4 shin L/R,
  // 5 shield arm, 6 weapon arm, 7 head, 8 cloth (tabard / cape / banner).
  function buildSoldier(C) {
    const p = [];
    const A = (g, m, bone, piv, piv2, w, tint) => { p.push({ g, m: m || null, bone: bone || 0, piv: piv || [0, 0, 0], piv2: piv2 || null, w: w || null, tint }); };
    const k = C.h / 1.80, K = v => v * k, B = C.bulk, W = C.bulk * 0.93;
    const rod = (a, b, r1, r2, t, bone, piv, piv2, tint) => {
      const [m, L] = spanM(a, b);
      A(uvAll(new THREE.CylinderGeometry(r2, r1, L, C.seg || SEG, 1, false), t), m, bone, piv, piv2, null, tint);
    };
    const limb = (a, b, w1, w2, tiles, bone, piv, piv2, tint) => {
      const [m, L] = spanM(a, b);
      A(tbox(w1, L, w1 * 0.92, tiles, 1, w2 / w1), m, bone, piv, piv2, null, tint);
    };
    // legF shortens the legs and drops everything above the hip by the same amount, which
    // is the whole difference between "tall man" and "ogre": heroic 6.5-head proportions
    // read as human no matter how big you scale them. legF === 1 is the original skeleton.
    const LG = C.legF === undefined ? 1 : C.legF, drop = K(0.90) * (1 - LG);
    const yAnk = K(0.085) * LG, yKne = K(0.44) * LG, yHip = K(0.90) * LG,
          yWst = K(1.00) - drop, yCst = K(1.36) - drop,
          ySh = K(1.375) - drop;
    // headDrop sinks the skull INTO the chest cavity: a mini-boss with a visible neck reads
    // as a tall man, and no amount of scale fixes that. shF widens the shoulder line against
    // the hips independently of `bulk`, which also thickens the waist.
    const hsk = K(C.headDrop || 0);
    const yNck = K(1.425) - drop - hsk, yChn = K(1.45) - drop - hsk, yCrn = K(1.71) - drop - hsk;
    const hipX = K(0.105) * B, shX = K(0.238) * B * (C.shF || 1);

    // ── legs ──
    for (const s of [-1, 1]) {
      const bT = s < 0 ? 1 : 2, bS = s < 0 ? 3 : 4;
      const hipP = [s * hipX, yHip, 0], kneP = [s * hipX * 0.96, yKne, 0];
      limb([s * hipX, yHip + K(0.03), 0], [s * hipX * 0.96, yKne, 0], K(0.185) * B, K(0.150) * B, [C.hose], bT, hipP, null, 0.94);
      // the shin now runs PAST the ankle and into the boot shaft, and a cuff straddles the
      // seam: the old pair met exactly at yAnk and any knee flex opened a visible hole
      // between shin bottom and boot top on both legs.
      limb([s * hipX * 0.96, yKne + K(0.01), 0], [s * hipX * 0.94, yAnk - K(0.055), 0], K(0.152) * B, K(0.118) * B, [C.shin], bS, kneP, hipP, 0.90);
      A(uvAll(new THREE.CylinderGeometry(K(0.098) * B, K(0.112) * B, K(0.070), (C.seg || SEG)), C.knee ? (C.kneeT || T.IRON) : T.LEATH),
        trs(s * hipX * 0.94, yAnk + K(0.012), K(0.006)), bS, kneP, hipP, null, 0.86);
      // knee: a cop plate over the joint, not a bare ball — the leg reads as two articulated
      // segments instead of one tapered cylinder once there is a hard edge at the pivot
      if (C.knee) {
        A(uvAll(new THREE.SphereGeometry(K(0.084) * B, 7, 5), C.kneeT || T.IRON), trs(s * hipX * 0.96, yKne, K(0.028), 0, 1, 0.86, 1), bS, kneP, hipP, null, 1.06);
        A(tbox(K(0.148) * B, K(0.086), K(0.058), [C.kneeT || T.IRON], 1.0, 0.72), trs(s * hipX * 0.96, yKne - K(0.052), K(0.062), 0, 1, 1, 1, 0.30), bS, kneP, hipP, null, 1.10);
      }
      A(boxA(K(0.170) * B, K(0.128), K(0.29), [T.LEATH]), trs(s * hipX * 0.94, K(0.052), K(0.048)), bS, kneP, hipP, null, 0.80);
      A(boxA(K(0.176) * B, K(0.055), K(0.10), [T.IRON]), trs(s * hipX * 0.94, K(0.020), K(0.185)), bS, kneP, hipP, null, 0.88);
    }
    // ── pelvis / skirt / torso / belt ──
    A(tbox(K(0.36) * B, K(0.18), K(0.27) * W, [C.mail], 1.0, 0.94), trs(0, yHip + K(0.05), 0), 0, null, null, null, 0.95);
    if (C.skirt >= 0) A(uvAll(new THREE.CylinderGeometry(K(0.215) * B, K(0.285) * B, K(0.26), C.seg || SEG, 1, false), C.skirt), trs(0, yHip - K(0.03), 0), 0, null, null, null, 0.92);
    A(tbox(K(0.415) * B, yCst - yWst, K(0.265) * W, [C.mail], 0.92, 1.06), trs(0, (yCst + yWst) / 2, 0), 0, null, null, null, 1.0);
    A(boxA(K(0.44) * B, K(0.080), K(0.30) * W, [T.LEATH]), trs(0, yWst + K(0.012), 0), 0, null, null, null, 0.92);
    A(boxA(K(0.090), K(0.078), K(0.035), [T.GOLD]), trs(0, yWst + K(0.012), K(0.156) * W), 0, null, null, null, 1.1);
    if (C.chest >= 0) A(tbox(K(0.30) * B, K(0.22), K(0.05), [T.IRON, T.IRON, T.IRON, T.IRON, C.chest, T.IRON]), trs(0, yCst - K(0.13), K(0.140) * W), 0, null, null, null, 1.04);
    // ── surcoat / tabard (cloth bone: hem flutters) ──
    if (C.tabard >= 0) {
      const tw = K(0.365) * B * (C.tabW === undefined ? 1 : C.tabW), ty0 = yHip - K(0.24), ty1 = yCst + K(0.005);
      for (const s of [1, -1]) {
        const fc = s > 0 ? [T.IRON, T.IRON, T.IRON, T.IRON, C.tabard, T.IRON] : [T.IRON, T.IRON, T.IRON, T.IRON, T.IRON, C.tabard];
        A(boxA(tw, ty1 - ty0, K(0.024), fc), trs(0, (ty0 + ty1) / 2, s * (K(0.136) * W + K(0.014))), 8, null, null,
          (x, y) => clamp((yWst - y) / (yWst - ty0), 0, 1), 1.02);
        A(boxA(tw * 1.03, K(0.030), K(0.032), [T.GOLD]), trs(0, ty0 + K(0.015), s * (K(0.136) * W + K(0.014))), 8, null, null, () => 1, 1.1);
      }
    }
    // ── shoulders ──
    for (const s of [-1, 1])
      A(tbox(K(0.145) * B, K(0.120), K(0.245) * W, [C.pauld], 1.0, 0.66), trs(s * (shX + K(0.012)), ySh + K(0.012), 0, 0, 1, 1, 1, 0, -s * 0.24), 0, null, null, null, 1.06);
    // ── arms: 5 = shield side (-x), 6 = weapon side (+x) ──
    const shL = [-shX, ySh, 0], shR = [shX, ySh, 0];
    const elbL = [-shX - K(0.02), ySh - K(0.255), K(0.015)], elbR = [shX + K(0.02), ySh - K(0.26), K(0.02)];
    const hndL = C.handL || [-shX - K(0.090), ySh - K(0.30), K(0.215)];
    const hndR = C.handR || [shX + K(0.03), ySh - K(0.325), K(0.215)];
    const aT = C.armTint === undefined ? 1 : C.armTint;
    // A bare cube at the wrist reads as "no hand" the moment the camera gets close, and the
    // sword grip terminated in one. A five-part mitten — cuff, tapered palm, knuckle mass,
    // thumb — costs 3 boxes and closes the single worst closeup tell in the whole rig.
    const mitt = (h, s, bone, piv, tint) => {
      A(tbox(K(0.104) * B, K(0.070), K(0.120), [C.hand], 1.0, 0.90), trs(h[0], h[1] + K(0.032), h[2] - K(0.004)), bone, piv, null, null, tint * 1.02);
      A(tbox(K(0.094) * B, K(0.108), K(0.118), [C.hand], 1.0, 0.80), trs(h[0], h[1] - K(0.024), h[2] + K(0.010)), bone, piv, null, null, tint);
      A(uvAll(new THREE.SphereGeometry(K(0.052) * B, 6, 5), C.hand),
        trs(h[0], h[1] - K(0.062), h[2] + K(0.022), 0, 1.0, 0.82, 1.06), bone, piv, null, null, tint * 0.96);
      A(boxA(K(0.036), K(0.058), K(0.046), [C.hand]), trs(h[0] - s * K(0.052) * B, h[1] - K(0.008), h[2] + K(0.038), 0, 1, 1, 1, 0, s * 0.42), bone, piv, null, null, tint * 1.04);
    };
    limb(shL, elbL, K(0.125) * B, K(0.105) * B, [C.arm], 5, shL, null, 0.98 * aT);
    limb(elbL, hndL, K(0.108) * B, K(0.092) * B, [C.arm], 5, shL, null, 0.95 * aT);
    mitt(hndL, -1, 5, shL, 0.92 * aT);
    limb(shR, elbR, K(0.125) * B, K(0.105) * B, [C.arm], 6, shR, null, 0.98 * aT);
    limb(elbR, hndR, K(0.108) * B, K(0.092) * B, [C.arm], 6, shR, null, 0.95 * aT);
    mitt(hndR, 1, 6, shR, 0.92 * aT);
    if (C.bracer) for (const [h, bo, pv] of [[hndL, 5, shL], [hndR, 6, shR]])
      A(uvAll(new THREE.CylinderGeometry(K(0.072), K(0.078), K(0.12), 7), T.IRON), trs(h[0], h[1] + K(0.09), h[2] - K(0.035), 0, 1, 1, 1, -1.1), bo, pv, null, null, 1.04);
    // ── neck + head ──
    const SKN = C.skin === undefined ? T.SKIN : C.skin, HRT = C.hair === undefined ? T.HAIR : C.hair;
    const HS = C.headS || 1;                             // brutish skulls read wider, not taller
    if (!C.headDrop) A(uvAll(new THREE.CylinderGeometry(K(0.072) * B, K(0.086) * B, K(0.075), 7), SKN), trs(0, yNck, 0), 7, [0, yNck - K(0.02), 0], null, null, 0.80);
    else A(uvAll(new THREE.SphereGeometry(K(0.230) * B, C.seg || SEG, 6), SKN),   // trapezius slab: mass where the neck would be
      trs(0, ySh + K(0.02), -K(0.02), 0, 1.10, 0.62, 0.90), 0, null, null, null, 0.86);
    A(tbox(K(0.192) * HS, yCrn - yChn, K(0.214) * HS, [SKN, SKN, HRT, SKN, C.face, HRT], 0.90, 1.0),
      trs(0, (yChn + yCrn) / 2, 0), 7, [0, yNck - K(0.02), 0], null, null, 1.0);
    A(boxA(K(0.038), K(0.055), K(0.042), [SKN]), trs(0, yChn + K(0.112), K(0.118) * HS), 7, [0, yNck - K(0.02), 0], null, null, 0.98);
    const hp = [0, yNck - K(0.02), 0];
    // The helmet bowl must swallow the skull down to the brow (sphere cap swept past the
    // equator) or the head reads as a pale block at every zoom level.
    // ── helmets ──
    const dome = (r, sy, t, yy, tint) => A(uvAll(new THREE.SphereGeometry(r, C.seg || SEG, 6, 0, TAU, 0, 1.88), t), trs(0, yy, 0, 0, 1, sy, 1), 7, hp, null, null, tint);
    // Aventail: a mail curtain from the helm rim over the neck and cheeks, open at the face.
    // Without it the exposed skin below the bowl reads as a pale block at every zoom.
    const aventail = (rt, rb, yTop, hgt, t) => A(uvAll(new THREE.CylinderGeometry(rt, rb, hgt, (C.seg || SEG) + 3, 1, true, 0.86, TAU - 1.72), t),
      trs(0, yTop - hgt / 2, 0), 7, hp, null, null, 0.90);
    // helm ridge: a low crest front-to-back so the bowl is not a perfect polished sphere
    const ridge = (r, yy, t) => A(boxA(K(0.036), K(0.048), r * 1.96, [t]), trs(0, yy, 0), 7, hp, null, null, 1.14);
    if (C.helm === 'nasal') {
      // helmT/helmTint: the dome used to be polished T.STEEL at tint 1.12 — one bright
      // specular cap per unit, 160 of them, and the horde sampled steel-dominant from the
      // overview camera. Warm iron at unity carries the same silhouette at a quarter of the
      // luminance, and a red crest + red cheek scales put the paint back on the head.
      const HT = C.helmT || T.STEEL, HTI = C.helmTint === undefined ? 1.12 : C.helmTint;
      dome(K(0.150), 1.04, HT, yCrn - K(0.078), HTI);
      ridge(K(0.150), yCrn + K(0.046), T.IRON);
      aventail(K(0.155), K(0.196), yCrn - K(0.145), K(0.235), T.MAIL);
      A(uvAll(new THREE.CylinderGeometry(K(0.152), K(0.160), K(0.050), C.seg + 2 || 10), T.RED), trs(0, yCrn - K(0.128), 0), 7, hp, null, null, 1.06);
      A(boxA(K(0.032), K(0.130), K(0.036), [T.IRON]), trs(0, yCrn - K(0.208), K(0.114)), 7, hp, null, null, 1.0);
      for (const s of [-1, 1])                            // red cheek scales flanking the face
        A(boxA(K(0.030), K(0.140), K(0.090), [T.RED]), trs(s * K(0.134), yCrn - K(0.212), K(0.070)), 7, hp, null, null, 1.02);
      A(boxA(K(0.030), K(0.086), K(0.030), [T.RED]), trs(0, yCrn + K(0.104), 0), 7, hp, null, null, 1.08);
    } else if (C.helm === 'wrap') {                          // skirmisher hood + headband
      dome(K(0.147), 0.98, T.CRIM, yCrn - K(0.086), 1.05);
      A(uvAll(new THREE.CylinderGeometry(K(0.150), K(0.154), K(0.046), C.seg + 2 || 10), T.RED), trs(0, yCrn - K(0.140), 0), 7, hp, null, null, 1.08);
      A(plateGeo([[-K(0.032), 0], [K(0.032), 0], [K(0.060), -K(0.26)], [-K(0.022), -K(0.31)]], K(0.014), T.RED, T.CRIM),
        trs(-K(0.10), yCrn - K(0.16), -K(0.06), 0.5), 8, null, null, (x, y) => clamp((yCrn - K(0.16) - y) / K(0.31), 0, 1), 1.0);
    } else if (C.helm === 'horned') {
      dome(K(0.160), 1.06, T.IRON, yCrn - K(0.086), 1.05);
      aventail(K(0.166), K(0.215), yCrn - K(0.158), K(0.250), T.FUR);
      A(uvAll(new THREE.CylinderGeometry(K(0.163), K(0.170), K(0.058), C.seg + 2 || 10), T.IRON), trs(0, yCrn - K(0.140), 0), 7, hp, null, null, 1.0);
      A(boxA(K(0.140), K(0.130), K(0.042), [T.IRON]), trs(0, yCrn - K(0.235), K(0.116)), 7, hp, null, null, 1.02);
      for (const s of [-1, 1]) {
        const [m, L] = spanM([s * K(0.150), yCrn - K(0.055), K(0.010)], [s * K(0.52), yCrn + K(0.30), -K(0.06)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.022), K(0.072), L, 6), T.BONE), m, 7, hp, null, null, 1.14);
      }
    } else if (C.helm === 'plume') {
      dome(K(0.152), 1.14, T.STEEL, yCrn - K(0.072), 1.14);
      ridge(K(0.152), yCrn + K(0.082), T.STEEL);
      aventail(K(0.158), K(0.202), yCrn - K(0.150), K(0.245), T.MAIL);
      A(uvAll(new THREE.CylinderGeometry(K(0.155), K(0.163), K(0.052), C.seg + 2 || 10), T.STEEL), trs(0, yCrn - K(0.132), 0), 7, hp, null, null, 1.08);
      A(boxA(K(0.036), K(0.150), K(0.038), [T.STEEL]), trs(0, yCrn - K(0.212), K(0.116)), 7, hp, null, null, 1.14);
      A(boxA(K(0.22), K(0.038), K(0.050), [T.STEEL]), trs(0, yCrn - K(0.168), K(0.094)), 7, hp, null, null, 1.06);
      A(plateGeo([[-K(0.020), 0], [K(0.020), 0], [K(0.060), K(0.165)], [0, K(0.235)], [-K(0.060), K(0.165)]], K(0.030), T.PLUME),
        trs(0, yCrn + K(0.010), -K(0.010)), 7, hp, null, null, 1.10);
    } else if (C.helm === 'crown') {
      dome(K(0.168), 1.12, T.IRON, yCrn - K(0.070), 1.05);
      ridge(K(0.168), yCrn + K(0.080), T.GOLD);
      aventail(K(0.174), K(0.226), yCrn - K(0.148), K(0.260), T.MAIL);
      A(uvAll(new THREE.CylinderGeometry(K(0.171), K(0.178), K(0.066), C.seg + 2 || 10), T.GOLD), trs(0, yCrn - K(0.135), 0), 7, hp, null, null, 1.14);
      for (const s of [-1, 1]) {
        const [m, L] = spanM([s * K(0.160), yCrn - K(0.11), -K(0.02)], [s * K(0.36), yCrn + K(0.42), -K(0.10)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.016), K(0.058), L, 6), T.IRON), m, 7, hp, null, null, 1.06);
      }
      for (let i = 0; i < 5; i++) A(boxA(K(0.030), K(0.085), K(0.030), [T.GOLD]), trs((i - 2) * K(0.062), yCrn - K(0.075), K(0.130) - Math.abs(i - 2) * K(0.022)), 7, hp, null, null, 1.16);
    } else if (C.helm === 'kettle') {
      // SHIELDBEARER (SPEC2 §D). The brim is the whole silhouette read: a broad iron war
      // hat over a mail curtain says "heavy infantry" at 12 px, which is the point of a
      // unit whose job is to be recognised and shot at with something other than arrows.
      dome(K(0.152), 0.84, T.IRON, yCrn - K(0.050), 1.08);
      aventail(K(0.160), K(0.214), yCrn - K(0.118), K(0.255), T.MAIL);
      A(uvAll(new THREE.CylinderGeometry(K(0.330), K(0.238), K(0.030), (C.seg || SEG) + 4), T.IRON),
        trs(0, yCrn - K(0.030), 0), 7, hp, null, null, 1.04);
      A(uvAll(new THREE.CylinderGeometry(K(0.240), K(0.248), K(0.048), (C.seg || SEG) + 2), T.IRON), trs(0, yCrn - K(0.062), 0), 7, hp, null, null, 0.90);
      A(uvAll(new THREE.SphereGeometry(K(0.034), 6, 4), T.IRON), trs(0, yCrn + K(0.042), 0), 7, hp, null, null, 1.16);
    } else if (C.helm === 'hood') {
      // MARAUDER: a deep hood with a flopped peak — no metal anywhere on the head, so the
      // skirmisher never gets confused with the mailed line troops behind him.
      dome(K(0.154), 1.02, T.DIRT, yCrn - K(0.078), 1.02);
      aventail(K(0.160), K(0.228), yCrn - K(0.140), K(0.300), T.DIRT);
      { const [m, L] = spanM([0, yCrn + K(0.03), -K(0.05)], [-K(0.03), yCrn + K(0.10), -K(0.46)]);
        A(uvAll(new THREE.ConeGeometry(K(0.088), L, 7), T.DIRT), m, 7, hp, null, null, 0.92); }
      A(uvAll(new THREE.CylinderGeometry(K(0.150), K(0.156), K(0.042), (C.seg || SEG) + 2), T.LEATH), trs(0, yCrn - K(0.126), 0), 7, hp, null, null, 1.06);
      A(uvAll(new THREE.CylinderGeometry(K(0.235) * B, K(0.335) * B, K(0.30), (C.seg || SEG) + 3, 1, true), T.DIRT),
        trs(0, ySh - K(0.09), -K(0.01)), 0, null, null, null, 0.86);     // shoulder mantle
    } else if (C.helm === 'tusk') {
      // OGRE. The old head was a featureless sage sphere under a full-width flat iron disc —
      // at gameplay size that is a lamp, and at mobile size an olive blob. Three changes fix
      // the silhouette: (1) the flat brim is GONE, replaced by an asymmetric bolted brow
      // that hugs the skull and never breaks its outline sideways; (2) the tusks are more
      // than a third of the skull's width and their tips push OUTSIDE it, so the head has
      // two hard spikes in profile at any zoom; (3) a heavy jaw and browridge give the
      // sphere an actual face. The dome is WIDER than the head box on purpose — it swallows
      // it, so every feature has to be pushed past its front surface (z ~ 0.26K) or it
      // renders inside the skull and the ogre comes out faceless.
      const SW = K(0.180) * HS;                       // skull half-width (0.27K at HS 1.5)
      A(uvAll(new THREE.SphereGeometry(SW, C.seg || SEG, 6, 0, TAU, 0, 1.90), SKN),
        trs(0, yCrn - K(0.082), -K(0.012), 0, 1, 0.92, 1), 7, hp, null, null, 1.0);
      // asymmetric bolted brow: a wide plate over the left eye, a short stub over the right,
      // both raked back so they read as riveted ONTO the skull rather than worn on it
      A(tbox(K(0.300), K(0.088), K(0.150), [T.IRON], 1.0, 0.72),
        trs(-K(0.045), yCrn - K(0.040), K(0.150), 0, 1, 1, 1, -0.30, 0.11), 7, hp, null, null, 1.06);
      A(tbox(K(0.140), K(0.070), K(0.130), [T.IRON], 1.0, 0.76),
        trs(K(0.170), yCrn - K(0.086), K(0.132), 0, 1, 1, 1, -0.22, -0.26), 7, hp, null, null, 0.92);
      for (let i = 0; i < 4; i++)                     // rivets along the plate
        A(uvAll(new THREE.SphereGeometry(K(0.026), 5, 4), T.IRON),
          trs(-K(0.170) + i * K(0.080), yCrn - K(0.016) - i * K(0.010), K(0.208)), 7, hp, null, null, 1.22);
      // heavy underslung jaw — mass below the eyes is what stops a sphere reading as a bulb
      A(tbox(K(0.330), K(0.135), K(0.150), [SKN], 1.0, 0.84), trs(0, yChn + K(0.036), K(0.185)), 7, hp, null, null, 0.84);
      A(boxA(K(0.250), K(0.036), K(0.040), [T.BONE]), trs(0, yChn + K(0.104), K(0.245)), 7, hp, null, null, 0.60);  // lower teeth
      for (const s of [-1, 1]) {
        A(boxA(K(0.100), K(0.052), K(0.060), [SKN]), trs(s * K(0.098), yCrn - K(0.116), K(0.212)), 7, hp, null, null, 0.24);  // sunken eye
        A(uvAll(new THREE.SphereGeometry(K(0.024), 5, 4), T.EYES), trs(s * K(0.098), yCrn - K(0.116), K(0.226)), 7, hp, null, null, 1.0);
        // TUSKS: 0.19K root to 0.40K tip in x — the tip clears the 0.27K skull edge, so the
        // silhouette grows two spikes. Forward-leaning as they rise; up-and-back would read
        // as horns, and a horned ogre is just the brute again.
        const [m, L] = spanM([s * K(0.185), yChn - K(0.020), K(0.150)], [s * K(0.400), yChn + K(0.360), K(0.230)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.026), K(0.090), L, 6), T.BONE), m, 7, hp, null, null, 1.24);
        A(uvAll(new THREE.SphereGeometry(K(0.086), 6, 5), SKN), trs(s * K(0.176), yChn + K(0.006), K(0.156), 0, 1, 0.72, 1), 7, hp, null, null, 0.80);
      }
    } else if (C.helm === 'great') {
      // IRONCLAD (SPEC3 §B). A flat-topped great helm: the only head in the roster with a
      // straight horizontal crown line, which is what tells a plate slab apart from the
      // shieldbearer's domed war hat at 12 px. No skin shows anywhere.
      const HR = K(0.196) * HS;
      A(uvAll(new THREE.CylinderGeometry(HR, HR * 1.02, K(0.40), (C.seg || SEG) + 3), C.helmT || T.IRON),
        trs(0, yCrn - K(0.150), 0), 7, hp, null, null, 1.06);
      A(uvAll(new THREE.CylinderGeometry(HR * 0.98, HR, K(0.055), (C.seg || SEG) + 3), C.helmT || T.IRON),
        trs(0, yCrn + K(0.070), 0), 7, hp, null, null, 1.16);                     // flat crown plate
      A(boxA(K(0.052), K(0.070), HR * 2.1, [C.helmT || T.IRON]), trs(0, yCrn + K(0.102), 0), 7, hp, null, null, 1.20);
      A(boxA(HR * 1.94, K(0.062), K(0.055), [T.EYES]), trs(0, yCrn - K(0.108), HR * 0.92), 7, hp, null, null, 1.0);  // vision slit
      A(boxA(K(0.062), K(0.300), K(0.058), [C.helmT || T.IRON]), trs(0, yCrn - K(0.170), HR * 0.94), 7, hp, null, null, 1.14);
      for (let i = 0; i < 5; i++)                                                  // breath holes
        A(uvAll(new THREE.SphereGeometry(K(0.020), 5, 4), T.IRON),
          trs((i - 2) * K(0.056), yCrn - K(0.280), HR * 0.90), 7, hp, null, null, 0.42);
      A(uvAll(new THREE.CylinderGeometry(HR * 1.10, HR * 1.16, K(0.050), (C.seg || SEG) + 3), T.IRON),
        trs(0, yCrn - K(0.348), 0), 7, hp, null, null, 0.92);                      // gorget ring
    } else if (C.helm === 'rime') {
      // FROST REVENANT. An open-faced bascinet the frost has grown out of: a bone face
      // under a pale bowl with four ice spines standing off the back of the skull.
      dome(K(0.152), 1.06, T.FROST, yCrn - K(0.078), 1.10);
      aventail(K(0.158), K(0.204), yCrn - K(0.146), K(0.240), T.SHROUD);
      A(uvAll(new THREE.CylinderGeometry(K(0.155), K(0.162), K(0.050), (C.seg || SEG) + 2), T.FROST), trs(0, yCrn - K(0.128), 0), 7, hp, null, null, 1.12);
      A(boxA(K(0.030), K(0.140), K(0.038), [T.FROST]), trs(0, yCrn - K(0.212), K(0.116)), 7, hp, null, null, 1.10);
      for (let i = 0; i < 4; i++) {
        const s2 = i < 2 ? -1 : 1, f = (i % 2) * 0.5;
        const [m, L] = spanM([s2 * K(0.09 + f * 0.05), yCrn - K(0.02), -K(0.10)],
                             [s2 * K(0.22 + f * 0.12), yCrn + K(0.42 - f * 0.14), -K(0.34 - f * 0.08)]);
        A(uvAll(new THREE.ConeGeometry(K(0.040), L, 5), T.FROST), m, 7, hp, null, null, 1.26);
      }
      for (const s of [-1, 1])                                                      // hollow eye sockets
        A(boxA(K(0.052), K(0.044), K(0.030), [T.SHROUD]), trs(s * K(0.062), yCrn - K(0.196), K(0.104)), 7, hp, null, null, 0.20);
    } else if (C.helm === 'mask') {
      // WAR SHAMAN. No helmet at all: a bone mask under a horned hood, so the unit the
      // player has to kill FIRST is the only silhouette on the road with antlers on it.
      dome(K(0.150), 1.00, T.ROBE, yCrn - K(0.082), 1.02);
      aventail(K(0.156), K(0.230), yCrn - K(0.138), K(0.320), T.ROBE);
      A(plateGeo([[-K(0.108), K(0.150)], [K(0.108), K(0.150)], [K(0.120), -K(0.055)],
                  [0, -K(0.185)], [-K(0.120), -K(0.055)]], K(0.028), T.BONE, T.BONE, T.BONE),
        trs(0, yCrn - K(0.196), K(0.112)), 7, hp, null, null, 1.18);                // bone face mask
      for (const s of [-1, 1]) {
        A(boxA(K(0.044), K(0.030), K(0.026), [T.SHROUD]), trs(s * K(0.052), yCrn - K(0.166), K(0.130)), 7, hp, null, null, 0.16);
        // The antlers ARE the war shaman's read. They have to be thick enough to survive a
        // 12-pixel unit and wide enough to break his own outline on both sides.
        const [m, L] = spanM([s * K(0.130), yCrn - K(0.020), -K(0.02)], [s * K(0.560), yCrn + K(0.640), -K(0.18)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.026), K(0.072), L, 6), T.BONE), m, 7, hp, null, null, 1.28);
        for (let i = 0; i < 3; i++) {                                               // antler tines
          const f = 0.30 + i * 0.26;
          const o = [s * lerp(K(0.130), K(0.560), f), lerp(yCrn - K(0.020), yCrn + K(0.640), f), lerp(-K(0.02), -K(0.18), f)];
          const [m2, L2] = spanM(o, [o[0] + s * K(0.20), o[1] + K(0.28), o[2] + (i & 1 ? K(0.22) : -K(0.20))]);
          A(uvAll(new THREE.CylinderGeometry(K(0.014), K(0.040), L2, 5), T.BONE), m2, 7, hp, null, null, 1.30);
        }
      }
    }
    // ── shields (bone 5) ──
    if (C.shield === 'round' || C.shield === 'buckler') {
      const r = C.shield === 'round' ? K(0.360) : K(0.200);
      const cen = [hndL[0] - K(0.075), hndL[1] + K(0.085), hndL[2] + K(0.040)];
      const ry = -0.62;
      A(plateGeo(polyC(r, DSEG), K(0.058), T.SHR, T.SHBK, T.IRON), trs(cen[0], cen[1], cen[2], ry, 1, 1, 1, 0.13, 0.09), 5, shL, null, null, 1.04);
      // the boss was a polished-steel cone a third of the disc wide; at gameplay zoom it was
      // a specular dot on every shield in the horde and the mass sampled steel, not crimson
      A(uvAll(new THREE.ConeGeometry(r * 0.19, r * 0.24, DSEG), T.IRON),
        trs(cen[0] + Math.sin(ry) * K(0.058), cen[1], cen[2] + Math.cos(ry) * K(0.058), ry, 1, 1, 1, Math.PI / 2 + 0.13, 0.09), 5, shL, null, null, 0.94);
    } else if (C.shield === 'kite') {
      const hw = K(0.205), hh = K(0.40);
      const pts = KITE.map(q => [q[0] * hw, q[1] * hh]);
      const cen = [hndL[0] - K(0.075), hndL[1] + K(0.105), hndL[2] + K(0.040)];
      A(plateGeo(pts, K(0.054), T.SHB, T.SHBK, T.STEEL), trs(cen[0], cen[1], cen[2], -0.56, 1, 1, 1, 0.11, 0.05), 5, shL, null, null, 1.0);
    } else if (C.shield === 'tower') {
      // PAVISE (SPEC2 §D). Two thirds of the man's height and carried square to the road:
      // the silhouette IS the unit. Its top edge stops at the nose so the kettle brim
      // still breaks the outline — a featureless slab reads as scenery, not a soldier.
      // shieldS widens the pavise for the ironclad (SPEC3 §B), whose whole read is a
      // WALL: at 1.32 the plate is broader than his own shoulders and reaches his visor.
      const SS = C.shieldS || 1, hw = K(0.300) * SS, hh = K(0.540) * SS;   // knee to mouth: a real pavise
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh * 0.72], [hw * 0.62, hh], [-hw * 0.62, hh], [-hw, hh * 0.72]];
      const cen = [hndL[0] + K(0.240), yHip + K(0.080), hndL[2] + K(0.115)];
      // shieldT: the ironclad's wall is bare bolted IRON, not the shieldbearer's painted
      // pavise — two units carrying the same red board would be one unit at gameplay zoom.
      A(plateGeo(pts, K(0.072), C.shieldT || T.PAV, T.SHBK, T.IRON), trs(cen[0], cen[1], cen[2], -0.11, 1, 1, 1, 0.06, 0.02), 5, shL, null, null, 1.0);
      A(uvAll(new THREE.CylinderGeometry(K(0.030), K(0.030), K(0.34) * SS, 6), T.WOOD),      // rear brace
        trs(cen[0], cen[1] - K(0.14), cen[2] - K(0.075), -0.11, 1, 1, 1, 0.06, 0.02), 5, shL, null, null, 0.82);
    }
    // ── weapons (bone 6) ──
    // bladeTint darkens polished steel on the RED army's weapons. A forest of 160 spear
    // heads at tint 1.12 was the single brightest thing on the road and it out-valued every
    // tabard under it; at 0.82 the points still glint but the crimson carries the frame.
    const BT = C.bladeTint === undefined ? 1 : C.bladeTint;
    if (C.weapon === 'spear') {
      const grip = [hndR[0] + K(0.03), hndR[1], hndR[2] + K(0.045)];
      const dir = [0, Math.cos(0.20), -Math.sin(0.20)];
      const pt = (t) => [grip[0] + dir[0] * t, grip[1] + dir[1] * t, grip[2] + dir[2] * t];
      rod(pt(-K(0.56)), pt(K(1.60)), K(0.026), K(0.023), T.WOOD, 6, shR, null, 1.0);
      const [m, L] = spanM(pt(K(1.56)), pt(K(1.92)));
      A(uvAll(new THREE.ConeGeometry(K(0.048), L, 6), T.BLADE), m, 6, shR, null, null, 1.12 * BT);
      A(uvAll(new THREE.CylinderGeometry(K(0.034), K(0.040), K(0.075), 6), T.IRON), spanM(pt(K(1.50)), pt(K(1.58)))[0], 6, shR, null, null, 1.0);
      A(uvAll(new THREE.CylinderGeometry(K(0.032), K(0.032), K(0.06), 6), T.IRON), spanM(pt(-K(0.60)), pt(-K(0.54)))[0], 6, shR, null, null, 1.0);
      // a strip of the unit's own cloth knotted under the head: at overview zoom this is the
      // pixel that keeps a spear forest reading crimson rather than as a field of steel pins
      if (C.tabard >= 0) A(plateGeo([[-K(0.030), 0], [K(0.030), 0], [K(0.052), -K(0.26)], [-K(0.018), -K(0.30)]], K(0.012), C.tabard, C.tabard),
        trs(pt(K(1.44))[0], pt(K(1.44))[1], pt(K(1.44))[2] + K(0.02), 0.35), 6, shR, null, null, 1.06);
    } else if (C.weapon === 'sword' || C.weapon === 'gsword') {
      const big = C.weapon === 'gsword';
      const bl = big ? K(1.18) : K(0.62), bw = big ? K(0.062) : K(0.058);
      const grip = [hndR[0] + K(0.02), hndR[1] + K(0.01), hndR[2] + K(0.045)];
      // Was a constant-width two-plane ribbon: at closeup the diagonal specular of the
      // BLADE tile banded across a flat rectangle and read as a zipper. A continuous taper
      // (0.09 -> 0.05 of its own width) plus a fuller on BOTH sizes gives it a spine.
      const pts = [[-bw, 0], [bw, 0], [bw * 0.86, bl * 0.44], [bw * 0.70, bl * 0.78],
                   [bw * 0.52, bl * 0.93], [0, bl], [-bw * 0.52, bl * 0.93], [-bw * 0.70, bl * 0.78], [-bw * 0.86, bl * 0.44]];
      A(plateGeo(pts, big ? K(0.044) : K(0.034), T.BLADE), trs(grip[0], grip[1] + K(0.10), grip[2], 0, 1, 1, 1, -0.22), 6, shR, null, null, 1.10 * BT);
      A(plateGeo([[-bw * 0.30, bl * 0.06], [bw * 0.30, bl * 0.06], [bw * 0.24, bl * 0.72], [0, bl * 0.86], [-bw * 0.24, bl * 0.72]],
        big ? K(0.052) : K(0.040), T.IRON), trs(grip[0], grip[1] + K(0.10), grip[2], 0, 1, 1, 1, -0.22), 6, shR, null, null, 0.84);
      // a real crossguard: a central block plus two down-swept quillons, not a flat bar
      const gy2 = grip[1] + K(0.085), gw = big ? K(0.11) : K(0.078);
      A(boxA(gw, K(0.052), K(0.062), [T.IRON]), trs(grip[0], gy2, grip[2] + K(0.020), 0, 1, 1, 1, -0.22), 6, shR, null, null, 1.02);
      for (const s of [-1, 1]) {
        const [qm, qL] = spanM([grip[0] + s * gw * 0.4, gy2 + K(0.006), grip[2] + K(0.018)],
                               [grip[0] + s * (big ? K(0.185) : K(0.132)), gy2 - K(0.052), grip[2] + K(0.030)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.014), K(0.026), qL, 5), T.IRON), qm, 6, shR, null, null, 1.06);
      }
      A(uvAll(new THREE.CylinderGeometry(K(0.026), K(0.026), big ? K(0.20) : K(0.13), 6), T.LEATH), trs(grip[0], grip[1] - K(0.02), grip[2] - K(0.012), 0, 1, 1, 1, -0.22), 6, shR, null, null, 0.9);
      A(uvAll(new THREE.SphereGeometry(K(0.040), 6, 4), T.GOLD), trs(grip[0], grip[1] - (big ? K(0.13) : K(0.09)), grip[2] - K(0.03)), 6, shR, null, null, 1.12);
    } else if (C.weapon === 'axe2h') {
      const grip = [hndR[0] + K(0.02), hndR[1], hndR[2] + K(0.05)];
      const dir = [0.10, Math.cos(0.34), -Math.sin(0.34)];
      const nl = Math.hypot(dir[0], dir[1], dir[2]); dir[0] /= nl; dir[1] /= nl; dir[2] /= nl;
      const pt = t => [grip[0] + dir[0] * t, grip[1] + dir[1] * t, grip[2] + dir[2] * t];
      rod(pt(-K(0.42)), pt(K(1.10)), K(0.034), K(0.030), T.WOOD, 6, shR, null, 1.0);
      const hc = pt(K(0.98));
      const hpts = [[0, -K(0.16)], [K(0.10), -K(0.30)], [K(0.40), -K(0.14)], [K(0.44), K(0.12)], [K(0.12), K(0.30)], [0, K(0.17)]];
      A(plateGeo(hpts, K(0.046), T.IRON, T.IRON, T.IRON), trs(hc[0], hc[1], hc[2], 0, 1, 1, 1, 0, 0.10), 6, shR, null, null, 1.0);
      // honed edge: a narrow bright bevel along the cutting arc so the axe is not a pale slab
      const epts = [[K(0.30), -K(0.20)], [K(0.40), -K(0.145)], [K(0.44), K(0.12)], [K(0.145), K(0.285)], [K(0.19), K(0.16)], [K(0.32), K(0.02)]];
      A(plateGeo(epts, K(0.050), T.BLADE, T.BLADE, T.BLADE), trs(hc[0], hc[1], hc[2], 0, 1, 1, 1, 0, 0.10), 6, shR, null, null, 1.16 * BT);
      A(plateGeo(hpts.map(q => [-q[0], q[1] * 0.58]), K(0.046), T.IRON, T.IRON, T.IRON), trs(hc[0], hc[1], hc[2], 0, 1, 1, 1, 0, 0.10), 6, shR, null, null, 0.94);
      A(uvAll(new THREE.CylinderGeometry(K(0.046), K(0.046), K(0.10), 7), T.IRON), spanM(pt(K(0.86)), pt(K(0.96)))[0], 6, shR, null, null, 1.02);
      A(uvAll(new THREE.CylinderGeometry(K(0.040), K(0.040), K(0.07), 7), T.IRON), spanM(pt(-K(0.46)), pt(-K(0.40)))[0], 6, shR, null, null, 1.02);
    } else if (C.weapon === 'club') {
      // OGRE. Was a smooth tapered trunk whose seven "studs" were spheres of r 0.042 sunk
      // inside a head of r 0.126 — they never broke the outline, so the whole weapon read as
      // a tan pill. Now: a hard taper (0.052 grip -> 0.190 head), a stepped iron collar that
      // cuts a notch into the silhouette, and eight IRON SPIKES whose bases sit on the head
      // surface and whose tips stand a third of a head-radius proud of it.
      const grip = [hndR[0] + K(0.03), hndR[1], hndR[2] + K(0.05)];
      const dir = [0.14, Math.cos(0.30), -Math.sin(0.30)];
      const nl = Math.hypot(dir[0], dir[1], dir[2]); dir[0] /= nl; dir[1] /= nl; dir[2] /= nl;
      const pt = t => [grip[0] + dir[0] * t, grip[1] + dir[1] * t, grip[2] + dir[2] * t];
      // perpendicular frame, so spikes stand off the shaft in every direction, not just xz
      const ux = [dir[1], -dir[0], 0], un = Math.hypot(ux[0], ux[1]) || 1; ux[0] /= un; ux[1] /= un;
      const vx = [dir[1] * ux[2] - dir[2] * ux[1], dir[2] * ux[0] - dir[0] * ux[2], dir[0] * ux[1] - dir[1] * ux[0]];
      rod(pt(-K(0.34)), pt(K(0.68)), K(0.052), K(0.098), T.WOOD, 6, shR, null, 0.94);   // haft
      rod(pt(K(0.66)), pt(K(1.28)), K(0.130), K(0.215), T.WOOD, 6, shR, null, 1.06);     // head
      A(uvAll(new THREE.CylinderGeometry(K(0.148), K(0.148), K(0.075), 7), T.IRON),      // notch collar
        spanM(pt(K(0.62)), pt(K(0.70)))[0], 6, shR, null, null, 1.10);
      A(uvAll(new THREE.SphereGeometry(K(0.210), 7, 5), T.WOOD), spanM(pt(K(1.22)), pt(K(1.32)))[0], 6, shR, null, null, 1.02);
      for (let i = 0; i < 8; i++) {
        // bases sunk just under the head surface, tips at 0.36K — nearly TWICE the head
        // radius — so every spike breaks the outline. The old studs were spheres buried
        // inside the wood, which is exactly why the club read as a smooth tan pill.
        const a = i / 8 * TAU + 0.4, tt = K(0.82) + (i % 4) * K(0.125);
        const c0 = pt(tt), nx = ux[0] * Math.cos(a) + vx[0] * Math.sin(a),
              ny = ux[1] * Math.cos(a) + vx[1] * Math.sin(a), nz = ux[2] * Math.cos(a) + vx[2] * Math.sin(a);
        const [m, L] = spanM([c0[0] + nx * K(0.115), c0[1] + ny * K(0.115), c0[2] + nz * K(0.115)],
                             [c0[0] + nx * K(0.360), c0[1] + ny * K(0.360), c0[2] + nz * K(0.360)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.016), K(0.062), L, 5), T.IRON), m, 6, shR, null, null, 1.18);
      }
      A(uvAll(new THREE.CylinderGeometry(K(0.062), K(0.062), K(0.14), 7), T.LEATH), spanM(pt(-K(0.32)), pt(-K(0.18)))[0], 6, shR, null, null, 0.92);
    } else if (C.weapon === 'bow') {
      // MARAUDER (SPEC2 §D). The bow lives in the SHIELD hand (bone 5) and carries its own
      // string and nocked arrow: this rig has no way to stretch a string between two bones,
      // so the whole assembly is baked at half draw and the draw arm swings back to meet
      // the nock in shoot mode. At gameplay zoom the cheat is invisible.
      const gx = hndL[0] - K(0.02), gy0 = hndL[1] + K(0.02), gz = hndL[2] + K(0.06);
      const bp = (dy, dz) => [gx, gy0 + K(dy), gz + K(dz)];
      const tipT = bp(0.60, -0.11), tipB = bp(-0.60, -0.11), nock = bp(0.0, -0.28);
      rod(bp(0.02, 0.05), bp(0.33, 0.07), K(0.026), K(0.021), T.WOOD, 5, shL, null, 1.02);
      rod(bp(0.33, 0.07), tipT, K(0.021), K(0.013), T.WOOD, 5, shL, null, 1.06);
      rod(bp(-0.02, 0.05), bp(-0.33, 0.07), K(0.026), K(0.021), T.WOOD, 5, shL, null, 1.02);
      rod(bp(-0.33, 0.07), tipB, K(0.021), K(0.013), T.WOOD, 5, shL, null, 1.06);
      A(uvAll(new THREE.CylinderGeometry(K(0.031), K(0.031), K(0.14), 7), T.LEATH), trs(gx, gy0, gz + K(0.055)), 5, shL, null, null, 0.94);
      rod(tipT, nock, K(0.007), K(0.007), T.BONE, 5, shL, null, 1.25);
      rod(tipB, nock, K(0.007), K(0.007), T.BONE, 5, shL, null, 1.25);
      rod(nock, bp(0.015, 0.58), K(0.011), K(0.011), T.WOOD, 5, shL, null, 1.0);
      { const [m, L] = spanM(bp(0.015, 0.58), bp(0.015, 0.70));
        A(uvAll(new THREE.ConeGeometry(K(0.026), L, 5), T.BLADE), m, 5, shL, null, null, 1.16); }
      A(boxA(K(0.012), K(0.088), K(0.115), [T.PLUME]), trs(nock[0], nock[1], nock[2] + K(0.075)), 5, shL, null, null, 1.14);
    } else if (C.weapon === 'totem') {
      // WAR SHAMAN (SPEC3 §B). A totem staff taller than the man carrying it, topped with a
      // horned skull and a caged ember: the roster's only VERTICAL line that ends in a
      // glowing point, so "kill that one first" is legible before you read the health bar.
      const grip = [hndR[0] + K(0.03), hndR[1], hndR[2] + K(0.04)];
      const dir = [0.03, Math.cos(0.08), -Math.sin(0.08)];
      const pt = t => [grip[0] + dir[0] * t, grip[1] + dir[1] * t, grip[2] + dir[2] * t];
      rod(pt(-K(0.70)), pt(K(1.34)), K(0.030), K(0.026), T.WOOD, 6, shR, null, 0.98);
      A(uvAll(new THREE.CylinderGeometry(K(0.040), K(0.046), K(0.070), 7), T.LEATH), spanM(pt(K(0.98)), pt(K(1.05)))[0], 6, shR, null, null, 0.92);
      { const c0 = pt(K(1.46));                                            // horned skull finial
        A(uvAll(new THREE.SphereGeometry(K(0.098), 7, 5), T.BONE), trs(c0[0], c0[1], c0[2], 0, 1, 1.05, 1.15), 6, shR, null, null, 1.16);
        A(boxA(K(0.078), K(0.060), K(0.110), [T.BONE]), trs(c0[0], c0[1] - K(0.052), c0[2] + K(0.076)), 6, shR, null, null, 1.06);
        for (const s of [-1, 1]) {
          const [m, L] = spanM([c0[0] + s * K(0.070), c0[1] + K(0.040), c0[2]],
                               [c0[0] + s * K(0.230), c0[1] + K(0.190), c0[2] - K(0.070)]);
          A(uvAll(new THREE.ConeGeometry(K(0.030), L, 5), T.BONE), m, 6, shR, null, null, 1.22);
        }
        for (const s of [-1, 1])                                           // sockets
          A(boxA(K(0.030), K(0.026), K(0.024), [T.SHROUD]), trs(c0[0] + s * K(0.038), c0[1] - K(0.006), c0[2] + K(0.090)), 6, shR, null, null, 0.18);
      }
      { const c1 = pt(K(1.20));                                            // caged ember
        for (let i = 0; i < 4; i++) {
          const a = i / 4 * TAU + 0.4;
          const [m, L] = spanM([c1[0] + Math.cos(a) * K(0.020), c1[1] - K(0.090), c1[2] + Math.sin(a) * K(0.020)],
                               [c1[0] + Math.cos(a) * K(0.078), c1[1] + K(0.030), c1[2] + Math.sin(a) * K(0.078)]);
          A(uvAll(new THREE.CylinderGeometry(K(0.010), K(0.010), L, 4), T.IRON), m, 6, shR, null, null, 1.0);
        }
        A(uvAll(new THREE.SphereGeometry(K(0.062), 7, 5), T.EMBER), trs(c1[0], c1[1] - K(0.030), c1[2]), 6, shR, null, null, 1.30);
      }
      for (let i = 0; i < 3; i++) {                                        // bone charms on thongs
        const c2 = pt(K(0.52) + i * K(0.20));
        A(boxA(K(0.026), K(0.100), K(0.020), [T.BONE]), trs(c2[0] + K(0.062), c2[1] - K(0.070), c2[2], 0, 1, 1, 1, 0, 0.30 + i * 0.12), 6, shR, null, null, 1.14);
      }
    }
    // ── cape / back banner ──
    if (C.cape) {
      const cw = K(0.215) * B, c0 = ySh + K(0.03), c1 = yKne - K(0.04), ch = c0 - c1, cT = C.capeT === undefined ? T.CRIM : C.capeT;
      A(plateGeo([[-cw, 0], [cw, 0], [cw * 1.28, -ch * 0.50], [cw * 1.02, -ch], [-cw * 1.02, -ch], [-cw * 1.28, -ch * 0.50]], K(0.022), cT, cT),
        trs(0, c0, -K(0.165) * W, 0, 1, 1, 1, 0.13), 8, null, null, (x, y) => clamp((c0 - y) / ch, 0, 1), 0.82);
    }
    // SPEC3 §B: ice grown THROUGH the armour — shards off both pauldrons and a crust down
    // the spine. Without them a pale knight is just a knight in the wrong palette.
    if (C.rime) {
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
        const f = i / 2;
        const [m, L] = spanM([s * (shX + K(0.02)), ySh + K(0.03), -K(0.02) + f * K(0.06)],
                             [s * (shX + K(0.14 + f * 0.16)), ySh + K(0.46 - f * 0.16), -K(0.10) - f * K(0.18)]);
        A(uvAll(new THREE.ConeGeometry(K(0.052 - f * 0.012), L, 5), T.FROST), m, 0, null, null, null, 1.28);
      }
      for (let i = 0; i < 4; i++)
        A(uvAll(new THREE.SphereGeometry(K(0.070 - i * 0.010), 6, 4), T.FROST),
          trs(0, yCst - i * K(0.16), -K(0.150) * W, 0, 1.3, 0.8, 0.9), 0, null, null, null, 1.22);
    }
    // Glowing hands (SPEC3 §B war shaman): the heal is invisible at range unless the caster
    // is lit. Two ember cores riding the wrists put the light ON the unit, not on the effect.
    if (C.glow) for (const [h, bo, pv] of [[hndL, 5, shL], [hndR, 6, shR]])
      A(uvAll(new THREE.SphereGeometry(K(0.086) * B, 7, 5), T.EMBER), trs(h[0], h[1] - K(0.030), h[2] + K(0.030)), bo, pv, null, null, 1.35);
    if (C.banner) {
      const by0 = yCst - K(0.05), by1 = K(2.34);
      rod([K(0.05), by0, -K(0.19) * W], [-K(0.10), by1, -K(0.44) * W], K(0.028), K(0.022), T.WOOD, 0, null, null, 1.0);
      // the pole used to pass through the cape unanchored, as if the banner were floating a
      // hand's width behind him. Bolt it to something: a shoulder bracket, a socket cup and
      // a strap across the back, all on the root bone so they ride with the torso.
      A(tbox(K(0.150), K(0.150), K(0.110), [T.IRON], 1.0, 0.72), trs(K(0.055), ySh - K(0.06), -K(0.20) * W, 0, 1, 1, 1, 0.22, -0.16), 0, null, null, null, 1.08);
      A(uvAll(new THREE.CylinderGeometry(K(0.062), K(0.050), K(0.120), 7), T.IRON), trs(K(0.045), by0 + K(0.03), -K(0.205) * W, 0, 1, 1, 1, 0.10, -0.07), 0, null, null, null, 1.12);
      A(boxA(K(0.058), K(0.052), K(0.044), [T.GOLD]), trs(K(0.055), ySh - K(0.02), -K(0.255) * W), 0, null, null, null, 1.14);
      A(boxA(K(0.42) * B, K(0.070), K(0.030), [T.LEATH]), trs(0, yCst - K(0.16), -K(0.150) * W, 0, 1, 1, 1, 0, -0.30), 0, null, null, null, 0.90);
      const bw = K(0.235), bh = K(0.60), bty = by1 - K(0.11);
      A(plateGeo([[-bw, 0], [bw, 0], [bw, -bh * 0.84], [0, -bh], [-bw, -bh * 0.84]], K(0.018), T.BANN, T.BANN),
        trs(-K(0.085), bty, -K(0.42) * W, 0, 1, 1, 1, 0.10), 8, null, null,
        (x, y) => clamp((bty - y) / bh, 0, 1) * (0.35 + 0.65 * clamp((x + bw) / (2 * bw), 0, 1)), 1.06);
      A(uvAll(new THREE.SphereGeometry(K(0.042), 7, 5), T.GOLD), trs(-K(0.10), by1 + K(0.03), -K(0.44) * W), 0, null, null, null, 1.16);
    }
    if (C.pelt) {                                            // brute fur mantle (must sit BELOW
      // the helmet brim and behind the neck, or it reads as a mushroom cap swallowing the head)
      A(uvAll(new THREE.SphereGeometry(K(0.185) * B, 9, 5), T.FUR), trs(0, ySh - K(0.055), -K(0.050), 0, 1.55, 0.40, 0.86), 0, null, null, null, 1.0);
      for (const s of [-1, 1]) A(uvAll(new THREE.SphereGeometry(K(0.105) * B, 7, 5), T.FUR), trs(s * (shX + K(0.02)), ySh + K(0.030), -K(0.01), 0, 1, 0.80, 1), 0, null, null, null, 1.06);
    }
    if (C.plates) {                                          // SPEC2 §D: iron bolted over hide
      A(tbox(K(0.52) * B, K(0.34), K(0.11), [T.IRON], 1.0, 0.84), trs(0, yCst - K(0.17), K(0.146) * W, 0, 1, 1, 1, -0.10), 0, null, null, null, 1.06);
      A(boxA(K(0.46) * B, K(0.080), K(0.095), [T.IRON]), trs(0, yWst + K(0.10), K(0.150) * W), 0, null, null, null, 1.12);
      A(boxA(K(0.095), K(0.095), K(0.052), [T.GOLD]), trs(0, yCst - K(0.17), K(0.205) * W), 0, null, null, null, 1.14);
      for (const s of [-1, 1]) {
        A(uvAll(new THREE.SphereGeometry(K(0.160) * B, 8, 5, 0, TAU, 0, 1.45), T.IRON),
          trs(s * (shX + K(0.020)), ySh + K(0.010), 0, 0, 1, 0.62, 1), 0, null, null, null, 1.10);
        // two long shoulder spikes per side: at overview zoom these are the only thing
        // stopping a heavy-shouldered mini-boss from reading as a rectangle
        for (const [ox, oy, oz, r] of [[0.10, 0.42, -0.06, 0.062], [0.26, 0.30, 0.02, 0.048]]) {
          const [m, L] = spanM([s * (shX + K(0.070)), ySh + K(0.060), 0], [s * (shX + K(0.070 + ox * 1.5)), ySh + K(oy), K(oz)]);
          A(uvAll(new THREE.ConeGeometry(K(r), L, 6), T.IRON), m, 0, null, null, null, 1.16);
        }
      }
    }
    if (C.quiver) {                                          // marauder: arrows over the shoulder
      const qy = yCst - K(0.06), qz = -K(0.175) * W;
      A(uvAll(new THREE.CylinderGeometry(K(0.070), K(0.060), K(0.50), 8), T.LEATH), trs(K(0.135), qy, qz, 0, 1, 1, 1, 0.30, -0.28), 0, null, null, null, 0.94);
      for (let i = 0; i < 4; i++) {
        const ox = K(0.135) + (i - 1.5) * K(0.028);
        A(uvAll(new THREE.CylinderGeometry(K(0.009), K(0.009), K(0.28), 4), T.WOOD), trs(ox + K(0.055), qy + K(0.30), qz - K(0.055), 0, 1, 1, 1, 0.30, -0.28), 0, null, null, null, 1.0);
        A(boxA(K(0.010), K(0.095), K(0.070), [T.PLUME]), trs(ox + K(0.085), qy + K(0.40), qz - K(0.085), 0, 1, 1, 1, 0.30, -0.28), 0, null, null, null, 1.14);
      }
      A(boxA(K(0.048), K(0.42), K(0.022), [T.LEATH]), trs(-K(0.01), yCst - K(0.10), K(0.010), 0, 1, 1, 1, 0, -0.52), 0, null, null, null, 0.86);
    }
    return { geo: mergeA(p, C.h), h: C.h };
  }

  // ── HOUND (SPEC2 §D) ────────────────────────────────────────────────────────
  // A quadruped on the SAME skinning rig, which is the only reason it costs nothing
  // extra: bones 1/2 carry the FRONT legs and 3/4 the BACK legs with aPiv2 === aPiv, so
  // the shader's two-joint knee chain collapses to a single hip rotation and the gallop
  // can drive four independent beats. Bone 7 is the skull, bone 8 the tail (cloth sway).
  function buildHound(C) {
    const p = [];
    const A = (g, m, bone, piv, piv2, w, tint) => { p.push({ g, m: m || null, bone: bone || 0, piv: piv || [0, 0, 0], piv2: piv2 || null, w: w || null, tint }); };
    const k = C.h / 1.05, K = v => v * k, SG = C.seg || SEG;
    const rod = (a, b, r1, r2, t, bone, piv, piv2, tint) => {
      const [m, L] = spanM(a, b);
      A(uvAll(new THREE.CylinderGeometry(r2, r1, L, SG, 1, false), t), m, bone, piv, piv2, null, tint);
    };
    const ell = (r, sx, sy, sz, x, y, z, t, bone, piv, tint) =>
      A(uvAll(new THREE.SphereGeometry(r, SG + 1, 6), t), trs(x, y, z, 0, sx, sy, sz), bone, piv, piv, null, tint);
    const HD = [0, K(0.83), K(0.50)];                    // skull pivot (base of the neck)
    // body: two ellipsoids (deep chest, tucked loin) — a box reads as a crate on legs
    ell(K(0.200), 1.00, 0.96, 1.52, 0, K(0.640), K(0.190), C.coat, 0, null, 1.0);
    ell(K(0.182), 1.00, 1.00, 1.26, 0, K(0.640), -K(0.250), C.coat, 0, null, 0.96);
    A(boxA(K(0.300), K(0.130), K(0.560), [C.coat, C.coat, C.coat, C.belly, C.coat, C.coat]),
      trs(0, K(0.560), -K(0.020)), 0, null, null, null, 0.86);
    rod([0, K(0.700), K(0.330)], [0, K(0.830), K(0.510)], K(0.108), K(0.086), C.coat, 0, null, null, 1.0);
    // spiked war collar: the one hard edge on the animal, and what makes it the horde's
    A(uvAll(new THREE.CylinderGeometry(K(0.104), K(0.112), K(0.070), SG + 2, 1, true), T.IRON),
      trs(0, K(0.775), K(0.435), 0, 1, 1, 1, -0.62), 0, null, null, null, 1.10);
    for (let i = 0; i < 5; i++) {
      const a2 = (i / 5) * TAU - 0.4, cx = Math.cos(a2) * K(0.112), cy = Math.sin(a2) * K(0.112);
      const [m, L] = spanM([cx, K(0.775) + cy, K(0.435)], [cx * 1.8, K(0.775) + cy * 1.8, K(0.435) + cy * 0.5]);
      A(uvAll(new THREE.ConeGeometry(K(0.024), L, 5), T.IRON), m, 0, null, null, null, 1.20);
    }
    A(boxA(K(0.330), K(0.045), K(0.150), [T.CRIM]), trs(0, K(0.735), K(0.170)), 0, null, null, null, 1.02);
    // skull, muzzle, ears (bone 7)
    ell(K(0.112), 1.00, 0.98, 1.16, 0, K(0.895), K(0.605), C.coat, 7, HD, 1.02);
    rod([0, K(0.872), K(0.660)], [0, K(0.836), K(0.868)], K(0.078), K(0.056), C.coat, 7, HD, null, 0.98);
    A(uvAll(new THREE.SphereGeometry(K(0.036), 6, 5), T.IRON), trs(0, K(0.838), K(0.878)), 7, HD, null, null, 0.42);
    A(boxA(K(0.096), K(0.038), K(0.140), [T.BONE]), trs(0, K(0.800), K(0.808)), 7, HD, null, null, 1.06);
    for (const s of [-1, 1]) {
      A(boxA(K(0.030), K(0.030), K(0.026), [T.BONE]), trs(s * K(0.052), K(0.900), K(0.700)), 7, HD, null, null, 0.18);
      const [m, L] = spanM([s * K(0.072), K(0.955), K(0.588)], [s * K(0.118), K(1.105), K(0.520)]);
      A(uvAll(new THREE.ConeGeometry(K(0.055), L, 5), C.coat), m, 7, HD, null, null, 1.10);
      const [m2, L2] = spanM([s * K(0.040), K(0.812), K(0.836)], [s * K(0.046), K(0.856), K(0.876)]);
      A(uvAll(new THREE.ConeGeometry(K(0.014), L2, 4), T.BONE), m2, 7, HD, null, null, 1.24);  // fangs
    }
    // tail (bone 8 — the cloth channel gives it a live sway for free)
    rod([0, K(0.700), -K(0.470)], [0, K(0.905), -K(0.790)], K(0.042), K(0.020), C.coat, 8, null, null, 0.94);
    p[p.length - 1].w = (x, y, z) => clamp((-z / k - 0.47) / 0.32, 0, 1);
    // four legs. Fronts are straight posts, hinds carry the hock zigzag that says "runs".
    for (const s of [-1, 1]) {
      const fp = [s * K(0.130), K(0.605), K(0.270)];
      rod(fp, [s * K(0.136), K(0.320), K(0.300)], K(0.062), K(0.044), C.coat, s < 0 ? 1 : 2, fp, null, 0.98);
      rod([s * K(0.136), K(0.330), K(0.300)], [s * K(0.140), K(0.062), K(0.330)], K(0.040), K(0.029), C.sock, s < 0 ? 1 : 2, fp, null, 0.92);
      A(boxA(K(0.086), K(0.052), K(0.130), [C.sock]), trs(s * K(0.140), K(0.030), K(0.362)), s < 0 ? 1 : 2, fp, null, null, 0.84);
      const hp2 = [s * K(0.142), K(0.630), -K(0.250)];
      rod(hp2, [s * K(0.150), K(0.345), -K(0.360)], K(0.076), K(0.050), C.coat, s < 0 ? 3 : 4, hp2, hp2, 0.98);
      rod([s * K(0.150), K(0.355), -K(0.360)], [s * K(0.152), K(0.062), -K(0.290)], K(0.044), K(0.030), C.sock, s < 0 ? 3 : 4, hp2, hp2, 0.92);
      A(boxA(K(0.086), K(0.052), K(0.130), [C.sock]), trs(s * K(0.152), K(0.030), -K(0.258)), s < 0 ? 3 : 4, hp2, hp2, null, 0.84);
    }
    return { geo: mergeA(p, C.h), h: C.h };
  }

  // ── ASH WRAITH (SPEC3 §B) ───────────────────────────────────────────────────
  // The one thing on the road with NO LEGS. Everything below the ribs is a shroud that
  // stops a foot short of the grass, and every rag on it rides bone 8 (the cloth channel),
  // so it drifts instead of marching — a hovering hole with two coals in the hood, which
  // is the only silhouette a player can pick out of a running column at a glance.
  function buildWraith(C) {
    const p = [];
    const A = (g, m, bone, piv, piv2, w, tint) => { p.push({ g, m: m || null, bone: bone || 0, piv: piv || [0, 0, 0], piv2: piv2 || null, w: w || null, tint }); };
    const k = C.h / 1.80, K = v => v * k, SG = C.seg || SEG;
    const rod = (a, b, r1, r2, t, bone, piv, tint) => {
      const [m, L] = spanM(a, b);
      A(uvAll(new THREE.CylinderGeometry(r2, r1, L, SG, 1, false), t), m, bone, piv, null, null, tint);
    };
    const yHem = K(0.34), yWst = K(1.00), ySh = K(1.34), yCrn = K(1.70);
    // the shroud: a NARROW tapered column from the hem to the shoulders. The first cut was
    // a fat bell that read as a tent at gameplay zoom; a wraith has to be thinner than a
    // man, not wider, or the one thing it says (this is not a soldier) is lost.
    // Everything shroud is tinted well under unity: it must be the darkest value on the
    // road, so the two coals in the hood are the only thing the eye lands on.
    A(uvAll(new THREE.CylinderGeometry(K(0.200), K(0.320), ySh - yHem, SG + 4, 1, true), T.SHROUD),
      trs(0, (ySh + yHem) / 2, 0), 0, null, null, null, 0.54);
    // A HARD SHOULDER. The first cut ran one unbroken taper from hem to hood point and read
    // as a wizard's hat; a cowl that flares wider than the body and then steps back in is
    // what makes the head a head. It is also the only horizontal edge on the model.
    A(uvAll(new THREE.CylinderGeometry(K(0.360), K(0.190), K(0.30), SG + 4, 1, true), T.SHROUD),
      trs(0, ySh + K(0.06), -K(0.02), 0, 1.10, 1, 0.94), 0, null, null, null, 0.62);
    A(uvAll(new THREE.CylinderGeometry(K(0.375), K(0.360), K(0.055), SG + 4, 1, true), T.SHROUD),
      trs(0, ySh + K(0.20), -K(0.02), 0, 1.10, 1, 0.94), 0, null, null, null, 0.46);
    // ragged hem: twelve long tapered strips whose weight rises to the tip, so the bottom
    // of the wraith is always drifting even when the sim has it standing still
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * TAU, rr2 = K(0.305), L = K(0.34 + (i % 4) * 0.16);
      const x = Math.cos(a) * rr2, z = Math.sin(a) * rr2;
      A(plateGeo([[-K(0.070), 0], [K(0.070), 0], [K(0.040), -L], [-K(0.026), -L * 1.22]], K(0.012), T.SHROUD, T.SHROUD),
        trs(x, yHem + K(0.05), z, -a, 1, 1, 1, 0.05), 8, null, null, (xx, yy) => clamp((yHem + K(0.05) - yy) / L, 0, 1) * 1.8, 0.58);
    }
    // hood + face void + two ember coals (bone 7 so the head turns). The hood is a CONE,
    // not a dome: a rounded skull on a shroud reads as a monk, a peak reads as a wraith.
    const hp = [0, ySh - K(0.02), 0];
    { const [m, L] = spanM([0, yCrn - K(0.40), -K(0.03)], [-K(0.05), yCrn + K(0.22), -K(0.26)]);
      A(uvAll(new THREE.ConeGeometry(K(0.170), L, SG + 2), T.SHROUD), m, 7, hp, null, null, 0.60); }
    A(uvAll(new THREE.CylinderGeometry(K(0.165), K(0.205), K(0.30), SG + 3, 1, true), T.SHROUD),
      trs(0, yCrn - K(0.380), -K(0.010)), 7, hp, null, null, 0.48);
    A(uvAll(new THREE.SphereGeometry(K(0.140), SG, 5), T.SHROUD),
      trs(0, yCrn - K(0.285), K(0.060), 0, 1, 1, 0.66), 7, hp, null, null, 0.05);   // the void
    for (const s of [-1, 1]) {
      A(uvAll(new THREE.SphereGeometry(K(0.052), 7, 5), T.EMBER),
        trs(s * K(0.070), yCrn - K(0.265), K(0.150)), 7, hp, null, null, 1.55);
      A(uvAll(new THREE.SphereGeometry(K(0.026), 6, 4), T.EMBER),                    // the spill of
        trs(s * K(0.070), yCrn - K(0.340), K(0.140)), 7, hp, null, null, 1.55);      // light down the cheek
    }
    // skeletal arms — bare bone against the shroud, and the only hard edges on the model
    const shX = K(0.190), shL = [-shX, ySh - K(0.10), 0], shR = [shX, ySh - K(0.10), 0];
    for (const [s, bo, pv] of [[-1, 5, shL], [1, 6, shR]]) {
      const el = [s * (shX + K(0.03)), ySh - K(0.40), K(0.04)], hd = [s * (shX + K(0.06)), ySh - K(0.60), K(0.24)];
      rod(pv, el, K(0.052), K(0.040), T.BONE, bo, pv, 0.94);
      rod(el, hd, K(0.040), K(0.032), T.BONE, bo, pv, 1.0);
      A(uvAll(new THREE.SphereGeometry(K(0.048), 6, 4), T.BONE), trs(el[0], el[1], el[2]), bo, pv, null, null, 1.06);
      for (let i = 0; i < 3; i++) {                                                 // claws
        const a = (i - 1) * 0.42;
        const [m, L] = spanM(hd, [hd[0] + Math.sin(a) * K(0.10), hd[1] - K(0.12), hd[2] + Math.cos(a) * K(0.16)]);
        A(uvAll(new THREE.ConeGeometry(K(0.018), L, 4), T.BONE), m, bo, pv, null, null, 1.14);
      }
      // a torn sleeve trailing off each elbow, on the cloth channel
      A(plateGeo([[-K(0.075), 0], [K(0.075), 0], [K(0.040), -K(0.34)], [-K(0.055), -K(0.28)]], K(0.012), T.SHROUD, T.SHROUD),
        trs(s * (shX + K(0.05)), ySh - K(0.30), -K(0.02), s * 0.4), 8, null, null, () => 1.3, 0.80);
    }
    // two long tatters streaming off the shoulders — the wraith's motion tell at range
    for (const s of [-1, 1])
      A(plateGeo([[-K(0.120), 0], [K(0.120), 0], [K(0.070), -K(0.72)], [-K(0.090), -K(0.60)]], K(0.014), T.SHROUD, T.SHROUD),
        trs(s * K(0.150), ySh + K(0.06), -K(0.240), s * 0.30, 1, 1, 1, 0.16), 8, null, null,
        (x, y) => clamp((ySh + K(0.06) - y) / K(0.72), 0, 1) * 1.5, 0.74);
    void yWst;
    return { geo: mergeA(p, C.h), h: C.h };
  }

  // ── SIEGE RAM (SPEC3 §B) ────────────────────────────────────────────────────
  // Not a man at all: a timber cradle on four wheels with an iron-headed log slung under a
  // hide roof, pushed by four hunched crew. The log rides bone 6 (the weapon arm), so it
  // swings in its ropes as the machine rolls; the wheels ride bones 1/2, whose hip rotation
  // is a rotation about X — exactly a wheel's axle — so they turn instead of sliding.
  function buildRam(C) {
    const p = [];
    const A = (g, m, bone, piv, piv2, w, tint) => { p.push({ g, m: m || null, bone: bone || 0, piv: piv || [0, 0, 0], piv2: piv2 || null, w: w || null, tint }); };
    // The local unit here is the RIDGE height, not the model height: everything below is
    // authored against a roof at 1.62, so k maps that onto C.h. The first cut divided by
    // 2.60 and produced a machine shorter than the marauder walking beside it — a 1400-hit-
    // point siege engine has to out-mass everything on the road except a boss.
    const k = C.h / 1.72, K = v => v * k, SG = C.seg || SEG;
    const rod = (a, b, r1, r2, t, bone, piv, tint) => {
      const [m, L] = spanM(a, b);
      A(uvAll(new THREE.CylinderGeometry(r2, r1, L, SG, 1, false), t), m, bone, piv, null, null, tint);
    };
    const HW = K(0.62), yBed = K(0.62), yTop = K(1.62);     // half-width, deck height, roof
    const CY = 0.84;                                        // crew are men, not giants: their
    // own heights are authored in the same local unit and then pulled back to human scale
    // ── chassis: two long sills, four cross members, a deck ──
    for (const s of [-1, 1]) {
      A(boxA(K(0.13), K(0.16), K(2.30), [T.WOOD]), trs(s * HW, yBed, 0), 0, null, null, null, 1.0);
      A(boxA(K(0.10), K(0.07), K(2.34), [T.IRON]), trs(s * HW, yBed + K(0.10), 0), 0, null, null, null, 0.92);
    }
    for (let i = -2; i <= 2; i++)
      A(boxA(HW * 2.1, K(0.10), K(0.14), [T.WOOD]), trs(0, yBed + K(0.02), i * K(0.54)), 0, null, null, null, 0.90);
    // ── four wheels, all on bone 1 with their own axle pivots. Bone 1's animation is a
    // rotation about X — which for a cart pointing down +z IS the axle — so the wheels turn
    // with the gait instead of skidding, and sharing one bone keeps all four in phase.
    for (const s of [-1, 1]) for (const zf of [1, -1]) {
      const wr = K(0.56), ax = [s * (HW + K(0.12)), wr, zf * K(0.86)];
      A(uvAll(new THREE.CylinderGeometry(wr, wr, K(0.17), SG + 5, 1, false), T.WOOD),
        trs(ax[0], ax[1], ax[2], 0, 1, 1, 1, 0, Math.PI / 2), 1, ax, null, null, 0.94);
      A(uvAll(new THREE.CylinderGeometry(wr * 1.03, wr * 1.03, K(0.09), SG + 5, 1, true), T.IRON),
        trs(ax[0], ax[1], ax[2], 0, 1, 1, 1, 0, Math.PI / 2), 1, ax, null, null, 1.06);
      for (let i = 0; i < 6; i++)                            // spokes, in the wheel's own plane
        A(boxA(K(0.075), wr * 1.86, K(0.075), [T.WOOD]),
          trs(ax[0], ax[1], ax[2], 0, 1, 1, 1, i / 6 * Math.PI, 0), 1, ax, null, null, 1.02);
      A(uvAll(new THREE.CylinderGeometry(K(0.13), K(0.13), K(0.22), 7), T.IRON),
        trs(ax[0], ax[1], ax[2], 0, 1, 1, 1, 0, Math.PI / 2), 1, ax, null, null, 1.10);
      A(uvAll(new THREE.CylinderGeometry(K(0.075), K(0.075), K(0.30), 6), T.IRON),   // axle stub
        trs(s * (HW + K(0.02)), wr, zf * K(0.86), 0, 1, 1, 1, 0, Math.PI / 2), 0, null, null, null, 0.96);
    }
    // ── A-frame uprights + ridge beam + hide roof ──
    for (const zf of [1, -1]) for (const s of [-1, 1])
      rod([s * HW, yBed + K(0.06), zf * K(0.80)], [s * K(0.16), yTop, zf * K(0.66)], K(0.11), K(0.09), T.WOOD, 0, null, 1.0);
    A(boxA(K(0.15), K(0.15), K(2.10), [T.WOOD]), trs(0, yTop, 0), 0, null, null, null, 1.06);
    for (const s of [-1, 1]) {                               // two hide panels pitched off the ridge
      A(boxA(K(1.02), K(0.055), K(2.16), [T.HIDE]), trs(s * K(0.44), yTop - K(0.20), 0, 0, 1, 1, 1, 0, -s * 0.46), 0, null, null, null, 0.88);
      A(boxA(K(1.02), K(0.035), K(0.10), [T.WOOD]), trs(s * K(0.44), yTop - K(0.16), K(1.06), 0, 1, 1, 1, 0, -s * 0.46), 0, null, null, null, 0.94);
      A(boxA(K(1.02), K(0.035), K(0.10), [T.WOOD]), trs(s * K(0.44), yTop - K(0.16), -K(1.06), 0, 1, 1, 1, 0, -s * 0.46), 0, null, null, null, 0.94);
    }
    for (let i = -3; i <= 3; i++)                            // purlins under the hide
      A(boxA(K(1.34), K(0.05), K(0.07), [T.WOOD]), trs(0, yTop - K(0.34), i * K(0.30)), 0, null, null, null, 0.82);
    // ── the ram itself: bone 6, so it swings fore-and-aft in its ropes ──
    const rp = [0, yTop - K(0.10), 0];
    rod([0, yBed + K(0.50), -K(1.04)], [0, yBed + K(0.50), K(1.56)], K(0.25), K(0.23), T.WOOD, 6, rp, 1.04);
    for (const zz of [-0.72, 0.00, 0.76])                    // iron bands along the log
      A(uvAll(new THREE.CylinderGeometry(K(0.265), K(0.265), K(0.15), SG + 2), T.IRON),
        trs(0, yBed + K(0.50), K(zz), 0, 1, 1, 1, Math.PI / 2), 6, rp, null, null, 1.02);
    { // the head: a bound iron ram's skull with two horns, standing well proud of the
      // frame — the business end has to break the machine's outline or the whole thing
      // reads as a covered cart rather than as the reason the gate is about to fall.
      A(uvAll(new THREE.CylinderGeometry(K(0.34), K(0.27), K(0.50), SG + 3), T.IRON),
        trs(0, yBed + K(0.50), K(1.76), 0, 1, 1, 1, Math.PI / 2), 6, rp, null, null, 1.10);
      A(uvAll(new THREE.SphereGeometry(K(0.31), SG, 6), T.IRON),
        trs(0, yBed + K(0.50), K(2.00), 0, 1, 0.94, 1.10), 6, rp, null, null, 1.16);
      for (const s of [-1, 1]) {
        const [m, L] = spanM([s * K(0.18), yBed + K(0.62), K(1.94)], [s * K(0.58), yBed + K(0.22), K(1.66)]);
        A(uvAll(new THREE.CylinderGeometry(K(0.055), K(0.135), L, 6), T.IRON), m, 6, rp, null, null, 1.20);
      }
    }
    for (const zz of [-0.60, 0.70]) for (const s of [-1, 1])   // suspension ropes
      rod([s * K(0.10), yTop - K(0.10), K(zz)], [s * K(0.05), yBed + K(0.74), K(zz)], K(0.026), K(0.026), T.LEATH, 6, rp, 0.86);
    // ── crew: four hunched pushers on the flanks. Deliberately crude — they are scale
    // reference and motion, and any real detail on them steals read from the machine.
    for (const s of [-1, 1]) for (const zf of [0, 1]) {
      const cx = s * (HW + K(0.34)), cz = -K(0.72) - zf * K(0.62);
      A(tbox(K(0.30), K(0.62) * CY, K(0.23), [T.CRIM], 1.0, 0.86), trs(cx, K(0.94) * CY, cz, 0, 1, 1, 1, 0.34), 0, null, null, null, 0.94);
      A(uvAll(new THREE.SphereGeometry(K(0.14), 7, 5), T.IRON), trs(cx, K(1.30) * CY, cz + K(0.09)), 0, null, null, null, 1.02);
      A(boxA(K(0.26), K(0.26), K(0.09), [T.FACE]), trs(cx, K(1.26) * CY, cz + K(0.18)), 0, null, null, null, 0.92);
      // legs ride bones 1/2 and arms 5/6 — the same channels the wheels and the log use, so
      // the crew walks and heaves without the rig growing a single new bone
      for (const [ls, bo] of [[-1, 1], [1, 2]]) {
        const hip = [cx + ls * K(0.10), K(0.66) * CY, cz];
        rod(hip, [cx + ls * K(0.14), K(0.05), cz - ls * K(0.11) + K(0.09)], K(0.068), K(0.054), T.DIRT, bo, hip, 0.84);
      }
      const sho = [cx, K(1.14) * CY, cz + K(0.05)];
      rod(sho, [cx - s * K(0.24), K(1.02) * CY, cz + K(0.52)], K(0.064), K(0.052), T.MAIL, zf ? 5 : 6, sho, 0.90);
    }
    // ── a horde standard lashed to the rear post (cloth channel: it waves) ──
    rod([0, yTop - K(0.04), -K(1.02)], [-K(0.10), yTop + K(0.98), -K(1.18)], K(0.045), K(0.036), T.WOOD, 0, null, 1.0);
    { const bw = K(0.34), bh = K(0.80), bty = yTop + K(0.88);
      A(plateGeo([[-bw, 0], [bw, 0], [bw, -bh * 0.84], [0, -bh], [-bw, -bh * 0.84]], K(0.018), T.BANN, T.BANN),
        trs(-K(0.09), bty, -K(1.16), 0, 1, 1, 1, 0.08), 8, null, null,
        (x, y) => clamp((bty - y) / bh, 0, 1) * (0.35 + 0.65 * clamp((x + bw) / (2 * bw), 0, 1)), 1.06); }
    return { geo: mergeA(p, C.h), h: C.h };
  }

  // ── 5. GPU skinning: gait / fight lunge / death fall+sink+dither-dissolve ──
  // aAnim (per instance) = (gait phase, cycle rate, mode 0=march 1=fight 2=guard, death 0..1 / -1 alive)
  const ANIM_HEAD = `
uniform float uT; uniform float uHip;
attribute float aBone; attribute vec3 aPiv; attribute vec3 aPiv2; attribute float aW;
attribute vec4 aAnim;
varying float vFade;
mat3 rX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rZ(float a){ float c=cos(a),s=sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
`;
  const ANIM_BODY = `
  float aPh = aAnim.x, aSp = aAnim.y, aMd = aAnim.z, aDd = aAnim.w;
  float aT = uT*aSp*6.2831853 + aPh;
  float s1 = sin(aT);
  float wk = step(aMd, 0.5);
  float fg = step(0.5, aMd)*step(aMd, 1.5);
  float idl = step(1.5, aMd)*step(aMd, 2.5);
  // SPEC2 §D modes. 3 = marauder braced and drawing; 4 = hound four-beat gallop (bones
  // 1/2 front, 3/4 back — see buildHound); 5 = ogre stomp, a one-shot the CPU re-phases
  // so aT starts at 0 on the frame the stomp lands.
  float sht = step(2.5, aMd)*step(aMd, 3.5);
  float qd  = step(3.5, aMd)*step(aMd, 4.5);
  float slm = step(4.5, aMd);
  float ga = 1.0 - smoothstep(0.0, 0.20, max(aDd, 0.0));
  float atk = pow(0.5 + 0.5*s1, 9.0);
  float bph = fract(aT*0.15915494);                    // bow: long pull, snap release
  float pull = smoothstep(0.06, 0.70, bph)*(1.0 - smoothstep(0.78, 0.88, bph));
  float qFL = sin(aT + 2.30), qFR = sin(aT + 2.92), qBL = sin(aT), qBR = sin(aT + 0.60);
  float slp = clamp(aT*0.645, 0.0, 1.0);               // stomp progress 0..1
  float slu = smoothstep(0.0, 0.40, slp) - smoothstep(0.40, 0.58, slp);
  float legA = (wk*(-0.66*s1) + fg*(-0.26 - 0.10*atk) + idl*(-0.06) + sht*(-0.30) + qd*(0.74*qFL) + slm*(-1.24*slu))*ga;
  float legB = (wk*( 0.66*s1) + fg*( 0.22) + idl*( 0.06) + sht*( 0.26) + qd*(0.74*qFR) + slm*( 0.20*slu))*ga;
  float knA  = (wk*(0.92*max(0.0,  sin(aT+0.55))) + fg*0.34 + idl*0.11 + sht*0.16 + qd*(0.74*(qBL - qFL)) + slm*(1.35*slu))*ga;
  float knB  = (wk*(0.92*max(0.0, -sin(aT+0.55))) + fg*0.18 + idl*0.11 + sht*0.12 + qd*(0.74*(qBR - qFR)) + slm*(0.30*slu))*ga;
  float jt = fract(aPh*0.3183) - 0.5;                  // per-unit rest-pose jitter
  float armA = (wk*( 0.30*s1) + fg*(-0.40 - 0.20*atk) + idl*(-0.12) + sht*(-1.44) + slm*(-0.62*slu))*ga + jt*0.13;
  float armB = (wk*(-0.17*s1) + fg*( 0.34 - 1.45*atk) + idl*( 0.05) + sht*(-1.34 + 0.66*pull) + slm*(-0.74*slu))*ga + jt*0.20;
  float hdA  = (wk*(-0.055*sin(2.0*aT)) + fg*(0.12*atk) + idl*(0.03*sin(aT*0.8)) + sht*0.06 + qd*(0.11*sin(aT)) + slm*(-0.10*slu))*ga;
  float bob  = (wk*0.052*(0.5 - 0.5*cos(2.0*aT)) + idl*0.009*sin(aT*0.9) + fg*0.025*atk + qd*0.080*(0.5 - 0.5*cos(2.0*aT + 1.1)) + slm*(0.16*slu - 0.05))*ga;
  float rol  = (wk*0.050*s1 + qd*0.038*sin(aT + 0.9))*ga;
  float lea  = (wk*0.060 + fg*(0.11 + 0.24*atk) + sht*0.05 + qd*(0.10 + 0.17*sin(aT + 2.0)) + slm*(-0.16*slu))*ga;
  float fwd  = (fg*0.17*atk + qd*0.05*sin(aT))*ga;
  float twi  = (fg*(-0.28*atk) + sht*(-0.34))*ga;
  vec3 aP = position;
  mat3 aBM = mat3(1.0);
  if (aBone > 0.5) {
    if (aBone < 1.5)      { aBM = rX(legA); aP = aPiv + aBM*(aP - aPiv); }
    else if (aBone < 2.5) { aBM = rX(legB); aP = aPiv + aBM*(aP - aPiv); }
    else if (aBone < 3.5) { mat3 k1 = rX(knA), k2 = rX(legA);
                            aP = aPiv + k1*(aP - aPiv); aP = aPiv2 + k2*(aP - aPiv2); aBM = k2*k1; }
    else if (aBone < 4.5) { mat3 k1 = rX(knB), k2 = rX(legB);
                            aP = aPiv + k1*(aP - aPiv); aP = aPiv2 + k2*(aP - aPiv2); aBM = k2*k1; }
    else if (aBone < 5.5) { aBM = rX(armA); aP = aPiv + aBM*(aP - aPiv); }
    else if (aBone < 6.5) { aBM = rX(armB); aP = aPiv + aBM*(aP - aPiv); }
    else if (aBone < 7.5) { aBM = rY(hdA*1.5)*rX(hdA); aP = aPiv + aBM*(aP - aPiv); }
    else {
      float ww = aW;
      aP.x += sin(uT*2.7 + aPh + aP.y*3.4)*0.036*ww;
      aP.z += cos(uT*2.2 + aPh*1.7 + aP.y*2.8)*0.028*ww - (wk*0.070 + fg*0.02)*ww;
      aP.y -= 0.012*ww*wk;
    }
  }
  aP.z += fwd;
  vec3 aRP = vec3(0.0, uHip, 0.0);
  mat3 aRM = rX(lea)*rZ(rol)*rY(twi);
  aP = aRP + aRM*(aP - aRP);
  aP.y += bob;
  aBM = aRM*aBM;
  vFade = 1.0;
  if (aDd >= 0.0) {
    float dir = fract(aPh*0.1591) < 0.5 ? 1.0 : -1.0;
    float fpr = smoothstep(0.0, 0.40, aDd);
    mat3 dm = rX(dir*1.64*fpr)*rZ(dir*0.28*fpr);
    vec3 fo = vec3(0.0, 0.05, 0.0);
    aP = fo + dm*(aP - fo);
    aBM = dm*aBM;
    aP.y -= max(0.0, aDd - 0.50)/0.50*1.35;
    vFade = 1.0 - smoothstep(0.54, 1.0, aDd);
  }
`;
  const DITHER = `
  if (vFade < 0.997) {
    vec2 dp = floor(mod(gl_FragCoord.xy, 4.0));
    float dth = (mod(dp.x,2.0)*8.0 + mod(dp.y,2.0)*4.0 + floor(mod(dp.x*0.5,2.0))*2.0 + floor(mod(dp.y*0.5,2.0)))/16.0;
    if (vFade < dth + 0.02) discard;
  }
`;
  const patchAnim = (mat, hip, key) => {
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = sh => {
      sh.uniforms.uT = AT_U; sh.uniforms.uHip = { value: hip };
      sh.vertexShader = ANIM_HEAD + sh.vertexShader
        .replace('void main() {', 'void main() {\n' + ANIM_BODY)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tobjectNormal = normalize(aBM * objectNormal);')
        .replace('#include <begin_vertex>', 'vec3 transformed = aP;');
      sh.fragmentShader = 'varying float vFade;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n' + DITHER);
    };
    return mat;
  };

  // ── 5b. BOSS VARIANT KITS (SPEC2 §E) ─────────────────────────────────────────
  // A map finale used to be the base boss with a colour multiply and a scale — three
  // climaxes, one silhouette, and one of them (cinderqueen at mscale 0.88) SMALLER than the
  // boss it recoloured. Each variant now owns a swappable attachment set built in the
  // boss's own local space and rendered as one extra InstancedMesh that shares his instance
  // matrix, colour and animation attributes. Three draw calls, not three rigs — and a mesh
  // whose count is 0 never draws, so the Vale pays nothing for the other maps' finales.
  const KITS = {};
  function buildKit(kind) {
    const p = [], C = { h: 3.90 }, k = C.h / 1.80, K = v => v * k, B = 1.58, W = B * 0.93;
    const A = (g, m, bone, piv, w, tint) => { p.push({ g, m: m || null, bone: bone || 0, piv: piv || [0, 0, 0], piv2: null, w: w || null, tint }); };
    const rod = (a, b, r1, r2, t, bone, piv, tint) => { const [m, L] = spanM(a, b); A(uvAll(new THREE.CylinderGeometry(r2, r1, L, 6), t), m, bone, piv, null, tint); };
    const ySh = K(1.375), yCst = K(1.36), yCrn = K(1.71), yKne = K(0.44), shX = K(0.238) * B;
    const hp = [0, K(1.405), 0];                       // the boss's own head pivot
    if (kind === 'matriarch') {
      // FROST MATRIARCH: an antlered crown and a double banner trailing off both shoulders.
      for (const s of [-1, 1]) {
        const base = [s * K(0.150), yCrn + K(0.02), -K(0.03)], tip = [s * K(0.62), yCrn + K(0.92), -K(0.16)];
        rod(base, tip, K(0.046), K(0.014), T.BONE, 7, hp, 1.20);
        for (let i = 0; i < 3; i++) {                  // tines, alternating fore and aft
          const f = 0.24 + i * 0.26, o = [lerp(base[0], tip[0], f), lerp(base[1], tip[1], f), lerp(base[2], tip[2], f)];
          rod(o, [o[0] + s * K(0.10), o[1] + K(0.30 + i * 0.05), o[2] + (i & 1 ? K(0.24) : -K(0.20))], K(0.026), K(0.008), T.BONE, 7, hp, 1.26);
        }
      }
      for (const s of [-1, 1]) {
        const bw = K(0.30), bh = K(1.86), by = ySh + K(0.05);
        A(plateGeo([[-bw, 0], [bw, 0], [bw * 0.86, -bh * 0.62], [bw * 0.40, -bh], [-bw * 0.62, -bh * 0.88], [-bw * 0.92, -bh * 0.44]], K(0.020), T.BANN, T.BANN),
          trs(s * (shX + K(0.10)), by, -K(0.30) * W, s * 0.22, 1, 1, 1, 0.06), 8, null,
          (x, y) => clamp((by - y) / bh, 0, 1), 1.06);
        A(uvAll(new THREE.CylinderGeometry(K(0.05), K(0.05), K(0.16), 7), T.IRON), trs(s * (shX + K(0.10)), by + K(0.04), -K(0.30) * W), 0, null, null, 1.10);
      }
    } else if (kind === 'emberlord') {
      // EMBERLORD: a shoulder brazier (its coals sit on the emissive tile, so they light) and
      // a snapped greatsword strapped across the back.
      A(uvAll(new THREE.CylinderGeometry(K(0.30), K(0.17), K(0.30), 9, 1, true), T.IRON),
        trs(-(shX + K(0.13)), ySh + K(0.26), -K(0.05), 0, 1, 1, 1, 0.10), 0, null, null, 1.08);
      A(uvAll(new THREE.SphereGeometry(K(0.24), 9, 5, 0, TAU, 0, 1.2), T.EYES),
        trs(-(shX + K(0.13)), ySh + K(0.30), -K(0.05), 0, 1, 0.55, 1), 0, null, null, 1.30);
      for (let i = 0; i < 4; i++) {                    // legs of the bowl into the pauldron
        const a = i / 4 * TAU + 0.5;
        rod([-(shX + K(0.13)) + Math.cos(a) * K(0.17), ySh + K(0.13), Math.sin(a) * K(0.17) - K(0.05)],
            [-(shX + K(0.13)) + Math.cos(a) * K(0.09), ySh - K(0.10), Math.sin(a) * K(0.09) - K(0.05)], K(0.032), K(0.026), T.IRON, 0, null, 1.02);
      }
      { const bw = K(0.115), bl = K(1.10);             // the broken blade, snapped at 60%
        const pts = [[-bw, 0], [bw, 0], [bw * 0.88, bl * 0.42], [bw * 0.52, bl * 0.60], [bw * 0.10, bl * 0.50],
                     [-bw * 0.46, bl * 0.62], [-bw * 0.90, bl * 0.44]];
        A(plateGeo(pts, K(0.050), T.BLADE), trs(K(0.10), yKne + K(0.30), -K(0.36) * W, 0.10, 1, 1, 1, 0.14, 0.62), 0, null, null, 0.94);
        A(boxA(K(0.34), K(0.055), K(0.070), [T.IRON]), trs(K(0.10), yKne + K(0.24), -K(0.36) * W, 0.10, 1, 1, 1, 0.14, 0.62), 0, null, null, 1.04);
        A(boxA(K(0.40) * B, K(0.075), K(0.032), [T.LEATH]), trs(0, yCst - K(0.30), -K(0.20) * W, 0, 1, 1, 1, 0, 0.42), 0, null, null, 0.90); }
    } else if (kind === 'cinderqueen') {
      // CINDERQUEEN: a cracked mantle of spikes off the shoulder line and twin blades crossed
      // at her back — the widest and spikiest of the three reads at the greatest distance.
      for (let i = 0; i < 7; i++) {
        const f = (i / 6 - 0.5) * 2, x = f * (shX + K(0.20)), h2 = K(0.78) - Math.abs(f) * K(0.30);
        rod([x, ySh + K(0.02), -K(0.12) * W], [x * 1.24, ySh + h2, -K(0.42) * W], K(0.060), K(0.012), T.IRON, 0, null, 1.14);
        A(uvAll(new THREE.SphereGeometry(K(0.075), 6, 4), T.CRIM), trs(x, ySh + K(0.02), -K(0.12) * W), 0, null, null, 1.02);
      }
      A(uvAll(new THREE.CylinderGeometry(K(0.34) * B, K(0.46) * B, K(0.34), 11, 1, true), T.CRIM),
        trs(0, ySh - K(0.10), -K(0.06)), 0, null, null, 0.94);
      for (const s of [-1, 1]) {                       // twin blades, crossed low on the back
        const bw = K(0.085), bl = K(1.32);
        const pts = [[-bw, 0], [bw, 0], [bw * 0.82, bl * 0.55], [bw * 0.46, bl * 0.86], [0, bl], [-bw * 0.52, bl * 0.84], [-bw * 0.80, bl * 0.52]];
        A(plateGeo(pts, K(0.038), T.BLADE), trs(s * K(0.14), yCst - K(0.62), -K(0.40) * W, 0, 1, 1, 1, 0.16, s * 0.66), 0, null, null, 0.96);
        A(boxA(K(0.24), K(0.048), K(0.060), [T.GOLD]), trs(s * K(0.14), yCst - K(0.66), -K(0.40) * W, 0, 1, 1, 1, 0.16, s * 0.66), 0, null, null, 1.12);
      }
    }
    return mergeA(p, C.h);
  }

  // ── 6. archetype table + instanced meshes ──
  const CFG = {
    // FACTION LAW: red-army units carry NO T.STEEL and NO T.BLUE anywhere. Their metal is
    // T.IRON (warm, half-metallic) and their value mass is T.RED/#a42a22 tabard + skirt +
    // shield face, with T.CRIM/#7e1e18 as the shade. Steel and blue belong to the knights,
    // and that is the only thing keeping the two armies apart at gameplay zoom.
    grunt:  { h: 1.80, bulk: 1.00, hose: T.DIRT, shin: T.CRIM, mail: T.MAIL, arm: T.MAIL, hand: T.LEATH,
              pauld: T.RED, skirt: T.RED, tabard: T.RED, tabW: 1.14, chest: -1, face: T.FACE, helm: 'nasal',
              helmT: T.IRON, helmTint: 0.98, bladeTint: 0.82,
              shield: 'round', weapon: 'spear', knee: false, gait: 1.70, jit: 0.10, aim: 1.00 },
    runner: { h: 1.63, bulk: 0.86, hose: T.DIRT, shin: T.CRIM, mail: T.LEATH, arm: T.SKIN, hand: T.SKIN,
              pauld: T.RED, skirt: -1, tabard: T.RED, tabW: 1.06, chest: -1, face: T.FACE, helm: 'wrap',
              bladeTint: 0.84,
              shield: 'buckler', weapon: 'sword', knee: false, gait: 3.05, jit: 0.11, aim: 0.90, bracer: true },
    brute:  { h: 2.52, bulk: 1.42, hose: T.FUR, shin: T.LEATH, mail: T.IRON, arm: T.SKIN, hand: T.SKIN,
              pauld: T.FUR, skirt: T.CRIM, tabard: -1, chest: T.CRIM, face: T.FACE, helm: 'horned',
              shield: 'none', weapon: 'axe2h', knee: true, gait: 0.98, jit: 0.07, aim: 1.55, pelt: true,
              bracer: true, armTint: 0.80, bladeTint: 0.88 },
    // THE WARLORD. Was blue pauldrons over a gold cuirass — the enemy general dressed in the
    // player's own heraldry. Crimson over dark iron now, and gold survives only as crown
    // band, belt buckle, tabard hem and pommel (well under 8% of his surface).
    boss:   { h: 3.90, bulk: 1.58, hose: T.IRON, shin: T.IRON, mail: T.IRON, arm: T.IRON, hand: T.IRON,
              pauld: T.CRIM, skirt: T.CRIM, tabard: T.RED, chest: T.RED, face: T.EYES, helm: 'crown',
              shield: 'none', weapon: 'gsword', knee: true, gait: 0.62, jit: 0.03, aim: 2.60,
              bladeTint: 0.92, banner: true, cape: true, seg: 10, tabW: 0.94 },
    knight: { h: 1.88, bulk: 1.06, hose: T.MAIL, shin: T.MAIL, mail: T.MAIL, arm: T.MAIL, hand: T.STEEL,
              pauld: T.STEEL, skirt: T.BLUE, tabard: T.BLUE, chest: -1, face: T.FACE, helm: 'plume',
              shield: 'kite', weapon: 'sword', knee: true, kneeT: T.STEEL, gait: 1.66, jit: 0.06, aim: 1.00, bar: 0.96 },
    // ══ SPEC2 §D: four more silhouettes, same rig, +4 draw calls ══
    // Every one of them has to be told apart from a grunt at overview zoom, so each owns
    // one loud shape: a wall (pavise), a low four-legged blur (hound), a hood and a bow
    // (marauder) and sheer mass with tusks (ogre).
    shield: { h: 1.86, bulk: 1.16, hose: T.DIRT, shin: T.CRIM, mail: T.MAIL, arm: T.MAIL, hand: T.LEATH,
              pauld: T.RED, skirt: T.CRIM, tabard: T.RED, tabW: 0.96, chest: T.IRON, face: T.FACE, helm: 'kettle',
              bladeTint: 0.82,
              shield: 'tower', weapon: 'sword', knee: true, gait: 1.42, jit: 0.06, aim: 1.05,
              bracer: true, bar: 1.10 },
    hound:  { h: 1.02, quad: true, coat: T.FUR, belly: T.DIRT, sock: T.DIRT,
              seg: tier === 'mobile' ? 5 : 7, gait: 2.10, jit: 0.13, aim: 0.55, bar: 0.66 },
    marauder: { h: 1.76, bulk: 0.94, hose: T.DIRT, shin: T.LEATH, mail: T.LEATH, arm: T.SKIN, hand: T.LEATH,
              pauld: T.LEATH, skirt: -1, tabard: T.RED, tabW: 0.72, chest: -1, face: T.FACE, helm: 'hood',
              shield: 'none', weapon: 'bow', knee: false, gait: 1.85, jit: 0.09, aim: 0.98,
              bracer: true, quiver: true, bar: 0.92 },
    // legF 0.76 is what turns a giant man into an ogre: squat legs, a torso that carries
    // the mass, and a skull big enough to read the tusks from the overview camera.
    ogre:   { h: 3.45, hv: 2.95, legF: 0.76, bulk: 1.58, hose: T.HIDE, shin: T.LEATH, mail: T.HIDE,
              arm: T.HIDE, hand: T.HIDE, pauld: T.IRON, skirt: -1, tabard: T.DIRT, tabW: 0.90,
              chest: -1, face: T.HIDE, skin: T.HIDE, hair: T.HIDE,
              headS: 1.50, helm: 'tusk', shield: 'none', weapon: 'club', knee: true, gait: 0.60,
              jit: 0.05, aim: 2.00, plates: true, seg: tier === 'mobile' ? 7 : 10, bar: 1.95,
              // shoulders ~1.9x the hip line and the skull sunk into the chest: mass with no
              // neck is the whole difference between a mini-boss and a big man in a hood.
              shF: 1.22, headDrop: 0.13 },
    // ══ SPEC3 §B: five more silhouettes, +5 draw calls ══════════════════════════
    // Each one exists to be recognised INSTANTLY and answered with a different school, so
    // each owns exactly one loud shape the rest of the roster does not have: a flat-topped
    // great helm behind a wall (ironclad), a legless drifting shroud (ashwraith), antlers
    // over a bone mask (warshaman), ice grown through pale plate (frostrevenant) and a
    // wheeled machine with no man-shape at all (ram).
    ironclad: { h: 2.34, bulk: 1.48, hose: T.IRON, shin: T.IRON, mail: T.IRON, arm: T.IRON, hand: T.IRON,
              pauld: T.IRON, skirt: T.CRIM, tabard: -1, chest: T.IRON, face: T.EYES,
              skin: T.IRON, hair: T.IRON, helm: 'great', helmT: T.IRON,
              shield: 'tower', shieldS: 1.34, shieldT: T.IRON, weapon: 'sword', knee: true, kneeT: T.IRON,
              gait: 0.88, jit: 0.05, aim: 1.40, plates: true, bracer: true, bladeTint: 0.78,
              shF: 1.20, headDrop: 0.10, bar: 1.52, seg: tier === 'mobile' ? 7 : 10 },
    ashwraith: { h: 1.92, hv: 1.74, wraith: true, seg: tier === 'mobile' ? 6 : 8,
              gait: 1.05, jit: 0.14, aim: 1.05, bar: 0.90 },
    frostrevenant: { h: 1.98, bulk: 1.03, hose: T.FROST, shin: T.FROST, mail: T.FROST, arm: T.FROST,
              hand: T.BONE, pauld: T.FROST, skirt: -1, tabard: -1, chest: T.FROST, face: T.BONE,
              skin: T.BONE, hair: T.FROST, helm: 'rime', shield: 'none', weapon: 'gsword',
              knee: true, kneeT: T.FROST, gait: 1.28, jit: 0.07, aim: 1.12, bracer: true,
              rime: true, cape: true, capeT: T.SHROUD, bladeTint: 1.08, bar: 1.04 },
    warshaman: { h: 1.74, bulk: 0.92, hose: T.ROBE, shin: T.ROBE, mail: T.ROBE, arm: T.ROBE,
              hand: T.LEATH, pauld: T.ROBE, skirt: T.ROBE, tabard: T.ROBE, tabW: 0.80, chest: -1,
              face: T.BONE, skin: T.SKIN, helm: 'mask', shield: 'none', weapon: 'totem',
              knee: false, gait: 1.62, jit: 0.09, aim: 1.05, glow: true, bar: 0.94 },
    ram:     { h: 2.60, hv: 2.34, siege: true, seg: tier === 'mobile' ? 7 : 9,
              gait: 0.52, jit: 0.03, aim: 1.60, bar: 2.30 },
  };
  // Which builder each archetype is cut from. Everything human comes out of buildSoldier;
  // the hound, the wraith and the ram are the three that cannot.
  const BUILDER = C => C.quad ? buildHound(C) : C.wraith ? buildWraith(C) : C.siege ? buildRam(C) : buildSoldier(C);
  // Archetypes whose material carries the emissive sheet (ember eyes, banked coals). Any
  // other unit pays nothing: the map is only bound where it is actually used.
  const EMIT = { boss: 2.6, ashwraith: 2.9, warshaman: 2.2 };
  const CAPS = Object.assign({ knight: KNIGHT_CAP }, ACAP);
  for (const key in CFG) {
    const C = CFG[key], built = BUILDER(C), geo = built.geo, cap = CAPS[key];
    const anim = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) anim[i * 4 + 3] = -1;
    geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(anim, 4));
    const mat = patchAnim(new THREE.MeshStandardMaterial({
      map: albedo, roughnessMap: mrmap, metalnessMap: mrmap, roughness: 1, metalness: 1,
      vertexColors: true, envMapIntensity: 0.9,
      emissive: EMIT[key] ? 0xffffff : 0x000000,
      emissiveMap: EMIT[key] ? emmap : null,
      emissiveIntensity: EMIT[key] || 0,
    }), C.h * 0.50 * (C.legF || 1), 'sold_' + key);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.count = 0; mesh.name = 'ARMY_' + key;
    const dep = patchAnim(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), C.h * 0.50 * (C.legF || 1), 'solddep_' + key);
    mesh.customDepthMaterial = dep;
    scene.add(mesh);
    // `hv` is the VISUAL height when the skeleton is not 6.5 heads (see legF) — the health
    // bar rides on it, so an ogre's bar sits on its skull instead of a metre above it.
    AM[key] = { mesh, anim, cap, n: 0, h: C.hv || C.h, gait: C.gait, jit: C.jit, key,
                bar: C.bar || 0.92, quad: !!C.quad };
    Armies.meshes.push(mesh);
  }
  Armies.enemyMesh = AM.grunt.mesh; Armies.knightMesh = AM.knight.mesh;

  // Variant kits: same material, same shader rig, same hip as the boss, so a kit instance
  // walks, fights and dies in lockstep with the body it is bolted to (syncVisuals writes it
  // the identical matrix / colour / aAnim row).
  {
    const bC = CFG.boss, KCAP = 4;
    for (const kind of ['matriarch', 'emberlord', 'cinderqueen']) {
      const geo = buildKit(kind);
      const anim = new Float32Array(KCAP * 4);
      for (let i = 0; i < KCAP; i++) anim[i * 4 + 3] = -1;
      geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(anim, 4));
      const mat = patchAnim(new THREE.MeshStandardMaterial({
        map: albedo, roughnessMap: mrmap, metalnessMap: mrmap, roughness: 1, metalness: 1,
        vertexColors: true, envMapIntensity: 0.9,
        emissive: 0xffffff, emissiveMap: emmap, emissiveIntensity: 2.2,
      }), bC.h * 0.50, 'kit_' + kind);
      const mesh = new THREE.InstancedMesh(geo, mat, KCAP);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      mesh.count = 0; mesh.name = 'ARMY_KIT_' + kind;
      mesh.customDepthMaterial = patchAnim(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), bC.h * 0.50, 'kitdep_' + kind);
      scene.add(mesh);
      KITS[kind] = { mesh, anim, cap: KCAP, n: 0 };
      Armies.meshes.push(mesh);
    }
    Armies.KITS = KITM = KITS;
  }

  // ── 7. health bars: one instanced billboard quad system, drawn only when damaged ──
  {
    const bg = new THREE.PlaneGeometry(1, 1);
    const bar = new Float32Array(BAR_CAP * 2);
    bg.setAttribute('aBar', new THREE.InstancedBufferAttribute(bar, 2));
    const bmat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `
attribute vec2 aBar;
varying vec2 vU; varying float vF; varying float vK; varying vec2 vWH;
void main(){
  vU = uv; vF = aBar.x; vK = aBar.y;
  float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
  vWH = vec2(sx, sy);
  vec4 wp = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 mv = viewMatrix * wp;
  // partial screen-space sizing: a pure world-space bar is a billboard the size of a barn
  // at closeup and a single pixel at overview. Clamped depth scaling keeps it thin and
  // legible across the whole zoom range.
  float dsc = clamp(-mv.z / 72.0, 0.34, 1.30);
  vWH *= dsc;
  mv.xy += position.xy * vWH;
  mv.y += vWH.y * 0.5;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `#include <common>
varying vec2 vU; varying float vF; varying float vK; varying vec2 vWH;
void main(){
  float e = min(min(vU.x, 1.0-vU.x)*vWH.x, min(vU.y, 1.0-vU.y)*vWH.y);
  vec3 fillc = vK < 0.5 ? vec3(0.520,0.055,0.040) : vec3(0.075,0.220,0.520);
  vec3 hi    = vK < 0.5 ? vec3(1.020,0.320,0.170) : vec3(0.360,0.660,1.060);
  vec3 c; float a;
  if (e < 0.016) { c = vec3(0.020,0.017,0.014); a = 0.90; }
  else if (vU.x < vF) { c = mix(fillc, hi, smoothstep(0.20,0.92,vU.y)); a = 1.0; }
  else { c = vec3(0.045,0.037,0.030); a = 0.72; }
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
    });
    barMesh = new THREE.InstancedMesh(bg, bmat, BAR_CAP);
    barMesh.frustumCulled = false; barMesh.count = 0; barMesh.renderOrder = 6; barMesh.name = 'ARMY_BARS';
    barArr = bar;
    scene.add(barMesh);
    Armies.barMesh = barMesh;
  }
}

// ── 8. per-frame sync: sub-tick position lerp + per-unit gait jitter ──
const H1 = n => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
const DEATH_DUR = 1.45;
const _acol = new THREE.Color();
// HOOK: VFX builder (SPEC3 §D). Elemental Ward turns a whole wave against the school the
// player has leaned on hardest, and a mechanic that only exists in a HUD banner is a
// mechanic the player forgets the moment the horde walks on. So the wave WEARS it: the
// per-instance tint is dragged toward the warded school's colour on a slow pulse, phase-
// offset per unit so a column shimmers rather than strobing in lockstep. Costs one branch
// and one lerp per unit — no quads, no second draw call, nothing in the alpha bucket, which
// is the only version of this that a phone rendering three hundred bodies can afford.
// Storm reads VIOLET here and in VFX.hit, so it never collides with pierce's steel.
const WARDC = { pierce: [0.74, 0.88, 1.10], crush: [1.06, 0.88, 0.54],
                fire:   [1.20, 0.58, 0.24], storm: [0.72, 0.62, 1.30] };
const _YAX = new THREE.Vector3(0, 1, 0);
let _lastTick = -1;
Armies.syncVisuals = (vtNow) => {
  const sub = clamp(G.subT || 0, 0, 1);
  const at = vtNow + sub * TICK;                 // smooth, deterministic animation clock
  AT_U.value = at;
  const tk = G.state.tick, shift = tk !== _lastTick; _lastTick = tk;
  for (const key in AM) AM[key].n = 0;
  for (const key in KITM) KITM[key].n = 0;
  let bn = 0;
  const pushBar = (x, y, z, w, frac, kind) => {
    if (bn >= BAR_CAP) return;
    _m4.makeScale(w, w * 0.132, 1); _m4.setPosition(x, y, z);
    barMesh.setMatrixAt(bn, _m4);
    barArr[bn * 2] = clamp(frac, 0, 1); barArr[bn * 2 + 1] = kind; bn++;
  };
  for (const e of G.enemies) {
    if (!e.alive && e.deathT < 0) continue;
    const dd = e.alive ? -1 : (at - e.deathT) / DEATH_DUR;
    if (dd > 1.02) continue;
    // `art` lets a map finale borrow another archetype's mesh (SPEC2 §E boss variants)
    const A = AM[e.def.art || e.type];
    if (!A || A.n >= A.cap) continue;
    if (e._cd === undefined) { e._cd = e._pd = e.d; e._pid = e.pathId; }
    else if (shift) {
      e._pd = e._cd; e._cd = e.d;
      // a junction moves `d` onto a different spline: interpolating the old value against
      // the new one would fling the model across the map for exactly one frame
      if (e._pid !== e.pathId) { e._pd = e.d; e._pid = e.pathId; }
    }
    const d = lerp(e._pd, e._cd, sub);
    G.pathPos(d, _v3, e.lane, e.pathId);
    const tn = G.pathTan(d, e.pathId);
    let face = Math.atan2(tn.x, tn.z), mode = A.quad ? 4 : 0;
    if (e.alive && e.blockedBy >= 0) {
      const kn = G.knights[e.blockedBy];
      if (kn && kn.alive) { mode = 1; face = Math.atan2(kn.x - _v3.x, kn.z - _v3.z); }
    } else if (e.alive && e.shooting) {                // marauder: halted, drawing on a knight
      mode = 3; face = Math.atan2(e.aimX - _v3.x, e.aimZ - _v3.z);
    }
    // the ogre's stomp is a one-shot: re-phasing aAnim.x every frame off the sim time the
    // blow landed makes the shader's aT start at exactly 0 on the frame it fired.
    let stompPh = -1;
    if (e.alive && e.stompFX >= 0 && at - e.stompFX < 0.62) { mode = 5; stompPh = e.stompFX; }
    const h1 = H1(e.id * 3 + 1), h2 = H1(e.id * 7 + 23);
    const s = (1 + (h1 - 0.5) * A.jit) * (e.def.mscale || 1);
    _q.setFromAxisAngle(_YAX, face);
    _m4.compose(_v3, _q, _sc.setScalar(s));
    A.mesh.setMatrixAt(A.n, _m4);
    // per-instance lightness: the old 0.80-1.20 range pushed the top third of the horde
    // past #a42a22 into salmon under ACES + the golden-hour key. 0.78-1.10 keeps the mass
    // on the crimson side of the palette while still breaking up the ranks.
    const l = 0.78 + h2 * 0.32, wv = (h1 - 0.5) * 0.13, tnt = e.def.tint;
    if (tnt) _acol.setRGB(l * (1 + wv) * tnt[0], l * tnt[1], l * (1 - wv * 1.5) * tnt[2]);
    else _acol.setRGB(l * (1 + wv), l, l * (1 - wv * 1.5));
    if (e.ward) {                                  // SPEC3 §D — the warded wave shimmers
      const W = WARDC[e.ward];
      if (W) {
        const k = 0.15 + 0.20 * (0.5 + 0.5 * Math.sin(at * 2.3 + h2 * 6.2831853));
        _acol.setRGB(_acol.r + (W[0] * l - _acol.r) * k,
                     _acol.g + (W[1] * l - _acol.g) * k,
                     _acol.b + (W[2] * l - _acol.b) * k);
      }
    }
    A.mesh.setColorAt(A.n, _acol);
    const o = A.n * 4, an = A.anim;
    const rate = mode === 5 ? 0.45
               : mode === 3 ? 0.42 * (0.90 + h1 * 0.20)
               : mode === 1 ? 0.52 * (0.86 + h1 * 0.30) : A.gait * (0.88 + h1 * 0.24);
    an[o] = mode === 5 ? -stompPh * rate * 6.2831853 : h2 * 6.2831853;
    an[o + 1] = rate;
    an[o + 2] = mode; an[o + 3] = dd;
    A.n++;
    // SPEC2 §E: a finale variant bolts its own silhouette kit onto the shared boss body —
    // identical matrix, colour and animation row, so it is one extra draw call rather than
    // one extra rig, and it costs nothing on a map that never fields that boss.
    const KT = e.def.art_kit && KITM[e.def.art_kit];
    if (KT && KT.n < KT.cap) {
      KT.mesh.setMatrixAt(KT.n, _m4);
      KT.mesh.setColorAt(KT.n, _acol);
      const ko = KT.n * 4;
      KT.anim[ko] = an[o]; KT.anim[ko + 1] = an[o + 1]; KT.anim[ko + 2] = an[o + 2]; KT.anim[ko + 3] = an[o + 3];
      KT.n++;
    }
    // Bars are a DAMAGE read-out for the rank and file, but a mini-boss's bar is a threat
    // read-out: `elite` (SPEC3 §B — ogre, ironclad, ram) keeps it up from the moment the
    // thing walks on, so the player can see what he is about to have to kill.
    if (e.alive && (e.hp < e.maxhp || e.def.elite))
      pushBar(_v3.x, _v3.y + A.h * s + 0.34, _v3.z, A.bar * s, e.hp / e.maxhp, 0);
  }
  const KA = AM.knight;
  for (const kn of G.knights) {
    if (!kn.alive || KA.n >= KA.cap) continue;
    if (kn._cx === undefined) { kn._cx = kn._qx = kn.x; kn._cz = kn._qz = kn.z; }
    else if (shift) { kn._qx = kn._cx; kn._qz = kn._cz; kn._cx = kn.x; kn._cz = kn.z; }
    const x = lerp(kn._qx, kn._cx, sub), z = lerp(kn._qz, kn._cz, sub);
    const mv = Math.hypot(kn._cx - kn._qx, kn._cz - kn._qz);
    const mode = mv > 0.025 ? 0 : (kn.target >= 0 ? 1 : 2);
    const hid = (Math.round(kn.hx * 13) + Math.round(kn.hz * 37) * 101) | 0;
    const h1 = H1(hid), h2 = H1(hid * 5 + 7);
    const s = 1 + (h1 - 0.5) * KA.jit;
    _q.setFromAxisAngle(_YAX, kn.face);
    _m4.compose(_v3.set(x, G.groundY(x, z), z), _q, _sc.setScalar(s));
    KA.mesh.setMatrixAt(KA.n, _m4);
    const l = 0.92 + h2 * 0.16;
    _acol.setRGB(l, l, l * 1.02);
    KA.mesh.setColorAt(KA.n, _acol);
    const o = KA.n * 4, an = KA.anim;
    an[o] = h2 * 6.2831853;
    an[o + 1] = mode === 1 ? 0.60 * (0.9 + h1 * 0.2) : mode === 0 ? KA.gait * (0.9 + h1 * 0.2) : 0.24;
    an[o + 2] = mode; an[o + 3] = -1;
    KA.n++;
    if (kn.hp < kn.maxhp) pushBar(x, G.groundY(x, z) + KA.h * s + 0.34, z, 0.96 * s, kn.hp / kn.maxhp, 1);
  }
  for (const src of [AM, KITM]) for (const key in src) {
    const A = src[key];
    A.mesh.count = A.n;
    A.mesh.instanceMatrix.needsUpdate = true;
    if (A.mesh.instanceColor) A.mesh.instanceColor.needsUpdate = true;
    A.mesh.geometry.attributes.aAnim.needsUpdate = true;
  }
  barMesh.count = bn;
  barMesh.instanceMatrix.needsUpdate = true;
  barMesh.geometry.attributes.aBar.needsUpdate = true;
};
// ══════════════════════ END SECTION: ARMIES ══════════════════════

// ══════════════════════ SECTION: TOWERS (owner: TOWERS builder) ══════════════════════
// Four hand-authored procedural fortifications, each with three visible upgrade stages
// and a mechanism that actually tracks and shoots at the sim's targets.
//
// PERF CONTRACT — every tower is exactly FOUR merged meshes (one per material bucket).
// Moving parts are NOT separate objects: they are rigged in the vertex shader off baked
// per-vertex pivot/weight attributes driven by six per-tower uniforms, so a fully
// animated ballista still costs 4 draw calls. Projectiles are 3 pooled InstancedMeshes.
// Selection UX adds 2 meshes that only draw while something is selected, and every
// brazier/torch flame in the game shares 1 additive InstancedMesh.
//
// RIG CHANNELS (per-vertex weight × per-tower uniform driver):
//   aRig.x × uPitch  rotate about local X at aPiv   (elevation, catapult arm, bow draw)
//   aRig.y × uSlide  translate along local Z        (bolt carriage, nocked arrow)
//   aRig.z × uYaw    rotate about local Y at uYawP  (turret / archer torso; radians)
//   aRig.w × uAux    rotate about local Y at aPiv   (ballista arms, training dummy)
//   aLoad  × uLoad   scale about aPv2               (ammunition appear/disappear)
// ELEMENT (SPEC3 §A) replaces SPEC2's dmgType: every damaging tower belongs to exactly one
// school — pierce · crush · fire · storm — and every foe carries a resist vector against
// those four. There is no "ignores armour" branch any more: a school is strong against
// some silhouettes and inefficient against others, which is the whole diversification
// pressure. The barracks does no tower damage of its own — its knights swing CRUSH.
// `mode` (SPEC3 §F) is the tower's DEFAULT targeting doctrine; the player cycles it per
// tower (First / Strong / Close) and the choice rides on the tower, not on the type.
const TOWER_DEFS = {
  // Balance pass r2: archer one-shots early grunts (16 vs 12hp*hpMul through W4) so single-
  // target play tracks the horde-scale waves; ballista/storm hunt the TOUGHEST target in
  // range (mode 'strong') so bosses can no longer starve behind their own chaff.
  archer:   { name: 'Archer',   cost: 45,  range: 10, cd: 0.7,  dmg: 16,  color: 0x7a5a34, element: 'pierce', mode: 'first' },
  ballista: { name: 'Ballista', cost: 85,  range: 14, cd: 2.3,  dmg: 38,  color: 0x777f88, pierce: 4, element: 'pierce', mode: 'strong' },
  catapult: { name: 'Catapult', cost: 110, range: 12, cd: 3.4,  dmg: 26,  color: 0x5f5648, splash: 4.5, minRange: 4.5, element: 'crush', mode: 'first' },
  barracks: { name: 'Barracks', cost: 70,  range: 8,  cd: 0,    dmg: 0,   color: 0x3a5fa0, knights: 3, element: 'crush' },
  storm:    { name: 'Storm',    cost: 100, range: 11, cd: 1.6,  dmg: 26,  color: 0x6f86b6, element: 'storm', mode: 'strong', chain: 4, hop: 6.5, fall: 0.30 },
  pyre:     { name: 'Pyre',     cost: 95,  range: 8,  cd: 2.8,  dmg: 0,   color: 0x6a4a34, element: 'fire', mode: 'close',
              patch: { dps: 14, dur: 4, rad: 3, max: 2 } },
  banner:   { name: 'Warbanner', cost: 80, range: 9,  cd: 0,    dmg: 0,   color: 0x2e5fa3, element: 'support',
              aura: [0.12, 0.20, 0.30] },
};
// A tower "fights" if it damages by itself — the banner never does, so the sim's firing
// loop and the aim solver both ask this instead of testing `dmg` alone.
const fights = (def) => !!(def.dmg || def.patch);
G.TOWER_DEFS = TOWER_DEFS;
// onFire / fireEvents / projRender are the VFX builder's attachment points (see §hooks).
const Towers = { onFire: null, fireEvents: [], projRender: [] };
G.Towers = Towers;

// ── deterministic local jitter stream (never touches the sim rng or world scatter) ──
let _tsd = 0;
const tsd = (s) => { _tsd = (Math.imul(s | 0, 2654435761) ^ 0x9e3779b9) >>> 0; };
const trng = () => { _tsd |= 0; _tsd = _tsd + 0x6D2B79F5 | 0; let t = Math.imul(_tsd ^ _tsd >>> 15, 1 | _tsd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const tr = (a, b) => a + (b - a) * trng();

// ── absolute linear albedos for the untextured "trim" bucket. The sun is 4.9 intensity
// with 0.68 environment on top, so these are DELIBERATELY dark — 0.20 already renders
// as bright gold and 0.30 blows out. [metalness, roughness] pairs alongside.
const IRON = [0.050, 0.053, 0.061], DIRON = [0.026, 0.027, 0.031], STEEL = [0.103, 0.110, 0.122],
      GOLD = [0.200, 0.142, 0.040], ROPE = [0.086, 0.070, 0.044], LEATH = [0.058, 0.039, 0.025],
      SKIN = [0.178, 0.116, 0.082], BLUE = [0.029, 0.056, 0.130], DBLUE = [0.013, 0.027, 0.064],
      ROCK = [0.086, 0.085, 0.079], WOODC = [0.098, 0.064, 0.037], STRAW = [0.188, 0.152, 0.070],
      EMBER = [1.70, 0.50, 0.09], CREAM = [0.238, 0.208, 0.156], SOOT = [0.017, 0.015, 0.014];
const M_IRON = [0.72, 0.42], M_STEEL = [0.86, 0.27], M_GOLD = [0.93, 0.25],
      M_DULL = [0, 0.90], M_ROCK = [0, 0.95], M_CLOTH = [0, 0.86], M_SKIN = [0, 0.70];
// INTEGRATE: a tower stands at G.padY, which is the LOWEST ground within the 1.9u
// foundation footprint — so anything the model puts FURTHER out (palisade stakes at 3.8u,
// tent pegs, guy pegs) sits on a plane the terrain has already fallen away from, and on a
// slope it hangs in the air. canPlace admits ground down to ny 0.93 (~21.6 deg), so 3.8u
// out can be 1.5u below the pad. Every such prop is driven SINK deeper with its top left
// where it was: buried timber costs nothing (same merged draw call) and cannot float.
const SINK = 1.5;

// ── shared textures (created once; the wrng stream is already past World.build) ──
function tentTex() {                                   // weathered striped campaign canvas
  const S = 256, [c, g] = cnv(S);
  g.fillStyle = '#cabe9f'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < S; i += 3) { g.fillStyle = 'rgba(92,82,62,.07)'; g.fillRect(i, 0, 1, S); g.fillRect(0, i, S, 1); }
  for (let i = 0; i < 4; i++) { g.fillStyle = 'rgba(118,98,70,.17)'; g.fillRect(i * S / 4 + S / 32, 0, S / 14, S); }
  for (let i = 0; i < 46; i++) {                       // damp stains
    g.fillStyle = 'rgba(94,82,58,' + (0.04 + wrng() * 0.11) + ')';
    g.beginPath(); g.ellipse(wrng() * S, wrng() * S, 6 + wrng() * 26, 5 + wrng() * 19, wrng() * 3, 0, 7); g.fill();
  }
  for (let i = 1; i < 4; i++) {                        // stitched seams
    g.strokeStyle = 'rgba(70,60,44,.38)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, i * S / 4); g.lineTo(S, i * S / 4); g.stroke();
    g.setLineDash([4, 5]); g.strokeStyle = 'rgba(240,232,208,.30)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, i * S / 4 + 2); g.lineTo(S, i * S / 4 + 2); g.stroke(); g.setLineDash([]);
  }
  return tex(c, 1);
}
// One heraldry atlas serves every cloth on every tower: quadrants are
// [0,.5,.5,1] tall banner · [.5,.5,1,1] streamer pennant · [0,0,.5,.5] square standard ·
// [.5,0,1,.5] plain field (shields, tent flaps).
const HR_TALL = [0, 0.5, 0.5, 1], HR_PEN = [0.5, 0.5, 1, 1], HR_SQ = [0, 0, 0.5, 0.5], HR_PLAIN = [0.5, 0, 1, 0.5];
function heraldTex() {
  const S = 512, H = 256, [c, g] = cnv(S);
  const BL = '#2e5fa3', DK = '#16305c', GD = '#e8b64c', DG = '#8d6216';
  const field = (x, y, w, h, folds) => {
    const gr = g.createLinearGradient(x, y, x + w, y);
    gr.addColorStop(0, DK); gr.addColorStop(0.34, BL); gr.addColorStop(0.70, BL); gr.addColorStop(1, DK);
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    for (let i = 0; i < 200; i++) { g.fillStyle = 'rgba(0,0,0,' + (0.03 + wrng() * 0.06) + ')'; g.fillRect(x + wrng() * w, y + wrng() * h, 1 + wrng() * 3, 2 + wrng() * 15); }
    for (let i = 0; i < folds; i++) {                  // vertical cloth folds
      const fx = x + (i + 0.5) * w / folds, fw = w / folds;
      const g2 = g.createLinearGradient(fx - fw / 2, 0, fx + fw / 2, 0);
      g2.addColorStop(0, 'rgba(0,0,0,.26)'); g2.addColorStop(0.46, 'rgba(255,248,232,.13)'); g2.addColorStop(1, 'rgba(0,0,0,.24)');
      g.fillStyle = g2; g.fillRect(fx - fw / 2, y, fw, h);
    }
  };
  const star = (cx, cy, r) => {                        // six-pointed mullet, gold
    g.fillStyle = GD; g.beginPath();
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 - Math.PI / 2, rr = i & 1 ? r * 0.42 : r; const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.closePath(); g.fill();
    g.strokeStyle = DG; g.lineWidth = 3; g.stroke();
  };
  // A · tall hanging banner (top-left)
  field(0, 0, H, H, 6);
  g.fillStyle = GD; g.fillRect(0, 0, H, 14); g.fillStyle = DG; g.fillRect(0, 14, H, 5);
  g.fillStyle = GD; g.fillRect(0, 0, 9, H); g.fillRect(H - 9, 0, 9, H);
  star(H / 2, H * 0.40, 46);
  g.fillStyle = GD; g.fillRect(0, H - 26, H, 8);       // fringe rail
  for (let i = 0; i < 12; i++) { g.fillStyle = i & 1 ? GD : DG; g.beginPath(); g.moveTo(i * H / 12, H - 18); g.lineTo((i + 1) * H / 12, H - 18); g.lineTo(i * H / 12 + H / 24, H - 2); g.closePath(); g.fill(); }
  // B · long streamer pennant (top-right) — u runs along the length, v across the height
  field(H, 0, H, H, 3);
  g.fillStyle = GD; g.fillRect(H, 0, H, 16); g.fillRect(H, H - 16, H, 16);
  g.fillStyle = DG; g.fillRect(H, 16, H, 5); g.fillRect(H, H - 21, H, 5);
  for (let i = 0; i < 5; i++) {                        // chevrons pointing down-length
    g.fillStyle = i & 1 ? 'rgba(232,182,76,.92)' : 'rgba(255,240,200,.82)';
    const x0 = H + 18 + i * 46;
    g.beginPath(); g.moveTo(x0, 34); g.lineTo(x0 + 20, H / 2); g.lineTo(x0, H - 34); g.lineTo(x0 + 9, H - 34); g.lineTo(x0 + 29, H / 2); g.lineTo(x0 + 9, 34); g.closePath(); g.fill();
  }
  // C · square standard (bottom-left)
  field(0, H, H, H, 5);
  g.strokeStyle = GD; g.lineWidth = 16; g.strokeRect(8, H + 8, H - 16, H - 16);
  g.strokeStyle = DG; g.lineWidth = 4; g.strokeRect(17, H + 17, H - 34, H - 34);
  star(H / 2, H + H / 2, 66);
  // D · plain field (bottom-right)
  field(H, H, H, H, 4);
  const t = tex(c); t.anisotropy = 8; return t;
}
const TXT = { wood: woodTex(), stone: stoneTex(), slate: shingleTex('#22262c', 'rgba(108,118,132,L)'),
              tent: tentTex(), herald: heraldTex() };

// ══ vertex-shader rig ══════════════════════════════════════════════════════════
const RIG_DECL = `
attribute vec3 aPiv; attribute vec3 aPv2; attribute vec4 aRig; attribute float aLoad;
attribute vec2 aMR; attribute float aWv;
uniform float uPitch; uniform float uAux; uniform float uSlide; uniform float uYaw;
uniform float uLoad; uniform float uTT; uniform vec3 uYawP;
varying vec2 vMR;
vec3 bfRX(vec3 p, vec3 pv, float a){ vec3 q=p-pv; float c=cos(a), s=sin(a); return pv+vec3(q.x, q.y*c-q.z*s, q.y*s+q.z*c); }
vec3 bfRY(vec3 p, vec3 pv, float a){ vec3 q=p-pv; float c=cos(a), s=sin(a); return pv+vec3(q.x*c+q.z*s, q.y, -q.x*s+q.z*c); }
`;
const RIG_POS = `#include <begin_vertex>
  vMR = aMR;
  if (aLoad > 0.5) transformed = mix(aPv2, transformed, uLoad);
  if (aRig.x != 0.0) transformed = bfRX(transformed, aPiv, uPitch*aRig.x);
  if (aRig.w != 0.0) transformed = bfRY(transformed, aPiv, uAux*aRig.w);
  transformed.z += uSlide*aRig.y;
  if (aRig.z != 0.0) transformed = bfRY(transformed, uYawP, uYaw*aRig.z);
  if (aWv > 0.0) { float ph = transformed.y*1.55 + transformed.x*1.05 + transformed.z*0.7;
    transformed.z += sin(uTT*2.15 + ph)*0.26*aWv;
    transformed.x += cos(uTT*1.73 + ph*1.27)*0.14*aWv;
    transformed.y -= abs(sin(uTT*2.15 + ph))*0.05*aWv; }`;
const RIG_NRM = `#include <beginnormal_vertex>
  if (aRig.x != 0.0) objectNormal = bfRX(objectNormal, vec3(0.0), uPitch*aRig.x);
  if (aRig.w != 0.0) objectNormal = bfRY(objectNormal, vec3(0.0), uAux*aRig.w);
  if (aRig.z != 0.0) objectNormal = bfRY(objectNormal, vec3(0.0), uYaw*aRig.z);`;
function rigVS(sh, U) {
  sh.uniforms.uPitch = U.p; sh.uniforms.uAux = U.a; sh.uniforms.uSlide = U.s;
  sh.uniforms.uYaw = U.y; sh.uniforms.uLoad = U.l; sh.uniforms.uTT = U.t; sh.uniforms.uYawP = U.yp;
  sh.vertexShader = RIG_DECL + sh.vertexShader
    .replace('#include <beginnormal_vertex>', RIG_NRM)
    .replace('#include <begin_vertex>', RIG_POS);
}
// per-vertex metalness/roughness: lets one untextured material carry iron, gilding,
// rope, leather, skin and glowing coals without a second draw call.
function rigFS(sh) {
  sh.fragmentShader = 'varying vec2 vMR;\n' + sh.fragmentShader
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMR.y;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMR.x;');
}
function newU() {
  return { p: { value: 0 }, a: { value: 0 }, s: { value: 0 }, y: { value: 0 },
           l: { value: 1 }, t: { value: 0 }, yp: { value: new THREE.Vector3() } };
}
function rigMat(map, U, o) {
  const m = new THREE.MeshStandardMaterial(Object.assign({ map: map || null, vertexColors: true, roughness: 0.9, metalness: 0 }, o));
  const k = 'bf_tw' + (map ? 'm' : 'n') + (o && o.side === THREE.DoubleSide ? 'd' : '');
  m.customProgramCacheKey = () => k;
  m.onBeforeCompile = (sh) => { rigVS(sh, U); rigFS(sh); };
  return m;
}
// Without a matching depth material the shadow of a swinging catapult arm stays welded
// to its cocked pose. Same vertex patch, so it compiles once for the whole game.
function rigDepth(U) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.customProgramCacheKey = () => 'bf_twd';
  d.onBeforeCompile = (sh) => { rigVS(sh, U); };
  return d;
}

// ══ geometry assembly ══════════════════════════════════════════════════════════
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sd = new THREE.Vector3(), _sup = new THREE.Vector3(0, 1, 0);
// maps a unit-height box onto the segment a→b (so timber can be aimed, not hand-rotated)
function span(a, b) {
  _sa.fromArray(a); _sb.fromArray(b); _sd.subVectors(_sb, _sa);
  const len = _sd.length() || 1e-5; _sd.divideScalar(len);
  return [new THREE.Matrix4().compose(_sa.clone().addScaledVector(_sd, len / 2),
    new THREE.Quaternion().setFromUnitVectors(_sup, _sd), new THREE.Vector3(1, len, 1)), len];
}
const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const CY = (r0, r1, h, s, open) => new THREE.CylinderGeometry(r0, r1, h, s, 1, !!open);
const CN = (r, h, s) => new THREE.ConeGeometry(r, h, s);
const ZERO3 = [0, 0, 0], ZERO4 = [0, 0, 0, 0];
// parts: { g, m, tint, jit, ao, uv, pl, rect, piv, pv2, rig, load, mr, wv }
function tMerge(parts, uvDef) {
  let vt = 0, it = 0;
  for (const p of parts) { idxd(p.g); if (!p.g.attributes.normal) p.g.computeVertexNormals(); vt += p.g.attributes.position.count; it += p.g.index.count; }
  const pos = new Float32Array(vt * 3), nor = new Float32Array(vt * 3), uvs = new Float32Array(vt * 2),
        col = new Float32Array(vt * 3), piv = new Float32Array(vt * 3), pv2 = new Float32Array(vt * 3),
        rig = new Float32Array(vt * 4), lod = new Float32Array(vt), mrr = new Float32Array(vt * 2),
        wav = new Float32Array(vt), idx = new Uint32Array(it);
  const nm = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3(), I4 = new THREE.Matrix4();
  let vo = 0, io = 0;
  for (const p of parts) {
    const g = p.g, PA = g.attributes.position, NA = g.attributes.normal, UA = g.attributes.uv, CA = g.attributes.color;
    const m = p.m || I4; nm.getNormalMatrix(m);
    const tint = p.tint === undefined ? 1 : p.tint, jit = p.jit === undefined ? 0.24 : p.jit,
          aoK = p.ao === undefined ? 0.24 : p.ao, us = p.uv || uvDef || 1.2;
    const arr = Array.isArray(tint), R = arr ? tint[0] : tint, Gc = arr ? tint[1] : tint, Bc = arr ? tint[2] : tint;
    const pv = p.piv || ZERO3, p2 = p.pv2 || pv, rg = p.rig || ZERO4, lo = p.load ? 1 : 0;
    const mr = p.mr || M_DULL;
    for (let i = 0; i < PA.count; i++) {
      const lx = PA.getX(i), ly = PA.getY(i), lz = PA.getZ(i);
      v.set(lx, ly, lz).applyMatrix4(m);
      const k3 = (vo + i) * 3;
      pos[k3] = v.x; pos[k3 + 1] = v.y; pos[k3 + 2] = v.z;
      n.fromBufferAttribute(NA, i).applyMatrix3(nm).normalize();
      nor[k3] = n.x; nor[k3 + 1] = n.y; nor[k3 + 2] = n.z;
      if (p.pl && UA) {                                // planar: remap the source uv into a rect
        const r = p.rect || [0, 0, 1, 1];
        uvs[(vo + i) * 2] = r[0] + UA.getX(i) * (r[2] - r[0]);
        uvs[(vo + i) * 2 + 1] = r[1] + UA.getY(i) * (r[3] - r[1]);
      } else {                                         // box projection at a chosen texel density
        const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
        let uu, vv;
        if (ay >= ax && ay >= az) { uu = v.x; vv = v.z; } else if (ax >= az) { uu = v.z; vv = v.y; } else { uu = v.x; vv = v.y; }
        uvs[(vo + i) * 2] = uu / us; uvs[(vo + i) * 2 + 1] = vv / us;
      }
      const mot = 1 - jit * 0.5 + jit * vnz(v.x * 3.3 + v.z * 1.8, v.y * 2.6);
      const dn = (1 - aoK) + aoK * clamp(v.y * 0.26 + 0.56, 0, 1);
      // a source colour attribute (from paint()/facet()) is a MODULATION, not discarded —
      // that is what lets faceted procedural rock keep its per-triangle granite tint
      const sr = CA ? CA.getX(i) : 1, sg = CA ? CA.getY(i) : 1, sb = CA ? CA.getZ(i) : 1;
      col[k3] = R * sr * mot * dn; col[k3 + 1] = Gc * sg * mot * dn; col[k3 + 2] = Bc * sb * mot * dn;
      piv[k3] = pv[0]; piv[k3 + 1] = pv[1]; piv[k3 + 2] = pv[2];
      pv2[k3] = p2[0]; pv2[k3 + 1] = p2[1]; pv2[k3 + 2] = p2[2];
      const k4 = (vo + i) * 4;
      rig[k4] = rg[0]; rig[k4 + 1] = rg[1]; rig[k4 + 2] = rg[2]; rig[k4 + 3] = rg[3];
      lod[vo + i] = lo;
      mrr[(vo + i) * 2] = mr[0]; mrr[(vo + i) * 2 + 1] = mr[1];
      wav[vo + i] = p.wv ? p.wv(lx, ly, lz) : 0;
    }
    const IX = g.index; for (let i = 0; i < IX.count; i++) idx[io + i] = IX.getX(i) + vo;
    vo += PA.count; io += IX.count;
    g.dispose();
  }
  const o = new THREE.BufferGeometry();
  o.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  o.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  o.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  o.setAttribute('color', new THREE.BufferAttribute(col, 3));
  o.setAttribute('aPiv', new THREE.BufferAttribute(piv, 3));
  o.setAttribute('aPv2', new THREE.BufferAttribute(pv2, 3));
  o.setAttribute('aRig', new THREE.BufferAttribute(rig, 4));
  o.setAttribute('aLoad', new THREE.BufferAttribute(lod, 1));
  o.setAttribute('aMR', new THREE.BufferAttribute(mrr, 2));
  o.setAttribute('aWv', new THREE.BufferAttribute(wav, 1));
  o.setIndex(new THREE.BufferAttribute(idx, 1));
  o.computeBoundingSphere();
  return o;
}
// builder context: bucket keys w=timber s=masonry r=slate t=trim c=canvas b=heraldry
function ctx() {
  const bk = { w: [], s: [], r: [], t: [], c: [], b: [] };
  const add = (k, g, m, o) => { const p = Object.assign({ g, m: m || null }, o); bk[k].push(p); return p; };
  const beam = (k, w, d, a, b, o) => { const [m] = span(a, b); return add(k, B(w, 1, d), m, o); };
  return { bk, add, beam };
}
// ══ shared sub-assemblies ══════════════════════════════════════════════════════
// a hanging cloth: plane subdivided so the sway shader can ripple it, aW rising with
// distance from the fixing so the fixed edge stays put
function clothGeo(w, h, sx, sy) { const g = new THREE.PlaneGeometry(w, h, sx, sy); g.translate(0, -h / 2, 0); return g; }
// tapering streamer along +x, anchored at x=0 (swallow-tailed pennant)
function pennantGeo(len, h0, h1, seg) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, x = t * len, hh = lerp(h0, h1, t) * 0.5, sag = -t * t * 0.10;
    pos.push(x, hh + sag, 0, x, -hh + sag, 0); uv.push(t, 1, t, 0);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
// dry-stone footing pad: a ring of squat irregular blocks
function footing(add, cx, cz, r, n, sc) {
  for (let i = 0; i < n; i++) {
    const a = i / n * 6.283 + tr(0, 1), rr = r * tr(0.82, 1.06);
    add('t', B(sc * tr(0.7, 1.15), sc * tr(0.5, 0.85), sc * tr(0.7, 1.1)),
      trs(cx + Math.cos(a) * rr, sc * 0.14, cz + Math.sin(a) * rr, tr(0, 6.283), 1, 1, 1, tr(-0.06, 0.06), tr(-0.06, 0.06)),
      { tint: [ROCK[0] * 0.82, ROCK[1] * 0.90, ROCK[2] * 0.74], jit: 0.40, ao: 0.50, mr: M_ROCK });
  }
}
// iron strap + rivets round a post — the detail that stops timber reading as toy blocks
function strap(add, y, hw, th, gild) {
  for (const s of [-1, 1]) {
    add('t', B(hw * 2 + th, 0.10, th), trs(0, y, s * hw), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.14 });
    add('t', B(th, 0.10, hw * 2 + th), trs(s * hw, y, 0), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.14 });
  }
}

// A crewman: no rig, but posed leaning into a windlass / shading his eyes. Two of these
// beside a siege engine do more for scale and life than any amount of extra ironwork.
function figCrew(add, ox, oy, oz, ry, pose) {
  const TAB = [0.050, 0.096, 0.212];
  const R = (g, m, o) => add('t', g, new THREE.Matrix4().multiplyMatrices(trs(ox, oy, oz, ry), m), Object.assign({ jit: 0.20, ao: 0.30 }, o));
  const lean = pose === 0 ? 0.34 : 0.06;               // 0 = hauling the windlass, 1 = standing
  for (const s of [-1, 1]) {
    R(B(0.19, 0.86, 0.22), trs(s * 0.16, 0.43, s * 0.05 - (pose === 0 ? 0.10 : 0)), { tint: LEATH });
    R(B(0.21, 0.11, 0.31), trs(s * 0.16, 0.055, s * 0.05 + 0.04), { tint: SOOT });
  }
  R(CY(0.24, 0.30, 0.60, 7), trs(0, 1.14, 0.14, 0, 1, 1, 1, lean), { tint: LEATH });
  R(B(0.46, 0.52, 0.34), trs(0, 1.14, 0.16, 0, 1, 1, 1, lean), { tint: TAB, mr: M_CLOTH, jit: 0.18 });
  R(B(0.48, 0.08, 0.36), trs(0, 0.88, 0.10), { tint: [0.09, 0.062, 0.036] });
  R(CY(0.27, 0.25, 0.14, 8), trs(0, 1.44, 0.24, 0, 1, 1, 1, lean), { tint: STEEL, mr: M_STEEL });
  R(B(0.21, 0.23, 0.21), trs(0, 1.62, 0.30), { tint: SKIN, mr: M_SKIN, jit: 0.12 });
  R(CY(0.175, 0.16, 0.17, 8), trs(0, 1.78, 0.30), { tint: STEEL, mr: M_STEEL });
  if (pose === 0) {                                    // both arms out to the crank handles
    for (const s of [-1, 1]) { const [m] = span([s * 0.25, 1.36, 0.26], [s * 0.34, 0.98, 0.86]); R(B(0.13, 1, 0.13), m, { tint: SKIN, mr: M_SKIN }); }
  } else {                                             // one arm up pointing down-range
    R(B(0.13, 0.13, 0.62), trs(0.26, 1.44, 0.56, 0, 1, 1, 1, -0.30), { tint: SKIN, mr: M_SKIN });
    const [m] = span([-0.26, 1.34, 0.24], [-0.30, 0.86, 0.30]); R(B(0.13, 1, 0.13), m, { tint: SKIN, mr: M_SKIN });
  }
}

// ══ 1 · ARCHER WATCHTOWER ══════════════════════════════════════════════════════
// Raking timber frame on dry-stone footings, jettied fighting deck, hipped shingle
// roof, blue streamer pennant, and a live archer who tracks, draws and looses.
function figArcher(add, ox, oy, oz, pose) {
  // pose 0 = the rigged shooter (yaw + draw), 1 = kneeling nocker, 2 = spotter at the rail
  const anim = pose === 0;
  const yaw = anim ? [0, 0, 1, 0] : ZERO4;
  const P = (g, m, o) => add('t', g, m, Object.assign({ rig: yaw, jit: 0.20, ao: 0.30 }, o));
  const kneel = pose === 1, sc = kneel ? 0.90 : 1.12;
  const hipY = oy + (kneel ? 0.56 : 0.86);
  const TAB = [0.050, 0.096, 0.212];                   // brighter than the army blue: the
  // crew are 12 px tall in a gameplay frame and have to hold their faction read
  // legs
  for (const s of [-1, 1]) {
    if (kneel && s < 0) { P(B(0.17, 0.44, 0.20), trs(ox + s * 0.15, oy + 0.22, oz - 0.10, 0, 1, 1, 1, 0.9), { tint: LEATH }); P(B(0.17, 0.20, 0.44), trs(ox + s * 0.15, oy + 0.10, oz + 0.18), { tint: LEATH }); }
    else P(B(0.17, hipY - oy, 0.20), trs(ox + s * 0.15, (oy + hipY) / 2, oz + (kneel ? 0.10 : 0)), { tint: LEATH });
    P(B(0.19, 0.10, 0.28), trs(ox + s * 0.15, oy + 0.05, oz + 0.05), { tint: SOOT });
  }
  // torso: gambeson + blue tabard + belt
  P(CY(0.20 * sc, 0.25 * sc, 0.52 * sc, 7), trs(ox, hipY + 0.26 * sc, oz), { tint: LEATH });
  P(B(0.40 * sc, 0.46 * sc, 0.30 * sc), trs(ox, hipY + 0.27 * sc, oz), { tint: TAB, mr: M_CLOTH, jit: 0.18 });
  P(B(0.30 * sc, 0.34 * sc, 0.33 * sc), trs(ox, hipY + 0.16 * sc, oz), { tint: [TAB[0] * 1.5, TAB[1] * 1.5, TAB[2] * 1.5], mr: M_CLOTH, jit: 0.14 });
  P(B(0.42 * sc, 0.07, 0.32 * sc), trs(ox, hipY + 0.03, oz), { tint: GOLD, mr: M_GOLD, jit: 0.10 });
  // shoulders + head + kettle helm
  const shY = hipY + 0.48 * sc;
  P(CY(0.235 * sc, 0.215 * sc, 0.13, 8), trs(ox, shY, oz), { tint: STEEL, mr: M_STEEL });
  P(B(0.19, 0.20, 0.19), trs(ox, shY + 0.19, oz), { tint: SKIN, mr: M_SKIN, jit: 0.12 });
  P(CY(0.155, 0.145, 0.14, 8), trs(ox, shY + 0.34, oz), { tint: STEEL, mr: M_STEEL });
  P(CY(0.245, 0.245, 0.035, 10), trs(ox, shY + 0.28, oz), { tint: STEEL, mr: M_STEEL });
  // quiver on the back with fletched arrows
  P(CY(0.075, 0.065, 0.42, 7), trs(ox - 0.16, hipY + 0.28, oz - 0.19, 0, 1, 1, 1, -0.24, 0.30), { tint: LEATH });
  for (let i = 0; i < 4; i++) P(B(0.022, 0.30, 0.022), trs(ox - 0.20 + i * 0.035, hipY + 0.70, oz - 0.24 + (i & 1) * 0.03, 0, 1, 1, 1, -0.26, 0.30), { tint: i & 1 ? CREAM : STRAW, jit: 0.1 });
  const bowX = ox + 0.19 * (pose === 2 ? -1 : 1);
  if (pose === 2) {                                    // spotter: shading eyes, bow slung
    P(B(0.12, 0.40, 0.12), trs(ox + 0.24, shY + 0.10, oz + 0.02, 0, 1, 1, 1, -1.5, -0.5), { tint: SKIN, mr: M_SKIN });
    for (let i = 0; i < 5; i++) { const t = i / 4; P(B(0.05, 0.30, 0.05), trs(ox - 0.28, hipY + 0.30 + (t - 0.5) * 1.05, oz - 0.02 + Math.sin(t * 3.14) * 0.14, 0, 1, 1, 1, (t - 0.5) * 1.1), { tint: WOODC }); }
    return;
  }
  // bow: six short limbs on a quadratic arc in the y-z plane, bulging toward +z
  const bY = shY - 0.10, NL = 6;
  const bp = (t) => [bowX, bY + (t - 0.5) * 1.16, oz + 0.16 + Math.sin(t * 3.1416) * 0.30];
  for (let i = 0; i < NL; i++) {
    const [m] = span(bp(i / NL), bp((i + 1) / NL));
    add('t', B(0.075, 1, 0.105), m, { rig: yaw, tint: [0.160, 0.108, 0.062], jit: 0.20 });
  }
  const nk0 = bp(0), nk1 = bp(1);
  P(B(0.06, 0.06, 0.06), trs(nk0[0], nk0[1], nk0[2]), { tint: IRON, mr: M_IRON });
  P(B(0.06, 0.06, 0.06), trs(nk1[0], nk1[1], nk1[2]), { tint: IRON, mr: M_IRON });
  // grip + bow arm
  P(B(0.09, 0.20, 0.11), trs(bowX, bY, oz + 0.315), { tint: LEATH });
  const [am] = span([ox + 0.14, shY - 0.02, oz + 0.02], [bowX, bY + 0.02, oz + 0.30]);
  add('t', B(0.115, 1, 0.115), am, { rig: yaw, tint: SKIN, mr: M_SKIN });
  // bowstring: two halves rotating about their nocks so the V forms as it is drawn
  // both halves swing the same way about their own nock, so the string opens into a V
  const apex = [bowX, bY, oz + 0.315];
  for (const nk of [nk0, nk1]) {
    const [sm] = span(nk, apex);
    add('t', B(0.022, 1, 0.022), sm, { rig: anim ? [0.46, 0, 1, 0] : ZERO4,
      piv: nk, tint: CREAM, mr: M_CLOTH, jit: 0.06 });
  }
  // draw arm: rotates back about the shoulder as the string comes to the ear
  const [dm] = span([ox - 0.12, shY - 0.02, oz + 0.02], [bowX - 0.02, bY + 0.02, oz + 0.30]);
  add('t', B(0.12, 1, 0.12), dm, { rig: anim ? [-0.78, 0, 1, 0] : ZERO4, piv: [ox - 0.12, shY - 0.02, oz + 0.02], tint: SKIN, mr: M_SKIN });
  // nocked arrow: slides back with the draw and vanishes on release
  add('t', B(0.026, 0.026, 0.90), trs(bowX, bY, oz + 0.62), { rig: anim ? [0, -0.30, 1, 0] : ZERO4,
    load: anim, pv2: [bowX, bY, oz + 0.62], tint: STRAW, jit: 0.1 });
  add('t', CN(0.038, 0.13, 5), trs(bowX, bY, oz + 1.13, 0, 1, 1, 1, 1.5708), { rig: anim ? [0, -0.30, 1, 0] : ZERO4,
    load: anim, pv2: [bowX, bY, oz + 0.62], tint: STEEL, mr: M_STEEL });
  for (let i = 0; i < 3; i++) add('t', B(0.005, 0.075, 0.11), trs(bowX, bY, oz + 0.24, 0, 1, 1, 1, 0, i * 2.09),
    { rig: anim ? [0, -0.30, 1, 0] : ZERO4, load: anim, pv2: [bowX, bY, oz + 0.62], tint: CREAM, jit: 0.14 });
}

function bArcher(L) {
  const { bk, add, beam } = ctx();
  tsd(1101 + L * 37);
  const H = [5.0, 6.1, 7.0][L - 1];                    // fighting-deck height
  const bs = 1.46, ts = 0.84;                          // base / top half-spread of the legs
  const gild = L >= 3;
  const wo = { uv: 1.15, tint: 1, jit: 0.30, ao: 0.22 };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) footing(add, sx * bs, sz * bs, 0.30, 5, 0.56);
  if (L >= 3) footing(add, 0, 0, 1.9, 9, 0.72);        // full dry-stone plinth at max level
  // raking legs
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    beam('w', 0.31, 0.31, [sx * bs, 0.18, sz * bs], [sx * ts, H + 0.06, sz * ts], wo);
    if (L >= 2) beam('w', 0.17, 0.17, [sx * bs * 1.30, 0.05, sz * bs * 1.30], [sx * bs * 0.92, H * 0.36, sz * bs * 0.92], wo); // outriggers
  }
  const CN4 = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
  const kAt = (f) => lerp(bs, ts, f);
  const tiers = L >= 2 ? [0.04, 0.33, 0.64] : [0.33, 0.64];
  for (const [ax, az, bx, bz] of CN4) {
    for (const f of tiers) { const k = kAt(f); beam('w', 0.19, 0.19, [ax * k, H * f, az * k], [bx * k, H * f, bz * k], wo); }
    for (let i = 0; i < tiers.length - 1; i++) {
      const f0 = tiers[i], f1 = tiers[i + 1], k0 = kAt(f0), k1 = kAt(f1);
      beam('w', 0.155, 0.135, [ax * k0, H * f0, az * k0], [bx * k1, H * f1, bz * k1], wo);
      beam('w', 0.155, 0.135, [bx * k0, H * f0, bz * k0], [ax * k1, H * f1, az * k1], wo);
    }
    const kt = kAt(0.64);
    beam('w', 0.155, 0.135, [ax * kt, H * 0.64, az * kt], [bx * ts, H - 0.05, bz * ts], wo);
  }
  // ladder up the back face (-z)
  for (const s of [-1, 1]) beam('w', 0.10, 0.13, [s * 0.42, 0.0, -bs - 0.55], [s * 0.42, H - 0.1, -ts - 0.16], { uv: 1, tint: 0.9 });
  for (let i = 0; i < 9; i++) { const t = (i + 0.5) / 9; add('w', B(0.94, 0.07, 0.11), trs(0, t * (H - 0.1), lerp(-bs - 0.55, -ts - 0.16, t)), { uv: 0.8, tint: 0.86 }); }
  // jettied deck: joists, planked floor, corner brackets
  const dh = ts + 0.92;
  for (let i = -1; i <= 1; i++) add('w', B(dh * 2 + 0.24, 0.17, 0.20), trs(0, H + 0.02, i * dh * 0.60), { uv: 1.1, tint: 0.82 });
  for (let i = 0; i < 7; i++) add('w', B(dh * 2 / 7 - 0.03, 0.13, dh * 2), trs(-dh + (i + 0.5) * dh * 2 / 7, H + 0.17, 0), { uv: 1.25, tint: tr(0.88, 1.06) });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam('w', 0.14, 0.14, [sx * ts * 0.9, H - 0.85, sz * ts * 0.9], [sx * (dh - 0.1), H + 0.0, sz * (dh - 0.1)], { uv: 1, tint: 0.8 });
  // Parapet: plank hoarding on three sides, a LOW firing sill on the front (+z). The
  // archer has to be visible above it from the game camera or the whole crew is wasted.
  const pH = L >= 2 ? 0.80 : 0.66, fH = 0.34;
  add('w', B(dh * 2, pH, 0.12), trs(0, H + 0.24 + pH / 2, -dh), { uv: 1.0, tint: 0.94 });
  add('w', B(dh * 2 + 0.22, 0.13, 0.20), trs(0, H + 0.26 + pH, -dh), { uv: 1.0, tint: 0.82 });
  add('w', B(dh * 2, fH, 0.14), trs(0, H + 0.24 + fH / 2, dh), { uv: 1.0, tint: 0.96 });
  add('w', B(dh * 2 + 0.22, 0.14, 0.22), trs(0, H + 0.26 + fH, dh), { uv: 1.0, tint: 0.84 });
  for (const s of [-1, 1]) {
    add('w', B(0.12, pH, dh * 1.30), trs(s * dh, H + 0.24 + pH / 2, -dh * 0.34), { uv: 1.0, tint: 0.94 });
    add('w', B(0.12, fH, dh * 0.66), trs(s * dh, H + 0.24 + fH / 2, dh * 0.66), { uv: 1.0, tint: 0.96 });
    add('w', B(0.20, 0.13, dh * 2 + 0.22), trs(s * dh, H + 0.26 + pH, 0), { uv: 1.0, tint: 0.82 });
    if (gild) add('t', B(dh * 2 + 0.24, 0.055, 0.055), trs(0, H + 0.33 + pH, s * (dh + 0.10)), { tint: GOLD, mr: M_GOLD, jit: 0.1 });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add('w', B(0.17, pH + 0.42, 0.17), trs(sx * (dh - 0.05), H + 0.24 + (pH + 0.42) / 2, sz * (dh - 0.05)), { uv: 1.0, tint: 0.9 });
    strap(add, H + 0.20, dh + 0.02, 0.075, gild);
  }
  // roof: four posts, flared skirt + pyramid, eave fascia, finial
  const rY = H + 0.30 + pH + 1.62;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add('w', B(0.165, rY - (H + 0.20), 0.165), trs(sx * (dh - 0.12), (rY + H + 0.20) / 2, sz * (dh - 0.12)), { uv: 1.0, tint: 0.88 });
    beam('w', 0.11, 0.11, [sx * (dh - 0.12), rY - 0.62, sz * (dh - 0.12)], [sx * (dh - 0.75), rY - 0.10, sz * (dh - 0.75)], { uv: 0.8, tint: 0.8 });
  }
  add('w', B(dh * 1.7, 0.15, dh * 1.7), trs(0, rY + 0.05, 0), { uv: 1.1, tint: 0.72 });
  const rr = (dh * 0.88) / 0.7071;              // deliberately NARROWER than the deck:
  // a full-overhang pyramid hides the whole crew at the game's 50-degree camera pitch
  add('r', CN(rr, 0.60, 4), trs(0, rY + 0.42, 0, 0.7854), { uv: 2.0, tint: 0.74, jit: 0.26 });
  add('r', CN(rr * 0.76, 1.62, 4), trs(0, rY + 1.44, 0, 0.7854), { uv: 2.0, tint: 0.80, jit: 0.26 });
  for (const s of [-1, 1]) {                           // eave fascia boards
    add('w', B(dh * 1.76, 0.17, 0.11), trs(0, rY + 0.16, s * dh * 0.88), { uv: 1.0, tint: 0.68 });
    add('w', B(0.11, 0.17, dh * 1.76), trs(s * dh * 0.88, rY + 0.16, 0), { uv: 1.0, tint: 0.68 });
  }
  const apex = rY + 2.24;
  add('t', CY(0.09, 0.09, 0.30, 6), trs(0, apex - 0.05, 0), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  add('t', new THREE.SphereGeometry(gild ? 0.19 : 0.13, 9, 7), trs(0, apex + 0.16, 0), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.1 });
  // mast + streamer pennants
  const mh = [1.5, 2.0, 2.5][L - 1];
  add('t', CY(0.055, 0.045, mh, 6), trs(0, apex + 0.2 + mh / 2, 0), { tint: gild ? GOLD : DIRON, mr: gild ? M_GOLD : M_IRON });
  const pn = (py, len, h0) => {
    const g = pennantGeo(len, h0, h0 * 0.34, 8);
    add('b', g, trs(0.05, py, 0), { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / len, 0, 1) * 1.05, tint: 1, jit: 0.06, mr: M_CLOTH, ao: 0 });
  };
  pn(apex + 0.2 + mh - 0.16, [1.85, 2.25, 2.65][L - 1], [0.50, 0.58, 0.64][L - 1]);
  if (L >= 2) pn(apex + 0.2 + mh - 0.90, 1.55, 0.40);
  if (L >= 3) {                                        // gilded corner streamers
    for (const sx of [-1, 1]) {
      add('t', CY(0.045, 0.04, 1.25, 5), trs(sx * (dh - 0.05), H + 0.34 + pH + 0.60, dh - 0.05), { tint: GOLD, mr: M_GOLD });
      const g = pennantGeo(1.15, 0.32, 0.10, 6);
      add('b', g, trs(sx * (dh + 0.06), H + 0.34 + pH + 1.16, dh - 0.05, sx > 0 ? 1.15 : 4.0),
        { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / 1.15, 0, 1) * 0.95, mr: M_CLOTH, ao: 0 });
    }
  }
  // deck dressing
  add('w', CY(0.34, 0.30, 0.62, 9), trs(-dh + 0.52, H + 0.55, -dh + 0.52), { uv: 0.8, tint: 0.9 });
  for (let i = 0; i < 7; i++) add('t', B(0.024, 0.80, 0.024), trs(-dh + 0.52 + tr(-0.16, 0.16), H + 1.14, -dh + 0.52 + tr(-0.16, 0.16), 0, 1, 1, 1, tr(-0.14, 0.14), tr(-0.14, 0.14)), { tint: STRAW, jit: 0.12 });
  if (L >= 2) {                                        // shield hung on the parapet
    add('b', clothGeo(0.62, 0.72, 1, 1), trs(dh * 0.42, H + 0.30 + pH, dh + 0.09), { pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.1 });
    add('t', CY(0.09, 0.09, 0.05, 8), trs(dh * 0.42, H + 0.30 + pH - 0.36, dh + 0.13), { tint: gild ? GOLD : STEEL, mr: gild ? M_GOLD : M_STEEL });
  }
  // crew — the shooter stands at the front sill so his torso, bow and helm clear the
  // parapet at the gameplay camera angle. He yaws about his OWN feet, not the deck centre.
  const shZ = dh - 0.62;
  figArcher(add, 0, H + 0.24, shZ, 0);
  if (L >= 2) figArcher(add, -dh + 0.60, H + 0.24, shZ - 0.30, 1);
  if (L >= 3) figArcher(add, dh - 0.58, H + 0.24, -dh + 0.70, 2);
  return { bk, yawP: [0, H + 0.24, shZ], muz: [0.55, H + 1.45] };
}
// ══ 2 · BALLISTA ═══════════════════════════════════════════════════════════════
// Coursed-masonry pedestal, iron-and-ash armature that yaws + elevates onto its target,
// and a windlass re-cock between shots. Long blue banner on a mast, as per the reference.
function bBallista(L) {
  const { bk, add, beam } = ctx();
  tsd(2203 + L * 53);
  const H = [1.62, 2.02, 2.42][L - 1];                 // pedestal height
  const gild = L >= 3;
  const so = { uv: 2.4, tint: [0.66, 0.62, 0.52], jit: 0.34, ao: 0.40 };
  // pedestal: battered drum, string course, moulded cornice, entry steps. Kept NARROW —
  // an over-wide drum swallows the machine and the whole thing reads as a stone tub.
  add('s', CY(1.26, 1.52, H * 0.66, 8), trs(0, H * 0.33, 0), so);
  add('s', CY(1.36, 1.30, 0.20, 8), trs(0, H * 0.66 + 0.10, 0), { uv: 2.4, tint: 0.76, jit: 0.28, ao: 0.30 });
  add('s', CY(1.18, 1.24, H * 0.34 - 0.30, 8), trs(0, H * 0.83 - 0.05, 0), so);
  add('s', CY(1.44, 1.16, 0.24, 8), trs(0, H - 0.12, 0), { uv: 2.4, tint: 0.80, jit: 0.26, ao: 0.26 });
  for (let i = 0; i < 3; i++) add('s', B(1.5 - i * 0.16, 0.30, 0.66), trs(0, 0.15 + i * 0.24, -1.28 - (2 - i) * 0.40), { uv: 2.0, tint: 0.66, jit: 0.32, ao: 0.46 });
  footing(add, 0, 0, 1.72, 10, 0.6);
  if (gild) { add('t', CY(1.375, 1.375, 0.085, 8), trs(0, H * 0.66 + 0.10, 0), { tint: GOLD, mr: M_GOLD, jit: 0.1 });
              add('t', CY(1.46, 1.46, 0.075, 8), trs(0, H - 0.24, 0), { tint: GOLD, mr: M_GOLD, jit: 0.1 }); }
  const yawP = [0, H, 0];
  const YW = [0, 0, 1, 0];                             // "part of the traversing turret"
  // turntable + racer ring
  add('t', CY(1.06, 1.06, 0.08, 14), trs(0, H + 0.02, 0), { tint: [0.038, 0.040, 0.046], mr: [0.55, 0.55], jit: 0.14 });
  add('w', CY(0.78, 0.86, 0.15, 12), trs(0, H + 0.12, 0), { uv: 1.2, tint: 1.06, rig: YW });
  add('w', B(1.24, 0.20, 1.80), trs(0, H + 0.22, -0.05), { uv: 1.1, tint: 1.14, rig: YW });
  for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; add('t', B(0.12, 0.12, 0.12), trs(Math.cos(a) * 1.06, H + 0.02, Math.sin(a) * 1.06), { tint: IRON, mr: M_IRON }); }
  // ── the pitching cradle. Geometry is authored level; uPitch is the elevation in radians.
  // It sits a clear 0.9u above the cornice so the machine, not the plinth, is the read.
  const cy = H + 1.00, piv = [0, cy, -0.30];
  const PC = { rig: [1, 0, 1, 0], piv };               // pitch + yaw
  const S = [1.0, 1.13, 1.26][L - 1];                  // machine scale
  // stock / slider bed
  add('w', B(0.50 * S, 0.26 * S, 3.55 * S), trs(0, cy, 0.16), Object.assign({ uv: 1.2, tint: 0.96 }, PC));
  add('w', B(0.32 * S, 0.16, 3.40 * S), trs(0, cy + 0.21 * S, 0.16), Object.assign({ uv: 1.0, tint: 0.82 }, PC));
  for (const s of [-1, 1]) add('w', B(0.10 * S, 0.32 * S, 3.40 * S), trs(s * 0.24 * S, cy + 0.24 * S, 0.16), Object.assign({ uv: 1.0, tint: 0.9 }, PC));
  // trunnion cheeks carrying the cradle (traverse but do NOT pitch)
  for (const s of [-1, 1]) {
    add('w', B(0.24, 1.26, 0.52), trs(s * 0.46, cy - 0.52, -0.30), { uv: 1.0, tint: 0.88, rig: YW });
    add('t', CY(0.16, 0.16, 0.12, 9), trs(s * 0.33, cy, -0.30, 0, 1, 1, 1, 0, 1.5708), { tint: IRON, mr: M_IRON, rig: YW });
    beam('w', 0.13, 0.13, [s * 0.46, cy - 1.05, -0.30], [s * 0.86, cy - 1.14, 0.55], { uv: 0.9, tint: 0.8, rig: YW });
  }
  // elevating strut at the breech (timber, not polished steel — a metalness-0.7 rod up
  // here catches the sky and reads as a white stick from the gameplay camera)
  for (const s of [-1, 1]) beam('w', 0.12, 0.12, [s * 0.30, cy - 0.10, -0.95], [s * 0.42, H + 0.30, -0.30], { uv: 0.9, tint: 0.84, rig: YW });
  // field frame at the muzzle: two posts, transoms, vertical torsion bundles
  const fz = 1.52 * S, fy0 = cy - 0.10, fh = 1.62 * S;
  for (const s of [-1, 1]) {
    add('w', B(0.26 * S, fh, 0.32 * S), trs(s * 0.66 * S, fy0 + fh / 2, fz), Object.assign({ uv: 1.0, tint: 1.04 }, PC));
    add('t', CY(0.19 * S, 0.19 * S, fh - 0.34, 9), trs(s * 0.66 * S, fy0 + fh / 2, fz), Object.assign({ tint: ROPE, mr: M_DULL, jit: 0.30 }, PC));
    for (const yy of [fy0 + 0.10, fy0 + fh - 0.12]) add('t', CY(0.25 * S, 0.25 * S, 0.15, 9), trs(s * 0.66 * S, yy, fz), Object.assign({ tint: IRON, mr: M_IRON }, PC));
    add('t', B(0.34 * S, 0.11, 0.38 * S), trs(s * 0.66 * S, fy0 - 0.08, fz), Object.assign({ tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON }, PC));
  }
  add('w', B(1.86 * S, 0.26, 0.28 * S), trs(0, fy0 + 0.03, fz), Object.assign({ uv: 1.0, tint: 0.94 }, PC));
  add('w', B(1.86 * S, 0.24, 0.28 * S), trs(0, fy0 + fh - 0.05, fz), Object.assign({ uv: 1.0, tint: 0.94 }, PC));
  // throwing arms: sweep OUTWARD (mostly ±x) about the vertical torsion springs so the
  // silhouette from a top-down camera is unmistakably a ballista
  const armY = fy0 + fh * 0.55, aL = 1.55 * S;
  for (const s of [-1, 1]) {
    const ap = [s * 0.66 * S, armY, fz];
    const [m] = span(ap, [s * (0.66 * S + aL), armY + 0.16, fz + aL * 0.13]);
    add('w', B(0.17 * S, 1, 0.22 * S), m, { rig: [1, 0, 1, -s * 0.40], piv: ap, tint: 1.0, uv: 1.0 });
    add('t', B(0.20, 0.20, 0.15), trs(s * (0.66 * S + aL), armY + 0.16, fz + aL * 0.13), { rig: [1, 0, 1, -s * 0.40], piv: ap, tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  }
  // bowstring: rides back with the carriage; the arm tips travel the same distance so it
  // stays visually attached without a second rotation channel
  const strZ = fz + aL * 0.13;
  add('t', B((0.66 * S + aL) * 2, 0.055, 0.055), trs(0, armY + 0.16, strZ), { rig: [1, -1.05, 1, 0], piv, tint: CREAM, mr: M_CLOTH, jit: 0.06 });
  // carriage / claw + bolt
  add('w', B(0.38 * S, 0.24, 0.58), trs(0, cy + 0.36 * S, strZ - 0.12), { rig: [1, -1.05, 1, 0], piv, uv: 0.9, tint: 0.78 });
  add('t', B(0.22, 0.18, 0.22), trs(0, cy + 0.48 * S, strZ + 0.10), { rig: [1, -1.05, 1, 0], piv, tint: IRON, mr: M_IRON });
  const CG = { rig: [1, -1.05, 1, 0], piv, load: 1 };
  const bl = 2.10 * S, bz = strZ + bl * 0.5, byy = cy + 0.42 * S;
  const bpv = [0, byy, bz];
  add('w', B(0.10 * S, 0.10 * S, bl), trs(0, byy, bz), Object.assign({ pv2: bpv, uv: 0.7, tint: 0.9 }, CG));
  add('t', CN(0.14 * S, 0.42, 4), trs(0, byy, bz + bl * 0.5 + 0.19, 0, 1, 1, 1, 1.5708), Object.assign({ pv2: bpv, tint: STEEL, mr: M_STEEL }, CG));
  for (let i = 0; i < 3; i++) add('t', B(0.007, 0.12, 0.24), trs(0, byy, bz - bl * 0.5 + 0.12, 0, 1, 1, 1, 0, i * 2.094), Object.assign({ pv2: bpv, tint: LEATH, jit: 0.12 }, CG));
  // windlass at the breech: drum, crank, rope
  add('t', CY(0.22, 0.22, 0.56, 10), trs(0, cy + 0.30, -1.55, 0, 1, 1, 1, 0, 1.5708), Object.assign({ tint: IRON, mr: M_IRON }, PC));
  add('t', CY(0.155, 0.155, 0.62, 8), trs(0, cy + 0.30, -1.55, 0, 1, 1, 1, 0, 1.5708), Object.assign({ tint: ROPE, mr: M_DULL, jit: 0.3 }, PC));
  for (const s of [-1, 1]) { add('t', B(0.065, 0.40, 0.065), trs(s * 0.34, cy + 0.48, -1.55), Object.assign({ tint: IRON, mr: M_IRON }, PC));
    add('w', B(0.08, 0.08, 0.26), trs(s * 0.34, cy + 0.66, -1.48), Object.assign({ uv: 0.5, tint: 0.8 }, PC)); }
  add('t', B(0.045, 0.045, 2.5), trs(0, cy + 0.42, -0.34), Object.assign({ tint: ROPE, mr: M_DULL, jit: 0.2 }, PC));
  // pavise + bolt basket beside the pedestal (ground furniture, no rig)
  if (L >= 2) {
    add('w', B(0.10, 1.45, 1.00), trs(-1.55, 0.76, 0.60, 0, 1, 1, 1, 0, 0.16), { uv: 1.0, tint: 0.9 });
    add('b', clothGeo(0.90, 1.26, 1, 1), trs(-1.49, 1.44, 0.60, 1.5708, 1, 1, 1, 0, 0.16), { pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.12 });
  }
  add('w', CY(0.32, 0.28, 0.60, 8), trs(1.52, 0.30, -0.75), { uv: 0.8, tint: 0.86 });
  for (let i = 0; i < 5; i++) { const a = i * 1.3; add('w', B(0.075, 1.7, 0.075), trs(1.52 + Math.cos(a) * 0.14, 1.15, -0.75 + Math.sin(a) * 0.14, 0, 1, 1, 1, tr(-0.14, 0.14), tr(-0.14, 0.14)), { uv: 0.5, tint: 0.95 }); }
  for (let i = 0; i < 5; i++) { const a = i * 1.3; add('t', CN(0.10, 0.28, 4), trs(1.52 + Math.cos(a) * 0.14, 2.02, -0.75 + Math.sin(a) * 0.14), { tint: STEEL, mr: M_STEEL }); }
  // crew
  figCrew(add, 0.55, 0, -1.95, -0.25, 0);
  if (L >= 2) figCrew(add, -1.62, 0, 0.15, 1.45, 1);
  // banner mast — the long blue banner from the reference frame
  const mh = [4.6, 5.5, 6.4][L - 1], mx = 1.82;
  add('w', CY(0.115, 0.095, mh, 7), trs(mx, mh / 2, -1.55), { uv: 1.0, tint: 0.9 });
  add('t', new THREE.SphereGeometry(gild ? 0.20 : 0.14, 9, 7), trs(mx, mh + 0.14, -1.55), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.1 });
  add('t', B(0.05, 0.05, 1.10), trs(mx, mh - 0.14, -1.55 + 0.50), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  const bw = 1.22, bh = mh * 0.60;
  add('b', clothGeo(bw, bh, 3, 8), trs(mx, mh - 0.20, -1.05, 1.5708),
    { pl: 1, rect: HR_TALL, wv: (x, y) => clamp(-y / bh, 0, 1) * 0.9, mr: M_CLOTH, ao: 0 });
  if (gild) {
    add('b', clothGeo(0.72, mh * 0.40, 2, 6), trs(mx, mh - 1.05, -1.97, 1.5708),
      { pl: 1, rect: HR_TALL, wv: (x, y) => clamp(-y / (mh * 0.40), 0, 1) * 0.85, mr: M_CLOTH, ao: 0 });
    add('t', B(0.045, 0.045, 0.90), trs(mx, mh - 1.0, -1.97), { tint: GOLD, mr: M_GOLD });
  }
  return { bk, yawP, muz: [2.2 * S, H + 1.5] };
}

// ══ 3 · CATAPULT ═══════════════════════════════════════════════════════════════
// Timber onager on a stone platform. The arm is authored at the RELEASED pose, so
// uPitch = 0 is "just thrown" and uPitch = 1 is "cocked", which lets the throw play
// straight off the sim's fire event.
function bCatapult(L) {
  const { bk, add, beam } = ctx();
  tsd(3307 + L * 71);
  const L1 = L - 1, gild = L >= 3;
  const S = [1.0, 1.10, 1.20][L1];                     // overall machine scale
  const py = 0.56;                                     // stone platform top
  const so = { uv: 2.4, tint: 1, jit: 0.22, ao: 0.34 };
  add('s', B(3.5, py, 3.2), trs(0, py / 2, 0), { uv: 2.4, tint: [0.70, 0.66, 0.55], jit: 0.32, ao: 0.36 });
  add('s', B(3.74, 0.20, 3.44), trs(0, py - 0.08, 0), { uv: 2.4, tint: 0.78, jit: 0.28, ao: 0.32 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('s', B(0.5, py + 0.30, 0.5), trs(sx * 1.62, (py + 0.30) / 2, sz * 1.48), { uv: 2.0, tint: 0.70, jit: 0.30, ao: 0.44 });
  footing(add, 0, 0, 2.15, 11, 0.58);
  const yawP = [0, py, 0], YW = [0, 0, 1, 0];
  // chassis: two sills, cross members, iron shoes
  for (const s of [-1, 1]) {
    add('w', B(0.30 * S, 0.34 * S, 3.0 * S), trs(s * 0.92 * S, py + 0.17 * S, -0.1), { uv: 1.2, tint: 1.0, rig: YW });
    add('t', B(0.34 * S, 0.10, 0.34), trs(s * 0.92 * S, py + 0.02, 1.28 * S), { tint: IRON, mr: M_IRON, rig: YW });
    add('t', B(0.34 * S, 0.10, 0.34), trs(s * 0.92 * S, py + 0.02, -1.48 * S), { tint: IRON, mr: M_IRON, rig: YW });
  }
  for (const z of [1.20, 0.20, -1.30]) add('w', B(2.14 * S, 0.24 * S, 0.26 * S), trs(0, py + 0.16 * S, z * S), { uv: 1.1, tint: 0.92, rig: YW });
  // A-frame: raking posts to a padded stop beam
  const apY = py + 2.62 * S, apZ = 0.42 * S;
  for (const s of [-1, 1]) {
    beam('w', 0.28 * S, 0.30 * S, [s * 0.92 * S, py + 0.30 * S, -0.55 * S], [s * 0.30 * S, apY, apZ], { uv: 1.15, tint: 1.02, rig: YW });
    beam('w', 0.19 * S, 0.19 * S, [s * 0.92 * S, py + 0.30 * S, 1.20 * S], [s * 0.36 * S, apY - 0.30, apZ + 0.06], { uv: 1.0, tint: 0.94, rig: YW });
    add('t', B(0.34, 0.30, 0.16), trs(s * 0.60 * S, py + 1.35 * S, -0.05 * S), { tint: IRON, mr: M_IRON, rig: YW });
  }
  add('w', B(1.30 * S, 0.30 * S, 0.34 * S), trs(0, apY, apZ), { uv: 1.0, tint: 0.96, rig: YW });
  add('t', CY(0.24 * S, 0.24 * S, 1.22 * S, 9), trs(0, apY - 0.02, apZ, 0, 1, 1, 1, 0, 1.5708), { tint: ROPE, mr: M_DULL, jit: 0.32, rig: YW });
  // torsion bundle + axle bearings at the arm pivot
  const axY = py + 0.60 * S, axZ = -1.02 * S, piv = [0, axY, axZ];
  add('t', CY(0.40 * S, 0.40 * S, 1.55 * S, 12), trs(0, axY, axZ, 0, 1, 1, 1, 0, 1.5708), { tint: ROPE, mr: M_DULL, jit: 0.34, rig: YW });
  for (const s of [-1, 1]) { add('w', B(0.26 * S, 1.0 * S, 0.62 * S), trs(s * 0.90 * S, axY - 0.06, axZ), { uv: 1.0, tint: 0.9, rig: YW });
    add('t', CY(0.20, 0.20, 0.16, 9), trs(s * 0.78 * S, axY, axZ, 0, 1, 1, 1, 0, 1.5708), { tint: IRON, mr: M_IRON, rig: YW }); }
  // throwing arm (released pose) + sling pouch with a whip lead of 1.45× the arm
  const ARM = -1.42, tip = [0, axY + 3.05 * S, axZ + 1.15 * S];
  const AR = { rig: [ARM, 0, 1, 0], piv };
  const [am] = span([0, axY - 0.16, axZ - 0.06], tip);
  add('w', B(0.38 * S, 1, 0.44 * S), am, Object.assign({ uv: 1.2, tint: 1.06 }, AR));
  for (const yy of [0.35, 0.62, 0.86]) {               // iron bands up the arm
    const bp = [lerp(axY - 0.16, tip[1], yy), lerp(axZ - 0.06, tip[2], yy)];
    add('t', B(0.36 * S, 0.10, 0.40 * S), trs(0, bp[0], bp[1], 0, 1, 1, 1, -0.38), Object.assign({ tint: gild && yy > 0.8 ? GOLD : IRON, mr: gild && yy > 0.8 ? M_GOLD : M_IRON }, AR));
  }
  add('w', CY(0.50 * S, 0.34 * S, 0.40 * S, 9), trs(tip[0], tip[1] + 0.12, tip[2] + 0.12, 0, 1, 1, 1, -0.38), Object.assign({ uv: 0.8, tint: 0.86 }, AR));
  for (let i = 0; i < 3; i++) add('t', B(0.045, 0.60 * S, 0.045), trs(0, tip[1] - 0.22 + i * 0.02, tip[2] + 0.30 + i * 0.05, 0, 1, 1, 1, -1.05), { rig: [ARM * 1.42, 0, 1, 0], piv, tint: ROPE, mr: M_DULL, jit: 0.2 });
  add('t', B(0.34 * S, 0.06, 0.40 * S), trs(0, tip[1] - 0.48, tip[2] + 0.52, 0, 1, 1, 1, -1.05), { rig: [ARM * 1.42, 0, 1, 0], piv, tint: LEATH, jit: 0.2 });
  // the projectile in the pouch: scales in as the arm is winched back down
  const bo = [0, tip[1] + 0.02, tip[2] + 0.30];
  add('t', facet(paint(new THREE.IcosahedronGeometry(0.42 * S, 1), (c, x, y, z) => { const v = 0.72 + 0.5 * fbmz(x * 4.1 + 3, z * 4.1 + y * 3, 2); c.setRGB(ROCK[0] * v, ROCK[1] * v, ROCK[2] * v); }), 7.7, 0.20),
    trs(bo[0], bo[1], bo[2]), { rig: [ARM * 1.42, 0, 1, 0], piv, load: 1, pv2: bo, tint: 1, jit: 0.0, ao: 0.2, mr: M_ROCK });
  // windlass + ratchet at the front, rope running back to the arm
  add('t', CY(0.24 * S, 0.24 * S, 1.20 * S, 10), trs(0, py + 0.52 * S, 1.16 * S, 0, 1, 1, 1, 0, 1.5708), { tint: IRON, mr: M_IRON, rig: YW });
  add('t', CY(0.185, 0.185, 1.24 * S, 8), trs(0, py + 0.52 * S, 1.16 * S, 0, 1, 1, 1, 0, 1.5708), { tint: ROPE, mr: M_DULL, jit: 0.3, rig: YW });
  for (const s of [-1, 1]) { add('t', B(0.07, 0.44, 0.07), trs(s * 0.70 * S, py + 0.72 * S, 1.16 * S), { rig: [ARM * 4.6, 0, 1, 0], piv: [s * 0.70 * S, py + 0.52 * S, 1.16 * S], tint: IRON, mr: M_IRON });
    add('w', B(0.08, 0.08, 0.28), trs(s * 0.70 * S, py + 0.92 * S, 1.22 * S), { rig: [ARM * 4.6, 0, 1, 0], piv: [s * 0.70 * S, py + 0.52 * S, 1.16 * S], uv: 0.5, tint: 0.8 }); }
  add('t', CY(0.36, 0.36, 0.09, 12), trs(0.62 * S, py + 0.52 * S, 1.16 * S, 0, 1, 1, 1, 0, 1.5708), { tint: IRON, mr: M_IRON, rig: YW });
  // pavise shield wall on the front face (L2+) and a small pennant on the A-frame (L3)
  if (L >= 2) for (const s of [-1, 1]) {
    add('w', B(0.86, 1.15, 0.09), trs(s * 0.52, py + 0.95, 1.42 * S, 0, 1, 1, 1, -0.14), { uv: 1.0, tint: 0.94, rig: YW });
    add('b', clothGeo(0.76, 1.02, 1, 1), trs(s * 0.52, py + 1.48, 1.47 * S, 0, 1, 1, 1, -0.14), { pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.12, rig: YW });
  }
  if (L >= 3) {
    add('t', CY(0.05, 0.045, 1.30, 6), trs(0, apY + 0.75, apZ), { tint: GOLD, mr: M_GOLD, rig: YW });
    const g = pennantGeo(1.70, 0.46, 0.16, 7);
    add('b', g, trs(0.04, apY + 1.32, apZ), { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / 1.7, 0, 1) * 1.0, mr: M_CLOTH, ao: 0, rig: YW });
  }
  // crew
  figCrew(add, -1.05, 0, 2.20, 0.2, 0);
  if (L >= 2) figCrew(add, 1.35, 0, 2.30, -0.35, 1);
  // ammunition pile + a crate of pitch pots beside the platform
  const np = [4, 6, 8][L1];
  for (let i = 0; i < np; i++) {
    const a = tr(0, 6.283), rr = tr(0.25, 1.05), s2 = tr(0.30, 0.52);
    add('t', facet(paint(new THREE.IcosahedronGeometry(s2, 1), (c, x, y, z) => { const v = 0.70 + 0.55 * fbmz(x * 5.1 + i, z * 5.1 + y * 3, 2); c.setRGB(ROCK[0] * v, ROCK[1] * v, ROCK[2] * v); }), 3.1 + i, 0.22),
      trs(-2.30 + Math.cos(a) * rr, s2 * 0.72, 1.35 + Math.sin(a) * rr * 0.8, tr(0, 6.283)), { tint: 1, jit: 0, ao: 0.24, mr: M_ROCK });
  }
  add('w', B(0.86, 0.62, 0.70), trs(2.25, 0.31, 1.25, tr(-0.2, 0.2)), { uv: 0.9, tint: 0.88 });
  for (const s of [-1, 1]) add('t', B(0.90, 0.07, 0.07), trs(2.25, 0.31 + s * 0.20, 1.25), { tint: IRON, mr: M_IRON });
  return { bk, yawP, muz: [0.9, py + 2.4 * S] };
}
// ══ 4 · BARRACKS ═══════════════════════════════════════════════════════════════
// Palisaded campaign camp: ridge tents, a lit brazier, a battered training dummy,
// weapon rack and the company standard. Opens toward the road.
function bBarracks(L) {
  const { bk, add, beam } = ctx();
  tsd(4409 + L * 97);
  const L1 = L - 1, gild = L >= 3;
  const R = [3.30, 3.55, 3.80][L1], PH = [1.30, 1.58, 1.86][L1];   // palisade radius / height
  // ── palisade: pointed stakes on an arc, open toward +z (the road side)
  const a0 = 1.12, a1 = 6.283 - 1.12, n = Math.round((a1 - a0) / 0.21);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * (a1 - a0), h = PH * tr(0.90, 1.06);
    const x = Math.cos(a) * R, z = Math.sin(a) * R;
    add('w', CY(0.155, 0.185, h + SINK, 6), trs(x, h / 2 - 0.08 - SINK / 2, z, tr(0, 6.283), 1, 1, 1, tr(-0.04, 0.04), tr(-0.04, 0.04)), { uv: 0.9, tint: tr(0.86, 1.10), jit: 0.30, ao: 0.30 });
    add('w', CN(0.175, 0.52, 6), trs(x, h + 0.16, z), { uv: 0.7, tint: 0.86 });
  }
  for (const f of L >= 2 ? [0.42, 0.78] : [0.55]) {    // waling rails
    const rn = 30;
    for (let i = 0; i < rn; i++) {
      const aa = a0 + (i / rn) * (a1 - a0), ab = a0 + ((i + 1) / rn) * (a1 - a0);
      beam('w', 0.10, 0.16, [Math.cos(aa) * (R - 0.14), PH * f, Math.sin(aa) * (R - 0.14)], [Math.cos(ab) * (R - 0.14), PH * f, Math.sin(ab) * (R - 0.14)], { uv: 0.9, tint: 0.84 });
    }
  }
  // gate posts + lintel at the opening
  for (const s of [-1, 1]) {
    const a = s < 0 ? a1 : a0, x = Math.cos(a) * R, z = Math.sin(a) * R;
    add('w', B(0.32, PH + 0.75 + SINK, 0.32), trs(x, (PH + 0.75) / 2 - 0.08 - SINK / 2, z), { uv: 1.0, tint: 1.0 });
    add('t', CN(0.19, 0.34, 6), trs(x, PH + 0.70, z), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
    strap(add, PH * 0.55, 0.17, 0.06, gild);
  }
  for (const s of [-1, 1]) {                         // short raking braces on the gate posts
    const a = s < 0 ? a1 : a0;
    beam('w', 0.15, 0.15, [Math.cos(a) * R, PH + 0.30, Math.sin(a) * R], [Math.cos(a) * (R + 0.85), -SINK, Math.sin(a) * (R + 0.85)], { uv: 0.9, tint: 0.88 });
  }
  // ── ridge tents
  const tent = (tx, tz, ry, w, len, hgt, cmd) => {
    const sl = Math.hypot(w / 2, hgt);
    const M0 = trs(tx, 0, tz, ry);
    const put = (k, g, m, o) => add(k, g, new THREE.Matrix4().multiplyMatrices(M0, m), o);
    for (const s of [-1, 1]) put('c', B(len, 0.075, sl * 1.03), trs(0, hgt / 2, s * w / 4, 0, 1, 1, 1, s * Math.atan2(hgt, w / 2), 0), { uv: 1.9, tint: cmd ? [0.40, 0.340, 0.245] : [0.345, 0.288, 0.205], jit: 0.26, ao: 0.26 });
    put('w', B(len * 1.10, 0.11, 0.13), trs(0, hgt + 0.03, 0), { uv: 0.9, tint: 0.86 });
    for (const s of [-1, 1]) {                         // gable ends
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -w / 2, 0, 0, w / 2, 0, hgt, 0], 3));
      tg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      tg.setIndex(s < 0 ? [0, 1, 2] : [0, 2, 1]); tg.computeVertexNormals();
      put('c', tg, trs(s * len * 0.5, 0, 0), { uv: 1.9, tint: s > 0 ? [0.20, 0.178, 0.140] : [0.28, 0.248, 0.194], jit: 0.18, ao: 0.16 });
      put('w', CY(0.075, 0.09, hgt, 6), trs(s * len * 0.5, hgt / 2, 0), { uv: 0.8, tint: 0.9 });
    }
    // door flap rolled back, dark interior wedge
    put('c', B(0.05, hgt * 0.72, w * 0.34), trs(-len * 0.5 - 0.03, hgt * 0.34, w * 0.16, 0, 1, 1, 1, 0, 0, 0.22), { uv: 1.2, tint: 0.30, ao: 0.34 });
    put('t', B(0.02, hgt * 0.66, w * 0.30), trs(-len * 0.5 + 0.02, hgt * 0.31, -w * 0.06), { tint: SOOT, jit: 0.1 });
    for (const s of [-1, 1]) for (const s2 of [-1, 1]) {   // guy ropes + pegs
      const gx = s * len * 0.42, gz = s2 * (w / 2 + 0.62);
      const [gm] = span([gx, hgt * 0.92, s2 * w * 0.12], [gx, 0.02, gz]);
      put('t', B(0.028, 1, 0.028), gm, { tint: ROPE, mr: M_DULL, jit: 0.2 });
      put('w', B(0.07, 0.24 + SINK, 0.07), trs(gx, 0.06 - SINK / 2, gz, 0, 1, 1, 1, 0.2, 0), { uv: 0.5, tint: 0.8 });
    }
    if (cmd) {                                          // gilded command tent: finials + valance
      for (const s of [-1, 1]) { put('t', CY(0.045, 0.04, 0.55, 6), trs(s * len * 0.5, hgt + 0.30, 0), { tint: GOLD, mr: M_GOLD });
        put('t', new THREE.SphereGeometry(0.10, 8, 6), trs(s * len * 0.5, hgt + 0.60, 0), { tint: GOLD, mr: M_GOLD }); }
      put('b', clothGeo(len * 0.92, 0.34, 4, 1), trs(0, hgt * 0.52, w / 2 + 0.02), { pl: 1, rect: HR_PLAIN, wv: (x, y) => clamp(-y / 0.34, 0, 1) * 0.5, mr: M_CLOTH, ao: 0.1 });
    }
  };
  tent(-2.00, -1.05, 0.72, 1.90, 2.25, 1.22, false);
  if (L >= 2) tent(-2.35, 1.35, 1.52, 1.58, 1.85, 1.02, false);
  tent(1.62, -1.72, -0.46, 1.78, 2.10, 1.14, L >= 3);
  // ── brazier: iron tripod, bowl of coals (the flame quad lives in the shared glow mesh)
  const bx = 1.72, bz = 1.42;
  for (let i = 0; i < 3; i++) { const a = i * 2.094 + 0.4; const [m] = span([bx + Math.cos(a) * 0.44, 0, bz + Math.sin(a) * 0.44], [bx, 0.78, bz]); add('t', B(0.075, 1, 0.075), m, { tint: DIRON, mr: M_IRON }); }
  add('t', CY(0.46, 0.30, 0.34, 10), trs(bx, 0.92, bz), { tint: DIRON, mr: M_IRON, jit: 0.2, ao: 0.3 });
  add('t', CY(0.40, 0.40, 0.10, 10), trs(bx, 1.06, bz), { tint: EMBER, mr: [0, 0.85], jit: 0.34, ao: 0 });
  for (let i = 0; i < 5; i++) { const a = tr(0, 6.283), rr = tr(0, 0.30); add('t', B(tr(0.08, 0.16), tr(0.06, 0.12), tr(0.08, 0.16)), trs(bx + Math.cos(a) * rr, 1.13, bz + Math.sin(a) * rr, tr(0, 6.28)), { tint: i & 1 ? EMBER : SOOT, jit: 0.3, ao: 0 }); }
  // ── training dummy (rocks under blows via the aux channel)
  const dx = -1.10, dz = 2.05, dp = [dx, 0, dz];
  const DR = { rig: [0, 0, 0, 0.20], piv: dp };
  add('w', CY(0.135, 0.155, 1.70, 7), trs(dx, 0.85, dz), Object.assign({ uv: 0.9, tint: 0.94 }, DR));
  add('w', B(1.20, 0.13, 0.13), trs(dx, 1.40, dz), Object.assign({ uv: 0.8, tint: 0.9 }, DR));
  add('t', CY(0.38, 0.32, 0.74, 8), trs(dx, 1.18, dz), Object.assign({ tint: STRAW, jit: 0.36, ao: 0.2 }, DR));
  for (let i = 0; i < 7; i++) add('t', B(0.022, 0.34, 0.022), trs(dx + tr(-0.24, 0.24), 1.62, dz + tr(-0.20, 0.20), 0, 1, 1, 1, tr(-0.4, 0.4), tr(-0.4, 0.4)), Object.assign({ tint: STRAW, jit: 0.2 }, DR));
  add('t', CY(0.20, 0.19, 0.20, 8), trs(dx, 1.60, dz), Object.assign({ tint: STEEL, mr: M_STEEL }, DR));
  add('t', CY(0.28, 0.28, 0.04, 10), trs(dx, 1.52, dz), Object.assign({ tint: STEEL, mr: M_STEEL }, DR));
  add('b', clothGeo(0.52, 0.60, 1, 1), trs(dx, 1.42, dz + 0.20), Object.assign({ pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.14 }, DR));
  for (let i = 0; i < 4; i++) add('t', B(0.022, 0.18, 0.022), trs(dx + tr(-0.22, 0.22), 1.20 + tr(-0.2, 0.2), dz + 0.26, 0, 1, 1, 1, tr(-0.3, 0.3)), Object.assign({ tint: CREAM, jit: 0.1 }, DR)); // spent arrows
  // ── weapon rack, shields, barrels
  for (const s of [-1, 1]) add('w', B(0.11, 1.10, 0.11), trs(-2.30 + s * 0.55, 0.55, 2.00), { uv: 0.8, tint: 0.92 });
  add('w', B(1.30, 0.11, 0.13), trs(-2.30, 1.02, 2.00), { uv: 0.8, tint: 0.9 });
  for (let i = 0; i < 5; i++) { const ox = -2.85 + i * 0.28;
    add('w', B(0.05, 2.05, 0.05), trs(ox, 1.02, 2.00 + tr(-0.05, 0.05), 0, 1, 1, 1, tr(-0.06, 0.06), tr(-0.10, 0.10)), { uv: 0.5, tint: 0.95 });
    add('t', CN(0.06, 0.30, 4), trs(ox, 2.16, 2.00, 0, 1, 1, 1, tr(-0.06, 0.06), tr(-0.10, 0.10)), { tint: STEEL, mr: M_STEEL }); }
  for (let i = 0; i < 3; i++) {                        // stacked shields
    add('b', clothGeo(0.66, 0.78, 1, 1), trs(2.45, 0.42, -0.35 + i * 0.14, 0, 1, 1, 1, 0.24, 0, i * 0.12 - 0.1), { pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.2 });
    add('t', CY(0.085, 0.085, 0.045, 8), trs(2.42, 0.44, -0.31 + i * 0.14, 0, 1, 1, 1, 1.32), { tint: STEEL, mr: M_STEEL });
  }
  for (const [bx2, bz2, br] of [[-2.55, -1.05, 0.34], [-2.05, -1.85, 0.28]]) {
    add('w', CY(br, br * 0.88, br * 1.75, 9), trs(bx2, br * 0.87, bz2), { uv: 0.9, tint: 0.9 });
    for (const yy of [0.30, 0.72]) add('t', CY(br * 1.03, br * 1.03, 0.055, 9), trs(bx2, br * 1.75 * yy, bz2), { tint: IRON, mr: M_IRON });
  }
  // ── company standard
  const mh = [3.6, 4.3, 5.0][L1], sx = 2.15, sz = -0.05;
  add('w', CY(0.115, 0.095, mh, 7), trs(sx, mh / 2, sz), { uv: 1.0, tint: 0.92 });
  add('t', CN(gild ? 0.17 : 0.12, gild ? 0.46 : 0.32, 6), trs(sx, mh + 0.20, sz), { tint: gild ? GOLD : STEEL, mr: gild ? M_GOLD : M_STEEL });
  add('t', B(0.05, 0.05, 1.28), trs(sx, mh - 0.18, sz + 0.60), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  const bw = [1.15, 1.30, 1.48][L1], bh = bw * 1.30;
  add('b', clothGeo(bw, bh, 3, 6), trs(sx, mh - 0.24, sz + 0.62, 1.5708),
    { pl: 1, rect: HR_SQ, wv: (x, y) => clamp(-y / bh, 0, 1) * 0.85, mr: M_CLOTH, ao: 0 });
  for (let i = 0; i < 3; i++) footing(add, sx, sz, 0.5, 5, 0.5);
  return { bk, yawP: [0, 0, 0], muz: [0, 1.5], fire: [[bx, 1.28, bz, 1.0]] };
}

// ══ 5 · STORM SPIRE ════════════════════════════════════════════════════════════
// Dry-stone battered spire, iron-hooped, with a corbelled crown carrying a great
// focusing crystal caged in wrought iron. The cage traverses onto the target (uYaw), a
// copper armillary turns about the shaft (uAux) and the shards swell as the charge
// builds (uLoad). The lightning leaves the crystal, so that is the muzzle height.
// INTEGRATE: the crystal was authored at [0.62,1.35,2.20] — an albedo an order of magnitude
// past the blow-out point for this sun (see the IRON block: 0.30 already clips), so every
// facet saturated and the crown read as a white blob rather than a stone. Pulled into the
// same league as the other trim albedos but hard-biased to ice: the shell now shows its
// facets and only the inner core crosses the 0.90 bloom threshold, which is the glow.
const ARC = [0.17, 0.44, 0.86],                        // lit crystal (core still blooms)
      ARCD = [0.085, 0.180, 0.320],                    // rune slits / dead facets
      CU = [0.145, 0.082, 0.038];                      // weathered copper
function shard(add, x, y, z, s, tall, seed, o) {
  const g = facet(paint(new THREE.IcosahedronGeometry(s, 0), (c, px, py, pz) => {
    const v = 0.55 + 0.75 * vnz(px * 7 + seed, pz * 7 + py * 4);
    c.setRGB(v, v * 1.03, v * 1.08);
  }), 5.1 + seed, 0.34);
  g.scale(0.66, tall, 0.66);
  add('t', g, trs(x, y, z, tr(0, 6.283), 1, 1, 1, tr(-0.16, 0.16), tr(-0.16, 0.16)),
    Object.assign({ tint: ARC, mr: [0, 0.14], jit: 0.26, ao: 0 }, o));
}
function bStorm(L) {
  const { bk, add, beam } = ctx();
  tsd(5501 + L * 83);
  const L1 = L - 1, gild = L >= 3;
  const H = [4.3, 5.3, 6.3][L1];                       // crown platform height
  const so = { uv: 2.4, tint: [0.62, 0.60, 0.58], jit: 0.36, ao: 0.44 };
  footing(add, 0, 0, 1.96, 12, 0.64);
  // ── battered octagonal drum: plinth, string course, upper stage, corbelled cornice
  add('s', CY(1.14, 1.52, H * 0.58, 8), trs(0, H * 0.29, 0), so);
  add('s', CY(1.24, 1.18, 0.20, 8), trs(0, H * 0.58 + 0.10, 0), { uv: 2.4, tint: 0.78, jit: 0.28, ao: 0.30 });
  add('s', CY(0.95, 1.12, H * 0.42 - 0.32, 8), trs(0, H * 0.79 - 0.06, 0), so);
  add('s', CY(1.34, 0.96, 0.26, 8), trs(0, H - 0.13, 0), { uv: 2.4, tint: 0.84, jit: 0.26, ao: 0.24 });
  for (const [yy, rr2] of [[H * 0.22, 1.40], [H * 0.72, 1.03]])
    add('t', CY(rr2, rr2, 0.085, 16), trs(0, yy, 0), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.12 });
  // arched doorway, deeply shadowed, with a keystone
  add('t', B(0.72, 1.05, 0.20), trs(0, 0.52, 1.30), { tint: SOOT, jit: 0.1, ao: 0.5 });
  add('s', CY(0.44, 0.44, 0.22, 9, 0), trs(0, 1.05, 1.30, 0, 1, 1, 1, 1.5708), { uv: 1.6, tint: 0.6, ao: 0.5 });
  add('s', B(0.30, 0.26, 0.24), trs(0, 1.32, 1.34), { uv: 1.4, tint: 0.92 });
  // rune slits: narrow openings cut through the upper stage. The glow line is deliberately
  // set INSIDE a dark recess — a bright bar sitting proud of the masonry catches the sun
  // and reads as a white stick glued to the wall, not as light coming out of a window.
  for (let i = 0; i < 4; i++) {
    const a = i * 1.5708 + 0.7854, rr2 = 1.06;
    add('t', B(0.26, H * 0.24, 0.12), trs(Math.cos(a) * rr2, H * 0.80, Math.sin(a) * rr2, -a),
      { tint: SOOT, jit: 0.1, ao: 0.5 });
    add('t', B(0.075, H * 0.19, 0.05), trs(Math.cos(a) * (rr2 - 0.04), H * 0.80, Math.sin(a) * (rr2 - 0.04), -a),
      { tint: [ARCD[0] * 0.9, ARCD[1] * 0.9, ARCD[2] * 0.9], mr: [0, 0.5], jit: 0.08, ao: 0 });
  }
  if (L >= 2) for (let i = 0; i < 4; i++) {             // raking buttress spurs
    const a = i * 1.5708 + 0.7854;
    beam('s', 0.42, 0.52, [Math.cos(a) * 1.86, 0.05, Math.sin(a) * 1.86], [Math.cos(a) * 1.16, H * 0.56, Math.sin(a) * 1.16],
      { uv: 2.2, tint: 0.72, jit: 0.34, ao: 0.44 });
    add('t', B(0.26, 0.09, 0.26), trs(Math.cos(a) * 1.30, H * 0.56, Math.sin(a) * 1.30), { tint: IRON, mr: M_IRON });
  }
  // ── crown: parapet ring of small merlons, plus the yawing iron cage
  const yawP = [0, H, 0], YW = [0, 0, 1, 0];
  add('s', CY(1.16, 1.16, 0.16, 8), trs(0, H + 0.08, 0), { uv: 2.0, tint: 0.88, jit: 0.24, ao: 0.20 });
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * 6.283 + 0.3927;
    add('s', B(0.40, 0.34, 0.26), trs(Math.cos(a) * 1.02, H + 0.32, Math.sin(a) * 1.02, -a), { uv: 1.8, tint: tr(0.74, 0.96), jit: 0.30, ao: 0.28 });
  }
  const cy = H + 2.15;                                 // crystal centre
  const NA = L >= 2 ? 6 : 4;
  // The cage is a CRADLE, not a lantern: the arms stop at the crystal's equator so the
  // crystal itself is the highest, brightest thing on the model. Iron even at max tier —
  // gilding the arms turned the crown into a gold cage with a white speck in it.
  for (let i = 0; i < NA; i++) {
    const a = i / NA * 6.283 + 0.5;
    const bx = Math.cos(a) * 0.94, bz = Math.sin(a) * 0.94;
    const mx = Math.cos(a) * 0.80, mz = Math.sin(a) * 0.80;
    beam('t', 0.085, 0.085, [bx, H + 0.16, bz], [mx, cy - 0.86, mz], { tint: DIRON, mr: M_IRON, rig: YW });
    beam('t', 0.07, 0.07, [mx, cy - 0.86, mz], [Math.cos(a) * 0.42, cy - 0.16, Math.sin(a) * 0.42], { tint: DIRON, mr: M_IRON, rig: YW });
    add('t', B(0.13, 0.13, 0.13), trs(mx, cy - 0.86, mz, -a), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, rig: YW });
  }
  add('t', CY(0.36, 0.46, 0.24, NA * 2), trs(0, H + 0.24, 0), { tint: IRON, mr: M_IRON, rig: YW });
  // the focusing crystal: swells with the charge (uLoad about its own centre)
  const cpv = [0, cy, 0];
  shard(add, 0, cy, 0, [0.66, 0.80, 0.96][L1], 1.70, 3, { rig: YW, load: 1, pv2: cpv });
  shard(add, 0, cy + 0.04, 0, [0.38, 0.46, 0.56][L1], 1.95, 11, { rig: YW, load: 1, pv2: cpv, tint: [ARC[0] * 1.6, ARC[1] * 1.5, ARC[2] * 1.4], mr: [0, 0.05] });
  // ── copper armillary + orbiting shards (uAux spins the whole ring)
  const ringY = H + 1.30, AX = [0, 0, 0, 1], apv = [0, ringY, 0];
  add('t', new THREE.TorusGeometry(1.02, 0.042, 5, 22), trs(0, ringY, 0, 0, 1, 1, 1, 1.5708),
    { tint: CU, mr: [0.82, 0.38], rig: AX, piv: apv, jit: 0.16 });
  if (L >= 3) add('t', new THREE.TorusGeometry(0.84, 0.038, 5, 20), trs(0, ringY + 0.40, 0, 0, 1, 1, 1, 1.2, 0.35),
    { tint: gild ? GOLD : CU, mr: gild ? M_GOLD : [0.82, 0.38], rig: AX, piv: apv, jit: 0.16 });
  const NS = [3, 4, 6][L1];
  for (let i = 0; i < NS; i++) {
    const a = i / NS * 6.283, rr2 = 1.02, yy = ringY + (i % 2 ? 0.14 : -0.10);
    shard(add, Math.cos(a) * rr2, yy, Math.sin(a) * rr2, 0.15 + (i % 3) * 0.03, 1.9, 20 + i,
      { rig: AX, piv: apv, load: 1, pv2: [Math.cos(a) * rr2, yy, Math.sin(a) * rr2] });
  }
  // ── heraldry: a standard hung FLAT against the back of the crown, facing out, so it
  // reads as a banner from the game camera instead of edge-on beside the cage
  const bw = [1.05, 1.20, 1.34][L1], bh = [2.40, 2.90, 3.35][L1], yardZ = -1.30;
  add('t', B(bw + 0.22, 0.07, 0.07), trs(0, H + 0.46, yardZ), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, rig: YW });
  for (const s of [-1, 1]) add('t', new THREE.SphereGeometry(0.075, 7, 6), trs(s * (bw + 0.22) * 0.5, H + 0.46, yardZ), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, rig: YW });
  add('t', B(0.07, 0.07, 0.62), trs(0, H + 0.46, yardZ + 0.31), { tint: IRON, mr: M_IRON, rig: YW });
  add('b', clothGeo(bw, bh, 4, 9), trs(0, H + 0.40, yardZ - 0.04),
    { pl: 1, rect: HR_TALL, wv: (x, y) => clamp(-y / bh, 0, 1) * 0.95, mr: M_CLOTH, ao: 0, rig: YW });
  if (L >= 2) for (const s of [-1, 1]) {                // crown pennons
    add('t', CY(0.042, 0.036, 1.05, 5), trs(s * 0.98, H + 0.80, 0.16), { tint: gild ? GOLD : DIRON, mr: gild ? M_GOLD : M_IRON });
    const g = pennantGeo(1.05, 0.30, 0.10, 6);
    add('b', g, trs(s * 1.02, H + 1.22, 0.16, s > 0 ? 1.05 : 4.15),
      { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / 1.05, 0, 1) * 0.95, mr: M_CLOTH, ao: 0 });
  }
  // ── ground furniture: a scholar's lectern and a rack of spare shards
  add('w', B(0.62, 0.10, 0.44), trs(-1.90, 0.96, 0.72, 0.4, 1, 1, 1, -0.38), { uv: 0.7, tint: 0.9 });
  for (const s of [-1, 1]) beam('w', 0.09, 0.09, [-1.90 + s * 0.22, 0.02, 0.72 + s * 0.10], [-1.90 + s * 0.05, 0.94, 0.72], { uv: 0.6, tint: 0.86 });
  add('w', B(0.70, 0.36, 0.52), trs(1.92, 0.20, -0.86, -0.3), { uv: 0.8, tint: 0.84 });
  for (let i = 0; i < 3; i++) shard(add, 1.92 + tr(-0.18, 0.18), 0.44, -0.86 + tr(-0.14, 0.14), 0.13, 1.7, 40 + i, { tint: ARCD, mr: [0, 0.3] });
  figCrew(add, -1.72, 0, -0.95, 0.9, 1);
  if (L >= 3) figCrew(add, 1.55, 0, 1.30, -2.2, 0);
  return { bk, yawP, muz: [0, cy + 0.05] };
}

// ══ 6 · PYRE ═══════════════════════════════════════════════════════════════════
// A soot-blackened stone drum carrying a great iron brazier on a tripod, with a
// traversing timber davit that lobs sealed clay fire-pots over the road. The davit is
// authored at the RELEASED pose (uPitch 0 = just thrown, 1 = cocked), same contract as
// the catapult, so the throw plays straight off the sim's fire event.
const CLAY = [0.108, 0.062, 0.038], ASH = [0.052, 0.049, 0.046];
function firePot(add, x, y, z, s, o) {                 // sealed pitch pot, pitch-black glaze
  add('t', new THREE.SphereGeometry(s, 8, 6), trs(x, y, z), Object.assign({ tint: CLAY, mr: [0, 0.62], jit: 0.24 }, o));
  add('t', CY(s * 0.42, s * 0.50, s * 0.30, 8), trs(x, y + s * 0.86, z), Object.assign({ tint: CLAY, mr: [0, 0.62], jit: 0.2 }, o));
  add('t', B(s * 0.30, s * 0.34, s * 0.10), trs(x, y + s * 1.14, z), Object.assign({ tint: STRAW, jit: 0.3, ao: 0 }, o));
}
function bPyre(L) {
  const { bk, add, beam } = ctx();
  tsd(6607 + L * 89);
  const L1 = L - 1, gild = L >= 3;
  const H = [1.95, 2.35, 2.75][L1];                    // stone drum top
  const so = { uv: 2.4, tint: [0.56, 0.52, 0.46], jit: 0.36, ao: 0.44 };
  footing(add, 0, 0, 1.90, 11, 0.62);
  // ── drum: battered courses, soot-stained cornice, entry steps
  add('s', CY(1.30, 1.58, H * 0.70, 9), trs(0, H * 0.35, 0), so);
  add('s', CY(1.42, 1.34, 0.18, 9), trs(0, H * 0.70 + 0.09, 0), { uv: 2.4, tint: 0.70, jit: 0.30, ao: 0.34 });
  add('s', CY(1.22, 1.30, H * 0.30 - 0.27, 9), trs(0, H * 0.85 - 0.04, 0), { uv: 2.4, tint: [0.40, 0.37, 0.34], jit: 0.34, ao: 0.40 });
  add('s', CY(1.50, 1.22, 0.24, 9), trs(0, H - 0.12, 0), { uv: 2.4, tint: 0.64, jit: 0.28, ao: 0.30 });
  for (let i = 0; i < 3; i++) add('s', B(1.40 - i * 0.14, 0.28, 0.62), trs(0, 0.14 + i * 0.23, -1.34 - (2 - i) * 0.38), { uv: 2.0, tint: 0.60, jit: 0.32, ao: 0.46 });
  add('t', CY(1.44, 1.44, 0.09, 18), trs(0, H * 0.70 + 0.09, 0), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.12 });
  // ── brazier: heavy iron tripod, riveted bowl, bed of coals. Static — only the davit turns.
  const bowlY = H + 1.28;
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094 + 0.5;
    beam('t', 0.17, 0.17, [Math.cos(a) * 0.82, H - 0.02, Math.sin(a) * 0.82], [Math.cos(a) * 0.30, bowlY - 0.18, Math.sin(a) * 0.30], { tint: DIRON, mr: M_IRON });
    add('t', B(0.30, 0.10, 0.30), trs(Math.cos(a) * 0.82, H + 0.03, Math.sin(a) * 0.82, -a), { tint: DIRON, mr: M_IRON });
    beam('t', 0.075, 0.075, [Math.cos(a) * 0.72, H + 0.55, Math.sin(a) * 0.72], [Math.cos(a + 2.094) * 0.66, H + 0.55, Math.sin(a + 2.094) * 0.66], { tint: DIRON, mr: M_IRON });
  }
  // A DEEP bowl, not a dish: a shallow pan on legs reads as a table from the game camera.
  // Solid bowl with the coal bed sitting PROUD of its cap inside a raised iron rim: an
  // open cylinder would be back-face culled and a capped one shows the game camera a flat
  // grey lid, which is what made the first pass read as a table on legs.
  const BR = [0.80, 0.88, 0.98][L1], BD = 0.80, bt = bowlY + 0.40;
  add('t', CY(BR, BR * 0.46, BD, 14), trs(0, bt - BD / 2, 0), { tint: DIRON, mr: M_IRON, jit: 0.24, ao: 0.34 });
  add('t', CY(BR * 0.93, BR * 0.93, 0.09, 14), trs(0, bt + 0.03, 0), { tint: EMBER, mr: [0, 0.85], jit: 0.40, ao: 0 });
  for (let i = 0; i < 11; i++) {                       // coals and clinker heaped in the bed
    const a = tr(0, 6.283), rr2 = tr(0, BR * 0.76);
    add('t', B(tr(0.11, 0.22), tr(0.08, 0.16), tr(0.11, 0.22)), trs(Math.cos(a) * rr2, bt + 0.08, Math.sin(a) * rr2, tr(0, 6.28)),
      { tint: i % 3 ? EMBER : SOOT, jit: 0.34, ao: 0 });
  }
  add('t', new THREE.TorusGeometry(BR * 1.00, 0.10, 5, 18), trs(0, bt + 0.05, 0, 0, 1, 1, 1, 1.5708),
    { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.14 });
  for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283;   // rivets round the belly
    add('t', new THREE.SphereGeometry(0.055, 6, 5), trs(Math.cos(a) * BR * 0.98, bt - 0.22, Math.sin(a) * BR * 0.98), { tint: IRON, mr: M_IRON }); }
  for (let i = 0; i < 3; i++) {                        // hanging chains
    const a = i * 2.094 + 1.2;
    for (let k = 0; k < 4; k++) add('t', new THREE.TorusGeometry(0.055, 0.019, 4, 8),
      trs(Math.cos(a) * BR * 0.98, bowlY - 0.02 - k * 0.11, Math.sin(a) * BR * 0.98, 0, 1, 1, 1, k & 1 ? 0 : 1.5708),
      { tint: IRON, mr: M_IRON });
  }
  // ── traversing davit: king post, braces, throwing arm, pot in the sling
  // The king post stands BEHIND the fire and reaches well above the rim, so the arm sweeps
  // over the coals with daylight under it: the pot is dipped through the flame on its way
  // out, and the machine still reads as a machine from the gameplay camera.
  const yawP = [0, H, 0], YW = [0, 0, 1, 0];
  const kx = 0, kz = -1.42, kb = H + 0.04, kt = bowlY + 1.62;
  add('w', CY(0.20, 0.28, kt - kb, 8), trs(kx, (kb + kt) / 2, kz), { uv: 1.0, tint: 1.02, rig: YW });
  add('t', CY(0.34, 0.34, 0.16, 12), trs(kx, kb + 0.07, kz), { tint: DIRON, mr: M_IRON, rig: YW });
  for (const s of [-1, 1]) {
    beam('w', 0.13, 0.13, [kx + s * 0.74, kb, kz - 0.18], [kx + s * 0.10, kt - 0.55, kz], { uv: 0.9, tint: 0.88, rig: YW });
    beam('w', 0.11, 0.11, [kx + s * 0.10, kt - 0.90, kz], [kx + s * 0.10, kt - 0.30, kz - 0.78], { uv: 0.9, tint: 0.84, rig: YW });
  }
  strap(add, kt - 0.24, 0.16, 0.06, gild);
  const piv = [kx, kt - 0.14, kz], AR = { rig: [-1.05, 0, 1, 0], piv };
  const tip = [kx, kt + 0.20, kz + 2.95];
  const [am] = span([kx, kt - 0.44, kz - 0.72], tip);
  add('w', B(0.19, 1, 0.23), am, Object.assign({ uv: 1.1, tint: 1.05 }, AR));
  for (const f of [0.35, 0.70]) add('t', B(0.21, 0.09, 0.25), trs(kx, lerp(kt - 0.44, tip[1], f), lerp(kz - 0.72, tip[2], f), 0, 1, 1, 1, -0.20),
    Object.assign({ tint: IRON, mr: M_IRON }, AR));
  add('t', CY(0.26, 0.26, 0.34, 10), trs(kx, kt - 0.52, kz - 0.86), Object.assign({ tint: IRON, mr: M_IRON, jit: 0.2 }, AR));  // counterweight
  for (let k = 0; k < 4; k++) add('t', new THREE.TorusGeometry(0.05, 0.018, 4, 8),
    trs(tip[0], tip[1] - 0.10 - k * 0.11, tip[2], 0, 1, 1, 1, k & 1 ? 0 : 1.5708), Object.assign({ tint: IRON, mr: M_IRON }, AR));
  const po = [tip[0], tip[1] - 0.66, tip[2]];
  firePot(add, po[0], po[1], po[2], 0.28, Object.assign({ load: 1, pv2: po }, AR));
  // windlass that re-cocks the davit
  add('t', CY(0.20, 0.20, 0.52, 10), trs(kx, H + 0.42, kz - 0.62, 0, 1, 1, 1, 0, 1.5708), { tint: IRON, mr: M_IRON, rig: YW });
  add('t', B(0.045, 0.045, 1.9), trs(kx, kt - 0.60, kz - 0.30, 0, 1, 1, 1, -0.55), { tint: ROPE, mr: M_DULL, jit: 0.2, rig: YW });
  for (const s of [-1, 1]) add('t', B(0.06, 0.34, 0.06), trs(kx + s * 0.30, H + 0.58, kz - 0.62), { rig: [-4.2, 0, 1, 0], piv: [kx + s * 0.30, H + 0.42, kz - 0.62], tint: IRON, mr: M_IRON });
  // ── cressets, pot rack, ash and crew
  const fire = [[0, bt + 0.14, 0, 1.75 + 0.22 * L1]];
  if (L >= 2) for (const s of [-1, 1]) {
    const cxx = s * 1.62, czz = 1.05;
    beam('t', 0.10, 0.10, [cxx, 0.02, czz], [cxx, 1.42, czz], { tint: DIRON, mr: M_IRON });
    add('t', CY(0.30, 0.20, 0.24, 9), trs(cxx, 1.52, czz), { tint: DIRON, mr: M_IRON, jit: 0.2 });
    add('t', CY(0.26, 0.26, 0.07, 9), trs(cxx, 1.63, czz), { tint: EMBER, mr: [0, 0.85], jit: 0.3, ao: 0 });
    fire.push([cxx, 1.72, czz, 0.85]);
  }
  add('w', B(1.10, 0.16, 0.78), trs(-2.00, 0.42, 0.55, 0.35), { uv: 0.9, tint: 0.86 });
  for (const s of [-1, 1]) for (const s2 of [-1, 1]) add('w', B(0.10, 0.42, 0.10), trs(-2.00 + s * 0.46, 0.21, 0.55 + s2 * 0.30, 0.35), { uv: 0.6, tint: 0.8 });
  for (let i = 0; i < (L >= 2 ? 5 : 3); i++) firePot(add, -2.28 + i * 0.30, 0.72, 0.55 + (i & 1) * 0.24, 0.22, { });
  add('w', CY(0.36, 0.32, 0.66, 9), trs(2.10, 0.33, 0.90, 0.2), { uv: 0.8, tint: 0.82 });
  for (const yy of [0.16, 0.52]) add('t', CY(0.375, 0.375, 0.05, 9), trs(2.10, yy, 0.90), { tint: IRON, mr: M_IRON });
  add('t', CY(0.30, 0.30, 0.06, 9), trs(2.10, 0.665, 0.90), { tint: SOOT, jit: 0.3, ao: 0 });
  for (let i = 0; i < 7; i++) {                        // ash and cinder spill at the foot
    const a = tr(0, 6.283), rr2 = tr(1.7, 2.5);
    add('t', B(tr(0.16, 0.40), 0.05, tr(0.16, 0.40)), trs(Math.cos(a) * rr2, 0.03, Math.sin(a) * rr2, tr(0, 6.28)), { tint: ASH, jit: 0.32, ao: 0.2 });
  }
  figCrew(add, -0.95, 0, -2.05, 0.35, 0);
  if (L >= 2) figCrew(add, 1.55, 0, -1.55, -1.1, 1);
  if (L >= 3) {                                        // gilded pennon on the king post
    add('t', CY(0.045, 0.04, 1.15, 6), trs(kx, kt + 0.62, kz), { tint: GOLD, mr: M_GOLD, rig: YW });
    const g = pennantGeo(1.35, 0.36, 0.12, 6);
    add('b', g, trs(kx + 0.05, kt + 1.10, kz), { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / 1.35, 0, 1) * 1.0, mr: M_CLOTH, ao: 0, rig: YW });
  }
  return { bk, yawP, muz: [1.0, kt + 0.55], fire };
}

// ══ 7 · WARBANNER ══════════════════════════════════════════════════════════════
// The company's great standard on a stone dais: a tall banded mast, an enormous blue
// banner on a yard, flanking pennons, a horn-blower and a drummer. It never shoots —
// its aura is read in the SIM's cooldown maths — so the whole asset is silhouette,
// cloth and crew, and every stage adds visible ceremony.
function figHorn(add, ox, oy, oz, ry) {                // crewman with a raised war horn
  figCrew(add, ox, oy, oz, ry, 1);
  const M0 = trs(ox, oy, oz, ry);
  const R = (g, m, o) => add('t', g, new THREE.Matrix4().multiplyMatrices(M0, m), Object.assign({ jit: 0.16, ao: 0.2 }, o));
  R(CY(0.055, 0.14, 0.86, 8), trs(0.16, 1.62, 0.52, 0, 1, 1, 1, 1.20), { tint: GOLD, mr: M_GOLD });
  R(CY(0.155, 0.185, 0.14, 9), trs(0.20, 1.90, 0.86, 0, 1, 1, 1, 1.20), { tint: GOLD, mr: M_GOLD });
  R(B(0.05, 0.05, 0.24), trs(0.16, 1.62, 0.52), { tint: LEATH });
}
function bBanner(L) {
  const { bk, add, beam } = ctx();
  tsd(7703 + L * 101);
  const L1 = L - 1, gild = L >= 3;
  const mh = [5.6, 6.9, 8.2][L1];                      // mast height
  const so = { uv: 2.2, tint: [0.66, 0.63, 0.55], jit: 0.32, ao: 0.40 };
  // ── dais: two dressed courses over a dry-stone ring, worn tread on the road side
  footing(add, 0, 0, 2.05, 12, 0.60);
  add('s', CY(1.74, 1.86, 0.34, 12), trs(0, 0.17, 0), so);
  add('s', CY(1.42, 1.54, 0.30, 12), trs(0, 0.48, 0), { uv: 2.2, tint: 0.80, jit: 0.28, ao: 0.34 });
  add('s', B(1.30, 0.20, 0.52), trs(0, 0.10, 1.86), { uv: 2.0, tint: 0.72, jit: 0.3, ao: 0.4 });
  add('s', B(1.10, 0.20, 0.46), trs(0, 0.40, 1.52), { uv: 2.0, tint: 0.76, jit: 0.3, ao: 0.4 });
  if (L >= 3) add('t', CY(1.46, 1.46, 0.06, 24), trs(0, 0.635, 0), { tint: GOLD, mr: M_GOLD, jit: 0.1 });
  // ── mast: banded timber, iron collar, finial
  add('w', CY(0.155, 0.20, mh, 9), trs(0, 0.62 + mh / 2, 0), { uv: 1.1, tint: 1.0, jit: 0.26 });
  for (let i = 0; i < 4; i++) add('t', CY(0.21 - i * 0.012, 0.21 - i * 0.012, 0.10, 10), trs(0, 0.90 + i * mh * 0.22, 0),
    { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON, jit: 0.12 });
  add('t', CY(0.13, 0.05, 0.44, 8), trs(0, 0.62 + mh + 0.20, 0), { tint: gild ? GOLD : STEEL, mr: gild ? M_GOLD : M_STEEL });
  add('t', new THREE.SphereGeometry(gild ? 0.20 : 0.14, 10, 8), trs(0, 0.62 + mh + 0.02, 0), { tint: gild ? GOLD : STEEL, mr: gild ? M_GOLD : M_STEEL });
  if (gild) for (let i = 0; i < 5; i++) {              // laurel spray under the finial
    const a = i / 5 * 6.283;
    add('t', B(0.05, 0.24, 0.11), trs(Math.cos(a) * 0.16, 0.62 + mh - 0.16, Math.sin(a) * 0.16, -a, 1, 1, 1, -0.5), { tint: GOLD, mr: M_GOLD });
  }
  // ── the great banner: yard arm, rings, and a wide sheet of heraldry with a deep sway
  const yy0 = 0.62 + mh - 0.34, yl = [1.55, 1.80, 2.05][L1];
  add('t', B(0.075, 0.075, yl), trs(0, yy0, yl * 0.5 - 0.10), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  add('t', new THREE.SphereGeometry(0.085, 7, 6), trs(0, yy0, yl - 0.10), { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  for (let i = 0; i < 4; i++) add('t', new THREE.TorusGeometry(0.07, 0.022, 4, 9), trs(0, yy0 - 0.02, 0.12 + i * (yl - 0.30) / 3, 0, 1, 1, 1, 0, 1.5708),
    { tint: gild ? GOLD : IRON, mr: gild ? M_GOLD : M_IRON });
  const bw = [1.42, 1.66, 1.92][L1], bh = [3.30, 3.90, 4.50][L1];
  add('b', clothGeo(bw, bh, 4, 11), trs(0, yy0 - 0.10, bw * 0.5 - 0.08, 1.5708),
    { pl: 1, rect: HR_TALL, wv: (x, y) => clamp(-y / bh, 0, 1) * 1.05, mr: M_CLOTH, ao: 0 });
  // ── flanking pennon staves, guyed off the dais
  for (const s of [-1, 1]) {
    const px = s * 1.42, pz = -0.45, ph = [2.6, 3.2, 3.8][L1];
    // the stave foot has to reach the LOWER dais course (top 0.34) it actually stands on —
    // at 0.60 it started above that course and hung in the air (visible in _new1)
    add('w', CY(0.075, 0.09, ph + 0.40, 7), trs(px, 0.40 + ph / 2, pz, 0, 1, 1, 1, 0, -s * 0.10), { uv: 0.9, tint: 0.92 });
    add('t', CN(0.09, 0.26, 6), trs(px - s * ph * 0.05, 0.62 + ph + 0.10, pz), { tint: gild ? GOLD : STEEL, mr: gild ? M_GOLD : M_STEEL });
    const g = pennantGeo([1.30, 1.55, 1.80][L1], 0.36, 0.12, 7);
    add('b', g, trs(px - s * ph * 0.05, 0.62 + ph - 0.24, pz, s > 0 ? 1.30 : 4.00),
      { pl: 1, rect: HR_PEN, wv: (x) => clamp(x / 1.5, 0, 1) * 1.0, mr: M_CLOTH, ao: 0 });
    const [gm] = span([px + s * 0.06, 0.62 + ph * 0.62, pz], [px + s * 1.05, 0.02, pz - 0.55]);
    add('t', B(0.026, 1, 0.026), gm, { tint: ROPE, mr: M_DULL, jit: 0.2 });
    add('w', B(0.07, 0.22 + SINK, 0.07), trs(px + s * 1.05, 0.06 - SINK / 2, pz - 0.55, 0, 1, 1, 1, s * 0.2), { uv: 0.5, tint: 0.8 });
  }
  // mast guys, so the whole thing reads as rigged rather than planted
  for (let i = 0; i < 3; i++) {
    const a = 2.2 + i * 1.9;
    const [gm] = span([Math.cos(a) * 0.16, 0.62 + mh * 0.72, Math.sin(a) * 0.16], [Math.cos(a) * 2.55, 0.02, Math.sin(a) * 2.55]);
    add('t', B(0.028, 1, 0.028), gm, { tint: ROPE, mr: M_DULL, jit: 0.2 });
    add('w', B(0.08, 0.26 + SINK, 0.08), trs(Math.cos(a) * 2.55, 0.07 - SINK / 2, Math.sin(a) * 2.55, -a, 1, 1, 1, 0.18), { uv: 0.5, tint: 0.82 });
  }
  // ── crew: the horn-blower on the dais, a drummer, and a shield trophy at max tier
  figHorn(add, -0.72, 0.62, 0.62, -0.55);
  if (L >= 2) {                                        // drummer, with the drum slung
    const DR = { rig: [0, 0, 0, 0.16], piv: [1.05, 0, -0.55] };
    figCrew(add, 1.05, 0.62, -0.55, 2.5, 1);
    add('w', CY(0.34, 0.34, 0.46, 12), trs(1.05, 1.10, -0.16, 0, 1, 1, 1, 0.25), Object.assign({ uv: 0.8, tint: 0.9 }, DR));
    add('c', CY(0.345, 0.345, 0.06, 12), trs(1.05, 1.32, -0.14), Object.assign({ uv: 1.4, tint: 0.9 }, DR));
    for (const s of [-1, 1]) add('t', B(0.035, 0.34, 0.035), trs(1.05 + s * 0.20, 1.52, -0.24, 0, 1, 1, 1, s * 0.6, s * 0.3), Object.assign({ tint: STRAW, jit: 0.14 }, DR));
  }
  if (L >= 3) {
    for (let i = 0; i < 3; i++) {                      // captured shields stacked at the dais
      add('b', clothGeo(0.66, 0.78, 1, 1), trs(-1.85, 0.44, -0.85 + i * 0.16, 0, 1, 1, 1, 0.26, 0, i * 0.13 - 0.12),
        { pl: 1, rect: HR_PLAIN, mr: M_CLOTH, ao: 0.2 });
      add('t', CY(0.085, 0.085, 0.045, 8), trs(-1.88, 0.46, -0.81 + i * 0.16, 0, 1, 1, 1, 1.32), { tint: STEEL, mr: M_STEEL });
    }
    figCrew(add, 1.70, 0, 1.35, -2.6, 0);
  }
  return { bk, yawP: [0, 0, 0], muz: [0, 2.0] };
}

// ══ assembly, caching and per-tower material sets ══════════════════════════════
const BUILDERS = { archer: bArcher, ballista: bBallista, catapult: bCatapult, barracks: bBarracks,
                   storm: bStorm, pyre: bPyre, banner: bBanner };
const GEO_CACHE = new Map();
function towerGeo(type, level) {
  const key = type + level;
  let e = GEO_CACHE.get(key);
  if (e) return e;
  const r = BUILDERS[type](level);
  const geos = {};
  for (const k of ['w', 's', 'r', 't', 'c', 'b']) if (r.bk[k].length) geos[k] = tMerge(r.bk[k], k === 's' ? 2.4 : 1.2);
  e = { geos, yawP: r.yawP, muz: r.muz, fire: r.fire || [] };
  GEO_CACHE.set(key, e);
  return e;
}
const BUCKET_TX = { w: 'wood', s: 'stone', r: 'slate', t: null, c: 'tent', b: 'herald' };
// base yaw: every tower turns to face the road, so a row of them never reads as a
// line of identical copies stamped on the meadow
function roadFacing(x, z) {
  let bq = 1e18, bx = x, bz = z + 1;
  for (const T of PTS) for (let i = 0; i <= PATH_N; i += 4) { const p = T.pos[i], q = (p.x - x) ** 2 + (p.z - z) ** 2; if (q < bq) { bq = q; bx = p.x; bz = p.z; } }
  return Math.atan2(bx - x, bz - z);
}
Towers.build = (tw) => {
  if (tw.group) for (const c of tw.group.children) { if (c.material) c.material.dispose(); if (c.customDepthMaterial) c.customDepthMaterial.dispose(); }
  const E = towerGeo(tw.type, tw.level);
  const U = newU();
  U.yp.value.fromArray(E.yawP);
  const g = new THREE.Group();
  for (const k in E.geos) {
    const txn = BUCKET_TX[k];
    const cloth = k === 'b';
    const m = rigMat(txn ? TXT[txn] : null, U, cloth ? { side: THREE.DoubleSide, roughness: 0.84 }
      : k === 'r' ? { roughness: 0.56 } : k === 's' ? { roughness: 0.93 } : k === 'c' ? { roughness: 0.92 } : { roughness: 0.88 });
    const mesh = new THREE.Mesh(E.geos[k], m);
    mesh.castShadow = !cloth; mesh.receiveShadow = true;
    if (!cloth && tier !== 'mobile') mesh.customDepthMaterial = rigDepth(U);
    mesh.name = 'TW_' + tw.type + '_' + k;
    g.add(mesh);
  }
  tw._u = U; tw._muz = E.muz; tw._fire = E.fire;
  tw._base = tw._base === undefined ? roadFacing(tw.x, tw.z) : tw._base;
  g.rotation.y = tw._base;
  if (tw.aim === undefined) { tw.aim = 0; tw.pitch = 0.12; }
  return g;
};
// ══ fire event (called from the SIM HOOK) ══════════════════════════════════════
// Deterministic: the muzzle offset comes from the tower level and the yaw straight to
// the target, never from the render-side smoothed aim.
// `hasProj` is false for hitscan weapons (the storm's chain lightning): they push nothing
// onto G.projectiles, so the "last projectile is mine" assumption below would otherwise
// grab some other tower's arrow and teleport it to this muzzle.
Towers.fire = (tw, tgt, hasProj = true) => {
  const t = G.vt();
  const yaw = Math.atan2(tgt.px - tw.x, tgt.pz - tw.z);
  tw.fireT = t; tw.aimYaw = yaw; tw.shots = (tw.shots || 0) + 1;
  const mz = tw._muz || [0.8, 4];
  const p = hasProj ? G.projectiles[G.projectiles.length - 1] : null;
  const mx = tw.x + Math.sin(yaw) * mz[0], mzz = tw.z + Math.cos(yaw) * mz[0], my = G.groundY(tw.x, tw.z) + mz[1];
  if (p) {
    p.x = mx; p.y = my; p.z = mzz;
    if (ARCK(p.kind)) { p.sx = mx; p.sy = my; p.sz = mzz; }
    // Render-only flight frame, stamped HERE rather than on first sight: the shot harness
    // ticks the whole sim before it ever renders, so a first-sight cache would see every
    // projectile already mid-flight and compute a travel fraction of zero.
    p.mx = mx; p.my = my; p.mz = mzz;
    if (p.kind !== 'boulder') {
      const ty = G.groundY(tgt.px, tgt.pz) + tgt.def.scale;
      const dx = tgt.px - mx, dy = ty - my, dz = tgt.pz - mzz;
      const d = Math.hypot(dx, dy, dz) || 1;
      p.ad0 = d; p.adx = dx / d; p.ady = dy / d; p.adz = dz / d;
    }
  }
  const ev = { tw, type: tw.type, x: mx, y: my, z: mzz, yaw, t, tgt };
  Towers.fireEvents.push(ev);
  if (Towers.fireEvents.length > 32) Towers.fireEvents.shift();
  if (Towers.onFire) Towers.onFire(tw, tgt, ev);
};

// ══ per-frame mechanism drive ══════════════════════════════════════════════════
const wrapPi = (a) => { while (a > Math.PI) a -= 6.283185307; while (a < -Math.PI) a += 6.283185307; return a; };
let _lastAt = 0;
function syncTowers(at) {
  const dt = clamp(at - _lastAt, 0, 0.25); _lastAt = at;
  for (const tw of G.towersList) {
    const U = tw._u; if (!U) continue;
    const def = TOWER_DEFS[tw.type];
    U.t.value = at;
    // ── aim: same target rule as SIM (furthest along the road, inside the band) so the
    // mechanism is always pointing where the next shot will actually go
    if (fights(def)) {
      const range = def.range * (1 + 0.08 * (tw.level - 1)), rq = range * range, minq = (def.minRange || 0) ** 2;
      let bd = -1, tx = 0, tz = 0;
      for (const e of G.enemies) {
        if (!e.alive) continue;
        const q = (e.px - tw.x) ** 2 + (e.pz - tw.z) ** 2;
        if (q <= rq && q >= minq && e.d > bd) { bd = e.d; tx = e.px; tz = e.pz; }
      }
      if (bd >= 0) {
        const want = wrapPi(Math.atan2(tx - tw.x, tz - tw.z) - tw._base);
        const d = Math.hypot(tx - tw.x, tz - tw.z);
        const dy = G.groundY(tx, tz) + 1.0 - (G.groundY(tw.x, tw.z) + tw._muz[1]);
        const wantP = clamp(Math.atan2(dy, Math.max(1, d)) + (tw.type === 'catapult' ? 0 : 0.10 + d * 0.008), -0.34, 0.40);
        const k = SHOT ? 1 : 1 - Math.exp(-dt * 5.5);
        tw.aim = wrapPi(tw.aim + wrapPi(want - tw.aim) * k);
        tw.pitch = lerp(tw.pitch, wantP, k);
      }
      U.y.value = tw.aim;
    }
    // ── fire cycle: everything derives from time-since-shot, so it is keyed to the
    // sim's real shots and stays deterministic in the shot harness
    const p = at - (tw.fireT === undefined ? -99 : tw.fireT);
    const cd = Math.max(0.4, def.cd);
    if (tw.type === 'archer') {
      const draw = sstep(0.10, cd * 0.62, p);
      U.p.value = draw; U.s.value = draw; U.l.value = sstep(0.06, 0.34, draw);
    } else if (tw.type === 'ballista') {
      const ck = sstep(0.16, cd * 0.60, p);            // 0 = just loosed, 1 = cocked
      U.s.value = ck; U.a.value = ck; U.l.value = sstep(0.78, 0.96, ck);
      U.p.value = tw.pitch - 0.05 * Math.exp(-p * 12); // muzzle flip on release
    } else if (tw.type === 'catapult') {
      const arm = p < 0.15 ? 1 - Math.pow(p / 0.15, 0.55) : sstep(0.19, cd * 0.82, p);
      U.p.value = arm; U.l.value = sstep(0.58, 0.94, arm);
    } else if (tw.type === 'storm') {
      // charge cycle: the shards collapse on discharge and swell back as it re-charges,
      // with a fast breath on top so an idle spire is never dead still
      const ch = sstep(0.05, cd * 0.72, p);
      U.l.value = 0.34 + 0.66 * ch + 0.04 * Math.sin(at * 5.3);
      U.a.value = at * 0.62;                           // armillary turns
    } else if (tw.type === 'pyre') {
      const arm = p < 0.16 ? 1 - Math.pow(p / 0.16, 0.5) : sstep(0.22, cd * 0.80, p);
      U.p.value = arm; U.l.value = sstep(0.52, 0.90, arm);
    } else {                                           // barracks / warbanner idle life
      U.a.value = Math.sin(at * 1.35) * 0.9 + Math.sin(at * 2.9) * 0.25;
    }
  }
}

// ══ projectiles: 3 pooled instanced meshes (shafts · boulders · additive streaks) ══
// Arcing kinds fly a fixed-time ballistic path the SIM integrates (boulder, fire pot);
// everything else chases its target id.
const ARCK = (k) => k === 'boulder' || k === 'pot';
const PROJ_CAP = 128;
let arrowMesh = null, rockMesh = null, streakMesh = null;
{
  // fletched arrow, authored along +y so an instance matrix can aim it at its velocity
  const ap = [];
  ap.push({ g: CY(0.036, 0.044, 1.35, 5), m: trs(0, 0, 0), tint: [0.52, 0.44, 0.26], jit: 0.16, mr: M_DULL });
  ap.push({ g: CN(0.082, 0.32, 4), m: trs(0, 0.79, 0), tint: [0.42, 0.44, 0.48], jit: 0.1, mr: M_STEEL });
  ap.push({ g: CY(0.050, 0.050, 0.10, 6), m: trs(0, 0.60, 0), tint: IRON, mr: M_IRON });
  for (let i = 0; i < 3; i++) ap.push({ g: B(0.006, 0.30, 0.135), m: trs(0, -0.50, 0, i * 2.094), tint: i ? [0.48, 0.44, 0.36] : [0.20, 0.18, 0.16], jit: 0.12, mr: M_CLOTH });
  ap.push({ g: CY(0.042, 0.042, 0.08, 5), m: trs(0, -0.69, 0), tint: LEATH, mr: M_DULL });
  const ag = tMerge(ap, 1);
  const amat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 });
  arrowMesh = new THREE.InstancedMesh(ag, amat, PROJ_CAP);
  // tumbling boulder
  const rg = facet(paint(new THREE.IcosahedronGeometry(0.52, 1), (c, x, y, z) => {
    const v = 0.70 + 0.55 * fbmz(x * 4.6 + 9, z * 4.6 + y * 3.1, 2);
    c.setRGB(ROCK[0] * v, ROCK[1] * v, ROCK[2] * v);
  }), 12.3, 0.24);
  rockMesh = new THREE.InstancedMesh(rg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 48);
  rg.scale(1.20, 1.20, 1.20);
  // motion streak
  const stx = (() => {
    const S = 128, [c, g2] = cnv(S);
    const gr = g2.createLinearGradient(0, 0, S, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.72, 'rgba(255,246,220,.55)'); gr.addColorStop(1, 'rgba(255,255,240,1)');
    g2.fillStyle = gr; g2.fillRect(0, 0, S, S);
    const vg = g2.createLinearGradient(0, 0, 0, S);
    vg.addColorStop(0, 'rgba(0,0,0,1)'); vg.addColorStop(0.5, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,1)');
    g2.globalCompositeOperation = 'destination-out'; g2.fillStyle = vg; g2.fillRect(0, 0, S, S);
    return tex(c);
  })();
  const sg = new THREE.PlaneGeometry(1, 1); sg.translate(-0.5, 0, 0);   // anchored at the head
  streakMesh = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial({ map: stx, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, color: 0xfff0c8 }), PROJ_CAP);
  for (const m of [arrowMesh, rockMesh, streakMesh]) { m.frustumCulled = false; m.count = 0; scene.add(m); }
  arrowMesh.castShadow = false; rockMesh.castShadow = true;
  arrowMesh.name = 'PROJ_SHAFT'; rockMesh.name = 'PROJ_ROCK'; streakMesh.name = 'PROJ_STREAK';
}
const _pv = new THREE.Vector3(), _pq = new THREE.Quaternion(), _ps = new THREE.Vector3(), _pm = new THREE.Matrix4();
const _pcol = new THREE.Color();
const _up3 = new THREE.Vector3(0, 1, 0), _ax3 = new THREE.Vector3(), _cf = new THREE.Vector3();
let _pid = 0;
const ARC_K = 0.052;                                   // ballistic sag as a fraction of range
function syncProj(at) {
  let ai = 0, ri = 0, si = 0;
  Towers.projRender.length = 0;
  for (const p of G.projectiles) {
    if (p._id === undefined) {
      p._id = ++_pid;
      if (p.mx === undefined) {                        // not stamped by Towers.fire: rebuild
        p.mx = p.x; p.my = p.y; p.mz = p.z;
        if (!ARCK(p.kind)) {
          const tgt = G.enemies.find(e => e.id === p.tid);
          const tx = tgt ? tgt.px : p.x, tz = tgt ? tgt.pz : p.z + 1;
          const ty = tgt ? G.groundY(tx, tz) + tgt.def.scale : p.y + 1;
          _pv.set(tx - p.x, ty - p.y, tz - p.z);
          p.ad0 = _pv.length() || 1; _pv.divideScalar(p.ad0);
          p.adx = _pv.x; p.ady = _pv.y; p.adz = _pv.z;
        }
      }
      if (ARCK(p.kind)) p.ad0 = Math.hypot(p.ex - p.mx, p.ez - p.mz) || 1;
    }
    if (ARCK(p.kind)) {
      if (ri >= 48) continue;
      const f = clamp(p.el / p.T, 0, 1);
      const pot = p.kind === 'pot';
      _ax3.set(0.42 + (p._id % 7) * 0.11, 0.9, 0.3 + (p._id % 5) * 0.16).normalize();
      _pq.setFromAxisAngle(_ax3, p.el * (pot ? 5.1 : 7.4) + p._id);
      const sc = (pot ? 0.46 : 0.86) + (p._id % 3) * (pot ? 0.03 : 0.12);
      _pm.compose(_pv.set(p.x, p.y, p.z), _pq, _ps.set(sc, sc, sc));
      rockMesh.setMatrixAt(ri, _pm);
      // the pot is fired clay, not granite: an instance colour keeps both in one draw call
      _pcol.setRGB(pot ? 0.62 : 1, pot ? 0.34 : 1, pot ? 0.22 : 1);
      rockMesh.setColorAt(ri++, _pcol);
      Towers.projRender.push({ p, kind: p.kind, x: p.x, y: p.y, z: p.z, f, r: 0.62 * sc,
        dx: (p.ex - p.mx) / p.T, dy: Math.cos(f * Math.PI) * 11 * Math.PI / p.T, dz: (p.ez - p.mz) / p.T });
      continue;
    }
    if (ai >= PROJ_CAP) continue;
    const trav = Math.hypot(p.x - p.mx, p.y - p.my, p.z - p.mz);
    const f = clamp(trav / p.ad0, 0, 1);
    const sag = Math.sin(f * Math.PI) * p.ad0 * ARC_K;
    const y = p.y + sag;
    _pv.set(p.adx, p.ady + Math.PI * ARC_K * Math.cos(f * Math.PI), p.adz).normalize();
    _pq.setFromUnitVectors(_up3, _pv);
    const bolt = p.kind === 'bolt', sc = bolt ? 2.35 : 1.15;
    _pm.compose(_ps.set(p.x, y, p.z), _pq, _cf.set(sc, bolt ? 1.55 : 1, sc));
    arrowMesh.setMatrixAt(ai++, _pm);
    // streak: a flat ribbon trailing the head, oriented in the plane facing the camera
    _ax3.crossVectors(_pv, _cf.subVectors(G.camera.position, _ps).normalize()).normalize();
    if (_ax3.lengthSq() < 0.1) _ax3.set(1, 0, 0);
    _cf.crossVectors(_ax3, _pv);
    const len = (bolt ? 5.6 : 3.8) * clamp(f * 6, 0.22, 1), wid = bolt ? 0.95 : 0.62;
    _pm.set(_pv.x * len, _ax3.x * wid, _cf.x, p.x + _pv.x * 0.5,
            _pv.y * len, _ax3.y * wid, _cf.y, y + _pv.y * 0.5,
            _pv.z * len, _ax3.z * wid, _cf.z, p.z + _pv.z * 0.5,
            0, 0, 0, 1);
    streakMesh.setMatrixAt(si++, _pm);
    Towers.projRender.push({ p, kind: p.kind, x: p.x, y, z: p.z, f, r: bolt ? 0.12 : 0.05,
      dx: _pv.x, dy: _pv.y, dz: _pv.z });
  }
  arrowMesh.count = ai; rockMesh.count = ri; streakMesh.count = si;
  arrowMesh.instanceMatrix.needsUpdate = true; rockMesh.instanceMatrix.needsUpdate = true; streakMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
}

// ══ shared brazier / coal glow — one additive instanced mesh for every tower ══
let glowMesh = null;
{
  const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.42, 0);
  glowMesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ map: flameTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, color: 0xffcf8a }), 32);
  glowMesh.frustumCulled = false; glowMesh.count = 0; glowMesh.renderOrder = 4; glowMesh.name = 'TW_GLOW';
  scene.add(glowMesh);
}
function syncGlow(at) {
  let gi = 0;
  for (const tw of G.towersList) {
    if (!tw._fire || !tw._fire.length) continue;
    const cy = Math.cos(tw._base), sy = Math.sin(tw._base), gy = tw.y === undefined ? G.groundY(tw.x, tw.z) : tw.y;
    for (const [lx, ly, lz, s] of tw._fire) {
      if (gi >= 32) break;
      const wx = tw.x + lx * cy + lz * sy, wz = tw.z - lx * sy + lz * cy;
      const ph = tw.uid * 2.7 + gi;
      const fl = 0.82 + 0.30 * Math.sin(at * 9.1 + ph) + 0.16 * Math.sin(at * 21.3 + ph * 2.1);
      _cf.subVectors(G.camera.position, _ps.set(wx, gy + ly, wz));
      _pm.compose(_ps, _pq.setFromEuler(new THREE.Euler(0, Math.atan2(_cf.x, _cf.z), 0)),
        _pv.set(1.15 * s * (0.92 + fl * 0.12), 1.75 * s * fl, 1));
      glowMesh.setMatrixAt(gi++, _pm);
    }
  }
  glowMesh.count = gi;
  glowMesh.instanceMatrix.needsUpdate = true;
}

// ══ storm chain lightning: one dynamic ribbon mesh for every arc in the air ════
// A bolt is a short-lived (60-90 ms) camera-facing ribbon jagged by a hash of its own
// seed, so the whole chain — tower→foe→foe→foe — costs ONE draw call and no allocation.
// SIM pushes arcs through Towers.zap(); nothing here reads rng().
const BOLT_MAX = 16, BOLT_SEG = 14, BOLT_V = (BOLT_SEG + 1) * 2;
const BOLTS = [];
let boltMesh = null;
function boltTex() {
  const S = 64, [c, g] = cnv(S);
  const gr = g.createLinearGradient(0, 0, 0, S);       // v runs across the ribbon
  gr.addColorStop(0, 'rgba(90,150,255,0)'); gr.addColorStop(0.30, 'rgba(130,190,255,.55)');
  gr.addColorStop(0.47, 'rgba(238,248,255,1)'); gr.addColorStop(0.53, 'rgba(238,248,255,1)');
  gr.addColorStop(0.70, 'rgba(130,190,255,.55)'); gr.addColorStop(1, 'rgba(90,150,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c);
}
{
  const pos = new Float32Array(BOLT_MAX * BOLT_V * 3), uv = new Float32Array(BOLT_MAX * BOLT_V * 2),
        col = new Float32Array(BOLT_MAX * BOLT_V * 3), idx = new Uint32Array(BOLT_MAX * BOLT_SEG * 6);
  let o = 0;
  for (let b = 0; b < BOLT_MAX; b++) for (let i = 0; i < BOLT_SEG; i++) {
    const A = b * BOLT_V + i * 2;
    idx[o++] = A; idx[o++] = A + 1; idx[o++] = A + 3; idx[o++] = A; idx[o++] = A + 3; idx[o++] = A + 2;
  }
  for (let b = 0; b < BOLT_MAX; b++) for (let i = 0; i <= BOLT_SEG; i++) {
    const k = (b * BOLT_V + i * 2) * 2;
    uv[k] = i / BOLT_SEG; uv[k + 1] = 0; uv[k + 2] = i / BOLT_SEG; uv[k + 3] = 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  g.setDrawRange(0, 0);
  boltMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: boltTex(), vertexColors: true,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  boltMesh.frustumCulled = false; boltMesh.renderOrder = 5; boltMesh.name = 'TW_BOLT';
  boltMesh.visible = false; scene.add(boltMesh);
}
// SIM contract: one call per HOP, from → to in world space. `seed` varies the jag.
Towers.zap = (x0, y0, z0, x1, y1, z1, seed) => {
  BOLTS.push({ x0, y0, z0, x1, y1, z1, t: G.vt(), life: 0.062 + 0.028 * ((seed * 7 + 3) % 4) / 3,
    s: (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0 });
  if (BOLTS.length > BOLT_MAX) BOLTS.shift();
};
const _bj = (s, i) => { let h = Math.imul(s ^ Math.imul(i + 1, 374761393), 1274126177); h ^= h >>> 15; return ((h >>> 0) / 4294967296) * 2 - 1; };
const _bw = new THREE.Vector3(), _bu = new THREE.Vector3(), _bd = new THREE.Vector3(), _bp = new THREE.Vector3();
function syncBolts(at) {
  const P = boltMesh.geometry.attributes.position.array, C = boltMesh.geometry.attributes.color.array;
  let n = 0;
  for (let i = BOLTS.length - 1; i >= 0; i--) if (at - BOLTS[i].t > BOLTS[i].life + 0.001) BOLTS.splice(i, 1);
  for (const b of BOLTS) {
    if (n >= BOLT_MAX) break;
    const f = clamp((at - b.t) / b.life, 0, 1);
    const bri = (1 - f * f) * 1.25;
    _bd.set(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
    const len = _bd.length() || 1; _bd.divideScalar(len);
    _bw.subVectors(G.camera.position, _bp.set(b.x0, b.y0, b.z0)).normalize();
    _bu.crossVectors(_bd, _bw); if (_bu.lengthSq() < 1e-4) _bu.set(1, 0, 0); _bu.normalize();
    _bw.crossVectors(_bu, _bd).normalize();
    const amp = clamp(len * 0.085, 0.14, 0.70), wid = 0.055 + 0.035 * (1 - f);
    for (let i = 0; i <= BOLT_SEG; i++) {
      const t = i / BOLT_SEG, taper = Math.sin(t * Math.PI);
      // two octaves of jag: the coarse one gives the bolt its path, the fine one the
      // splintered edge that stops it reading as a smooth painted ribbon
      const jx = (_bj(b.s, i) * 0.72 + _bj(b.s ^ 0x27d4eb2f, i * 3 + 1) * 0.28) * amp * taper;
      const jy = (_bj(b.s ^ 0x5bf03635, i) * 0.72 + _bj(b.s ^ 0x165667b1, i * 3 + 2) * 0.28) * amp * taper * 0.7;
      const px = b.x0 + _bd.x * len * t + _bu.x * jx + _bw.x * jy;
      const py = b.y0 + _bd.y * len * t + _bu.y * jx + _bw.y * jy;
      const pz = b.z0 + _bd.z * len * t + _bu.z * jx + _bw.z * jy;
      const w = wid * (0.55 + 0.75 * taper);
      const k = (n * BOLT_V + i * 2) * 3;
      P[k] = px + _bu.x * w; P[k + 1] = py + _bu.y * w; P[k + 2] = pz + _bu.z * w;
      P[k + 3] = px - _bu.x * w; P[k + 4] = py - _bu.y * w; P[k + 5] = pz - _bu.z * w;
      const eb = bri * (0.35 + 0.65 * taper);          // dimmer where it leaves and lands
      for (const kk of [k, k + 3]) { C[kk] = eb * 0.62; C[kk + 1] = eb * 0.92; C[kk + 2] = eb * 1.45; }
    }
    n++;
  }
  boltMesh.visible = n > 0;
  if (n) {
    boltMesh.geometry.setDrawRange(0, n * BOLT_SEG * 6);
    boltMesh.geometry.attributes.position.needsUpdate = true;
    boltMesh.geometry.attributes.color.needsUpdate = true;
  }
}

// ══ burning ground + fire-pot flames: one additive instanced quad mesh ═════════
// SIM owns the patch list (G.patches, deterministic); this only draws it. Up to two
// pooled point lights sit in the two liveliest fires so the meadow round them warms.
const FIRE_CAP = 96, PATCH_Q = 10;
let fireMesh = null;
const EMBL = [];
{
  const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.46, 0);
  fireMesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ map: flameTex(), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, color: 0xffb264 }), FIRE_CAP);
  fireMesh.frustumCulled = false; fireMesh.count = 0; fireMesh.visible = false;
  fireMesh.renderOrder = 4; fireMesh.name = 'TW_FIRE';
  scene.add(fireMesh);
  if (tier !== 'mobile') for (let i = 0; i < 2; i++) {   // created up-front: the light count is
    const l = new THREE.PointLight(0xff8c34, 0, 17, 2);  // baked into every shader program, so
    l.name = 'EMBER_L' + i; scene.add(l); EMBL.push(l);  // adding them later would recompile all
  }
}
const _fe = new THREE.Euler();
function fireQuad(n, wx, wy, wz, w, h) {
  _cf.subVectors(G.camera.position, _ps.set(wx, wy, wz));
  _pm.compose(_ps, _pq.setFromEuler(_fe.set(0, Math.atan2(_cf.x, _cf.z), 0)), _pv.set(w, h, 1));
  fireMesh.setMatrixAt(n, _pm);
}
function syncFire(at) {
  let n = 0, li = 0;
  const P = G.patches || [];
  for (let i = 0; i < P.length; i++) {
    const pa = P[i];
    const f = clamp((at - pa.born) / pa.dur, 0, 1);
    const env = sstep(0, 0.22, f) * (1 - sstep(0.74, 1, f));
    const gy = G.groundY(pa.x, pa.z);
    // MANY SMALL tongues spread over the whole patch, not a few big ones: overlapping
    // additive quads saturate to a white blob under ACES, which is what the first pass of
    // this effect looked like. The scorch decal underneath carries the "burnt" read.
    for (let k = 0; k < PATCH_Q && n < FIRE_CAP; k++) {
      const a = k * 2.3999 + i * 1.13;                  // golden-angle scatter, no clumping
      const rr = pa.r * 0.88 * Math.sqrt(((k * 7 + i * 5) % 11) / 11);
      const wx = pa.x + Math.cos(a) * rr, wz = pa.z + Math.sin(a) * rr;
      const ph = i * 3.1 + k * 1.77;
      const fl = 0.68 + 0.32 * Math.sin(at * 8.3 + ph) + 0.16 * Math.sin(at * 19.1 + ph * 2.3);
      const s = (0.62 + 0.34 * ((k * 5) % 3)) * env * (1 - rr / pa.r * 0.35);
      fireQuad(n++, wx, G.groundY(wx, wz) - 0.04, wz, s * (0.90 + fl * 0.18), s * 1.55 * fl);
    }
    if (li < EMBL.length && env > 0.15) {
      const l = EMBL[li++];
      l.position.set(pa.x, gy + 0.9, pa.z);
      l.intensity = 26 * env * (0.82 + 0.24 * Math.sin(at * 7.7 + i));
    }
  }
  for (const q of Towers.projRender) {                 // the pot itself is a ball of fire
    if (q.kind !== 'pot' || n >= FIRE_CAP) continue;
    const fl = 0.85 + 0.3 * Math.sin(at * 17 + q.p._id);
    fireQuad(n++, q.x, q.y - 0.30, q.z, 0.78 * fl, 1.15 * fl);
    fireQuad(n++, q.x, q.y - 0.12, q.z, 0.44, 0.70 * fl);
  }
  for (let i = li; i < EMBL.length; i++) EMBL[i].intensity = 0;
  fireMesh.count = n; fireMesh.visible = n > 0;
  fireMesh.instanceMatrix.needsUpdate = true;
}

// ══ selection + placement UX: range ring, tower highlight, build ghost ══════════
function ringTex() {
  const S = 256, [c, g] = cnv(S);                      // u = angle, v = radius
  g.clearRect(0, 0, S, S);
  const band = (v0, v1, style) => { g.fillStyle = style; g.fillRect(0, S - v1 * S, S, (v1 - v0) * S); };
  const gr = g.createLinearGradient(0, S, 0, 0);       // soft inner wash
  gr.addColorStop(0, 'rgba(232,200,140,0)'); gr.addColorStop(0.72, 'rgba(236,206,150,.045)');
  gr.addColorStop(0.93, 'rgba(250,228,176,.16)'); gr.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  band(0.902, 0.930, 'rgba(255,226,150,.26)');
  band(0.938, 0.956, 'rgba(255,236,182,.95)');         // the crisp hairline
  band(0.956, 0.974, 'rgba(206,158,74,.40)');
  for (let i = 0; i < 48; i++) {                       // survey ticks
    const x = i * S / 48;
    g.fillStyle = i % 4 === 0 ? 'rgba(255,230,164,.85)' : 'rgba(255,224,158,.32)';
    g.fillRect(x, S - 0.936 * S, 2, (i % 4 === 0 ? 0.046 : 0.022) * S);
  }
  const t = tex(c); t.wrapS = THREE.RepeatWrapping; return t;
}
function markTex() {
  const S = 256, [c, g] = cnv(S);
  g.clearRect(0, 0, S, S);
  // NO broad glow: an additive wash over the meadow just fogs it. This is a crisp gilt
  // bracket frame that reads on bright dirt and on dark grass alike.
  const M = 14, Lc = 74;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const cx = S / 2 - sx * (S / 2 - M), cy = S / 2 - sy * (S / 2 - M);
    for (const [w, col] of [[14, 'rgba(22,12,3,.78)'], [9, '#b07f24'], [6, '#f0b63a'], [1.6, '#fff2c8']]) {
      g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'butt';
      g.beginPath(); g.moveTo(cx, cy + sy * Lc); g.lineTo(cx, cy); g.lineTo(cx + sx * Lc, cy); g.stroke();
    }
    g.fillStyle = '#f7cf6a';
    g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill();
  }
  for (const [w, col] of [[8, 'rgba(24,14,4,.55)'], [3.5, 'rgba(255,222,150,.85)']]) {  // gilt lozenge
    g.strokeStyle = col; g.lineWidth = w;
    g.beginPath(); g.moveTo(S / 2, M + 40); g.lineTo(S - M - 40, S / 2); g.lineTo(S / 2, S - M - 40); g.lineTo(M + 40, S / 2); g.closePath(); g.stroke();
  }
  return tex(c);
}
// Footprint plate for placement mode: a surveyor's disc the size of a tower base, so the
// player sees exactly how much ground a build claims BEFORE paying. Drawn white; the
// material tints it green (buildable) or red (refused).
function footTex() {
  const S = 256, [c, g] = cnv(S), R = S * 0.5;
  g.clearRect(0, 0, S, S);
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, R);
  rg.addColorStop(0, 'rgba(255,255,255,.40)'); rg.addColorStop(0.70, 'rgba(255,255,255,.30)');
  rg.addColorStop(0.885, 'rgba(255,255,255,.60)'); rg.addColorStop(0.90, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.beginPath(); g.arc(S / 2, S / 2, R * 0.90, 0, 7); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 13;
  g.beginPath(); g.arc(S / 2, S / 2, R * 0.855, 0, 7); g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 7;
  g.beginPath(); g.arc(S / 2, S / 2, R * 0.855, 0, 7); g.stroke();
  for (let i = 0; i < 24; i++) {                       // survey ticks around the rim
    const an = i / 24 * 6.283185, L = i % 6 === 0 ? 0.14 : 0.07;
    g.strokeStyle = i % 6 === 0 ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.48)';
    g.lineWidth = i % 6 === 0 ? 9 : 5;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(an) * R * 0.855, S / 2 + Math.sin(an) * R * 0.855);
    g.lineTo(S / 2 + Math.cos(an) * R * (0.855 - L), S / 2 + Math.sin(an) * R * (0.855 - L));
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 5;                    // centre cross
  g.beginPath(); g.moveTo(S / 2 - 24, S / 2); g.lineTo(S / 2 + 24, S / 2);
  g.moveTo(S / 2, S / 2 - 24); g.lineTo(S / 2, S / 2 + 24); g.stroke();
  return tex(c);
}
const SEL = { ring: null, mark: null, foot: null, ghost: null, key: '', pkey: '' };
{
  const RS = 128, RR = 10;                             // 128 arcs × 10 radial rings
  const pos = new Float32Array((RS + 1) * RR * 3), uv = new Float32Array((RS + 1) * RR * 2);
  const idx = new Uint32Array(RS * (RR - 1) * 6);
  const VR = [0, 0.55, 0.78, 0.885, 0.925, 0.945, 0.958, 0.975, 0.992, 1.0];
  let o = 0;
  for (let i = 0; i <= RS; i++) for (let r = 0; r < RR; r++) {
    const k = i * RR + r; uv[k * 2] = i / RS * 6; uv[k * 2 + 1] = VR[r];
    if (i < RS && r < RR - 1) { const A = i * RR + r, Bb = A + 1, C = A + RR, D = C + 1; idx[o++] = A; idx[o++] = Bb; idx[o++] = D; idx[o++] = A; idx[o++] = D; idx[o++] = C; }
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  rg.setIndex(new THREE.BufferAttribute(idx, 1));
  rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  SEL.ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ map: ringTex(), transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  SEL.ring.renderOrder = 3; SEL.ring.visible = false; SEL.ring.frustumCulled = false; SEL.ring.name = 'SEL_RING';
  SEL._VR = VR; SEL._RS = RS; SEL._RR = RR;
  // decals are subdivided grids, not quads: a flat plane pokes under the meadow's own
  // relief and the corner brackets vanish into the ground
  const MG = 12;
  const decal = (map) => {
    const mg = new THREE.PlaneGeometry(1, 1, MG, MG); mg.rotateX(-Math.PI / 2);
    mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const m = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    m.renderOrder = 3; m.visible = false; m.frustumCulled = false;
    return m;
  };
  SEL.markG = MG;
  SEL.mark = decal(markTex()); SEL.mark.name = 'SEL_MARK';
  SEL.foot = decal(footTex()); SEL.foot.name = 'SEL_FOOT';
  scene.add(SEL.ring, SEL.mark, SEL.foot);
}
// drape a decal grid over the heightfield
function gridShape(mesh, cx, cz, half, lift) {
  const P = mesh.geometry.attributes.position.array, N = SEL.markG + 1;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = (j * N + i) * 3, x = cx + (i / (N - 1) - 0.5) * half * 2, z = cz + (j / (N - 1) - 0.5) * half * 2;
    P[k] = x; P[k + 1] = G.groundY(x, z) + lift; P[k + 2] = z;
  }
  mesh.geometry.attributes.position.needsUpdate = true;
}
function ringShape(cx, cz, rad) {
  const P = SEL.ring.geometry.attributes.position.array, { _VR: VR, _RS: RS, _RR: RR } = SEL;
  for (let i = 0; i <= RS; i++) {
    const a = i / RS * 6.283185307, ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 0; r < RR; r++) {
      const rr = rad * VR[r] * 1.0, x = cx + ca * rr, z = cz + sa * rr, k = (i * RR + r) * 3;
      P[k] = x; P[k + 1] = G.groundY(x, z) + 0.17; P[k + 2] = z;
    }
  }
  SEL.ring.geometry.attributes.position.needsUpdate = true;
}
// ── build ghosts: one cached translucent copy per tower type. Towers.build() mints its
// own material set per tower, so overriding transparency here can never leak into a real
// fortification. Ghosts are static (no uniforms driven), cast no shadow, and only draw
// while placement mode is live.
const GHOSTS = new Map();
function ghostFor(type) {
  let g = GHOSTS.get(type);
  if (!g) {
    g = Towers.build({ type, level: 1, x: 0, z: 0 });
    for (const c of g.children) {
      c.castShadow = false; c.receiveShadow = false; c.customDepthMaterial = undefined;
      c.material.transparent = true; c.material.opacity = 0.84;
      // depthWrite STAYS ON. A translucent object with depth writes off sorts against
      // itself into mush AND loses to the footprint plate (renderOrder 3), which painted
      // straight over the ghost's base — the preview read as an empty disc with a smear
      // in it. Writing depth keeps the silhouette coherent and lets the plate's fragments
      // fail the depth test where the tower stands on it.
      c.material.depthWrite = true;
      c.renderOrder = 2;
      c.userData._c0 = c.material.color.clone();   // base albedo tint, so the validity
      c.material.color = c.material.color.clone();  // wash MULTIPLIES instead of erasing it
    }
    g.visible = false; scene.add(g); GHOSTS.set(type, g);
  }
  return g;
}
// Plate/ring wash. The refusal colour is ROSE, not red: the ring blends additively over a
// green meadow, and additive red there resolves to exactly the brown of the dirt road — the
// "you cannot build here" ring read as a second road. Magenta has no counterpart in the
// palette, so it can only be read as UI.
const C_OK = [0.52, 1.00, 0.58], C_NO = [1.00, 0.26, 0.52];
// support aura (warbanner): heraldic blue, kept pale so it still reads additively on grass
// (the ring art is warm gold, so the tint has to be pushed hard to read as blue at all)
const C_AURA = [0.26, 0.60, 1.65];
// Ghost wash (multiplied onto each part's own albedo, so timber stays timber).
const T_OK = [0.86, 1.12, 0.94], T_NO = [1.30, 0.44, 0.52];
// Placement mode read-out (state lives in SIM's G.place): footprint plate + range ring +
// ghost tower, tinted by validity. The RANGE IS ALWAYS VISIBLE BEFORE GOLD IS SPENT.
function syncPlace(p, at) {
  SEL.mark.visible = false; SEL.key = '';
  const def = TOWER_DEFS[p.type], rad = def.range;
  const key = p.type + '|' + p.ok + '|' + p.x.toFixed(2) + '|' + p.z.toFixed(2);
  if (key !== SEL.pkey) {
    SEL.pkey = key;
    const c = p.ok ? C_OK : C_NO;
    if (rad > 0) ringShape(p.x, p.z, rad);
    gridShape(SEL.foot, p.x, p.z, 2.35, 0.12);
    SEL.ring.material.color.setRGB(c[0], c[1], c[2]);
    SEL.foot.material.color.setRGB(c[0], c[1], c[2]);
    const gh = ghostFor(p.type);
    if (SEL.ghost && SEL.ghost !== gh) SEL.ghost.visible = false;
    SEL.ghost = gh;
    gh.position.set(p.x, G.padY(p.x, p.z), p.z);
    gh.rotation.y = roadFacing(p.x, p.z);
    // a cool cast on a valid ghost, a rose one on a refused ghost: even with the plate
    // hidden behind foliage the preview still reads as 'not built yet'
    const t = p.ok ? T_OK : T_NO;
    for (const ch of gh.children) {
      const b = ch.userData._c0;
      ch.material.color.setRGB(clamp(b.r * t[0], 0, 1), clamp(b.g * t[1], 0, 1), clamp(b.b * t[2], 0, 1));
    }
    gh.visible = true;
  }
  const pu = 0.72 + 0.28 * Math.sin(at * 3.4);
  SEL.foot.material.opacity = 0.60 + 0.40 * pu;
  SEL.ring.material.opacity = (p.ok ? 0.60 : 0.42) + 0.24 * pu;
  SEL.ring.material.map.offset.x = at * 0.02;
  SEL.ring.visible = rad > 0; SEL.foot.visible = true;
}
function syncSel(at) {
  if (G.place) return syncPlace(G.place, at);
  if (SEL.pkey) {                                      // just left placement mode
    SEL.pkey = ''; SEL.foot.visible = false;
    SEL.ring.material.color.setRGB(1, 1, 1); SEL.foot.material.color.setRGB(1, 1, 1);
    if (SEL.ghost) { SEL.ghost.visible = false; SEL.ghost = null; }
  }
  const si = G.state.selTower, tw = si >= 0 ? G.towersList[si] : null;
  if (!tw) { SEL.ring.visible = false; SEL.mark.visible = false; SEL.key = ''; return; }
  const key = si + '|' + tw.type + tw.level;
  if (key !== SEL.key) {
    SEL.key = key;
    const def = TOWER_DEFS[tw.type];
    const rad = def.range * (1 + 0.08 * (tw.level - 1));
    // a warbanner's ring is its AURA, not its reach: a cool heraldic blue separates
    // "everything in here fires faster" from "this is what I can shoot"
    const c = def.aura ? C_AURA : null;
    SEL.ring.material.color.setRGB(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    if (rad > 0) { ringShape(tw.x, tw.z, rad); SEL.ring.visible = true; } else SEL.ring.visible = false;
    gridShape(SEL.mark, tw.x, tw.z, 3.35, 0.13);
    SEL.mark.visible = true;
  }
  const pu = 0.72 + 0.28 * Math.sin(at * 2.6);
  SEL.mark.material.opacity = 0.70 + 0.30 * pu;
  SEL.ring.material.opacity = 0.55 + 0.24 * pu;
  SEL.ring.material.map.offset.x = at * 0.012;
}

// ══ MAIN's per-frame entry point (contract name preserved) ══════════════════════
Towers.syncProjectiles = (vtNow) => {
  const at = vtNow + (G.subT || 0) * TICK;
  syncTowers(at);
  syncProj(at);
  syncGlow(at);
  syncBolts(at);
  syncFire(at);
  syncSel(at);
};
// ══════════════════════ END SECTION: TOWERS ══════════════════════

// ══════════════════════ SECTION: SIM (owner: architect; TOWERS/ARMIES builders may tune constants) ══
// ARMIES pass: unit counts tripled and per-unit HP/bounty/dps scaled down to match, so a
// wave reads as the reference's dense crimson river on the road instead of a trickle of
// individuals. Total wave HP only rises ~1.5x, so tower balance is broadly preserved.
// `resist` (SPEC3 §A) replaces SPEC2's flat `armor`: a vector over the four schools
// (pierce · crush · fire · storm), fraction of that school's damage shrugged off. Negative
// is VULNERABLE — it takes extra. Immunity is capped at 0.85 in dealDamage(), so a resist
// only ever makes a school INEFFICIENT, never useless. Migration: the old armour value is
// now resist.pierce, and siege's old "half armour" is authored as its own crush profile.
// SPEC2 §D roster of 8. `scale` is ONLY the height projectiles aim at; the model's real
// height lives in ARMIES' CFG. `range`/`melee` make a skirmisher (halts and shoots knights,
// fights badly when caught); `stomp` makes a mini-boss (area blow on a timer while held).
const ENEMY_DEFS = {
  // Balance pass r2: bounty 2 on the chaff pair funds an honest opening (110g start could
  // never out-earn the horde at 1g/kill); boss-line hp cut so a solid final build can
  // actually fell them before the gate now that mode:'strong' towers focus them.
  grunt:   { hp: 12,   speed: 2.0,  bounty: 2,   dps: 1.5, leak: 1,  scale: 1,    resist: {} },
  runner:  { hp: 9,    speed: 3.4,  bounty: 2,   dps: 1.2, leak: 1,  scale: 0.82, resist: {} },
  // the pavise wall is the ANTI-ARROW unit and always was — but a shield held against
  // arrows is a bad answer to a boulder, so crush now goes THROUGH it (SPEC3 §A).
  shield:  { hp: 55,   speed: 1.7,  bounty: 6,   dps: 4,   leak: 1,  scale: 1.10, resist: { pierce: 0.7, crush: -0.2 } },
  hound:   { hp: 7,    speed: 4.6,  bounty: 1,   dps: 2,   leak: 1,  scale: 0.55, resist: {} },
  marauder:{ hp: 26,   speed: 2.2,  bounty: 4,   dps: 5,   leak: 1,  scale: 0.98, resist: {}, range: 7, melee: 3 },
  brute:   { hp: 150,  speed: 1.15, bounty: 9,   dps: 5,   leak: 2,  scale: 1.55, resist: {} },
  ogre:    { hp: 860,  speed: 0.9,  bounty: 40,  dps: 25,  leak: 3,  scale: 2.0,  elite: true,
             resist: { pierce: 0.25, fire: -0.2 },
             stomp: { cd: 5, dmg: 30, rad: 2.5 } },
  // bosses keep their old armour as pierce and gain storm .2, so no single school melts a
  // finale on its own — the answer to a boss is a COMPOSITION.
  // ══ SPEC3 §B — five newcomers. Every one of them is a QUESTION about composition:
  // ironclad is a wall crush and fire walk through, ashwraith burns for nothing and must
  // be met with storm or mass pierce, frostrevenant shrugs arrows off, warshaman turns
  // every other unit on the road into a longer fight until he is picked out of it, and the
  // ram is a crush-proof battering machine no barracks can stand in front of.
  // `elite` = mini-boss: its health bar is up the whole time it is on the road.
  ironclad:{ hp: 380,  speed: 1.0,  bounty: 18,  dps: 9,   leak: 2,  scale: 1.35, elite: true,
             resist: { storm: 0.85, pierce: 0.5, crush: -0.25 } },
  ashwraith:{hp: 60,   speed: 3.0,  bounty: 6,   dps: 3,   leak: 1,  scale: 1.15,
             resist: { fire: 0.85, pierce: 0.25, storm: -0.25 } },
  frostrevenant:{hp:90,speed: 1.5,  bounty: 8,   dps: 6,   leak: 1,  scale: 1.10,
             resist: { pierce: 0.6, fire: 0.3, storm: -0.3 } },
  // heal: r = radius, pct = fraction of the ALLY's own max hit points per second, cap =
  // the hard ceiling in hit points per second, so a shaman can nurse a levy back up but
  // barely tickles a boss. He heals; he never damages anything but a knight he is caught by.
  warshaman:{hp: 45,   speed: 1.8,  bounty: 10,  dps: 2,   leak: 1,  scale: 1.00, resist: {},
             heal: { r: 8, pct: 0.03, cap: 6 } },
  ram:     { hp: 1400, speed: 0.6,  bounty: 60,  dps: 14,  leak: 6,  scale: 1.60, elite: true,
             unblockable: true, resist: { crush: 0.8, pierce: -0.3, storm: 0.3 } },
  boss:    { hp: 2400, speed: 0.75, bounty: 200, dps: 30,  leak: 20, scale: 2.6,  resist: { pierce: 0.22, storm: 0.2 }, unblockable: true },
  // ── map finales (SPEC2 §E): palette + scale swaps of the boss ARCHETYPE. `art` points
  // at the mesh they borrow, so a variant costs no extra InstancedMesh and no extra draw
  // call; `tint` multiplies the per-instance colour and `mscale` the model matrix.
  // `art_kit` names a swappable SILHOUETTE ATTACHMENT SET (ARMIES' KIT meshes): crown,
  // banners, brazier, blades. A tint and a scale alone made every map's climax the same
  // man in the same armour — a recolour, not a boss. The kit rides the boss's own instance
  // matrix and animation, so a variant costs one InstancedMesh that only draws on the map
  // that fields it, not a second rig.
  // mscale is a SILHOUETTE number, not a balance one: cinderqueen shipped at 0.88, which
  // made a map finale physically smaller than the base boss and barely bigger than a
  // wave-9 ogre. The hierarchy now only ever goes up from `boss`.
  matriarch:  { hp: 2600, speed: 0.70, bounty: 260, dps: 34, leak: 20, scale: 2.8, resist: { pierce: 0.26, storm: 0.2 }, unblockable: true,
                art: 'boss', art_kit: 'matriarch', tint: [1.38, 0.74, 0.98], mscale: 1.12 },
  emberlord:  { hp: 1950, speed: 0.80, bounty: 220, dps: 32, leak: 16, scale: 2.6, resist: { pierce: 0.24, storm: 0.2 }, unblockable: true,
                art: 'boss', art_kit: 'emberlord', tint: [1.50, 0.66, 0.34], mscale: 1.08 },
  cinderqueen:{ hp: 1500, speed: 0.95, bounty: 190, dps: 26, leak: 14, scale: 2.3, resist: { pierce: 0.18, storm: 0.2 }, unblockable: true,
                art: 'boss', art_kit: 'cinderqueen', tint: [1.22, 0.52, 0.86], mscale: 1.06 },
};
// The four schools, in the order every read-out lists them.
const SCHOOLS = ['pierce', 'crush', 'fire', 'storm'];
G.SCHOOLS = SCHOOLS;
const resistOf = (def, el) => (def.resist ? (def.resist[el] || 0) : 0);
G.resistOf = resistOf;
const WAVE_TABLES = { 1: [ // [type, count, interval s, delay s] groups
  // r2 reshape: waves 1-4 sized so an HONEST purse (140g start, bounty-funded) can hold
  // with 2 archers → 4-5 towers; the marketing-frame hordes stay in W5+ where a real
  // defense exists to fight them.
  [['grunt', 30, 0.75, 0]],
  [['grunt', 50, 0.55, 0]],
  [['grunt', 85, 0.40, 0], ['runner', 40, 0.30, 12]],
  [['grunt', 105, 0.32, 0], ['runner', 55, 0.24, 8]],
  // r4: the Vale's back half now fields the full bestiary — shieldbearer walls bleed a
  // pure-physical battery, hounds race slow lines, marauders harry the knights, and two
  // ogres headline wave 9. Without them any phys deathball swept the map untouched.
  [['brute', 8, 1.40, 0], ['grunt', 85, 0.32, 2], ['hound', 14, 0.25, 10]],
  [['runner', 100, 0.18, 0], ['shield', 8, 1.30, 4], ['grunt', 70, 0.30, 8]],
  // SPEC3 §B fixed mini-boss slots. Every one of these is a SWAP-IN, not an addition: the
  // head count it costs is taken straight back out of the chaff group beside it, so the
  // Vale's wave sizes stay within a few units of the r6 balance pass. W7 teaches the
  // priority kill (shamans healing the brute line), W8 the ironclad wall, W9 the ram.
  [['brute', 16, 0.85, 0], ['marauder', 10, 0.90, 5], ['warshaman', 4, 2.60, 8], ['grunt', 96, 0.27, 3]],
  [['runner', 100, 0.18, 0], ['shield', 16, 0.85, 6], ['brute', 8, 1.00, 10], ['ironclad', 4, 2.40, 12], ['grunt', 85, 0.27, 2]],
  [['grunt', 132, 0.21, 0], ['ogre', 3, 4.50, 6], ['ram', 1, 0, 14], ['brute', 16, 0.85, 12], ['runner', 60, 0.20, 16]],
  [['boss', 1, 0, 10], ['grunt', 150, 0.22, 0], ['shield', 20, 0.80, 5], ['brute', 16, 0.85, 3]],
] ,
  // ══ 2. FROSTFELL PASS — 12 waves. The map's own idea is TIMING: two gates means two
  // arrival clocks, and a group tagged with a gate index (the 5th field) comes out of that
  // gate alone. Hound packs and shieldbearer walls are the featured pressure — the hounds
  // punish a slow single-target line, the pavises punish a purely physical one.
  2: [
    // waves 1-2 come out of the NORTH gate alone: a two-gate map that opens both mouths on
    // wave 1 gives a first-time player no chance to learn where the roads run.
    // r2: a two-gate wave is worth ~1.3x its head count (half of it bypasses any single
    // battery), so Frostfell runs ~15% lighter than the Vale at the same wave number.
    [['grunt', 28, 0.80, 0, 0]],
    [['grunt', 46, 0.55, 0, 0], ['hound', 8, 0.40, 12, 1]],
    [['hound', 20, 0.26, 0, 1], ['grunt', 56, 0.44, 3, 0]],
    [['shield', 8, 1.20, 0, 0], ['grunt', 64, 0.40, 2]],
    // SPEC3 §B: the frost revenants are Frostfell's own dead and walk their home map from
    // W5 — an arrow battery that swept the first four waves meets a wall of pierce .6 here.
    // W6 the shamans, W7 the ram, W9 the ironclad column: two mini-boss species mid-run,
    // every one of them paid for out of the group it marches beside.
    [['runner', 59, 0.25, 0], ['frostrevenant', 5, 2.20, 5], ['hound', 20, 0.22, 12, 1]],
    // NO fixed shaman here. Three chanters behind a fourteen-strong pavise wall put nine
    // lives on the floor at wave 6 in the bot matrix — a healer is a MULTIPLIER, and it
    // multiplies hardest against exactly the unit Frostfell already leans on. The shaman
    // still reaches this map through the wave-10 swap slot, where the purse can answer him.
    [['shield', 14, 0.95, 0, 0], ['grunt', 70, 0.36, 2], ['marauder', 8, 1.05, 9, 1]],
    [['hound', 26, 0.17, 0, 0], ['hound', 18, 0.17, 5, 1], ['ram', 1, 0, 9, 0], ['runner', 54, 0.21, 8]],
    [['brute', 11, 1.05, 0], ['shield', 20, 0.78, 4, 1], ['grunt', 90, 0.29, 2]],
    [['marauder', 18, 0.60, 0], ['ironclad', 3, 3.20, 6, 0], ['hound', 46, 0.15, 8, 0], ['grunt', 76, 0.31, 3]],
    [['ogre', 3, 3.00, 0, 0], ['shield', 30, 0.60, 3, 1], ['runner', 96, 0.17, 6]],
    [['brute', 18, 0.80, 0], ['hound', 74, 0.11, 5, 1], ['grunt', 112, 0.25, 2], ['marauder', 19, 0.62, 13]],
    [['matriarch', 1, 0, 13, 0], ['shield', 32, 0.52, 0, 1], ['hound', 54, 0.13, 6, 0],
     ['grunt', 102, 0.25, 2], ['ogre', 2, 4.00, 20, 1]],
  ],
  // ══ 3. EMBER WASTES — 14 waves. Marauders and ogres are the featured pressure: the
  // skirmishers make a barracks a liability and the ogres make one a corpse, so the wastes
  // are the map that has to be answered with towers over the road. Finale is a double boss.
  3: [
    // r2: 14 waves is a marathon — the front half runs lighter so the purse can build the
    // battery the back half demands; marauders enter at W3 in single digits only.
    [['grunt', 30, 0.75, 0]],
    [['grunt', 52, 0.55, 0]],
    [['marauder', 6, 1.20, 0], ['grunt', 62, 0.44, 3]],
    [['runner', 62, 0.26, 0], ['grunt', 54, 0.40, 5]],
    [['marauder', 14, 0.75, 0], ['shield', 8, 1.30, 7], ['grunt', 64, 0.38, 2]],
    // SPEC3 §B: ash wraiths are the wastes' own — a pyre wall, the obvious answer to this
    // map, does almost nothing to them (fire .85), which is the lesson W6 exists to teach.
    // W8 fields the ironclads, W10 the ram. Head counts unchanged to within 3%.
    [['ogre', 2, 4.00, 0], ['grunt', 80, 0.35, 2], ['ashwraith', 12, 0.55, 8], ['runner', 36, 0.24, 11]],
    [['marauder', 22, 0.55, 0], ['hound', 32, 0.19, 9], ['grunt', 72, 0.33, 3]],
    [['brute', 8, 1.00, 0], ['ironclad', 4, 2.40, 3], ['shield', 15, 0.90, 4], ['grunt', 82, 0.30, 2]],
    [['ogre', 4, 3.20, 0], ['marauder', 22, 0.58, 5], ['runner', 76, 0.20, 9]],
    [['hound', 58, 0.13, 0], ['marauder', 25, 0.52, 7], ['ram', 1, 0, 12], ['grunt', 86, 0.28, 3]],
    [['brute', 15, 0.88, 0], ['shield', 20, 0.76, 5], ['marauder', 18, 0.58, 11], ['grunt', 80, 0.30, 2]],
    [['ogre', 4, 3.20, 0], ['runner', 86, 0.19, 6], ['hound', 46, 0.15, 11], ['grunt', 80, 0.30, 2]],
    [['marauder', 30, 0.48, 0], ['brute', 16, 0.85, 6], ['shield', 23, 0.70, 11], ['grunt', 94, 0.28, 2]],
    // The twins duel you IN SEQUENCE (10s / 34s): simultaneous arrival made both leak —
    // tough-preferring towers split fire and neither died. Staggered, each is a real duel.
    [['emberlord', 1, 0, 10], ['cinderqueen', 1, 0, 34], ['ogre', 3, 4.20, 4],
     ['marauder', 22, 0.54, 0], ['shield', 16, 0.90, 9], ['grunt', 92, 0.28, 2]],
  ],
};
// The wave list belongs to the ACTIVE map (CORE's MAPS table owns everything else about
// it). Later maps add their own table here and hang it off MAP.waves.
MAP.waves = MAP.waves || WAVE_TABLES[MAP.id] || WAVE_TABLES[1];
const WAVES = MAP.waves;
G.WAVES = WAVES;
const INTERWAVE = MAP.interwave;
// lives raised with the horde-scale rebalance: at ~150 units per wave, 20 lives meant a 6%
// leak rate was an instant loss.
// selTower indexes G.towersList (-1 = nothing selected). There are no plots to select
// any more: empty ground is selected by ENTERING PLACEMENT MODE, not by tapping a marker.
// `muster` (SPEC3 §C) is the number of towers the vale can field at once — the anti-
// deathball bound. `omen` is the war omen riding the CURRENT wave ('' = none).
const state = { phase: 'title', gold: 140, lives: 32, wave: 0, tick: 0, speed: 1, paused: false,
  countdown: 0, kills: 0, selTower: -1, leaked: 0, invested: 0, muster: 6, omen: '' };
G.state = state;
// ══ MUSTER (SPEC3 §C) ════════════════════════════════════════════════
// Six standards to start; each further slot is bought, and the price climbs steeply, so a
// wide line costs real board presence. Fourteen is the ceiling — past that the map is a
// carpet again and the comp stops being a choice.
const MUSTER_COST = [120, 170, 230, 300, 380, 470, 570, 680];
const musterCost = () => MUSTER_COST[state.muster - 6];   // undefined at the cap
G.musterCost = musterCost;
function raiseMuster(free = false) {
  const c = musterCost();
  if (c === undefined) return false;
  if (!free) { if (state.gold < c) { Audio.play('ui'); return false; } state.gold -= c; state.invested += c; }
  state.muster++;
  UI.sync(); Audio.play('banner');
  return true;
}
G.raiseMuster = raiseMuster;
G.enemies = []; G.knights = []; G.towersList = []; G.projectiles = [];
G.patches = [];                      // burning ground (pyre) — sim-owned, TOWERS draws it
G.obstacles = G.obstacles || [];
let eid = 0, twid = 0;

// ══ FREE PLACEMENT (SPEC2 §A) ════════════════════════════════════════
// G.canPlace(x,z) is the SINGLE authority on whether a tower may stand somewhere: the UI
// ghost, the keyboard/touch commit path and the bot harness all ask this one function, so
// what the player sees tinted green is exactly what the sim will accept. Reads only the
// fixed heightfield + the prop table WORLD registered, never rng() — safe to call from a
// sim tick and from a render frame alike.
const FOOT_R = 1.9;                  // tower footprint radius (matches the ghost plate)
const _cn = new THREE.Vector3(), _cp = new THREE.Vector3();
function canPlace(x, z) {
  // The muster is checked FIRST and without looking at the ground: when the standards are
  // all raised, no site is a good site, and the writ must say why rather than blaming the
  // slope (SPEC3 §C). Sell a tower or pay the herald to widen the line.
  if (G.towersList.length >= state.muster) return { ok: false, reason: 'The muster is full' };
  if (!isFinite(x) || !isFinite(z)) return { ok: false, reason: 'Off the map' };
  if ((x / 86) ** 2 + (z / 58) ** 2 > 1) return { ok: false, reason: 'Beyond the vale' };
  G.groundNormal(x, z, _cn);
  if (_cn.y < 0.93) return { ok: false, reason: 'Ground too steep' };
  if (Math.abs(G.roadSD(x, z)) < 4.2) return { ok: false, reason: 'Too close to the road' };
  for (const r of G.spawnRoutes) {
    G.pathPos(0, _cp, 0, r);
    if (Math.hypot(x - _cp.x, z - _cp.z) < 26) return { ok: false, reason: 'Under the foe\u2019s gate' };
  }
  G.pathPos(G.pathLen, _cp);
  if (Math.hypot(x - _cp.x, z - _cp.z) < 24) return { ok: false, reason: 'Inside the keep grounds' };
  for (const tw of G.towersList)
    if ((x - tw.x) ** 2 + (z - tw.z) ** 2 < 3.8 * 3.8) return { ok: false, reason: 'Too close to a tower' };
  for (const o of G.obstacles) {
    const r = o.r + FOOT_R;
    if ((x - o.x) ** 2 + (z - o.z) ** 2 < r * r) return { ok: false, reason: 'Ground is occupied' };
  }
  return { ok: true, reason: '' };
}
G.canPlace = canPlace;
// Foundation height: the LOWEST ground under the footprint, so a tower on a gentle roll
// cuts into the slope instead of hovering over it on its downhill side.
function padY(x, z) {
  let y = G.groundY(x, z);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * 6.283185307;
    y = Math.min(y, G.groundY(x + Math.cos(a) * FOOT_R, z + Math.sin(a) * FOOT_R));
  }
  return y;
}
G.padY = padY;
// Placement mode. MAIN drives the cursor → world hit-test; this owns the rules (phase,
// affordability, validity) and the read-out handoff to UI + TOWERS.
G.place = null;
function enterPlace(type) {
  if (state.phase !== 'prewave' && state.phase !== 'wave') return false;
  if (!TOWER_DEFS[type]) return false;
  if (state.gold < TOWER_DEFS[type].cost) { Audio.play('ui'); return false; }
  state.selTower = -1;
  const p = G.place;
  G.place = { type, x: p ? p.x : 0, z: p ? p.z : 0, ok: false, reason: '' };
  setPlaceAt(G.place.x, G.place.z);
  Audio.play('ui'); UI.sync();
  return true;
}
function setPlaceAt(x, z) {
  const p = G.place;
  if (!p) return;
  p.x = x; p.z = z;
  const v = canPlace(x, z);
  p.ok = v.ok; p.reason = v.reason;
  UI.place(p);
}
function exitPlace() {
  if (!G.place) return;
  G.place = null;
  UI.place(null);
}
function commitPlace(keep) {
  const p = G.place;
  if (!p) return false;
  if (!p.ok || !placeTower(p.x, p.z, p.type)) { Audio.play('ui'); return false; }
  // Shift-place keeps the hammer in hand as long as the purse allows it.
  if (keep && state.gold >= TOWER_DEFS[p.type].cost) { setPlaceAt(p.x, p.z); return true; }
  exitPlace();
  return true;
}
G.enterPlace = enterPlace; G.setPlaceAt = setPlaceAt; G.exitPlace = exitPlace; G.commitPlace = commitPlace;

// ══ DAMAGE (SPEC3 §A) ════════════════════════════════════════════════
// EVERY point of damage in the game goes through here — arrows, bolts, boulders, splash,
// burning ground and knights — so the element wheel, the omen modifiers and (later) any
// on-hit effect have exactly one place to live. Returns the damage actually dealt.
//   resist  0.5 → takes half · 0    → takes all · −0.2 → takes 20% EXTRA
// Resistance is capped at RES_CAP: nothing in the game is ever immune, only inefficient.
const RES_CAP = 0.85;
// Per-school ledger for the whole run. Elemental Ward reads it to pick the school the
// player has leaned on hardest — the diversification forcer only works if it can see the
// lean, so the count has to be kept everywhere damage lands, not just at towers.
const dmgBySchool = { pierce: 0, crush: 0, fire: 0, storm: 0 };
G.dmgBySchool = dmgBySchool;
function dealDamage(e, amount, element) {
  if (!e || !e.alive || !(amount > 0)) return 0;
  let r = resistOf(e.def, element);
  if (e.ward === element) r += OMEN_FX.ward;             // Elemental Ward rides the unit
  if (r > RES_CAP) r = RES_CAP;
  const dmg = amount * (1 - r) * (OMEN_FX.dmg[element] || 1);
  e.hp -= dmg;
  if (dmgBySchool[element] !== undefined) dmgBySchool[element] += dmg;
  if (e.hp <= 0) killEnemy(e);
  return dmg;
}
G.dealDamage = dealDamage;
// HOOK: VFX/AUDIO builder (SPEC3 §A). The one place that DRESSES a landed blow. Kept next
// to dealDamage() rather than at each call site so the picture and the sound of a school
// can never drift apart, and so a shrug is defined once: at or above half resistance the
// hit is a deflection, and the cue that plays is the dull one that says so. Pierce under
// that bar stays SILENT on purpose — an archer wall firing four arrows a second would turn
// any per-hit cue into a rattle, and the bow report already covers it.
const HIT_SFX = { crush: 'thud', fire: 'sizzle', storm: 'crack', pierce: '' };
function hitFX(e, x, y, z, el, size) {
  VFX.hit(x, y, z, el, size, e);
  let r = resistOf(e.def, el);
  if (e.ward === el) r += OMEN_FX.ward;
  const cue = r >= 0.5 ? 'shrug' : HIT_SFX[el];
  if (cue) Audio.play(cue, x, z, r >= 0.5 ? 0.5 : 0.62);
}

// ══ WAR OMENS (SPEC3 §D) ═════════════════════════════════════════════
// From wave 5 on, every muster offers three omens — always at least one challenge and at
// least one boon — and the one the player takes rides the NEXT wave only. A challenge pays
// +20% bounty, so the greedy line and the safe line are genuinely different lines.
// The offer is drawn from the RUN SEED (srng), never from the sim stream: the draw must be
// the same whether the player called the wave early or let the countdown run out.
const OMEN_FROM = 5;                                   // first wave that carries an omen
G.OMEN_FROM = OMEN_FROM;                               // UI reads it for the dispatch's omen line
const OMENS = {
  march:    { kind: 'challenge', name: 'Forced March',    desc: 'The horde comes on at a run — +25% speed.' },
  ironskin: { kind: 'challenge', name: 'Iron Skins',      desc: 'Boiled hide and plate — +40% hit points.' },
  ward:     { kind: 'challenge', name: 'Elemental Ward',  desc: 'Warded against whichever school has spilt the most blood this campaign.' },
  night:    { kind: 'challenge', name: 'Night Raid',      desc: 'They come out of the dark almost twice as thick.' },
  sappers:  { kind: 'challenge', name: 'Sappers',         desc: 'Nothing slows them and they smother burning ground.' },
  shafts:   { kind: 'boon',      name: 'Sharpened Shafts',desc: 'Arrows and bolts bite 30% deeper this wave.' },
  front:    { kind: 'boon',      name: 'Storm Front',     desc: 'Lightning leaps two foes further.' },
  chest:    { kind: 'boon',      name: 'War Chest',       desc: 'The treasury opens — 60 gold, now.' },
  wind:     { kind: 'boon',      name: 'Second Wind',     desc: 'Fallen knights return twice as fast.' },
  thin:     { kind: 'boon',      name: 'Thin Ranks',      desc: 'A fifth fewer foes — and a quarter less coin.' },
};
G.OMENS = OMENS;
// The active bundle. EVERY omen effect is read out of this one object, so "the omen is
// over" is a single reset rather than five scattered flags.
const OMEN_FX = { spd: 1, hp: 1, ward: 0, wardEl: '', interval: 1, count: 1, noSlow: 0,
                  dmg: {}, chain: 0, respawn: 1, bounty: 1 };
G.OMEN_FX = OMEN_FX;
function resetOmenFx() {
  OMEN_FX.spd = OMEN_FX.hp = OMEN_FX.interval = OMEN_FX.count = OMEN_FX.respawn = OMEN_FX.bounty = 1;
  OMEN_FX.ward = OMEN_FX.chain = OMEN_FX.noSlow = 0; OMEN_FX.wardEl = '';
  for (const k in OMEN_FX.dmg) delete OMEN_FX.dmg[k];
}
// The school this run has leaned on hardest — what Elemental Ward turns against you.
function topSchool() {
  let best = SCHOOLS[0];
  for (const s of SCHOOLS) if (dmgBySchool[s] > dmgBySchool[best]) best = s;
  return best;
}
G.topSchool = topSchool;
function applyOmen(key) {
  resetOmenFx();
  state.omen = OMENS[key] ? key : '';
  const o = OMENS[state.omen];
  if (!o) return;
  switch (state.omen) {
    case 'march':    OMEN_FX.spd = 1.25; break;
    case 'ironskin': OMEN_FX.hp = 1.40; break;
    case 'ward':     OMEN_FX.ward = 0.5; OMEN_FX.wardEl = topSchool(); break;
    case 'night':    OMEN_FX.interval = 0.55; break;
    case 'sappers':  OMEN_FX.noSlow = 1; break;
    case 'shafts':   OMEN_FX.dmg.pierce = 1.3; break;
    case 'front':    OMEN_FX.chain = 2; break;
    case 'chest':    state.gold += 60; break;
    case 'wind':     OMEN_FX.respawn = 0.5; break;
    case 'thin':     OMEN_FX.count = 0.8; OMEN_FX.bounty = 0.75; break;
  }
  if (o.kind === 'challenge') OMEN_FX.bounty = 1.2;    // danger money
}
// Bot policy (`&omenpol=random|gold|safe`). A bot takes its omen the moment it is offered,
// so a balance run never depends on a countdown it cannot see.
const OMENPOL = (P.get('omenpol') || '').toLowerCase();
function policyPick(offer, n) {
  if (OMENPOL === 'random') return (srng(0x0E5, n) * offer.length) | 0;
  if (OMENPOL === 'gold') {
    let i = offer.indexOf('chest'); if (i >= 0) return i;
    i = offer.findIndex(k => OMENS[k].kind === 'challenge');   // +20% bounty is income too
    return i >= 0 ? i : 0;
  }
  if (OMENPOL === 'safe') {
    for (const k of ['thin', 'wind', 'front', 'shafts', 'chest']) { const i = offer.indexOf(k); if (i >= 0) return i; }
    for (const k of ['sappers', 'ward', 'ironskin', 'march', 'night']) { const i = offer.indexOf(k); if (i >= 0) return i; }
  }
  return -1;                                            // leave it to the seeded default
}
const Omens = { offer: [], forWave: 0, picked: -1, defIdx: 0, active: '', wardEl: '' };
// UI contract (SPEC3 §D): G.omens.offer is the three keys on the table, pick(i) takes one,
// active is the omen riding the wave in progress ('' = none). Everything else is private.
G.omens = Omens;
function drawOmens(n) {
  // The draw index carries the MAP as well as the wave. Keyed on the wave alone, a pinned
  // seed dealt all three roads the identical wave-N hand — visible in the shipped frames,
  // where battle2 (W8) and battle3 (W7) both came up Elemental Ward — which makes the
  // campaign feel scripted exactly where §D wants it to feel dealt. SWAPS already salts on
  // MAP.id; this is the same idiom. Still deterministic given (map, seed).
  const oi = n + MAP.id * 101;
  const keys = Object.keys(OMENS);
  const ch = keys.filter(k => OMENS[k].kind === 'challenge'), bo = keys.filter(k => OMENS[k].kind === 'boon');
  const one = (arr, r) => arr[Math.min(arr.length - 1, (r * arr.length) | 0)];
  const a = one(ch, srng(0x0E1, oi)), b = one(bo, srng(0x0E2, oi));
  const rest = keys.filter(k => k !== a && k !== b);
  const c = one(rest, srng(0x0E3, oi));
  const off = (srng(0x0E4, oi) * 3) | 0, trio = [a, b, c];
  Omens.offer = [trio[off], trio[(off + 1) % 3], trio[(off + 2) % 3]];
  Omens.forWave = n; Omens.picked = -1;
  Omens.defIdx = (srng(0x0E6, oi) * 3) | 0;             // what the herald picks if you dither
  const pp = policyPick(Omens.offer, n);
  if (pp >= 0) Omens.picked = pp;
  UI.omens();
}
Omens.pick = (i) => {
  if (state.phase !== 'prewave' || !Omens.offer.length) return false;
  if (!(i >= 0 && i < Omens.offer.length)) return false;
  Omens.picked = i;
  // HOOK: AUDIO builder — taking an omen is the only decision in the game that is not a
  // purchase, so it gets its own stinger (page turn + a low choir) rather than the HUD tick.
  // The parchment burn-in is UI-CSS's `omBurn`, which runs off the card being rebuilt.
  Audio.play('omen'); UI.omens(); UI.sync();
  return true;
};
// Called every prewave tick: the offer is drawn once per muster, whoever opened the phase
// (a cleared wave, UI.startGame, or the shot harness staging one directly).
function omenTick() {
  const n = state.wave + 1;
  if (n < OMEN_FROM || n > WAVES.length) return;
  if (Omens.forWave !== n) drawOmens(n);
}
// Fired by startWave(): the pick (or the seeded default) becomes the wave's omen.
function commitOmen(n) {
  if (Omens.forWave !== n || !Omens.offer.length) { applyOmen(''); Omens.active = ''; return; }
  const key = Omens.offer[Omens.picked >= 0 ? Omens.picked : Omens.defIdx];
  applyOmen(key);
  Omens.active = state.omen; Omens.wardEl = OMEN_FX.wardEl;
  Omens.offer = []; Omens.forWave = 0; Omens.picked = -1;
  if (SHOT) console.log('OMENLOG wave=' + n + ' key=' + state.omen + (OMEN_FX.wardEl ? ' ward=' + OMEN_FX.wardEl : ''));
}

// ══ ELITE SWAP SLOTS (SPEC3 §E) ══════════════════════════════════════
// From wave 6 on, two or three groups per campaign are drawn from a swap table instead of
// being fixed: the same seed always fields the same threats, a new run fields a different
// mix. Each option is [key, count×, interval×] — a mini-boss replaces a mob of chaff at a
// fraction of the count and a slower cadence. Option 0 is always the ORIGINAL group, so a
// run can legitimately come out vanilla.
// Options naming a species the roster does not carry YET fall back to the original group.
// ROSTER pass: the count/interval factors were authored blind against SPEC3's hp column.
// They are now sized against EFFECTIVE hit points — raw hp divided through the resist the
// swapped species carries against the school the map's advertised comp actually shoots
// with. Raw-hp parity is the wrong target and the bot matrix proved it: 18 frost revenants
// carry the same 3100 hit points as the 11 brutes they replaced, but at pierce .6 against
// Frostfell's archer wall they are worth 7700, and intended2 went from surviving to wave
// 12 to dying on wave 8. A slot is allowed to be a spike, not a different campaign.
const SWAP_SLOTS = {
  1: [
    // 16 brutes = 2400 hp. ironclad 5 (pierce .5 · storm .85) · ram 2 · ashwraith 32.
    { wave: 7, from: 'brute',  to: [['brute', 1, 1], ['ironclad', 0.32, 2.7], ['ram', 0.14, 5.0], ['ashwraith', 2.0, 0.50]] },
    // 60 runners = 540 hp. A mini-swarm of 18 wraiths or 8 revenants is a real spike but
    // not a second wave: at the blind 0.55/0.42 this slot fielded 2000+ hp of elites.
    { wave: 9, from: 'runner', to: [['runner', 1, 1], ['ashwraith', 0.30, 2.6], ['frostrevenant', 0.13, 5.5]] },
    // 8 pavises = 440 hp. The shaman option is the teaching one: it costs the wave almost
    // nothing in hit points and doubles how long everything ELSE on the road takes to kill.
    { wave: 6, from: 'shield', to: [['shield', 1, 1], ['warshaman', 0.75, 1.45], ['marauder', 1.1, 0.95]] },
  ],
  2: [
    // Frostfell's advertised answer is pierce, so both elite options here are priced
    // against pierce: ironclad .5 and frost revenant .6 both cost roughly double.
    { wave: 8,  from: 'brute',  to: [['brute', 1, 1], ['ironclad', 0.28, 3.1], ['frostrevenant', 0.70, 1.4]] },
    // 30 pavises. A healer count is a force multiplier, so it sits far under hp parity.
    { wave: 10, from: 'shield', to: [['shield', 1, 1], ['ironclad', 0.10, 7.0], ['warshaman', 0.22, 3.8]] },
    // 74 hounds = 518 hp. 10 wraiths = 620 — and a wraith pack is as fast as a hound pack.
    { wave: 11, from: 'hound',  to: [['hound', 1, 1], ['ashwraith', 0.14, 6.0], ['runner', 0.9, 1.05]] },
  ],
  3: [
    // 22 marauders = 572 hp. ashwraith 11 = 660 (and fire, the wastes' own school, is the
    // one thing that does not touch them) · warshaman 8.
    { wave: 7,  from: 'marauder', to: [['marauder', 1, 1], ['ashwraith', 0.5, 1.9], ['warshaman', 0.35, 2.7]] },
    // 15 brutes = 2250 hp. ram 2 · ironclad 4.
    { wave: 11, from: 'brute',    to: [['brute', 1, 1], ['ram', 0.16, 5.0], ['ironclad', 0.27, 3.4]] },
    // 23 pavises = 1265 hp. ironclad 2 · ashwraith 21 = 1260.
    { wave: 13, from: 'shield',   to: [['shield', 1, 1], ['ironclad', 0.11, 6.2], ['ashwraith', 0.9, 0.78]] },
  ],
};
// Resolved ONCE per run, off the run seed — not per wave, so a slot cannot re-roll itself
// by the player replaying a wave boundary.
const SWAPS = (SWAP_SLOTS[MAP.id] || []).map((s, i) => {
  const r = srng(0x53 + MAP.id * 17, i);
  let opt = s.to[Math.min(s.to.length - 1, (r * s.to.length) | 0)];
  if (!ENEMY_DEFS[opt[0]]) opt = s.to[0];
  return { wave: s.wave, from: s.from, k: opt[0], n: opt[1], iv: opt[2] };
});
G.SWAPS = SWAPS;
if (SHOT) for (const s of SWAPS)
  console.log('SWAPLOG wave=' + s.wave + ' ' + s.from + '->' + s.k + ' n=' + s.n);
// ROSTLOG (SPEC3 §B verification): one line per resolved slot with the seed that resolved
// it, plus the roster head count. Two runs at different `&seed=` must print different
// resolutions — that IS the per-run-variance test, and it is machine-readable.
if (SHOT) {
  console.log('ROSTLOG roster=' + Object.keys(ENEMY_DEFS).length + ' map=' + MAP.id + ' seed=' + G.runSeed +
    ' slots=' + SWAPS.length);
  for (const s of SWAPS)
    console.log('ROSTLOG swap map=' + MAP.id + ' seed=' + G.runSeed + ' wave=' + s.wave + ' ' + s.from + '->' + s.k +
      ' n=' + s.n + ' iv=' + s.iv + (s.k === s.from ? ' (vanilla)' : ' (elite)'));
  // the fixed mid-campaign mini-boss slots, so a log diff proves they are still on the road
  const fixed = [];
  WAVES.forEach((w, i) => { for (const g of w) if ((ENEMY_DEFS[g[0]] || {}).elite && g[0] !== 'ogre') fixed.push('W' + (i + 1) + ':' + g[0] + '×' + g[1]); });
  console.log('ROSTLOG fixed map=' + MAP.id + ' ' + (fixed.join(' ') || 'none'));
}

// `pid` = which spawn gate this one walks out of (Frostfell has two); `branch` is the coin
// flip the Ember Wastes fork reads at the split. Both draws are guarded so a single-route
// map consumes the rng stream exactly as it did before maps 2-3 existed.
function spawnEnemy(type, pid) {
  const def = ENEMY_DEFS[type];
  const hpMul = 1 + (MAP.hpRamp || 0.14) * (state.wave - 1); // r3: per-map ramp — long maps scale slower per wave
  // r7 REGRESSION REVERT — spawn placement is SIM, not dressing. ARMIES swapped this for a
  // six-file lattice (G.laneOf) + a `d0 = r1 * 0.30` head start. Draw COUNT was preserved, so
  // the rng stream stayed aligned, but the lane DISTRIBUTION did not: the old jitter is
  // triangular (two thirds of the column inside the middle ~1.4u), the lattice is uniform out
  // to ±2.30. Same maximum, very different mean distance from the road centre — so towers
  // sited on the centre line lost DPS uptime on most of the column. That flipped BALANCE.md's
  // map-3 anchors both ways (magic3 2/32 win → loss, intended3 loss → 13/32 win). Centring d0
  // alone did not restore them; the lattice is the load-bearing half. Reverted to the tuned
  // distribution. ARMIES' mesh/armour/ogre art is untouched — only these two lines were sim.
  // G.laneOf stays defined: the _bestiary showcase preset still poses with it.
  const lane = (rng() + rng() - 1) * 2.35;
  const SR = G.spawnRoutes;
  if (pid === undefined) pid = SR.length > 1 ? SR[Math.min(SR.length - 1, (rng() * SR.length) | 0)] : SR[0];
  const branch = HAS_FORK ? (rng() < 0.5 ? 1 : 0) : 0;
  G.pathPos(0, _v3, lane, pid);                         // real position from tick one: the
  // marauder's "is a knight within 7u" test runs before the movement pass writes px/pz
  // The omen rides the UNIT, not the clock: hit points, pace, the ward school and the
  // sapper's immunity are stamped on at muster, so nothing an omen did can outlive its wave.
  const hp = def.hp * hpMul * OMEN_FX.hp;
  G.enemies.push({ id: eid++, type, def, hp, maxhp: hp, d: 0,
    pathId: pid, branch,
    lane, alive: true, deathT: -1, blockedBy: -1, px: _v3.x, pz: _v3.z, slowT: 0, slowF: 1,
    spdM: OMEN_FX.spd, ward: OMEN_FX.ward ? OMEN_FX.wardEl : '', noSlow: OMEN_FX.noSlow,
    shooting: false, aimX: 0, aimZ: 0, stompT: def.stomp ? 2 : 0, stompFX: -1 });
}
// The one place a knight loses hit points — melee, marauder arrows and the ogre's stomp
// all land here, so a knight's death always frees whoever was holding him and always
// looks the same. Mirrors dealDamage()'s role on the other side of the line.
function hurtKnight(kn, amount) {
  if (!kn || !kn.alive || !(amount > 0)) return 0;
  kn.hp -= amount;
  if (kn.hp > 0) return amount;
  kn.alive = false; kn.respawn = 8 * OMEN_FX.respawn; kn.target = -1;
  const ki = G.knights.indexOf(kn);
  for (const e of G.enemies) if (e.blockedBy === ki) e.blockedBy = -1;
  VFX.burst(kn.x, 1, kn.z, 0x88aaff, 1.4, .5);
  return amount;
}
G.hurtKnight = hurtKnight;
function nearestKnight(x, z, rad) {
  let bq = rad * rad, best = null;
  for (const kn of G.knights) {
    if (!kn.alive) continue;
    const q = (kn.x - x) ** 2 + (kn.z - z) ** 2;
    if (q < bq) { bq = q; best = kn; }
  }
  return best;
}
// OGRE (SPEC2 §D). While it is held in melee it brings a foot down every 5 s: 30 to every
// knight inside 2.5u, a shake and a ring of dust. That is what makes a barracks a bad
// answer to one — you have to shoot it.
function ogreStomp(e) {
  const S = e.def.stomp;
  if (e.stompT > 0) { e.stompT -= TICK; return; }
  e.stompT = S.cd; e.stompFX = vt();
  const rq = S.rad * S.rad;
  for (const kn of G.knights)
    if (kn.alive && (kn.x - e.px) ** 2 + (kn.z - e.pz) ** 2 <= rq) hurtKnight(kn, S.dmg);
  const gy = G.groundY(e.px, e.pz);
  VFX.shakeAt(e.px, gy, e.pz, 0.85);
  VFX.stomp(e.px, gy, e.pz);                            // HOOK: VFX builder — dust burst
  Audio.play('stomp', e.px, e.pz);
}
let spawnQueue = [];
let _bountyFrac = 0;                                    // sub-gold change from omen bounty multipliers
function startWave(n) {
  state.wave = n; state.phase = 'wave'; spawnQueue = [];
  commitOmen(n);                                        // SPEC3 §D — the omen is locked in here
  // 5th field of a wave group = the spawn gate it marches out of (Frostfell). Omitted, the
  // group is split across the map's gates one enemy at a time by spawnEnemy().
  for (const [type0, count0, interval0, delay, pid] of WAVES[n - 1]) {
    // SPEC3 §E: an elite swap slot re-casts one group of this wave for the whole run.
    const sw = SWAPS.find(s => s.wave === n && s.from === type0);
    const type = sw ? sw.k : type0;
    const count = Math.max(1, Math.round(count0 * (sw ? sw.n : 1) * OMEN_FX.count));
    const interval = interval0 * (sw ? sw.iv : 1) * OMEN_FX.interval;
    for (let i = 0; i < count; i++)
      spawnQueue.push({ tick: state.tick + Math.round((delay + i * interval) * TPS), type, pid });
  }
  spawnQueue.sort((a, b) => a.tick - b.tick);
  UI.msg('Wave ' + n + (n === WAVES.length ? ' — ' + MAP.finale : '') + ' incoming!');
  // HOOK: AUDIO builder — the horn reads the wave's COMPOSITION, so a pack wave answers
  // with hounds and a finale answers with the boss's own sting (SPEC2 §D/§E).
  Audio.waveCue(WAVES[n - 1]);
  UI.sync();
}
G.startWave = startWave;

// Free placement: (x,z) is anywhere G.canPlace() allows. `free` skips the purse AND the
// validity gate — that is the shot harness / preset path only.
function placeTower(x, z, type, level = 1, free = false) {
  const def = TOWER_DEFS[type];
  if (!free) {
    if (state.gold < def.cost || !canPlace(x, z).ok) return false;
    state.gold -= def.cost;
  }
  // POLISH/BUGFIX: this used to store `level` here AND then run the upgrade loop below, so
  // placeTower(..., 2) actually produced a LEVEL 3 tower and mis-stated `invested`. Build
  // at tier 1 and let the loop walk up — every preset's level argument now means what it
  // says (the shot tables were re-pointed to the tiers they were really getting).
  // `mode` (SPEC3 §F) starts at the type's doctrine and is then the tower's own property —
  // cycled per tower, never re-read from the def.
  const tw = { uid: ++twid, type, level: 1, cdT: 0, invested: def.cost, x, z, y: padY(x, z), group: null,
    mode: def.mode || 'first' };
  state.invested += def.cost;
  tw.group = Towers.build(tw);
  tw.group.position.set(x, tw.y, z);
  scene.add(tw.group);
  G.towersList.push(tw);
  if (type === 'barracks') spawnKnights(tw);
  // HOOK: WORLD — stamp a contact-AO footprint so the tower sits IN the terrain instead of
  // on it (same pass every scattered prop uses).
  if (G.stampAO) G.stampAO(x, z, 2.4, 0.9);
  for (let l = 2; l <= level; l++) upgradeTower(tw, true);
  // HOOK: AUDIO builder — a raised standard gets its own cue (mallets + a horn swell);
  // everything else is timber and stone.
  UI.sync(); Audio.play(def.aura ? 'banner' : 'build', x, z);
  return true;
}
G.placeTower = placeTower;
function upgradeTower(tw, free = false) {
  if (tw.level >= 3) return false;
  const cost = Math.round(TOWER_DEFS[tw.type].cost * (tw.level === 1 ? 0.8 : 1.3));
  if (!free) { if (state.gold < cost) return false; state.gold -= cost; }
  tw.level++; tw.invested += cost; state.invested += cost;
  scene.remove(tw.group); tw.group = Towers.build(tw);
  tw.group.position.set(tw.x, tw.y, tw.z);
  scene.add(tw.group);
  if (tw.type === 'barracks') for (const kn of G.knights) if (kn.tower === tw) { kn.maxhp = 90 * (1 + 0.5 * (tw.level - 1)); kn.dps = 6 * (1 + 0.55 * (tw.level - 1)); }
  UI.sync(); Audio.play('build');
  return true;
}
G.upgradeTower = upgradeTower;
// Selling frees the 3.8u spacing again, so repositioning is a real strategy (SPEC2 §A).
function sellTower(tw) {
  state.gold += Math.round(tw.invested * 0.7);
  scene.remove(tw.group);
  G.towersList.splice(G.towersList.indexOf(tw), 1);
  G.knights = G.knights.filter(k => k.tower !== tw);
  state.selTower = -1;
  UI.sync(); Audio.play('coin');
}
G.sellTower = sellTower;
// SPEC3 §F — First → Strong → Close, per tower, hotkey T. Support towers have no target
// to argue about, so they keep no doctrine at all.
const MODES = ['first', 'strong', 'close'];
const MODE_NAME = { first: 'First', strong: 'Strong', close: 'Close' };
G.MODES = MODES; G.MODE_NAME = MODE_NAME;
function cycleMode(tw) {
  if (!tw || !fights(TOWER_DEFS[tw.type])) return null;
  tw.mode = MODES[(MODES.indexOf(tw.mode || 'first') + 1) % MODES.length];
  UI.buildMenu(); Audio.play('ui');
  return tw.mode;
}
G.cycleMode = cycleMode;
function spawnKnights(tw) {
  // rally = nearest point on ANY road: on a forked map a barracks beside the canyon must
  // stand on the canyon, not on route 0 by definition
  const np = G.nearestPath(tw.x, tw.z), bd = np.d, bp = np.pid;
  for (let i = 0; i < 3; i++) {
    G.pathPos(bd, _v3, (i - 1) * 1.6, bp);
    G.knights.push({ tower: tw, alive: true, hp: 90, maxhp: 90, dps: 6, x: _v3.x + (rng() - .5), z: _v3.z + (rng() - .5),
      hx: _v3.x, hz: _v3.z, target: -1, respawn: 0, face: 0, idleT: 0 });
  }
}
const vt = () => state.tick * TICK; // sim virtual time (deterministic)
G.vt = vt;

// ══ TOWER WEAPONS (SPEC2 §C) ═════════════════════════════════════════
// Everything a tower does when its cooldown expires lives in fireTower(), so the shot
// harness can stage a shot mid-frame (`G.fireTower(tw)`) without duplicating the rules.
const FIRE_SFX = { archer: 'bow', ballista: 'ballista', catapult: 'catapult', storm: 'storm', pyre: 'pyre' };
// Warbanner aura: NON-STACKING — the strongest banner covering a tower wins, so three
// banners in a heap are worth exactly one (SPEC2 §C, anti-deathball).
function auraMul(x, z) {
  let m = 1;
  for (const b of G.towersList) {
    const a = TOWER_DEFS[b.type].aura;
    if (!a) continue;
    const r = TOWER_DEFS[b.type].range * (1 + 0.08 * (b.level - 1));
    if ((x - b.x) ** 2 + (z - b.z) ** 2 <= r * r) m = Math.max(m, 1 + a[b.level - 1]);
  }
  return m;
}
G.auraMul = auraMul;
// Chain lightning: hops to the nearest un-struck foe within `hop`, losing `fall` of its
// damage each time. Hitscan — the visible arc is a render-side ribbon (Towers.zap).
const _chain = [];
function chainLightning(tw, tgt, dmg) {
  // Storm Front (SPEC3 §D) buys the arc two more foes for the wave it rides.
  const def = TOWER_DEFS.storm, hops = def.chain + (tw.level >= 2 ? 1 : 0) + OMEN_FX.chain;
  _chain.length = 0;
  let cur = tgt, d = dmg;
  let sx = tw.x, sy = G.groundY(tw.x, tw.z) + (tw._muz ? tw._muz[1] : 5), sz = tw.z;
  for (let h = 0; h < hops && cur; h++) {
    const ey = G.groundY(cur.px, cur.pz) + cur.def.scale * 0.85;
    Towers.zap(sx, sy, sz, cur.px, ey, cur.pz, h + tw.uid);
    dealDamage(cur, d, 'storm');
    if (tw.level >= 3 && !cur.noSlow) {                 // L3 grounds them: 25% slow, 0.8 s
      cur.slowT = Math.max(cur.slowT, 0.8);
      cur.slowF = Math.min(cur.slowF, 0.75);
    }
    // HOOK: VFX/AUDIO builder — the strike dressing. One crack per CHAIN (h===0), not per
    // hop: four cracks inside 40 ms is a rattle, not lightning (MINGAP would eat them
    // anyway, but saying it here keeps the intent visible).
    VFX.zapHit(cur.px, ey, cur.pz, h, cur);
    if (h === 0) Audio.play('zap', cur.px, cur.pz);
    // SPEC3 §A: an ironclad earths the arc. The strike keeps its crack (the SPIRE fired,
    // and that is what the player did) but the body answers with the deflection clang.
    if (resistOf(cur.def, 'storm') >= 0.5) Audio.play('shrug', cur.px, cur.pz, 0.5);
    _chain.push(cur);
    sx = cur.px; sy = ey; sz = cur.pz;
    d *= 1 - def.fall;
    let nx = null, bq = def.hop * def.hop;
    for (const e of G.enemies) {
      if (!e.alive || _chain.indexOf(e) >= 0) continue;
      const q = (e.px - sx) ** 2 + (e.pz - sz) ** 2;
      if (q < bq) { bq = q; nx = e; }
    }
    cur = nx;
  }
}
// Burning ground. A tower may only hold `max` patches: the oldest is stamped out when a
// new pot lands, which is what keeps a pyre wall from carpeting the whole road.
function addPatch(tw, x, z) {
  const P = TOWER_DEFS.pyre.patch;
  let own = 0;
  for (let i = G.patches.length - 1; i >= 0; i--) if (G.patches[i].owner === tw.uid) own++;
  while (own >= P.max) {
    for (let i = 0; i < G.patches.length; i++) if (G.patches[i].owner === tw.uid) { G.patches.splice(i, 1); own--; break; }
  }
  G.patches.push({ x, z, r: P.rad, dur: P.dur, born: vt(), owner: tw.uid,
    dps: P.dps * Math.pow(1.55, tw.level - 1) });
  VFX.firePatch(x, z, P.rad);
}
function fireTower(tw) {
  const def = TOWER_DEFS[tw.type];
  const range = def.range * (1 + 0.08 * (tw.level - 1)), rq = range * range, minq = (def.minRange || 0) ** 2;
  // TARGETING DOCTRINE (SPEC3 §F), per tower:
  //   first  — furthest along the road (the classic: kill what is closest to the gate)
  //   strong — highest hit points in range, ties to the furthest along. This is what lets
  //            a boss be focused instead of starving behind its own chaff stream.
  //   close  — nearest to the tower, which is what a short-range splash/burn wants.
  let tgt = null, bestD = -1, bestH = -1, bestQ = Infinity;
  const mode = tw.mode || def.mode || 'first';
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const q = (e.px - tw.x) ** 2 + (e.pz - tw.z) ** 2;
    if (q > rq || q < minq) continue;
    const take = mode === 'strong' ? (e.hp > bestH || (e.hp === bestH && e.d > bestD))
               : mode === 'close'  ? q < bestQ
               : e.d > bestD;
    if (take) { bestH = e.hp; bestD = e.d; bestQ = q; tgt = e; }
  }
  if (!tgt) return false;
  tw.cdT = def.cd / auraMul(tw.x, tw.z);               // banner aura buys rate, not damage
  const dmg = def.dmg * Math.pow(1.55, tw.level - 1);
  let hasProj = true;
  if (tw.type === 'catapult' || tw.type === 'pyre') {
    const pot = tw.type === 'pyre', T = pot ? 1.25 : 1.1;
    const lead = clamp(tgt.d + tgt.def.speed * T, 0, PTS[tgt.pathId].len);
    G.pathPos(lead, _v3, tgt.lane, tgt.pathId);
    G.projectiles.push({ kind: pot ? 'pot' : 'boulder', x: tw.x, y: 4, z: tw.z, sx: tw.x, sy: 4, sz: tw.z,
      ex: _v3.x, ez: _v3.z, T, el: 0, dmg, tw: pot ? tw : null,
      splash: def.splash, element: def.element });
  } else if (tw.type === 'storm') {
    chainLightning(tw, tgt, dmg);
    hasProj = false;
  } else {
    G.projectiles.push({ kind: tw.type === 'archer' ? 'arrow' : 'bolt', x: tw.x, y: 4.2, z: tw.z,
      tid: tgt.id, speed: tw.type === 'archer' ? 42 : 55, dmg, pierce: def.pierce || 0, element: def.element });
  }
  Audio.play(FIRE_SFX[tw.type] || 'bow', tw.x, tw.z);  // AUDIO: x/z pan+attenuate
  // HOOK: TOWERS builder — fire animation trigger here (tw, tgt)
  Towers.fire(tw, tgt, hasProj);
  return true;
}
G.fireTower = fireTower;

function tickSim() {
  state.tick++;
  const t = vt();
  if (state.phase === 'prewave') {
    omenTick();                                         // SPEC3 §D — three omens on the table
    state.countdown -= TICK;
    if (state.countdown <= 0) startWave(state.wave + 1);
    UI.syncCountdown();
  }
  if (state.phase !== 'wave' && state.phase !== 'prewave') return;
  // spawns
  while (spawnQueue.length && spawnQueue[0].tick <= state.tick) { const sq = spawnQueue.shift(); spawnEnemy(sq.type, sq.pid); }
  // enemies
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const kn = e.blockedBy >= 0 ? G.knights[e.blockedBy] : null;
    e.shooting = false;
    if (kn && kn.alive) { // fight the blocker
      // a marauder caught in melee is a poor swordsman: `melee` overrides its bow dps
      hurtKnight(kn, (e.def.melee === undefined ? e.def.dps : e.def.melee) * TICK);
      if (e.def.stomp) ogreStomp(e);
    } else {
      e.blockedBy = -1;
      // MARAUDER (SPEC2 §D): a skirmisher that comes within 7u of a free knight stops
      // where it stands and looses arrows instead of marching on. It never closes, so a
      // barracks alone cannot hold a wave that is carrying them.
      const sk = e.def.range ? nearestKnight(e.px, e.pz, e.def.range) : null;
      if (sk) {
        e.shooting = true; e.aimX = sk.x; e.aimZ = sk.z;
        hurtKnight(sk, e.def.dps * TICK);
        // one arrow per 18 ticks rather than per tick, staggered per unit so a firing line
        // does not strobe. Render-only dressing; the damage above is the real thing.
        // HOOK: VFX/AUDIO builder — the loose. VFX.arrow flies the real line and back-dates
        // its own hit sparks to the moment of arrival.
        if ((state.tick + e.id) % 18 === 0) {
          // both ends are ABSOLUTE world heights (VFX.arrow does no ground lookup of its
          // own) — passing 1.15 raw put the target under the meadow and the streak flew
          // into the hillside
          VFX.arrow(e.px, G.groundY(e.px, e.pz) + 1.35, e.pz, sk.x, G.groundY(sk.x, sk.z) + 1.15, sk.z);
          Audio.play('mbow', e.px, e.pz);
        }
      } else {
        // slowF is the strongest slow currently on this foe (catapult 0.6, storm L3 0.75);
        // it resets when the timer runs out so a stale factor can never outlive its source
        e.d += e.def.speed * (e.spdM || 1) * TICK * (e.slowT > 0 ? e.slowF : 1);
        // JUNCTIONS (SPEC2 §E): crossing a handoff distance moves the walker onto another
        // route and carries the overshoot with it, so no step is ever lost or doubled. A
        // tagged handoff clears the tag, which is what stops the Ember fork re-firing when
        // the canyon drops the walker back onto route 0 downstream of the split.
        const HH = HAND[e.pathId];
        for (let hi = 0; hi < HH.length; hi++) {
          const h = HH[hi];
          if (e.d < h.at || (h.tag !== undefined && e.branch !== h.tag)) continue;
          if (h.tag !== undefined) e.branch = 0;
          e.d = h.d + (e.d - h.at); e.pathId = h.to;
          break;
        }
        if (e.pathId === G.endRoute && e.d >= PTS[e.pathId].len - 1.5) {
          e.alive = false; e.deathT = -2; state.lives = Math.max(0, state.lives - e.def.leak); state.leaked++;
          UI.msg('The gate is breached!'); Audio.play('leak'); UI.sync();
          if (state.lives <= 0) return endGame(false);
        }
      }
      if (e.slowT > 0) { e.slowT -= TICK; if (e.slowT <= 0) e.slowF = 1; }
    }
    G.pathPos(e.d, _v3, e.lane, e.pathId); e.px = _v3.x; e.pz = _v3.z;
  }
  // ── WAR SHAMAN (SPEC3 §B) ───────────────────────────────────────────────────
  // The only unit in the horde that never attacks the vale: it pours hit points back into
  // everything around it, which is precisely why it has to be picked out and killed first.
  // Healing is NOT damage — it goes through nothing and touches no resist — but every point
  // of harm the shaman itself takes still goes through dealDamage() like anyone else.
  // `pct` of the ALLY's own maximum per second, hard-capped at `cap`: it nurses a levy back
  // to full in three seconds and barely troubles a boss.
  // Runs AFTER the movement pass, so every px/pz it measures against is this tick's.
  for (const h of G.enemies) {
    if (!h.alive || !h.def.heal) continue;
    const H = h.def.heal, rq = H.r * H.r;
    let lit = false;
    for (const e of G.enemies) {
      if (!e.alive || e === h || e.hp >= e.maxhp) continue;
      if ((e.px - h.px) ** 2 + (e.pz - h.pz) ** 2 > rq) continue;
      e.hp = Math.min(e.maxhp, e.hp + Math.min(e.maxhp * H.pct, H.cap) * TICK);
      lit = true;
    }
    // HOOK: VFX/AUDIO builder — the glow only fires when the chant actually mends someone,
    // and is throttled per unit so a shaman line does not carpet the frame in green.
    // `healT` is a RENDER-SIDE read-out (VFX's presence emitter fills the gaps between
    // pulses with chant motes); nothing in the sim ever reads it back, so it cannot move
    // a tick. Unthrottled on purpose — the throttle below is a spawn budget, not a state.
    if (lit) h.healT = vt();
    if (lit && (state.tick + h.id) % 12 === 0) {
      VFX.heal(h.px, G.groundY(h.px, h.pz), h.pz, H.r);
      Audio.play('heal', h.px, h.pz, 0.5);
    }
  }
  // knights
  for (let ki = 0; ki < G.knights.length; ki++) {
    const kn = G.knights[ki];
    if (!kn.alive) {
      kn.respawn -= TICK;
      // Second Wind (SPEC3 §D) halves the walk back from the barracks.
      if (kn.respawn <= 0) { kn.alive = true; kn.hp = kn.maxhp; kn.x = kn.hx; kn.z = kn.hz; kn.target = -1; }
      continue;
    }
    let tgt = kn.target >= 0 ? G.enemies.find(e => e.id === kn.target && e.alive) : null;
    if (tgt && tgt.blockedBy !== ki) tgt = null;
    if (!tgt) {
      kn.target = -1;
      let bq = 64;
      for (const e of G.enemies) { // claim nearest free enemy near home
        if (!e.alive || e.blockedBy >= 0 || e.def.unblockable) continue;
        const q = (e.px - kn.hx) ** 2 + (e.pz - kn.hz) ** 2;
        if (q < bq) { bq = q; tgt = e; }
      }
      if (tgt) { tgt.blockedBy = ki; kn.target = tgt.id; }
    }
    if (tgt) {
      const dx = tgt.px - kn.x, dz = tgt.pz - kn.z, dist = Math.hypot(dx, dz);
      kn.face = Math.atan2(dx, dz);
      if (dist > 1.15) { kn.x += dx / dist * 3.2 * TICK; kn.z += dz / dist * 3.2 * TICK; }
      else dealDamage(tgt, kn.dps * TICK, 'crush');    // knights swing steel: CRUSH (SPEC3 §A)
      kn.idleT = 0;
    } else {
      const dx = kn.hx - kn.x, dz = kn.hz - kn.z, dist = Math.hypot(dx, dz);
      if (dist > 0.4) { kn.x += dx / dist * 3.2 * TICK; kn.z += dz / dist * 3.2 * TICK; kn.face = Math.atan2(dx, dz); }
      kn.idleT += TICK;
      // knights standing in a warbanner's aura bind their wounds half again as fast
      if (kn.idleT > 3 && kn.hp < kn.maxhp) kn.hp = Math.min(kn.maxhp, kn.hp + 4 * TICK * (auraMul(kn.x, kn.z) > 1 ? 1.5 : 1));
    }
  }
  // towers
  for (const tw of G.towersList) {
    const def = TOWER_DEFS[tw.type];
    if (!fights(def)) continue;
    tw.cdT -= TICK;
    if (tw.cdT > 0) continue;
    fireTower(tw);
  }
  // burning ground (SPEC2 §C): the pyre's patches live in the SIM, tick in the SIM and
  // are the only thing that damages from them — the flames TOWERS draws are pure render.
  for (let i = G.patches.length - 1; i >= 0; i--) {
    const pa = G.patches[i];
    if (t - pa.born >= pa.dur) { G.patches.splice(i, 1); continue; }
    const rq = pa.r * pa.r;
    for (const e of G.enemies) {
      // Sappers (SPEC3 §D) smother burning ground as they cross it.
      if (!e.alive || e.noSlow) continue;
      if ((e.px - pa.x) ** 2 + (e.pz - pa.z) ** 2 <= rq) dealDamage(e, pa.dps * TICK, 'fire');
    }
  }
  // projectiles
  for (let i = G.projectiles.length - 1; i >= 0; i--) {
    const p = G.projectiles[i];
    if (p.kind === 'boulder' || p.kind === 'pot') {
      p.el += TICK;
      const f = Math.min(1, p.el / p.T);
      p.x = lerp(p.sx, p.ex, f); p.z = lerp(p.sz, p.ez, f);
      p.y = lerp(p.sy, G.groundY(p.ex, p.ez), f) + Math.sin(f * Math.PI) * (p.kind === 'pot' ? 8 : 11);
      if (f >= 1) {
        G.projectiles.splice(i, 1);
        if (p.kind === 'pot') {                        // the pot shatters into burning ground
          addPatch(p.tw, p.ex, p.ez);
          VFX.burst(p.ex, 0.5, p.ez, 0xff7a22, 1.35, 0.55);
          VFX.shakeAt(p.ex, G.groundY(p.ex, p.ez), p.ez, 0.10);
          Audio.play('firepot', p.ex, p.ez);
          continue;
        }
        VFX.explosion(p.ex, G.groundY(p.ex, p.ez), p.ez);
        Audio.play('boom', p.ex, p.ez);
        // Stone chips on the BODIES, not just a crater: a boulder landing in a wall of
        // ironclads (crush −0.25) is the single clearest picture of the wheel working, and
        // one landing on the ram (crush .8) is the clearest picture of it not. Three
        // victims dressed per blast — enough to read, cheap enough to spam.
        let dressed = 0;
        for (const e of G.enemies) {
          if (!e.alive) continue;
          const dd = Math.hypot(e.px - p.ex, e.pz - p.ez);
          if (dd <= p.splash) {
            if (!e.noSlow) { e.slowT = 0.4; e.slowF = Math.min(e.slowF, 0.6); }
            const wasElite = e.def.elite;
            dealDamage(e, p.dmg * (1 - 0.6 * dd / p.splash), p.element);
            if (dressed < 3 && (wasElite || dd < p.splash * 0.6))
              { dressed++; hitFX(e, e.px, 1.2, e.pz, p.element, 0.85); }
          }
        }
      }
    } else {
      const tgt = G.enemies.find(e => e.id === p.tid);
      if (!tgt || !tgt.alive) { G.projectiles.splice(i, 1); continue; }
      const dx = tgt.px - p.x, dy = tgt.def.scale + G.groundY(tgt.px, tgt.pz) - p.y, dz = tgt.pz - p.z;
      const dist = Math.hypot(dx, dy, dz), step = p.speed * TICK;
      if (dist <= step + 0.4) {
        G.projectiles.splice(i, 1);
        const tx = tgt.px, tz = tgt.pz;
        dealDamage(tgt, p.dmg, p.element);
        // HOOK: VFX builder — the impact states the SCHOOL and, if the target shrugged it
        // off, states that too (SPEC3 §A). Pierce below the shrug threshold is bit-for-bit
        // the old VFX.burst call, so the archer wall looks exactly as it did.
        hitFX(tgt, tx, 1.4, tz, p.element, 0.7);
        if (p.pierce) { // the bolt punches on through a couple of neighbours
          let hits = 0;
          for (const e of G.enemies) {
            if (!e.alive || e === tgt) continue;
            if (Math.hypot(e.px - tx, e.pz - tz) < 2.2) { dealDamage(e, p.dmg * 0.5, p.element); if (++hits >= p.pierce) break; }
          }
        }
      } else { p.x += dx / dist * step; p.y += dy / dist * step; p.z += dz / dist * step; }
    }
  }
  // wave cleared?
  if (state.phase === 'wave' && !spawnQueue.length && !G.enemies.some(e => e.alive)) {
    if (SHOT) console.log('LIVESLOG wave=' + state.wave + ' lives=' + state.lives + ' leaked=' + state.leaked + ' gold=' + state.gold);
    if (state.wave >= WAVES.length) return endGame(true);
    applyOmen(''); Omens.active = '';                   // an omen lasts exactly one wave
    state.phase = 'prewave'; state.countdown = INTERWAVE;
    UI.msg('Wave ' + state.wave + ' cleared!'); Audio.play('cleared'); UI.sync();
  }
  if (state.tick % 90 === 0) G.enemies = G.enemies.filter(e => e.alive || vt() - e.deathT < 2);
}
function killEnemy(e) {
  if (!e.alive) return;
  // Bounty rides the omen: a challenge wave pays danger money (+20%), Thin Ranks pays less.
  // Gold stays an integer, but the FRACTION is banked rather than rounded away — +20% of a
  // 2-gold levyman is 0.4 gold, and rounding each kill would have paid the player nothing
  // at all for the whole chaff stream (which is most of a wave's income).
  e.alive = false; e.deathT = vt(); state.kills++;
  _bountyFrac += e.def.bounty * OMEN_FX.bounty;
  const paid = Math.floor(_bountyFrac); _bountyFrac -= paid; state.gold += paid;
  if (e.blockedBy >= 0) { const kn = G.knights[e.blockedBy]; if (kn) kn.target = -1; e.blockedBy = -1; }
  for (const kn of G.knights) if (kn.target === e.id) kn.target = -1;
  VFX.burst(e.px, 1, e.pz, 0xc03828, 1.1, 0.4);
  Audio.play('die', e.px, e.pz); UI.sync();
  // HOOK: VFX builder — coin pop / death effect (e)
  VFX.death(e);
}
function endGame(won) {
  state.phase = won ? 'won' : 'lost';
  UI.showEnd(won);
  Audio.play(won ? 'victory' : 'defeat');
}
G.tickSim = tickSim;
// ══════════════════════ END SECTION: SIM ══════════════════════

// ══════════════════════ SECTION: VFX (owner: VFX builder) ══════════════════════
// ONE GPU particle system for the whole game: two InstancedBufferGeometry buckets
// (alpha-blended + additive) sharing a procedural 4x4 sprite atlas, plus one
// terrain-conforming decal mesh = 3 draw calls for every effect in BANNERFALL.
//
// Three design rules make this survive the deterministic shot harness:
//   1. ANALYTIC AGE. A particle's transform is a closed form of its age
//      (p = p0 + v0*A(age) - g*B(age) for linear drag), so there is no integration
//      and no per-frame dt. The harness ticks the sim thousands of times with NO
//      render at all and then renders one virtual time three times; anything
//      integrated per frame would either never advance or advance three times.
//   2. RING-BUFFER POOLS. Spawns overwrite the oldest slot, so the sim's entire
//      backlog of death/impact events can fire during a headless catch-up without
//      starving the effects that are still visible. Zero allocation in the hot path.
//   3. LEAD TIMES + PRIMING. Sub-emitters are born slightly in the past so the very
//      first rendered frame of an explosion is already blossomed, and the continuous
//      emitters (march dust, embers, clashes) are back-filled once on first update so
//      a headless frame shows the same atmosphere a live frame would.
// Continuous emitters run exactly once per SIM TICK from a hash-seeded stream, so
// frame rate, pause and x2 speed never change what is on screen at a virtual time.
// G.rng() is never touched, so sim determinism is untouched either.
const VFX = { list: [] };
G.VFX = VFX;
{
const PQ = tier === 'mobile'
  ? { ts: 64,  aCap: 760,  bCap: 520,  mote: [5, 3, 5], mcell: 9, dust: 3, decals: 6,  prime: 52 }
  : { ts: 128, aCap: 2800, bCap: 1900, mote: [8, 4, 8], mcell: 7, dust: 7, decals: 14, prime: 90 };

// ══ procedural sprite atlas ═══════════════════════════════════════════════════
// 16 tiles. Alpha carries the silhouette, RGB carries baked internal shadowing so a
// white puff already has volume before the shader's sun/sky ramp touches it.
const T_SMOKE = 0, T_WISP = 1, T_DUST = 2, T_SPARK = 3, T_EMBER = 4, T_COIN = 5,
      T_CHUNK = 6, T_BLOOD = 7, T_FLASH = 8, T_RING = 9, T_TUFT = 10, T_MOTE = 11,
      T_GLINT = 12, T_SOOT = 13, T_SCORCH = 14, T_SOFT = 15;
const TS = PQ.ts, ATS = TS * 4;
let _as = 0x2f6b1d31 >>> 0;
const ar = () => { _as ^= _as << 13; _as >>>= 0; _as ^= _as >>> 17; _as ^= _as << 5; _as >>>= 0; return _as / 4294967296; };
const atlasTex = (() => {
  const [ac, x] = cnv(ATS);
  const tile = (i, fn) => {
    x.save();
    x.translate((i % 4) * TS, ((i / 4) | 0) * TS);
    x.beginPath(); x.rect(0, 0, TS, TS); x.clip();
    fn(TS * 0.5, TS * 0.5, TS * 0.5);
    x.restore();
  };
  const blob = (px, py, r, a, col) => {
    r = Math.max(0.6, r);
    const gr = x.createRadialGradient(px, py, 0, px, py, r);
    gr.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')');
    gr.addColorStop(0.52, 'rgba(' + col + ',' + (a * 0.52).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(' + col + ',0)');
    x.fillStyle = gr; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
  };
  const feather = (cx, cy, R, inner) => {          // force alpha 0 before the tile border
    x.globalCompositeOperation = 'destination-in';
    const gr = x.createRadialGradient(cx, cy, R * inner, cx, cy, R * 0.99);
    gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(cx - R, cy - R, R * 2, R * 2);
    x.globalCompositeOperation = 'source-over';
  };
  const cloud = (cx, cy, R, n, lit, shade, a, spread, inner) => {
    for (let i = 0; i < n; i++) {
      const an = ar() * 6.2832, rr = Math.pow(ar(), 0.62) * R * spread;
      blob(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr * 0.92 - R * 0.04,
           R * (0.20 + ar() * 0.28), a * (0.55 + ar() * 0.7), ar() < 0.40 ? shade : lit);
    }
    feather(cx, cy, R, inner);
  };
  const needle = (cx, cy, an, len, w, col) => {
    x.save(); x.translate(cx, cy); x.rotate(an);
    const gr = x.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(' + col + ',1)'); gr.addColorStop(0.5, 'rgba(' + col + ',.5)'); gr.addColorStop(1, 'rgba(' + col + ',0)');
    x.fillStyle = gr; x.beginPath();
    x.moveTo(0, -w); x.lineTo(len, -w * 0.16); x.lineTo(len, w * 0.16); x.lineTo(0, w); x.closePath(); x.fill();
    x.restore();
  };

  tile(T_SMOKE, (cx, cy, R) => cloud(cx, cy, R, 18, '255,255,255', '166,162,158', 0.52, 0.40, 0.44));
  tile(T_WISP,  (cx, cy, R) => cloud(cx, cy, R, 11, '255,255,255', '186,182,178', 0.40, 0.52, 0.24));
  tile(T_SOOT,  (cx, cy, R) => cloud(cx, cy, R, 24, '212,206,198', '80,76,72', 0.92, 0.36, 0.56));
  tile(T_BLOOD, (cx, cy, R) => cloud(cx, cy, R, 13, '198,58,44', '94,20,16', 0.44, 0.42, 0.24));
  tile(T_DUST,  (cx, cy, R) => {
    cloud(cx, cy, R, 11, '255,255,255', '214,208,200', 0.36, 0.34, 0.30);
    for (let i = 0; i < 44; i++) blob(cx + (ar() - .5) * R * 1.4, cy + (ar() - .5) * R * 1.4, R * 0.055, 0.13, '255,255,255');
    feather(cx, cy, R, 0.26);
  });
  tile(T_SPARK, (cx, cy, R) => {                     // comet, head at u = 0 (left edge)
    const hx = R * 0.22;
    const gr = x.createLinearGradient(hx, 0, TS, 0);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,246,214,.70)');
    gr.addColorStop(0.62, 'rgba(255,214,140,.20)'); gr.addColorStop(1, 'rgba(255,190,110,0)');
    x.fillStyle = gr; x.beginPath();
    x.moveTo(hx, cy - R * 0.20); x.quadraticCurveTo(TS * 0.55, cy - R * 0.05, TS, cy);
    x.quadraticCurveTo(TS * 0.55, cy + R * 0.05, hx, cy + R * 0.20); x.closePath(); x.fill();
    blob(hx + R * 0.05, cy, R * 0.28, 1, '255,255,255');
    blob(hx + R * 0.05, cy, R * 0.12, 1, '255,255,255');
  });
  tile(T_EMBER, (cx, cy, R) => {
    blob(cx, cy, R * 0.92, 0.40, '255,148,52'); blob(cx, cy, R * 0.44, 0.9, '255,214,132');
    blob(cx, cy, R * 0.16, 1, '255,255,242');
  });
  tile(T_FLASH, (cx, cy, R) => {
    blob(cx, cy, R * 0.98, 0.32, '255,194,108');
    for (let i = 0; i < 9; i++) needle(cx, cy, ar() * 6.2832, R * (0.55 + ar() * 0.44), R * (0.045 + ar() * 0.05), '255,240,206');
    blob(cx, cy, R * 0.42, 0.92, '255,238,196'); blob(cx, cy, R * 0.17, 1, '255,255,252');
  });
  tile(T_RING, (cx, cy, R) => {
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, R * 0.99);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.58, 'rgba(255,255,255,0)');
    gr.addColorStop(0.79, 'rgba(255,250,238,.90)'); gr.addColorStop(0.88, 'rgba(255,236,200,.30)');
    gr.addColorStop(1, 'rgba(255,220,170,0)');
    x.fillStyle = gr; x.fillRect(0, 0, TS, TS);
  });
  tile(T_TUFT, (cx, cy, R) => {
    for (let i = 0; i < 13; i++) needle(cx, cy, ar() * 6.2832, R * (0.36 + ar() * 0.60), R * (0.05 + ar() * 0.07),
      ar() < 0.5 ? '255,236,198' : '216,192,152');
    blob(cx, cy, R * 0.22, 0.8, '255,246,222');
    feather(cx, cy, R, 0.55);
  });
  tile(T_MOTE, (cx, cy, R) => { blob(cx, cy, R * 0.98, 0.26, '255,246,224'); blob(cx, cy, R * 0.52, 0.62, '255,252,238'); });
  tile(T_GLINT, (cx, cy, R) => {
    for (let i = 0; i < 4; i++) needle(cx, cy, i * 1.5708 + 0.06, R * (i & 1 ? 0.60 : 0.97), R * 0.055, '255,250,226');
    blob(cx, cy, R * 0.28, 0.72, '255,246,214'); blob(cx, cy, R * 0.10, 1, '255,255,255');
  });
  tile(T_SOFT, (cx, cy, R) => blob(cx, cy, R * 0.99, 0.92, '255,255,255'));
  tile(T_COIN, (cx, cy, R) => {
    const r = R * 0.74;
    x.beginPath(); x.arc(cx + r * 0.10, cy + r * 0.14, r * 1.02, 0, 7); x.fillStyle = 'rgba(52,32,4,.42)'; x.fill();
    const gr = x.createLinearGradient(cx - r, cy - r, cx + r * 0.8, cy + r);
    gr.addColorStop(0, '#fff2bd'); gr.addColorStop(0.34, '#f0c25a'); gr.addColorStop(0.72, '#c98f24'); gr.addColorStop(1, '#7d5512');
    x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fillStyle = gr; x.fill();
    x.lineWidth = r * 0.13; x.strokeStyle = '#8a5c13'; x.stroke();
    x.beginPath(); x.arc(cx, cy, r * 0.63, 0, 7); x.strokeStyle = 'rgba(120,80,16,.7)'; x.lineWidth = r * 0.11; x.stroke();
    x.fillStyle = '#f7dd96'; x.font = 'bold ' + Math.max(6, r * 1.05).toFixed(0) + 'px Georgia';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('✦', cx, cy + r * 0.04);
    x.beginPath(); x.ellipse(cx - r * 0.30, cy - r * 0.40, r * 0.32, r * 0.16, -0.75, 0, 7);
    x.fillStyle = 'rgba(255,252,228,.9)'; x.fill();
  });
  tile(T_CHUNK, (cx, cy, R) => {
    const n = 7, pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * 6.2832 + ar() * 0.4, rr = R * (0.48 + ar() * 0.36); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.88]); }
    x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) x.lineTo(pts[i][0], pts[i][1]);
    x.closePath();
    const gr = x.createLinearGradient(0, cy - R, 0, cy + R);
    gr.addColorStop(0, '#a2865f'); gr.addColorStop(0.42, '#6d5539'); gr.addColorStop(1, '#31240f');
    x.fillStyle = gr; x.fill();
    x.strokeStyle = 'rgba(22,14,6,.55)'; x.lineWidth = Math.max(1, R * 0.055); x.stroke();
    x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); x.lineTo(pts[1][0], pts[1][1]); x.lineTo(cx, cy - R * 0.06); x.closePath();
    x.fillStyle = 'rgba(218,196,158,.40)'; x.fill();
  });
  tile(T_SCORCH, (cx, cy, R) => {
    for (let i = 0; i < 20; i++) {
      const an = ar() * 6.2832, rr = Math.pow(ar(), 0.5) * R * 0.52;
      blob(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr, R * (0.20 + ar() * 0.30), 0.42 + ar() * 0.4,
           ar() < 0.55 ? '44,36,28' : '152,134,110');
    }
    for (let i = 0; i < 11; i++) {                   // ejecta rays
      const an = ar() * 6.2832, l = R * (0.55 + ar() * 0.42);
      x.save(); x.translate(cx, cy); x.rotate(an);
      const gr = x.createLinearGradient(0, 0, l, 0);
      gr.addColorStop(0, 'rgba(56,44,32,.7)'); gr.addColorStop(1, 'rgba(122,106,82,0)');
      x.strokeStyle = gr; x.lineWidth = Math.max(1, R * (0.03 + ar() * 0.06)); x.lineCap = 'round';
      x.beginPath(); x.moveTo(R * 0.28, 0); x.lineTo(l, 0); x.stroke(); x.restore();
    }
    feather(cx, cy, R, 0.30);
  });
  const t = tex(ac); t.anisotropy = 8; return t;
})();

// ══ shared uniforms ═══════════════════════════════════════════════════════════
// Custom haze rather than scene.fog: WORLD's terrain runs fog:false and bakes its own
// aerial perspective, so particles need a matching curve or the far end of the road
// reads unnaturally crisp at the 158-unit overview distance.
const U_MAP = { value: atlasTex };
const U_HAZE = { value: new THREE.Color(0xd9c7a2) };
const U_HNF = { value: new THREE.Vector2(95, 400) };
const U_SUN = { value: new THREE.Color(1.50, 1.30, 0.99) };   // particle tops
const U_SKY = { value: new THREE.Color(0.52, 0.49, 0.47) };   // particle undersides
const U_ONE = { value: new THREE.Color(1, 1, 1) };
const P_VERT = `
attribute vec3 iPos; attribute vec3 iVel; attribute vec2 iSize; attribute vec4 iCol; attribute vec3 iAux;
varying vec2 vUv; varying vec4 vCol; varying float vHz; varying float vSh;
uniform vec2 uHNF;
void main(){
  vec2 q = position.xy;
  vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp; float md = iAux.z;
  if (md < 0.5) {                                  // camera billboard, spun by iAux.x
    float c = cos(iAux.x), s = sin(iAux.x);
    vec2 r = vec2(q.x*c - q.y*s, q.x*s + q.y*c) * iSize;
    wp = iPos + R*r.x + U*r.y;
    // Gentle top-lit ramp. A full 0..1 sweep put every billboard's lower half at the
    // sky colour, which at this near-top-down camera turned road dust into rows of dark
    // blobs — the quads are seen almost face-on, so the ramp reads as albedo, not light.
    vSh = q.y*0.55 + 0.72;
  } else if (md < 1.5) {                           // ground-aligned patch: never clips terrain
    float c = cos(iAux.x), s = sin(iAux.x);
    vec2 r = vec2(q.x*c - q.y*s, q.x*s + q.y*c) * iSize;
    wp = iPos + vec3(r.x, 0.0, r.y);
    vSh = 0.80;
  } else {                                         // screen-space streak along iVel
    vec2 d = vec2(dot(iVel,R), dot(iVel,U));
    float L = length(d); d = L > 1e-4 ? d/L : vec2(1.0,0.0);
    vec2 n = vec2(-d.y, d.x);
    vec2 r = -d*((q.x+0.5)*iSize.y) + n*(q.y*iSize.x);
    wp = iPos + R*r.x + U*r.y;
    vSh = 1.4;
  }
  vUv = (q*0.94 + 0.5)*0.25 + vec2(mod(iAux.y,4.0), 3.0 - floor(iAux.y*0.25))*0.25;
  vCol = iCol;
  vec4 mv = viewMatrix * vec4(wp,1.0);
  vHz = smoothstep(uHNF.x, uHNF.y, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const P_FRAG = (add) => `#include <common>
uniform sampler2D uMap; uniform vec3 uHaze, uSunC, uSkyC;
varying vec2 vUv; varying vec4 vCol; varying float vHz; varying float vSh;
void main(){
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vCol.a;
  if (a < 0.003) discard;
  vec3 c = t.rgb * vCol.rgb * mix(uSkyC, uSunC, clamp(vSh, 0.0, 1.0));
  ` + (add ? 'a *= 1.0 - vHz*0.90;' : 'c = mix(c, uHaze, vHz*0.88);') + `
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ══ ring-buffer particle pools ════════════════════════════════════════════════
// 0 birth · 1 life · 2..4 p0 · 5..7 v0 · 8 grav · 9 drag · 10 s0 · 11 s1
// 12 rot0 · 13 rotV · 14 tile · 15..17 rgb · 18 a0 · 19 mode · 20 fade · 21 aspect
const PF = 22;
function mkBucket(cap, add) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, -.5, .5, 0, .5, .5, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const mk = (name, n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
    a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a.array; };
  const B = { D: new Float32Array(cap * PF), cap, head: 0, n: 0, geo: g,
    aP: mk('iPos', 3), aV: mk('iVel', 3), aS: mk('iSize', 2), aC: mk('iCol', 4), aA: mk('iAux', 3) };
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const m = new THREE.ShaderMaterial({
    uniforms: { uMap: U_MAP, uHaze: U_HAZE, uHNF: U_HNF, uSunC: add ? U_ONE : U_SUN, uSkyC: add ? U_ONE : U_SKY },
    vertexShader: P_VERT, fragmentShader: P_FRAG(add), transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  B.mesh = new THREE.Mesh(g, m);
  B.mesh.frustumCulled = false; B.mesh.matrixAutoUpdate = false;
  B.mesh.renderOrder = add ? 7 : 6;
  B.mesh.name = add ? 'VFX_ADD' : 'VFX_ALPHA';
  scene.add(B.mesh);
  return B;
}
const BA = mkBucket(PQ.aCap, false), BB = mkBucket(PQ.bCap, true);

// One reused spawn descriptor keeps every emitter allocation-free.
const E = {};
function eReset() {
  E.x = E.y = E.z = 0; E.vx = E.vy = E.vz = 0; E.grav = 0; E.drag = 1.2;
  E.s0 = 1; E.s1 = 1.6; E.tile = T_SMOKE; E.r = E.g = E.b = 1; E.a = 0.6;
  E.life = 1; E.mode = 0; E.rot = 0; E.rotV = 0; E.fade = 0; E.lead = 0; E.asp = 1;
}
eReset();
let _lead = 0;                                     // emitter back-fill offset
function push(B) {
  const o = B.head * PF, D = B.D;
  B.head = (B.head + 1) % B.cap;
  D[o] = G.vt() - E.lead - _lead; D[o + 1] = E.life;
  D[o + 2] = E.x; D[o + 3] = E.y; D[o + 4] = E.z;
  D[o + 5] = E.vx; D[o + 6] = E.vy; D[o + 7] = E.vz;
  D[o + 8] = E.grav; D[o + 9] = E.drag;
  D[o + 10] = E.s0; D[o + 11] = E.s1; D[o + 12] = E.rot; D[o + 13] = E.rotV;
  D[o + 14] = E.tile; D[o + 15] = E.r; D[o + 16] = E.g; D[o + 17] = E.b;
  D[o + 18] = E.a; D[o + 19] = E.mode; D[o + 20] = E.fade; D[o + 21] = E.asp;
}

function stepBucket(B, t, max) {
  const D = B.D, aP = B.aP, aV = B.aV, aS = B.aS, aC = B.aC, aA = B.aA;
  let n = 0;
  for (let i = 0; i < B.cap; i++) {
    const o = i * PF, life = D[o + 1];
    if (life <= 0) continue;
    const age = t - D[o];
    if (age < 0 || age >= life) continue;
    const k = D[o + 9], gv = D[o + 8];
    let A, Bg, ev;
    if (k > 1e-3) { ev = Math.exp(-k * age); A = (1 - ev) / k; Bg = (age - A) / k; }
    else { ev = 1; A = age; Bg = age * age * 0.5; }
    const f = age / life, fd = D[o + 20];
    let a = D[o + 18];
    if (fd < 0.5) a *= Math.min(1, age * 30 + 0.08) * Math.pow(1 - f, 1.45);
    else if (fd < 1.5) a *= Math.pow(Math.sin(3.14159265 * f), 0.75);
    else a *= Math.min(1, age * 120 + 0.35) * Math.pow(1 - f, 0.42);
    if (a < 0.004) continue;
    const s = D[o + 10] + (D[o + 11] - D[o + 10]) * Math.pow(f, 0.55);
    const j = n * 3, j2 = n * 2, j4 = n * 4;
    aP[j] = D[o + 2] + D[o + 5] * A;
    aP[j + 1] = D[o + 3] + D[o + 6] * A - gv * Bg;
    aP[j + 2] = D[o + 4] + D[o + 7] * A;
    aV[j] = D[o + 5] * ev; aV[j + 1] = D[o + 6] * ev - gv * A; aV[j + 2] = D[o + 7] * ev;
    aS[j2] = s; aS[j2 + 1] = s * D[o + 21];
    aC[j4] = D[o + 15]; aC[j4 + 1] = D[o + 16]; aC[j4 + 2] = D[o + 17]; aC[j4 + 3] = a;
    aA[j] = D[o + 12] + D[o + 13] * age; aA[j + 1] = D[o + 14]; aA[j + 2] = D[o + 19];
    if (++n >= max) break;
  }
  return n;
}
function flush(B, n) {
  B.n = n; B.geo.instanceCount = n;
  if (!n) return;
  const A = B.geo.attributes;
  A.iPos.needsUpdate = true; A.iVel.needsUpdate = true;
  A.iSize.needsUpdate = true; A.iCol.needsUpdate = true; A.iAux.needsUpdate = true;
}

// ══ terrain-conforming decals: scorch craters + expanding ground shockwaves ═══
// One mesh, PQ.decals fixed slots of a 7x7 grid each. A slot's vertices are written
// once on spawn (conformed to G.groundY) with its birth/duration/type/seed baked per
// vertex, so per-frame cost is a single uniform write and free slots collapse to
// degenerate triangles.
const DG = 7, DV = DG * DG, DQ = (DG - 1) * (DG - 1) * 6;
const DEC = { slot: 0, mesh: null, uT: { value: 0 } };
{
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(PQ.decals * DV * 3), loc = new Float32Array(PQ.decals * DV * 2),
        inf = new Float32Array(PQ.decals * DV * 4), tin = new Float32Array(PQ.decals * DV * 3),
        idx = new Uint32Array(PQ.decals * DQ);
  let io = 0;
  for (let d = 0; d < PQ.decals; d++) {
    const vo = d * DV;
    for (let j = 0; j < DG; j++) for (let i = 0; i < DG; i++) {
      const k = vo + j * DG + i;
      loc[k * 2] = i / (DG - 1) * 2 - 1; loc[k * 2 + 1] = j / (DG - 1) * 2 - 1;
      pos[k * 3 + 1] = -9999; inf[k * 4 + 1] = -1;
    }
    for (let j = 0; j < DG - 1; j++) for (let i = 0; i < DG - 1; i++) {
      const a = vo + j * DG + i;
      idx[io++] = a; idx[io++] = a + DG; idx[io++] = a + 1;
      idx[io++] = a + 1; idx[io++] = a + DG; idx[io++] = a + DG + 1;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('aInf', new THREE.BufferAttribute(inf, 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aTint', new THREE.BufferAttribute(tin, 3).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const m = new THREE.ShaderMaterial({
    uniforms: { uMap: U_MAP, uT: DEC.uT, uHaze: U_HAZE, uHNF: U_HNF },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    vertexShader: `attribute vec2 aLocal; attribute vec4 aInf; attribute vec3 aTint;
uniform vec2 uHNF;
varying vec2 vL; varying vec4 vI; varying vec3 vT; varying float vHz;
void main(){ vL = aLocal; vI = aInf; vT = aTint;
  vec4 mv = viewMatrix * vec4(position,1.0);
  vHz = smoothstep(uHNF.x, uHNF.y, -mv.z);
  gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `#include <common>
uniform sampler2D uMap; uniform float uT; uniform vec3 uHaze;
varying vec2 vL; varying vec4 vI; varying vec3 vT; varying float vHz;
void main(){
  float age = uT - vI.x;
  if (vI.y <= 0.0 || age < 0.0 || age > vI.y) discard;
  float r = length(vL); if (r > 1.0) discard;
  float f = age / vI.y;
  vec3 c; float a;
  if (vI.z < 0.5) {                                  // scorch / crater
    float s = sin(vI.w*6.2832), cs = cos(vI.w*6.2832);
    vec2 uv = vec2(vL.x*cs - vL.y*s, vL.x*s + vL.y*cs)*0.47 + 0.5;
    vec4 t = texture2D(uMap, uv*0.25 + vec2(0.5, 0.0));
    a = t.a * (1.0 - smoothstep(0.62, 1.0, r)) * smoothstep(0.0, 0.10, age) * (1.0 - smoothstep(0.55, 1.0, f));
    c = vT * (0.30 + 0.85*t.r);
  } else {                                           // expanding ground shockwave
    float rr = pow(f, 0.48);
    float w = 0.09 + 0.30*f;
    float ring = exp(-pow((r - rr)/w, 2.0)*2.4);
    a = ring * pow(1.0 - f, 1.5) * 0.55;
    c = vT;
  }
  a *= 1.0 - vHz*0.85;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  DEC.mesh = new THREE.Mesh(g, m);
  DEC.mesh.frustumCulled = false; DEC.mesh.matrixAutoUpdate = false;
  DEC.mesh.renderOrder = 1; DEC.mesh.name = 'VFX_DECAL';
  scene.add(DEC.mesh);
}
// `lead` back-dates the birth exactly as a particle's E.lead does, so an expanding
// shockwave can be mid-flight on the very first rendered frame (see VFX.banner).
function decal(x, z, rad, type, dur, r, g, b, seed, lead) {
  const d = DEC.slot; DEC.slot = (DEC.slot + 1) % PQ.decals;
  const vo = d * DV, geo = DEC.mesh.geometry;
  const P = geo.attributes.position.array, I = geo.attributes.aInf.array, T = geo.attributes.aTint.array;
  const ca = Math.cos(seed * 6.2832), sa = Math.sin(seed * 6.2832), born = G.vt() - (lead || 0);
  for (let j = 0; j < DG; j++) for (let i = 0; i < DG; i++) {
    const k = vo + j * DG + i;
    const lx = (i / (DG - 1) * 2 - 1) * rad, lz = (j / (DG - 1) * 2 - 1) * rad;
    const wx = x + lx * ca - lz * sa, wz = z + lx * sa + lz * ca;
    P[k * 3] = wx; P[k * 3 + 1] = G.groundY(wx, wz) + 0.10; P[k * 3 + 2] = wz;
    I[k * 4] = born; I[k * 4 + 1] = dur; I[k * 4 + 2] = type; I[k * 4 + 3] = seed;
    T[k * 3] = r; T[k * 3 + 1] = g; T[k * 3 + 2] = b;
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aInf.needsUpdate = true;
  geo.attributes.aTint.needsUpdate = true;
}

// ══ camera shake: impulse + exponential falloff ══════════════════════════════
// MAIN's updateCamera() treats G.shake as an amplitude and decays it linearly.
// Turning it into an accessor lets VFX own the envelope (hard attack, exponential
// tail, secondary wobble, distance attenuation) without editing MAIN — MAIN's own
// decay write simply loses the comparison in the setter and is absorbed.
let _shkA = 0, _shkT = -99, _vt = 0;
const shkEnv = (age) => (age < 0 || age > 1.7) ? 0 : Math.exp(-age * 5.4) * (0.72 + 0.28 * Math.cos(age * 41));
Object.defineProperty(G, 'shake', {
  get() { return _shkA <= 0 ? 0 : _shkA * shkEnv(_vt - _shkT); },
  set(v) { if (v > _shkA * shkEnv(_vt - _shkT)) { _shkA = v; _shkT = _vt; } },
});
VFX.shakeAt = (x, y, z, power) => {                  // distance-attenuated impulse
  const c = G.camera.position;
  const imp = power / (1 + Math.hypot(c.x - x, c.y - y, c.z - z) / 46);
  const t = G.vt();
  if (imp > _shkA * shkEnv(t - _shkT)) { _shkA = imp; _shkT = t; }
};

// ══ pooled blast lights ══════════════════════════════════════════════════════
// A fireball that lights nothing is a sticker: the soldiers standing two metres off the
// crater have to catch an orange rim and throw a shadow the other way, or the blast is
// paint on the ground. Three.js bakes the light COUNT into every shader program, so the
// pair is built at boot and parked at intensity 0 — exactly the trick TOWERS' EMBER_L
// pair uses for burning ground. A blast claims the least-recently-used slot; the
// envelope is a closed form of the slot's birth time (rule 1 of this section), so a
// headless catch-up that fires ten explosions still lights only the one on screen.
const BLL = [], BLD = new Float32Array(2 * 5), BL_LIFE = 0.34;
if (tier !== 'mobile') for (let i = 0; i < 2; i++) {
  const l = new THREE.PointLight(0xffb060, 0, 24, 2);
  l.name = 'BLAST_L' + i; scene.add(l); BLL.push(l);
}
for (let i = 0; i < 2; i++) BLD[i * 5] = -99;
function claimBlast(x, y, z, p) {
  if (!BLL.length) return;
  let s = 0;                                         // least-recently-used slot
  for (let i = 1; i < BLL.length; i++) if (BLD[i * 5] < BLD[s * 5]) s = i;
  const o = s * 5;
  BLD[o] = G.vt() - 0.05;                            // matches the flash's lead
  BLD[o + 1] = x; BLD[o + 2] = y; BLD[o + 3] = z; BLD[o + 4] = p;
}
function stepBlast(t) {
  for (let i = 0; i < BLL.length; i++) {
    const o = i * 5, age = t - BLD[o], l = BLL[i];
    if (age < 0 || age >= BL_LIFE) { if (l.intensity !== 0) l.intensity = 0; continue; }
    const k = 1 - age / BL_LIFE;
    l.position.set(BLD[o + 1], BLD[o + 2], BLD[o + 3]);
    l.intensity = 85 * BLD[o + 4] * k * k;
  }
}

// ══ shared wind ══════════════════════════════════════════════════════════════
// One place that says which way the air moves, so dust, smoke and (if a later builder
// wants it) cloth all agree. WORLD's banners and TOWERS' pennants already sway on their
// own baked vertex-sway shaders and are NOT driven from here — they only need this if
// someone unifies them; the vector matches the direction their sway leans.
G.wind = { x: -0.72, z: 0.30, s: 1.0 };
const WX = G.wind.x, WZ = G.wind.z;

// ══ deterministic emitter stream (independent of G.rng) ══════════════════════
let _es = 1;
const eseed = (a, b) => { _es = ((Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 1013904223) ^ 0x9e3779b9) >>> 0) || 0x1234567; };
const er = () => { _es ^= _es << 13; _es >>>= 0; _es ^= _es >>> 17; _es ^= _es << 5; _es >>>= 0; return _es / 4294967296; };
const es1 = () => er() * 2 - 1;
const SMK = () => (er() < 0.5 ? T_SMOKE : T_WISP);
const _bc = new THREE.Color();

// ══════════════════════ EFFECT AUTHORING ═════════════════════════════════════

// ── generic hit spray. SIM contract: y is relative to the ground. ─────────────
// SIM calls this for three different events (arrow/bolt hit, enemy killed, knight
// killed) and passes no direction, so a projectile hit infers one: the nearest damaging
// tower is the shooter in every case the sim can produce, and biasing the spark cone
// away from it is what makes a hit read as a hit rather than a firework.
VFX.burst = (x, y, z, color, size, dur) => {
  const py = G.groundY(x, z) + y;
  eseed((x * 91 + z * 37) | 0, (G.vt() * 1000) | 0);
  _bc.setHex(color, THREE.SRGBColorSpace);
  let hx = 0, hz = 0;
  if (size < 1.0) {
    let bq = 1e9;
    for (const tw of G.towersList) {
      if (!TOWER_DEFS[tw.type].dmg) continue;
      const q = (tw.x - x) ** 2 + (tw.z - z) ** 2;
      if (q < bq) { bq = q; hx = x - tw.x; hz = z - tw.z; }
    }
    const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
  }
  const ns = Math.round(4 + size * 5);
  for (let i = 0; i < ns; i++) {                     // additive sparks
    eReset();
    E.x = x + es1() * 0.22 * size; E.y = py + es1() * 0.22 * size; E.z = z + es1() * 0.22 * size;
    const sp = (5 + er() * 12) * (0.6 + size * 0.5), an = er() * 6.2832;
    E.vx = (Math.cos(an) * 0.7 + hx * 0.85) * sp; E.vy = sp * (0.25 + er() * 0.95); E.vz = (Math.sin(an) * 0.7 + hz * 0.85) * sp;
    E.grav = 15; E.drag = 3.4; E.tile = T_SPARK; E.mode = 2;
    E.s0 = 0.09 + er() * 0.07; E.s1 = E.s0 * 0.5; E.asp = 5 + er() * 8;
    E.r = 2.5; E.g = 1.75 + er() * 0.4; E.b = 0.72;
    E.a = 0.95; E.life = 0.16 + er() * 0.22; E.fade = 2; E.lead = 0.02;
    push(BB);
  }
  eReset();                                          // core flash
  E.x = x; E.y = py; E.z = z; E.tile = T_FLASH; E.s0 = size * 0.85; E.s1 = size * 1.7;
  E.r = 2.3; E.g = 1.65; E.b = 0.95; E.a = 0.85; E.life = 0.10 + dur * 0.20; E.fade = 2;
  E.rot = er() * 6.28; E.lead = 0.02; push(BB);
  eReset();                                          // hue-carrying tuft
  E.x = x; E.y = py; E.z = z; E.tile = T_TUFT; E.s0 = size * 0.7; E.s1 = size * 1.9;
  E.r = _bc.r * 1.6 + 0.25; E.g = _bc.g * 1.6 + 0.20; E.b = _bc.b * 1.6 + 0.15;
  E.a = 0.7; E.life = 0.14 + dur * 0.4; E.fade = 2; E.rot = er() * 6.28; E.rotV = es1() * 3;
  E.lead = 0.03; push(BB);
  for (let i = 0; i < 2; i++) {                      // soft puff
    eReset();
    E.x = x + es1() * 0.3; E.y = py + er() * 0.3; E.z = z + es1() * 0.3;
    E.vy = 0.8 + er() * 0.9; E.vx = es1() * 0.8; E.vz = es1() * 0.8; E.drag = 2.1;
    E.tile = SMK(); E.s0 = size * 0.5; E.s1 = size * 1.5;
    E.r = 0.60; E.g = 0.54; E.b = 0.44;
    E.a = 0.34; E.life = 0.38 + dur * 0.7; E.rot = er() * 6.28; E.rotV = es1() * 1.4;
    E.lead = 0.05; push(BA);
  }
  if (_bc.r > _bc.b * 1.4 && size > 0.9) {           // red flavour: blood-lite mist
    for (let i = 0; i < 3; i++) {
      eReset();
      E.x = x + es1() * 0.35; E.y = py + es1() * 0.4; E.z = z + es1() * 0.35;
      E.vx = es1() * 2.2; E.vy = 1.4 + er() * 1.8; E.vz = es1() * 2.2; E.grav = 4.5; E.drag = 3.2;
      E.tile = T_BLOOD; E.s0 = 0.35; E.s1 = 1.15 + er() * 0.5;
      E.r = 1.0; E.g = 0.62; E.b = 0.56; E.a = 0.44; E.life = 0.5 + er() * 0.35;
      E.rot = er() * 6.28; E.rotV = es1() * 2.2; E.lead = 0.04; push(BA);
    }
  }
};

// ── element-tinted impact (SPEC3 §A) ─────────────────────────────────────────
// Every point of damage in BANNERFALL now carries a SCHOOL, and the wheel is the whole v3
// mechanic: a player who cannot SEE that his arrows are skittering off plate while his
// catapult caves it in has to read a tooltip to learn what the frame is already trying to
// tell him. So the hit site is where the school is stated —
//   pierce — the pale gold spark it always had. It is the BASELINE the other three are
//            read against, and it is also the hottest call site in the game (every arrow),
//            so it delegates straight to VFX.burst: identical frame, identical cost.
//   crush  — stone chips and a low dust ring, NO additive core. Mass, not magic.
//   fire   — an ember burst that lifts, cools and dies.
//   storm  — a violet crack over a hard white core.
// ...and it is where RESISTANCE is stated too. At res >= SHRUG_AT the hit takes the
// DEFLECTION path: the core flash is gone entirely and the energy goes sideways or into
// the ground, so "that did nothing" is a silhouette read one frame after the shot lands —
// which is exactly the teaching moment SPEC3 §B's ironclad and ash wraith exist to create.
// y is RELATIVE to the ground (VFX.burst's convention — SIM calls both off the same line);
// `e` is optional and read ONLY for its resist, never mutated.
const SHRUG_AT = 0.5, RES_CAP_V = 0.85;
const ESALT = { pierce: 11, crush: 29, fire: 47, storm: 71 };
VFX.hit = (x, y, z, el, size, e) => {
  const s = size || 1;
  let res = 0;
  if (e && e.def) {
    res = G.resistOf(e.def, el);
    if (e.ward === el) res += G.OMEN_FX.ward;
    if (res > RES_CAP_V) res = RES_CAP_V;
  }
  if (el === 'pierce' && res < SHRUG_AT) return VFX.burst(x, y, z, 0xffd090, s, 0.25);
  const gy = G.groundY(x, z), py = gy + y;
  eseed((x * 83 + z * 151) | 0, ((G.vt() * 967) | 0) + (ESALT[el] || 3));
  if (res >= SHRUG_AT) {
    // ══ DEFLECTION ══ nothing bit. Every variant is DIM, has no white core, and throws
    // its energy AWAY from the body rather than out of it.
    if (el === 'fire') {                                             // ash wraith: embers deflect
      for (let i = 0; i < 8; i++) {
        eReset();
        const an = er() * 6.2832, sp = 2.6 + er() * 4.5;
        E.x = x + Math.cos(an) * 0.42 * s; E.y = py + es1() * 0.45 * s; E.z = z + Math.sin(an) * 0.42 * s;
        E.vx = Math.cos(an) * sp; E.vy = 0.4 + er() * 1.1; E.vz = Math.sin(an) * sp;
        E.grav = 7.5; E.drag = 2.2; E.tile = T_EMBER;
        E.s0 = 0.10 + er() * 0.07; E.s1 = 0.015;
        // they COOL as they leave: no white, and the blue lift is what says the shroud
        // gave the flame nothing to catch.
        E.r = 1.35; E.g = 0.52 + er() * 0.18; E.b = 0.16; E.a = 0.72; E.life = 0.45 + er() * 0.35;
        E.fade = 2; E.lead = 0.02; push(BB);
      }
      eReset();                                                      // the cold refusal
      E.x = x; E.y = py; E.z = z; E.tile = T_SOFT; E.s0 = 0.75 * s; E.s1 = 1.55 * s;
      E.r = 0.30; E.g = 0.46; E.b = 0.62; E.a = 0.26; E.life = 0.26; E.fade = 1;
      E.lead = 0.02; push(BB);
    } else if (el === 'storm') {                                     // ironclad: the arc grounds out
      for (let i = 0; i < 6; i++) {                                  // charge runs DOWN the plate
        eReset();
        const an = er() * 6.2832;
        E.x = x + Math.cos(an) * 0.34 * s; E.y = py + er() * 0.5 * s; E.z = z + Math.sin(an) * 0.34 * s;
        E.vx = Math.cos(an) * 1.4; E.vy = -3.4 - er() * 3.2; E.vz = Math.sin(an) * 1.4;
        E.grav = 6; E.drag = 3.2; E.tile = T_SPARK; E.mode = 2;
        E.s0 = 0.055; E.s1 = 0.02; E.asp = 5 + er() * 5;
        E.r = 1.10; E.g = 0.86; E.b = 1.90; E.a = 0.9; E.life = 0.12 + er() * 0.10; E.fade = 2;
        E.lead = 0.01; push(BB);
      }
      eReset();                                                      // it spends itself in the earth
      E.x = x; E.y = gy + 0.10; E.z = z; E.tile = T_RING; E.mode = 1;
      E.s0 = 0.4 * s; E.s1 = 3.4 * s; E.r = 0.62; E.g = 0.42; E.b = 1.30;
      E.a = 0.30; E.life = 0.30; E.fade = 2; E.lead = 0.02; push(BB);
      eReset();
      E.x = x; E.y = gy + 0.07; E.z = z; E.tile = T_SOFT; E.mode = 1;
      E.s0 = 1.1 * s; E.s1 = 1.9 * s; E.r = 0.34; E.g = 0.24; E.b = 0.80;
      E.a = 0.22; E.life = 0.22; E.fade = 2; E.lead = 0.02; push(BB);
    } else {                                                         // pierce / crush glance off plate
      for (let i = 0; i < 5; i++) {
        eReset();
        const an = er() * 6.2832, sp = 5 + er() * 9;                 // TANGENTIAL, not out of a wound
        E.x = x; E.y = py; E.z = z;
        E.vx = Math.cos(an) * sp; E.vy = sp * (0.15 + er() * 0.45); E.vz = Math.sin(an) * sp;
        E.grav = 18; E.drag = 5.2; E.tile = T_SPARK; E.mode = 2;
        E.s0 = 0.06 * s; E.s1 = 0.025 * s; E.asp = 6 + er() * 7;
        E.r = 1.75; E.g = 1.70; E.b = 1.55; E.a = 1; E.life = 0.10 + er() * 0.10; E.fade = 2;
        E.lead = 0.01; push(BB);
      }
      eReset();                                                      // a hard little clang, no bloom
      E.x = x; E.y = py; E.z = z; E.tile = T_GLINT; E.s0 = 0.30 * s; E.s1 = 0.62 * s;
      E.r = 1.55; E.g = 1.52; E.b = 1.42; E.a = 0.62; E.life = 0.09; E.fade = 2;
      E.rot = er() * 6.28; E.lead = 0.01; push(BB);
    }
    return;
  }
  if (el === 'crush') {
    // A dull, WARM-GREY puff rather than a light: crush is mass. It is here at all because
    // the first pass had no core of any kind and, at the zoom the game is actually played
    // at, six stone chips half a metre wide are invisible — the school that answers plate
    // has to be the one you can see working from the build bar.
    eReset();
    E.x = x; E.y = py; E.z = z; E.tile = T_TUFT; E.s0 = 0.55 * s; E.s1 = 1.75 * s;
    E.r = 1.10; E.g = 0.94; E.b = 0.70; E.a = 0.60; E.life = 0.20; E.fade = 2;
    E.rot = er() * 6.28; E.rotV = es1() * 2.5; E.lead = 0.02; push(BB);
    eReset();                                                        // the blow, ground-aligned
    E.x = x; E.y = gy + 0.12; E.z = z; E.tile = T_RING; E.mode = 1;
    E.s0 = 0.6 * s; E.s1 = 3.7 * s; E.r = 0.94; E.g = 0.83; E.b = 0.62;
    E.a = 0.32; E.life = 0.30; E.fade = 2; E.lead = 0.02; push(BB);
    for (let i = 0; i < 7; i++) {                                    // chips off armour and bone
      eReset();
      const an = er() * 6.2832, sp = 3.5 + er() * 7;
      E.x = x + es1() * 0.2 * s; E.y = py; E.z = z + es1() * 0.2 * s;
      E.vx = Math.cos(an) * sp; E.vy = sp * (0.45 + er() * 0.8); E.vz = Math.sin(an) * sp;
      E.grav = 26; E.drag = 0.5; E.tile = T_CHUNK;
      E.s0 = (0.15 + er() * 0.17) * s; E.s1 = E.s0;
      E.r = 0.66; E.g = 0.60; E.b = 0.52; E.a = 1; E.life = 0.55 + er() * 0.4;
      E.rot = er() * 6.28; E.rotV = es1() * 10; E.lead = 0.02; push(BA);
    }
    for (let i = 0; i < 2; i++) {                                    // the dust it knocks loose
      eReset();
      const an = er() * 6.2832;
      E.x = x + Math.cos(an) * 0.35 * s; E.y = py - 0.2; E.z = z + Math.sin(an) * 0.35 * s;
      E.vx = Math.cos(an) * 2.2; E.vz = Math.sin(an) * 2.2; E.vy = 0.6; E.drag = 2.6;
      E.tile = T_DUST; E.mode = 1; E.s0 = 0.4 * s; E.s1 = 1.9 * s;
      E.r = 0.62; E.g = 0.55; E.b = 0.43; E.a = 0.30; E.life = 0.70 + er() * 0.4;
      E.rot = er() * 6.28; E.lead = 0.03; push(BA);
    }
  } else if (el === 'fire') {
    eReset();                                                        // ignition
    E.x = x; E.y = py; E.z = z; E.tile = T_FLASH; E.s0 = 0.5 * s; E.s1 = 1.35 * s;
    E.r = 2.30; E.g = 1.05; E.b = 0.30; E.a = 0.80; E.life = 0.12; E.fade = 2;
    E.rot = er() * 6.28; E.lead = 0.01; push(BB);
    for (let i = 0; i < 9; i++) {                                    // the ember burst
      eReset();
      const an = er() * 6.2832, sp = 2.5 + er() * 6;
      E.x = x + es1() * 0.2 * s; E.y = py + es1() * 0.25 * s; E.z = z + es1() * 0.2 * s;
      E.vx = Math.cos(an) * sp * 0.7; E.vy = 1.6 + er() * 3.4; E.vz = Math.sin(an) * sp * 0.7;
      E.grav = -0.7; E.drag = 1.5; E.tile = T_EMBER;
      E.s0 = (0.10 + er() * 0.09) * s; E.s1 = 0.02;
      E.r = 2.25; E.g = 0.95 + er() * 0.45; E.b = 0.20; E.a = 0.92; E.life = 0.55 + er() * 0.55;
      E.fade = 2; E.lead = 0.02; push(BB);
    }
    eReset();                                                        // greasy smoke off the burn
    E.x = x; E.y = py + 0.3; E.z = z;
    E.vx = WX * 1.2 + es1() * 0.4; E.vy = 1.3 + er() * 0.9; E.vz = WZ * 1.2 + es1() * 0.4;
    E.drag = 1.1; E.tile = er() < 0.6 ? T_SOOT : SMK(); E.s0 = 0.35 * s; E.s1 = 1.7 * s;
    E.r = 0.16; E.g = 0.13; E.b = 0.11; E.a = 0.34; E.life = 0.85 + er() * 0.5;
    E.rot = er() * 6.28; E.rotV = es1() * 1.2; E.lead = 0.05; push(BA);
  } else {                                                           // storm
    eReset();                                                        // hard white core
    E.x = x; E.y = py; E.z = z; E.tile = T_GLINT; E.s0 = 0.42 * s; E.s1 = 1.05 * s;
    E.r = 1.60; E.g = 1.40; E.b = 2.30; E.a = 0.92; E.life = 0.10; E.fade = 2;
    E.rot = er() * 6.28; E.lead = 0.01; push(BB);
    for (let i = 0; i < 7; i++) {                                    // the violet crack
      eReset();
      const an = er() * 6.2832, sp = 5 + er() * 12;
      E.x = x + es1() * 0.14 * s; E.y = py + es1() * 0.2 * s; E.z = z + es1() * 0.14 * s;
      E.vx = Math.cos(an) * sp * 0.85; E.vy = sp * (0.3 + er() * 0.85); E.vz = Math.sin(an) * sp * 0.85;
      E.grav = 15; E.drag = 4.6; E.tile = T_SPARK; E.mode = 2;
      E.s0 = 0.07 * s; E.s1 = 0.028 * s; E.asp = 6 + er() * 8;
      E.r = 1.55; E.g = 0.95; E.b = 2.55; E.a = 1; E.life = 0.11 + er() * 0.14; E.fade = 2;
      E.lead = 0.01; push(BB);
    }
    eReset();                                                        // violet bruise round the body
    E.x = x; E.y = py; E.z = z; E.tile = T_SOFT; E.s0 = 0.7 * s; E.s1 = 1.5 * s;
    E.r = 0.72; E.g = 0.24; E.b = 1.35; E.a = 0.30; E.life = 0.24; E.fade = 1;
    E.lead = 0.02; push(BB);
  }
};

// ── ogre stomp (SPEC2 §D) ────────────────────────────────────────────────────
// HOOK: VFX builder. A ground-hugging dust ring, a shallow dust decal and a handful of
// clods — deliberately EARTH only, no light: the ogre is muscle, not magic, and an
// additive flash at his feet would read as a spell. SIM calls this from ogreStomp().
VFX.stomp = (x, y, z) => {
  eseed((x * 149 + z * 83) | 0, (G.vt() * 811) | 0);
  decal(x, z, 5.6, 1, 0.72, 0.60, 0.52, 0.40, er());               // shockwave in the grass
  // VFX-2: the dust alone had no ATTACK — a ring of puffs simply grew where the foot
  // fell. One ground-aligned ring quad snapping outward in a third of a second is what
  // sells the blow; kept dim and warm-grey (NOT additive-bright) so it stays earth.
  eReset();
  E.x = x; E.y = y + 0.16; E.z = z; E.tile = T_RING; E.mode = 1;
  E.s0 = 1.1; E.s1 = 7.4; E.r = 0.92; E.g = 0.80; E.b = 0.58;
  E.a = 0.34; E.life = 0.34; E.fade = 2; E.lead = 0.01; push(BB);
  for (let i = 0; i < 12; i++) {                                    // low ring of dust
    eReset();
    const an = i / 12 * 6.2832 + er() * 0.5, sp = 4.2 + er() * 4.0;
    E.x = x + Math.cos(an) * 0.7; E.y = y + 0.22 + er() * 0.25; E.z = z + Math.sin(an) * 0.7;
    E.vx = Math.cos(an) * sp; E.vz = Math.sin(an) * sp; E.vy = 0.5 + er() * 0.6; E.drag = 2.6;
    E.tile = T_DUST; E.mode = 1; E.s0 = 0.85; E.s1 = 3.6 + er() * 1.2;
    E.r = 0.60; E.g = 0.52; E.b = 0.39; E.a = 0.40; E.life = 1.15 + er() * 0.7;
    E.rot = er() * 6.28; E.rotV = es1() * 0.8; E.lead = 0.03 + er() * 0.10; push(BA);
  }
  for (let i = 0; i < 9; i++) {                                     // clods kicked loose
    eReset();
    const an = er() * 6.2832, sp = 3.5 + er() * 7;
    E.x = x + Math.cos(an) * 0.45; E.y = y + 0.3; E.z = z + Math.sin(an) * 0.45;
    E.vx = Math.cos(an) * sp; E.vy = sp * (0.5 + er() * 0.9); E.vz = Math.sin(an) * sp;
    E.grav = 26; E.drag = 0.4; E.tile = T_CHUNK;
    E.s0 = 0.16 + er() * 0.22; E.s1 = E.s0;
    E.r = 0.72; E.g = 0.64; E.b = 0.52; E.a = 1;
    E.life = 0.7 + er() * 0.5; E.rot = er() * 6.28; E.rotV = es1() * 9; E.lead = 0.02; push(BA);
  }
};

// ── war shaman's chant (SPEC3 §B) ────────────────────────────────────────────
// HOOK: ROSTER → VFX. SIM calls this only on the ticks the chant actually MENDS someone,
// so the glow is a read-out of a live effect rather than an idle aura. Deliberately COLD
// green-white and additive: nothing else on the road is that hue, so "there is a healer in
// that group" is a colour cue you can act on before you have read a single health bar.
// The ring is ground-aligned at the heal radius — it draws the exact area under threat.
// VFX/AUDIO-3: retuned from the placeholder. Two changes that matter. (1) GREEN-GOLD, not
// green-white: at 0.42/1.55/0.86 the aura read as a cold sci-fi shield over a medieval
// road, and the one hue nothing else in BANNERFALL owns is a warm chant-green that leans
// gold as it lifts — so the motes are born green and DIE gold. (2) The ring is drawn at the
// true heal radius and held long enough to overlap the next pulse (SIM chants every 12
// ticks = 0.4 s, the ring lives 0.66), so while the shaman is mending, the ground under
// everything he is mending is continuously lit. That circle is the kill order.
VFX.heal = (x, y, z, rad) => {
  const R = rad || 8;
  eseed((x * 197 + z * 61) | 0, (G.vt() * 653) | 0);
  // THE RING IS A BOUNDARY, NOT A SHOCKWAVE. It barely moves (r7 → r8.3 over two thirds of
  // a second) because its job is to say "everything inside this circle is being mended" —
  // a ring that races outward like VFX.stomp's reads as a blow landing, which is the exact
  // opposite of what a healer is doing. T_RING's bright band sits at ~0.83 of the quad, so
  // the multipliers are chosen against the TRUE heal radius, not eyeballed.
  eReset();                                                         // the area of effect
  // Floated 0.7 above the ground rather than laid on it: a 16-unit ground-aligned quad on a
  // banked road buries most of its own circumference in the terrain, which turned the ring
  // into a lopsided wedge. At this camera pitch 0.7 still reads as a mark on the ground.
  E.x = x; E.y = y + 0.70; E.z = z; E.tile = T_RING; E.mode = 1;
  E.s0 = R * 1.05; E.s1 = R * 1.25; E.r = 0.38; E.g = 1.70; E.b = 0.26;
  E.a = 0.40; E.life = 0.66; E.fade = 1; E.lead = 0.02; push(BB);
  eReset();                                                         // a small pool at his feet
  E.x = x; E.y = y + 0.07; E.z = z; E.tile = T_SOFT; E.mode = 1;
  E.s0 = R * 0.16; E.s1 = R * 0.30; E.r = 0.42; E.g = 0.95; E.b = 0.26;
  E.a = 0.20; E.life = 0.50; E.fade = 1; E.lead = 0.02; push(BB);
  eReset();                                                         // the caster himself
  E.x = x; E.y = y + 1.15; E.z = z; E.tile = T_FLASH;
  E.s0 = 0.50; E.s1 = 1.40; E.r = 0.95; E.g = 2.10; E.b = 0.70;
  E.a = 0.55; E.life = 0.46; E.fade = 1; E.rot = er() * 6.28; E.lead = 0.02; push(BB);
  for (let i = 0; i < 9; i++) {                                     // motes rising off the staff
    eReset();
    const an = i / 9 * 6.2832 + er() * 0.7, rr = 0.30 + er() * 1.0;
    E.x = x + Math.cos(an) * rr; E.y = y + 0.30 + er() * 0.7; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * 0.45; E.vz = Math.sin(an) * 0.45; E.vy = 1.4 + er() * 1.5; E.drag = 1.7;
    E.grav = -0.35; E.tile = er() < 0.28 ? T_GLINT : T_MOTE;
    E.s0 = 0.14 + er() * 0.10; E.s1 = 0.04;
    E.r = 0.78 + er() * 0.45; E.g = 1.95; E.b = 0.62; E.a = 0.82; E.life = 0.75 + er() * 0.55;
    E.fade = 2; E.rot = er() * 6.28; E.rotV = es1() * 2.5; E.lead = 0.02 + er() * 0.07; push(BB);
  }
};

// ── chain-lightning strike (SPEC2 §C) ────────────────────────────────────────
// One call per HOP, from SIM's chainLightning(), landing where TOWERS' bolt ribbon ends.
// Three layers: a hard white core so the strike has a point, a cone of cold sparks kicked
// AWAY from the arc's arrival, and a soft envelope round the body that swells and dies
// (fade mode 1) — that envelope is the "this one is being electrocuted" read at gameplay
// zoom, where a 70 ms ribbon and a spark spray are both too small to parse.
// TINT GOTCHA: the additive bucket runs uSunC/uSkyC = white, so these numbers are raw
// radiance. Blue past ~2.6 clips to a violet-white blob under ACES + bloom.
VFX.zapHit = (x, y, z, hop, e) => {
  const gy = G.groundY(x, z);
  // SPEC3 §A/§B: an ironclad is storm .85. Lighting one up like a struck man is a LIE —
  // the arc reached it and did nothing. VFX.hit's deflection path already draws exactly
  // that (charge running down the plate, spending itself in the earth), so the strike
  // defers to it and skips its own body glow entirely.
  if (e && e.def && G.resistOf(e.def, 'storm') >= SHRUG_AT) { VFX.hit(x, y - gy, z, 'storm', 1, e); return; }
  eseed((x * 173 + z * 59) | 0, ((G.vt() * 907) | 0) + (hop | 0) * 131);
  eReset();                                                        // core
  E.x = x; E.y = y; E.z = z; E.tile = T_FLASH; E.s0 = 0.42; E.s1 = 1.25;
  E.r = 1.30; E.g = 1.80; E.b = 2.55; E.a = 0.92; E.life = 0.12; E.fade = 2;
  E.rot = er() * 6.28; E.lead = 0.01; push(BB);
  for (let i = 0; i < 8; i++) {                                    // arc-shatter sparks
    eReset();
    const an = er() * 6.2832, sp = 5 + er() * 13;
    E.x = x + es1() * 0.15; E.y = y + es1() * 0.2; E.z = z + es1() * 0.15;
    E.vx = Math.cos(an) * sp * 0.8; E.vy = sp * (0.35 + er() * 0.9); E.vz = Math.sin(an) * sp * 0.8;
    E.grav = 15; E.drag = 4.6; E.tile = T_SPARK; E.mode = 2;
    E.s0 = 0.075; E.s1 = 0.03; E.asp = 6 + er() * 8;
    E.r = 1.15; E.g = 1.85; E.b = 2.60; E.a = 1; E.life = 0.12 + er() * 0.16; E.fade = 2;
    E.lead = 0.01; push(BB);
  }
  eReset();                                                        // body envelope
  E.x = x; E.y = gy + 0.95; E.z = z; E.tile = T_SOFT;
  E.s0 = 1.05; E.s1 = 1.70; E.r = 0.20; E.g = 0.50; E.b = 1.30;
  E.a = 0.34; E.life = 0.30; E.fade = 1; E.lead = 0.02; push(BB);
  eReset();                                                        // grounding ring at the feet
  // KEPT THIN AND SHORT. At the first pass's weight (a 3 u hoop at 0.34) three struck
  // bodies wore three white donuts and the frame read as a selection UI, not a strike.
  E.x = x; E.y = gy + 0.10; E.z = z; E.tile = T_RING; E.mode = 1;
  E.s0 = 0.5; E.s1 = 2.3; E.r = 0.40; E.g = 0.80; E.b = 1.55;
  E.a = 0.20; E.life = 0.22; E.fade = 2; E.lead = 0.02; push(BB);
  if (er() < 0.6) {                                                // singed cloth
    eReset();
    E.x = x + es1() * 0.3; E.y = gy + 0.9 + er() * 0.5; E.z = z + es1() * 0.3;
    E.vx = WX * 0.8 + es1() * 0.4; E.vy = 1.1 + er() * 0.8; E.vz = WZ * 0.8 + es1() * 0.4;
    E.drag = 1.4; E.tile = SMK(); E.s0 = 0.30; E.s1 = 1.35;
    E.r = 0.34; E.g = 0.33; E.b = 0.36; E.a = 0.34; E.life = 0.85 + er() * 0.5;
    E.rot = er() * 6.28; E.rotV = es1() * 1.2; E.lead = 0.04; push(BA);
  }
};

// ── marauder arrow (SPEC2 §D) ────────────────────────────────────────────────
// ENEMIES-2 shipped the skirmisher with real ranged damage and NO projectile, so a
// melting knight had no visible cause. SIM calls this once per loosed arrow (every 18
// ticks per unit, staggered by id). The streak is a mode-2 screen-space ribbon flying
// the real line; the hit sparks are born with a NEGATIVE lead so they land when the
// arrow arrives instead of the instant it leaves the bow.
VFX.arrow = (x0, y0, z0, x1, y1, z1) => {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  // Flight time is deliberately slower than a real arrow: the skirmisher looses once every
  // 0.6 s, so at true arrow speed the streak exists for two frames out of eighteen and the
  // player never sees a cause. 7 u of range reads as ~0.2 s of travel.
  const L = Math.hypot(dx, dy, dz) || 1, T = clamp(L / 34, 0.10, 0.30);
  if (SHOT && P.has('dbg')) console.log('ARROWFX t=' + G.vt().toFixed(2) + ' from=' + x0.toFixed(1) + ',' + y0.toFixed(1) + ',' + z0.toFixed(1) + ' to=' + x1.toFixed(1) + ',' + y1.toFixed(1) + ',' + z1.toFixed(1));
  eseed((x0 * 61 + z0 * 137) | 0, (G.vt() * 523) | 0);
  eReset();
  E.x = x0; E.y = y0; E.z = z0;
  E.vx = dx / T; E.vy = dy / T + L * 0.05; E.vz = dz / T;           // a touch of loft
  E.grav = L * 0.10; E.drag = 0; E.tile = T_SPARK; E.mode = 2;
  // LONG and bright: a marauder often stands only 3 u off the knight it is shooting, and
  // that shot happens INSIDE a scrum of thirty bodies. A short dim streak simply does not
  // survive the clutter — at ~2 u the tracer spans most of the flight and reads.
  E.s0 = 0.125; E.s1 = 0.105; E.asp = 15;
  E.r = 2.20; E.g = 1.90; E.b = 1.30; E.a = 1; E.life = T; E.fade = 2; push(BB);
  for (let i = 0; i < 3; i++) {                                    // strike on the shield
    eReset();
    const an = er() * 6.2832, sp = 3.5 + er() * 7;
    E.x = x1; E.y = y1; E.z = z1;
    E.vx = Math.cos(an) * sp * 0.7 - dx / L * 3; E.vy = sp * (0.3 + er() * 0.7); E.vz = Math.sin(an) * sp * 0.7 - dz / L * 3;
    E.grav = 16; E.drag = 4.4; E.tile = T_SPARK; E.mode = 2;
    E.s0 = 0.06; E.s1 = 0.025; E.asp = 5 + er() * 6;
    E.r = 2.4; E.g = 1.85; E.b = 0.95; E.a = 1; E.life = 0.11 + er() * 0.1; E.fade = 2;
    E.lead = -T; push(BB);
  }
  eReset();
  E.x = x1; E.y = y1; E.z = z1; E.tile = T_FLASH; E.s0 = 0.22; E.s1 = 0.60;
  E.r = 2.1; E.g = 1.7; E.b = 1.05; E.a = 0.7; E.life = 0.09; E.fade = 2;
  E.rot = er() * 6.28; E.lead = -T; push(BB);
};

// ── warbanner raised (SPEC2 §C) ──────────────────────────────────────────────
// A support tower has no muzzle flash to sell it, so the moment it is planted the whole
// aura has to announce itself once: a blue ground pulse out to the real aura radius (so
// the player learns the shape), a flash at the standard's head and a lift of pennant
// scraps. The standing glow is the per-tick emitter further down — this is the attack.
VFX.banner = (x, z, rad) => {
  const gy = G.groundY(x, z), R = rad || 9;
  eseed((x * 211 + z * 97) | 0, (G.vt() * 617) | 0);
  // LEADS, as in VFX.explosion: the pulse is a one-shot, so without back-dating it the
  // very first rendered frame catches a ring of radius zero. 0.3 s in, it is a hoop
  // halfway to the aura edge — which is the frame worth looking at.
  decal(x, z, R, 1, 1.05, 0.30, 0.46, 0.92, er(), 0.34);           // pulse out to the aura edge
  eReset();
  E.x = x; E.y = gy + 0.14; E.z = z; E.tile = T_RING; E.mode = 1;
  E.s0 = 2.0; E.s1 = R * 2.0; E.r = 0.46; E.g = 0.72; E.b = 1.45;
  E.a = 0.45; E.life = 0.85; E.fade = 2; E.lead = 0.30; push(BB);
  eReset();                                                        // light at the standard's head
  E.x = x; E.y = gy + 7.4; E.z = z; E.tile = T_FLASH; E.s0 = 1.5; E.s1 = 3.4;
  E.r = 1.30; E.g = 1.55; E.b = 2.10; E.a = 0.70; E.life = 0.42; E.fade = 2;
  E.rot = er() * 6.28; E.lead = 0.16; push(BB);
  for (let i = 0; i < 12; i++) {                                   // rising heraldic sparks
    eReset();
    const an = er() * 6.2832, rr = er() * 2.2;
    E.x = x + Math.cos(an) * rr; E.y = gy + 0.6 + er() * 5.5; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * 0.8 + WX * 0.6; E.vy = 2.4 + er() * 2.6; E.vz = Math.sin(an) * 0.8 + WZ * 0.6;
    E.drag = 1.2; E.grav = -0.4; E.tile = er() < 0.4 ? T_GLINT : T_MOTE;
    E.s0 = 0.22 + er() * 0.20; E.s1 = 0.05;
    E.r = 0.85; E.g = 1.25; E.b = 2.10; E.a = 0.9; E.life = 0.9 + er() * 0.8; E.fade = 2;
    E.rot = er() * 6.28; E.rotV = es1() * 4; E.lead = er() * 0.20; push(BB);
  }
  for (let i = 0; i < 5; i++) {                                    // dust knocked off the base
    eReset();
    const an = er() * 6.2832;
    E.x = x + Math.cos(an) * 1.3; E.y = gy + 0.28; E.z = z + Math.sin(an) * 1.3;
    E.vx = Math.cos(an) * 2.6; E.vz = Math.sin(an) * 2.6; E.vy = 0.5; E.drag = 2.4;
    E.tile = T_DUST; E.mode = 1; E.s0 = 0.7; E.s1 = 3.0;
    E.r = 0.72; E.g = 0.64; E.b = 0.50; E.a = 0.30; E.life = 1.1 + er() * 0.5;
    E.rot = er() * 6.28; E.lead = 0.04; push(BA);
  }
};

// ── directional arrow / bolt impact (sparks kick back along the shaft) ────────
VFX.impact = (x, y, z, dx, dy, dz, s) => {
  eseed((x * 71 + z * 113) | 0, (G.vt() * 997) | 0);
  const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L;
  for (let i = 0; i < 7; i++) {
    eReset();
    E.x = x; E.y = y; E.z = z;
    const sp = 6 + er() * 15;
    E.vx = (-dx + es1() * 0.85) * sp; E.vy = (-dy * 0.5 + 0.55 + er() * 0.8) * sp; E.vz = (-dz + es1() * 0.85) * sp;
    E.grav = 16; E.drag = 4.2; E.tile = T_SPARK; E.mode = 2;
    E.s0 = 0.085 * s; E.s1 = 0.04 * s; E.asp = 6 + er() * 9;
    E.r = 2.6; E.g = 1.9; E.b = 0.85; E.a = 1; E.life = 0.13 + er() * 0.18; E.fade = 2; E.lead = 0.02;
    push(BB);
  }
  eReset();
  E.x = x; E.y = y; E.z = z; E.tile = T_TUFT; E.s0 = 0.5 * s; E.s1 = 1.5 * s;
  E.r = 2.0; E.g = 1.6; E.b = 1.0; E.a = 0.8; E.life = 0.18; E.fade = 2; E.rot = er() * 6.28;
  E.lead = 0.02; push(BB);
  eReset();
  E.x = x; E.y = y; E.z = z; E.vy = 1.1; E.drag = 2.4; E.tile = T_DUST;
  E.s0 = 0.45 * s; E.s1 = 1.5 * s; E.r = 0.72; E.g = 0.62; E.b = 0.46; E.a = 0.3; E.life = 0.55;
  E.rot = er() * 6.28; E.rotV = es1() * 1.6; E.lead = 0.04; push(BA);
};

// ── catapult impact ──────────────────────────────────────────────────────────
// Deliberately DIRT-led, not light-led: the hero read is an earth fountain and a
// smoke column, with the fireball only a small hot base. Additive light is kept on a
// short leash — stacked additive quads saturate to white instantly under ACES and the
// first pass of this effect looked like a nuclear flash, not a boulder strike.
// EJECTA PALETTE: a blast throws up the ground it lands ON. The Vale's warm tan fountain
// dropped unchanged onto Frostfell reads as mud smeared across a white field — it was the
// loudest wrong note in shots\battle2.png, and the critic took it for a burn decal. Snow
// ejecta is pale and neutral; Ember's is a shade sootier than the Vale's.
const EJ = (id => id === 2 ? [1.50, 1.85, 2.50] : id === 3 ? [0.95, 0.90, 0.82] : null)((G.MAP && G.MAP.id) || 1);
VFX.explosion = (x, y, z, power) => {
  const p = power || 1, gy = G.groundY(x, z);
  eseed((x * 131 + z * 61) | 0, (G.vt() * 733) | 0);
  VFX.shakeAt(x, gy, z, 1.25 * p);
  decal(x, z, 6.2 * p, 0, 20, 0.052, 0.042, 0.033, er());          // scorch, ~20 s
  decal(x, z, 11 * p, 1, 0.95, 0.72, 0.62, 0.46, er());            // ground shockwave

  claimBlast(x, gy + 1.2 * p, z, p);                               // light the neighbours
  // The T_FLASH star is the SPARK, not the fireball. At 2.3/1.55/0.72 and 2.9 u it blew
  // to flat 255 white with radial spikes under ACES and read as a UI sparkle; dimmed and
  // shrunk it is a small hot centre and the T_SOFT ball below is the visible body, so the
  // silhouette is an orange volume rather than a white star.
  eReset();                                                        // hot base flash
  E.x = x; E.y = gy + 0.8 * p; E.z = z; E.tile = T_FLASH;
  E.s0 = 0.95 * p; E.s1 = 2.1 * p; E.r = 1.50; E.g = 0.85; E.b = 0.35;
  E.a = 0.90; E.life = 0.17; E.lead = 0.05; E.fade = 2; E.rot = er() * 6.28; push(BB);
  eReset();                                                        // fireball core
  E.x = x; E.y = gy + 1.1 * p; E.z = z; E.tile = T_SOFT;
  E.s0 = 1.35 * p; E.s1 = 3.9 * p; E.r = 1.85; E.g = 0.72; E.b = 0.18;
  E.a = 0.88; E.life = 0.40; E.lead = 0.10; E.fade = 2; push(BB);
  // POLISH: without this the plume's base is the same cold grey as its apex and the whole
  // effect read as a dust devil with a spark in it. One wide, dim, short-lived glow puts
  // firelight inside the bottom of the column.
  eReset();
  E.x = x; E.y = gy + 1.5 * p; E.z = z; E.tile = T_SOFT;
  E.s0 = 2.6 * p; E.s1 = 6.0 * p; E.r = 0.95; E.g = 0.42; E.b = 0.12;
  E.a = 0.38; E.life = 0.62; E.lead = 0.16; E.fade = 2; push(BB);
  // EARTH FOUNTAIN — the hero element, and the reason this effect reads as a boulder
  // strike rather than a light show. Kept DARK and brown on purpose: the particle shader
  // ramps every quad toward the sun colour at its top edge and the atlas art is already
  // near-white, so a nominally "grey smoke" tint comes out pale sand. Earth needs a base
  // weight around 0.2, not 0.5. Leads are staggered 0.12..0.62 s so the fountain is a
  // continuous column from the crater to its apex on the very first rendered frame.
  for (let i = 0; i < 38; i++) {
    eReset();
    const an = er() * 6.2832, lat = (0.4 + er() * 3.4) * p, up = (13 + er() * 21) * p;
    E.x = x + Math.cos(an) * er() * 1.0 * p; E.y = gy + 0.35; E.z = z + Math.sin(an) * er() * 1.0 * p;
    E.vx = Math.cos(an) * lat; E.vy = up; E.vz = Math.sin(an) * lat;
    E.grav = 15; E.drag = 0.50;
    const lit = er() < 0.26;
    E.tile = er() < 0.45 ? T_SOOT : SMK();
    E.s0 = (1.05 + er() * 1.10) * p; E.s1 = E.s0 * (2.4 + er() * 1.5);
    const w = lit ? 0.52 : 0.20 + er() * 0.13;
    E.r = w; E.g = w * (lit ? 0.82 : 0.76); E.b = w * (lit ? 0.58 : 0.55);
    if (EJ && !lit) { E.r *= EJ[0]; E.g *= EJ[1]; E.b *= EJ[2]; }   // fire-lit dirt stays warm
    E.a = 0.92 + er() * 0.08; E.life = 1.30 + er() * 1.20;
    E.rot = er() * 6.28; E.rotV = es1() * 1.5; E.lead = 0.12 + er() * 0.50;
    push(BA);
  }
  for (let i = 0; i < 22; i++) {                                   // tumbling debris chunks
    eReset();
    const an = er() * 6.2832, sp = (7 + er() * 17) * p;
    E.x = x + Math.cos(an) * 0.4; E.y = gy + 0.45; E.z = z + Math.sin(an) * 0.4;
    E.vx = Math.cos(an) * sp; E.vy = sp * (0.60 + er() * 1.30); E.vz = Math.sin(an) * sp;
    E.grav = 28; E.drag = 0.30; E.tile = T_CHUNK;
    E.s0 = (0.26 + er() * 0.52) * p; E.s1 = E.s0;
    E.r = 0.90; E.g = 0.86; E.b = 0.82; E.a = 1;
    E.life = 0.90 + er() * 0.75; E.rot = er() * 6.28; E.rotV = es1() * 11; E.lead = 0.15 + er() * 0.14;
    push(BA);
  }
  for (let i = 0; i < 16; i++) {                                   // embers
    eReset();
    const an = er() * 6.2832, sp = (5 + er() * 13) * p;
    E.x = x; E.y = gy + 0.6; E.z = z;
    E.vx = Math.cos(an) * sp; E.vy = sp * (0.55 + er() * 1.25); E.vz = Math.sin(an) * sp;
    E.grav = 13; E.drag = 1.5; E.tile = T_EMBER;
    E.s0 = 0.14 + er() * 0.20; E.s1 = 0.05;
    E.r = 2.3; E.g = 0.95 + er() * 0.5; E.b = 0.24; E.a = 1;
    E.life = 0.5 + er() * 0.9; E.lead = 0.12; E.fade = 2; push(BB);
  }
  // low dirt fan: ground-aligned so it never intersects the terrain. Spawned on a ring
  // rather than at the centre — concentric quads at the impact point collapse into one
  // flat pale disc, which is what made the first pass read as a decal, not a blast.
  for (let i = 0; i < 10; i++) {
    eReset();
    const an = er() * 6.2832, rr = (1.4 + er() * 3.4) * p, sp = (3 + er() * 7) * p;
    E.x = x + Math.cos(an) * rr; E.y = gy + 0.30 + er() * 0.40; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * sp; E.vz = Math.sin(an) * sp; E.vy = 0.4; E.drag = 2.3;
    E.tile = T_DUST; E.mode = 1; E.s0 = 1.5 * p; E.s1 = 6.0 * p;
    E.r = 0.62; E.g = 0.53; E.b = 0.39; E.a = 0.40; E.life = 1.7 + er() * 0.9;
    if (EJ) { E.r *= EJ[0]; E.g *= EJ[1]; E.b *= EJ[2]; }
    E.rot = er() * 6.28; E.rotV = es1() * 0.7; E.lead = 0.18 + er() * 0.20; push(BA);
  }
  for (let i = 0; i < 16; i++) {                                   // lingering smoke column
    eReset();
    const an = er() * 6.2832, rr = er() * 1.8 * p;
    E.x = x + Math.cos(an) * rr; E.y = gy + (1.5 + er() * 7.5) * p; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * (0.4 + er() * 1.3) + WX * 1.1; E.vy = 2.2 + er() * 3.0; E.vz = Math.sin(an) * (0.4 + er() * 1.3) + WZ * 1.1;
    E.drag = 0.80; E.grav = -0.30;
    E.tile = er() < 0.5 ? T_SOOT : SMK();
    E.s0 = (1.2 + er() * 1.5) * p; E.s1 = (5.4 + er() * 4.6) * p;
    const w = 0.17 + er() * 0.13;
    E.r = w; E.g = w * 0.85; E.b = w * 0.68; E.a = 0.78 + er() * 0.22;
    // The column keeps its smoke weight — only its HUE follows the ground, so a Frostfell
    // plume is cold grey rather than a tan cloud parked over a white valley.
    if (EJ) { const m = 3 / (EJ[0] + EJ[1] + EJ[2]); E.r *= EJ[0] * m; E.g *= EJ[1] * m; E.b *= EJ[2] * m; }
    E.life = 2.6 + er() * 3.0; E.rot = er() * 6.28; E.rotV = es1() * 0.85; E.lead = 0.22 + er() * 0.45;
    push(BA);
  }
};

// ── burning ground (HOOK for TOWERS-2 / SPEC2 §C) ─────────────────────────────
// The pyre's fire pot shatters and sets the ground alight. SIM owns the patch (damage,
// lifetime) and TOWERS draws the standing flames; this is the one-shot dressing —
// scorch decal, a gout of fire, thrown embers and an oily smoke curl. Deliberately
// modest: VFX-2 owns the upgrade (a proper spreading fire and lit smoke).
VFX.firePatch = (x, z, rad) => {
  const gy = G.groundY(x, z), R = rad || 3;
  eseed((x * 197 + z * 89) | 0, (G.vt() * 811) | 0);
  decal(x, z, R * 1.35, 0, 9.5, 0.070, 0.050, 0.038, er());        // scorched ring
  eReset();                                                        // ignition flash — kept
  E.x = x; E.y = gy + 0.5; E.z = z; E.tile = T_FLASH;              // SMALL: a wide additive
  E.s0 = R * 0.26; E.s1 = R * 0.62; E.r = 1.7; E.g = 0.86; E.b = 0.30;   // flash on open ground
  E.a = 0.55; E.life = 0.14; E.fade = 2; E.rot = er() * 6.28; E.lead = 0.02; push(BB);
  for (let i = 0; i < 9; i++) {                                    // fire licking outward
    eReset();
    const an = er() * 6.2832, rr = er() * R * 0.85;
    E.x = x + Math.cos(an) * rr; E.y = gy + 0.30; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * (0.8 + er() * 1.6); E.vy = 2.2 + er() * 2.4; E.vz = Math.sin(an) * (0.8 + er() * 1.6);
    E.drag = 1.6; E.grav = -1.2; E.tile = T_SOFT;
    E.s0 = 0.42 + er() * 0.34; E.s1 = 1.15 + er() * 0.7;
    E.r = 1.55; E.g = 0.55; E.b = 0.14; E.a = 0.52; E.life = 0.55 + er() * 0.5; E.fade = 2;
    E.lead = er() * 0.16; push(BB);
  }
  for (let i = 0; i < 14; i++) {                                   // embers spat out
    eReset();
    const an = er() * 6.2832, sp = 3 + er() * 9;
    E.x = x; E.y = gy + 0.35; E.z = z;
    E.vx = Math.cos(an) * sp; E.vy = sp * (0.5 + er() * 1.1); E.vz = Math.sin(an) * sp;
    E.grav = 12; E.drag = 1.6; E.tile = T_EMBER;
    E.s0 = 0.11 + er() * 0.14; E.s1 = 0.04;
    E.r = 2.4; E.g = 1.0 + er() * 0.45; E.b = 0.22; E.a = 1;
    E.life = 0.6 + er() * 1.0; E.fade = 2; E.lead = 0.03 + er() * 0.1; push(BB);
  }
  for (let i = 0; i < 7; i++) {                                    // oily smoke off the pitch
    eReset();
    const an = er() * 6.2832, rr = er() * R * 0.7;
    E.x = x + Math.cos(an) * rr; E.y = gy + 0.8 + er() * 1.2; E.z = z + Math.sin(an) * rr;
    E.vx = WX * 1.2 + es1() * 0.5; E.vy = 1.6 + er() * 1.5; E.vz = WZ * 1.2 + es1() * 0.5;
    E.drag = 0.9; E.grav = -0.35; E.tile = er() < 0.6 ? T_SOOT : SMK();
    E.s0 = 0.9 + er() * 0.9; E.s1 = 3.2 + er() * 2.2;
    const w = 0.15 + er() * 0.10;
    E.r = w; E.g = w * 0.84; E.b = w * 0.70; E.a = 0.62; E.life = 1.6 + er() * 1.6;
    E.rot = er() * 6.28; E.rotV = es1() * 0.8; E.lead = 0.10 + er() * 0.5; push(BA);
  }
};
G.firePatch = VFX.firePatch;

// ── per-archetype death: dust collapse, gear glints, thud ring, coin ──────────
// SPEC2 §D/§E roster. `hound` takes its own short branch (see below) and the boss
// VARIANTS inherit the warlord's weight but carry their palette into the debris, so a
// Frost Matriarch does not fall in the Warlord's warm dust.
const U_H = { grunt: 1.80, runner: 1.63, brute: 2.52, boss: 3.90,
              shield: 1.92, marauder: 1.78, hound: 0.98, ogre: 3.10,
              matriarch: 4.30, emberlord: 3.95, cinderqueen: 3.40,
              // SPEC3 §B — real model heights, so the newcomers shed their gear from the
              // right altitude instead of from a guess off `def.scale`
              ironclad: 2.34, ashwraith: 1.74, frostrevenant: 1.98, warshaman: 1.74, ram: 2.34 };
VFX.death = (e) => {
  const x = e.px, z = e.pz, gy = G.groundY(x, z);
  const h = U_H[e.type] || (e.def.scale || 1) * 1.6, big = h > 3 ? 2.4 : h > 2.2 ? 1.5 : 1;
  eseed(e.id * 2654435761, (G.vt() * 631) | 0);
  // HOUND: a light body at a dead run. No gear to shed and no weight to land with — it
  // trips, throws a low skid of dust forward and leaves a tuft of coat in the air. Kept
  // to five particles: a pack burst is thirty of these inside two seconds.
  if (e.type === 'hound') {
    for (let i = 0; i < 3; i++) {
      eReset();
      const an = er() * 6.2832;
      E.x = x + Math.cos(an) * 0.35; E.y = gy + 0.18 + er() * 0.2; E.z = z + Math.sin(an) * 0.35;
      E.vx = Math.cos(an) * (2.0 + er() * 2.2); E.vz = Math.sin(an) * (2.0 + er() * 2.2);
      E.vy = 0.4 + er() * 0.5; E.drag = 3.0;
      E.tile = T_DUST; E.mode = 1; E.s0 = 0.30; E.s1 = 1.5 + er() * 0.7;
      E.r = 0.76; E.g = 0.65; E.b = 0.47; E.a = 0.32; E.life = 0.55 + er() * 0.35;
      E.rot = er() * 6.28; E.lead = 0.03; push(BA);
    }
    for (let i = 0; i < 2; i++) {                                  // coat tuft
      eReset();
      E.x = x + es1() * 0.3; E.y = gy + 0.55 + er() * 0.4; E.z = z + es1() * 0.3;
      E.vx = es1() * 1.6 + WX * 0.8; E.vy = 1.3 + er() * 1.1; E.vz = es1() * 1.6 + WZ * 0.8;
      E.grav = 3.2; E.drag = 2.0; E.tile = T_TUFT;
      E.s0 = 0.26 + er() * 0.16; E.s1 = 0.62;
      E.r = 0.52; E.g = 0.40; E.b = 0.30; E.a = 0.55; E.life = 0.5 + er() * 0.4;
      E.rot = er() * 6.28; E.rotV = es1() * 5; E.lead = 0.02; push(BA);
    }
    if (er() < 0.30) VFX.coin(x, gy + 0.8, z);
    return;
  }
  const TC = e.def.tint;                                          // boss-variant palette
  for (let i = 0; i < (big > 2 ? 12 : big > 1.2 ? 6 : 3); i++) {   // ground dust collapse
    eReset();
    const an = er() * 6.2832, rr = er() * 0.7 * big;
    E.x = x + Math.cos(an) * rr; E.y = gy + 0.25 + er() * 0.4 * big; E.z = z + Math.sin(an) * rr;
    E.vx = Math.cos(an) * (1.4 + er() * 2.6) * big; E.vz = Math.sin(an) * (1.4 + er() * 2.6) * big;
    E.vy = 0.5 + er() * 0.8; E.drag = 2.6;
    E.tile = er() < 0.5 ? T_DUST : SMK(); E.mode = er() < 0.55 ? 1 : 0;
    E.s0 = 0.5 * big; E.s1 = (2.2 + er() * 1.5) * big;
    E.r = 0.74; E.g = 0.63; E.b = 0.45; E.a = 0.38 + er() * 0.14;
    E.life = 0.9 + er() * 0.8; E.rot = er() * 6.28; E.rotV = es1() * 1.1; E.lead = 0.04;
    push(BA);
  }
  for (let i = 0; i < (big > 1.2 ? 5 : 2); i++) {                  // falling gear glints
    eReset();
    E.x = x + es1() * 0.4; E.y = gy + h * (0.5 + er() * 0.45); E.z = z + es1() * 0.4;
    E.vx = es1() * 2.6; E.vy = 1.4 + er() * 3.2; E.vz = es1() * 2.6;
    E.grav = 17; E.drag = 0.5; E.tile = T_GLINT;
    E.s0 = 0.30 + er() * 0.26; E.s1 = 0.16;
    E.r = 2.1 * (TC ? TC[0] : 1); E.g = 1.95 * (TC ? TC[1] : 1); E.b = 1.6 * (TC ? TC[2] : 1); E.a = 0.95;
    E.life = 0.55 + er() * 0.5; E.fade = 2; E.rot = er() * 6.28; E.rotV = es1() * 7; E.lead = 0.05;
    push(BB);
  }
  if (big > 1.2) {                                                 // brute / boss land hard
    VFX.shakeAt(x, gy, z, big > 2 ? 0.60 : 0.20);
    eReset();
    E.x = x; E.y = gy + 0.35; E.z = z; E.tile = T_RING; E.mode = 1;
    E.s0 = 1.4 * big; E.s1 = 8 * big;
    E.r = 1.15 * (TC ? TC[0] : 1); E.g = 1.02 * (TC ? TC[1] : 1); E.b = 0.82 * (TC ? TC[2] : 1);
    E.a = 0.42; E.life = 0.6; E.fade = 2; E.lead = 0.05; push(BB);
  }
  // A finale boss goes out with its own colour: a slow soul-light bloom in the variant's
  // tint (or the warlord's gold). One quad — the death of a 3000 hp body needs a beat,
  // not a firework, and a bright additive column here would fight the horde behind it.
  if (h > 3.5) {
    eReset();
    E.x = x; E.y = gy + h * 0.55; E.z = z; E.tile = T_SOFT;
    E.s0 = 2.2; E.s1 = 6.5; E.vy = 1.5; E.drag = 1.0;
    E.r = 1.05 * (TC ? TC[0] : 1.25); E.g = 0.85 * (TC ? TC[1] : 0.92); E.b = 0.60 * (TC ? TC[2] : 0.55);
    E.a = 0.46; E.life = 0.95; E.fade = 2; E.lead = 0.06; push(BB);
  }
  if (e.def.bounty >= 4 || er() < 0.30) VFX.coin(x, gy + h * 0.6, z);
};

// ── coin pop: world arc, then a screen-space handoff to the HUD gold counter ──
const COIN_N = 14, CF = 6, CT1 = 0.38, CT2 = 1.16, CGR = 15;
const CO = new Float32Array(COIN_N * CF);            // birth · x · y · z · vy · spin
let _co = 0;
VFX.coin = (x, y, z) => {
  const o = _co * CF; _co = (_co + 1) % COIN_N;
  eseed((x * 17 + z * 53) | 0, (G.vt() * 421) | 0);
  CO[o] = G.vt(); CO[o + 1] = x + es1() * 0.3; CO[o + 2] = y; CO[o + 3] = z + es1() * 0.3;
  CO[o + 4] = 5.4 + er() * 1.8; CO[o + 5] = er() * 6.28;
};
const _hv = new THREE.Vector3();
function hudPoint(out) {
  let nx = -0.855, ny = 0.945;
  const el = document.getElementById('gold');
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) { nx = (r.left + r.width * 0.5) / innerWidth * 2 - 1; ny = -((r.top + r.height * 0.5) / innerHeight * 2 - 1); }
  }
  out.set(nx, ny, 0.5).unproject(G.camera);
  out.sub(G.camera.position).normalize().multiplyScalar(11).add(G.camera.position);
  return out;
}
// One closed form for a coin's flight, shared by the coin quad and by its trail and
// specular pip — the pip has to sit ON the face and the trail has to leave from behind it,
// so all three must read the same curve. Writes px,py,pz,size into _cp.
const _cp = new Float32Array(4);
function coinAt(o, age) {
  const ax = CO[o + 1], ay = CO[o + 2], az = CO[o + 3], vy = CO[o + 4];
  if (age < CT1) {
    _cp[0] = ax; _cp[1] = ay + vy * age - 0.5 * CGR * age * age; _cp[2] = az; _cp[3] = 0.78;
  } else {
    const eY = ay + vy * CT1 - 0.5 * CGR * CT1 * CT1;
    const u = (age - CT1) / (CT2 - CT1), s = u * u * (3 - 2 * u);
    _cp[0] = lerp(ax, _hv.x, s); _cp[2] = lerp(az, _hv.z, s); _cp[3] = lerp(0.78, 0.30, s);
    _cp[1] = lerp(eY, _hv.y, s) + Math.sin(s * 3.1416) * 1.5 * (1 - s * 0.6);
  }
  return _cp;
}
function coinsLive(t) {
  for (let i = 0; i < COIN_N; i++) {
    const o = i * CF;
    if (CO[o + 4] === 0) continue;
    const age = t - CO[o];
    if (age >= 0 && age < CT2) return true;
  }
  return false;
}
const coinAlpha = (age) => Math.min(1, age * 14) * (age > CT2 - 0.10 ? (CT2 - age) / 0.10 : 1);
// TUMBLE. A coin that holds one face at the camera for its whole flight is a status pip,
// not a coin. iSize is applied AFTER the billboard rotation, so squeezing iSize.x alone
// spins the disc about a screen-vertical axis: face-on → ellipse → edge-on sliver → back.
const coinFlip = (o, age) => Math.abs(Math.cos(CO[o + 5] + age * 8));
function stepCoins(t, n) {
  if (!coinsLive(t)) return n;
  hudPoint(_hv);
  const B = BA, aP = B.aP, aV = B.aV, aS = B.aS, aC = B.aC, aA = B.aA;
  for (let i = 0; i < COIN_N && n < B.cap; i++) {
    const o = i * CF, age = t - CO[o];
    if (CO[o + 4] === 0 || age < 0 || age >= CT2) continue;
    const c = coinAt(o, age), sz = c[3], fl = coinFlip(o, age);
    const a = coinAlpha(age);
    const j = n * 3, j2 = n * 2, j4 = n * 4;
    aP[j] = c[0]; aP[j + 1] = c[1]; aP[j + 2] = c[2];
    aV[j] = 0; aV[j + 1] = 1; aV[j + 2] = 0;
    aS[j2] = sz * (0.16 + 0.84 * fl); aS[j2 + 1] = sz;
    aC[j4] = 1.35; aC[j4 + 1] = 1.22; aC[j4 + 2] = 0.95; aC[j4 + 3] = a;
    aA[j] = CO[o + 5] * 0.2 + Math.sin(age * 3.1 + CO[o + 5]) * 0.22; aA[j + 1] = T_COIN; aA[j + 2] = 0;
    n++;
  }
  return n;
}
// Additive dressing for the same coins: a short streak behind the flight so the arc is a
// gesture rather than a teleport, and a specular pip that sweeps across the face at the
// top of each tumble. Both live in the additive bucket, hence the separate pass.
const COIN_FX = COIN_N * 2;
const _cr = new THREE.Vector3(), _cd = new THREE.Vector3();
function stepCoinFX(t, n) {
  if (!coinsLive(t)) return n;
  const B = BB, aP = B.aP, aV = B.aV, aS = B.aS, aC = B.aC, aA = B.aA;
  const e = G.camera.matrixWorld.elements;
  _cr.set(e[0], e[1], e[2]);                          // camera right, for the pip sweep
  for (let i = 0; i < COIN_N && n < B.cap - 1; i++) {
    const o = i * CF, age = t - CO[o];
    if (CO[o + 4] === 0 || age < 0 || age >= CT2) continue;
    const c = coinAt(o, age), px = c[0], py = c[1], pz = c[2], sz = c[3];
    const a = coinAlpha(age), fl = coinFlip(o, age);
    const b = coinAt(o, Math.max(0, age - 0.04));     // finite-difference heading
    _cd.set(px - b[0], py - b[1], pz - b[2]);
    const sp = _cd.length();
    if (sp > 1e-3) {
      const j = n * 3, j2 = n * 2, j4 = n * 4;
      aP[j] = px; aP[j + 1] = py; aP[j + 2] = pz;
      aV[j] = _cd.x; aV[j + 1] = _cd.y; aV[j + 2] = _cd.z;
      aS[j2] = sz * 0.46; aS[j2 + 1] = Math.min(1.05, sp * 4.5);
      aC[j4] = 1.55; aC[j4 + 1] = 1.05; aC[j4 + 2] = 0.42; aC[j4 + 3] = a * 0.34;
      aA[j] = 0; aA[j + 1] = T_SPARK; aA[j + 2] = 2;
      n++;
    }
    if (fl > 0.45) {                                  // rim specular, only when face-on
      const sw = Math.sin(CO[o + 5] + age * 8) * 0.30 * sz;
      const j = n * 3, j2 = n * 2, j4 = n * 4;
      aP[j] = px + _cr.x * sw; aP[j + 1] = py + _cr.y * sw; aP[j + 2] = pz + _cr.z * sw;
      aV[j] = 0; aV[j + 1] = 1; aV[j + 2] = 0;
      aS[j2] = sz * 0.30; aS[j2 + 1] = sz * 0.30;
      aC[j4] = 2.0; aC[j4 + 1] = 1.9; aC[j4 + 2] = 1.55;
      aC[j4 + 3] = a * 0.85 * Math.pow((fl - 0.45) / 0.55, 1.5);
      aA[j] = age * 2.2; aA[j + 1] = T_GLINT; aA[j + 2] = 0;
      n++;
    }
  }
  return n;
}

// ── melee clash: sparks + a small weapon flash quad between the two fighters ──
function clash(x, y, z, k) {
  for (let i = 0; i < 5; i++) {
    eReset();
    E.x = x + es1() * 0.2; E.y = y + es1() * 0.2; E.z = z + es1() * 0.2;
    const sp = 4 + er() * 11, an = er() * 6.2832;
    E.vx = Math.cos(an) * sp * 0.8; E.vy = sp * (0.3 + er() * 0.9); E.vz = Math.sin(an) * sp * 0.8;
    E.grav = 17; E.drag = 4.5; E.tile = T_SPARK; E.mode = 2;
    E.s0 = 0.07; E.s1 = 0.03; E.asp = 5 + er() * 7;
    E.r = 2.4; E.g = 2.0; E.b = 1.3; E.a = 1; E.life = 0.11 + er() * 0.14; E.fade = 2;
    push(BB);
  }
  eReset();
  E.x = x; E.y = y; E.z = z; E.tile = T_FLASH; E.s0 = 0.36 * k; E.s1 = 0.80 * k;
  E.r = 2.1; E.g = 1.80; E.b = 1.22; E.a = 0.80; E.life = 0.11; E.fade = 2; E.rot = er() * 6.28;
  push(BB);
}

// ══ tower fire events (TOWERS' onFire hook) ══════════════════════════════════
Towers.onFire = (tw, tgt, ev) => {
  eseed((ev.x * 149 + ev.z * 79) | 0, (tw.shots || 0) * 7919);
  const gy = G.groundY(tw.x, tw.z), sy = Math.sin(ev.yaw), cy = Math.cos(ev.yaw);
  if (tw.type === 'archer') {
    eReset();                                        // bow snap
    E.x = ev.x; E.y = ev.y; E.z = ev.z; E.tile = T_SOFT; E.s0 = 0.30; E.s1 = 0.95;
    E.r = 1.9; E.g = 1.7; E.b = 1.2; E.a = 0.55; E.life = 0.10; E.fade = 2; push(BB);
    return;
  }
  if (tw.type === 'ballista') {
    eReset();                                        // muzzle flash
    E.x = ev.x + sy * 0.6; E.y = ev.y; E.z = ev.z + cy * 0.6; E.tile = T_FLASH;
    E.s0 = 0.9; E.s1 = 2.2; E.r = 2.4; E.g = 1.9; E.b = 1.15; E.a = 0.9; E.life = 0.14;
    E.fade = 2; E.rot = er() * 6.28; push(BB);
    for (let i = 0; i < 5; i++) {
      eReset();
      E.x = ev.x + sy * 0.7; E.y = ev.y; E.z = ev.z + cy * 0.7;
      const sp = 6 + er() * 9;
      E.vx = (sy + es1() * 0.7) * sp; E.vy = (0.3 + er() * 0.7) * sp; E.vz = (cy + es1() * 0.7) * sp;
      E.grav = 16; E.drag = 5; E.tile = T_SPARK; E.mode = 2; E.s0 = 0.07; E.s1 = 0.03;
      E.asp = 6 + er() * 6; E.r = 2.4; E.g = 1.8; E.b = 0.9; E.a = 1; E.life = 0.14; E.fade = 2;
      push(BB);
    }
    eReset();                                        // deck dust
    E.x = ev.x; E.y = gy + 0.35; E.z = ev.z; E.tile = T_DUST; E.mode = 1;
    E.s0 = 1.0; E.s1 = 4.2; E.r = 0.76; E.g = 0.64; E.b = 0.45; E.a = 0.30; E.life = 1.0;
    E.rot = er() * 6.28; push(BA);
    return;
  }
  if (tw.type === 'catapult') {
    VFX.shakeAt(tw.x, gy, tw.z, 0.22);
    for (let i = 0; i < 6; i++) {                    // recoil kicks dust off the platform
      eReset();
      const an = er() * 6.2832;
      E.x = tw.x + Math.cos(an) * (1 + er() * 2.2); E.y = gy + 0.3 + er() * 0.5; E.z = tw.z + Math.sin(an) * (1 + er() * 2.2);
      E.vx = Math.cos(an) * (1.5 + er() * 2.5); E.vz = Math.sin(an) * (1.5 + er() * 2.5); E.vy = 0.9 + er();
      E.drag = 2.2; E.tile = er() < 0.5 ? T_DUST : SMK(); E.mode = er() < 0.6 ? 1 : 0;
      E.s0 = 0.9; E.s1 = 3.8 + er() * 1.8; E.r = 0.76; E.g = 0.64; E.b = 0.45;
      E.a = 0.26; E.life = 1.1 + er() * 0.7; E.rot = er() * 6.28; E.rotV = es1(); push(BA);
    }
    eReset();                                        // sling whoosh
    E.x = ev.x; E.y = ev.y; E.z = ev.z; E.tile = T_WISP; E.s0 = 1.2; E.s1 = 3.2;
    E.r = 0.58; E.g = 0.53; E.b = 0.47; E.a = 0.26; E.life = 0.5; E.rot = er() * 6.28; push(BA);
  }
};

// ══ per-sim-tick continuous emitters ═════════════════════════════════════════
// Called once per distinct sim tick (and PQ.prime times on the first update, with a
// back-dated lead, so a headless frame carries the same atmosphere a live one does).
const DBIN = 6.5, NBIN = Math.ceil(PT.len / DBIN) + 2;
const binN = new Int16Array(NBIN);
const _ev3 = new THREE.Vector3();
// SPEC2 §C/§E state for the continuous emitters below.
const MAPID = (G.MAP && G.MAP.id) || 1;
// Phone budget: the burning-ground dressing is the one new emitter that can run four
// instances at once, and the mobile additive bucket is 520 slots wide against 1900.
const LOWQ = tier === 'mobile';
const _bnSeen = new Set();                           // warbanner uids already dressed
let _bnInit = false;                                 // ...and whether first sight has passed
// Ember Wastes: fixed scorch vents that breathe sparks. Chosen ONCE off the private
// emitter stream (never G.rng) on ground that is off the road but not out on the scree,
// and cached — a per-tick search would be both slow and non-deterministic in feel.
const _vents = [];
let _ventsB = false;
function vents() {
  if (_ventsB) return _vents;
  _ventsB = true;
  eseed(0x51ce7, MAPID * 977);
  for (let i = 0; i < 400 && _vents.length < 15; i++) {
    const x = es1() * 82, z = es1() * 50;
    if ((x / 84) ** 2 + (z / 52) ** 2 > 1) continue;
    const sd = Math.abs(G.roadSD(x, z));
    if (sd < 5.5 || sd > 30) continue;
    _vents.push([x, z, G.groundY(x, z)]);
  }
  return _vents;
}
function emitTick(tick, lead) {
  _lead = lead;
  const EN = G.enemies;
  // ── marching dust: density histogram along the road; dust only where it is thick
  binN.fill(0);
  let nAlive = 0;
  for (let i = 0; i < EN.length; i++) { const e = EN[i]; if (!e.alive) continue; nAlive++; binN[(e.d / DBIN) | 0]++; }
  if (nAlive > 3) {
    eseed(tick, 0x51ed27);
    const back = lead * 2.0;                         // where the column was `lead` ago
    let budget = PQ.dust;
    for (let b = 0; b < NBIN && budget > 0; b++) {
      const c = binN[b]; if (c < 4) continue;
      if (er() > Math.min(0.55, (c - 3) * 0.052)) continue;
      budget--;
      G.pathPos((b + er()) * DBIN - back, _ev3, es1() * 2.5);
      eReset();
      E.x = _ev3.x; E.z = _ev3.z;
      // warm road-dust tan. The tint weight has to account for the atlas art being
      // near-white AND the shader's sun ramp, so ~0.8 is already a light dusty tan.
      if (er() < 0.60) {                             // ground-hugging haze patch
        E.y = _ev3.y + 0.30 + er() * 0.5; E.mode = 1; E.tile = er() < 0.68 ? T_DUST : T_WISP;
        E.s0 = 1.4 + er() * 0.9; E.s1 = 5.6 + er() * 3.0;
        E.vy = 0.26; E.vx = es1() * 0.5 + WX * 0.7; E.vz = es1() * 0.5 + WZ * 0.7;
        E.a = 0.26 + er() * 0.13; E.life = 2.1 + er() * 1.1;
        E.r = 0.88; E.g = 0.75; E.b = 0.54;
      } else {                                       // a wisp lifting out of the column
        E.y = _ev3.y + 0.7 + er() * 1.3; E.tile = T_WISP;
        E.s0 = 1.1 + er() * 0.8; E.s1 = 4.6 + er() * 2.8;
        E.vy = 1.05 + er() * 0.9; E.vx = es1() * 0.8 + WX * 0.9; E.vz = es1() * 0.8 + WZ * 0.9;
        E.a = 0.17 + er() * 0.09; E.life = 2.4 + er() * 1.3;
        E.r = 0.95; E.g = 0.83; E.b = 0.62;
      }
      E.drag = 0.8;
      E.rot = er() * 6.28; E.rotV = es1() * 0.5;
      push(BA);
    }
    if (lead < 1.3) {                                // foot puffs under individual marchers
      eseed(tick, 0x2f9a3b);
      for (let i = 0; i < 2; i++) {
        const e = EN[(er() * EN.length) | 0];
        if (!e || !e.alive) continue;
        eReset();
        E.x = e.px + es1() * 0.35; E.y = G.groundY(e.px, e.pz) + 0.16; E.z = e.pz + es1() * 0.35;
        E.mode = 1; E.tile = T_DUST; E.s0 = 0.28; E.s1 = 1.5 + er() * 0.7;
        E.vy = 0.25; E.drag = 2.4; E.r = 0.78; E.g = 0.66; E.b = 0.46;
        E.a = 0.24; E.life = 0.75 + er() * 0.5; E.rot = er() * 6.28;
        push(BA);
      }
    }
  }
  // ── melee clash sparks from the engaged pairs (short-lived: no deep back-fill)
  if (lead < 0.30) {
    eseed(tick, 0x6d1f18);
    let np = 0;
    for (let i = 0; i < EN.length; i++) {
      const e = EN[i];
      if (!e.alive || e.blockedBy < 0) continue;
      const kn = G.knights[e.blockedBy];
      if (!kn || !kn.alive) continue;
      if (er() < 0.34) {
        const mx = (e.px + kn.x) * 0.5, mz = (e.pz + kn.z) * 0.5;
        clash(mx, G.groundY(mx, mz) + 1.05 + er() * 0.5, mz, 1);
      }
      if (++np >= 10) break;
    }
  }
  // ── SPEC3 §B PRESENCE: the three newcomers that have to be legible at gameplay zoom
  // before their health bar is. A mini-boss the player only identifies by reading a name
  // plate has already cost him the wave. Each of these is a CONTINUOUS read tied to what
  // the unit IS, and each is capped per tick so a swap slot that fields eleven of them
  // cannot walk over the alpha budget (the phone's additive bucket is 520 wide).
  //   ash wraith — a cold shroud trail: it is the only thing on the road that leaves
  //                something behind it, and it is the unit you must not let through.
  //   siege ram  — wheel dust off both axles: mass, and the ONLY cue that says the machine
  //                is still rolling when it is buried inside a column.
  //   war shaman — chant motes between VFX.heal's pulses, so the aura never goes dark
  //                mid-chant. The ring itself is VFX.heal's, drawn at the true heal radius.
  if (lead < 1.2) {
    eseed(tick, 0x5ea17d);
    const WCAP = LOWQ ? 2 : 4, at3 = tick * TICK;
    let nw = 0, nr = 0, ns = 0;
    for (let i = 0; i < EN.length; i++) {
      const e = EN[i];
      if (!e.alive) continue;
      const ty = e.type;
      if (ty === 'ashwraith') {
        if (nw >= WCAP || er() > 0.55) continue;
        nw++;
        const tn = G.pathTan(e.d, e.pathId), gy2 = G.groundY(e.px, e.pz);
        eReset();                                       // the shroud it drags behind it
        E.x = e.px - tn.x * (0.5 + er() * 0.9) + es1() * 0.25;
        E.z = e.pz - tn.z * (0.5 + er() * 0.9) + es1() * 0.25;
        E.y = gy2 + 0.55 + er() * 0.85;
        E.vx = -tn.x * 0.5 + WX * 0.35; E.vy = 0.30 + er() * 0.35; E.vz = -tn.z * 0.5 + WZ * 0.35;
        E.drag = 1.5; E.tile = T_WISP; E.s0 = 0.40 + er() * 0.26; E.s1 = 1.9 + er() * 1.0;
        // DARK and slightly cold. A pale trail on a pale unit is fog; the wraith has to be
        // the thing that makes the road behind it dimmer, not brighter.
        E.r = 0.13; E.g = 0.13; E.b = 0.18; E.a = 0.38; E.life = 0.85 + er() * 0.6;
        E.rot = er() * 6.28; E.rotV = es1() * 0.9; E.lead = er() * 0.06; push(BA);
        if (er() < 0.34) {                              // the ember eyes, banked low
          eReset();
          E.x = e.px + es1() * 0.14; E.y = gy2 + 1.55; E.z = e.pz + es1() * 0.14;
          E.vy = 0.35; E.drag = 1.2; E.grav = -0.3; E.tile = T_EMBER;
          E.s0 = 0.09 + er() * 0.05; E.s1 = 0.02;
          E.r = 1.85; E.g = 0.52; E.b = 0.16; E.a = 0.75; E.life = 0.55 + er() * 0.35;
          E.fade = 2; push(BB);
        }
      } else if (ty === 'ram') {
        if (nr >= 2) continue;
        nr++;
        const tn = G.pathTan(e.d, e.pathId);
        for (const sgn of [-1, 1]) {                    // one axle each side, under the bed
          if (er() < 0.45) continue;
          const wx = e.px - tn.z * 1.25 * sgn, wz = e.pz + tn.x * 1.25 * sgn;
          eReset();
          E.x = wx + es1() * 0.2; E.y = G.groundY(wx, wz) + 0.16; E.z = wz + es1() * 0.2;
          E.vx = -tn.x * 1.1 + es1() * 0.5; E.vy = 0.35 + er() * 0.4; E.vz = -tn.z * 1.1 + es1() * 0.5;
          E.drag = 2.4; E.tile = T_DUST; E.mode = 1;
          E.s0 = 0.42; E.s1 = 2.3 + er() * 1.0;
          E.r = 0.72; E.g = 0.62; E.b = 0.45; E.a = 0.30; E.life = 1.0 + er() * 0.6;
          E.rot = er() * 6.28; E.lead = er() * 0.05; push(BA);
        }
        if (er() < 0.22) {                              // a stone spat out from under a wheel
          eReset();
          const an = er() * 6.2832;
          E.x = e.px + es1() * 1.3; E.y = G.groundY(e.px, e.pz) + 0.25; E.z = e.pz + es1() * 1.3;
          E.vx = Math.cos(an) * 3 - tn.x * 2; E.vy = 2 + er() * 2.5; E.vz = Math.sin(an) * 3 - tn.z * 2;
          E.grav = 26; E.drag = 0.4; E.tile = T_CHUNK; E.s0 = 0.11 + er() * 0.09; E.s1 = E.s0;
          E.r = 0.68; E.g = 0.60; E.b = 0.50; E.a = 1; E.life = 0.55 + er() * 0.3;
          E.rot = er() * 6.28; E.rotV = es1() * 9; push(BA);
        }
      } else if (ty === 'warshaman') {
        if (ns >= 4 || at3 - (e.healT || -9) > 0.45 || er() > 0.5) continue;
        ns++;
        const gy2 = G.groundY(e.px, e.pz), an = er() * 6.2832, rr = 0.3 + er() * 0.8;
        eReset();
        E.x = e.px + Math.cos(an) * rr; E.y = gy2 + 0.4 + er() * 0.9; E.z = e.pz + Math.sin(an) * rr;
        E.vx = Math.cos(an) * 0.30; E.vz = Math.sin(an) * 0.30; E.vy = 1.0 + er() * 1.1;
        E.drag = 1.5; E.grav = -0.3; E.tile = T_MOTE;
        E.s0 = 0.11 + er() * 0.08; E.s1 = 0.03;
        E.r = 0.80 + er() * 0.4; E.g = 1.80; E.b = 0.58; E.a = 0.55; E.life = 0.9 + er() * 0.6;
        E.fade = 2; push(BB);
      }
    }
  }
  // ── brazier embers off any tower carrying a flame
  if ((tick & 3) === 0 && lead < 1.7) {
    eseed(tick, 0x1a3c5d);
    const TL = G.towersList;
    for (let i = 0; i < TL.length; i++) {
      const tw = TL[i];
      if (!tw._fire || !tw._fire.length || er() < 0.45) continue;
      const f = tw._fire[(er() * tw._fire.length) | 0];
      const cb = Math.cos(tw._base), sb = Math.sin(tw._base);
      eReset();
      E.x = tw.x + f[0] * cb + f[2] * sb + es1() * 0.12;
      E.z = tw.z - f[0] * sb + f[2] * cb + es1() * 0.12;
      E.y = G.groundY(tw.x, tw.z) + f[1] + 0.35;
      E.vx = es1() * 0.5 + WX * 0.5; E.vy = 1.5 + er() * 1.4; E.vz = es1() * 0.5 + WZ * 0.5;
      E.drag = 0.9; E.grav = -0.6; E.tile = T_EMBER;
      E.s0 = 0.12 + er() * 0.10; E.s1 = 0.03;
      E.r = 2.6; E.g = 1.2; E.b = 0.36; E.a = 0.95; E.life = 1.0 + er() * 0.9; E.fade = 1;
      push(BB);
    }
  }
  // ── BURNING GROUND (SPEC2 §C). TOWERS' fireMesh draws the standing tongues; everything
  // ABOVE and AROUND the patch is emitted here, once per sim tick per patch, so a pyre
  // field reads as a fire — licking flame, oily smoke off the pitch, spat embers and a
  // warm pool of light on the grass. Budget: a 4 s patch holds ~45 live particles.
  const PA = G.patches;
  if (PA && PA.length && lead < 2.4) {
    const at = tick * TICK;
    eseed(tick, 0x7f3a15);
    for (let i = 0; i < PA.length; i++) {
      const pa = PA[i];
      const f = (at - pa.born) / pa.dur;
      if (f < 0 || f > 1) continue;
      const env = sstep(0, 0.18, f) * (1 - sstep(0.72, 1, f));
      if (env < 0.06) continue;
      const gy = G.groundY(pa.x, pa.z);
      // TONGUES. Small, TALL (asp ~2.4) and deeply saturated, two per tick: the first pass
      // used one fat round blob per tick and the patch read as a lit dust cloud. Overlapping
      // additive quads still saturate to white under ACES, so the count goes up only because
      // each one goes down in size and alpha — the same trade TOWERS' fireMesh made.
      // VFX-3: sizes were pushed and pulled back. Additive quads at this density saturate
      // to a white blob the moment alpha OR count goes up (shots\_fire.png, two failed
      // passes), so the tongues keep their authored weight; what they gained is a per-quad
      // lean and spin, so they flicker independently instead of pulsing in lockstep.
      for (let k = 0; k < (LOWQ ? 1 : 2); k++) {
        const an = er() * 6.2832, rr = Math.sqrt(er()) * pa.r * 0.84;
        const hot = k === 0 && er() < 0.5;            // the odd yellow-hot one at the core
        eReset();
        E.x = pa.x + Math.cos(an) * rr * (hot ? 0.45 : 1); E.z = pa.z + Math.sin(an) * rr * (hot ? 0.45 : 1);
        E.y = G.groundY(E.x, E.z) + 0.16;
        E.vx = Math.cos(an) * 0.35 + WX * 0.30; E.vy = 2.3 + er() * 1.8; E.vz = Math.sin(an) * 0.35 + WZ * 0.30;
        E.drag = 2.4; E.grav = -1.4; E.tile = T_SOFT; E.asp = 2.2 + er() * 0.8;
        E.s0 = (0.34 + er() * 0.24) * env; E.s1 = (0.10 + er() * 0.09) * env;
        E.r = hot ? 2.30 : 1.98; E.g = hot ? 1.15 : 0.59; E.b = hot ? 0.30 : 0.10;
        E.a = (hot ? 0.30 : 0.40) * env; E.life = 0.38 + er() * 0.22; E.fade = 2;
        E.rot = es1() * 0.30; E.rotV = es1() * 0.9;
        push(BB);
      }
      if (((tick + i) & 1) === 0) {                  // spat ember
        eReset();
        const an = er() * 6.2832, rr = er() * pa.r * 0.7;
        E.x = pa.x + Math.cos(an) * rr; E.y = gy + 0.4; E.z = pa.z + Math.sin(an) * rr;
        E.vx = WX * 1.3 + es1() * 0.8; E.vy = 2.2 + er() * 2.6; E.vz = WZ * 1.3 + es1() * 0.8;
        E.drag = 1.1; E.grav = -0.5; E.tile = T_EMBER;
        E.s0 = 0.10 + er() * 0.09; E.s1 = 0.02;
        E.r = 2.3; E.g = 1.0 + er() * 0.4; E.b = 0.22; E.a = 0.9 * env; E.life = 0.8 + er() * 0.9;
        E.fade = 2; push(BB);
      }
      if ((tick + i) % 4 === 0) {                    // oily smoke off the pitch
        eReset();
        const an = er() * 6.2832, rr = er() * pa.r * 0.6;
        E.x = pa.x + Math.cos(an) * rr; E.y = gy + 1.0 + er() * 0.8; E.z = pa.z + Math.sin(an) * rr;
        E.vx = WX * 1.6 + es1() * 0.4; E.vy = 1.8 + er() * 1.2; E.vz = WZ * 1.6 + es1() * 0.4;
        E.drag = 0.85; E.grav = -0.3; E.tile = er() < 0.65 ? T_SOOT : SMK();
        E.s0 = 0.7 + er() * 0.6; E.s1 = 2.6 + er() * 1.8;
        // DARK. Burning pitch makes black smoke; at the pale weight the first pass used,
        // the plume washed the fire out to a grey cloud with a light in it.
        const w = 0.10 + er() * 0.07;
        E.r = w; E.g = w * 0.90; E.b = w * 0.82; E.a = 0.40 * env; E.life = 1.5 + er() * 1.1;
        E.rot = er() * 6.28; E.rotV = es1() * 0.7; push(BA);
      }
      if ((tick + i) % 3 === 0) {                    // warm pool on the ground under it
        eReset();
        E.x = pa.x; E.y = gy + 0.06; E.z = pa.z; E.tile = T_SOFT; E.mode = 1;
        E.s0 = pa.r * 1.5; E.s1 = pa.r * 1.9;
        E.r = 1.45; E.g = 0.44; E.b = 0.10; E.a = 0.20 * env; E.life = 0.34;
        E.rot = er() * 6.28; push(BB);
      }
      if ((tick + i) % (LOWQ ? 4 : 2) === 0) {       // coals: the ground itself is alight
        const an = er() * 6.2832, rr = Math.sqrt(er()) * pa.r * 0.9;
        eReset();
        E.x = pa.x + Math.cos(an) * rr; E.z = pa.z + Math.sin(an) * rr;
        E.y = G.groundY(E.x, E.z) + 0.05; E.tile = T_EMBER; E.mode = 1;
        E.s0 = 0.30 + er() * 0.34; E.s1 = 0.12;
        E.r = 1.70; E.g = 0.50 + er() * 0.30; E.b = 0.08;
        E.a = 0.55 * env; E.life = 0.55 + er() * 0.45; E.fade = 1;
        E.rot = er() * 6.28; push(BB);
      }
    }
  }
  // ── WARBANNER (SPEC2 §C). A support tower fires nothing, so its aura has to breathe:
  // a slow drift of heraldic light off the standard and the odd spark lifting out of the
  // ring. Newly raised banners get the one-shot pulse (VFX.banner) the first tick they
  // are seen — the seen-set is primed silently on first sight so a preset's pre-placed
  // banners do not all detonate on frame one.
  if (lead < 1.4 && (tick & 1) === 0) {
    eseed(tick, 0x2b7e15);
    const TL = G.towersList;
    for (let i = 0; i < TL.length; i++) {
      const tw = TL[i], def = TOWER_DEFS[tw.type];
      if (!def.aura) continue;
      const R = def.range * (1 + 0.08 * (tw.level - 1));
      if (!_bnSeen.has(tw.uid)) { _bnSeen.add(tw.uid); if (_bnInit) VFX.banner(tw.x, tw.z, R); continue; }
      if (er() < 0.5) {                              // light lifting off the standard
        eReset();
        E.x = tw.x + es1() * 0.5; E.y = G.groundY(tw.x, tw.z) + 4.6 + er() * 2.6; E.z = tw.z + es1() * 0.5;
        E.vx = WX * 0.5 + es1() * 0.25; E.vy = 0.8 + er() * 0.9; E.vz = WZ * 0.5 + es1() * 0.25;
        E.drag = 1.0; E.grav = -0.3; E.tile = er() < 0.3 ? T_GLINT : T_MOTE;
        E.s0 = 0.14 + er() * 0.12; E.s1 = 0.03;
        E.r = 0.70; E.g = 1.05; E.b = 1.80; E.a = 0.55; E.life = 1.3 + er() * 1.0; E.fade = 1;
        E.rot = er() * 6.28; E.rotV = es1() * 3; push(BB);
      }
      if (er() < 0.34) {                             // a mote rising somewhere in the aura
        const an = er() * 6.2832, rr = Math.sqrt(er()) * R;
        eReset();
        E.x = tw.x + Math.cos(an) * rr; E.z = tw.z + Math.sin(an) * rr;
        E.y = G.groundY(E.x, E.z) + 0.3 + er() * 1.4;
        E.vy = 0.55 + er() * 0.5; E.vx = WX * 0.3; E.vz = WZ * 0.3; E.drag = 0.7;
        E.tile = T_MOTE; E.s0 = 0.10 + er() * 0.08; E.s1 = 0.02;
        E.r = 0.55; E.g = 0.85; E.b = 1.55; E.a = 0.34; E.life = 1.8 + er() * 1.2; E.fade = 1;
        push(BB);
      }
    }
    _bnInit = true;
  }
  // ── PER-MAP WEATHER (SPEC2 §E). The falling field itself is the mote lattice below;
  // these are the two cues a lattice cannot give: breath in Frostfell's cold air, and
  // embers lifting off Ember Wastes' scorched ground.
  if (MAPID === 2 && lead < 1.6 && tick % 5 === 0) {
    eseed(tick, 0x4c01d);
    const EN2 = G.enemies;
    for (let i = 0; i < 2; i++) {
      const e = EN2[(er() * EN2.length) | 0];
      if (!e || !e.alive) continue;
      eReset();
      E.x = e.px + es1() * 0.3; E.y = G.groundY(e.px, e.pz) + 1.35 + (e.def.scale || 1) * 0.35; E.z = e.pz + es1() * 0.3;
      E.vx = es1() * 0.5 + WX * 0.6; E.vy = 0.55 + er() * 0.4; E.vz = es1() * 0.5 + WZ * 0.6;
      E.drag = 2.6; E.tile = T_WISP; E.s0 = 0.10; E.s1 = 0.55 + er() * 0.25;
      E.r = 1.02; E.g = 1.06; E.b = 1.12; E.a = 0.20; E.life = 0.6 + er() * 0.35;
      E.rot = er() * 6.28; push(BA);
    }
  }
  if (MAPID === 3 && lead < 2.2 && (tick & 1) === 0) {
    const V = vents();
    if (V.length) {
      eseed(tick, 0x3d0a11);
      const v = V[(er() * V.length) | 0];
      for (let i = 0, k = 1 + ((er() < 0.35) ? 1 : 0); i < k; i++) {
        eReset();
        E.x = v[0] + es1() * 1.6; E.z = v[1] + es1() * 1.6; E.y = v[2] + 0.15 + er() * 0.4;
        E.vx = WX * 1.5 + es1() * 0.5; E.vy = 1.6 + er() * 1.9; E.vz = WZ * 1.5 + es1() * 0.5;
        E.drag = 0.75; E.grav = -0.55; E.tile = T_EMBER;
        E.s0 = 0.07 + er() * 0.07; E.s1 = 0.015;
        E.r = 2.1; E.g = 0.82 + er() * 0.35; E.b = 0.18; E.a = 0.85; E.life = 1.6 + er() * 1.4; E.fade = 1;
        push(BB);
      }
      if (er() < 0.16) {                             // a breath of heat off the scorch
        eReset();
        E.x = v[0] + es1() * 2.2; E.z = v[1] + es1() * 2.2; E.y = v[2] + 0.5;
        E.vx = WX * 2.0; E.vy = 0.9 + er() * 0.7; E.vz = WZ * 2.0; E.drag = 0.8;
        E.tile = T_WISP; E.s0 = 0.7; E.s1 = 3.0 + er() * 1.4;
        E.r = 0.42; E.g = 0.31; E.b = 0.24; E.a = 0.18; E.life = 2.0 + er() * 1.4;
        E.rot = er() * 6.28; E.rotV = es1() * 0.5; push(BA);
      }
    }
  }
  // ── tumbling boulder smoke trail. TOWERS' projRender carries the RENDER position
  // (with the ballistic sag), so read that rather than re-deriving from the sim.
  // First sight of a boulder back-fills its whole past trail, which is what makes the
  // trail exist at all in a headless frame (the sim ran with no renders).
  if (lead === 0) {
    const PR = Towers.projRender;
    for (let i = 0; i < PR.length; i++) {
      const q = PR[i];
      if (q.kind !== 'boulder') continue;
      const pr = q.p;
      eseed((pr._id || i) * 6151, 977);
      let n0 = 0;
      if (!pr._vfxT) { pr._vfxT = 1; n0 = Math.min(20, Math.floor(pr.el * TPS)); }
      for (let s = n0; s >= 0; s--) {
        const el = Math.max(0, pr.el - s * TICK), ff = Math.min(1, el / pr.T);
        eReset();
        E.x = lerp(pr.sx, pr.ex, ff); E.z = lerp(pr.sz, pr.ez, ff);
        E.y = lerp(pr.sy, G.groundY(pr.ex, pr.ez), ff) + Math.sin(ff * Math.PI) * 11;
        E.vx = es1() * 0.5; E.vy = 0.5 + er() * 0.6; E.vz = es1() * 0.5;
        E.drag = 1.5; E.tile = er() < 0.35 ? T_SOOT : SMK();
        E.s0 = 0.50 + er() * 0.35; E.s1 = 2.4 + er() * 1.3;
        E.r = 0.34; E.g = 0.31; E.b = 0.29; E.a = 0.46; E.life = 0.85 + er() * 0.6;
        E.rot = er() * 6.28; E.rotV = es1() * 1.6; E.lead = s * TICK;
        push(BA);
      }
    }
  }
  _lead = 0;
}

// ══ ambient pollen / dust motes ══════════════════════════════════════════════
// A world-space lattice wrapped around the camera focus: motes are stationary in the
// world (full parallax, nothing pops when the camera moves) and only the visible cell
// window changes. Screen-locked size so near motes never become blobs.
// WEATHER DENSITY (SPEC2 §E): pollen is a hint, a snowfall is a FIELD. A weather map gets
// a denser lattice — ~500 cells instead of 256 on desktop — because at pollen density the
// flakes read as a handful of white dots on the lens rather than as falling snow. Still
// one draw call; the extra cost is instances in a bucket that has the headroom.
const WEA = !!G.weather;
const MOTE = WEA ? (tier === 'mobile' ? [7, 3, 7] : [10, 5, 10]) : PQ.mote;
const MX = MOTE[0], MY = MOTE[1], MZ = MOTE[2], MC = PQ.mcell;
// SNOW is a STREAK, not a dot. Frostfell's field used the pollen tile at pollen density
// and screen-locked size, which is precisely the recipe for "round white lens dirt": the
// size lock removes every depth cue and the round tile removes every motion cue. Snow now
// world-locks its size (clamped to a sane pixel band, so distance genuinely shrinks a
// flake), draws in the shader's screen-space streak mode along the map's own fall vector,
// and trades opacity for count — many faint beats few opaque.
// ASH is DARK. A cinder is a burnt fleck; on an additive tile over orange sand it can only
// ever blow out to white, so map 3's field moves to the ALPHA bucket where a 0.35 tint
// actually reads as soot, with one in eight kept hot as a live ember.
const MOTE_ALPHA = MAPID === 3;                      // ash blends dark → alpha bucket
const MOTE_SUB = WEA ? 2 : 1;                        // sub-flakes per lattice cell
const WTILE = MAPID === 2 ? T_SOFT : MAPID === 3 ? T_SOOT : T_MOTE;
const WSTREAK = MAPID === 2 ? 2.6 : 0;               // fall-aligned motion aspect
// Ember Wastes is a DIM map, so "dark" has to mean dark: at a 0.35 tint the flecks came
// out brighter than the shadowed sand they sat on and read as pale dust again.
const ASH_C = [0.24, 0.20, 0.18], ASH_E = [2.20, 0.95, 0.30];
// Ash flakes are bigger and fluffier than snow crystals, and they have to survive being
// read as DARK against a busy speckled sand — a 2 px soot dot just joins the ground noise.
const MOTE_PX = MAPID === 3 ? [3, 9] : [2, 7];       // screen-size clamp for weather (css px)
const MOTE_SZ = MAPID === 3 ? 1.7 : 1;
const MH = new Float32Array(MX * MY * MZ * MOTE_SUB * 4);
{
  let h = 0x9e3779b9 >>> 0;
  const r = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  for (let i = 0; i < MH.length; i++) MH[i] = r();
}
const _mf = new THREE.Vector3();
function stepMotes(t, n, B) {
  const cam = G.camera;
  cam.getWorldDirection(_mf);
  const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
  // Height gate: airborne motes are a near-field atmospheric cue. Pulled back to the
  // strategic overview they blanket the whole vista uniformly and read as snow or a
  // dirty lens, so they fade out as the camera climbs away from the valley floor.
  // WEATHER (SPEC2 §E): the same lattice, but the cells FALL. Each mote carries its own
  // wrap phase, so the field recycles continuously instead of every flake jumping a cell
  // width at the same instant. A weather map also keeps a floor under the height fade —
  // snowfall that stops when you pull the camera back is a bug, not an atmosphere.
  const W = G.weather;
  let zoom = 1 - sstep(58, 108, oy - G.groundY(ox, oz));
  if (W) zoom = Math.max(zoom, W.floor);
  if (zoom < 0.02) return n;
  const cx = ox + _mf.x * 24, cy = oy + _mf.y * 24, cz = oz + _mf.z * 24;
  const fx = Math.floor(cx / MC), fy = Math.floor(cy / MC), fz = Math.floor(cz / MC);
  const aP = B.aP, aV = B.aV, aS = B.aS, aC = B.aC, aA = B.aA;
  const R = MC * Math.min(MX, MZ) * 0.5;
  // Pixels-per-world-unit at one unit of depth, so a world-locked flake can be held inside
  // a sane screen band instead of ballooning in the near field.
  const PPW = innerHeight / (2 * Math.tan(cam.fov * 0.5 * Math.PI / 180));
  let k = 0;
  for (let gz = 0; gz < MZ; gz++) for (let gy = 0; gy < MY; gy++) for (let gx = 0; gx < MX; gx++)
  for (let sub = 0; sub < MOTE_SUB; sub++) {
    const h = k * 4; k++;
    if (n >= B.cap) return n;
    const ph = MH[h + 3] * 6.2832;
    const jx = W ? ((MH[h] * 53.7 + t * W.dx) % MC + MC) % MC / MC : MH[h];
    const jy = W ? 1 - (((MH[h + 1] * 71.3 + t * W.fall) % MC + MC) % MC) / MC : MH[h + 1];
    const jz = W ? ((MH[h + 2] * 37.1 + t * W.dz) % MC + MC) % MC / MC : MH[h + 2];
    const px = (fx + gx - (MX >> 1) + jx) * MC + Math.sin(t * 0.19 + ph) * 2.6;
    const py = (fy + gy - (MY >> 1) + jy) * MC + Math.sin(t * 0.33 + ph * 2.1) * 0.9;
    const pz = (fz + gz - (MZ >> 1) + jz) * MC + Math.cos(t * 0.15 + ph * 1.7) * 2.2;
    const dx = px - ox, dy = py - oy, dz = pz - oz;
    if (dx * _mf.x + dy * _mf.y + dz * _mf.z < 2) continue;        // behind / on the lens
    const ex = px - cx, ey = py - cy, ez = pz - cz;
    const q = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const qc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Pollen twinkles; weather does not — a snowflake that blinks reads as a dead pixel.
    // Both fade OUT of the near field as well as the far one: a flake three metres off the
    // lens is a white plate across the frame, which is the "dirty sensor" failure mode.
    const tw = W ? 0.72 + 0.28 * Math.sin(t * 0.6 + ph * 2.2)
                 : 0.34 + 0.66 * Math.pow(Math.max(0, Math.sin(t * 0.85 + ph * 3.3)), 3);
    const a = (1 - sstep(R * 0.42, R, q)) * (1 - sstep(34, 60, qc)) * zoom * tw
            * (W ? sstep(7, 24, qc) : 1);
    if (a < 0.03) continue;
    const big = MH[h + 2] > 0.80;
    let s, av;
    if (W) {
      // WORLD-LOCKED, then clamped into MOTE_PX. This is the inverse of the pollen rule and
      // it is the whole fix: a screen-locked flake is the same disc at 8 u and at 50 u, so
      // the field has no depth and every flake is a blob. Locked to the world, distance
      // shrinks it; the clamp only stops the two extremes (a flake on the lens, a flake
      // too small to survive the resolve).
      s = (0.075 + MH[h] * 0.075) * W.size * MOTE_SZ * (big ? 1.35 : 1) * (LOWQ ? 1.25 : 1);
      s = clamp(s, MOTE_PX[0] * qc / PPW, MOTE_PX[1] * qc / PPW);
      // Half the opacity, twice the flakes: many faint reads as weather, few opaque reads
      // as dirt on the sensor.
      av = a * 1.55 * W.alpha * (big ? 0.62 : 1) * (MOTE_ALPHA ? 1.4 : 0.55) * (LOWQ ? 1.30 : 1);
    } else {
      // Screen-locked size, so a pollen mote 3 m from the lens is not a dinner plate. A
      // fifth of them are blown up and faded to read as out-of-focus bokeh, which is what
      // stops the field looking like dead pixels on the sensor.
      s = qc * (0.0031 + MH[h] * 0.0046); av = a * 1.55;
      if (big) { s *= 2.5; av *= 0.34; }
    }
    const j = n * 3, j2 = n * 2, j4 = n * 4;
    aP[j] = px; aP[j + 1] = py; aP[j + 2] = pz;
    if (WSTREAK) {
      // Screen-space streak mode (iAux.z = 2): the quad is laid along the projection of the
      // fall vector, so a flake becomes a short fall-aligned dash at any camera angle
      // instead of a dot that could be going anywhere.
      aV[j] = W.dx; aV[j + 1] = -W.fall; aV[j + 2] = W.dz;
      aS[j2] = s; aS[j2 + 1] = s * WSTREAK;
      aA[j + 2] = 2;
    } else {
      aV[j] = 0; aV[j + 1] = 1; aV[j + 2] = 0;
      aS[j2] = s; aS[j2 + 1] = s;
      aA[j + 2] = 0;
    }
    // Ash is soot, not sparkle: a dark fleck in the alpha bucket, with one in eight kept
    // hot so the field still carries the map's ember cue.
    const emb = MOTE_ALPHA && MH[h + 1] > 0.875;
    const WC = MOTE_ALPHA ? (emb ? ASH_E : ASH_C) : W ? W.col : null;
    aC[j4] = WC ? WC[0] : 1.60; aC[j4 + 1] = WC ? WC[1] : 1.38; aC[j4 + 2] = WC ? WC[2] : 0.94;
    aC[j4 + 3] = emb ? Math.min(1, av * 1.5) : av;
    aA[j] = ph; aA[j + 1] = emb ? T_EMBER : WTILE;
    n++;
  }
  return n;
}

// ══ per-frame entry point (MAIN's contract name preserved) ═══════════════════
let _lastTick = -1;
const MOTE_RES = MX * MY * MZ * MOTE_SUB;
let _dbgLast = '';                                   // last VFXDBG line (shot-mode log dedupe)
VFX.update = (t) => {
  _vt = t;
  stepBlast(t);
  const tick = Math.round(t * TPS);
  if (_lastTick < 0) {                               // first sight: back-fill the ambience
    for (let L = PQ.prime; L >= 1; L--) emitTick(tick - L, L * TICK);
    _lastTick = tick - 1;
  }
  for (let s = Math.min(2, tick - _lastTick); s >= 1; s--) emitTick(tick - s + 1, 0);
  if (tick > _lastTick) _lastTick = tick;
  DEC.uT.value = t;
  // The mote lattice lands in whichever bucket its material needs (ash dark = alpha,
  // snow/pollen additive) and reserves its worst case there so a busy frame can never
  // starve the weather — or the weather the effects.
  let na = stepBucket(BA, t, BA.cap - COIN_N - (MOTE_ALPHA ? MOTE_RES : 0));
  na = stepCoins(t, na);
  if (MOTE_ALPHA) na = stepMotes(t, na, BA);
  flush(BA, na);
  let nb = stepBucket(BB, t, BB.cap - (MOTE_ALPHA ? 0 : MOTE_RES) - COIN_FX);
  nb = stepCoinFX(t, nb);
  if (!MOTE_ALPHA) nb = stepMotes(t, nb, BB);
  flush(BB, nb);
  if (SHOT && P.has('dbg')) {                        // harness diagnostic (opt-in, deduped)
    let bd = -1, bx = 0, bz = 0;
    for (const e of G.enemies) if (e.alive && e.d > bd) { bd = e.d; bx = e.px; bz = e.pz; }
    const line = 'VFXDBG alpha=' + na + ' add=' + nb + ' front=' + bx.toFixed(1) + ',' + bz.toFixed(1) + ' d=' + bd.toFixed(1);
    if (line !== _dbgLast) { _dbgLast = line; console.log(line); }
  }
};

// ══ post / grade ═════════════════════════════════════════════════════════════
// Vignette + a warm sun wash as a plain alpha-composited CSS layer inserted UNDER
// #ui: zero extra GPU passes, no blend modes (headless capture drops the GL layer
// when the compositor has to do anything exotic), fully static so it never repaints
// after the final shot render.
{
  const gd = document.createElement('div');
  gd.id = 'vfxGrade';
  gd.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;background-image:' +
    'radial-gradient(circle at 5% -8%, rgba(255,224,168,.22) 0%, rgba(255,208,142,.08) 30%, rgba(255,200,130,0) 58%),' +
    'radial-gradient(ellipse 116% 92% at 50% 45%, rgba(0,0,0,0) 44%, rgba(20,12,4,.13) 73%, rgba(10,6,2,.40) 100%);';
  const ui = document.getElementById('ui');
  if (ui && ui.parentNode) ui.parentNode.insertBefore(gd, ui); else document.body.appendChild(gd);
}
VFX.post = (composer, bloom) => {
  // Threshold stays high so only the additive sparks, flashes, embers and gilt
  // glints bleed — the sunlit meadow must not smear.
  if (bloom) { bloom.strength = 0.34; bloom.radius = 0.80; bloom.threshold = 0.90; }
};
VFX.meshes = [BA.mesh, BB.mesh, DEC.mesh];
VFX.debug = () => ({ alpha: BA.n, add: BB.n });
}
// ══════════════════════ END SECTION: VFX ══════════════════════

// ══════════════════════ SECTION: AUDIO (owner: AUDIO builder) ══════════════════════
// Fully synthesised medieval score + battle SFX. No sample assets, no files. One graph:
//
//   lute / drone / drum buses ─► musicG ─► duckG ─┐
//   sfx voices ─► 9 fixed pan buses ─► sfxG ──────┤─► limiter ─► softClip ─► master ─► out
//   bus sends ─► convolver (procedural valley IR) ─► revRet ─┘
//
// Invariants: no AudioContext is constructed when SHOT is set (a screenshot must never
// touch audio, and audio timers would violate GAME_SPEC §2.3b); nothing exists before the
// player's first gesture; and G.rng() is never consumed here — Audio.play() is called from
// inside tickSim, so touching the sim stream would desynchronise the shot harness.
const Audio = (() => {
  let ac = null, ok = false, _muted = false, live = false;   // live = music scheduler running
  let master, musicG, duckG, sfxG, revIn, luteB, droneB, drumB;
  let droneG = null, droneLP = null, windG = null, timer = 0;
  let PANS = [], NOISE = null, BROWN = null, voices = 0;
  const KSC = new Map();                                     // Karplus-Strong buffer cache
  const gap = {};                                            // name -> last trigger time
  const MINGAP = { die: .055, bow: .05, clash: .03, coin: .07, ui: .02, boom: .07, ballista: .04,
    catapult: .05, build: .06, leak: 1.5, cleared: 2, horn: .5, victory: 4, defeat: 4,
    // SPEC2 §C/§D cues. `zap` and `mbow` are the spammy pair: a storm at tier 3 with a
    // banner behind it fires under a second, and a firing line of marauders looses every
    // 0.6 s per unit — without these gaps both turn into a buzz.
    zap: .085, mbow: .06, banner: .5, howl: 2.4, bosshorn: 4,
    // SPEC3 §A/§B/§D cues. The element impacts and `shrug` sit on the same short leash as
    // `clash` — they are a TEXTURE that tells you what your towers are doing to what is on
    // the road, and the moment one of them becomes a per-hit event it is a rattle. `shrug`
    // is the loosest of the four on purpose: an archer wall into a frost revenant would
    // otherwise clang eleven times a second and drown the wall it is criticising.
    thud: .07, sizzle: .10, crack: .07, shrug: .11,
    ironfoot: .085, wraith: .55, heal: .5, omen: .5 };
  // Voice ceiling. A dense wave can ask for far more than it can usefully hear, so the
  // ambient layers get culled first — but story cues (horn, alarm, stingers, UI) must never
  // be dropped, so they raise `prio` for the duration of their scheduling call.
  let VCAP = 56, prio = false;
  const PRIO = { horn: 1, leak: 1, cleared: 1, victory: 1, defeat: 1, build: 1, ui: 1,
    banner: 1, howl: 1, bosshorn: 1, omen: 1 };
  const MAPID = (G.MAP && G.MAP.id) || 1;                    // per-map ambience (SPEC2 §E)
  const room = n => prio || voices < VCAP - n;
  // private noise stream — see the header note about G.rng()
  let _as = 0x9e3779b9 >>> 0;
  const rnd = () => { _as ^= _as << 13; _as ^= _as >>> 17; _as ^= _as << 5; return (_as >>> 0) / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const mf = m => 440 * Math.pow(2, (m - 69) / 12);          // MIDI -> Hz
  const _av = new THREE.Vector3();
  const LOW = tier === 'mobile';                             // thin the fattest cues on phones

  // ══ buffers ═══════════════════════════════════════════════════════════════════
  function noiseBuf(sec, brown) {
    const sr = ac.sampleRate, n = Math.floor(sr * sec), b = ac.createBuffer(1, n, sr), d = b.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const w = rr(-1, 1);
      if (brown) { lp = (lp + w * 0.035) * 0.996; d[i] = clamp(lp * 9, -1, 1); } else d[i] = w;
    }
    return b;
  }
  // Karplus-Strong: a lowpassed noise burst circulating through a comb of period 1/f with a
  // 1-pole loop filter. Rendered into a buffer (a feedback DelayNode cannot go below one
  // render quantum, which would break every note above ~340 Hz).
  function ks(freq, dur) {
    // Rendered at a reduced rate (the source node resamples) and snapped to three length
    // buckets: the cache would otherwise reach ~20 MB of gut string on a phone.
    dur = dur < 0.6 ? 0.4 : dur < 1.8 ? 1.4 : 2.4;
    const key = Math.round(freq * 2) + '|' + dur;
    let b = KSC.get(key);
    if (b) return b;
    const sr = LOW ? 16000 : 22050, N = Math.max(3, Math.round(sr / freq)), len = Math.ceil(sr * dur);
    b = ac.createBuffer(1, len, sr);
    const out = b.getChannelData(0), ring = new Float32Array(N);
    let lp = 0, dc = 0;
    for (let i = 0; i < N; i++) { lp += (rr(-1, 1) - lp) * 0.42; ring[i] = lp; dc += lp; }   // gut-string pluck, not a snap
    dc /= N; for (let i = 0; i < N; i++) ring[i] -= dc;
    const damp = 1 - 0.00025 * (44100 / sr), tail = Math.min(len >> 1, 500);
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const v = ring[idx];
      out[i] = v;
      ring[idx] = (v + ring[(idx + 1) % N]) * 0.5 * damp;
      idx = (idx + 1) % N;
    }
    for (let i = 0; i < tail; i++) out[len - 1 - i] *= i / tail;                              // no end click
    KSC.set(key, b);
    return b;
  }
  // short exponentially-decaying stereo noise: a dry, hard-walled valley, not a cathedral
  function irBuf(sec) {
    const sr = ac.sampleRate, n = Math.floor(sr * sec), b = ac.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), pre = Math.floor(sr * (0.012 + c * 0.004));
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / (n - pre);
        lp += (rr(-1, 1) - lp) * 0.55;
        d[i] = lp * Math.pow(1 - t, 2.1) * Math.exp(-t * 3.4);
      }
      for (let k = 0; k < 5; k++) { const p = pre + Math.floor(sr * (0.021 + k * 0.017)); if (p < n) d[p] += (k % 2 ? -1 : 1) * 0.55 / (1 + k); }
    }
    return b;
  }

  // ══ graph ═════════════════════════════════════════════════════════════════════
  function init() {
    if (ok || SHOT) return ok;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ac = new AC({ latencyHint: 'interactive' });
      VCAP = tier === 'mobile' ? 36 : 56;
      if (ac.state === 'suspended') ac.resume();
      const g = (v, to) => { const n = ac.createGain(); n.gain.value = v; if (to) n.connect(to); return n; };

      master = g(_muted ? 0 : 0.85);
      // soft clip catches anything the compressor's attack lets through
      const clip = ac.createWaveShaper(), cv = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; cv[i] = Math.tanh(x * 1.22) / Math.tanh(1.22) * 0.97; }
      clip.curve = cv; clip.oversample = '2x';
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -8; comp.knee.value = 8; comp.ratio.value = 9;
      comp.attack.value = 0.004; comp.release.value = 0.22;
      comp.connect(clip); clip.connect(master); master.connect(ac.destination);

      duckG = g(1, comp);
      musicG = g(0.56, duckG);
      sfxG = g(0.95, comp);
      const revRet = g(tier === 'mobile' ? 0.34 : 0.46, comp);
      revIn = ac.createConvolver();
      revIn.buffer = irBuf(tier === 'mobile' ? 1.0 : 1.7);
      revIn.connect(revRet);

      luteB = g(0.9, musicG); luteB.connect(g(0.55, revIn));   // per-bus reverb sends
      droneB = g(1, musicG);
      drumB = g(1, musicG);   drumB.connect(g(0.3, revIn));
      // 9 fixed pan buses: positional sfx with zero per-voice node allocation
      PANS = [];
      for (let i = 0; i < 9; i++) {
        const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
        if (!p) { PANS.push(sfxG); continue; }
        p.pan.value = (i - 4) / 4 * 0.85; p.connect(sfxG); PANS.push(p);
      }
      sfxG.connect(revIn);

      NOISE = noiseBuf(2.2, false);
      BROWN = noiseBuf(4.0, true);
      ok = true;
    } catch (e) { ok = false; ac = null; }
    return ok;
  }

  // ══ voice primitives ══════════════════════════════════════════════════════════
  const count = n => { voices++; n.onended = () => { voices--; }; };
  const env = (p, t, a, peak, d) => {
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  // filtered noise burst.  filt/f0/f1: biquad type + start/end frequency sweep
  function nz(dest, t, peak, a, d, filt, f0, f1, q, brown) {
    if (!room(0)) return;
    const s = ac.createBufferSource();
    s.buffer = brown ? BROWN : NOISE; s.loop = true;
    s.playbackRate.value = rr(0.88, 1.14);
    let tail = s;
    if (filt) {
      const f = ac.createBiquadFilter();
      f.type = filt; f.Q.value = q || 1;
      f.frequency.setValueAtTime(Math.max(30, f0), t);
      if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + a + d);
      s.connect(f); tail = f;
    }
    const g = ac.createGain(); env(g.gain, t, a, peak, d);
    tail.connect(g); g.connect(dest);
    s.start(t, rr(0, 1.6)); s.stop(t + a + d + 0.03); count(s);
  }
  // pitched oscillator with an exponential pitch glide
  function tone(dest, t, type, f0, f1, peak, a, d, gl) {
    if (!room(0)) return;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(12, f1), t + (gl || a + d));
    const g = ac.createGain(); env(g.gain, t, a, peak, d);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + a + d + 0.03); count(o);
  }
  // detuned-saw brass through a swept lowpass — horns and fanfares
  function brass(dest, t, freq, dur, peak) {
    if (!room(6)) return;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 1.3;
    f.frequency.setValueAtTime(freq * 1.4, t);
    f.frequency.linearRampToValueAtTime(freq * 7.5, t + 0.10);
    f.frequency.linearRampToValueAtTime(freq * 3.0, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.07);
    g.gain.setValueAtTime(peak, t + dur * 0.72);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.22);
    f.connect(g); g.connect(dest);
    const vib = ac.createOscillator(), vg = ac.createGain();
    vib.frequency.value = rr(4.4, 5.6); vg.gain.value = 5.5; vib.connect(vg);
    for (const dt of [0, 7, -6]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = dt;
      vg.connect(o.detune); o.connect(f); o.start(t); o.stop(t + dur + 0.3); count(o);
    }
    tone(f, t, 'sine', freq * 0.5, 0, peak * 0.5, 0.06, dur + 0.1);   // body
    vib.start(t); vib.stop(t + dur + 0.3);
  }
  function bell(dest, t, freq, peak, dur) {
    const P = [[1, 1], [2.01, .5], [2.98, .32], [4.21, .2], [5.43, .12]];
    for (const [m, a] of P) tone(dest, t, 'sine', freq * m, 0, peak * a, 0.006, dur * (1 - 0.12 * m));
  }
  function drum(dest, t, peak, deep) {
    const f0 = deep ? 96 : 152;
    tone(dest, t, 'sine', f0 * 1.85, f0 * 0.6, peak, 0.004, deep ? 0.26 : 0.13, 0.085);
    nz(dest, t, peak * 0.42, 0.002, deep ? 0.085 : 0.05, 'bandpass', deep ? 250 : 560, 0, 1.2);
  }
  function pluck(t, freq, peak, dur) {
    if (!room(4)) return;
    const s = ac.createBufferSource(); s.buffer = ks(freq, dur);
    const bod = ac.createBiquadFilter();
    bod.type = 'peaking'; bod.frequency.value = rr(390, 470); bod.Q.value = 1.1; bod.gain.value = 5.5;
    const g = ac.createGain(); g.gain.value = peak;
    s.connect(bod); bod.connect(g); g.connect(luteB);
    s.start(t); s.stop(t + s.buffer.duration + 0.02); count(s);
  }

  // ══ sfx ═══════════════════════════════════════════════════════════════════════
  function duck(amt, dur) {
    const t = ac.currentTime, p = duckG.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(Math.max(0.2, 1 - amt), t + 0.035);
    p.linearRampToValueAtTime(1, t + 0.035 + dur);
  }
  const SFX = {
    ui(d, t) { nz(d, t, 0.09, 0.001, 0.028, 'bandpass', 2400, 1500, 3); tone(d, t, 'triangle', 1180, 900, 0.05, 0.002, 0.05); },
    build(d, t) {                                          // mallet on timber + stone settle
      for (let i = 0; i < 3; i++) { const tt = t + i * 0.085; nz(d, tt, 0.2 - i * 0.04, 0.002, 0.05, 'bandpass', rr(900, 1500), 400, 2.4); tone(d, tt, 'triangle', rr(210, 280), 130, 0.13, 0.003, 0.09); }
      tone(d, t + 0.26, 'sine', 92, 52, 0.28, 0.006, 0.2, 0.12);
      nz(d, t + 0.26, 0.12, 0.004, 0.22, 'lowpass', 900, 300, 0.9);
    },
    bow(d, t) {                                            // string twang + fletch whoosh
      pluckSfx(d, t, rr(300, 380), 0.16, 0.55);
      nz(d, t, 0.28, 0.002, 0.05, 'bandpass', rr(1700, 2400), 900, 4);
      nz(d, t + 0.02, 0.15, 0.03, 0.19, 'bandpass', 1500, 520, 1.5);
    },
    ballista(d, t) {                                       // heavy iron thunk + bolt whoosh
      tone(d, t, 'triangle', 168, 62, 0.42, 0.003, 0.16, 0.1);
      nz(d, t, 0.3, 0.002, 0.07, 'bandpass', 720, 300, 1.6);
      nz(d, t, 0.16, 0.001, 0.035, 'highpass', 3200, 0, 0.7);
      nz(d, t + 0.03, 0.14, 0.05, 0.3, 'bandpass', 1100, 340, 1.3);
      tone(d, t + 0.01, 'sawtooth', 132, 118, 0.05, 0.02, 0.22);      // timber groan
    },
    catapult(d, t) {                                       // rope creak, release clack, whoosh
      for (let i = 0; i < 5; i++) tone(d, t + i * 0.045, 'sawtooth', rr(88, 150), 0, 0.045, 0.01, 0.05);
      nz(d, t + 0.22, 0.38, 0.001, 0.06, 'bandpass', 1250, 520, 2.2);
      tone(d, t + 0.22, 'triangle', 190, 78, 0.36, 0.003, 0.15, 0.09);
      nz(d, t + 0.24, 0.24, 0.09, 0.42, 'bandpass', 620, 1500, 1.1);  // arm sweeping air
    },
    storm(d, t) {                                          // crystal charge + dry lightning crack
      tone(d, t, 'sine', 1560, 2400, 0.05, 0.02, 0.12);    // the spire winding up
      nz(d, t + 0.07, 0.34, 0.0008, 0.045, 'highpass', 3400, 0, 0.7);   // the crack
      nz(d, t + 0.07, 0.30, 0.001, 0.09, 'bandpass', 1500, 4200, 1.1);
      tone(d, t + 0.07, 'square', 220, 90, 0.12, 0.001, 0.09);
      for (let i = 0; i < 3; i++) nz(d, t + 0.10 + i * 0.035, 0.10 - i * 0.025, 0.001, 0.05, 'bandpass', rr(2200, 5200), 0, 4);
      nz(d, t + 0.12, 0.13, 0.02, 0.42, 'lowpass', 620, 200, 0.9);      // rolling tail
    },
    pyre(d, t) {                                           // davit creak, release, pot whoosh
      for (let i = 0; i < 3; i++) tone(d, t + i * 0.05, 'sawtooth', rr(96, 148), 0, 0.04, 0.012, 0.06);
      tone(d, t + 0.18, 'triangle', 176, 70, 0.30, 0.003, 0.13, 0.08);
      nz(d, t + 0.18, 0.26, 0.001, 0.05, 'bandpass', 1050, 460, 2.0);
      nz(d, t + 0.21, 0.20, 0.08, 0.40, 'bandpass', 560, 1400, 1.0);
    },
    firepot(d, t) {                                        // clay shatter + whoomph of pitch
      nz(d, t, 0.30, 0.001, 0.055, 'bandpass', 2600, 1400, 5);
      for (let i = 0; i < 4; i++) nz(d, t + 0.01 + rnd() * 0.06, 0.07, 0.001, 0.04, 'bandpass', rr(1800, 4200), 0, 6);
      tone(d, t, 'sine', 108, 44, 0.34, 0.006, 0.26, 0.15);
      nz(d, t + 0.02, 0.30, 0.02, 0.55, 'lowpass', 900, 320, 0.8);      // the fire taking hold
      nz(d, t + 0.10, 0.14, 0.10, 0.95, 'bandpass', 430, 260, 0.8, true);
    },
    boom(d, t) {                                           // sub thump + body + debris
      duck(0.42, 0.55);
      tone(d, t, 'sine', 84, 26, 0.95, 0.006, 0.5, 0.3);
      tone(d, t, 'triangle', 132, 44, 0.35, 0.004, 0.24, 0.16);
      nz(d, t, 0.5, 0.003, 0.34, 'lowpass', 1500, 260, 0.9);
      nz(d, t, 0.24, 0.001, 0.06, 'highpass', 2600, 0, 0.8);
      for (let i = 0, k = LOW ? 3 : 7; i < k; i++) nz(d, t + 0.09 + rnd() * 0.42, 0.055, 0.001, 0.05, 'bandpass', rr(700, 2600), 0, 3);
      nz(d, t + 0.1, 0.11, 0.12, 0.85, 'lowpass', 520, 180, 0.8, true);
    },
    stomp(d, t) {                                          // SPEC2 §D — the ogre's foot
      duck(0.34, 0.46);                                    // sub thud, body slap, earth roll
      // VFX/AUDIO-2: a second, slower sub an octave down. The single 62 Hz thud read as a
      // big drum; the ogre needs weight you feel through the floor, and the long tail is
      // what makes the dust ring look heavy rather than fast.
      tone(d, t, 'sine', 40, 17, 0.72, 0.006, 0.72, 0.44);
      tone(d, t, 'sine', 62, 22, 0.88, 0.004, 0.42, 0.26);
      tone(d, t, 'triangle', 104, 38, 0.30, 0.004, 0.20, 0.14);
      nz(d, t, 0.42, 0.002, 0.26, 'lowpass', 1100, 190, 0.9);
      nz(d, t + 0.06, 0.14, 0.05, 0.58, 'lowpass', 420, 150, 0.8, true);
      for (let i = 0, k = LOW ? 2 : 4; i < k; i++) nz(d, t + 0.08 + rnd() * 0.24, 0.05, 0.001, 0.05, 'bandpass', rr(600, 1900), 0, 3);
    },
    clash(d, t) {                                          // sword on shield / helm
      const f = rr(2100, 3400);
      nz(d, t, 0.26, 0.001, 0.055, 'bandpass', f, f * 0.6, 6);
      nz(d, t, 0.17, 0.001, 0.03, 'highpass', 5200, 0, 0.8);
      tone(d, t, 'square', f * 0.82, 0, 0.06, 0.001, 0.16);
      tone(d, t, 'triangle', f * 1.34, 0, 0.045, 0.001, 0.1);
      tone(d, t, 'triangle', rr(150, 210), 0, 0.12, 0.002, 0.06);     // thud of the blow
    },
    die(d, t) {                                            // short filtered grunt
      const f = rr(300, 470);
      nz(d, t, 0.22, 0.006, 0.11, 'bandpass', f * 2.4, f * 1.1, 3.5);
      tone(d, t, 'sawtooth', f * 0.5, f * 0.34, 0.1, 0.01, 0.12);
      nz(d, t + 0.05, 0.07, 0.01, 0.1, 'lowpass', 1100, 400, 0.9);
    },
    coin(d, t) {                                           // little rising clink arpeggio
      const F = [2093, 2794, 3136, 4186];
      for (let i = 0; i < 3; i++) {
        const tt = t + i * 0.045, f = F[i] * rr(0.99, 1.01);
        tone(d, tt, 'triangle', f, 0, 0.11, 0.002, 0.12);
        tone(d, tt, 'sine', f * 2.01, 0, 0.04, 0.002, 0.07);
      }
      nz(d, t, 0.05, 0.001, 0.03, 'highpass', 6000, 0, 0.7);
    },
    horn(d, t) {                                           // two-note war horn
      duck(0.34, 1.9);
      const f = mf(50);                                    // D3
      brass(d, t, f, 0.55, 0.3);
      brass(d, t + 0.02, f * 1.5, 0.5, 0.14);
      brass(d, t + 0.62, f * 1.5, 1.05, 0.3);
      brass(d, t + 0.64, f * 2, 1.0, 0.13);
      drum(d, t + 0.62, 0.5, true);
      drum(d, t + 0.95, 0.3, true);
    },
    leak(d, t) {                                           // gate-breach alarm
      duck(0.5, 1.6);
      bell(d, t, 392, 0.3, 1.5);
      bell(d, t + 0.34, 330, 0.24, 1.3);
      for (let i = 0; i < 4; i++) tone(d, t + i * 0.19, 'square', i % 2 ? 466 : 622, 0, 0.075, 0.012, 0.14);
      tone(d, t, 'sine', 70, 40, 0.4, 0.01, 0.7, 0.4);
    },
    cleared(d, t) {                                        // triumphant sting
      duck(0.4, 2.0);
      const R = mf(62);
      brass(d, t, R * 0.5, 0.42, 0.22);
      brass(d, t + 0.2, R * 0.75, 0.42, 0.2);
      brass(d, t + 0.4, R, 1.1, 0.26);
      brass(d, t + 0.42, R * 1.5, 1.0, 0.14);
      drum(d, t, 0.45, true); drum(d, t + 0.4, 0.55, true);
      nz(d, t + 0.4, 0.06, 0.02, 0.9, 'highpass', 5200, 8000, 0.7);
      for (let i = 0; i < 4; i++) pluck(t + 0.42 + i * 0.07, mf(74 + [0, 4, 7, 12][i]), 0.16, 1.1);
    },
    victory(d, t) {                                        // full fanfare
      live = false; mode = 'end'; duck(0.55, 5);
      const M = [[62, 0, .5], [69, .42, .34], [70, .78, .3], [69, 1.1, .3], [74, 1.5, 1.5]];
      for (const [n, o, dur] of M) { brass(d, t + o, mf(n), dur, 0.3); if (!LOW) brass(d, t + o + 0.02, mf(n + 12), dur, 0.12); }
      for (const n of (LOW ? [50, 62] : [50, 57, 62, 66])) brass(d, t + 1.5, mf(n), 1.7, 0.13);   // D major resolve
      for (let i = 0, k = LOW ? 7 : 12; i < k; i++) drum(d, t + 1.0 + i * 0.055, 0.14 + i * 0.02, false);
      drum(d, t, 0.5, true); drum(d, t + 1.5, 0.7, true);
      bell(d, t + 1.55, 1174, 0.14, 2.4);
    },
    defeat(d, t) {                                         // somber
      live = false; mode = 'end'; duck(0.6, 6);
      for (let i = 0; i < 3; i++) bell(d, t + i * 1.15, 165, 0.26, 3.0);
      const C = [[50, 0], [53, .5], [57, 1.0], [48, 2.2]];
      for (const [n, o] of C) { brass(d, t + o, mf(n), 2.2, 0.13); tone(d, t + o, 'sine', mf(n - 12), 0, 0.16, 0.5, 2.2); }
      nz(d, t, 0.09, 1.2, 3.0, 'lowpass', 340, 150, 0.8, true);
    },
    // ══ SPEC2 §C/§D/§E — VFX/AUDIO-2 cues ════════════════════════════════════
    zap(d, t) {                                            // chain lightning striking home
      nz(d, t, 0.30, 0.0006, 0.032, 'highpass', 5400, 0, 0.7);     // the crack, all top end
      nz(d, t, 0.22, 0.001, 0.075, 'bandpass', 2400, 6200, 1.4);
      tone(d, t, 'square', 1720, 300, 0.10, 0.001, 0.07);          // the zap: a fast down-sweep
      tone(d, t + 0.004, 'sawtooth', 2500, 720, 0.045, 0.001, 0.05);
      nz(d, t + 0.03, 0.085, 0.012, 0.28, 'lowpass', 850, 240, 0.9);   // short rolling tail
    },
    // The marauder carries a short bow, not a war bow: the tower cue at -3 dB with the
    // string and the fletch whoosh pitched down a fourth (SPEC2 §D).
    mbow(d, t) {
      pluckSfx(d, t, rr(205, 258), 0.16, 0.39);
      nz(d, t, 0.20, 0.002, 0.05, 'bandpass', rr(1180, 1680), 620, 4);
      nz(d, t + 0.02, 0.105, 0.03, 0.19, 'bandpass', 1040, 360, 1.5);
    },
    banner(d, t) {                                         // a standard planted: mallets, then brass
      SFX.build(d, t);
      const f = mf(57);                                    // A2 — a fifth under the war horn
      brass(d, t + 0.30, f, 0.64, 0.22);
      brass(d, t + 0.33, f * 1.5, 0.58, 0.11);
      drum(d, t + 0.30, 0.34, true);
      bell(d, t + 0.44, 880, 0.055, 1.1);
    },
    howl(d, t) {                                           // the pack answering the horn
      for (let i = 0, k = LOW ? 2 : 3; i < k; i++) {
        const t0 = t + i * rr(0.12, 0.30), f = rr(300, 430);
        tone(d, t0, 'sawtooth', f * 0.62, f * 1.22, 0.095, 0.09, 0.52, 0.30);
        tone(d, t0 + 0.02, 'triangle', f * 1.2, f * 2.2, 0.045, 0.10, 0.48, 0.30);
        nz(d, t0, 0.05, 0.08, 0.46, 'bandpass', f * 2, f * 3, 2.4);
      }
    },
    bosshorn(d, t) {                                       // a map finale naming itself
      duck(0.45, 2.8);
      const f = mf(38);                                    // D2, an octave under the war horn
      brass(d, t, f, 1.5, 0.30);
      brass(d, t + 0.03, f * 1.5, 1.42, 0.15);
      tone(d, t, 'sine', mf(26), 0, 0.42, 0.06, 1.9);
      drum(d, t, 0.60, true); drum(d, t + 0.56, 0.42, true);
      bell(d, t + 0.10, 196, 0.13, 2.6);
    },
    crow(d, t) {                                           // Frostfell ambience, calm phases
      const f = rr(500, 700);
      for (let i = 0, k = 2 + (rnd() * 2 | 0); i < k; i++) {
        const t0 = t + i * rr(0.17, 0.30);
        nz(d, t0, 0.055, 0.006, 0.16, 'bandpass', f, f * 0.70, 5.5);
        tone(d, t0, 'sawtooth', f * 0.5, f * 0.42, 0.026, 0.008, 0.16);
      }
    },
    bird(d, t) {                                           // ambience only, calm phases
      const f = rr(2400, 3600);
      for (let i = 0, k = 2 + (rnd() * 3 | 0); i < k; i++)
        tone(d, t + i * rr(0.06, 0.11), 'sine', f * rr(0.9, 1.15), f * rr(1.2, 1.5), 0.028, 0.006, 0.055);
    },
    // ══ SPEC3 §A — element impact variants ═══════════════════════════════════
    // Pierce keeps the bow report it always had and adds NOTHING at the hit: four arrows a
    // second into a wall of shields would turn any per-hit cue into a buzz, and the wheel's
    // job here is contrast — you learn what pierce sounds like by hearing the other three.
    thud(d, t) {                                           // crush: a rock caving in plate
      tone(d, t, 'sine', 126, 50, 0.36, 0.003, 0.17, 0.09);
      tone(d, t, 'triangle', 212, 94, 0.15, 0.002, 0.085);
      nz(d, t, 0.22, 0.001, 0.075, 'lowpass', 1400, 420, 0.9);
      nz(d, t + 0.012, 0.09, 0.001, 0.04, 'bandpass', 2500, 1200, 4.5);   // grit off the strike
    },
    sizzle(d, t) {                                         // fire: pitch catching on cloth
      nz(d, t, 0.18, 0.001, 0.05, 'bandpass', 3100, 1300, 3.2);
      nz(d, t + 0.01, 0.14, 0.02, 0.36, 'bandpass', 880, 330, 0.9, true);
      tone(d, t, 'sine', 148, 60, 0.15, 0.004, 0.12, 0.07);
      for (let i = 0, k = LOW ? 2 : 3; i < k; i++)
        nz(d, t + 0.02 + rnd() * 0.13, 0.045, 0.001, 0.03, 'bandpass', rr(1800, 4600), 0, 6);
    },
    crack(d, t) {                                          // storm: a dry snap, no roll
      nz(d, t, 0.24, 0.0005, 0.026, 'highpass', 5200, 0, 0.7);
      tone(d, t, 'square', 1420, 250, 0.085, 0.001, 0.055);
      nz(d, t + 0.006, 0.13, 0.001, 0.062, 'bandpass', 2200, 5600, 1.3);
    },
    // NOTHING WENT IN. Deliberately dead: a damped clank with the ring taken out of it, so
    // it is instantly tellable from clash(), which is bright and alive. This is the sound of
    // wasted gold, and the player has to hear it that way.
    shrug(d, t) {
      const f = rr(420, 560);
      tone(d, t, 'triangle', f, f * 0.54, 0.125, 0.001, 0.07);
      tone(d, t, 'sine', f * 0.5, f * 0.31, 0.085, 0.002, 0.09);
      nz(d, t, 0.12, 0.001, 0.034, 'bandpass', f * 3.2, f * 1.6, 3);
      nz(d, t + 0.012, 0.05, 0.005, 0.055, 'lowpass', 860, 300, 0.9);
    },
    // ══ SPEC3 §B — the newcomers announce themselves ═════════════════════════
    // The war shaman is a PRIORITY KILL the player has to find inside a column of three
    // hundred, so he has to be audible before he is visible: a struck bowl over a bowed
    // drone, the only consonant thing on the road and the only cue that rings.
    heal(d, t) {
      bell(d, t, 622, 0.085, 1.5);                         // D#5 — outside the score's D minor
      bell(d, t + 0.10, 932, 0.045, 1.1);
      tone(d, t, 'sine', 155, 0, 0.075, 0.10, 0.85);       // the bowed drone under it
      tone(d, t + 0.01, 'triangle', 233, 0, 0.032, 0.14, 0.7);
      nz(d, t, 0.035, 0.02, 0.5, 'bandpass', 2400, 3400, 2.2);
    },
    ironfoot(d, t) {                                       // plate, greaves and a shield rim
      tone(d, t, 'sine', 74, 34, 0.30, 0.004, 0.20, 0.11);
      nz(d, t, 0.16, 0.002, 0.09, 'lowpass', 700, 240, 0.9);
      const f = rr(1500, 2300);                            // the metal on top of the weight
      nz(d, t + 0.008, 0.085, 0.001, 0.05, 'bandpass', f, f * 0.6, 5);
      tone(d, t + 0.008, 'triangle', f * 0.9, 0, 0.035, 0.001, 0.07);
    },
    wraith(d, t) {                                         // a whisper going past the lens
      const f = rr(620, 900);
      nz(d, t, 0.055, 0.16, 0.55, 'bandpass', f, f * 2.6, 3.4);
      nz(d, t + 0.10, 0.038, 0.12, 0.45, 'bandpass', f * 2.2, f * 0.7, 2.6);
      tone(d, t + 0.04, 'sine', f * 0.26, f * 0.19, 0.028, 0.16, 0.42);
    },
    // ══ SPEC3 §D — the muster's own stinger ══════════════════════════════════
    // Taking an omen is the only decision in BANNERFALL that is not a purchase, so it gets
    // a page turn (two brushed noise strokes, the second longer, as a leaf falls back) and
    // a low choir swell underneath. Ducked, because it happens over the music, not under it.
    omen(d, t) {
      duck(0.30, 1.1);
      nz(d, t, 0.16, 0.010, 0.10, 'bandpass', 2100, 4200, 1.2);          // the leaf lifting
      nz(d, t + 0.11, 0.19, 0.012, 0.20, 'bandpass', 3000, 1100, 1.0);   // and falling back
      nz(d, t + 0.11, 0.06, 0.004, 0.05, 'highpass', 6000, 0, 0.7);      // the paper's edge
      const R = mf(45);                                                  // A2, under the horn
      for (const [m, a, o] of [[1, .085, 0], [1.5, .05, .05], [2, .038, .09], [3, .022, .14]]) {
        tone(d, t + 0.16 + o, 'sine', R * m, 0, a, 0.26, 1.05);
        if (!LOW) tone(d, t + 0.17 + o, 'triangle', R * m * 1.005, 0, a * 0.42, 0.30, 0.95);
      }
      bell(d, t + 0.30, 1046, 0.045, 1.7);                               // the seal set on it
    },
  };
  // a plucked-string transient for the bow (short, damped, sent to the sfx bus not the lute bus)
  function pluckSfx(d, t, freq, dur, amp) {
    if (!room(4)) return;
    const s = ac.createBufferSource(); s.buffer = ks(freq, dur);
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq * 3; f.Q.value = 1.2;
    const g = ac.createGain(); g.gain.value = amp;
    s.connect(f); f.connect(g); g.connect(d);
    s.start(t); s.stop(t + s.buffer.duration + 0.02); count(s);
  }

  // ══ fire bed (SPEC2 §C/§E) ════════════════════════════════════════════════════
  // ONE looping voice for every burning patch on the map: a pyre wall must not become a
  // wall of noise, and per-patch loops would be per-patch node churn on top of it. Two
  // layers — a filtered roar off the brown-noise buffer and a sparse crackle buffer — and
  // the level is driven from sched(), which is the ONE timer this file owns. Deliberately
  // quiet: it is a bed under the music, not an event. Ember Wastes keeps a floor under it
  // even with no pyre on the map, because that ground smoulders on its own.
  let fireG = null, fireLP = null, crackG = null, CRACK = null;
  function crackBuf() {                                      // sparse decaying pops
    const sr = ac.sampleRate, n = Math.floor(sr * 3.1), b = ac.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let k = 0; k < 240; k++) {
      const p = Math.floor(rnd() * (n - 2400)), len = 140 + (rnd() * 900 | 0), amp = 0.25 + rnd() * 0.75;
      for (let i = 0; i < len; i++) d[p + i] += rr(-1, 1) * amp * Math.pow(1 - i / len, 5);
    }
    return b;
  }
  function startFireBed() {
    if (fireG) return;
    const t = ac.currentTime;
    fireG = ac.createGain(); fireG.gain.value = 0.0001; fireG.connect(sfxG);
    const s = ac.createBufferSource(); s.buffer = BROWN; s.loop = true;
    fireLP = ac.createBiquadFilter(); fireLP.type = 'lowpass'; fireLP.frequency.value = 520; fireLP.Q.value = 0.9;
    s.connect(fireLP); fireLP.connect(fireG); s.start(t);
    CRACK = CRACK || crackBuf();
    const c = ac.createBufferSource(); c.buffer = CRACK; c.loop = true;
    const cf = ac.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 1900; cf.Q.value = 0.9;
    crackG = ac.createGain(); crackG.gain.value = 0.0001;
    c.connect(cf); cf.connect(crackG); crackG.connect(fireG); c.start(t);
  }
  function fireBed(now) {
    let act = 0;
    const PA = G.patches, vt0 = G.vt();
    if (PA) for (let i = 0; i < PA.length; i++) { const f = (vt0 - PA[i].born) / PA[i].dur; if (f >= 0 && f <= 1) act++; }
    const bed = Math.max(MAPID === 3 ? 0.24 : 0, Math.min(1, act * 0.55));
    if (!fireG && bed < 0.01) return;
    startFireBed();
    fireG.gain.setTargetAtTime(0.085 * bed, now, act ? 0.16 : 0.55);
    fireLP.frequency.setTargetAtTime(380 + 560 * bed, now, 0.35);
    crackG.gain.setTargetAtTime(0.50 * bed, now, 0.25);
  }
  // ══ standing layers (SPEC3 §B/§D) ════════════════════════════════════════════
  // Two things in v3 are STATES, not events: a siege ram grinding down the road, and a wave
  // warded against one of the player's schools. Both last a minute or more, so both would
  // be nonsense as repeated one-shots — they are BEDS, exactly like the fire bed above:
  // one voice each, built lazily, level driven from sched(), which is the one timer this
  // file owns. The ram's "cap 1" is therefore structural rather than a counter: there is
  // one bed no matter how many rams a swap slot fields.
  let creakG = null, creakBP = null, wardG = null, wardLP = null, wardOsc = null, wardTremG = null;
  function startCreakBed() {
    if (creakG) return;
    const t = ac.currentTime;
    creakG = ac.createGain(); creakG.gain.value = 0.0001; creakG.connect(sfxG);
    // the axle: brown noise through a HIGH-Q bandpass whose resonance is swept by two
    // incommensurate LFOs, so the groan never lands on the same note twice
    const s = ac.createBufferSource(); s.buffer = BROWN; s.loop = true; s.playbackRate.value = 0.55;
    creakBP = ac.createBiquadFilter(); creakBP.type = 'bandpass'; creakBP.frequency.value = 230; creakBP.Q.value = 9;
    s.connect(creakBP); creakBP.connect(creakG); s.start(t);
    for (const [f, a] of [[0.31, 98], [0.113, 47]]) {
      const l = ac.createOscillator(), g = ac.createGain();
      l.frequency.value = f; g.gain.value = a; l.connect(g); g.connect(creakBP.frequency); l.start(t);
    }
    // and the timber weight under it
    const w = ac.createBufferSource(); w.buffer = BROWN; w.loop = true; w.playbackRate.value = 0.4;
    const wf = ac.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 155; wf.Q.value = 0.9;
    const wg = ac.createGain(); wg.gain.value = 0.55;
    w.connect(wf); wf.connect(wg); wg.connect(creakG); w.start(t);
  }
  // The ward names its school by PITCH — same chord, four roots — so a player who has heard
  // it once knows which of his towers has just been shut out without reading the banner.
  const WARDN = { pierce: 0, crush: -4, fire: 5, storm: 9 };
  const WARDP = [[1, 'sawtooth', 0.85, 0], [1, 'triangle', 0.5, 8], [2, 'triangle', 0.26, -7], [3, 'sine', 0.14, 5]];
  function startWardBed() {
    if (wardG) return;
    const t = ac.currentTime;
    wardG = ac.createGain(); wardG.gain.value = 0.0001; wardG.connect(sfxG); wardG.connect(revIn);
    wardLP = ac.createBiquadFilter(); wardLP.type = 'lowpass'; wardLP.Q.value = 1.4; wardLP.frequency.value = 760;
    // The shimmer rides its OWN gain stage in series, never wardG's. An LFO connected to an
    // AudioParam is ADDITIVE, so hanging it on the level control would keep swinging the bed
    // between −0.3 and +0.3 long after the level had been taken to silence — i.e. a hum that
    // never stops. One extra node is the whole fix.
    wardTremG = ac.createGain(); wardTremG.gain.value = 1;
    wardLP.connect(wardTremG); wardTremG.connect(wardG);
    wardOsc = [];
    for (const [m, ty, a, det] of WARDP) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = ty; o.frequency.value = mf(45) * m; o.detune.value = det;
      g.gain.value = a; o.connect(g); g.connect(wardLP); o.start(t);
      wardOsc.push([o, m]);
    }
    const trem = ac.createOscillator();                      // the shimmer, matching the tint pulse
    const tg = ac.createGain(); tg.gain.value = 0.32;
    trem.frequency.value = 0.37; trem.connect(tg); tg.connect(wardTremG.gain); trem.start(t);
  }
  function beds(now) {
    // ── the ram: one bed, level from how many are rolling and how close the nearest is
    let rams = 0;
    const EN = G.enemies;
    for (let i = 0; i < EN.length; i++) { const e = EN[i]; if (e.alive && e.type === 'ram') rams++; }
    if (creakG || rams) {
      startCreakBed();
      const lv = Math.min(1, rams * 0.8);
      creakG.gain.setTargetAtTime(0.10 * lv, now, rams ? 0.45 : 0.9);
      creakBP.Q.setTargetAtTime(rams ? 9 : 4, now, 1.0);
    }
    // ── the ward: only while the wave it rides is actually on the road
    const FX = G.OMEN_FX, on = FX.ward > 0 && FX.wardEl && G.state.phase === 'wave';
    if (wardG || on) {
      startWardBed();
      if (on) {
        const base = mf(45 + (WARDN[FX.wardEl] || 0));
        for (const [o, m] of wardOsc) o.frequency.setTargetAtTime(base * m, now, 0.5);
      }
      wardG.gain.setTargetAtTime(on ? 0.062 : 0.0001, now, on ? 1.2 : 0.8);
      wardLP.frequency.setTargetAtTime(on ? 780 : 380, now, 1.2);
    }
  }
  // ── SPEC3 §B presence: footfalls, whispers, and fire refusing to take hold ──────
  // Rate-derived exactly like melee(): the number of each species on the road sets a rate,
  // an accumulator spends it, and MINGAP does the rest. Emitted here rather than from the
  // sim so a headless catch-up of ten thousand ticks cannot queue ten thousand footsteps.
  let footAcc = 0, whAcc = 0;
  function presence(dt) {
    let ni = 0, nw = 0, ic = null, wr = null;
    const EN = G.enemies;
    for (let i = 0; i < EN.length; i++) {
      const e = EN[i];
      if (!e.alive) continue;
      if (e.type === 'ironclad') { ni++; if (rnd() * ni < 1) ic = e; }          // reservoir pick
      else if (e.type === 'ashwraith') { nw++; if (rnd() * nw < 1) wr = e; }
    }
    if (ni && ic) {
      footAcc += Math.min(4.5, 1.05 * Math.sqrt(ni) * 1.5) * dt;
      let k = 0;
      while (footAcc >= 1 && k++ < 2) { footAcc -= 1; play('ironfoot', ic.px, ic.pz, 0.46 + 0.22 * rnd()); }
      if (footAcc > 2.5) footAcc = 2.5;
    } else footAcc = 0;
    if (nw && wr) {
      whAcc += Math.min(1.3, 0.34 * Math.sqrt(nw)) * dt;
      if (whAcc >= 1) { whAcc -= 1; play('wraith', wr.px, wr.pz, 0.42 + 0.2 * rnd()); }
      if (whAcc > 1.6) whAcc = 1.6;
      // fire immunity, made audible: a wraith standing IN burning ground still only hisses.
      const PA = G.patches, vt0 = G.vt();
      if (PA && PA.length && rnd() < dt * 0.8) {
        for (let i = 0; i < PA.length; i++) {
          const pa = PA[i], f = (vt0 - pa.born) / pa.dur;
          if (f < 0 || f > 1) continue;
          if ((wr.px - pa.x) ** 2 + (wr.pz - pa.z) ** 2 <= pa.r * pa.r) { play('sizzle', wr.px, wr.pz, 0.4); break; }
        }
      }
    } else whAcc = 0;
  }

  // Per-map ambience (SPEC2 §E): the Vale hears songbirds over a soft valley draught;
  // Frostfell hears a colder, brighter wind and the odd crow; Ember Wastes hears almost
  // no wildlife at all — the fire bed above is its ambience.
  const AMB = MAPID === 2 ? 'crow' : MAPID === 3 ? null : 'bird';
  const WIND = MAPID === 2 ? { g: 0.075, f: 780, b: 0.055, s: 0.030 }
             : MAPID === 3 ? { g: 0.052, f: 300, b: 0.040, s: 0.022 }
             : { g: 0.040, f: 480, b: 0.032, s: 0.026 };

  // ══ music ═════════════════════════════════════════════════════════════════════
  // D aeolian, i–VII–VI–V (Dm C Bb A): the descending medieval cadence. One 8-step (eighth
  // note) grid; `mode` selects density, `intens` follows the size of the horde on the road.
  const CH = [[62, 65, 69, 74], [60, 64, 67, 72], [58, 62, 65, 70], [57, 61, 64, 69]];
  const CALM_S = [0, 3, 4, 6], CALM_I = [0, 1, 2, 1];
  const DRV_I = [0, 1, 2, 3, 2, 1, 2, 3];
  let mode = 'calm', step = 0, bar = 0, stepT = 0, intens = 0.3, mel = 0;

  function startDrone() {
    const t = ac.currentTime;
    droneLP = ac.createBiquadFilter(); droneLP.type = 'lowpass'; droneLP.Q.value = 1.6; droneLP.frequency.value = 420;
    droneG = ac.createGain(); droneG.gain.value = 0.0001;
    droneLP.connect(droneG); droneG.connect(droneB); droneG.connect(revIn);
    droneG.gain.linearRampToValueAtTime(0.12, t + 3.5);
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = 0.062; lg.gain.value = 5.5; lfo.connect(lg); lfo.start(t);
    for (const [m, ty, a, det] of [[38, 'sine', 1, 0], [38, 'triangle', .5, 6], [45, 'triangle', .28, -7], [50, 'sawtooth', .10, 4]]) {
      const o = ac.createOscillator(), g2 = ac.createGain();
      o.type = ty; o.frequency.value = mf(m); o.detune.value = det;
      g2.gain.value = a; lg.connect(o.detune);
      o.connect(g2); g2.connect(droneLP); o.start(t);
    }
    // valley wind
    const w = ac.createBufferSource(); w.buffer = BROWN; w.loop = true;
    const wf = ac.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = WIND.f; wf.Q.value = 0.8;
    windG = ac.createGain(); windG.gain.value = 0.0001;
    w.connect(wf); wf.connect(windG); windG.connect(master);
    windG.gain.linearRampToValueAtTime(WIND.g, t + 4);
    const wl = ac.createOscillator(), wlg = ac.createGain();
    wl.frequency.value = 0.085; wlg.gain.value = 0.022; wl.connect(wlg); wlg.connect(windG.gain); wl.start(t);
    w.start(t);
  }
  function emit(t, sd) {
    if (mode === 'end') return;
    const ch = CH[bar], drive = mode === 'drive';
    if (drive) {
      const n = ch[DRV_I[step]];
      pluck(t, mf(n), (0.2 + 0.1 * intens) * rr(0.85, 1.1), 1.5);
      if (step === 0) pluck(t, mf(ch[0] - 12), 0.24, 2.2);
      if (step === 4) pluck(t + 0.004, mf(ch[1] - 12), 0.16, 1.8);
      if (step === 6 && bar % 2 === 1) pluck(t, mf(n + 12), 0.11, 1.1);
      // sustained shawm melody line at high intensity: long notes over the arpeggio
      if (intens > 0.72 && step === 0) {
        mel = (mel + 1) % 4;
        brass(musicG, t, mf(ch[[2, 3, 2, 1][mel]] - 12), sd * 6, 0.055 * intens);
      }
      drum(drumB, t, step === 0 ? 0.5 : step === 3 ? 0.32 : step === 6 ? 0.38 : 0, true);
      if (step === 2 || step === 5 || step === 7) drum(drumB, t, 0.17, false);
      if (bar === 3 && step === 7) { drum(drumB, t + sd * 0.5, 0.22, false); drum(drumB, t + sd * 0.75, 0.3, false); }
    } else {
      const k = CALM_S.indexOf(step);
      if (k >= 0) pluck(t, mf(ch[CALM_I[k]]), 0.25 * rr(0.85, 1.1), 2.4);
      if (step === 0) { pluck(t, mf(ch[0] - 12), 0.26, 2.8); drum(drumB, t, 0.3, true); }
      if (step === 4) drum(drumB, t, 0.15, false);
      if (AMB && rnd() < 0.035) SFX[AMB](sfxG, t + rnd() * 0.4);
    }
  }
  // Metal melee is emitted here rather than from the sim: the rate is derived from how many
  // enemies are actually locked with a knight, capped hard so a big scrum is a texture and
  // not a machine gun.
  let clashAcc = 0;
  function melee(dt) {
    let eng = 0;
    const E = G.enemies;
    for (let i = 0; i < E.length; i++) if (E[i].alive && E[i].blockedBy >= 0) eng++;
    if (!eng) { clashAcc = 0; return; }
    const rate = Math.min(7, 0.9 * Math.sqrt(eng) * 1.6);
    clashAcc += rate * dt;
    let n = 0;
    while (clashAcc >= 1 && n++ < 3) {
      clashAcc -= 1;
      const kn = G.knights[(rnd() * G.knights.length) | 0];
      play('clash', kn ? kn.x : undefined, kn ? kn.z : undefined, 0.55 + 0.3 * rnd());
    }
    if (clashAcc > 3) clashAcc = 3;
  }

  let lastSched = 0;
  function sched() {
    if (!ok || ac.state !== 'running') return;
    const now = ac.currentTime, dt = clamp(now - lastSched, 0, 0.5); lastSched = now;
    const ph = G.state.phase;
    if (mode !== 'end') {
      const want = ph === 'wave' ? 'drive' : 'calm';
      if (want !== mode) { mode = want; step = 0; stepT = 0; }
      let ti = 0.42;
      if (ph === 'wave') {
        let a = 0; const E = G.enemies;
        for (let i = 0; i < E.length; i++) if (E[i].alive) a++;
        ti = 0.6 + 0.4 * Math.min(1, a / 70);
      }
      intens += (ti - intens) * Math.min(1, dt * 0.5);
    }
    if (droneG) {
      droneLP.frequency.setTargetAtTime(300 + 950 * intens, now, 0.6);
      droneG.gain.setTargetAtTime(mode === 'end' ? 0.03 : 0.105 + 0.075 * intens, now, 0.8);
      windG.gain.setTargetAtTime(WIND.b + WIND.s * intens, now, 1.2);
    }
    fireBed(now);
    beds(now);
    melee(dt);
    presence(dt);
    if (!live) return;
    const sd = 60 / (mode === 'drive' ? 96 : 74) / 2, ahead = now + 0.28;
    if (stepT < now) stepT = now + 0.05;
    while (stepT < ahead) {
      emit(stepT, sd);
      stepT += sd;
      if (++step >= 8) { step = 0; bar = (bar + 1) % 4; }
    }
  }

  // ══ public api ════════════════════════════════════════════════════════════════
  function play(name, x, z, vol) {
    if (SHOT || !ok || _muted || ac.state !== 'running') return;
    const f = SFX[name];
    if (!f) return;
    const t = ac.currentTime, mg = MINGAP[name];
    if (mg && gap[name] !== undefined && t - gap[name] < mg) return;
    gap[name] = t;
    let dest = sfxG, att = 1;
    if (x !== undefined && G.camera) {
      _av.setFromMatrixColumn(G.camera.matrix, 0);                     // camera right, world space
      const dx = x - G.CAM.tx, dz = z - G.CAM.tz;
      dest = PANS[clamp(Math.round((_av.x * dx + _av.z * dz) / 34 * 4) + 4, 0, 8)];
      const d2 = dx * dx + dz * dz;
      att = 1 / (1 + d2 / 4200);
      if (att < 0.14) return;                                          // far off-screen: silent
    }
    if (vol !== undefined) att *= vol;
    prio = !!PRIO[name];                                               // scheduling is synchronous
    if (att >= 0.999) f(dest, t);
    else { const g = ac.createGain(); g.gain.value = att; g.connect(dest); f(g, t); }
    prio = false;
  }
  // The war horn, then whatever the wave is actually MADE OF (SPEC2 §D/§E). SIM hands the
  // group list straight from the wave table, so this needs no per-map knowledge: a pack
  // wave answers with hounds, a finale with its own low sting. Both are scheduled ahead on
  // the audio clock (WebAudio time, not a timer — GAME_SPEC §2.3b).
  function waveCue(groups) {
    if (SHOT || !ok || _muted || ac.state !== 'running') { play('horn'); return; }
    play('horn');
    let hounds = 0, total = 0, boss = false;
    for (const g of (groups || [])) {
      const ty = g[0], n = g[1] || 0;
      total += n;
      if (ty === 'hound') hounds += n;
      if (ty === 'boss' || (ENEMY_DEFS[ty] && ENEMY_DEFS[ty].art === 'boss')) boss = true;
    }
    const t = ac.currentTime, mg = MINGAP;
    if (boss) {
      if (gap.bosshorn !== undefined && t - gap.bosshorn < mg.bosshorn) return;
      gap.bosshorn = t; prio = true; SFX.bosshorn(sfxG, t + 1.85); prio = false;
    } else if (hounds >= 10 || (total > 0 && hounds / total > 0.35)) {
      if (gap.howl !== undefined && t - gap.howl < mg.howl) return;
      gap.howl = t; prio = true; SFX.howl(sfxG, t + 1.55); prio = false;
    }
  }
  function music() {
    if (SHOT || !init()) return;
    if (!droneG) startDrone();
    mode = G.state.phase === 'wave' ? 'drive' : 'calm';
    stepT = 0; step = 0; bar = 0; live = true;
    if (!timer) { lastSched = ac.currentTime; timer = setInterval(sched, 50); }
  }
  return {
    init, music, play, waveCue,
    get muted() { return _muted; },
    set muted(v) {
      _muted = !!v;
      if (master) { const t = ac.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t); master.gain.linearRampToValueAtTime(_muted ? 0 : 0.85, t + 0.12); }
    },
    get ready() { return ok; },
    get ctx() { return ac; },
    get voices() { return voices; },
    get tap() { return master; },     // debug: connect an AnalyserNode here to meter the mix
  };
})();
G.Audio = Audio;
if (!SHOT) {
  // The context may only be constructed inside a user gesture (autoplay policy). Music
  // itself starts from the Play button (UI's btnPlay -> Audio.music()).
  const unlock = () => Audio.init();
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
  // one delegated tick for every button in the HUD, so UI's handlers stay audio-free
  document.addEventListener('pointerdown', e => {
    const el = e.target;
    if (el && el.closest && el.closest('button')) Audio.play('ui');
  }, true);
  document.addEventListener('visibilitychange', () => {
    const c = Audio.ctx;
    if (!c) return;
    if (document.hidden) c.suspend(); else c.resume();
  });
}
// ══════════════════════ END SECTION: AUDIO ══════════════════════

// ══════════════════════ SECTION: UI (owner: UI builder) ══════════════════════
// Medieval-AAA interface. Everything is procedural: SVG filigree lives in SECTION: UI-CSS
// and UI-HTML; the parchment/iron grain and every tower portrait / enemy bust below are
// drawn with 2d canvas at init. No external assets, nothing fetched.
//
// SHOT-MODE CONTRACT (see GAME_SPEC §2.3):
//  · no setTimeout/setInterval ever runs when SHOT is set;
//  · CSS base state == shipped look, so the harness's `animation:none` freeze is a no-op;
//  · UI.frame() (damage floaters, count-up, Ken-Burns) is called from MAIN's render() and
//    self-disables after the 2nd shot render, so the FINAL shot frame mutates no DOM.
const $ = id => document.getElementById(id);
const UI = {};
G.UI = UI;

// ── deterministic cosmetic noise (never touches the sim rng stream) ────────────
let _us = 0x1a2b3c4d;
const urng = () => { _us ^= _us << 13; _us ^= _us >>> 17; _us ^= _us << 5; return ((_us >>> 0) % 100000) / 100000; };
const ur = (a, b) => a + (b - a) * urng();
function pcv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// ── grain tiles pushed into CSS custom properties ──────────────────────────────
{
  const c = pcv(180, 180), g = c.getContext('2d');           // hammered dark iron
  for (let i = 0; i < 5200; i++) {
    const v = urng();
    g.fillStyle = v > 0.55 ? 'rgba(255,235,200,' + (0.012 + urng() * 0.05) + ')' : 'rgba(0,0,0,' + (0.02 + urng() * 0.10) + ')';
    g.fillRect(urng() * 180 | 0, urng() * 180 | 0, 1, 1);
  }
  for (let i = 0; i < 90; i++) {                              // faint hammer dishing
    g.globalAlpha = 0.05 + urng() * 0.07;
    const r = 5 + urng() * 16, x = urng() * 180, y = urng() * 180;
    const rg = g.createRadialGradient(x - r * .3, y - r * .3, 0, x, y, r);
    rg.addColorStop(0, '#fff0d8'); rg.addColorStop(0.6, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,.5)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  g.globalAlpha = 1;
  document.documentElement.style.setProperty('--noise', 'url("' + c.toDataURL('image/png') + '")');
}
{
  const c = pcv(200, 200), g = c.getContext('2d');           // parchment fibre + foxing
  for (let i = 0; i < 1500; i++) {
    g.strokeStyle = 'rgba(' + (urng() > 0.72 ? '255,248,224,' : '112,84,42,') + (0.03 + urng() * 0.10) + ')';
    g.lineWidth = ur(0.5, 1.4);
    const x = urng() * 200, y = urng() * 200, a = urng() * 6.283, l = ur(4, 28);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 70; i++) {                     // foxing blooms
    g.fillStyle = 'rgba(118,86,42,' + (0.04 + urng() * 0.11) + ')';
    g.beginPath(); g.ellipse(urng() * 200, urng() * 200, ur(3, 19), ur(2, 13), urng() * 3, 0, 7); g.fill();
  }
  for (let i = 0; i < 220; i++) {                    // fine speck
    g.fillStyle = 'rgba(88,62,28,' + (0.05 + urng() * 0.16) + ')';
    g.fillRect(urng() * 200, urng() * 200, 1, 1);
  }
  document.documentElement.style.setProperty('--grain', 'url("' + c.toDataURL('image/png') + '")');
}

// ══ canvas-drawn tower portraits ═══════════════════════════════════════════════
// Authored in a hand-friendly space: x −50..50, y = 0 at the ground line and +y up.
// Every asset is silhouette-first with a warm upper-left key and a cool sky bounce,
// mirroring the scene's golden-hour lighting so the icons read as the real towers.
const PAL = {
  wood: ['#8a6338', '#6d4c29', '#4a331b', '#a87b46'],       // lit / mid / shadow / highlight
  slate: ['#5b6874', '#414c57', '#2c343c', '#8b98a5'],
  stone: ['#6f6656', '#524a3d', '#332e26', '#837868'],
  cloth: ['#3a72b8', '#2b5794', '#183a6b', '#5f96d8'],
  linen: ['#ded0b0', '#c2b18c', '#8f8063', '#f2e8ce'],
  iron:  ['#4c4a46', '#35332f', '#1e1d1b', '#7d7a74'],
  gold:  ['#e8b64c', '#b3831f', '#6d4a10', '#fff0c6'],
  blood: ['#8f2d20', '#651a11', '#3b0d08', '#c2543f'],
};
function poly(g, pts, fill, stroke, lw) {
  g.beginPath(); g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
}
function beam(g, x0, y0, x1, y1, w, p) {              // a timber/stone member with lit edge
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L * w / 2, ny = dx / L * w / 2;
  poly(g, [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], p[1], p[2], 0.9);
  g.strokeStyle = p[3]; g.globalAlpha = 0.55; g.lineWidth = Math.max(0.7, w * 0.22);
  g.beginPath(); g.moveTo(x0 + nx * 0.72, y0 + ny * 0.72); g.lineTo(x1 + nx * 0.72, y1 + ny * 0.72); g.stroke();
  g.globalAlpha = 1;
}
function pennant(g, x, y, h, len, up) {               // blue swallow-tail on a staff
  beam(g, x, y, x, y + h, 1.5, PAL.wood);
  g.fillStyle = PAL.gold[0]; g.beginPath(); g.arc(x, y + h + 1.6, 1.9, 0, 7); g.fill();
  const t = y + h - 1.5;
  const gr = g.createLinearGradient(x, 0, x + len, 0);
  gr.addColorStop(0, PAL.cloth[1]); gr.addColorStop(0.45, PAL.cloth[3]); gr.addColorStop(1, PAL.cloth[1]);
  poly(g, [x, t, x + len, t - up, x + len * 0.66, t - up * 0.45 - 3.2, x + len, t - up - 7, x, t - 7.4], gr, PAL.cloth[1], 0.8);
  g.strokeStyle = PAL.gold[0]; g.globalAlpha = 0.8; g.lineWidth = 0.9;
  g.beginPath(); g.moveTo(x, t - 0.6); g.lineTo(x + len * 0.95, t - up * 0.9); g.stroke(); g.globalAlpha = 1;
}
function banner(g, x, y, w, h) {                      // long hanging heraldic banner
  const gr = g.createLinearGradient(x, 0, x + w, 0);
  gr.addColorStop(0, PAL.cloth[1]); gr.addColorStop(0.34, PAL.cloth[3]); gr.addColorStop(0.72, PAL.cloth[0]); gr.addColorStop(1, PAL.cloth[1]);
  poly(g, [x, y, x + w, y, x + w, y - h + 3, x + w / 2, y - h, x, y - h + 3], gr, PAL.cloth[1], 0.8);
  g.fillStyle = PAL.gold[0]; g.globalAlpha = 0.85;
  g.fillRect(x, y - 1.6, w, 1.6);
  poly(g, [x + w / 2, y - h * 0.42, x + w * 0.82, y - h * 0.62, x + w / 2, y - h * 0.8, x + w * 0.18, y - h * 0.62], PAL.gold[0]);
  g.globalAlpha = 1;
}
function slateRoof(g, cx, y, halfW, h, eave) {
  const gr = g.createLinearGradient(cx - halfW, y, cx + halfW, y + h);
  gr.addColorStop(0, PAL.slate[3]); gr.addColorStop(0.34, PAL.slate[0]); gr.addColorStop(1, PAL.slate[2]);
  poly(g, [cx - halfW - eave, y, cx, y + h, cx + halfW + eave, y], gr, PAL.slate[2], 1);
  g.strokeStyle = 'rgba(0,0,0,.26)'; g.lineWidth = 0.7;                      // shingle courses
  for (let i = 1; i < 5; i++) {
    const f = i / 5, w2 = (halfW + eave) * (1 - f);
    g.beginPath(); g.moveTo(cx - w2, y + h * f); g.lineTo(cx + w2, y + h * f); g.stroke();
  }
  g.strokeStyle = PAL.slate[3]; g.globalAlpha = 0.5; g.lineWidth = 1.1;
  g.beginPath(); g.moveTo(cx - halfW - eave, y + 0.6); g.lineTo(cx, y + h); g.stroke(); g.globalAlpha = 1;
}
// Silhouette mode (the phone's icon tier): the crews are 3-4px of noise at 40px tall and
// they are the first thing that turns a miniature into mush, so they are simply not drawn.
let _silh = false;
function crew(g, x, y, s, col, spear) {               // small defender: shoulders, helm, optional spear
  if (_silh) return;
  if (spear) { g.strokeStyle = PAL.wood[2]; g.lineWidth = 0.8 * s; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x + 2.2 * s, y); g.lineTo(x + 3 * s, y + 11 * s); g.stroke();
    g.fillStyle = PAL.iron[3]; poly(g, [x + 3 * s, y + 11 * s, x + 2.2 * s, y + 13.6 * s, x + 3.9 * s, y + 11.7 * s], PAL.iron[3]); }
  g.strokeStyle = '#3b2b18'; g.lineWidth = 1.1 * s; g.lineCap = 'round';         // legs
  g.beginPath(); g.moveTo(x - 0.7 * s, y + 2.4 * s); g.lineTo(x - 1 * s, y + 0.2 * s); g.stroke();
  g.beginPath(); g.moveTo(x + 0.7 * s, y + 2.4 * s); g.lineTo(x + 1.1 * s, y + 0.2 * s); g.stroke();
  poly(g, [x - 1.15 * s, y + 2.2 * s, x + 1.15 * s, y + 2.2 * s, x + 1.65 * s, y + 5.9 * s,
           x - 1.65 * s, y + 5.9 * s], col || PAL.cloth[1]);                     // torso, shoulders flared
  g.fillStyle = 'rgba(0,0,0,.34)';
  poly(g, [x - 1.15 * s, y + 2.2 * s, x - 0.25 * s, y + 2.2 * s, x - 0.55 * s, y + 5.9 * s, x - 1.65 * s, y + 5.9 * s], 'rgba(0,0,0,.34)');
  g.fillStyle = PAL.iron[3]; g.beginPath(); g.arc(x, y + 7.1 * s, 1.5 * s, 0, 7); g.fill();  // helm
  g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(x - 0.45 * s, y + 7.5 * s, 0.6 * s, 0, 7); g.fill();
}
const TOWER_ART = {
  archer(g, lv) {
    const H = lv >= 3 ? 46 : lv >= 2 ? 41 : 36;
    for (const sx of [-1, 1]) {                                        // splayed legs
      beam(g, sx * 15, 0, sx * 8.5, H, 4.4, PAL.wood);
      beam(g, sx * 9, 0, sx * 5, H, 3.2, PAL.wood);
    }
    for (let i = 0; i < (lv >= 2 ? 3 : 2); i++) {                       // cross bracing
      const y0 = 5 + i * (H - 10) / (lv >= 2 ? 3 : 2), y1 = y0 + (H - 10) / (lv >= 2 ? 3 : 2);
      const w0 = 15 - (15 - 8.5) * y0 / H, w1 = 15 - (15 - 8.5) * y1 / H;
      beam(g, -w0, y0, w1, y1, 2.1, PAL.wood); beam(g, w0, y0, -w1, y1, 2.1, PAL.wood);
      beam(g, -w0, y0, w0, y0, 2.4, PAL.wood);
    }
    // the deck is deliberately a full third of the silhouette: at icon size the railing +
    // crew band is what says "archer post" rather than "generic tower".
    beam(g, -14, H - 1, 14, H + 2.6, 4.6, PAL.wood);                    // joists
    poly(g, [-14, H + 2.6, 14, H + 2.6, 14, H + 4.8, -14, H + 4.8], PAL.wood[3], PAL.wood[2], 0.8);
    for (let i = -3; i <= 3; i++) beam(g, i * 4.3, H + 4, i * 4.3, H + 12, 1.6, PAL.wood);
    beam(g, -13.4, H + 7.6, 13.4, H + 7.6, 1.5, PAL.wood);              // mid rail
    // crew drawn between the rails so their heads and shoulders clear the top rail
    crew(g, -5.8, H + 4.6, 1.4, PAL.cloth[1], true);
    crew(g, 5.2, H + 4.6, 1.3, PAL.blood[0], false);
    beam(g, -13.4, H + 11.6, 13.4, H + 11.6, 2.1, PAL.wood);            // top rail
    slateRoof(g, 0, H + 13.4, 13, lv >= 3 ? 15 : 13, 3.4);
    pennant(g, 0, H + (lv >= 3 ? 29 : 27), lv >= 3 ? 12 : 9, 14, 3.8);
    if (lv >= 2) { beam(g, 17, 0, 13, H - 4, 1.4, PAL.wood);            // ladder
      for (let i = 0; i < 7; i++) { const f = i / 7; beam(g, 17 - 4 * f, f * (H - 4), 13.4 - 3 * f, f * (H - 4) + 1, 1.1, PAL.wood); } }
    if (lv >= 3) { g.globalAlpha = .9;
      poly(g, [-14.6, H + 12.6, 14.6, H + 12.6, 14.6, H + 13.9, -14.6, H + 13.9], PAL.gold[1]); g.globalAlpha = 1; }
  },
  ballista(g, lv) {
    const H = lv >= 3 ? 26 : lv >= 2 ? 22 : 18;
    for (let i = 0; i < (lv >= 3 ? 5 : 4); i++) {                        // ashlar plinth
      const f = i / (lv >= 3 ? 5 : 4), w = 20 - f * 4.5, y = f * H, hh = H / (lv >= 3 ? 5 : 4);
      poly(g, [-w, y, w, y, w - 0.9, y + hh, -w + 0.9, y + hh], PAL.stone[i % 2 ? 0 : 1], PAL.stone[2], 0.9);
      g.strokeStyle = 'rgba(255,240,214,.09)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(-w + 1, y + 0.6); g.lineTo(w - 1, y + 0.6); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.30)';
      g.beginPath(); g.moveTo(-w + 1, y + hh - 0.5); g.lineTo(w - 1, y + hh - 0.5); g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,.30)';                                     // shadow side of the plinth
    poly(g, [-20, 0, -11, 0, -9.5, H, -20, H], 'rgba(0,0,0,.30)');
    poly(g, [-22, H, 22, H, 20, H + 3.4, -20, H + 3.4], PAL.stone[3], PAL.stone[2], 1);   // cornice
    banner(g, -18.5, H - 0.5, 10.5, H - 2);                              // long banner off the cornice
    beam(g, -11, H + 4, 11, H + 4, 3.6, PAL.wood);                        // turntable / carriage
    beam(g, -7, H + 5, 16, H + 15, 3.6, PAL.wood);                        // stock, elevated
    beam(g, -8.5, H + 4.5, -2, H + 11, 2.6, PAL.wood);                    // elevation prop
    const bx = 8, by = H + 11.2;                                          // bow arms
    g.lineCap = 'round';
    for (const dir of [1, -1]) {
      const ex = bx + (dir > 0 ? 2.5 : -5), ey = by + dir * 17;
      g.strokeStyle = PAL.wood[2]; g.lineWidth = 4;
      g.beginPath(); g.moveTo(bx, by); g.quadraticCurveTo(bx + 6.5 * (dir > 0 ? 1 : 0.4), by + dir * 10, ex, ey); g.stroke();
      g.strokeStyle = PAL.wood[3]; g.lineWidth = 1.4; g.globalAlpha = .5;
      g.beginPath(); g.moveTo(bx, by); g.quadraticCurveTo(bx + 6.5 * (dir > 0 ? 1 : 0.4), by + dir * 10, ex, ey); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = PAL.iron[1]; g.beginPath(); g.arc(ex, ey, 1.5, 0, 7); g.fill();
    }
    g.strokeStyle = '#e2d2a8'; g.lineWidth = 1.2; g.lineCap = 'butt';      // bowstring
    g.beginPath(); g.moveTo(bx + 2.5, by + 17); g.lineTo(bx - 5, by - 17); g.stroke();
    beam(g, -5, H + 7.6, 13, H + 15.6, 2.1, PAL.iron);                     // bolt in the groove
    poly(g, [13, H + 15.6, 18, H + 17.6, 13.4, H + 17.9], PAL.iron[3], PAL.iron[2], 0.6);
    poly(g, [-5, H + 7.6, -8.4, H + 5.4, -6.4, H + 8.9], PAL.wood[3]);     // fletching
    if (lv >= 2) crew(g, -15, H + 4, 1.25, PAL.cloth[1], false);
    if (lv >= 3) { crew(g, 15, H + 4, 1.2, PAL.blood[0], false);
      g.globalAlpha = .8; poly(g, [-22, H + 3.1, 22, H + 3.1, 22, H + 4.2, -22, H + 4.2], PAL.gold[1]); g.globalAlpha = 1; }
  },
  catapult(g, lv) {
    const H = lv >= 3 ? 13 : lv >= 2 ? 10 : 8;
    for (let i = 0; i < 3; i++) {                                        // stone platform
      const f = i / 3, w = 24 - f * 3, y = f * H, hh = H / 3;
      poly(g, [-w, y, w, y, w - 0.7, y + hh, -w + 0.7, y + hh], PAL.stone[i % 2 ? 0 : 1], PAL.stone[2], 0.9);
    }
    poly(g, [-25, H, 25, H, 23, H + 2.6, -23, H + 2.6], PAL.stone[3], PAL.stone[2], 1);
    beam(g, -19, H + 3, 19, H + 3, 4, PAL.wood);                          // sill beams
    beam(g, -19, H + 6.6, 19, H + 6.6, 3, PAL.wood);
    beam(g, -13, H + 4, -3, H + 26, 4, PAL.wood);                         // A-frame
    beam(g, 9, H + 4, -3, H + 26, 4, PAL.wood);
    beam(g, -11, H + 14, 6, H + 14, 2.4, PAL.wood);
    const px = -3, py = H + 26;
    beam(g, px, py, px + 26, py - 15, 4.6, PAL.wood);                     // throwing arm (cocked)
    beam(g, px, py, px - 13, py + 8, 3.4, PAL.wood);
    g.fillStyle = PAL.iron[1]; g.beginPath(); g.arc(px, py, 3.1, 0, 7); g.fill();
    g.fillStyle = PAL.iron[3]; g.beginPath(); g.arc(px - 0.7, py + 0.7, 1.3, 0, 7); g.fill();
    // sling hangs off the arm tip with the shot loaded, plus the winch rope to the bed
    g.strokeStyle = '#c2a878'; g.lineWidth = 1.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(px + 26, py - 15); g.lineTo(px + 23.4, py - 22.5); g.stroke();
    g.beginPath(); g.moveTo(px + 26, py - 15); g.lineTo(px + 29.6, py - 22); g.stroke();
    g.beginPath(); g.moveTo(px - 13, py + 8); g.lineTo(px - 16, H + 7.4); g.stroke();
    poly(g, [px + 22, py - 21.4, px + 30.4, py - 20.6, px + 29, py - 26, px + 22.6, py - 26.4], '#7d6446', '#5a462e', 0.8);
    const bg = g.createRadialGradient(px + 24.6, py - 26.4, 0.6, px + 26, py - 24.8, 6.4);
    bg.addColorStop(0, PAL.stone[3]); bg.addColorStop(0.55, PAL.stone[1]); bg.addColorStop(1, PAL.stone[2]);
    g.fillStyle = bg; g.beginPath(); g.arc(px + 26, py - 24.4, 4.8, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 0.8; g.stroke();
    for (const sx of [-1, 1]) {                                           // wheels
      g.fillStyle = PAL.wood[2]; g.beginPath(); g.arc(sx * 15, H + 4.4, 4.4, 0, 7); g.fill();
      g.strokeStyle = PAL.wood[3]; g.lineWidth = 1.1; g.beginPath(); g.arc(sx * 15, H + 4.4, 3.1, 0, 7); g.stroke();
      g.fillStyle = PAL.iron[1]; g.beginPath(); g.arc(sx * 15, H + 4.4, 1.3, 0, 7); g.fill();
    }
    if (lv >= 2) crew(g, -20, H + 4, 1.25, PAL.cloth[1], false);
    if (lv >= 3) { crew(g, 20, H + 4, 1.2, PAL.blood[0], false);
      for (let i = 0; i < 3; i++) { g.fillStyle = i % 2 ? PAL.stone[1] : PAL.stone[0];
        g.beginPath(); g.arc(-24 + (i % 2) * 3.6, H + 5.4 + i * 3.2, 2.8, 0, 7); g.fill(); } }
  },
  // SPEC2 §C towers. Silhouette first: spire + crystal, brazier + davit, mast + banner.
  storm(g, lv) {
    const H = lv >= 3 ? 40 : lv >= 2 ? 34 : 28;                           // drum height
    const NC = lv >= 3 ? 6 : 5;
    for (let i = 0; i < NC; i++) {                                        // battered ashlar courses
      const f = i / NC, w = 15.5 - f * 5, y = f * H, hh = H / NC;
      poly(g, [-w, y, w, y, w - 0.9, y + hh, -w + 0.9, y + hh], PAL.stone[i % 2 ? 0 : 1], PAL.stone[2], 0.9);
      g.strokeStyle = 'rgba(255,240,214,.09)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(-w + 1, y + 0.6); g.lineTo(w - 1, y + 0.6); g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,.30)'; poly(g, [-15.5, 0, -7, 0, -5.6, H, -15.5, H], 'rgba(0,0,0,.30)');
    for (const yf of [0.24, 0.72]) {                                      // iron hoops
      const w = 15.5 - yf * 5;
      poly(g, [-w - 0.5, yf * H, w + 0.5, yf * H, w + 0.5, yf * H + 1.7, -w - 0.5, yf * H + 1.7],
        lv >= 3 ? PAL.gold[1] : PAL.iron[0], PAL.iron[2], 0.7);
    }
    poly(g, [-6.2, H * 0.30, 6.2, H * 0.30, 6.2, H * 0.62, -6.2, H * 0.62], 'rgba(0,0,0,0)');
    for (const sx of [-1, 1]) {                                           // rune slits
      g.fillStyle = '#8fd8ff'; g.globalAlpha = .75;
      g.fillRect(sx * 6 - 0.8, H * 0.42, 1.6, 7); g.globalAlpha = 1;
    }
    poly(g, [-17, H, 17, H, 15, H + 3.4, -15, H + 3.4], PAL.stone[3], PAL.stone[2], 1);   // cornice
    for (let i = -3; i <= 3; i++)                                         // crown merlons
      poly(g, [i * 4.4 - 1.7, H + 3.4, i * 4.4 + 1.7, H + 3.4, i * 4.4 + 1.7, H + 7, i * 4.4 - 1.7, H + 7],
        PAL.stone[i % 2 ? 1 : 0], PAL.stone[2], 0.8);
    banner(g, -20.5, H + 1, 9.5, H * 0.62);                               // heraldry off the crown
    const cy = H + 20;
    g.lineCap = 'round';                                                  // wrought-iron cage arms
    for (const dir of [-1, 1]) for (const k of (lv >= 2 ? [1, 0.45] : [1])) {
      g.strokeStyle = lv >= 3 ? PAL.gold[1] : PAL.iron[0]; g.lineWidth = 2.4 * (k > 0.5 ? 1 : 0.8);
      g.beginPath(); g.moveTo(dir * 9 * k, H + 4);
      g.quadraticCurveTo(dir * 11 * k, cy - 7, dir * 2.6 * k, cy + 3.4); g.stroke();
    }
    if (lv >= 2) {                                                        // copper armillary
      g.strokeStyle = '#b07f3a'; g.lineWidth = 1.8;
      g.beginPath(); g.ellipse(0, cy - 8, 12.5, 3.6, 0, 0, 7); g.stroke();
      g.strokeStyle = '#e0b070'; g.lineWidth = 0.9; g.globalAlpha = .7;
      g.beginPath(); g.ellipse(0, cy - 8, 12.5, 3.6, 0, 3.2, 6.1); g.stroke(); g.globalAlpha = 1;
      for (const sx of [-1, 1]) { g.fillStyle = '#bfeaff';
        poly(g, [sx * 12.5, cy - 9.6, sx * 13.6, cy - 8, sx * 12.5, cy - 6.2, sx * 11.4, cy - 8], '#bfeaff'); }
    }
    const cg = g.createRadialGradient(0, cy, 0.5, 0, cy, 16);             // charge halo
    cg.addColorStop(0, 'rgba(190,235,255,.75)'); cg.addColorStop(0.35, 'rgba(120,190,255,.28)');
    cg.addColorStop(1, 'rgba(80,150,255,0)');
    g.fillStyle = cg; g.beginPath(); g.arc(0, cy, 16, 0, 7); g.fill();
    const cs = lv >= 3 ? 1.32 : lv >= 2 ? 1.14 : 1;                       // the focusing crystal
    poly(g, [0, cy + 9 * cs, 4.2 * cs, cy + 1.6 * cs, 2.4 * cs, cy - 7 * cs, -2.4 * cs, cy - 7 * cs, -4.2 * cs, cy + 1.6 * cs],
      '#7fc6f2', '#dff4ff', 1);
    poly(g, [0, cy + 9 * cs, 0, cy - 7 * cs, -2.4 * cs, cy - 7 * cs, -4.2 * cs, cy + 1.6 * cs], '#4f9ed6');
    poly(g, [0, cy + 9 * cs, 1.5 * cs, cy + 1.2 * cs, 0, cy - 5 * cs], '#ffffff');
    g.strokeStyle = '#cdefff'; g.lineWidth = 1.6; g.lineCap = 'round';    // the arc it throws
    g.beginPath(); g.moveTo(2, cy + 2); g.lineTo(9, cy - 3); g.lineTo(6.4, cy - 6.6); g.lineTo(14.5, cy - 13); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 0.7; g.stroke();
    if (lv >= 3) { g.globalAlpha = .85;
      poly(g, [-17, H + 3.1, 17, H + 3.1, 17, H + 4.3, -17, H + 4.3], PAL.gold[1]); g.globalAlpha = 1; }
    crew(g, -13.5, 0.5, 1.15, PAL.cloth[1], false);
  },
  pyre(g, lv) {
    const H = lv >= 3 ? 17 : lv >= 2 ? 14 : 11;                           // drum height
    for (let i = 0; i < 4; i++) {                                         // soot-stained drum
      const f = i / 4, w = 18 - f * 3.4, y = f * H, hh = H / 4;
      poly(g, [-w, y, w, y, w - 0.7, y + hh, -w + 0.7, y + hh], i > 2 ? '#3c352c' : PAL.stone[i % 2 ? 0 : 1], PAL.stone[2], 0.9);
    }
    g.fillStyle = 'rgba(0,0,0,.32)'; poly(g, [-18, 0, -9, 0, -8, H, -18, H], 'rgba(0,0,0,.32)');
    poly(g, [-20, H, 20, H, 18, H + 3, -18, H + 3], lv >= 3 ? PAL.gold[1] : PAL.stone[3], PAL.stone[2], 1);
    const by = H + 15;                                                    // brazier height
    for (const dx of [-8, 0, 8]) beam(g, dx * 0.55, H + 3, dx, by - 3, 2.2, PAL.iron);
    const BR = lv >= 3 ? 13 : lv >= 2 ? 11.5 : 10;
    poly(g, [-BR, by, BR, by, BR * 0.62, by - 7, -BR * 0.62, by - 7], PAL.iron[0], PAL.iron[2], 1.1);
    poly(g, [-BR - 1.2, by, BR + 1.2, by, BR + 1.2, by + 1.8, -BR - 1.2, by + 1.8],
      lv >= 3 ? PAL.gold[0] : PAL.iron[3], PAL.iron[2], 0.8);
    for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#ff7a24' : '#5a3020';   // coals
      g.beginPath(); g.arc(-BR * 0.6 + i * BR * 0.3, by + 1.4, 2.2, 0, 7); g.fill(); }
    const fg = g.createRadialGradient(0, by + 5, 1, 0, by + 7, BR * 1.5); // flame
    fg.addColorStop(0, 'rgba(255,248,214,.98)'); fg.addColorStop(0.3, 'rgba(255,176,58,.85)');
    fg.addColorStop(0.68, 'rgba(255,96,16,.42)'); fg.addColorStop(1, 'rgba(255,70,0,0)');
    g.fillStyle = fg; g.beginPath(); g.ellipse(0, by + 8, BR * 0.95, BR * 1.35, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,238,190,.9)';
    poly(g, [-3, by + 2, 3, by + 2, 1.4, by + 12, 0, by + 17, -1.6, by + 11], 'rgba(255,240,200,.92)');
    // the davit: king post, throwing arm, pot on its chain
    beam(g, 4, H + 3, 4, H + 13, 2.6, PAL.wood);
    beam(g, 4, H + 12, 20, H + 20, 2.4, PAL.wood);
    beam(g, 4, H + 12, -2.4, H + 8.6, 2, PAL.wood);
    g.strokeStyle = PAL.iron[3]; g.lineWidth = 0.9;
    g.beginPath(); g.moveTo(20, H + 20); g.lineTo(20.4, H + 15.6); g.stroke();
    g.fillStyle = '#3a2418'; g.beginPath(); g.arc(20.6, H + 13.6, 2.6, 0, 7); g.fill();
    g.fillStyle = '#ffb03a'; g.beginPath(); g.arc(20.6, H + 16.2, 1.5, 0, 7); g.fill();
    for (let i = 0; i < (lv >= 2 ? 4 : 3); i++) {                         // pot rack at the foot
      g.fillStyle = '#3f2a1c'; g.beginPath(); g.arc(-21 + i * 3.4, 2.6, 2.4, 0, 7); g.fill();
      g.fillStyle = '#241811'; g.fillRect(-22 + i * 3.4, 4.6, 2, 1.2);
    }
    if (lv >= 2) for (const sx of [-1, 1]) {                              // cressets
      beam(g, sx * 22, 0, sx * 22, 9, 1.6, PAL.iron);
      g.fillStyle = PAL.iron[1]; g.beginPath(); g.ellipse(sx * 22, 10.2, 3, 1.6, 0, 0, 7); g.fill();
      const cg2 = g.createRadialGradient(sx * 22, 12, 0.4, sx * 22, 12.6, 5.4);
      cg2.addColorStop(0, '#fff3c8'); cg2.addColorStop(0.4, '#ffa832'); cg2.addColorStop(1, 'rgba(255,90,0,0)');
      g.fillStyle = cg2; g.beginPath(); g.ellipse(sx * 22, 12.6, 3.6, 5.4, 0, 0, 7); g.fill();
    }
    crew(g, -12.5, 0.5, 1.2, PAL.cloth[1], false);
    if (lv >= 3) crew(g, 13, 0.5, 1.15, PAL.blood[0], false);
  },
  banner(g, lv) {
    const mh = lv >= 3 ? 52 : lv >= 2 ? 45 : 38;                          // mast height
    for (let i = 0; i < 2; i++) {                                         // stone dais
      const w = 15 - i * 3.5, y = i * 3.4;
      poly(g, [-w, y, w, y, w - 0.8, y + 3.4, -w + 0.8, y + 3.4], PAL.stone[i ? 0 : 1], PAL.stone[2], 0.9);
    }
    g.fillStyle = 'rgba(0,0,0,.28)'; poly(g, [-15, 0, -7, 0, -6.4, 6.8, -15, 6.8], 'rgba(0,0,0,.28)');
    if (lv >= 3) { g.globalAlpha = .85; poly(g, [-11.6, 6.6, 11.6, 6.6, 11.6, 7.6, -11.6, 7.6], PAL.gold[1]); g.globalAlpha = 1; }
    for (const sx of [-1, 1]) {                                          // guy ropes to pegs
      g.strokeStyle = '#a08a5e'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(sx * 1.6, mh * 0.62); g.lineTo(sx * 17, 0.8); g.stroke();
    }
    for (const sx of [-1, 1]) {                                          // flanking pennon staves
      const ph = mh * 0.52;
      beam(g, sx * 11, 6.8, sx * 12.6, 6.8 + ph, 1.7, PAL.wood);
      pennant(g, sx * 12.6, 6.8 + ph - 1, 3.5, sx > 0 ? 11 : -11, 3);
    }
    beam(g, 0, 6.8, 0, mh, 3.1, PAL.wood);                               // the mast
    for (let i = 0; i < 4; i++) {                                        // iron/gilt bands
      const y = 10 + i * (mh - 14) / 4;
      poly(g, [-2.2, y, 2.2, y, 2.2, y + 1.4, -2.2, y + 1.4], lv >= 3 ? PAL.gold[1] : PAL.iron[0], PAL.iron[2], 0.6);
    }
    g.fillStyle = lv >= 3 ? PAL.gold[0] : PAL.iron[3];                   // finial
    poly(g, [0, mh + 6.5, 2, mh + 1.4, -2, mh + 1.4], lv >= 3 ? PAL.gold[0] : PAL.iron[3], PAL.gold[2], 0.7);
    g.beginPath(); g.arc(0, mh + 0.6, 2.1, 0, 7); g.fill();
    beam(g, 0, mh - 2.4, 17, mh - 2.4, 1.5, PAL.iron);                   // yard arm
    banner(g, 0.5, mh - 3, lv >= 3 ? 17 : lv >= 2 ? 15 : 13, mh * 0.62); // the great banner
    crew(g, -5.4, 7, 1.5, PAL.cloth[1], false);                          // horn-blower
    g.strokeStyle = lv >= 3 ? PAL.gold[0] : PAL.gold[1]; g.lineWidth = 1.6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-4.4, 15.4); g.lineTo(-0.6, 19.4); g.stroke();
    g.fillStyle = PAL.gold[0]; poly(g, [-0.6, 19.4, 1.6, 21.6, 2.4, 18.8], PAL.gold[0], PAL.gold[2], 0.6);
    if (lv >= 2) {                                                       // drummer
      crew(g, 7.4, 7, 1.4, PAL.cloth[0], false);
      g.fillStyle = PAL.wood[1]; g.beginPath(); g.ellipse(7.4, 13.6, 3.6, 3.2, 0, 0, 7); g.fill();
      g.strokeStyle = PAL.linen[0]; g.lineWidth = 1.1; g.beginPath(); g.ellipse(7.4, 13.6, 3.6, 3.2, 0, 0, 7); g.stroke();
    }
    if (lv >= 3) crew(g, 13.4, 0.5, 1.15, PAL.blood[0], true);
  },
  barracks(g, lv) {
    const th = lv >= 3 ? 38 : lv >= 2 ? 34 : 30;                          // command tent, drawn first
    const TW2 = 17.5;
    const gr = g.createLinearGradient(-TW2, 0, TW2, 0);
    gr.addColorStop(0, '#8a7b58'); gr.addColorStop(0.30, '#d8c9a2'); gr.addColorStop(0.60, '#bfae86'); gr.addColorStop(1, '#7c6e4f');
    poly(g, [-TW2, 3, TW2, 3, 0, th], gr, '#61553d', 1.2);
    g.strokeStyle = 'rgba(88,76,52,.5)'; g.lineWidth = 0.9;               // seams
    for (const i of [-2, -1, 1, 2]) { g.beginPath(); g.moveTo(i * 6.4, 3); g.lineTo(0, th); g.stroke(); }
    for (let i = 0; i < 4; i++) { g.strokeStyle = 'rgba(96,82,54,.26)'; g.lineWidth = 0.8;   // sag lines
      const y = 6 + i * 6, w = TW2 * (1 - (y - 3) / (th - 3));
      g.beginPath(); g.moveTo(-w, y); g.quadraticCurveTo(0, y - 1.2, w, y); g.stroke(); }
    poly(g, [-4.8, 3, 4.8, 3, 3, 17, -3, 17], '#3f3826', '#2c2618', 0.9);   // open doorway
    poly(g, [-7.4, 3, -4.8, 3, -3, 17, -7.8, 15.4], '#e0d1a8', '#8a7b58', 0.7); // pinned-back flap
    g.strokeStyle = '#a08a5e'; g.lineWidth = 1;                            // guy ropes
    g.beginPath(); g.moveTo(-17, 3.6); g.lineTo(-22.5, 0); g.stroke();
    g.beginPath(); g.moveTo(17, 3.6); g.lineTo(22.5, 0); g.stroke();
    pennant(g, 0, th - 1.5, lv >= 3 ? 9 : 6.5, 12, 3.2);
    if (lv >= 2) banner(g, 21, 26, 9, 22);
    for (let i = -7; i <= 7; i++) {                                       // palisade in front
      if (i >= -1 && i <= 1) continue;                                    // gap for the gate
      const x = i * 3.25, h = 10.5 + ((i * 7 + 49) % 3) * 1.1;
      poly(g, [x - 1.45, 0, x + 1.45, 0, x + 1.45, h, x, h + 2.4, x - 1.45, h], PAL.wood[1], PAL.wood[2], 0.85);
      g.strokeStyle = PAL.wood[3]; g.globalAlpha = .42; g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(x - 0.85, 1); g.lineTo(x - 0.85, h); g.stroke(); g.globalAlpha = 1;
    }
    beam(g, -23.5, 7.4, -6, 7.4, 1.9, PAL.wood); beam(g, 6, 7.4, 23.5, 7.4, 1.9, PAL.wood);
    crew(g, -4.2, 0.5, 1.0, PAL.cloth[1], true); crew(g, 3.9, 0.5, 0.95, PAL.cloth[1], false);
    if (lv >= 2) crew(g, -0.2, 1.2, 1.05, PAL.cloth[0], false);
    if (lv >= 3) {                                                        // brazier
      beam(g, -20, 0, -20, 6.4, 1.6, PAL.iron);
      g.fillStyle = PAL.iron[1]; g.beginPath(); g.ellipse(-20, 7.4, 3.2, 1.7, 0, 0, 7); g.fill();
      const fg = g.createRadialGradient(-20, 9, 0.4, -20, 9.6, 5);
      fg.addColorStop(0, '#fff3c8'); fg.addColorStop(0.4, '#ffb03a'); fg.addColorStop(1, 'rgba(255,90,0,0)');
      g.fillStyle = fg; g.beginPath(); g.ellipse(-20, 9.6, 3.8, 5.6, 0, 0, 7); g.fill();
    }
  },
};
// per-type framing: the ballista/catapult/barracks are low and wide, so they need a bigger
// scale than the tall watchtower to fill the same plate. Every asset is scaled so its TIER-3
// silhouette just fills it.
const POR_SC = { archer: 0.88, ballista: 1.34, catapult: 1.36, barracks: 1.66,
                 storm: 1.02, pyre: 1.26, banner: 1.24 };
// ── icon tier 2: the phone's flat silhouette ───────────────────────────────────
// A 51px downscale of the diorama portrait is brown mush — the catapult, the ballista and
// the pyre became the same smudge. At thumb size a tower has exactly one job: be tellable
// apart by OUTLINE. So the same art is drawn with crews suppressed and then flattened to a
// single warm ink on a dark plate, which is the highest-contrast form the shape can take.
function towerGlyph(type, lv, cw, ch) {
  const c = pcv(cw * 2, ch * 2), g = c.getContext('2d'), W = cw * 2, H = ch * 2;
  g.fillStyle = '#1b1710'; g.fillRect(0, 0, W, H);
  const t = pcv(W, H), tg = t.getContext('2d');
  _silh = true;
  tg.save();
  // framed tighter than the diorama plate: there is no sky and no meadow to leave room for,
  // so the outline is pushed out to the edges where it can actually be read
  tg.translate(W / 2, H * 0.95);
  const S = Math.min(W / 104, H / 70) * (POR_SC[type] || 1);
  tg.scale(S, -S); tg.lineJoin = 'round';
  TOWER_ART[type](tg, lv);
  tg.restore();
  _silh = false;
  tg.globalCompositeOperation = 'source-in';       // recolour everything drawn to one ink
  tg.fillStyle = '#e8d7b0'; tg.fillRect(0, 0, W, H);
  g.drawImage(t, 0, 0);
  return c;
}
// Draws a portrait into a canvas: diorama backdrop, ground pad, contact shadow, asset.
function towerPortrait(type, lv, cw, ch) {
  if (cw < 64) return towerGlyph(type, lv, cw, ch);
  const c = pcv(cw * 2, ch * 2), g = c.getContext('2d'), W = cw * 2, H = ch * 2;
  const sky = g.createLinearGradient(0, 0, 0, H);                       // dusk-blue to hazy horizon
  sky.addColorStop(0, '#23384c'); sky.addColorStop(0.42, '#3d5361'); sky.addColorStop(0.66, '#7d7d5e');
  sky.addColorStop(0.80, '#8e8058'); sky.addColorStop(1, '#37341f');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const warm = g.createRadialGradient(W * 0.22, H * 0.16, 2, W * 0.3, H * 0.3, W * 0.95);
  warm.addColorStop(0, 'rgba(255,222,158,.42)'); warm.addColorStop(0.45, 'rgba(255,206,140,.14)'); warm.addColorStop(1, 'rgba(255,200,130,0)');
  g.fillStyle = warm; g.fillRect(0, 0, W, H);
  const gy = H * 0.885;
  const gr = g.createLinearGradient(0, gy - H * 0.12, 0, H);            // meadow pad
  gr.addColorStop(0, '#7d9a48'); gr.addColorStop(0.42, '#5f7736'); gr.addColorStop(1, '#333f1e');
  g.fillStyle = gr; g.beginPath(); g.ellipse(W / 2, gy + H * 0.07, W * 0.66, H * 0.18, 0, 0, 7); g.fill();
  for (let i = 0; i < 340; i++) {                                       // grass speckle so the pad isn't vector-flat
    const a = urng() * 6.283, r = Math.sqrt(urng());
    const x = W / 2 + Math.cos(a) * r * W * 0.64, y = gy + H * 0.07 + Math.sin(a) * r * H * 0.175;
    g.fillStyle = 'rgba(' + (urng() > 0.45 ? '164,192,102,' : '44,58,24,') + (0.22 + urng() * 0.42) + ')';
    g.fillRect(x, y, 1 + urng() * 3.2, 1 + urng() * 1.8);
  }
  g.fillStyle = 'rgba(20,14,4,.45)';                                    // contact shadow
  g.beginPath(); g.ellipse(W / 2 + W * 0.05, gy + 1, W * 0.33, H * 0.038, 0, 0, 7); g.fill();
  g.save();
  const S = Math.min(W / 118, H / 82) * POR_SC[type];
  g.translate(W / 2, gy); g.scale(S, -S);
  g.lineJoin = 'round';
  TOWER_ART[type](g, lv);
  g.restore();
  const vg = g.createRadialGradient(W / 2, H * 0.5, W * 0.2, W / 2, H * 0.52, W * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return c;   // display size is CSS-driven so the phone breakpoint can shrink it
}
// ══ canvas-drawn enemy busts for the wave preview ══════════════════════════════
function enemyIcon(type, px) {
  // a map finale borrows its archetype's bust as well as its mesh
  type = (ENEMY_DEFS[type] && ENEMY_DEFS[type].art) || type;
  const c = pcv(px * 2, px * 2), g = c.getContext('2d'), S = px * 2;
  g.save(); g.translate(S / 2, S * 0.93); g.scale(S / 34, -S / 34); g.lineJoin = 'round';
  const RED = '#a42a22', DRED = '#6d1a14', ST = '#b9c3cf', DST = '#6e7885', SK = '#c08e64';
  const helm = (x, y, r, horn, crown) => {
    const hg = g.createLinearGradient(x - r, 0, x + r, 0);
    hg.addColorStop(0, DST); hg.addColorStop(0.4, '#e2e9f2'); hg.addColorStop(1, DST);
    g.fillStyle = hg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = '#2a2f36'; g.fillRect(x - r * 0.85, y - r * 0.28, r * 1.7, r * 0.44);
    if (horn) { g.strokeStyle = '#efe3c8'; g.lineWidth = 1.5; g.lineCap = 'round';
      for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(x + sx * r * 0.85, y + r * 0.4);
        g.quadraticCurveTo(x + sx * r * 2.1, y + r * 1.5, x + sx * r * 1.2, y + r * 2.5); g.stroke(); } }
    if (crown) { g.fillStyle = '#e8b64c';
      poly(g, [x - r, y + r * 0.7, x - r * 0.5, y + r * 1.9, x - r * 0.18, y + r * 0.95, x, y + r * 2.2,
               x + r * 0.18, y + r * 0.95, x + r * 0.5, y + r * 1.9, x + r, y + r * 0.7], '#e8b64c'); }
  };
  // Levy and skirmisher used to be the same bust with a 2.4u lean and a shield swapped in
  // and out — two 24px red smudges that differed by spear-vs-sword and nothing else. They
  // are now separated by MASS: the levy is a wide braced block behind a full kite shield,
  // the skirmisher a thin leaning diagonal, mid-stride, with a scarf streaming off it.
  if (type === 'grunt') {
    g.strokeStyle = '#7a5a34'; g.lineWidth = 1.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(6, 26); g.lineTo(9, 2); g.stroke();                   // couched spear
    g.fillStyle = ST; poly(g, [6, 26, 4.4, 32, 7.6, 27.8], ST);
    g.fillStyle = RED;                                                            // broad torso
    poly(g, [-5.0, 8, 5.2, 8, 6.4, 20.6, -6.0, 20.6], RED);
    g.fillStyle = DRED; poly(g, [-5.0, 8, -1.2, 8, -2.0, 20.6, -6.0, 20.6], DRED);
    g.fillStyle = '#4a3520'; g.fillRect(-4.6, 4.8, 9.4, 3.6);                     // belt
    g.strokeStyle = '#4a3520'; g.lineWidth = 2.9; g.lineCap = 'round';            // planted legs
    g.beginPath(); g.moveTo(-2.2, 8); g.lineTo(-3.6, 0.4); g.stroke();
    g.beginPath(); g.moveTo(2.2, 8); g.lineTo(3.8, 0.4); g.stroke();
    helm(0, 23.6, 3.6, false, false);
    const sg = g.createLinearGradient(-11, 0, -2.8, 0); sg.addColorStop(0, DRED); sg.addColorStop(1, '#c2543f');
    poly(g, [-11.0, 21.2, -2.8, 21.2, -2.8, 11.4, -6.9, 6.4, -11.0, 11.4], sg, '#d8c08a', 1);  // full kite shield
    g.fillStyle = '#e8b64c'; g.fillRect(-7.6, 11.4, 1.4, 9.8);
  } else if (type === 'runner') {
    g.fillStyle = '#c2543f';                                                      // scarf, streaming back
    poly(g, [-3.4, 22.6, -13.2, 25.4, -10.6, 20.4, -4.4, 18.8], '#c2543f');
    g.strokeStyle = '#4a3520'; g.lineWidth = 2.3; g.lineCap = 'round';            // long stride
    g.beginPath(); g.moveTo(0.4, 8.6); g.lineTo(-6.4, 1.0); g.stroke();
    g.beginPath(); g.moveTo(2.6, 8.6); g.lineTo(8.6, 2.0); g.stroke();
    g.fillStyle = '#b8443a';                                                      // slim leaning torso
    poly(g, [-1.6, 8.6, 3.6, 8.6, 6.4, 19.6, 0.6, 19.6], '#b8443a');
    g.fillStyle = '#8c2a1f'; poly(g, [-1.6, 8.6, 0.8, 8.6, 3.0, 19.6, 0.6, 19.6], '#8c2a1f');
    helm(4.0, 22.6, 2.9, false, false);
    g.strokeStyle = SK; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(4.4, 17.0); g.lineTo(10.2, 20.4); g.stroke();         // sword arm
    g.beginPath(); g.moveTo(2.2, 16.8); g.lineTo(-3.6, 13.0); g.stroke();         // trailing arm
    g.strokeStyle = ST; g.lineWidth = 1.7;                                        // short sword, raised
    g.beginPath(); g.moveTo(10.2, 20.4); g.lineTo(15.0, 28.6); g.stroke();
    g.fillStyle = ST; poly(g, [15.0, 28.6, 16.6, 31.6, 13.2, 29.2], ST);
  } else if (type === 'shield') {                                                  // SPEC2 §D
    g.strokeStyle = '#4a3520'; g.lineWidth = 2.6; g.lineCap = 'round';             // legs
    g.beginPath(); g.moveTo(-1.4, 8); g.lineTo(-2.8, 0.4); g.stroke();
    g.beginPath(); g.moveTo(3.0, 8); g.lineTo(4.6, 0.4); g.stroke();
    g.fillStyle = RED; poly(g, [-3.4, 8, 5.4, 8, 6.4, 20, -4, 20], RED);           // torso
    helm(1.4, 23.2, 3.3, false, false);
    g.fillStyle = DST; poly(g, [-6.4, 25.2, 9.8, 25.2, 7.6, 26.9, -4.4, 26.9], DST);  // kettle brim
    const pg = g.createLinearGradient(-11.5, 0, -1.5, 0);
    pg.addColorStop(0, '#571310'); pg.addColorStop(0.45, '#8f2318'); pg.addColorStop(1, '#5e130d');
    poly(g, [-11.5, 3.4, -1.6, 3.4, -1.6, 21.4, -3.8, 23.6, -9.3, 23.6, -11.5, 21.4], pg, '#c9ccd2', 0.9);
    g.fillStyle = '#4a5058'; g.fillRect(-11.5, 7.0, 9.9, 2.0); g.fillRect(-11.5, 18.2, 9.9, 2.0);
    g.fillStyle = '#c9ccd2'; g.beginPath(); g.arc(-6.5, 13.4, 2.1, 0, 7); g.fill();
  } else if (type === 'hound') {
    g.fillStyle = '#3a2b1e';
    poly(g, [-9, 8.5, 5.5, 9.5, 9, 13, 8, 17, -6, 16.5, -10, 13], '#3a2b1e');      // barrel body
    g.strokeStyle = '#3a2b1e'; g.lineWidth = 2.2; g.lineCap = 'round';
    for (const [x0, x1] of [[-7, -8.8], [-5.2, -3.6], [5.0, 3.6], [6.6, 8.6]]) { g.beginPath(); g.moveTo(x0, 9.6); g.lineTo(x1, 1.2); g.stroke(); }
    g.lineWidth = 1.6; g.beginPath(); g.moveTo(-9.4, 13.8); g.lineTo(-14.4, 19.6); g.stroke();   // tail
    poly(g, [7, 14.6, 13.4, 17.2, 16.6, 15.4, 15.4, 12.4, 8.6, 11.8], '#463427');  // head + muzzle
    poly(g, [8.4, 18.2, 10.2, 22.6, 12.0, 17.4], '#463427');                       // pricked ear
    g.fillStyle = '#e8b64c'; g.fillRect(12.0, 15.2, 1.6, 1.2);
    poly(g, [15.4, 13.2, 16.6, 11.8, 14.2, 12.4], '#efe3c8');                      // fang
    g.fillStyle = '#8f2318'; g.fillRect(6.4, 11.8, 2.4, 5.2);                      // war collar
    g.fillStyle = DST; for (const cy of [12.6, 15.2]) { g.beginPath(); g.arc(7.6, cy, 0.9, 0, 7); g.fill(); }
  } else if (type === 'marauder') {
    g.strokeStyle = '#6b5233'; g.lineWidth = 1.6; g.lineCap = 'round';             // bow
    g.beginPath(); g.arc(4.0, 14, 9, -1.12, 1.12); g.stroke();
    g.strokeStyle = '#d8ccb6'; g.lineWidth = 0.8;                                  // drawn string
    g.beginPath(); g.moveTo(7.9, 22.1); g.lineTo(0.6, 14); g.lineTo(7.9, 5.9); g.stroke();
    g.strokeStyle = '#4a3520'; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(-2.6, 8); g.lineTo(-4.8, 0.4); g.stroke();
    g.beginPath(); g.moveTo(1.4, 8); g.lineTo(3.2, 0.4); g.stroke();
    poly(g, [-4.6, 8, 3.4, 8, 4.2, 19.4, -5.2, 19.4], '#6d1a14');                  // tabard
    poly(g, [-6.6, 16.8, 4.6, 16.8, 3.6, 25.4, -1.6, 27.6, -6.8, 24.8], '#4c4034'); // hood
    g.fillStyle = SK; g.fillRect(0.2, 20.2, 3.4, 3.6);
    g.strokeStyle = '#4c4034'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(-4.8, 24.4); g.lineTo(-10.2, 27.4); g.stroke();        // flopped peak
    g.strokeStyle = SK; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(1.2, 18); g.lineTo(4.0, 14.4); g.stroke();
    g.beginPath(); g.moveTo(1.2, 17.2); g.lineTo(-1.8, 14.6); g.stroke();
    g.strokeStyle = '#7a5a34'; g.lineWidth = 1.0;                                  // nocked arrow
    g.beginPath(); g.moveTo(0.6, 14); g.lineTo(11.6, 14); g.stroke();
    poly(g, [11.6, 14, 14.2, 14.9, 14.2, 13.1], ST);
  } else if (type === 'ogre') {
    g.strokeStyle = '#5a4126'; g.lineWidth = 2.8; g.lineCap = 'round';             // studded club
    g.beginPath(); g.moveTo(9.4, 4.5); g.lineTo(13.2, 23.5); g.stroke();
    g.fillStyle = '#6b5233'; g.beginPath(); g.arc(13.8, 26.2, 4.4, 0, 7); g.fill();
    g.fillStyle = DST; for (const [cx, cy] of [[11.4, 25.0], [15.9, 26.8], [13.4, 29.4]]) { g.beginPath(); g.arc(cx, cy, 1.2, 0, 7); g.fill(); }
    poly(g, [-8.6, 6, 8.6, 6, 10.6, 20.4, -10.6, 20.4], '#6f7a56');                // hide torso
    poly(g, [-8.6, 6, -1.6, 6, -2.6, 20.4, -10.6, 20.4], '#535d3c');
    poly(g, [-9.6, 12.4, 9.6, 12.4, 8.6, 17.6, -8.6, 17.6], DST);                  // bolted plate
    g.fillStyle = '#e8b64c'; g.beginPath(); g.arc(0, 15, 1.7, 0, 7); g.fill();
    poly(g, [-11.8, 17.2, -4, 22.4, 4, 22.4, 11.8, 17.2, 10.6, 20.4, -10.6, 20.4], DST);
    g.strokeStyle = '#3e2c18'; g.lineWidth = 4.4;
    g.beginPath(); g.moveTo(-4, 6); g.lineTo(-5.8, 0.5); g.stroke();
    g.beginPath(); g.moveTo(4, 6); g.lineTo(5.8, 0.5); g.stroke();
    g.fillStyle = '#6f7a56'; g.beginPath(); g.arc(0, 25.4, 4.7, 0, 7); g.fill();   // bald skull
    g.fillStyle = DST; g.fillRect(-4.6, 25.0, 9.2, 1.8);
    g.fillStyle = '#191c14'; g.fillRect(-3.0, 23.0, 2.0, 1.4); g.fillRect(1.0, 23.0, 2.0, 1.4);
    poly(g, [-2.8, 21.2, -4.2, 25.2, -1.7, 21.5], '#efe3c8');                      // tusks
    poly(g, [2.8, 21.2, 4.2, 25.2, 1.7, 21.5], '#efe3c8');
  } else if (type === 'ironclad') {                                                // SPEC3 §B
    g.strokeStyle = '#2f2a24'; g.lineWidth = 3.2; g.lineCap = 'round';             // planted legs
    g.beginPath(); g.moveTo(-1.6, 8); g.lineTo(-3.2, 0.4); g.stroke();
    g.beginPath(); g.moveTo(3.6, 8); g.lineTo(5.4, 0.4); g.stroke();
    poly(g, [-4.0, 8, 6.4, 8, 7.6, 21.2, -5.0, 21.2], '#4a443c');                  // plate slab
    poly(g, [-4.0, 8, 0.4, 8, -0.6, 21.2, -5.0, 21.2], '#2e2a25');
    poly(g, [-6.2, 18.4, -1.0, 22.6, 5.0, 22.6, 9.4, 18.4, 7.6, 21.2, -5.0, 21.2], DST);  // pauldrons
    for (const sx of [-1, 1]) { poly(g, [1.2 + sx * 5.6, 21.4, 2.2 + sx * 8.4, 27.4, 2.6 + sx * 6.2, 21.8], DST); }  // spikes
    g.fillStyle = '#5b544a'; g.fillRect(-1.6, 24.2, 7.6, 6.4);                     // GREAT HELM: flat top
    g.fillStyle = '#6e675c'; g.fillRect(-2.2, 30.2, 8.8, 1.6);
    g.fillStyle = '#15171a'; g.fillRect(-1.4, 27.6, 7.2, 1.5);                     // vision slit
    g.fillStyle = '#ff8a2a'; g.globalAlpha = .9; g.fillRect(-0.8, 27.9, 2.6, 0.9); g.fillRect(2.4, 27.9, 2.6, 0.9); g.globalAlpha = 1;
    g.fillStyle = '#3f3a33'; g.fillRect(1.4, 24.6, 1.4, 3.0);
    const ig = g.createLinearGradient(-14.5, 0, -2.0, 0);                          // the WALL
    ig.addColorStop(0, '#4d463d'); ig.addColorStop(0.42, '#7c7264'); ig.addColorStop(1, '#39332c');
    poly(g, [-14.5, 1.4, -2.0, 1.4, -2.0, 25.6, -5.0, 28.4, -11.5, 28.4, -14.5, 25.6], ig, '#c9ccd2', 0.9);
    g.fillStyle = '#2b2721'; g.fillRect(-14.5, 6.0, 12.5, 2.2); g.fillRect(-14.5, 21.0, 12.5, 2.2);
    g.fillStyle = '#a9a396'; g.beginPath(); g.arc(-8.2, 14.6, 2.3, 0, 7); g.fill();
  } else if (type === 'ram') {
    g.fillStyle = '#5a4126';                                                       // hide roof
    poly(g, [-15, 22, 0, 30, 15, 22, 15, 24.4, 0, 32.4, -15, 24.4], '#6b5233');
    g.fillStyle = '#3e2c18'; g.fillRect(-14.6, 20.4, 29.2, 1.8);                   // ridge
    g.strokeStyle = '#5a4126'; g.lineWidth = 2.4;                                  // A-frame
    g.beginPath(); g.moveTo(-12.4, 8.4); g.lineTo(-1.4, 21.4); g.stroke();
    g.beginPath(); g.moveTo(12.4, 8.4); g.lineTo(1.4, 21.4); g.stroke();
    g.fillStyle = '#6b5233'; g.fillRect(-14.4, 7.0, 28.8, 2.6);                    // chassis sill
    g.fillStyle = '#7a5a34'; g.fillRect(-11.0, 11.2, 21.0, 4.4);                   // the LOG
    g.fillStyle = '#4a3520'; for (const bx of [-6.0, 0.0, 6.0]) g.fillRect(bx, 11.2, 1.6, 4.4);
    poly(g, [10.0, 10.2, 15.4, 11.4, 16.6, 13.4, 15.4, 15.4, 10.0, 16.6], DST, '#2a2f36', 0.8);  // iron head
    poly(g, [13.6, 15.4, 18.4, 18.0, 15.0, 16.8], DST);                            // horns
    poly(g, [13.6, 11.4, 18.4, 8.8, 15.0, 10.0], DST);
    for (const cx of [-9.6, 8.6]) {                                                // spoked wheels
      g.fillStyle = '#3e2c18'; g.beginPath(); g.arc(cx, 5.0, 5.0, 0, 7); g.fill();
      g.fillStyle = '#7a5a34'; g.beginPath(); g.arc(cx, 5.0, 4.2, 0, 7); g.fill();
      g.strokeStyle = '#3e2c18'; g.lineWidth = 1.1;
      for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI; g.beginPath(); g.moveTo(cx - Math.cos(a) * 4.2, 5.0 - Math.sin(a) * 4.2); g.lineTo(cx + Math.cos(a) * 4.2, 5.0 + Math.sin(a) * 4.2); g.stroke(); }
      g.fillStyle = DST; g.beginPath(); g.arc(cx, 5.0, 1.3, 0, 7); g.fill();
    }
    g.fillStyle = '#8f2318'; poly(g, [-13.4, 9.6, -9.0, 9.6, -9.6, 18.6, -13.8, 18.6], '#8f2318');  // crewman
    g.fillStyle = SK; g.beginPath(); g.arc(-11.4, 20.4, 1.9, 0, 7); g.fill();
  } else if (type === 'ashwraith') {
    g.fillStyle = '#2f2e33';                                                       // hovering shroud
    poly(g, [-6.4, 5.6, 6.4, 5.6, 5.0, 20.0, -5.0, 20.0], '#3b3a3e');
    poly(g, [-6.4, 5.6, -0.6, 5.6, -1.4, 20.0, -5.0, 20.0], '#232227');
    for (const [x0, x1, y1] of [[-6.2, -7.2, 0.6], [-3.2, -3.6, 2.4], [0, 0.6, 0.2], [3.4, 4.2, 2.0], [6.2, 7.4, 1.0]])
      poly(g, [x0 - 1.0, 6.2, x0 + 1.0, 6.2, x1, y1], '#2a292e');                  // ragged hem
    poly(g, [-7.6, 18.4, 7.6, 18.4, 5.4, 27.0, 0, 29.4, -5.4, 27.0], '#3b3a3e');   // hood
    poly(g, [-4.2, 19.6, 4.2, 19.6, 3.0, 25.6, 0, 27.0, -3.0, 25.6], '#0c0b0e');   // the void
    g.fillStyle = '#ff8a2a'; g.globalAlpha = .95;                                  // ember eyes
    g.beginPath(); g.arc(-1.8, 23.6, 1.15, 0, 7); g.fill();
    g.beginPath(); g.arc(1.8, 23.6, 1.15, 0, 7); g.fill();
    g.globalAlpha = .35; g.fillStyle = '#ffd090';
    g.beginPath(); g.arc(-1.8, 23.6, 2.4, 0, 7); g.fill(); g.beginPath(); g.arc(1.8, 23.6, 2.4, 0, 7); g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = '#d8ccb6'; g.lineWidth = 1.4; g.lineCap = 'round';             // bone claws
    g.beginPath(); g.moveTo(5.6, 17.0); g.lineTo(10.4, 12.0); g.stroke();
    g.beginPath(); g.moveTo(-5.6, 17.0); g.lineTo(-10.0, 12.6); g.stroke();
    g.lineWidth = 0.9;
    for (const d of [-1.4, 0, 1.4]) { g.beginPath(); g.moveTo(10.4, 12.0); g.lineTo(13.0 + d * 0.4, 9.4 + d); g.stroke(); }
    poly(g, [6.0, 20.4, 13.6, 23.6, 11.4, 18.0], '#2a292e');                       // trailing tatter
  } else if (type === 'frostrevenant') {
    const FR = '#a8c0d0', DFR = '#5d7385';
    g.strokeStyle = '#4c5f6e'; g.lineWidth = 2.8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-2.0, 8); g.lineTo(-3.6, 0.4); g.stroke();
    g.beginPath(); g.moveTo(2.6, 8); g.lineTo(4.4, 0.4); g.stroke();
    poly(g, [-9.6, 22.0, -3.0, 21.0, -4.6, 5.0, -11.4, 8.6], '#3b3a3e');           // shroud cape
    poly(g, [-4.6, 8, 5.2, 8, 6.4, 21.0, -5.6, 21.0], FR);                         // rimed plate
    poly(g, [-4.6, 8, -0.2, 8, -1.2, 21.0, -5.6, 21.0], DFR);
    g.fillStyle = '#33414d'; g.fillRect(-4.4, 5.0, 9.4, 3.2);
    poly(g, [-7.4, 18.6, -2.0, 22.6, 4.0, 22.6, 9.0, 18.6, 6.4, 21.0, -5.6, 21.0], FR);  // pauldrons
    for (const [x0, y0, x1, y1] of [[-6.6, 21.6, -11.0, 27.8], [-4.2, 22.2, -7.0, 29.2], [7.4, 21.6, 11.6, 27.4]])
      poly(g, [x0 - 1.1, y0 - 1.0, x0 + 1.1, y0 + 1.0, x1, y1], '#dcecf6');        // ice shards
    g.fillStyle = FR; g.beginPath(); g.arc(0.4, 25.4, 3.6, 0, 7); g.fill();        // rimed bascinet
    g.fillStyle = '#e6dcc2'; g.fillRect(-2.6, 22.6, 6.2, 3.0);                     // bone face
    g.fillStyle = '#1a2229'; g.fillRect(-1.8, 24.0, 1.8, 1.4); g.fillRect(1.4, 24.0, 1.8, 1.4);
    g.fillStyle = FR; g.fillRect(0.0, 22.2, 1.0, 3.4);
    g.strokeStyle = '#cfe0ea'; g.lineWidth = 2.0;                                  // greatsword
    g.beginPath(); g.moveTo(8.4, 8.0); g.lineTo(13.6, 27.6); g.stroke();
    poly(g, [13.6, 27.6, 15.8, 31.6, 12.0, 28.2], '#eef6fb');
    g.strokeStyle = '#4c5f6e'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(6.0, 6.2); g.lineTo(10.4, 9.4); g.stroke();
  } else if (type === 'warshaman') {
    const RB = '#6b5a2e', DRB = '#3d3216';
    g.strokeStyle = '#5a4126'; g.lineWidth = 1.8; g.lineCap = 'round';             // totem staff
    g.beginPath(); g.moveTo(7.0, 1.0); g.lineTo(9.4, 26.0); g.stroke();
    g.fillStyle = '#e6dcc2'; g.beginPath(); g.arc(9.6, 28.4, 2.6, 0, 7); g.fill(); // skull finial
    poly(g, [8.0, 29.8, 5.0, 33.4, 8.8, 30.8], '#e6dcc2');                         // horns
    poly(g, [11.2, 29.8, 14.4, 33.4, 10.6, 30.8], '#e6dcc2');
    g.fillStyle = '#3b3a3e'; g.fillRect(8.4, 27.6, 1.0, 1.0); g.fillRect(10.0, 27.6, 1.0, 1.0);
    g.fillStyle = '#ff8a2a'; g.globalAlpha = .95; g.beginPath(); g.arc(9.0, 22.4, 1.7, 0, 7); g.fill();  // caged ember
    g.globalAlpha = .32; g.fillStyle = '#ffd090'; g.beginPath(); g.arc(9.0, 22.4, 3.6, 0, 7); g.fill(); g.globalAlpha = 1;
    poly(g, [-6.8, 0.6, 6.0, 0.6, 4.4, 20.4, -5.4, 20.4], RB);                     // long robe
    poly(g, [-6.8, 0.6, -0.6, 0.6, -1.4, 20.4, -5.4, 20.4], DRB);
    g.fillStyle = '#8b7a44'; g.fillRect(-5.0, 12.0, 9.0, 1.8);
    poly(g, [-7.6, 17.6, 6.6, 17.6, 5.0, 26.6, -0.4, 28.8, -6.2, 26.6], DRB);      // horned hood
    poly(g, [-3.4, 20.6, 3.0, 20.6, 2.2, 26.0, -0.2, 27.2, -2.8, 26.0], '#e6dcc2');// bone mask
    g.fillStyle = '#2b2721'; g.fillRect(-2.0, 23.4, 1.6, 1.3); g.fillRect(0.8, 23.4, 1.6, 1.3);
    g.strokeStyle = '#e6dcc2'; g.lineWidth = 1.3; g.lineCap = 'round';             // antlers
    for (const sx of [-1, 1]) {
      g.beginPath(); g.moveTo(sx * 3.6, 26.0); g.quadraticCurveTo(sx * 8.0, 30.0, sx * 6.4, 34.2); g.stroke();
      g.beginPath(); g.moveTo(sx * 5.8, 29.0); g.lineTo(sx * 9.6, 31.0); g.stroke();
    }
    g.fillStyle = '#ff8a2a'; g.globalAlpha = .9;                                   // glowing hands
    g.beginPath(); g.arc(-6.6, 12.4, 1.9, 0, 7); g.fill(); g.globalAlpha = .3;
    g.fillStyle = '#ffd090'; g.beginPath(); g.arc(-6.6, 12.4, 3.8, 0, 7); g.fill(); g.globalAlpha = 1;
    g.strokeStyle = '#8b7a44'; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(-4.0, 16.4); g.lineTo(-6.6, 12.4); g.stroke();
    for (const [cx, cy] of [[-3.2, 8.6], [-1.0, 7.2], [1.4, 8.2]]) { g.fillStyle = '#e6dcc2'; g.fillRect(cx, cy, 1.0, 3.0); }  // charms
  } else if (type === 'brute') {
    g.strokeStyle = '#5a4126'; g.lineWidth = 2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(8, 3); g.lineTo(11, 27); g.stroke();                   // axe haft
    g.fillStyle = ST; poly(g, [11, 27, 16.5, 30, 17, 22.5, 11.4, 23.6], ST, DST, 0.8);
    g.fillStyle = '#8f2318';                                                       // heavy torso
    poly(g, [-7, 7, 7, 7, 8.6, 21.5, -8.6, 21.5], '#8f2318');
    g.fillStyle = '#5e130d'; poly(g, [-7, 7, -1.6, 7, -2.4, 21.5, -8.6, 21.5], '#5e130d');
    g.fillStyle = DST; poly(g, [-9.4, 18.6, -3.4, 22.4, 3.4, 22.4, 9.4, 18.6, 8.6, 21.5, -8.6, 21.5], DST); // pauldrons
    g.fillStyle = '#3e2c18'; g.fillRect(-6.6, 4, 13.2, 3.6);
    g.strokeStyle = '#3e2c18'; g.lineWidth = 3.6;
    g.beginPath(); g.moveTo(-3.4, 7); g.lineTo(-4.8, 0.5); g.stroke();
    g.beginPath(); g.moveTo(3.4, 7); g.lineTo(4.8, 0.5); g.stroke();
    helm(0, 25.2, 4, true, false);
  } else {
    g.strokeStyle = '#4a3520'; g.lineWidth = 1.6;                                  // back banner
    g.beginPath(); g.moveTo(-6, 10); g.lineTo(-9, 33); g.stroke();
    g.fillStyle = '#8f2d20'; poly(g, [-9, 33, -19, 30.4, -17.6, 22.6, -7.6, 25.4], '#8f2d20', '#e8b64c', 0.8);
    g.fillStyle = '#6f1a12'; poly(g, [-8, 6, 8, 6, 9.6, 22, -9.6, 22], '#6f1a12');
    g.fillStyle = '#4a0f0a'; poly(g, [-8, 6, -1.6, 6, -2.6, 22, -9.6, 22], '#4a0f0a');
    g.fillStyle = '#e8b64c'; poly(g, [0, 9, 4.4, 14, 0, 19, -4.4, 14], '#e8b64c');
    g.fillStyle = DST; poly(g, [-11, 18.4, -3.4, 23.4, 3.4, 23.4, 11, 18.4, 9.6, 22, -9.6, 22], DST);
    g.fillStyle = '#3e2c18'; g.fillRect(-7.4, 2.6, 14.8, 3.8);
    g.strokeStyle = '#332413'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(-3.8, 6); g.lineTo(-5.2, 0.5); g.stroke();
    g.beginPath(); g.moveTo(3.8, 6); g.lineTo(5.2, 0.5); g.stroke();
    helm(0, 27, 4.4, true, true);
    g.fillStyle = '#ff5a2a'; g.globalAlpha = .95; g.fillRect(-3.7, 26.2, 7.4, 1.5); g.globalAlpha = 1;
    g.strokeStyle = '#5a4126'; g.lineWidth = 2.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, 4); g.lineTo(15, 27); g.stroke();
    g.fillStyle = ST; poly(g, [15, 27, 21, 31, 21.4, 22, 15.4, 23.4], ST, DST, 0.8);
  }
  g.restore();
  return c;
}
// ══ wave copy ══════════════════════════════════════════════════════════════════
const E_NAME = { grunt: 'Levy', runner: 'Skirmishers', brute: 'Brutes', boss: 'The Warlord',
  shield: 'The Shieldwall', hound: 'War Hounds', marauder: 'Marauders', ogre: 'The Ogre',
  matriarch: 'The Frost Matriarch', emberlord: 'The Ember Lord', cinderqueen: 'The Cinder Queen',
  // SPEC3 §B
  ironclad: 'The Ironclads', ashwraith: 'Ash Wraiths', frostrevenant: 'Frost Revenants',
  warshaman: 'War Shamans', ram: 'The Siege Ram' };
// headline priority: whatever the player most needs to have an answer ready for. The ram
// outranks even an ogre (nothing can block it), and the shaman outranks the units it heals
// — naming him on the card is half the teaching this roster does.
const E_HEAD = ['matriarch', 'emberlord', 'cinderqueen', 'boss', 'ram', 'ogre', 'ironclad',
  'warshaman', 'brute', 'frostrevenant', 'shield', 'ashwraith', 'marauder', 'hound'];
// Wave copy is per map — a 12- or 14-wave campaign that fell back to the Vale's ten titles
// would print `undefined` on its last waves.
const W_TITLES = {
  // SPEC3 §B: the waves that now carry a mini-boss say so on the card. A title is the only
  // warning a player gets before the countdown runs out, so it names the THREAT, not the mood.
  1: ['Red Rabble', 'The Levy Swells', 'Skirmishers', 'Two Columns',
      'Brutes at the Van', 'Running Tide', 'Drums and Bone Charms', 'The Ironclad Wall',
      'Ram at the Gate', 'The Warlord'],
  2: ['First Snowfall', 'Two Gates Open', 'The Pack', 'Wall of Pavises', 'The Dead Walk',
      'Chanting in the Drifts', 'Timber and Iron', 'Bruteshield', 'The Ironclad Column',
      'Something Huge', 'The Long Howl', 'The Frost Matriarch'],
  3: ['Ash on the Wind', 'The Cinder Levy', 'Raiders', 'Running the Wastes', 'Skirmish Line',
      'Wraiths off the Ash', 'Fork in the Road', 'The Ironclad Line', 'Twin Giants', 'The Ram Rolls',
      'Everything at Once', 'The Ogre March', 'The Great Burning', 'The Ember Twins'],
};
const W_TITLE = W_TITLES[MAP.id] || W_TITLES[1];
const bossy = k => !!(ENEMY_DEFS[k] && (k === 'boss' || ENEMY_DEFS[k].art === 'boss'));
function waveMix(n) {                                   // [type,count] sorted by count desc
  const w = WAVES[n - 1]; if (!w) return [];
  const m = {};
  for (const [t, c] of w) m[t] = (m[t] || 0) + c;
  return Object.entries(m).sort((a, b) => (bossy(a[0]) ? -1 : bossy(b[0]) ? 1 : b[1] - a[1]));
}
function waveHead(n) {
  const mix = waveMix(n);
  if (!mix.length) return '';
  let key = null;
  for (const k of E_HEAD) { key = mix.find(m => m[0] === k); if (key) break; }
  key = key || mix[0];
  return (E_NAME[key[0]] || 'The horde') + ' incoming';
}
const ICO_CACHE = {};
function icoFor(t) {                     // cloneNode does NOT copy a canvas bitmap — blit instead
  const src = ICO_CACHE[t] || (ICO_CACHE[t] = enemyIcon(t, 30));
  const c = pcv(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
// One bust + count, with the armour pip if the type shrugs off physical damage. Both the
// live wave card and the bestiary rig build their rows through here so the two can never
// disagree about what an armoured silhouette looks like.
// SPEC3 §A — at most TWO pips per bust: the school this silhouette shrugs off hardest (▲)
// and the one that opens it up (▼). Four pips on a shieldbearer is a spreadsheet; two is a
// warning. The full resist table still goes into the tooltip for a desktop hover.
const pipFor = (dir, school, title) => {
  const p = document.createElement('i');
  p.className = 'pip ' + dir + ' sc-' + school + ' pg-' + school;
  p.title = title;
  return p;
};
UI.bust = (t, c) => {
  const d = document.createElement('div'); d.className = 'wpE';
  d.appendChild(icoFor(t));
  const res = (ENEMY_DEFS[t] || {}).resist || {};
  const hard = G.SCHOOLS.filter(s => (res[s] || 0) >= 0.2).sort((a, b) => res[b] - res[a]);
  const soft = G.SCHOOLS.filter(s => (res[s] || 0) <= -0.1).sort((a, b) => res[a] - res[b]);
  const nm = E_NAME[t] || 'This foe';
  const pips = [];
  if (hard.length) pips.push(pipFor('up', hard[0], nm + ' resists ' +
    hard.map(s => s + ' ' + Math.round(res[s] * 100) + '%').join(', ')));
  if (soft.length) pips.push(pipFor('dn', soft[0], nm + ' is weak to ' +
    soft.map(s => s + ' +' + Math.round(-res[s] * 100) + '%').join(', ')));
  pips.forEach((p, i) => { p.classList.add('p' + i); d.appendChild(p); });
  if (pips.length) d.title = pips.map(p => p.title).join(' · ');
  const n = document.createElement('span'); n.className = 'wpN';
  n.textContent = bossy(t) && c <= 2 ? '' : '×' + c;
  d.appendChild(n);
  return d;
};
// ══ HUD ════════════════════════════════════════════════════════════════════════
let showGold = state.gold, lastGold = state.gold, lastLives = state.lives, bumpT = -9, hitT = -9;
const fmt = n => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : '' + n;
let msgTimer = 0;
// height of whichever bottom panel is standing — the build bar or the garrison sheet. The
// wave call, the placement writ and the tutorial writ all stack on top of it.
const barH = () => Math.max($('buildMenu').offsetHeight || 0, $('towerMenu').offsetHeight || 0);
UI.msg = (text, sub) => {
  // SIM passes plain sentences; the banner re-cuts them into a heraldic title + kicker so
  // the copy stays owned here and SIM never has to know about presentation.
  let head = text;
  const wm = /^Wave (\d+)/.exec(text);
  if (wm) {
    const n = +wm[1], mix = waveMix(n), tot = mix.reduce((a, x) => a + x[1], 0);
    if (/cleared/i.test(text)) { head = 'Wave ' + n + ' Held'; sub = sub || 'The road falls quiet'; }
    else { head = 'Wave ' + n; sub = sub || W_TITLE[n - 1] + ' · ' + tot + ' on the road'; }
  } else if (/breach/i.test(text)) { head = 'The Gate Is Breached'; sub = sub || 'Hold the vale'; }
  const m = $('msg');
  // `wv` marks the banner as a WAVE announcement, which the phone layout suppresses while the
  // parchment card is up (same sentence twice, over the only battle content in frame). A
  // breach or a hold still gets its banner.
  m.classList.toggle('wv', !!wm && !/cleared/i.test(text));
  m.innerHTML = '<div class="mT">' + head + '</div>' + (sub ? '<div class="mS">' + sub + '</div>' : '') + '<div class="mR rule"></div>';
  m.style.opacity = 1;
  if (SHOT) return; // shot mode: no timers after render — a late DOM mutation forces a recomposite that drops the GL layer in headless capture
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => m.style.opacity = 0, 2400);
};
UI.sync = () => {
  const onTitle = state.phase === 'title', ended = state.phase === 'won' || state.phase === 'lost';
  const chrome = !onTitle && !ended;
  $('hud').classList.toggle('hidden', !chrome);
  // The keyboard legend grew a sixth group (omens) and now wraps to three rows, which is
  // fine in play and wrong in a marketing frame — so it steps aside wherever the build bar
  // already has (MINBAR is exactly the "this frame has to sell the game" flag).
  $('hint').classList.toggle('hidden', !chrome || isTouch || MINBAR);
  if (state.gold > lastGold) { $('chipGold').classList.remove('bump'); void $('chipGold').offsetWidth; $('chipGold').classList.add('bump'); }
  if (state.lives < lastLives) { $('chipLives').classList.remove('hit'); void $('chipLives').offsetWidth; $('chipLives').classList.add('hit'); }
  else if (state.lives > lastLives) $('chipLives').classList.remove('hit');
  lastGold = state.gold; lastLives = state.lives;
  if (SHOT) showGold = state.gold;
  $('gold').textContent = fmt(Math.round(showGold));
  $('lives').textContent = state.lives;
  $('wave').textContent = Math.max(1, state.wave) + '/' + WAVES.length;
  // SPEC3 §C — standards raised of standards allowed. `.full` is the state that MATTERS:
  // the next card you press is going to be refused, and the chip says so before you press it.
  const mFull = G.towersList.length >= state.muster;
  $('muster').textContent = G.towersList.length + '/' + state.muster;
  $('chipMuster').classList.toggle('full', mFull);
  $('chipMuster').title = (mFull ? 'The muster is full — no more standards may take the field. ' : '') +
    (G.musterCost() === undefined ? 'The muster is at its limit.'
      : 'Raise the muster for ' + G.musterCost() + ' gold.');
  // wave preview card
  const nx = state.wave + (state.phase === 'prewave' ? 1 : 0);
  const wp = $('wavePrev'), live = chrome && nx <= WAVES.length && (state.phase === 'prewave' || state.phase === 'wave');
  wp.classList.toggle('hidden', !live);
  if (live) {
    const mix = waveMix(nx), tot = mix.reduce((a, m) => a + m[1], 0);
    const pre = state.phase === 'prewave';
    wp.classList.toggle('pre', pre);   // the phone keeps the subtitle only while it is a countdown
    let h = '<div class="wpT">Wave ' + nx + ' <em>—</em> ' + (pre ? waveHead(nx) : W_TITLE[nx - 1]) + '</div>' +
      '<div class="wpS">' + (pre ? 'Muster in ' + Math.max(0, Math.ceil(state.countdown)) + 's' : tot + ' strong on the road') + '</div>' +
      '<div class="wpRow"></div>';
    if (state.phase === 'wave') {
      const alive = G.enemies.filter(e => e.alive).length;
      h += '<div class="bar"><i style="width:' + clamp(100 - alive / Math.max(1, tot) * 100, 2, 100).toFixed(0) + '%"></i></div>';
    }
    h += omenLine(nx, pre);
    wp.innerHTML = h;
    const row = wp.querySelector('.wpRow');
    for (const [t, c] of mix.slice(0, 6)) row.appendChild(UI.bust(t, c));
    if (mix.length > 6) {
      const more = document.createElement('span'); more.className = 'wpN';
      more.textContent = '+' + (mix.length - 6); row.appendChild(more);
    }
  }
  UI.buildMenu();
  UI.omens();
  // The build bar is persistent (SPEC2 §A) and it paints OVER the bottom of the screen, so
  // the wave call has to stand on top of it — at bottom:26px it was buried and unclickable.
  // It shares the slot with the placement writ, which is why it steps aside while the
  // hammer is in hand: you are siting a tower, not calling the horde.
  const bw = $('btnWave'), callable = state.phase === 'prewave' && !SHOT && !G.place;
  bw.style.display = callable ? 'block' : 'none';
  if (callable) bw.style.bottom = (barH() + 26) + 'px';
  // QA aids for the shot harness (opt-in via query string, inert in normal play).
  // `narrow` matters because headless Chrome floors its window at 500 CSS px and then CROPS
  // the PNG to --window-size, so a 390px phone layout can only be verified by clamping #ui.
  if (SHOT && P.has('narrow')) $('ui').style.width = P.get('narrow') + 'px';
  if (SHOT && P.has('bigport')) { document.querySelectorAll('#buildMenu .card').forEach(c => c.style.width = '340px');
    document.querySelectorAll('#buildMenu canvas.por').forEach(c => c.style.height = '235px'); }
};
// ══ war omens (SPEC3 §D) ═══════════════════════════════════════════════════════
// Three portents on parchment, pinned above the dispatch. Contract (owned by SIM):
// G.omens = { offer:[key,key,key], pick(i), active, forWave, picked, defIdx } and
// G.OMENS[key] = {kind,name,desc}. Built inside UI.sync(), so it is pure static DOM with
// no timers — shot-safe by construction; only the countdown ring is written afterwards,
// and it is written from SIM ticks (UI.syncCountdown), never from a wall clock.
const OM_KEYS = ['8', '9', '0'];                       // the hotkeys, in card order
// What the portent PAYS. A challenge is danger money; two boons move the purse themselves.
const OM_PAY = { chest: '+60 gold now', thin: '−25% coin' };
const omPay = (k) => OM_PAY[k] || (G.OMENS[k].kind === 'challenge' ? '+20% coin' : 'no cost');
// Elemental Ward is the one omen whose text depends on how the run has been played, so it
// is resolved against the live damage ledger rather than printed as a rule.
const omDesc = (k) => k === 'ward'
  ? G.OMENS[k].desc.replace('whichever school has spilt the most blood this campaign',
      'your <b>' + G.topSchool() + '</b> towers')
  : G.OMENS[k].desc;
const esc = (s) => s.replace(/</g, '&lt;').replace(/"/g, '&quot;');
function omCard(k, i, sel) {
  const o = G.OMENS[k], kind = o.kind === 'challenge' ? 'chal' : 'boon', pay = omPay(k);
  return '<button class="omC parch frm ' + kind + (i === sel ? ' on' : '') + '" data-i="' + i +
    '" title="' + (kind === 'chal' ? 'Challenge' : 'Boon') + ' — ' + esc(o.desc) + ' (hotkey ' + OM_KEYS[i] + ')">' +
    '<i class="omSig sig-' + kind + '"></i>' +
    '<span class="omBody"><span class="omN">' + o.name + '</span>' +
    '<span class="omD">' + omDesc(k) + '</span></span>' +
    '<span class="omSide"><kbd class="omK">' + OM_KEYS[i] + '</kbd>' +
    '<span class="omChip' + (pay.charAt(0) === '−' ? ' pay' : '') + '">' + pay + '</span></span>' +
    '<span class="omTk">Taken</span></button>';
}
// The countdown ring. r=12.5 → circumference 78.54; the arc is a dash offset, so the ring
// is a single attribute write on an element that already exists (no relayout, no rebuild).
const RING_C = 78.54;
let _omMax = 1;                                        // longest countdown seen for this offer
UI.omenRing = () => {
  const el = $('omenRow'), r = el.querySelector('.rFg');
  if (!r) return;
  const left = Math.max(0, state.countdown);
  if (left > _omMax) _omMax = left;
  r.style.strokeDasharray = RING_C;
  r.style.strokeDashoffset = (RING_C * (1 - left / Math.max(0.001, _omMax))).toFixed(2);
  const n = el.querySelector('.omRing b');
  if (n) n.textContent = Math.ceil(left);
};
let _omKey = '';
UI.omens = () => {
  const el = $('omenRow'), O = G.omens;
  const chrome = state.phase === 'prewave' || state.phase === 'wave';
  // UI.sync() runs on every coin earned, so this row must be idempotent and cheap: nothing
  // is rebuilt unless the hand on the table actually changed. (The ring is deliberately
  // OUTSIDE the key — it moves every tick and must not rebuild three cards to do it.)
  const key = state.phase + '|' + O.forWave + '|' + O.offer.join(',') + '|' + O.picked + '|' +
    state.omen + '|' + G.OMEN_FX.wardEl;
  if (key === _omKey) { if (state.phase === 'prewave') UI.omenRing(); return; }
  if (_omKey.split('|')[1] !== String(O.forWave)) _omMax = Math.max(1, state.countdown);
  _omKey = key;
  if (!chrome) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  if (state.phase === 'wave') {
    // The omen taken is now the omen RIDING the wave: a banner, not a card — there is
    // nothing left to choose, so it loses the hotkey, the ring and the hover.
    const o = G.OMENS[state.omen];
    el.classList.toggle('hidden', !o);
    if (!o) { el.innerHTML = ''; return; }
    const kind = o.kind === 'challenge' ? 'chal' : 'boon';
    el.innerHTML = '<div class="omBan frm ' + kind + '"><i class="omSig sig-' + kind + '"></i>' +
      '<span class="omBody"><span class="omN">' + o.name + '</span>' +
      '<span class="omD">' + (state.omen === 'ward' && G.OMEN_FX.wardEl
        ? o.desc.replace('whichever school has spilt the most blood this campaign',
            'your <b>' + G.OMEN_FX.wardEl + '</b> towers')
        : omDesc(state.omen)) + '</span></span>' +
      '<span class="omSide"><span class="omK">Omen</span>' +
      '<span class="omChip">' + omPay(state.omen) + '</span></span></div>';
    return;
  }
  const live = O.offer.length > 0;
  el.classList.toggle('hidden', !live);
  if (!live) { el.innerHTML = ''; return; }
  const sel = O.picked;
  el.innerHTML = '<div class="omHead"><span class="omT">War Omens</span>' +
    '<span class="omSub">Wave ' + O.forWave + ' · ' + (sel < 0 ? 'take one before the muster ends' : 'omen taken') +
    '</span><span class="omRing" title="Time left to choose"><svg viewBox="0 0 30 30">' +
    '<circle class="rBg" cx="15" cy="15" r="12.5"/><circle class="rFg" cx="15" cy="15" r="12.5"/></svg><b></b>' +
    '</span></div>' + O.offer.map((k, i) => omCard(k, i, sel)).join('');
  el.querySelectorAll('.omC').forEach(b => { b.onclick = () => G.omens.pick(+b.dataset.i); });
  UI.omenRing();
};
// SPEC3 §D read-out: the dispatch always says what the NEXT muster will put on the table,
// so the omen system announces itself a wave early instead of appearing out of nowhere.
function omenLine(nx, pre) {
  const O = G.omens, F = G.OMEN_FROM;
  let txt = '';
  if (pre) {
    if (O.offer.length && O.forWave === nx) {
      if (O.picked >= 0) {
        const o = G.OMENS[O.offer[O.picked]];
        txt = 'Omen taken · <b' + (o.kind === 'boon' ? ' class="boon"' : '') + '>' + o.name + '</b>';
      } else txt = 'Three omens on the table · <b>choose one</b>';
    } else if (nx < F) txt = 'War omens from wave <b>' + F + '</b>';
  } else if (nx + 1 <= WAVES.length) {
    txt = nx + 1 >= F ? 'Wave ' + (nx + 1) + ' · <b>omens at the muster</b>'
                      : 'War omens from wave <b>' + F + '</b>';
  }
  return txt ? '<div class="wpOm"><i class="dg-omen"></i><span>' + txt + '</span></div>' : '';
}
UI.syncCountdown = () => {
  if (state.phase !== 'prewave') return;
  if (state.tick % 15 === 0) {
    $('btnWave').innerHTML = '⚔ Call Wave ' + (state.wave + 1) + ' &nbsp;<span style="opacity:.7">' + Math.ceil(state.countdown) + 's</span>';
    const s = $('wavePrev').querySelector('.wpS');
    if (s) s.textContent = 'Muster · ' + Math.max(0, Math.ceil(state.countdown)) + 's';
    UI.omenRing();
  }
};
// ══ build menu (cards built once, then only state-updated) ═════════════════════
const TK = Object.keys(TOWER_DEFS);
// SPEC3 §A: the badge names the SCHOOL and NOTHING ELSE. It used to be keyed by tower
// first, "so a weapon could look like itself" — but with resists on the board the school is
// the number the player compares across cards, and a card that says CRUSH under a pair of
// crossed swords (the barracks) taught the wrong wheel. One sigil per school, everywhere:
// build card, resist pip, wave dispatch.
const DTYPE = { pierce: ['pierce', 'Pierce', 'Pierce — shields and plate turn it aside'],
                crush:  ['crush', 'Crush', 'Crush — goes through a shield wall, poor against plate'],
                fire:   ['flame', 'Fire', 'Fire — cooks armour, smothered by the fireproof'],
                storm:  ['bolt', 'Storm', 'Storm — leaps a crowd, grounded by the earthed'],
                support:['bnr', 'Support', 'Support — strengthens your own line'] };
const dGlyph = k => (DTYPE[TOWER_DEFS[k].element] || DTYPE.pierce)[0];
const dLabel = k => (DTYPE[TOWER_DEFS[k].element] || DTYPE.pierce);
const T_HINT = { archer: 'Quick volleys · cheap to raise',
  ballista: 'Heavy bolt, punches through two',
  catapult: 'Lobbed splash · blind up close',
  barracks: 'Three knights hold the road',
  storm: 'Arc leaps between four foes',
  pyre: 'Sets the ground itself alight',
  banner: 'Quickens every tower in its aura' };
const statRows = (k) => {
  const d = TOWER_DEFS[k];
  const rows = d.knights ? [['Guards', d.knights], ['Hp', 90], ['Rng', d.range]]
    : d.aura ? [['Rate', '+' + Math.round(d.aura[0] * 100) + '%'], ['Aura', d.range], ['Heals', 'yes']]
    : d.patch ? [['Burn', d.patch.dps + '/s'], ['Area', d.patch.rad], ['Rng', d.range]]
    : [['Dmg', d.dmg], ['Rate', (1 / d.cd).toFixed(1) + '/s'], ['Rng', d.range]];
  return '<div class="stats">' + rows.map(r => '<div class="srow"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('') + '</div>';
};
// The phone tier gets names authored for its width rather than an ellipsis: "Warban…" is
// not a tower. Only the names that do not fit are re-cut.
const T_SHORT = { banner: 'Banner' };
{
  const bm = $('buildMenu');
  // SPEC3 §C: "Raise the Muster" lives on the build bar because it competes for the same
  // gold as the next tower — that is the decision. Placeholder styling; UI agent owns it.
  bm.innerHTML = '<div class="pHead"><div class="pT">Build</div><div class="rule"></div>' +
    '<button class="mus" id="btnMuster">Raise the Muster</button>' +
    '<button class="x" id="mX2" title="Cancel">✕</button></div><div class="cards"></div>';
  const cards = bm.querySelector('.cards');
  TK.forEach((k, i) => {
    const d = TOWER_DEFS[k], b = document.createElement('button');
    b.className = 'card'; b.dataset.t = k;
    const dl = dLabel(k);
    b.innerHTML = '<span class="kb">' + (i + 1) + '</span><span class="por"></span><span class="porS"></span>' +
      '<div class="nm">' + d.name + '</div><div class="nmS">' + (T_SHORT[k] || d.name) +
      '</div><div class="cost"><i class="ic ic-gold"></i>' + d.cost + '</div>' +
      '<div class="tags"><span class="tag" title="' + dl[2] + '"><i class="dg-' + dGlyph(k) + '"></i>' +
        '<span class="tw">' + dl[1] + '</span></span>' +
      '<span class="tag" title="Reach at tier 1"><i class="dg-rng"></i><b>' + d.range + '</b></span></div>' +
      // INTEGRATE: the writ and the stat table used to stand open on all seven cards at
      // once, which made the persistent shop 355 px tall — a third of every gameplay frame
      // on every map. Same information, folded into a flyout that opens over the card on
      // hover (and stays open while the card is armed, so placement still explains itself).
      '<div class="det"><div class="hnt">' + (T_HINT[k] || '') + '</div>' + statRows(k) + '</div>';
    const cv = towerPortrait(k, 1, 122, 88);
    cv.style.borderRadius = '4px'; b.querySelector('.por').replaceWith(cv); cv.className = 'por';
    // both tiers are authored up front and swapped by the breakpoint — a canvas cannot be
    // re-rasterised on resize without mutating the DOM after the final shot render
    const cs = towerGlyph(k, 1, 62, 40);
    b.querySelector('.porS').replaceWith(cs); cs.className = 'porS';
    cards.appendChild(b);
  });
}
let sellArm = false;
// A marketing frame must not ship with the shop standing over the keep. Under the harness the
// bar collapses to its hotkey rail for every overview/battle preset; `&ui=min` requests that
// anywhere, `&ui=full` forces the open bar back. Normal play is untouched.
const MINBAR = !!SHOT && (P.get('ui') === 'min' ||
  (/^(overview|battle)/.test(SHOT) && P.get('ui') !== 'full'));
// The build bar is PERSISTENT now (SPEC2 §A): it is the always-available shop, and a card
// arms placement mode instead of buying on the spot. Selecting a standing tower swaps it
// for the garrison panel.
UI.buildMenu = () => {
  const bm = $('buildMenu'), tm = $('towerMenu');
  const inGame = state.phase === 'prewave' || state.phase === 'wave';
  const tw = state.selTower >= 0 ? G.towersList[state.selTower] : null;
  if (!inGame) { bm.classList.add('hidden'); tm.classList.add('hidden'); sellArm = false; return; }
  if (tw) {
    bm.classList.add('hidden');
    const d = TOWER_DEFS[tw.type], lv = tw.level, max = lv >= 3;
    const upCost = max ? null : Math.round(d.cost * (lv === 1 ? 0.8 : 1.3));
    const dmgN = v => Math.round(d.dmg * Math.pow(1.55, v - 1));
    const rngN = v => (d.range * (1 + 0.08 * (v - 1))).toFixed(1);
    const burnN = v => Math.round((d.patch ? d.patch.dps : 0) * Math.pow(1.55, v - 1));
    const rows = d.knights
      ? [['Guards', d.knights, null], ['Guard hp', Math.round(90 * (1 + 0.5 * (lv - 1))), max ? null : Math.round(45)],
         ['Guard dps', (6 * (1 + 0.55 * (lv - 1))).toFixed(1), max ? null : 3.3], ['Rally', rngN(lv), null]]
      : d.aura
      ? [['Fire rate', '+' + Math.round(d.aura[lv - 1] * 100) + '%', max ? null : Math.round((d.aura[lv] - d.aura[lv - 1]) * 100) + '%'],
         ['Aura', rngN(lv), max ? null : (rngN(lv + 1) - rngN(lv)).toFixed(1)],
         ['Knight heal', '+50%', null], ['Stacks', 'no', null]]
      : d.patch
      ? [['Burn dps', burnN(lv), max ? null : burnN(lv + 1) - burnN(lv)],
         ['Range', rngN(lv), max ? null : (rngN(lv + 1) - rngN(lv)).toFixed(1)],
         ['Patch', d.patch.rad + 'u · ' + d.patch.dur + 's', null], ['Fires', d.patch.max, null]]
      : [['Damage', dmgN(lv), max ? null : dmgN(lv + 1) - dmgN(lv)],
         ['Range', rngN(lv), max ? null : (rngN(lv + 1) - rngN(lv)).toFixed(1)],
         ['Rate', (1 / d.cd).toFixed(2) + '/s', null], ['Dps', (dmgN(lv) / d.cd).toFixed(1), null]];
    tm.innerHTML = '<div class="pHead"><div class="pT">' + (max ? 'Veteran' : 'Garrison') + '</div><div class="rule"></div>' +
      '<button class="x" id="mX">✕</button></div>' +
      '<div class="tHead"><span class="tpor"></span><div><div class="tN">' + d.name + '</div>' +
      '<div class="tL">Tier ' + lv + (max ? ' · Max' : '') + '</div>' +
      '<div class="pips">' + [1, 2, 3].map(i => '<i class="' + (i <= lv ? 'on' : '') + '"></i>').join('') + '</div></div></div>' +
      '<div class="stats">' + rows.map(r => '<div class="srow"><span>' + r[0] + '</span><b>' + r[1] +
        (r[2] ? ' <span class="d">+' + r[2] + '</span>' : '') + '</b></div>').join('') + '</div>' +
      '<div class="tBtns"><button class="tBtn up" id="mUp"' + (max || state.gold < upCost ? ' disabled' : '') + '>' +
        (max ? 'Fully Built' : '▲ Upgrade') + (max ? '' : '<span class="s2">🪙 ' + upCost + '</span>') + '</button>' +
      '<button class="tBtn sell' + (sellArm ? ' arm' : '') + '" id="mSell">' + (sellArm ? 'Confirm?' : 'Dismantle') +
        '<span class="s2 ref">🪙 +' + Math.round(tw.invested * 0.7) + '</span></button>' +
      // SPEC3 §F — targeting doctrine, per tower (hotkey T). A rail of the three standing
      // orders with the live one lit: the point is which of THREE it is, not the name alone.
      (fights(d) ? '<button class="tBtn tgt" id="mTgt" title="Cycle this tower&apos;s standing order (T)">' +
        '<i class="tgL"></i><span class="tgS">' +
        G.MODES.map(m => '<i class="' + ((tw.mode || 'first') === m ? 'on' : '') + '">' + G.MODE_NAME[m] + '</i>').join('') +
        '</span><span class="tgK">T</span></button>' : '') + '</div>';
    tm.querySelector('.tpor').replaceWith(towerPortrait(tw.type, lv, 64, 64));
    tm.classList.remove('hidden');
    $('mUp').onclick = () => { sellArm = false; upgradeTower(tw); UI.buildMenu(); };
    $('mSell').onclick = () => { if (!sellArm) { sellArm = true; UI.buildMenu(); return; } sellArm = false; sellTower(tw); UI.deselect(); };
    $('mX').onclick = () => UI.deselect();
    if ($('mTgt')) $('mTgt').onclick = () => G.cycleMode(tw);
  } else {
    tm.classList.add('hidden'); sellArm = false;
    const armed = G.place ? G.place.type : '';
    bm.querySelectorAll('.card').forEach(b => {
      const poor = state.gold < TOWER_DEFS[b.dataset.t].cost;
      b.disabled = poor; b.classList.toggle('poor', poor);
      b.classList.toggle('arm', b.dataset.t === armed);
      b.onclick = () => { if (G.enterPlace(b.dataset.t) && G.placeAtCursor) G.placeAtCursor(); };
    });
    $('mX2').onclick = () => { G.exitPlace(); UI.deselect(); };
    // SPEC3 §C: the muster control shares the build bar's head with the shop because it
    // shares the shop's purse — one more standard OR one more tower, never both. The price
    // is on its face for the same reason every card carries its cost.
    const mb = $('btnMuster'), mc = G.musterCost();
    mb.innerHTML = '<i class="mIc ic-must"></i><span class="lg">Raise the Muster</span>' +
      '<b>' + G.towersList.length + '/' + state.muster + '</b>' +
      (mc === undefined ? '<span class="c cap">Limit</span>'
        : '<span class="c"><i class="ic ic-gold"></i>' + mc + '</span>');
    mb.title = mc === undefined ? 'The muster is at its limit — 14 standards is all the vale can field'
      : 'Raise the Muster — one more tower may take the field (' + mc + ' gold)';
    mb.disabled = mc === undefined || state.gold < mc;
    mb.onclick = () => { G.raiseMuster(); };
    bm.classList.toggle('min', MINBAR && !G.place);
    bm.classList.remove('hidden');
  }
};
UI.deselect = () => { state.selTower = -1; sellArm = false; $('towerMenu').classList.add('hidden'); UI.buildMenu(); };
// Placement read-out. `p` is SIM's G.place (or null when the hammer is put down).
let _pmsg = '';
UI.place = (p) => {
  const el = $('placeBar');
  if (!p) { el.classList.add('hidden'); _pmsg = ''; tutHint(false); UI.buildMenu(); return; }
  const d = TOWER_DEFS[p.type];
  const rr = (d.range).toFixed(0) + 'u ' + (d.aura ? 'aura' : 'reach');
  // SPEC3 §C: a full muster is not bad GROUND, so it does not get the ground's refusal. It
  // gets its own writ, naming the roster and the price of the next slot — otherwise the
  // player is told "no" by a system whose control is a small button on the other panel.
  const mFull = !p.ok && p.reason === 'The muster is full', mc = G.musterCost();
  // on a phone the ✓ button IS the instruction, so the writ stays one line
  const html = p.ok
    ? '<b>' + d.name + '</b> · ' + rr + '<i class="ic ic-gold"></i>' + d.cost + (UI.coarse ? '' : ' · click to raise')
    : mFull
    ? '<b>The muster is full</b><span class="pSub">' + G.towersList.length + ' of ' + state.muster +
      ' standards already in the field · ' + (mc === undefined ? 'no more may be raised'
        : 'raise the muster for <i>' + mc + '</i> gold, or dismantle one') + '</span>'
    : '<b>' + p.reason + '</b>';
  const pm = $('placeMsg');
  if (html !== _pmsg) { _pmsg = html; pm.innerHTML = html; }
  // the plate itself says yes or no — see #placeMsg.ok/.bad
  pm.classList.toggle('ok', !!p.ok); pm.classList.toggle('bad', !p.ok);
  // sit the writ clear of the build bar, whose height depends on how the cards wrapped
  el.style.bottom = ((barH() || 200) + 26) + 'px';
  el.classList.toggle('bad', !p.ok);
  el.classList.toggle('mus', mFull);
  el.classList.toggle('touch', !!UI.coarse);
  el.classList.remove('hidden');
  tutHint(true);
  UI.buildMenu();
};
UI.coarse = false;   // MAIN sets this from the pointer type (or &coarse= in shot mode)
// ══ campaign progress + map select (SPEC2 §E) ══════════════════════════════════
// Progress is one small object: best stars per map id. It lives in localStorage — EXCEPT
// under the shot harness, which must never depend on what the machine happens to have
// played. A preset stages it with UI.setProgress({1:2}); nothing is ever written back.
const PROG_KEY = 'bannerfall.progress', TUT_KEY = 'bannerfall.tut';
const LIVES0 = state.lives;                 // full garrison, captured before the first tick
let PROG = {};
function saveProg() { if (SHOT) return; try { localStorage.setItem(PROG_KEY, JSON.stringify({ v: 1, stars: PROG })); } catch (e) { /* private mode */ } }
if (!SHOT) try { const o = JSON.parse(localStorage.getItem(PROG_KEY) || 'null'); if (o) PROG = o.stars || o; } catch (e) { PROG = {}; }
UI.setProgress = (o) => { PROG = Object.assign({}, o); saveProg(); if (!$('maps').classList.contains('hidden')) buildMapCards(); };
const starsOf = id => PROG[id] | 0;
const unlocked = id => id === 1 || P.has('unlock') || starsOf(id - 1) >= 1;
// SPEC2 §E: three stars for ≥90% of the garrison still standing, two for ≥50%, one for a win.
const starsFor = lives => lives <= 0 ? 0 : lives >= LIVES0 * 0.9 ? 3 : lives >= LIVES0 * 0.5 ? 2 : 1;

// ── map chart: an engraved parchment plate, not a vector top-down ──────────────
// A flat top-down of the mesh pasted over a lit 3D diorama reads as an editor minimap: it
// shares no light direction with anything behind it, and a saturated lime fill is the first
// thing an art director calls programmer art. So the card carries a DIEGETIC object instead —
// the quartermaster's chart of that road: ink and wash on parchment, hachured relief, ruled
// border, compass rose, the route dashed. Same data as before (the real spline waypoints, the
// real gate positions, that map's own palette as the wash hue), told in its own register, so
// there is nothing left to clash with the golden hour behind it.
const MINI_W = 228, MINI_H = 140;
const s8 = v => Math.round(255 * Math.pow(clamp(v, 0, 1), 1 / 2.2));
const rgbOf = (a, k) => 'rgb(' + s8(a[0] * (k || 1)) + ',' + s8(a[1] * (k || 1)) + ',' + s8(a[2] * (k || 1)) + ')';
const mixv = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function mapMini(m) {
  const pal = Object.assign({}, WPAL_BASE, m.palette || {});
  const c = pcv(MINI_W * 2, MINI_H * 2), g = c.getContext('2d'), W = c.width, H = c.height;
  const X = x => W / 2 + x * W / 212, Z = z => H / 2 + z * H / 130;
  const INK = '#3a2c1c';
  const ink = a => 'rgba(58,44,28,' + a + ')';
  const snow = pal.snow || 0;
  // hue from the map's own ground palette, but a chart is ink and WASH: never a flat fill
  const wash = mixv(mixv(pal.gLit, pal.dry1, 0.36), mixv(pal.snowC, [0.46, 0.54, 0.66], 0.28), snow * 0.86);
  const wsh = a => 'rgba(' + s8(wash[0]) + ',' + s8(wash[1]) + ',' + s8(wash[2]) + ',' + a + ')';

  // ── the sheet ────────────────────────────────────────────────────────────────
  const pg = g.createLinearGradient(0, 0, W * 0.35, H);
  pg.addColorStop(0, '#e6d7b4'); pg.addColorStop(0.48, '#d9c9a3'); pg.addColorStop(1, '#c4ad83');
  g.fillStyle = pg; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {                                   // laid fibre
    g.strokeStyle = 'rgba(' + (urng() > 0.7 ? '255,248,224,' : '124,96,54,') + (0.04 + urng() * 0.10) + ')';
    g.lineWidth = ur(0.6, 1.6);
    const x = urng() * W, y = urng() * H, a = urng() * 6.283, l = ur(5, 30);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 44; i++) {                                    // foxing blooms
    g.fillStyle = 'rgba(126,94,48,' + (0.05 + urng() * 0.10) + ')';
    g.beginPath(); g.ellipse(urng() * W, urng() * H, ur(5, 26), ur(4, 18), urng() * 3, 0, 7); g.fill();
  }

  // ── the coastline of the bowl, from the same harmonics the diorama is cut to ──
  const TAU = 6.283185307, RX = W * 0.436, RY = H * 0.418, ph = m.id * 2.1;
  const rk = a => 1 + 0.062 * Math.sin(a * 3 + ph) + 0.040 * Math.sin(a * 5 - ph * 1.7)
                    + 0.024 * Math.sin(a * 9 + 1.1) - 0.030 * Math.sin(a * 2 - ph);
  const at = (a, k) => [W / 2 + Math.cos(a) * RX * rk(a) * k, H / 2 + Math.sin(a) * RY * rk(a) * k];
  const blob = (k) => {
    g.beginPath();
    for (let i = 0; i <= 96; i++) { const p = at(i / 96 * TAU, k); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
    g.closePath();
  };

  // ── hachures: relief is drawn, not shaded — short strokes falling off the rim ──
  g.lineCap = 'round';
  for (let i = 0; i < 210; i++) {
    const a = i / 210 * TAU, p = at(a, 1.0);
    const nx = Math.cos(a) * RY, ny = Math.sin(a) * RX, L = Math.hypot(nx, ny) || 1;
    const ux = nx / L, uy = ny / L, len = (i % 3 === 0 ? 15 : i % 3 === 1 ? 10 : 6) * (0.8 + urng() * 0.5);
    g.strokeStyle = ink(i % 3 === 0 ? 0.5 : 0.3); g.lineWidth = i % 3 === 0 ? 1.7 : 1.2;
    g.beginPath(); g.moveTo(p[0] + ux * 2, p[1] + uy * 2); g.lineTo(p[0] + ux * (2 + len), p[1] + uy * (2 + len)); g.stroke();
  }

  g.save();
  blob(1); g.clip();
  g.fillStyle = wsh(0.30); g.fillRect(0, 0, W, H);                  // the vale, washed in
  for (let i = 0; i < 900; i++) {                                   // wash tooth, not speckle
    g.fillStyle = wsh(0.05 + urng() * 0.14);
    g.beginPath(); g.arc(urng() * W, urng() * H, 0.7 + urng() * 2.2, 0, 7); g.fill();
  }
  for (let k of [0.86, 0.7, 0.52]) {                                // contour rings
    g.strokeStyle = ink(0.16); g.lineWidth = 1.2; g.setLineDash([9, 7]); blob(k); g.stroke();
  }
  g.setLineDash([]);
  // woodland: an ink symbol repeated, the way a chart says "trees" — never a filled dot
  const tuft = (x, y, s) => {
    g.strokeStyle = ink(0.44); g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(x, y + s * 0.95); g.lineTo(x, y - s * 0.1); g.stroke();
    g.beginPath(); g.moveTo(x - s, y + s * 0.3); g.quadraticCurveTo(x, y - s * 1.1, x + s, y + s * 0.3); g.stroke();
    g.beginPath(); g.moveTo(x - s * 0.6, y + s * 0.78); g.quadraticCurveTo(x, y - s * 0.3, x + s * 0.6, y + s * 0.78); g.stroke();
  };
  // woodland in CLUSTERS, not an even sprinkle: a chart draws the forests it means, and the
  // meadow it leaves open is information too
  for (let k = 0; k < 17; k++) {
    const a = urng() * TAU, r = 0.26 + Math.sqrt(urng()) * 0.66, cp = at(a, r);
    const n = 3 + (urng() * 5 | 0), sp = 9 + urng() * 14;
    for (let i = 0; i < n; i++)
      tuft(cp[0] + ur(-sp, sp), cp[1] + ur(-sp * 0.6, sp * 0.6), 4.4 + urng() * 3.4);
  }
  // the road, drawn from the SAME waypoints PATH builds the spline from
  const routes = m.routes ? m.routes.map(r => r.wps) : [m.wps];
  const road = (wid, style, dash) => {
    g.strokeStyle = style; g.lineWidth = wid; g.lineCap = 'round'; g.lineJoin = 'round';
    g.setLineDash(dash || []);
    for (const wps of routes) {
      const p = wps.map(w => [X(w[0]), Z(w[1])]);
      g.beginPath(); g.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++)
        g.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      g.lineTo(p[p.length - 1][0], p[p.length - 1][1]); g.stroke();
    }
    g.setLineDash([]);
  };
  road(11, 'rgba(214,196,158,.85)');                                // the sheet cleared for it
  road(9.4, ink(0.16));                                             // its shadow line
  road(3.2, ink(0.82), [11, 8]);                                    // the route, dashed in ink
  if (m.houses) for (const [hx, hz] of m.houses) {                  // the hamlet by the keep
    const x = X(hx), y = Z(hz);
    poly(g, [x - 4.4, y + 4.4, x + 4.4, y + 4.4, x + 4.4, y - 1, x - 4.4, y - 1], ink(0.62), INK, 1);
    poly(g, [x - 6, y - 1, x + 6, y - 1, x, y - 7], ink(0.82), INK, 1);
  }
  g.restore();

  blob(1); g.strokeStyle = ink(0.86); g.lineWidth = 2.6; g.stroke();       // the coastline
  blob(0.985); g.strokeStyle = ink(0.22); g.lineWidth = 1.1; g.stroke();

  { const rx = W - 38, ry = H - 34, r = 15;                         // compass rose (under the gates)
    g.strokeStyle = ink(0.5); g.lineWidth = 1.3;
    g.beginPath(); g.arc(rx, ry, r, 0, 7); g.stroke();
    g.beginPath(); g.arc(rx, ry, r * 0.66, 0, 7); g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 - Math.PI / 2;
      poly(g, [rx + Math.cos(a) * r * 1.12, ry + Math.sin(a) * r * 1.12,
               rx + Math.cos(a + 2.3) * r * 0.26, ry + Math.sin(a + 2.3) * r * 0.26,
               rx + Math.cos(a - 2.3) * r * 0.26, ry + Math.sin(a - 2.3) * r * 0.26],
        i === 0 ? ink(0.82) : ink(0.42), INK, 0.8);
    }
    g.fillStyle = ink(0.8); g.beginPath(); g.arc(rx, ry, 2, 0, 7); g.fill();
  }
  const gate = (x, z, foe) => {                                     // gates: red in, blue home
    const px = X(x), pz = Z(z);
    g.fillStyle = foe ? 'rgba(150,42,30,.88)' : 'rgba(38,74,132,.88)';
    g.beginPath(); g.arc(px, pz, 8.2, 0, 7); g.fill();
    g.strokeStyle = INK; g.lineWidth = 2.2; g.stroke();
    if (foe) {
      g.strokeStyle = 'rgba(246,238,216,.92)'; g.lineWidth = 2.2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(px - 3.2, pz - 3.2); g.lineTo(px + 3.2, pz + 3.2);
      g.moveTo(px + 3.2, pz - 3.2); g.lineTo(px - 3.2, pz + 3.2); g.stroke();
    } else poly(g, [px, pz - 4.8, px + 4, pz - 1.6, px + 4, pz + 1.6, px, pz + 5,
                    px - 4, pz + 1.6, px - 4, pz - 1.6], 'rgba(246,238,216,.95)');
  };
  (m.routes || [{ wps: m.wps }]).forEach(r => { if (!r.from) gate(r.wps[0][0], r.wps[0][1], true); });
  const endR = (m.routes || [{ wps: m.wps }]).find(r => r.to === undefined) || { wps: m.wps };
  gate(endR.wps[endR.wps.length - 1][0], endR.wps[endR.wps.length - 1][1], false);

  g.strokeStyle = ink(0.6); g.lineWidth = 2.2; g.strokeRect(9, 9, W - 18, H - 18);   // ruled border
  g.strokeStyle = ink(0.3); g.lineWidth = 1.1; g.strokeRect(15.5, 15.5, W - 31, H - 31);
  const bn = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.6);
  bn.addColorStop(0, 'rgba(84,58,24,0)'); bn.addColorStop(1, 'rgba(76,50,18,.36)');  // edge burn
  g.fillStyle = bn; g.fillRect(0, 0, W, H);
  c.className = 'mini';
  return c;
}
// The copy already says "Chained until Frostfell Pass is held", so the art says chains — not
// dashed hazard tape over a black void. The chart stays readable underneath (that is what
// makes it worth unlocking); the iron is what is between you and it.
function lockArt() {
  const link = (x, y, a) =>
    '<g transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + a.toFixed(1) + ')">' +
    '<ellipse rx="9.4" ry="5.4" fill="none" stroke="#15171b" stroke-width="6.6"/>' +
    '<ellipse rx="9.4" ry="5.4" fill="none" stroke="#5b5850" stroke-width="4.2"/>' +
    '<path d="M-8 -3A9.4 5.4 0 0 1 1.4 -5" fill="none" stroke="#b6b0a4" stroke-width="1.4" opacity=".75"/></g>';
  let s = '';
  for (const [x0, y0, x1, y1] of [[-14, 22, 254, 118], [-14, 118, 254, 22]]) {
    const n = 15, ang = Math.atan2(y1 - y0, x1 - x0) * 57.2958;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      s += link(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ang + (i % 2 ? 74 : 0));
    }
  }
  return '<svg viewBox="0 0 240 140" preserveAspectRatio="none" aria-hidden="true">' + s +
    '<g transform="translate(120 70)" >' +
    '<path d="M-13 -3v-12a13 13 0 0 1 26 0v12" fill="none" stroke="#14161a" stroke-width="9"/>' +
    '<path d="M-13 -3v-12a13 13 0 0 1 26 0v12" fill="none" stroke="#7d786e" stroke-width="5.4"/>' +
    '<rect x="-21" y="-4" width="42" height="33" rx="5" fill="#3a332a" stroke="#14161a" stroke-width="2.4"/>' +
    '<rect x="-17" y="-0.6" width="34" height="26" rx="3" fill="none" stroke="#5d5445" stroke-width="1.4"/>' +
    '<circle cy="9" r="4.6" fill="#e8b64c"/><path d="M-2.2 9h4.4l-1 11h-2.4z" fill="#e8b64c"/>' +
    '</g></svg>';
}
const MINI_CACHE = {};
function buildMapCards() {
  const host = $('mapCards');
  host.innerHTML = '';
  // "where am I in the campaign" was unanswerable: nothing marked the road you have taken and
  // nothing marked the one you are on. The first unlocked road with no stars is the CONTINUE.
  const nextM = MAPS.find(m => unlocked(m.id) && !starsOf(m.id)) ||
                MAPS.filter(m => unlocked(m.id)).pop() || MAPS[0];
  MAPS.forEach((m, i) => {
    const open = unlocked(m.id), st = starsOf(m.id), prev = MAPS[i - 1];
    const nw = (WAVE_TABLES[m.id] || []).length;
    const b = document.createElement('button');
    b.className = 'mCard' + (open ? '' : ' lock') + (open && m === nextM ? ' next' : '');
    b.innerHTML = '<div class="mWrap"></div><div class="mTxt"><div class="mN">' + m.name + '</div>' +
      '<div class="mB">' + (open ? m.blurb : 'Chained until ' + (prev ? prev.name : 'the first road') + ' is held.') + '</div>' +
      '<div class="mFoot"><span class="mW">' + nw + ' waves</span>' +
      (open ? '<div class="stars">' + (st ? '<b class="ck"></b>' : '') +
                [1, 2, 3].map(k => '<i class="' + (k <= st ? 'on' : '') + '"></i>').join('') + '</div>'
            : '<span class="mLk">Chained</span>') + '</div></div>' +
      (open && m === nextM ? '<span class="rib">' + (st ? 'Replay' : 'Continue') + '</span>' : '');
    b.querySelector('.mWrap').appendChild(MINI_CACHE[m.id] || (MINI_CACHE[m.id] = mapMini(m)));
    if (!open) { const lk = document.createElement('div'); lk.className = 'mChain'; lk.innerHTML = lockArt();
      b.querySelector('.mWrap').appendChild(lk); }
    b.title = open ? m.name + ' · ' + nw + ' waves · best ' + st + '/3 stars'
                   : m.name + ' — locked until ' + (prev ? prev.name : 'the first road') + ' is held';
    if (open) b.onclick = () => chooseMap(m.id);
    host.appendChild(b);
  });
}
function chooseMap(id) {
  Audio.play('ui');
  if (id === MAP.id) { $('maps').classList.add('hidden'); UI.startGame(); return; }
  // The world, the wave tables and the palette are all resolved from `&map=` at load, so a
  // different road is a reload. `auto` drops the player straight in rather than back to the title.
  const q = new URLSearchParams(location.search);
  q.set('map', id); q.set('auto', '1'); q.delete('maps');
  location.search = q.toString();
}
UI.showMaps = () => { buildMapCards(); $('title').classList.add('hidden'); $('end').classList.add('hidden'); $('maps').classList.remove('hidden'); };
// `gesture` is false on the deep-link path (`&auto=1`), where the page opened without a
// user gesture: a WebAudio context created there is born suspended and stays that way, so
// the score waits for the first touch instead of never sounding at all.
UI.startGame = (gesture) => {
  $('title').classList.add('hidden'); $('maps').classList.add('hidden');
  // whatever the player clicked to get here keeps focus otherwise, and a focused HUD button
  // outranks gold and lives on contrast the moment the overlay lifts
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  state.phase = 'prewave'; state.countdown = 14;
  CAM.dist = 100; CAM.tx = -2; CAM.tz = 2;
  if (gesture === false) {
    const kick = () => Audio.music();
    addEventListener('pointerdown', kick, { once: true });
    addEventListener('keydown', kick, { once: true });
  } else Audio.music();
  UI.sync();
};
// ── first-placement writ (localStorage-gated, never shown under the harness) ────
let tutDone = true;
if (!SHOT) try { tutDone = !!localStorage.getItem(TUT_KEY); } catch (e) { tutDone = true; }
function tutSeen() { if (tutDone) return; tutDone = true; try { localStorage.setItem(TUT_KEY, '1'); } catch (e) {} }
function tutHint(on) {
  const el = $('tutHint');
  if (G.towersList.length) tutSeen();          // the lesson is over the moment one stands
  // `&tut=1` forces the writ under the harness (it is otherwise unreachable there, since
  // SHOT mode never has a "first ever" flag to read) so it can be art-directed like the rest.
  if (!on || (tutDone && !(SHOT && P.has('tut')))) { el.classList.add('hidden'); return; }
  el.innerHTML = '<div class="tH">Raising a tower</div>Set it on open ground clear of the road — the <b>ring</b> is how far it will reach. ' +
    (UI.coarse ? 'Drag to aim, then tap <b>✓</b>.' : 'Click to raise it · <b>Shift</b> keeps the hammer in hand · <b>Esc</b> puts it down.');
  el.style.bottom = ((barH() || 200) + 88) + 'px';
  el.classList.remove('hidden');
}
// ══ victory / defeat ═══════════════════════════════════════════════════════════
// Struck-gold medallion: scalloped rim, blue enamel field, a device, and a ribbon fold.
function scallop(n, cx, cy, r1, r2) {
  let p = '';
  for (let i = 0; i < n * 2; i++) {
    const a = i / (n * 2) * 6.283185 - 1.5708, r = i % 2 ? r1 : r2;
    p += (i ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2);
  }
  return p + 'Z';
}
const DEVICE = {
  shield: '<path d="M28 36.5h0M20.4 38.6h15.2v8.4c0 5.4-4 8.8-7.6 10.8-3.6-2-7.6-5.4-7.6-10.8z" fill="url(#gGold)" stroke="#6d4a10" stroke-width=".8"/>' +
          '<path d="M20.4 47.4l7.6-4 7.6 4v2.6L28 46l-7.6 4z" fill="#24487e" opacity=".55"/>',
  tower:  '<path d="M21 57.4V41.6h2.4v-3h2.2v3h4v-3h2.2v3H34v15.8z" fill="url(#gGold)" stroke="#6d4a10" stroke-width=".8"/>' +
          '<path d="M26.4 48.6h2.4v8.8h-2.4z" fill="#24487e" opacity=".6"/>',
  star:   '<path d="M28 37.4l3.4 7 7.6 1.1-5.6 5.4 1.4 7.6L28 54.9l-6.8 3.6 1.4-7.6-5.6-5.4 7.6-1.1z" fill="url(#gGold)" stroke="#6d4a10" stroke-width=".8"/>',
};
const medal = (on, label, dev) => '<div class="md' + (on ? '' : ' off') + '">' +
  '<svg viewBox="0 0 56 76"><title>' + label + '</title>' +
  '<path d="M15 0h11l-2.4 22h-7z" fill="#5c160f"/><path d="M30 0h11l-1.6 22h-7z" fill="#5c160f"/>' +
  '<path d="M15 0h11l-2.4 22h-7z" fill="#8f2d20" opacity=".85"/><path d="M13.5 0h29l-2 8h-25z" fill="#a5352b"/>' +
  '<path d="M13.5 0h29l-2 8h-25z" fill="none" stroke="#6d4a10" stroke-width=".7" opacity=".6"/>' +
  '<path d="' + scallop(20, 28, 47.5, 24.4, 26.6) + '" fill="url(#gGoldR)" opacity=".95"/>' +
  '<circle cx="28" cy="47.5" r="23" fill="url(#gGold)"/>' +
  '<circle cx="28" cy="47.5" r="23" fill="none" stroke="#6d4a10" stroke-width="1.2"/>' +
  '<circle cx="28" cy="47.5" r="17.4" fill="#1f3f74"/>' +
  '<circle cx="28" cy="47.5" r="17.4" fill="none" stroke="#ffe7ab" stroke-width=".9" opacity=".55"/>' +
  '<path d="M11 40a19 19 0 0 1 12-11" fill="none" stroke="#fff6da" stroke-width="2.2" opacity=".45" stroke-linecap="round"/>' +
  '<g transform="translate(28,47.5) scale(1.34) translate(-28,-47.5)">' + DEVICE[dev] + '</g></svg>' +
  '<span class="mL">' + label + '</span></div>';
UI.showEnd = (won) => {
  const total = state.kills + state.leaked;
  // SPEC2 §E: a win writes its stars into the campaign record, which is what opens the
  // next road. Best-ever is kept, so a scrappy re-run never demotes a clean one.
  const st = won ? starsFor(state.lives) : 0, was = starsOf(MAP.id), best = Math.max(st, was);
  if (st > was) { PROG[MAP.id] = st; saveProg(); }
  const nx = won ? MAPS.find(m => m.id === MAP.id + 1) : null;
  $('endTitle').textContent = won ? 'VICTORY' : MAP.id === 1 ? 'THE VALE HAS FALLEN' : 'THE ROAD IS LOST';
  $('endTitle').style.color = won ? '#f0c96a' : '#d0563c';
  $('endSub').textContent = won ? MAP.name + ' holds' : 'The banners fall on ' + MAP.name;
  $('endStars').classList.toggle('hidden', !won);
  $('endStarL').classList.toggle('hidden', !won);
  if (won) {
    $('endStars').innerHTML = [1, 2, 3].map(i => '<i class="' + (i <= st ? 'on' : '') + '"></i>').join('');
    // INTEGRATE: the top star is 90% of the garrison, not a clean sheet, so "not a banner
    // lost" was a lie on any 3-star run that leaked — and the plate says "Breached the gate:
    // 3" four rows below it. The clean-sheet line is now earned by an actual clean sheet.
    $('endStarL').textContent = (state.leaked === 0 ? 'Not a banner lost' : st >= 3 ? 'The line never broke'
      : st === 2 ? 'A costly hold' : 'Held by a thread') +
      (st > was ? ' · new best' : was > st ? ' · best ' + best + '/3' : '');
  }
  const bn = $('btnNext');
  bn.classList.toggle('hidden', !nx);
  if (nx) {
    bn.textContent = nx.name + ' awaits';
    bn.onclick = () => chooseMap(nx.id);
  }
  $('btnRestart').textContent = won ? 'Choose Your Road' : 'Try Again';
  $('btnRestart').classList.toggle('sec', !!nx);   // the next road is the headline, not this
  const m1 = state.wave >= 5 || won, m2 = won && state.lives >= 16, m3 = won && state.leaked === 0;
  // the campaign has three roads now, so a medal cannot be named after the Vale
  $('medals').innerHTML = medal(m1, 'Held', 'shield') + medal(m2, 'Garrison Kept', 'tower') + medal(m3, 'Flawless', 'star');
  $('endStats').innerHTML = '<table>' +
    '<tr><td>Foes slain</td><td>' + state.kills + '</td></tr>' +
    '<tr><td>Breached the gate</td><td>' + state.leaked + '</td></tr>' +
    '<tr><td>Waves held</td><td>' + (won ? WAVES.length : Math.max(0, state.wave - 1)) + ' / ' + WAVES.length + '</td></tr>' +
    '<tr><td>Garrison left</td><td>' + Math.max(0, state.lives) + ' / ' + LIVES0 + '</td></tr>' +
    '<tr><td>Kill ratio</td><td>' + (total ? Math.round(state.kills / total * 100) : 0) + '%</td></tr></table>';
  $('end').classList.remove('hidden');
  UI.sync();
};
// ══ damage floaters (pooled DOM, projected world → screen) ═════════════════════
const FLN = 20, flEl = [], flR = [];
{
  const host = $('floaters');
  for (let i = 0; i < FLN; i++) { const d = document.createElement('div'); d.className = 'fl'; host.appendChild(d); flEl.push(d); flR.push(null); }
}
const _fv = new THREE.Vector3();
let _fw = 0, _lastEvT = -1;
const FLIGHT = { archer: 0.19, ballista: 0.14, catapult: 1.1 };
function pushFloater(rec) { flR[_fw] = rec; _flHid[_fw] = 0; _fw = (_fw + 1) % FLN; }
// The number on screen has to be the number the sim dealt. The raw `dmg * 1.55^(level-1)`
// ignores resistance entirely, so every hit on a .7-pierce pavise was printed at 330% of
// the truth. Mirrors SIM's dealDamage() exactly (SPEC3 §A) — same cap, same omen multiplier.
function armMul(def, e) {
  const el = def.element;
  let r = (e && e.def) ? G.resistOf(e.def, el) : 0;
  if (e && e.ward === el) r += G.OMEN_FX.ward;
  return (1 - Math.min(r, 0.85)) * (G.OMEN_FX.dmg[el] || 1);
}
// OCCLUSION. layoutFloaters only rejected z > 1 (behind the camera), so a number belonging
// to a unit hidden behind a foreground conifer was painted at full opacity on top of the
// tree with no unit anywhere near it — the reader has no way to attach it to anything.
// One ray per floater against the instanced tree/rock/cliff meshes, refreshed every 4th
// frame and cached in between; a hit fades the floater out entirely.
const _flRay = new THREE.Raycaster(), _flOcc = [], _flHid = new Uint8Array(FLN);
let _flFrame = 0, _flGot = false;
function flOccluders() {
  if (_flGot) return _flOcc;
  _flGot = true;
  for (const nm of ['TREE_OAK', 'TREE_ASH', 'TREE_PINE', 'CRAGS_A', 'CRAGS_B', 'CRAGS_C', 'ROCKS']) {
    const m = G.scene && G.scene.getObjectByName(nm);
    if (m) _flOcc.push(m);
  }
  return _flOcc;
}
function harvestFire(t) {
  const evs = Towers.fireEvents;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.t <= _lastEvT) continue;
    if (t - ev.t > 1.4) { _lastEvT = Math.max(_lastEvT, ev.t); continue; }
    const tw = ev.tw, d = TOWER_DEFS[tw.type];
    if (!d.dmg || !ev.tgt) { _lastEvT = Math.max(_lastEvT, ev.t); continue; }
    const crit = tw.type === 'catapult' || (tw.shots | 0) % 4 === 0;
    const base = d.dmg * Math.pow(1.55, tw.level - 1), t0 = ev.t + (FLIGHT[tw.type] || 0.2);
    const jit = s => (((tw.uid * 37 + (tw.shots | 0) * 19 + s * 53) % 11) - 5) * 5;
    pushFloater({ t0, e: ev.tgt, txt: '' + Math.round(base * (crit ? 1.85 : 1) * armMul(d, ev.tgt)),
      cls: 'fl' + (crit ? ' crit' : ''), sx: jit(0) });
    // splash / pierce victims get their own (smaller) number — this is what makes a catapult
    // volley read as a volley instead of a single hit.
    if (tw.type === 'catapult' || d.pierce) {
      const R = tw.type === 'catapult' ? (d.splash || 4.5) : 2.2;
      let extra = tw.type === 'catapult' ? 4 : d.pierce, s = 1;
      for (const e2 of G.enemies) {
        if (extra <= 0) break;
        if (!e2.alive || e2 === ev.tgt) continue;
        if (Math.hypot(e2.px - ev.tgt.px, e2.pz - ev.tgt.pz) > R) continue;
        pushFloater({ t0: t0 + s * 0.045, e: e2, txt: '' + Math.round(base * 0.52 * armMul(d, e2)), cls: 'fl', sx: jit(s) });
        extra--; s++;
      }
    }
    _lastEvT = Math.max(_lastEvT, ev.t);
  }
}
const _fa = new THREE.Vector3();
function layoutFloaters(t) {
  const test = (_flFrame++ & 3) === 0, occ = test ? flOccluders() : null;
  for (let i = 0; i < FLN; i++) {
    const r = flR[i], el = flEl[i];
    if (!r) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
    const age = t - r.t0, DUR = 1.05;
    if (age < 0 || age > DUR) { flR[i] = null; el.style.opacity = '0'; continue; }
    const e = r.e;
    _fa.set(e.px, G.groundY(e.px, e.pz) + (e.def.scale || 1) * 1.55, e.pz);
    if (test && occ.length) {
      _flRay.ray.origin.copy(G.camera.position);
      _flRay.ray.direction.copy(_fa).sub(G.camera.position);
      const dist = _flRay.ray.direction.length();
      _flRay.ray.direction.multiplyScalar(1 / dist);
      // Under ~10 u nothing can get between this camera and the unit, and that is exactly
      // the range where the ray cost would be paid most often (a closeup frame).
      _flRay.near = 0.1; _flRay.far = dist - 0.6;
      _flHid[i] = dist > 10 && _flRay.intersectObjects(occ, false).length ? 1 : 0;
    }
    if (_flHid[i]) { el.style.opacity = '0'; continue; }
    _fv.copy(_fa).project(G.camera);
    if (_fv.z > 1) { el.style.opacity = '0'; continue; }
    const f = age / DUR;
    // Higher and further clear of the anchor: at the old offset a number landed straight on
    // the instanced health bar above the unit and the bar's pixels cut the glyphs, so a
    // '388' read as struck through (shots\battle2.png).
    const x = (_fv.x * 0.5 + 0.5) * innerWidth + r.sx, y = (-_fv.y * 0.5 + 0.5) * innerHeight - 46 * Math.sqrt(f) - 18;
    if (el.textContent !== r.txt) el.textContent = r.txt;
    if (el.className !== r.cls) el.className = r.cls;
    el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + (f < 0.14 ? 0.6 + f / 0.14 * 0.45 : 1.05 - f * 0.14).toFixed(3) + ')';
    el.style.opacity = (f < 0.1 ? f / 0.1 : f > 0.62 ? (1 - f) / 0.38 : 1).toFixed(3);
  }
  if (SHOT && P.has('dbg') && test) {
    let live = 0, hid = 0;
    for (let i = 0; i < FLN; i++) if (flR[i]) { live++; hid += _flHid[i]; }
    console.log('FLDBG occ=' + flOccluders().length + ' live=' + live + ' hidden=' + hid);
  }
}
// ══ per-frame UI: count-up gold, floaters, title Ken-Burns ═════════════════════
// Called from MAIN's render(). In SHOT mode it stops mutating the DOM before the FINAL
// render so the headless compositor never repaints after the GL frame is presented.
let _uiLast = -1, _shotFrames = 0;
UI.frame = (rt) => {
  if (SHOT) { if (_shotFrames++ >= 2) return; }
  const dt = _uiLast < 0 ? 0.016 : clamp(rt - _uiLast, 0, 0.1); _uiLast = rt;
  if (!SHOT) {
    if (showGold !== state.gold) {                                     // animated count-up
      const d = state.gold - showGold;
      showGold += Math.sign(d) * Math.min(Math.abs(d), Math.max(1, Math.abs(d) * 6 * dt + 24 * dt));
      if (Math.abs(state.gold - showGold) < 0.6) showGold = state.gold;
      $('gold').textContent = fmt(Math.round(showGold));
    }
    if (state.phase === 'title') {                                     // Ken-Burns backdrop drift
      CAM.dist = 152 + Math.sin(rt * 0.055) * 9;
      CAM.tx = -2 + Math.sin(rt * 0.037) * 11; CAM.tz = -18 + Math.cos(rt * 0.029) * 7;
    }
  }
  const t = G.vt();
  harvestFire(t);
  layoutFloaters(t);
};
// ══ controls ═══════════════════════════════════════════════════════════════════
$('btnWave').onclick = () => { if (state.phase === 'prewave') { state.gold += Math.ceil(state.countdown); startWave(state.wave + 1); } };
$('btnSpeed').onclick = () => { state.speed = state.speed === 1 ? 2 : 1;
  $('btnSpeed').textContent = '×' + state.speed; $('btnSpeed').classList.toggle('on', state.speed === 2); };
$('btnPause').onclick = () => { state.paused = !state.paused;
  $('btnPause').textContent = state.paused ? '▶' : '❚❚'; $('btnPause').classList.toggle('on', state.paused); };
$('btnGear').onclick = () => { const s = $('settings'); s.classList.toggle('hidden');
  $('btnGear').classList.toggle('on', !s.classList.contains('hidden')); };
$('btnMute').onclick = () => { Audio.muted = !Audio.muted; $('muteV').textContent = Audio.muted ? 'Off' : 'On'; };
$('btnQual').onclick = () => {
  const order = ['mobile', 'high', 'ultra'], nx = order[(order.indexOf(tier) + 1) % 3];
  const p = new URLSearchParams(location.search); p.set('tier', nx);
  location.search = p.toString();
};
$('btnReset').onclick = () => location.reload();
// Title → map select → game. `&map=` names a road outright, so it skips the chooser and
// Play drops straight into that map (the shot harness and any deep link rely on this).
$('btnPlay').onclick = () => { if (P.has('map')) UI.startGame(); else UI.showMaps(); };
$('btnBack').onclick = () => { $('maps').classList.add('hidden'); $('title').classList.remove('hidden'); Audio.play('ui'); };
$('btnRestart').onclick = () => {
  if (state.phase !== 'won') { location.reload(); return; }
  const q = new URLSearchParams(location.search);      // a held road sends you back to the campaign
  q.delete('map'); q.delete('auto'); q.set('maps', '1');
  location.search = q.toString();
};
$('chipWave').title = MAP.name + ' · ' + WAVES.length + ' waves';
$('wavePrev').title = MAP.name;
// the title plinth counted four towers and one road; both grew (SPEC2 §C/§E)
// SPEC3 §E: the war seed is the run's fingerprint — same seed, same elite swap slots and the
// same omen draws, so a run can be replayed or handed to someone else. The die rolls a new
// one and reloads; the number appears wherever a run is about to start (plinth + chooser).
const seedTag = () => '<span class="sV">War Seed ' + G.runSeed + '</span>' +
  '<button class="sD frm" data-seed="1" title="Roll a new war seed — new elite swaps, new omen draws">Roll</button>';
$('titleFoot').innerHTML = MAPS.length + ' roads &nbsp;·&nbsp; ' + TK.length + ' fortifications &nbsp;·&nbsp; ' +
  '<span class="seedTag">' + seedTag() + '</span>';
$('mapsSeed').innerHTML = seedTag();
// Entropy for a NEW seed comes from the same crypto source CORE captured with — never
// Math.random/Date.now (SPEC3 §E), and never inside a sim tick: this only ever reloads.
const rollSeed = () => {
  if (!(globalThis.crypto && crypto.getRandomValues)) return;
  const q = new URLSearchParams(location.search);
  q.set('seed', String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000)));
  location.search = q.toString();
};
document.querySelectorAll('.seedTag .sD').forEach(b => { b.onclick = rollSeed; });
$('qualV').textContent = tier === 'mobile' ? 'Low' : tier === 'ultra' ? 'Ultra' : 'High';
if (!SHOT) {
  // Interaction listeners live behind the SHOT guard (GAME_SPEC §2.3c).
  addEventListener('keydown', e => { if (e.key === 'g' || e.key === 'G') $('btnGear').click(); });
  $('title').addEventListener('pointerdown', e => { if (e.target === $('title')) $('btnPlay').click(); });
}
// ══════════════════════ END SECTION: UI ══════════════════════

// ══════════════════════ SECTION: MAIN (owner: architect — renderer, camera, loop, SHOT HARNESS) ══
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier !== 'mobile', powerPreference: 'high-performance', preserveDrawingBuffer: !!SHOT });
renderer.info.autoReset = false;
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.px));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
G.renderer = renderer;

const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 1, 600);
G.camera = camera;
// dir pitch ~50° (GAME_SPEC §1 asks for a high-angle 55–60° aerial read); azimuth puts
// the warm sun raking in from screen-left and the road's S-curve across the frame.
const CAM = { tx: -2, ty: 0, tz: 2, dist: 100, dir: new THREE.Vector3(0.44, 1.215, 0.92).normalize(), free: false };
G.CAM = CAM;
function updateCamera(t) {
  if (CAM.free) return;
  // Shake offsets are a RENDER-time function, never rng(): a variable frame rate used to
  // pull a variable number of draws out of the sim stream, which desynced the shot harness
  // from live play. Two mutually-irrational frequencies read as noise.
  const amp = G.shake;
  const shx = amp > 0 ? Math.sin(t * 61.7) * amp * 0.5 : 0, shz = amp > 0 ? Math.sin(t * 47.3 + 1.7) * amp * 0.5 : 0;
  if (amp > 0) G.shake = Math.max(0, amp - 0.02);
  camera.position.set(CAM.tx + CAM.dir.x * CAM.dist + shx, CAM.ty + CAM.dir.y * CAM.dist, CAM.tz + CAM.dir.z * CAM.dist + shz);
  camera.lookAt(CAM.tx + shx, CAM.ty, CAM.tz + shz);
}
let composer = null, bloomPass = null;
function buildPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (Q.bloom) { bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.28, 0.7, 0.86); composer.addPass(bloomPass); }
}
buildPost();
// HOOK: VFX builder — extend buildPost() with additional passes (keep mobile tier clean).
VFX.post(composer, bloomPass);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  composer.setSize(innerWidth, innerHeight);
  // Headless capture fires a late resize; setSize clears the canvas, so in shot
  // mode we must re-render immediately or the screenshot is black. Do not remove.
  if (SHOT) render(vt());
});

// ── Input: tap select / drag pan / pinch+wheel zoom ──
// Input stays off in SHOT mode (deterministic captures need no interaction). NOTE: any
// handler that resizes/clears the canvas must re-render in shot mode — see the resize
// listener above. Builders: keep new interaction listeners inside this guard.
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const pointers = new Map();
let pinchD = 0, dragging = false, downX = 0, downY = 0;
// Coarse pointers get the drag-ghost + confirm-button flow; a mouse places on click.
// (&coarse=1 lets the harness shoot the touch variant.)
UI.coarse = SHOT ? P.has('coarse') : matchMedia('(pointer: coarse)').matches;
let hoverX = innerWidth / 2, hoverY = innerHeight / 2;
// Screen → ground. Bisecting the heightfield beats raycasting the terrain mesh: the mesh
// is edge-trimmed (a cursor past the rim would miss entirely) and it is 50k triangles.
const _gh = new THREE.Vector3();
function groundAt(cx, cy, out) {
  ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y > -0.02) return false;                       // looking at or above the horizon
  const f = t => (o.y + d.y * t) - G.groundY(o.x + d.x * t, o.z + d.z * t);
  let tA = Math.max(0, (16 - o.y) / d.y), tB = (-40 - o.y) / d.y;
  if (f(tA) < 0) tA = 0;
  for (let i = 0; i < 26; i++) { const tm = (tA + tB) * 0.5; if (f(tm) > 0) tA = tm; else tB = tm; }
  const t = (tA + tB) * 0.5;
  out.set(o.x + d.x * t, 0, o.z + d.z * t);
  return true;
}
function placeAtScreen(cx, cy) { if (groundAt(cx, cy, _gh)) G.setPlaceAt(_gh.x, _gh.z); }
// UI's build cards and the 1-4 hotkeys arm placement without knowing about the camera.
G.placeAtCursor = () => placeAtScreen(hoverX, hoverY);
if (!SHOT) {
canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { const p = [...pointers.values()]; pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
  dragging = false; downX = e.clientX; downY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
$('placeOk').addEventListener('click', () => G.commitPlace(false));
$('placeNo').addEventListener('click', () => G.exitPlace());
canvas.addEventListener('contextmenu', e => { e.preventDefault(); G.exitPlace(); });
canvas.addEventListener('pointermove', e => {
  hoverX = e.clientX; hoverY = e.clientY;
  const p = pointers.get(e.pointerId);
  // desktop: the ghost tracks the bare cursor (no button held, nothing being dragged)
  if (!p && G.place && !UI.coarse) placeAtScreen(e.clientX, e.clientY);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const pts = [...pointers.values()], d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchD > 0) CAM.dist = clamp(CAM.dist * pinchD / d, 42, 120);
    pinchD = d;
    dragging = true;
  } else if (pointers.size === 1) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) dragging = true;
    if (dragging) {
      const k = CAM.dist / innerHeight * 1.35;
      CAM.tx = clamp(CAM.tx - (dx * 0.74 + dy * 0.4) * k, -70, 70);
      CAM.tz = clamp(CAM.tz - (dy * 1.05 - dx * 0.35) * k, -48, 46);
    }
  }
});
const endPointer = e => {
  pointers.delete(e.pointerId); pinchD = 0;
  if (dragging || e.type === 'pointercancel') return;
  if (state.phase === 'title' || state.phase === 'won' || state.phase === 'lost') return;
  if (G.place) {                                       // placement mode owns the tap
    placeAtScreen(e.clientX, e.clientY);
    if (!UI.coarse) G.commitPlace(e.shiftKey);         // touch: confirm with the ✓ button
    return;
  }
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(G.towersList.map(t => t.group), true)[0];
  if (!hit) { UI.deselect(); Audio.play('ui'); return; }
  let o = hit.object;
  while (o && o.parent !== scene) o = o.parent;
  state.selTower = G.towersList.findIndex(t => t.group === o);
  UI.buildMenu();
  Audio.play('ui');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => { e.preventDefault(); CAM.dist = clamp(CAM.dist * (e.deltaY > 0 ? 1.08 : 0.93), 42, 120); }, { passive: false });
addEventListener('keydown', e => {
  if (e.key === ' ') $('btnPause').click();
  if (e.key === 'Escape') { if (G.place) G.exitPlace(); else UI.deselect(); }
  // SPEC3 §F — T cycles the selected tower's targeting doctrine.
  if ((e.key === 't' || e.key === 'T') && state.selTower >= 0) G.cycleMode(G.towersList[state.selTower]);
  // SPEC3 §D — 8/9/0 take the omen on the table. They sit past the seven build hotkeys on
  // purpose: the number row reads left-to-right as "what you build" then "what you accept".
  const oi = { '8': 0, '9': 1, '0': 2 }[e.key];
  if (oi !== undefined) { if (state.phase === 'prewave') G.omens.pick(oi); return; }
  const keys = Object.keys(TOWER_DEFS), n = parseInt(e.key);
  if (n >= 1 && n <= keys.length) {                    // hotkeys ARM the hammer
    UI.deselect();
    if (G.enterPlace(keys[n - 1])) G.placeAtCursor();
  }
});
} // end !SHOT input guard

// ── Render loop ──
const statsEl = $('stats');
if (P.get('stats')) statsEl.classList.remove('hidden');
let acc = 0, last = performance.now(), fpsT = 0, fpsN = 0;
function render(rt) {
  renderer.info.reset();
  Armies.syncVisuals(vt());
  Towers.syncProjectiles(vt());
  VFX.update(vt());
  updateCamera(rt);
  UI.frame(rt);   // HOOK: UI — count-up counters, projected damage floaters, title drift (self-freezes in SHOT mode)
  composer.render();
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now - last) / 1000); last = now;
  if (!state.paused && (state.phase === 'wave' || state.phase === 'prewave')) {
    acc += dt * state.speed;
    let steps = 0;
    while (acc >= TICK && steps++ < 8) { tickSim(); acc -= TICK; }
  }
  G.subT = acc / TICK;   // HOOK: ARMIES — sub-tick fraction so the 30 tps sim renders smooth at 60 fps
  render(now / 1000);
  if (statsEl && !statsEl.classList.contains('hidden')) {
    fpsN++; fpsT += dt;
    if (fpsT >= 0.5) { statsEl.textContent = Math.round(fpsN / fpsT) + ' fps · ' + renderer.info.render.calls + ' calls · ' + renderer.info.render.triangles + ' tris'; fpsN = 0; fpsT = 0; }
  }
}

// ── SHOT HARNESS (sacred — deterministic screenshots for the critic pipeline) ──
// Composes an asset rig around the fight it is meant to show: look at the midpoint of
// tower→its current target, stand off perpendicular to that line so neither subject is
// behind the camera. `side` picks which flank; `h` is the camera height above the pad.
function frameFight(cam, tw, h, side) {
  const rr = TOWER_DEFS[tw.type].range * (1 + 0.08 * (tw.level - 1));
  let bd = -1, tx = tw.x, tz = tw.z;
  for (const e of G.enemies) {
    if (!e.alive) continue;
    const q = (e.px - tw.x) ** 2 + (e.pz - tw.z) ** 2;
    if (q <= rr * rr && e.d > bd) { bd = e.d; tx = e.px; tz = e.pz; }
  }
  if (bd < 0) {                                        // nothing in range: aim down the road
    tx = tw.x + Math.sin(tw._base) * rr; tz = tw.z + Math.cos(tw._base) * rr;
  }
  const mx = (tw.x + tx) / 2, mz = (tw.z + tz) / 2;
  let dx = tx - tw.x, dz = tz - tw.z;
  const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const D = 15 + L * 0.55;
  cam.look = [mx, G.groundY(mx, mz) + 3.2, mz];
  cam.pos = [mx - dz * side * D, G.groundY(mx, mz) + h + 6, mz + dx * side * D];
  // opt-in: `&dbg=1` prints the framing it chose, so a rig that lands in a tree canopy
  // can be re-pointed by hand (that is how _pyre's fixed camera was picked)
  if (P.has('dbg')) console.log('CAMFRAME ' + tw.type + ' pos=' + cam.pos.map(v => v.toFixed(1)) + ' look=' + cam.look.map(v => v.toFixed(1)));
}
const SHOT_PRESETS = {
  // WORLD: yawed off the orbit rig onto an explicit pose. The old framing put the road's
  // two arms straight out of frame left and right and cropped the keep against the edge;
  // this bearing lays the whole S on the frame diagonal — keep low-left, spawn gate
  // high-right — which is the single compositional line the reference sells on.
  overview: { t: 2,   builds: [], cam: { pos: [-47, 139, 110], look: [-27, 4, 6] } },
  // TOWERS: +0.9s puts an arrow in flight. AUDIO/POLISH: the hero frame used to sit the
  // horde in the top-right eighth with half the frame empty meadow; pulled in and onto the
  // column so the crimson river is the subject, which is the whole point of the reference.
  // ARMIES r7 retimed this to t=345 because "the formation lattice shifted every wave
  // boundary and t=262 landed on an empty road". The lattice was reverted as a balance
  // regression (see spawnEnemy), which voids that reason — and t=262 now measures wave 4,
  // ~100 alive, i.e. a full road. Restored to the tuned moment BALANCE.md anchors on.
  // ARMIES' composition work is kept: its own build list, because STD_BUILDS' barracks sits
  // behind the lens, so this frame — the one marketing frame that is supposed to sell
  // red-vs-blue — never contained a single blue defender.
  // Hand-pointed, not auto-framed: an auto-framer that stands off the road's near verge at
  // battle range lands inside the conifer belt about half the time (see _pyre for the same
  // lesson). Pulled in and shifted along the bearing so the column runs the frame's left
  // diagonal, with the up-road barracks camp and its knights in the lower-left third —
  // clear of the build panel, which is where the old pose buried them.
  battle:   { t: 262, builds: 'battle', cam: { pos: [16, 31, 26], look: [36, -1, -16] } },
  // ARMIES: re-aimed at the road bend so the closeup frame actually contains the horde.
  // WORLD: the hand-placed pose sat the lens inside the conifer belt — one tree owned 45%
  // of the frame and there was no subject at all. It now frames itself off the horde's own
  // front rank, standing just off the verge ahead of the column and looking back down it.
  closeup:  { t: 262, bare: true, builds: 'std', cam: { pos: [58, 13, 26], look: [32, 2, 2] },
    fx: () => {
      let bd = 0;
      for (const e of G.enemies) if (e.alive && e.d > bd) bd = e.d;
      const d = Math.max(12, bd - 2), ZM = 21;
      G.pathPos(d, _v3);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(d);
      const c = SHOT_PRESETS.closeup.cam;
      c.look = [mx - tn.x * 5, gy + 2.1, mz - tn.z * 5];
      c.pos = [mx + tn.x * ZM * 0.70 + tn.z * ZM * 0.58, gy + ZM * 0.40,
               mz + tn.z * ZM * 0.70 - tn.x * ZM * 0.58];
    } },
  // VFX: the blast used to fire at a fixed spot on the road that the horde had long
  // since marched past, and it landed half off the bottom edge. It now lands INSIDE the
  // column and retargets its own camera — pre.fx() runs before runShot applies pre.cam,
  // so writing cam.tgt in place is enough, and the horde position is deterministic.
  impact:   { t: 265, builds: 'std', cam: { tgt: [18, 1, 8], dist: 41 },
    fx: () => {
      let bd = -1;
      for (const e of G.enemies) if (e.alive && e.d > bd) bd = e.d;
      G.pathPos(Math.max(8, bd - 7), _v3);
      VFX.explosion(_v3.x, 0, _v3.z, 1.5);
      const c = SHOT_PRESETS.impact.cam; c.tgt[0] = _v3.x; c.tgt[2] = _v3.z;
    } },
  ui:       { t: 40,  builds: [[32, -31, 'archer', 1], [16, -3, 'archer', 1]], cam: { tgt: [4, 2, 6], dist: 96 }, ui: () => { state.selTower = 1; UI.buildMenu(); } },
  title:    { t: 0,   builds: [], cam: { tgt: [-2, 4, -18], dist: 158 }, title: true },
  _keep:   { t: 40,  bare: true, builds: [], cam: { pos: [-54, 34, 50], look: [-95, 7, 21] } },
  // VFX inspection rig. A lone L3 barracks near the spawn end is the only way to see a
  // melee scrum at all: in STD_BUILDS the towers kill the horde around d=85, well short
  // of the barracks rally point, so clash sparks and knight deaths never occur there.
  _vfx:    { t: 232, bare: true, builds: [[50, 3, 'barracks', 3]], cam: { tgt: [50, 1, 3], dist: 21 },
    // SPEC2 §D: the scrum rig now also has to prove the new melee. An ogre is handed to a
    // knight and armed to stomp, two marauders are dropped just inside their 7u band, and
    // the sim is run on for ~0.9 s so the engagement (and the stomp) is the real thing
    // rather than a pose — the frame must show dust, a shake and arrows landing.
    fx: () => {
      const kn0 = G.knights.find(k => k.alive);
      if (kn0) {
        let bd = 0, best = 1e9;
        for (let d = 0; d < PT.len; d += 1) { G.pathPos(d, _v3); const q = (_v3.x - kn0.hx) ** 2 + (_v3.z - kn0.hz) ** 2; if (q < best) { best = q; bd = d; } }
        const put = (ty, dd, ln) => {
          spawnEnemy(ty);
          const e = G.enemies[G.enemies.length - 1];
          e.d = dd; e.lane = ln; G.pathPos(dd, _v3, ln); e.px = _v3.x; e.pz = _v3.z;
          return e;
        };
        const ki = G.knights.indexOf(kn0);
        for (const e2 of G.enemies) if (e2.blockedBy === ki) e2.blockedBy = -1;
        const og = put('ogre', bd - 0.8, 0.5);
        og.blockedBy = ki; kn0.target = og.id; og.stompT = 0.5;
        put('marauder', bd - 5.4, -2.0); put('marauder', bd - 6.1, 1.8);
        // the other two knights must be BUSY, or they simply walk out and claim the
        // marauders — a claimed skirmisher fights instead of shooting, which is the exact
        // behaviour this frame exists to show off. Give each a grunt it cannot finish.
        for (let i = 0; i < G.knights.length; i++) {
          const k2 = G.knights[i];
          if (!k2.alive || i === ki) continue;
          for (const e3 of G.enemies) if (e3.blockedBy === i) e3.blockedBy = -1;
          let bq = 1e9, pick = null;
          for (const e2 of G.enemies)                     // an UNCLAIMED grunt, or two knights
            if (e2.alive && e2.type === 'grunt' && e2.blockedBy < 0) {   // fight over one and
              const q = (e2.px - k2.hx) ** 2 + (e2.pz - k2.hz) ** 2;     // the loser grabs a
              if (q < bq) { bq = q; pick = e2; }                          // marauder instead
            }
          if (!pick) continue;
          pick.blockedBy = i; k2.target = pick.id; pick.hp = pick.maxhp = 400;
        }
        for (let i = 0; i < 26; i++) tickSim();
        const c2 = SHOT_PRESETS._vfx.cam; c2.tgt[0] = og.px; c2.tgt[2] = og.pz; return;
      }
      const kn = G.knights.find(k => k.alive && k.target >= 0) || G.knights[0];
      if (kn) { const c = SHOT_PRESETS._vfx.cam; c.tgt[0] = kn.x; c.tgt[2] = kn.z; } } },
  // SPEC2 §D bestiary rig: one of each new type on a clear stretch of road, walking, at
  // asset-inspection range. Silhouettes must be tellable apart with the colour stripped
  // out — that is the only test this frame exists to fail.
  _bestiary: { t: 8, bare: true, builds: [], cam: { pos: [0, 0, 0], look: [0, 0, 0] },
    fx: () => {
      // SPEC3 §B raises the line-up to the whole nine-strong non-boss roster, ordered by
      // MASS so neighbouring silhouettes are never the same height — nine units that all
      // read alike is the failure this frame exists to catch, and it can only be judged
      // when the biggest and the smallest are not sorted into two separate halves.
      const kinds = ['ogre', 'shield', 'ram', 'marauder', 'ironclad', 'hound',
                     'frostrevenant', 'ashwraith', 'warshaman'];
      const D0 = 44, GAP = 2.85;
      for (let i = 0; i < kinds.length; i++) {
        spawnEnemy(kinds[i]);
        const e = G.enemies[G.enemies.length - 1];
        e.d = D0 + i * GAP; e.lane = (i & 1 ? 2.0 : -2.0);
        G.pathPos(e.d, _v3, e.lane); e.px = _v3.x; e.pz = _v3.z;
        e.hp = e.maxhp * (0.44 + (i % 5) * 0.12);      // every new type must grow a health bar
      }
      const dm = D0 + (P.has('bi') ? +P.get('bi') : (kinds.length - 1) / 2) * GAP;   // "&bi=0" frames one subject
      G.pathPos(dm, _v3);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(dm);
      const c = SHOT_PRESETS._bestiary.cam;
      const ZM = +(P.get('zm') || 21);                 // -Extra "&zm=7" for a tight critic pass
      // stand off the road on the near flank AND a little down-road, so the line-up walks
      // toward the lens: a bestiary shot from behind proves nothing about a silhouette.
      c.look = [mx, gy + 1.5, mz];
      c.pos = [mx - tn.z * ZM + tn.x * ZM * 0.42, gy + ZM * 0.44, mz + tn.x * ZM + tn.z * ZM * 0.42];
    },
    // The active map's wave table never fields all nine at once, so the live card would
    // never draw the whole set of busts. Re-cut the preview row by hand: this frame is
    // therefore also the proof that enemyIcon()/E_NAME cover the roster of 13.
    post: () => {
      const row = document.querySelector('#wavePrev .wpRow'), ttl = document.querySelector('#wavePrev .wpT');
      if (!row) return;
      row.innerHTML = '';
      for (const [t, c] of [['ironclad', 4], ['ram', 1], ['ashwraith', 12], ['frostrevenant', 8],
                            ['warshaman', 4], ['ogre', 1]])
        row.appendChild(UI.bust(t, c));      // UI-2: same builder as the live card, resist pips and all
      // "Bestiary — The Siege Ram incoming" overran the card's 322 px (which now ellipses
      // rather than bleeding, but an elided hero frame is still a bad hero frame).
      if (ttl) ttl.innerHTML = 'Bestiary <em>—</em> the roster';
    } },
  _spawn:  { t: 40,  bare: true, builds: [], cam: { pos: [52, 34, 4], look: [86, 8, -52] } },
  // ══ VFX/AUDIO-3 inspection rigs (not in the default suite) ═══════════════════
  // `_elem` — the element wheel as a LINE-UP: the same blow landing on a body that takes
  // it and on a body that does not, four schools in a row, so the two readings can be
  // compared inside one frame rather than across two runs. Left to right:
  //   pierce → brute (the pale spark baseline) · frost revenant (.6 — it skitters off)
  //   crush  → ironclad (−.25 — chips fly)     · ram (.8 — a dull nothing)
  //   fire   → brute (ember burst)             · ash wraith (.85 — the embers deflect, cold)
  //   storm  → brute (violet crack)            · ironclad (.85 — the arc earths itself)
  // The storm pair deliberately goes through VFX.zapHit, not VFX.hit, because the deferral
  // from the strike to the deflection path is the thing being proven.
  _elem: { t: 8, bare: true, builds: [], cam: { pos: [0, 0, 0], look: [0, 0, 0] },
    fx: () => {
      // The ram sits LAST: at 1.6 scale on a 3.6 u pitch it eclipses whatever stands behind it.
      const PAIRS = [['brute', 'pierce'], ['frostrevenant', 'pierce'], ['ironclad', 'crush'],
                     ['brute', 'fire'], ['ashwraith', 'fire'], ['brute', 'storm'],
                     ['ironclad', 'storm'], ['ram', 'crush']];
      const D0 = 44, GAP = 3.6, hit = [];
      PAIRS.forEach(([ty, el], i) => {
        spawnEnemy(ty);
        const e = G.enemies[G.enemies.length - 1];
        e.d = D0 + i * GAP; e.lane = (i & 1 ? 1.9 : -1.9);
        G.pathPos(e.d, _v3, e.lane); e.px = _v3.x; e.pz = _v3.z;
        e.hp = e.maxhp * 0.66;
        hit.push([e, el]);
      });
      for (const [e, el] of hit) {
        const gy = G.groundY(e.px, e.pz), ey = gy + e.def.scale * 0.85;
        if (el === 'storm') VFX.zapHit(e.px, ey, e.pz, 0, e);
        else VFX.hit(e.px, ey - gy, e.pz, el, 1.0, e);
      }
      // ...then let a fifth of a second pass. Every effect in this section is a closed form
      // of its AGE, so a rig that fires at the render's own virtual time catches all eight
      // of them on their birth frame — every spark still at the muzzle, every ring at radius
      // zero. Three ticks puts all eight between a fifth and four fifths of their own life,
      // which is the only window where a hit and a shrug can be compared side by side.
      for (let i = 0; i < 3; i++) tickSim();
      const dm = D0 + (P.has('bi') ? +P.get('bi') : (PAIRS.length - 1) / 2) * GAP;
      G.pathPos(dm, _v3);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(dm);
      // 15 held six of the eight pairs; the line is 8 × 3.6 u wide and the ram on the end
      // was cropped, which defeats a rig whose whole point is the side-by-side comparison.
      const c = SHOT_PRESETS._elem.cam, ZM = +(P.get('zm') || 22);
      c.look = [mx, gy + 1.4, mz];
      c.pos = [mx - tn.z * ZM + tn.x * ZM * 0.42, gy + ZM * 0.42, mz + tn.x * ZM + tn.z * ZM * 0.42];
    } },
  // `_aura` — the three CONTINUOUS presences (SPEC3 §B), which no single-frame effect rig
  // can show: the war shaman mid-chant with his ring lit and motes coming off the staff, a
  // file of ash wraiths dragging their shroud, and the ram grinding dust off both axles.
  // Staged then SIMULATED for a second and a half, because all three are emitted per sim
  // tick — a rig that only stages them would prove nothing.
  _aura: { t: 8, bare: true, builds: [], cam: { pos: [0, 0, 0], look: [0, 0, 0] },
    fx: () => {
      const D0 = 44;
      const put = (ty, dd, ln, hf) => {
        spawnEnemy(ty);
        const e = G.enemies[G.enemies.length - 1];
        e.d = dd; e.lane = ln; G.pathPos(dd, _v3, ln); e.px = _v3.x; e.pz = _v3.z;
        if (hf) e.hp = e.maxhp * hf;
        return e;
      };
      put('warshaman', D0, 0);
      for (let i = 0; i < 8; i++)                       // wounded ranks for him to mend
        put(i & 1 ? 'grunt' : 'brute', D0 - 4 + (i % 4) * 2.6, (i < 4 ? -3.1 : 3.1), 0.34);
      for (let i = 0; i < 4; i++) put('ashwraith', D0 + 8 + i * 2.4, i & 1 ? 1.7 : -1.7, 0.8);
      put('ram', D0 - 9, 0, 0.85);
      for (let i = 0; i < 45; i++) tickSim();           // let the chant, the trail and the dust exist
      G.pathPos(D0, _v3);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(D0);
      const c = SHOT_PRESETS._aura.cam, ZM = +(P.get('zm') || 17);
      c.look = [mx, gy + 1.2, mz];
      c.pos = [mx - tn.z * ZM + tn.x * ZM * 0.85, gy + ZM * 0.46, mz + tn.x * ZM + tn.z * ZM * 0.85];
    } },
  // `_wardfx` — the Elemental Ward shimmer at GAMEPLAY zoom. `_ward` frames the banner, and
  // at that framing the horde is a red smear at the top of the shot; the tint pulse lives on
  // the bodies, so it needs its own rig. Same staging as `_ward`, then the column is walked
  // down the road and the lens put on it.
  _wardfx: { t: 2, bare: true, builds: [], cam: { pos: [0, 0, 0], look: [0, 0, 0] },
    fx: () => {
      state.wave = OMEN_FROM - 1; state.phase = 'prewave'; state.countdown = 9;
      omenTick();
      G.omens.offer[0] = 'ward'; G.omens.pick(0);
      G.dmgBySchool[P.get('sch') && G.SCHOOLS.indexOf(P.get('sch')) >= 0 ? P.get('sch') : 'pierce'] += 4000;
      startWave(OMEN_FROM);
      for (let i = 0; i < 900; i++) tickSim();          // walk the warded column into frame
      // Frame the MASS, not the van: the hounds run twenty units ahead of everything else
      // and a shimmer on four dogs proves nothing. `&sch=` forces the warded school.
      let bd = 0;
      for (const e of G.enemies) if (e.alive && e.d > bd) bd = e.d;
      const df = Math.max(12, bd - 24);
      G.pathPos(df, _v3);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(df);
      const c = SHOT_PRESETS._wardfx.cam, ZM = +(P.get('zm') || 24);
      c.look = [mx - tn.x * 4, gy + 1.6, mz - tn.z * 4];
      c.pos = [mx + tn.x * ZM * 0.62 + tn.z * ZM * 0.62, gy + ZM * 0.40,
               mz + tn.z * ZM * 0.62 - tn.x * ZM * 0.62];
    } },
  // ══ SPEC3 §D omen rigs. Both are STAGED rather than simulated: reaching the wave-5
  // muster honestly costs ~500 sim seconds, and the frame is about the CARDS, not about
  // how the horde got there. The engine does all the work — the preset only moves the
  // clock to a wave-5 prewave and lets omenTick() deal the hand it would really deal.
  _omens:  { t: 2, builds: 'std', cam: { pos: [16, 31, 26], look: [36, -1, -16] },
    fx: () => { state.wave = OMEN_FROM - 1; state.phase = 'prewave'; state.countdown = 9; state.gold = 260;
      // A phys-leaning ledger so Elemental Ward, if the seed deals it, names a real school
      // instead of the alphabetical fallback — the card's copy is run-dependent by design.
      dmgBySchool.pierce += 1400; dmgBySchool.crush += 300;
      omenTick();
      // The rig also has to stage the CHOICE having been made: half the frame's job is the
      // taken state (gold ring, Taken ribbon, "omen taken" in the dispatch), which no honest
      // sim would reach inside two seconds. `&om=` picks a different card for comparison.
      if (P.get('om') !== 'open') Omens.pick(Math.min(2, Math.max(0, +(P.get('om') || 1)))); } },
  // the same wave, one tick later: the omen taken, the wave running, the banner up. Which
  // omen it is depends only on the seed, so this frame is stable.
  _ward:   { t: 2, builds: 'std', cam: { pos: [16, 31, 26], look: [36, -1, -16] },
    fx: () => { state.wave = OMEN_FROM - 1; state.phase = 'prewave'; state.countdown = 9;
      omenTick();
      // Elemental Ward is the one omen with a read-out of its own (the school it wards
      // against), so this rig forces it whether or not the seed dealt it.
      G.omens.offer[0] = 'ward'; G.omens.pick(0);
      G.dmgBySchool.pierce += 1000;                      // a phys-leaning run, so the ward bites
      startWave(OMEN_FROM);
      for (let i = 0; i < 300; i++) tickSim(); } },
  // ══ SPEC2 §E map presets. CORE's SHOT_MAPS binds these names to their map, so
  // `-Shots battle2` needs no -Extra; `&map=` still overrides for cross-checks.
  overview2: { t: 2, builds: [], cam: { tgt: [-2, 4, -6], dist: 158 } },
  // Finale inspection rig: puts the ACTIVE map's last-wave boss line-up on the road at
  // asset range. `-Shots _finale -Extra "&map=2"` is the proof that a palette/scale variant
  // renders, carries a health bar and gets its own name in the wave copy.
  _finale: { t: 8, bare: true, builds: [], cam: { pos: [0, 0, 0], look: [0, 0, 0] },
    fx: () => {
      const last = WAVES[WAVES.length - 1].filter(g => (ENEMY_DEFS[g[0]] || {}).art === 'boss' || g[0] === 'boss');
      const D0 = 52;
      last.forEach((g, i) => {
        spawnEnemy(g[0], 0);
        const e = G.enemies[G.enemies.length - 1];
        e.d = D0 + i * 7; e.lane = i & 1 ? 1.6 : -1.6;
        G.pathPos(e.d, _v3, e.lane, 0); e.px = _v3.x; e.pz = _v3.z;
        e.hp = e.maxhp * 0.62;
      });
      // ARMIES r7: he used to stand alone on an empty road, so his mass read as nothing —
      // a boss is only "huge" next to something man-sized. Give him a column of chaff at his
      // heels and a knight line in front of him, all real units on the real road.
      const chaff = [['grunt', 16, 1], ['shield', 5, 2], ['brute', 3, 3]];
      let ci = 0;
      for (const [ty, n, sp] of chaff) for (let i = 0; i < n; i++, ci++) {
        spawnEnemy(ty, 0);
        const e2 = G.enemies[G.enemies.length - 1];
        e2.d = D0 - 3.5 - (i * sp * 0.9) - (ci % 3) * 0.6;
        e2.lane = G.laneOf(ci * 5 + 2, ((ci * 37) % 11) / 11);
        G.pathPos(e2.d, _v3, e2.lane, 0); e2.px = _v3.x; e2.pz = _v3.z;
      }
      { // a barracks just off the verge ahead of him: its knights rally onto the road and
        // give the frame the red-vs-blue scale comparison the whole shot exists to prove
        G.pathPos(D0 + 7, _v3, 0, 0);
        const tn2 = G.pathTan(D0 + 7, 0);
        for (const sgn of [-1, 1]) {
          const bx = _v3.x - tn2.z * 6.2 * sgn, bz = _v3.z + tn2.x * 6.2 * sgn;
          if (G.canPlace(bx, bz).ok && G.placeTower(bx, bz, 'barracks', 3, true)) break;
        }
        for (let i = 0; i < 40; i++) tickSim();          // let the knights walk to their rally
      }
      const dm = D0 + (last.length - 1) * 3.5;
      G.pathPos(dm, _v3, 0, 0);
      const mx = _v3.x, mz = _v3.z, gy = G.groundY(mx, mz), tn = G.pathTan(dm, 0);
      const c = SHOT_PRESETS._finale.cam, ZM = +(P.get('zm') || 20);
      c.look = [mx, gy + 2.6, mz];
      c.pos = [mx - tn.z * ZM + tn.x * ZM * 0.5, gy + ZM * 0.55, mz + tn.x * ZM + tn.z * ZM * 0.5];
    } },
  overview3: { t: 2, builds: [], cam: { tgt: [-2, 4, -4], dist: 158 } },
  // Frostfell's hero frame is the FORK: stand west of the junction and both columns march
  // into the lens at once, which is the one thing this map has that the Vale does not.
  // Hand-pointed rather than auto-framed: on Frostfell the fight happens on BOTH approach
  // roads at once, east of the junction, and the orbit camera can only ever look west.
  // ROSTER retime 620 -> 760: SPEC3 §B puts a siege ram in Frostfell's wave 7, and a
  // 2500-hit-point crush-proof machine holds that wave open for a further eighty seconds.
  // At 620 the hero frame was one surviving unit on an empty road; 760 lands mid wave 8
  // with ~120 on both approaches, which is what this shot exists to show.
  battle2:  { t: 760, builds: 'm2', cam: { pos: [-18, 44, 46], look: [38, 2, 4] } },
  // Ember's hero frame is the FORK, with the tower island in the near field and a column on
  // each arm. Hand-pointed, because the auto-framer it used to run (hordeFrame) aimed the
  // orbit rig at the median of the "engaged" horde — which on this map is the tail still
  // pouring out of the gate 60 u up the ramp. The camera ended up outside the rim shooting a
  // boulder field with the fight as a smear on the edge, so the framer is deleted rather
  // than patched (same lesson as battle/battle2/_pyre: hand-point the hero frames).
  // RETIMED 900 → 940, measured rather than guessed: Ember's approach is a serpentine ramp
  // and the wave walks it as one long file. At 900 all 113 alive are still ON the ramp
  // (x 37→96) and nothing has reached the fork; by 980 the wave is dead. 940 is the one
  // window where the whole survivorship — 75 of them — is through the fork and inside the
  // battery's reach, which is the only moment this map's geometry is legible in one frame.
  battle3:  { t: 940, builds: 'm3', cam: { pos: [-16, 42, 40], look: [26, 1, -26] } },
  // TOWERS asset-inspection rigs (not in the default suite; see tools\shots.ps1 -Shots)
  _arch1:  { t: 8, bare: true, builds: [[2, 20, 'archer', 1]],   cam: { pos: [13, 12, 32], look: [2, 4.5, 20] } },
  _arch3:  { t: 8, bare: true, builds: [[2, 20, 'archer', 3]],   cam: { pos: [13, 12, 32], look: [2, 5.5, 20] } },
  _ball1:  { t: 8, bare: true, builds: [[26, 21, 'ballista', 1]], cam: { pos: [36, 11, 32] , look: [26, 3.0, 21] } },
  _ball3:  { t: 8, bare: true, builds: [[26, 21, 'ballista', 3]], cam: { pos: [36, 11, 32] , look: [26, 3.5, 21] } },
  _cat1:   { t: 8, bare: true, builds: [[-21, 25, 'catapult', 1]], cam: { pos: [-11, 11, 36], look: [-21, 3.0, 25] } },
  _cat3:   { t: 8, bare: true, builds: [[-21, 25, 'catapult', 3]], cam: { pos: [-11, 11, 36], look: [-21, 3.5, 25] } },
  _barr1:  { t: 8, bare: true, builds: [[-40, 4, 'barracks', 1]], cam: { pos: [-30, 12, 15], look: [-40, 2.0, 4] } },
  _barr3:  { t: 8, bare: true, builds: [[-40, 4, 'barracks', 3]], cam: { pos: [-30, 12, 15], look: [-40, 2.5, 4] } },
  // TOWERS-2 rigs (SPEC2 §C). A lone tower cannot hold the road for 230 s, so each rig
  // pairs its subject with the proven L3 barracks at 50,3: the horde piles into those
  // knights and the new tower fights over a real scrum instead of empty meadow.
  // `fx` fires the subject on the spot — chain lightning lives 60-90 ms, so waiting for
  // the sim to happen to end mid-arc would be a one-in-twenty shot.
  _storm:  { t: 230, bare: true, builds: [[50, 3, 'barracks', 3], [45, -2, 'storm', 3]],
    cam: { pos: [34, 14, -14], look: [46, 6, -1] },
    fx: () => { const tw = G.towersList.find(t => t.type === 'storm');
      if (tw) { tw.cdT = 0; G.fireTower(tw); frameFight(SHOT_PRESETS._storm.cam, tw, 9, -1); } } },
  // the pyre rig fires a pot, runs the sim on until it lands and lights the ground, then
  // lobs a second one — so the frame carries the whole loop: davit, pot in the air, fire
  // hand-framed: the auto-framer put this one inside a canopy (the tree line hugs the
  // road on the pyre's east flank), so the camera stands off to the west like _storm
  _pyre:   { t: 230, bare: true, builds: [[50, 3, 'barracks', 3], [45, -2, 'pyre', 3]],
    cam: { pos: [34, 13.9, 16.6], look: [39.8, 2.1, -3.5] },
    // STAGED, like _win/_lose: where the horde's front happens to be at t=230 depends on
    // every kill that came before it, so waiting for a lob to line itself up is a coin
    // toss. The rig lays a burning patch on the road in front of the tower and puts a
    // second pot mid-arc above it — the real code paths, at a chosen moment.
    fx: () => {
      const py = G.towersList.find(t => t.type === 'pyre');
      if (!py) return;
      const P = TOWER_DEFS.pyre.patch;
      const bx = py.x + Math.sin(py._base) * 6.4, bz = py.z + Math.cos(py._base) * 6.4;
      G.patches.push({ x: bx, z: bz, r: P.rad, dur: P.dur, born: G.vt() - 1.1, owner: py.uid,
        dps: P.dps * Math.pow(1.55, py.level - 1) });
      VFX.firePatch(bx, bz, P.rad);
      const ex = py.x + Math.sin(py._base) * 8.6, ez = py.z + Math.cos(py._base) * 8.6;
      G.projectiles.push({ kind: 'pot', x: py.x, y: 4, z: py.z, sx: py.x, sy: 4, sz: py.z,
        ex, ez, T: 1.25, el: 0, dmg: 0, tw: py, element: 'fire' });
      Towers.fire(py, { px: ex, pz: ez, def: ENEMY_DEFS.grunt });
      const p = G.projectiles[G.projectiles.length - 1], f = 0.55;
      p.el = f * p.T;
      p.x = lerp(p.sx, p.ex, f); p.z = lerp(p.sz, p.ez, f);
      p.y = lerp(p.sy, G.groundY(p.ex, p.ez), f) + Math.sin(f * Math.PI) * 8;
    } },
  _banner: { t: 230, bare: true, builds: [[50, 3, 'barracks', 3], [45, -2, 'banner', 3]],
    cam: { pos: [33, 13, -13], look: [45, 6, -2] },
    // VFX-2: the aura pulse is a ONE-SHOT fired when a banner is raised, and preset builds
    // are primed silently (or every staged banner would detonate on frame one). Fire it by
    // hand here so this rig proves the activation as well as the standing glow.
    fx: () => { const b = G.towersList.find(t => t.type === 'banner');
      if (b) VFX.banner(b.x, b.z, TOWER_DEFS.banner.range * (1 + 0.08 * (b.level - 1))); },
    ui: () => { state.selTower = G.towersList.findIndex(t => t.type === 'banner'); UI.buildMenu(); } },
  // VFX-2 burning-ground rig: two patches on open road at asset range, one fresh and one
  // half burnt out, so the flame/smoke/ember dressing and its envelope are both on screen.
  // This is the frame that judges the fire itself, not the tower that threw it.
  _fire:   { t: 40, bare: true, builds: [[45, -2, 'pyre', 3]], cam: { pos: [40, 8.5, 12], look: [50, 1.2, 0] },
    fx: () => {
      const py = G.towersList.find(t => t.type === 'pyre'), P = TOWER_DEFS.pyre.patch;
      if (!py) return;
      for (const [dx, dz, ag] of [[4.6, 1.2, 1.35], [8.2, -2.4, 3.0]]) {
        G.patches.push({ x: py.x + dx, z: py.z + dz, r: P.rad, dur: P.dur, born: G.vt() - ag,
          owner: py.uid, dps: P.dps * Math.pow(1.55, py.level - 1) });
        VFX.firePatch(py.x + dx, py.z + dz, P.rad);
      }
    } },
  // ══ VFX-2 weather rigs (SPEC2 §E). Low cameras: the falling field is a NEAR-FIELD cue
  // and the overview presets deliberately fade it out, so neither of those frames can
  // judge it. `-Shots _snow,_ash` — SHOT_MAPS binds each to its map.
  _snow:   { t: 120, bare: true, builds: [], cam: { pos: [40, 11, 20], look: [10, 2.5, -2] } },
  _ash:    { t: 70, bare: true, builds: [[-12, -6, 'pyre', 3]], cam: { pos: [10, 10, 22], look: [-18, 2.5, -4] },
    // a live patch so the ash frame also carries the burning-ground dressing
    fx: () => { const py = G.towersList.find(t => t.type === 'pyre');
      if (!py) return;
      const P = TOWER_DEFS.pyre.patch;
      G.patches.push({ x: py.x - 3.5, z: py.z + 4.2, r: P.rad, dur: P.dur, born: G.vt() - 1.0, owner: py.uid,
        dps: P.dps * Math.pow(1.55, py.level - 1) });
      VFX.firePatch(py.x - 3.5, py.z + 4.2, P.rad); } },
  // tier-1 line-up of the three new towers: the upgrade stages have to read as stages, so
  // this is the frame to compare against _storm/_pyre/_banner (which are all tier 3)
  _new1:   { t: 8, bare: true, builds: [[22, 18, 'storm', 1], [30, 18, 'pyre', 1], [26, 21, 'banner', 1]],
    cam: { pos: [26, 13, 40], look: [26, 3.5, 19] } },
  _sel:    { t: 40, builds: [[26, 21, 'ballista', 3]], cam: { pos: [38, 16, 36], look: [26, 1, 21] }, ui: () => { state.selTower = 0; UI.buildMenu(); } },
  // garrison panel for the two towers that carry no damage stat at all (SPEC2 §C): the
  // warbanner's panel is built first and the pyre's is left on screen, so one shot walks
  // both of the new stat-row branches and any error in either fails the log.
  _sel2:   { t: 40, builds: [[26, 21, 'pyre', 2], [16, -3, 'banner', 3]], cam: { pos: [38, 16, 36], look: [26, 1, 21] },
    ui: () => { state.selTower = 1; UI.buildMenu(); state.selTower = 0; UI.buildMenu(); } },
  // build bar with nothing selected — the always-available shop (SPEC2 §A)
  _selp:   { t: 40, builds: [], cam: { pos: [38, 16, 36], look: [26, 1, 21] }, ui: () => { UI.buildMenu(); } },
  // placement mode: ghost + footprint plate + range ring on a buildable rise, gold unspent
  _place:  { t: 40, builds: [[16, -3, 'archer', 2]], cam: { tgt: [12, 2, -6], dist: 48 },
    ui: () => { G.enterPlace('ballista'); G.setPlaceAt(8, -8); } },
  // the same frame refused: plate + ring turn red and the writ says why (here: spacing)
  _placeX: { t: 40, builds: [[16, -3, 'archer', 2]], cam: { tgt: [12, 2, -6], dist: 48 },
    ui: () => { G.enterPlace('ballista'); G.setPlaceAt(18, -5); } },
  // bot harness (SPEC2 §F): no free builds — &plan= ops buy with real gold as it accrues
  bot:     { t: 400, builds: [], plan: true, cam: { tgt: [-2, 4, -8], dist: 152 } },
  // POLISH: winnability rig — every plot at tier 3. `-Shots _full -T 1900` must end in
  // phase "won" with lives > 0, which is the standing proof that the campaign is beatable.
  _full:   { t: 900, bare: true, builds: [[32, -31, 'archer', 3], [16, -3, 'ballista', 3], [50, 3, 'archer', 3], [26, 21, 'catapult', 3],
      [2, 20, 'barracks', 3], [-21, 25, 'catapult', 3], [-40, 4, 'ballista', 3], [-58, 17, 'archer', 3]],
    cam: { tgt: [-2, 4, -8], dist: 152 } },
  // UI overlay-inspection rigs (not in the default suite; run with -Shots _win,_lose,_gear).
  // The end screens are unreachable inside a shot's tick budget, so the stats are staged.
  // 29 of 32 lives = 91% → three stars, and the staged record (two) makes it a NEW best,
  // so this one frame carries the star row, the best-ever line and the next-road call.
  _win:    { t: 0, builds: [], cam: { tgt: [-2, 4, -8], dist: 132 },
    ui: () => { UI.setProgress({ 1: 2 });
      // 29 of 32 lives means THREE banners fell — staging leaked:0 alongside it put a
      // contradiction on the plate (a Flawless medal over a "breached the gate: 0" row that
      // the garrison row disagreed with). Consistent staging: 3 stars, no Flawless.
      Object.assign(state, { kills: 1874, leaked: 3, wave: 10, lives: 29, phase: 'won' }); UI.showEnd(true); } },
  _lose:   { t: 0, builds: [], cam: { tgt: [-2, 4, -8], dist: 132 },
    ui: () => { UI.setProgress({ 1: 1 });
      Object.assign(state, { kills: 613, leaked: 21, wave: 7, lives: 0, phase: 'lost' }); UI.showEnd(false); } },
  // SPEC2 §E map select with every state on screen at once: stars already earned on the
  // Vale, Frostfell opened by that win, Ember Wastes still chained. The record is staged in
  // memory — the harness never reads whatever this machine happens to have played.
  // SPEC3 §E: the chooser also carries the war seed + die, because the seed belongs to the
  // RUN and this is the last screen before one starts — this rig is where that chrome is judged.
  _maps:   { t: 0, builds: [], cam: { tgt: [-2, 4, -18], dist: 158 },
    ui: () => { state.phase = 'title'; UI.setProgress({ 1: 2 }); UI.showMaps(); } },
  // tier-1 tower so the upgrade path shows its stat deltas, plus the settings sheet open.
  // SPEC3 §C/§F: it doubles as the rig for the two garrison-side additions — the targeting
  // rail (staged off its default so the lit state is legible) and the full-muster refusal,
  // which is otherwise unreachable in a shot because a preset widens the muster to fit its
  // own composition. One standard, one slot, hammer in hand: the writ has to answer.
  // The five extra standards are what makes the muster FULL at the base 6 without inventing
  // a state real play never reaches (a muster below 6 has no price in MUSTER_COST). They
  // stand well behind the lens, so the frame's subject is still the one archer.
  _gear:   { t: 40, builds: [[26, 21, 'archer', 1], [-58, 17, 'archer', 1], [-40, 4, 'ballista', 1],
      [-21, 25, 'ballista', 1], [2, 20, 'barracks', 1], [16, -3, 'archer', 1]],
    cam: { pos: [38, 16, 36], look: [26, 1, 21] },
    ui: () => { state.selTower = 0;
      G.towersList[0].mode = 'strong';
      UI.buildMenu(); $('settings').classList.remove('hidden'); $('btnGear').classList.add('on');
      UI.place({ type: 'ballista', ok: false, reason: canPlace(26, 6).reason || 'The muster is full' }); } },
};
// [x, z, type, level] since free placement landed. The coordinates are the eight old fixed
// plots, so every shipped frame keeps its composition; levels are literal (see placeTower).
// THREE of the inherited plot coordinates (37,-31 · 30,25 · -24,29) turned out to sit ON the
// road surface — the old plot markers were drawn offset from their anchor, so the raw anchors
// were never buildable ground. They only survived the port because preset builds are `free`
// (validity-gate bypassed), which meant three shipped frames had a tower standing in the
// middle of the highway. Each is nudged to the nearest site G.canPlace() accepts (≈5u, road
// clearance 5.1/5.6/5.4) and the inspection-rig cameras moved by the same delta, so the
// framing is unchanged. See BUILDWARN in runShot: a preset that builds on refused ground now
// says so in the log instead of failing silently.
const STD_BUILDS = [[32, -31, 'archer', 3], [16, -3, 'archer', 1], [50, 3, 'ballista', 1], [26, 21, 'catapult', 1],
  [2, 20, 'barracks', 3], [-21, 25, 'ballista', 2], [-40, 4, 'ballista', 1], [-58, 17, 'archer', 2]];
// The hero frame's own composition: STD_BUILDS plus a second L3 barracks up-road, so the
// reference's head-on clash — blue knights holding against the crimson column — is actually
// IN the frame instead of behind the lens. (Balance presets keep using STD_BUILDS.)
const BATTLE_BUILDS = STD_BUILDS.concat([[35, -12, 'barracks', 3]]);
// Mid-campaign compositions for the new maps. Every coordinate was authored against
// `&scan=1` (see BUILDWARN) and sits on the wedge/verge each map's geometry hands you.
// Frostfell: the wedge between the two approaches, so one battery answers both gates,
// plus a rearguard on the shared tail.
const M2_BUILDS = [[6, -2, 'archer', 3], [2, 0, 'banner', 1], [-6, 0, 'ballista', 3],
  [2, -6, 'catapult', 1], [10, -6, 'barracks', 2], [28, -6, 'archer', 3],
  [20, 6, 'ballista', 2], [36, 6, 'storm', 2]];
// Ember Wastes: the island of ground inside the fork — every tower on it reaches the
// canyon AND the loop, which is the whole reason the fork is shaped that way.
const M3_BUILDS = [[-28, -6, 'ballista', 3], [-20, -6, 'banner', 1], [-12, -6, 'storm', 2],
  [-8, -12, 'archer', 3], [4, -6, 'catapult', 1], [12, -6, 'archer', 2],
  [-40, -12, 'barracks', 2], [28, -12, 'pyre', 1]];
// ── bot harness v2 (SPEC2 §F) ─────────────────────────────────────────
// `&plan=37,-31:archer,up:0` — ops run IN ORDER, each waiting until the purse can pay for
// it out of real bounty income, so a plan is a build ORDER, not a cheat sheet. An op that
// could never work (bad type, refused ground, tower already at tier 3) is skipped with a
// BOTSKIP note so the balance matrix can see it went unbuilt.
// SPEC3 §C/§G adds `muster`: buys one more standard slot when the purse can pay, and holds
// the queue until it can — a plan that wants eight towers must say where the seventh slot
// came from, exactly like a human paying for it.
function parsePlan(str) {
  const ops = [], re = /(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*:\s*([a-z]+)|up\s*:\s*(\d+|\*)|(muster)/gi;
  let m;
  while ((m = re.exec(str))) ops.push(m[5] !== undefined ? { k: 'muster' }
    : m[4] === undefined ? { k: 'place', x: +m[1], z: +m[2], t: m[3].toLowerCase() }
    : m[4] === '*' ? { k: 'upall' } : { k: 'up', i: +m[4] });
  return ops;
}
function botStep(ops, placed) {
  while (ops.length) {
    const op = ops[0], skip = (why) => { console.log('BOTSKIP ' + why); ops.shift(); };
    if (op.k === 'muster') {
      const c = G.musterCost();
      if (c === undefined) { skip('muster — already at the cap'); continue; }
      if (state.gold < c) return;                        // affordable later; hold the order
      G.raiseMuster();
    } else if (op.k === 'place') {
      const def = TOWER_DEFS[op.t];
      if (!def) { skip('unknown tower "' + op.t + '"'); continue; }
      const v = canPlace(op.x, op.z);
      // "the muster is full" is a WAIT, not a refusal: a later `muster` op frees the slot.
      if (!v.ok && v.reason === 'The muster is full') return;
      if (!v.ok) { skip(op.x + ',' + op.z + ':' + op.t + ' — ' + v.reason); continue; }
      if (state.gold < def.cost) return;               // affordable later; hold the order
      placeTower(op.x, op.z, op.t);
      placed.push(G.towersList[G.towersList.length - 1]);
    } else if (op.k === 'upall') {
      // terminal sink op: models a human who keeps upgrading late-game instead of
      // banking gold. Upgrades the oldest under-levelled tower whenever affordable;
      // never shifts off the queue (put it LAST in a plan).
      let did = false;
      for (const tw of placed) {
        if (!tw || tw.level >= 3) continue;
        const cost = Math.round(TOWER_DEFS[tw.type].cost * (tw.level === 1 ? 0.8 : 1.3));
        if (state.gold < cost) continue;
        upgradeTower(tw); did = true; break;
      }
      return; // upall stays queued whether or not it bought something
    } else {
      const tw = placed[op.i];
      if (!tw) { skip('up:' + op.i + ' — no such placed tower'); continue; }
      if (tw.level >= 3) { skip('up:' + op.i + ' — already at tier 3'); continue; }
      const cost = Math.round(TOWER_DEFS[tw.type].cost * (tw.level === 1 ? 0.8 : 1.3));
      if (state.gold < cost) return;
      upgradeTower(tw);
    }
    ops.shift();
  }
}
function runShot(name) {
  const pre = SHOT_PRESETS[name];
  if (!pre) { __err('unknown shot: ' + name); return; }
  // Freeze every CSS transition/animation: any repaint after the final render would
  // recomposite without the (already-presented) GL frame in headless capture.
  const frz = document.createElement('style');
  frz.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(frz);
  if (!pre.title) {
    $('title').classList.add('hidden');
    // QA aid for the balance loop: `&scan=1` prints an ASCII map of buildable ground, so a
    // build plan can be authored against G.canPlace() instead of guessed at.
    if (P.has('scan')) {
      console.log('SCAN x from -84 to 84 step 4   # = buildable');
      for (let z = -54; z <= 54; z += 6) {
        let row = '';
        for (let x = -84; x <= 84; x += 4) row += canPlace(x, z).ok ? '#' : '.';
        console.log('SCAN z=' + String(z).padStart(4) + ' ' + row);
      }
      // per-site read-out for the sites a preset (or a &plan=) actually builds on
      const _sn = new THREE.Vector3();
      for (const [bx, bz] of (P.get('scan') || '').split(';').map(s => s.split(',').map(Number)).filter(a => a.length === 2 && isFinite(a[0]))
        .concat(STD_BUILDS.map(b => [b[0], b[1]]))) {
        G.groundNormal(bx, bz, _sn);
        console.log('SCANP ' + bx + ',' + bz + ' road=' + G.roadSD(bx, bz).toFixed(2) + ' ny=' + _sn.y.toFixed(3) +
          ' -> ' + JSON.stringify(canPlace(bx, bz)));
      }
    }
    const builds = pre.builds === 'std' ? STD_BUILDS : pre.builds === 'battle' ? BATTLE_BUILDS
      : pre.builds === 'm2' ? M2_BUILDS : pre.builds === 'm3' ? M3_BUILDS : pre.builds;
    // A staged composition is a POSE, not a purchase: widen the muster to fit it so the
    // BUILDWARN oracle below still judges the GROUND rather than reporting a full muster
    // eight times (SPEC3 §C). A `plan` preset stages nothing, so the bot still has to buy
    // every slot it uses.
    if (builds.length > state.muster) state.muster = builds.length;
    for (const [bx, bz, ty, lv] of builds) {
      // Preset builds are `free` (no purse, no validity gate) so a shot can stage any
      // composition — but a site the player could never buy is almost always a mistake in
      // the preset table, not an intent. Say so out loud rather than quietly shipping a
      // tower standing in the road.
      const v = canPlace(bx, bz);
      if (!v.ok) console.log('BUILDWARN ' + bx + ',' + bz + ':' + ty + ' — ' + v.reason);
      placeTower(bx, bz, ty, lv, true);
    }
    state.phase = 'prewave'; state.countdown = 3;
    const ops = pre.plan ? parsePlan(P.get('plan') || '') : null, placed = [];
    const tSec = P.has('t') ? parseFloat(P.get('t')) : pre.t;
    const ticks = Math.round(tSec * TPS);
    for (let i = 0; i < ticks; i++) {
      if (ops && i % 15 === 0) botStep(ops, placed);    // the bot buys twice a sim second
      tickSim();
      if (state.phase === 'won' || state.phase === 'lost') break;
    }
    if (ops) { const left = ops.filter(o => o.k !== 'upall').length;
      if (left) console.log('BOTSKIP ' + left + ' op(s) never became affordable'); }
    if (pre.fx) pre.fx();
    if (pre.ui) pre.ui();
  }
  const c = pre.cam;
  if (c.pos) { CAM.free = true; camera.position.set(...c.pos); camera.lookAt(...c.look); }
  else { CAM.tx = c.tgt[0]; CAM.ty = c.tgt[1]; CAM.tz = c.tgt[2]; CAM.dist = c.dist; }
  UI.sync();
  // `bare`: strip the bottom chrome. The build bar is PERSISTENT now (SPEC2 §A), so it sits
  // over the bottom-centre of every in-game frame — which is right for the gameplay shots
  // and wrong for the asset-inspection rigs, whose entire subject it was covering. Runs
  // after UI.sync() because sync() re-shows the bar.
  if (pre.bare) for (const id of ['buildMenu', 'towerMenu', 'placeBar', 'hint']) $(id).classList.add('hidden');
  // `post`: the only hook that runs AFTER UI.sync(), for a preset that needs to dress the
  // HUD sync() would otherwise rebuild from live state (see _bestiary's icon row).
  if (pre.post) pre.post();
  // Render inside real animation frames so the headless compositor picks up the buffer.
  let settle = 3;
  const settleFrame = () => {
    render(vt());
    if (--settle > 0) { requestAnimationFrame(settleFrame); return; }
    const glc = renderer.getContext();
    const pb = new Uint8Array(4);
    glc.readPixels(glc.drawingBufferWidth >> 1, glc.drawingBufferHeight >> 1, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, pb);
    console.log('PROBE center=' + [...pb] + ' buf=' + glc.drawingBufferWidth + 'x' + glc.drawingBufferHeight + ' cam=' + camera.position.toArray().map(v => v.toFixed(1)));
    const alive = G.enemies.filter(e => e.alive).length;
    console.log('STATE ' + JSON.stringify({ shot: name, tier, map: MAP.id, tick: state.tick, wave: state.wave, phase: state.phase,
      alive, knights: G.knights.filter(k => k.alive).length, towers: G.towersList.length, gold: state.gold,
      lives: state.lives, leaked: state.leaked, kills: state.kills, invested: state.invested,
      muster: state.muster, omen: state.omen, seed: G.runSeed,
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles }));
    document.title = window.__errors.length ? 'ERROR' : 'SHOT_READY';
  };
  requestAnimationFrame(settleFrame);
}
// POLISH: QA hook. Everything lives in module scope, so a live playtest has no way to
// inspect the game from the console or from an automated harness. Opt-in only.
if (P.get('dbg')) window.G = G;
if (SHOT) runShot(SHOT);
else {
  // `&auto=1` (written by a map card) drops straight into the chosen road; `&maps=1`
  // ("Choose Your Road" on the victory plate) opens the chooser over the title backdrop.
  if (P.has('auto')) UI.startGame(false); else if (P.has('maps')) UI.showMaps();
  UI.sync(); requestAnimationFrame(frame);
}
// ══════════════════════ END SECTION: MAIN ══════════════════════
