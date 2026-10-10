// ═══════════════════ SECTION: CO-OP TRANSPORT (owner: coop-netcode stage) ═══════════════════
// GAME_SPEC_9 §B — host-sequenced deterministic lockstep, over the wire.
//
// The lobby (js/lobby.js) decides WHO plays and hands that over once, as `bf-coop-start`. The
// sim (SECTION: SIM, via the `NET` command layer) decides WHAT a command does. This file owns
// the thin, dumb, ordered pipe between them and nothing else:
//
//     a guest's click ──► SUB ──► THE HOST ──► stamps execTick = hostTick + LEAD
//                                    │
//                                    └──► BUN ──► every peer, host included ──► the sim queue
//
// It never reads a balance table, never touches an entity, never invents a tick. It moves four
// message kinds, keeps one number monotonic (the horizon), and shouts when the four peers stop
// agreeing about the world.
//
// ── WHY THE HOST STAMPS, AND WHY EMPTY TICKS ARE STILL SENT ─────────────────────────────────
// Lockstep's whole safety property is that every peer applies the SAME commands in the SAME
// order at the SAME tick. Two peers cannot agree on an order by themselves — so one of them
// decides. The host's arrival order IS the order, and it travels inside the bundle rather than
// being re-derived anywhere, so there is nothing left for two engines to disagree about.
//
// A peer may never simulate past the last tick the host has authorized (the HORIZON). That
// makes silence indistinguishable from a stall — so silence is illegal: the host emits bundles
// for empty ticks too, coalesced into `{f,t}` ranges so a quiet minute costs a few dozen bytes
// rather than 1800 messages.
//
// ── CONTRACT WITH THE COMMAND LAYER (verified — see the RECONCILIATION block at the foot) ──
//   CMD = { t, p, op, args }     t = execTick, p = player index, op/args = the rules vocabulary
//   LEAD = 8 ticks (≈266 ms at 30 tps)
//   Set by us:       NET.onSubmit = (cmd)      the local player just did a thing
//                    NET.onCRC = ({tick,crc})  the sim's checkpoint state hash
//   Called by us:    NET.recv(cmd)             queue a command for its stamped tick
//                    NET.setHorizon(tick)      the sim may now run up to and including `tick`
//   Read by us:      NET.stamp() / NET.LEAD / NET.session() / NET.OPS / NET.active
//
// ── INVARIANTS ──────────────────────────────────────────────────────────────────────────────
//  · SHOT/TESTQ: this file installs NOTHING under `?shot=`/`?test=`. No listener, no DOM, no
//    import, no timer. The one and only side effect at module scope is a single `bf-coop-start`
//    listener behind `if (!SHOT)`, and that event cannot be dispatched by anything headless.
//  · SOLO IS UNTOUCHED: not one byte of NET is written, and not one timer runs, until a session
//    actually starts. `stop()` puts every hook back exactly as it found it.
//  · NO Math.random — crypto.getRandomValues, like the lobby. The project bans it outright.
//  · NO CDN: the Trystero bundle is the vendored, pinned one, reached through the import map.
//  · Nothing here may throw out of an async boundary: SECTION: CORE turns an unhandled
//    rejection into `document.title = 'ERROR'`, which is the harness's own failure marker.

// ── i18n ────────────────────────────────────────────────────────────────────────────────────
// Same flat keyspace and same medieval register as LOBBY_STR, and merged the same way (see
// lobby.js contract §4). Mirrored on `window.BF_NET_STR` so game.js can fold it into STR
// without importing this module.
export const NET_STR = {
en: {
  'coop.net.waiting': 'Waiting for {0}…',
  'coop.net.waitingAny': 'Waiting for the band…',
  'coop.net.silent': 'Their line has gone quiet. Holding the field until they answer.',
  'coop.net.dropped': '{0} has fallen out of the band. Their works pass to the captain.',
  'coop.net.hostgone': 'The captain has ridden off. Without a captain the band cannot hold the vale.',
  'coop.net.desync': 'The vales have parted.',
  'coop.net.desyncBody': 'The band no longer sees the same field — two tellings of the same battle cannot both be true, so the battle is called at tick {0}. Ride back to the war-band and set out again.',
  'coop.net.toLobby': 'Back to the war-band',
  'coop.net.stalled': 'The captain has fallen silent. Holding at tick {0}…',
  'coop.net.gather': 'Mustering the war-band…',
  'coop.net.gatherBody': 'The horn has sounded and the field is being made ready. The battle opens when every captain has come up — nobody rides ahead of the band.',
  'coop.net.nolib': 'The co-op courier is missing from this build.',
},
fr: {
  'coop.net.waiting': 'En attente de {0}…',
  'coop.net.waitingAny': 'En attente de la compagnie…',
  'coop.net.silent': 'Sa ligne s’est tue. On tient le terrain jusqu’à sa réponse.',
  'coop.net.dropped': '{0} a quitté la compagnie. Ses ouvrages passent au capitaine.',
  'coop.net.hostgone': 'Le capitaine est parti. Sans capitaine, la compagnie ne peut tenir la vallée.',
  'coop.net.desync': 'Les vallées se sont séparées.',
  'coop.net.desyncBody': 'La compagnie ne voit plus le même terrain — deux récits d’une même bataille ne peuvent être vrais tous les deux, donc la bataille s’arrête au temps {0}. Retournez à la compagnie et repartez.',
  'coop.net.toLobby': 'Retour à la compagnie',
  'coop.net.stalled': 'Le capitaine s’est tu. On tient au temps {0}…',
  'coop.net.gather': 'Rassemblement de la compagnie…',
  'coop.net.gatherBody': 'Le cor a sonné et le terrain se prépare. La bataille s’ouvre quand chaque capitaine est arrivé — personne ne part devant la compagnie.',
  'coop.net.nolib': 'Le messager de coopération manque à cette version.',
},
};
try { window.BF_NET_STR = NET_STR; } catch (e) { /* never fatal */ }

const P = new URLSearchParams(location.search);
// Read exactly as SECTION: CORE and lobby.js read it. Everything below the boot guard is
// unreachable when this is set.
const SHOT = P.get('shot') || (P.get('test') ? '__test__' : null);

const LANG_KEY = 'bannerfall.lang';
const LANG = (() => {
  const q = (P.get('lang') || '').toLowerCase();
  if (q === 'fr' || q === 'en') return q;
  if (SHOT) return 'en';
  try { const s = localStorage.getItem(LANG_KEY); if (s === 'fr' || s === 'en') return s; } catch (e) { /* private mode */ }
  return /^fr/i.test(navigator.language || '') ? 'fr' : 'en';
})();
const L = (k, ...a) => {
  let s = NET_STR[LANG][k];
  if (s === undefined) s = NET_STR.en[k];
  if (s === undefined) {
    // The lobby's table is the other half of the same keyspace; fall through to it so a key
    // that migrates between the two files never renders as a raw key.
    try { const o = window.BF_LOBBY_STR; if (o) s = (o[LANG] && o[LANG][k]) || (o.en && o.en[k]); } catch (e) { /* */ }
  }
  if (s === undefined) return k;
  return a.length ? s.replace(/\{(\d)\}/g, (m, i) => (a[i] === undefined ? m : a[i])) : s;
};

// ── protocol ────────────────────────────────────────────────────────────────────────────────
// Bumped on any wire-visible change. A peer on a different PROTO is refused at the handshake
// rather than allowed to desync six minutes later.
export const PROTO = 1;
const APP_ID = 'bannerfall';

// GAME_SPEC_9 §B. LEAD is the whole latency budget: a command the local player issues is not
// obeyed for LEAD ticks, because every other peer has to be told about it first.
const DEF = {
  lead: 8,        // ticks between the host's now and the tick a command executes
  hbTicks: 3,     // host: emit a heartbeat bundle at least this often (in ticks)
  hb: 1000,       // guest: emit a liveness ping at least this often (ms)
  pump: 25,       // host: ms between reads of NET.stamp() — a little under one 30 tps tick
  watchdog: 500,  // ms between silence sweeps
  silent: 5000,   // ms of silence from a peer -> auto-pause overlay
  drop: 30000,    // ms of silence from a peer -> drop them
  crcGrace: 4000, // ms to wait for every peer's hash for a checkpoint before judging on what came
  gapStall: 2000, // ms of a hole in the bundle stream before we say so on screen
  muster: 60000,  // ms a saddle that has NEVER spoken is given to come back from the navigation
};
const T = { ...DEF };

// Action names. Trystero caps these at 12 bytes; the lobby has already claimed
// 'seat' / 'lobby' / 'go' and this stage claims exactly these four.
const A_CMD = 'cmd';   // guest -> host   : SUB  { v, n, op, args }
const A_BUN = 'bun';   // host  -> all    : BUN  { v, f, t, c:[CMD] }
const A_CRC = 'crc';   // peer  -> host   : CRC  { v, t, h }
const A_SYS = 'sys';   // any   -> any    : SYS  { v, k, ... }

// ── BroadcastChannel loopback (`?net=bc`) ───────────────────────────────────────────────────
// A same-machine transport that is API-compatible with Trystero, for tests and for the two-tab
// E2E. It is NOT a WebRTC substitute and never ships as a play mode: it exists because a
// sequencer whose only proof runs over public Nostr relays is a sequencer proved against the
// weather. Over one BroadcastChannel per room it is ordered and lossless, which is exactly the
// delivery guarantee an ordered reliable DataChannel gives — so the ordering, horizon and CRC
// properties proved here are the properties that hold in play.
//
// It implements the 0.25 surface the vendored bundle actually exposes (verified against
// js/vendor/trystero-nostr.min.js, not against the docs):
//   joinRoom({appId}, roomId) -> { makeAction, leave, getPeers, onPeerJoin, onPeerLeave }
//   makeAction(n) -> { send(data, {target}), get/set onMessage }      ← object, not tuple
//   onPeerJoin / onPeerLeave are settable PROPERTIES, and assigning onPeerJoin replays the
//   peers already present — a subtle behaviour the real bundle has and code depends on.
//   handler signature: (payload, { peerId })
function makeBcStrategy() {
  const rnd = (n) => {
    const b = new Uint8Array(n); crypto.getRandomValues(b);
    return Array.from(b, (x) => (x % 36).toString(36)).join('');
  };
  const selfId = 'bc' + rnd(18);

  const joinRoom = (cfg, roomId) => {
    const app = (cfg && cfg.appId) || APP_ID;
    const ch = new BroadcastChannel('bfnet:' + app + ':' + roomId);
    const peers = new Set();
    const acts = new Map();          // name -> { onMessage }
    const hooks = { onPeerJoin: null, onPeerLeave: null };
    let left = false;

    const post = (m) => { if (!left) try { ch.postMessage(m); } catch (e) { /* channel closed */ } };
    const meet = (id) => {
      if (id === selfId || peers.has(id)) return;
      peers.add(id);
      try { if (hooks.onPeerJoin) hooks.onPeerJoin(id); } catch (e) { console.warn('bfnet/bc: onPeerJoin threw', e); }
    };
    const part = (id) => {
      if (!peers.delete(id)) return;
      try { if (hooks.onPeerLeave) hooks.onPeerLeave(id); } catch (e) { console.warn('bfnet/bc: onPeerLeave threw', e); }
    };

    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || m.app !== app) return;
      if (m.from === selfId) return;                    // BroadcastChannel does not echo, belt+braces
      if (m.k === 'hello') { meet(m.from); post({ app, k: 'hi', from: selfId, to: m.from }); return; }
      if (m.k === 'hi') { if (m.to === selfId) meet(m.from); return; }
      if (m.k === 'bye') { part(m.from); return; }
      if (m.k === 'act') {
        if (m.to && m.to !== selfId) return;            // a targeted send
        meet(m.from);                                   // a message is proof of life
        const a = acts.get(m.n);
        if (a && a.onMessage) {
          // Async-dispatched exactly like the real bundle, so a handler that throws cannot
          // unwind into the sender's stack (and so ordering-vs-reentrancy behaves the same).
          const fn = a.onMessage;
          Promise.resolve().then(() => fn(m.d, { peerId: m.from }))
            .catch((err) => console.warn('bfnet/bc: action handler error', err));
        }
      }
    };

    post({ app, k: 'hello', from: selfId });
    // A tab that is torn down without leave() must still un-seat itself.
    const onUnload = () => post({ app, k: 'bye', from: selfId });
    try { addEventListener('pagehide', onUnload); } catch (e) { /* */ }

    const room = {
      makeAction(name) {
        if (acts.has(name)) return acts.get(name).api;
        const rec = { onMessage: null };
        const api = {
          send: (d, opts) => { post({ app, k: 'act', n: name, from: selfId, to: (opts && opts.target) || null, d }); return Promise.resolve(); },
          get onMessage() { return rec.onMessage; },
          set onMessage(fn) { rec.onMessage = fn; },
        };
        rec.api = api; acts.set(name, rec);
        return api;
      },
      leave() {
        if (left) return Promise.resolve();
        post({ app, k: 'bye', from: selfId }); left = true;
        try { removeEventListener('pagehide', onUnload); } catch (e) { /* */ }
        try { ch.close(); } catch (e) { /* */ }
        peers.clear();
        return Promise.resolve();
      },
      getPeers() { const o = {}; for (const p of peers) o[p] = {}; return o; },
      get onPeerJoin() { return hooks.onPeerJoin; },
      set onPeerJoin(fn) { hooks.onPeerJoin = fn; if (fn) for (const p of Array.from(peers)) fn(p); },
      get onPeerLeave() { return hooks.onPeerLeave; },
      set onPeerLeave(fn) { hooks.onPeerLeave = fn; },
      __bc: true,
    };
    return room;
  };

  return { joinRoom, selfId, __bc: true };
}

// ── strategy switch ─────────────────────────────────────────────────────────────────────────
// `?net=bc` picks the loopback; anything else is the real thing. The Trystero bundle is fetched
// by dynamic `import()` and no earlier — a solo boot never pays for it, exactly as the lobby
// arranged, and `null` stays a first-class answer.
let _strategy;
export async function transport() {
  if (_strategy !== undefined) return _strategy;
  if ((P.get('net') || '').toLowerCase() === 'bc') {
    _strategy = makeBcStrategy();
    console.info('bfnet: BroadcastChannel loopback (?net=bc) — same-machine rooms only');
    return _strategy;
  }
  try { _strategy = await import('trystero'); }
  catch (e) { _strategy = null; console.warn('bfnet: trystero unavailable —', e && e.message); }
  return _strategy;
}
export const strategyName = () => ((P.get('net') || '').toLowerCase() === 'bc' ? 'bc' : 'nostr');

// ── the two shapes Trystero has shipped ─────────────────────────────────────────────────────
// Same adapters as the lobby's, for the same reason: re-pinning the vendor bundle must not
// silently break a channel. Verified against 0.25.4 (object + settable property + `{peerId}`),
// with the ≤0.21 tuple/call/string form still handled.
const act = (room, name) => {
  const a = room.makeAction(name);
  // The two generations disagree about how a DIRECT send is addressed, and the difference is
  // silent: 0.25 takes `{target}`, <=0.21 took the peer id positionally. Normalised here so
  // every call site in this file can write `{ target: id }` and mean it.
  if (Array.isArray(a)) return { send: (d, o) => a[0](d, o && o.target), on: a[1] };
  return { send: (d, o) => a.send(d, o), on: (fn) => { a.onMessage = fn; } };
};
const onPeer = (room, key, fn) => {
  if (typeof room[key] === 'function') room[key](fn); else room[key] = fn;
};
const pid = (m) => (m && typeof m === 'object' && m.peerId) ? m.peerId : m;
// Trystero's send() is async and rejects when a peer vanishes mid-flight. An unhandled
// rejection sets document.title = 'ERROR', which is the harness's failure marker — so every
// send in this file goes through here and nowhere else.
const fire = (fn, d, o) => { try { const r = fn(d, o); if (r && r.catch) r.catch(() => {}); } catch (e) { /* peer gone */ } };

// ── session state ───────────────────────────────────────────────────────────────────────────
const S = {
  live: false,
  role: null,          // 'host' | 'guest'
  room: null,          // the Trystero (or shim) room — borrowed from the lobby when it has one
  ownRoom: false,      // did WE open it? then WE close it
  selfId: '',
  players: [],         // the lobby's roster, verbatim: [{ id, name, idx, crest, host, ready }]
  localIdx: 0,
  hostIdx: 0,
  byId: new Map(),     // peerId -> idx
  byIdx: new Map(),    // idx    -> { id, name, gone }
  send: null,          // { cmd, bun, crc, sys }

  tick: -1,            // last sim tick we have been told about
  horizon: -1,         // highest tick the sim has been authorized to run
  emitted: -1,         // host: highest tick we have authorized anyone to run
  lastEmit: 0,         // host: tick at which the last bundle went out
  pend: [],            // host: submits waiting for a stamp
  seq: 0,              // guest: local submit sequence
  buf: new Map(),      // client: bundles held for a hole in the stream, keyed by `f`
  gapSince: 0,

  crc: new Map(),      // checkpoint tick -> { at, rows: Map(idx -> hash) }
  crcSinks: [],        // registrar-shaped consumers, if the command layer turns out to want that
  desync: 0,           // tick of the parting, 0 = still one world

  startedAt: 0,        // ms; the clock a peer that has never spoken is measured against
  seen: new Map(),     // peerId -> ms of last inbound byte
  met: new Set(),      // seats that have announced themselves SINCE THIS SESSION BEGAN. Not the
                       // same thing as `seen`: the roster's peer ids are all stale on the far
                       // side of the navigation, so this is the only honest answer to "is that
                       // saddle actually on the wire yet".
  gatherOn: 0,         // is the muster overlay up
  stalling: new Set(), // idx of peers past `silent`
  gone: new Set(),     // idx of peers past `drop`
  paused: false,
  ended: '',           // '' | 'desync' | 'hostgone'

  wd: 0, hbT: 0, pmp: 0,   // timers
  code: '',            // the room code we re-dialled with
  prev: null,          // the NET hooks as we found them
  tickMode: '',
};

const now = () => Date.now();
const nameOf = (i) => { const p = S.byIdx.get(i); return (p && p.name) || ('#' + i); };

// ── the bridge to SECTION: NET (js/game.js, the command layer) ──────────────────────────────
// RECONCILED against the landed command layer, not guessed at. That section publishes itself as
// `window.BFNet` and meets this file at exactly four points:
//
//   NET.onSubmit = (cmd) => …     WE SET IT. The sim funnels a local click here and does nothing
//                                 locally; cmd = { t:-1, p, s, op, args:[] } with `s` the
//                                 submitter's own never-restarting sequence number.
//   NET.recv(cmd)                 WE CALL IT, with `t` filled in. Queues the command for its tick.
//   NET.setHorizon(t)             WE CALL IT. "Everything up to and including t is sealed."
//   NET.onCRC = ({tick, crc}) =>  WE SET IT. The once-a-sim-second tripwire.
//
// And it hands us the two things a sequencer cannot invent:
//   NET.stamp() === state.tick + NET.LEAD     the host's stamping rule, published once
//   NET.session()                             seed / map / mode / diff / roster / code
//
// `args` IS AN ARRAY and its arity is declared in NET.OPS[op].a — which is what lets us refuse a
// malformed packet from a peer at the door rather than inside G.placeTower.
const sim = () => { try { const N = window.BFNet; return (N && typeof N.setHorizon === 'function') ? N : null; } catch (e) { return null; } };

function bindSim() {
  const N = sim();
  S.prev = null;
  if (!N) { console.warn('bfnet: SECTION: NET not present — running as a pure transport'); return; }
  S.prev = { onSubmit: N.onSubmit, onCRC: N.onCRC };
  N.onSubmit = (c) => { if (c) submitCmd(c); };
  N.onCRC = (rec) => { if (rec) localCRC(rec.tick | 0, rec.crc >>> 0); };
  S.tickMode = 'NET.stamp()';
  console.info('bfnet: bound to SECTION: NET — LEAD', N.LEAD, 'ops', Object.keys(N.OPS || {}).length);
}

function unbindSim() {
  const N = sim();
  if (N && S.prev) { N.onSubmit = S.prev.onSubmit; N.onCRC = S.prev.onCRC; }
  S.prev = null; S.crcSinks = [];
}

// ── THE MUSTER GATE ─────────────────────────────────────────────────────────────────────────
// A run BEGINS with a navigation: SECTION: NET writes `?coop=CODE` and every page dies and comes
// back, at its own pace, after its own world build. The captain is usually first. A bundle sealed
// before a rider's channels exist is simply lost - `bun` is a broadcast into a room the rider has
// not joined - and because the sequencer has no retransmit by design, that rider holds a hole at
// f=0 that can never be filled and stands at horizon -1 for the rest of the road, buffering
// bundles it may never apply. (Measured: tools/coopsmoke.mjs, guest buffered=133 horizon=-1.)
//
// So the captain seals NOTHING until every saddle has answered `hello`. Both halves of the band
// wait at the gate together, which is exactly what the horizon means anyway, and the first bundle
// any rider ever sees is f=0. A saddle that never comes is dropped by sweep()'s muster window, at
// which point `gone` takes it out of this test and the band rides without it.
function bandPresent() {
  for (const p of S.players) {
    if (p.idx === S.localIdx || S.gone.has(p.idx)) continue;
    if (!S.met.has(p.idx)) return false;
  }
  return true;
}

// THE HOST'S CLOCK. `NET.stamp()` is the sim's own published rule — state.tick + LEAD — so the
// sequencer never has to keep a second, drifting idea of what tick it is. Pumped a little faster
// than the 30 tps sim so a tick is never missed; the emitter itself coalesces (see feedTick).
// Note the deliberate feedback loop: the host's OWN sim also refuses to step past the horizon it
// has sealed, so each pump raises the seal by exactly as far as the sim actually advanced.
function pump() {
  const N = sim(); if (!N) return;
  if (!bandPresent()) return;                 // THE MUSTER GATE - see above. Host-only path.
  let t;
  try { t = (N.stamp() | 0) - (N.LEAD | 0); } catch (e) { return; }
  if (t > S.tick) feedTick(t);
}

// A peer's packet is validated against the OP TABLE before it is trusted: an unknown op, or the
// wrong number of arguments, is a broken or hostile peer and is dropped here rather than allowed
// to reach a G.* verb with garbage.
function okOp(op, args) {
  const N = sim(); if (!N || !N.OPS) return true;
  const spec = N.OPS[op];
  if (!spec) return false;
  return Array.isArray(args) && args.length === (spec.a | 0);
}

function applyToSim(cmd) {
  const N = sim(); if (!N) { emit('cmd', { cmd }); return; }
  try { N.recv(cmd); } catch (e) { console.warn('bfnet: NET.recv threw', e); }
}

function horizonToSim(t) {
  if (t <= S.horizon) return;                 // MONOTONIC. The one number that must never go back.
  S.horizon = t;
  const N = sim();
  try { if (N) N.setHorizon(t); } catch (e) { console.warn('bfnet: setHorizon threw', e); }
  emit('horizon', { tick: t });
}

// ── the host sequencer ──────────────────────────────────────────────────────────────────────
// Called once per sim tick (and only ever forwards). Everything the host owes the band is
// decided here: what the horizon is, which commands ride with it, and how rarely it may say
// nothing at all.
export function feedTick(t) {
  if (!S.live || !(t > S.tick)) return;
  S.tick = t;
  if (S.role !== 'host') return;
  if (S.paused || S.ended) return;            // a paused band advances nobody's horizon

  // LEAD IS THE SIM'S NUMBER, not ours. `T.lead` is only the standalone default: when SECTION:
  // NET is under us its NET.LEAD wins, because a transport stamping to a different lead than the
  // sim was written for is a desync waiting for a slow link.
  const N = sim();
  const lead = (N && typeof N.LEAD === 'number') ? (N.LEAD | 0) : T.lead;
  const target = t + lead;
  const due = S.pend.length > 0;
  // A bundle carrying commands goes NOW; a bundle carrying nothing is a heartbeat and may wait
  // up to hbTicks, which is what turns 1800 empty messages a minute into a few dozen.
  if (!due && (target - S.lastEmit) < T.hbTicks) return;
  if (target <= S.emitted) return;

  const cmds = [];
  if (due) {
    // ONE canonical order, decided here and FROZEN into the array, so that no peer ever has to
    // re-derive it and no two peers can derive it differently. Seat first, then that player's
    // own submit sequence — deliberately NOT raw arrival order, which is a property of relay
    // jitter rather than of the game. A burst from one player still lands in the order that
    // player made it, which is the only ordering a player can actually perceive.
    S.pend.sort((a, b) => (a.p - b.p) || (a.s - b.s));
    for (const s of S.pend) cmds.push({ t: target, p: s.p, s: s.s, op: s.op, args: s.args });
    S.pend.length = 0;
  }
  const bun = { v: PROTO, f: S.emitted + 1, t: target, c: cmds };
  S.emitted = target; S.lastEmit = target;
  if (S.send) fire(S.send.bun, bun);
  ingestBundle(bun, S.selfId);                // the host obeys its own bundles, same code path
}

// ── bundle ingestion (host and guest alike) ─────────────────────────────────────────────────
function ingestBundle(b, from) {
  // A peer that has declared the run over — parted CRCs, or a captain who never came back —
  // stops advancing. Simulating on past a desync is how one wrong board becomes two.
  if (!S.live || S.ended || !b || b.v !== PROTO) return;
  // Only the captain sequences — but "a peer we have not placed yet" is not "a peer who is not
  // the captain". After the run's page navigation every peer re-dials with a BRAND NEW peer id,
  // so the roster's ids are stale until each `hello` lands; rejecting on an unknown id here
  // would drop the first bundles of every session.
  if (S.role === 'guest' && from !== S.selfId) { const fi = S.byId.get(from); if (fi !== undefined && fi !== S.hostIdx) return; }
  if (typeof b.t !== 'number' || typeof b.f !== 'number') return;
  if (b.t <= S.horizon) return;                                  // already lived through

  if (b.f > S.horizon + 1) {                                     // a hole: hold it, do not skip it
    S.buf.set(b.f, b);
    if (!S.gapSince) S.gapSince = now();
    if (S.buf.size > 512) S.buf.clear();                         // a hole this old is a dead session
    return;
  }
  if (S.gapSince) { S.gapSince = 0; veil(S.stalling.size ? 'wait' : ''); }
  applyBundle(b);
  // Drain anything the hole was hiding.
  for (;;) {
    const nx = S.buf.get(S.horizon + 1);
    if (!nx) break;
    S.buf.delete(S.horizon + 1);
    applyBundle(nx);
  }
}

function applyBundle(b) {
  // ORDER MATTERS AND IS NOT NEGOTIABLE: every command is queued BEFORE the horizon rises, so
  // the sim can never be authorized to run a tick whose commands have not yet landed.
  const c = Array.isArray(b.c) ? b.c : [];
  for (const cmd of c) {
    if (!cmd || typeof cmd.t !== 'number') continue;
    if (cmd.t <= S.horizon) continue;                            // a re-send of something already lived
    const op = String(cmd.op || ''), args = Array.isArray(cmd.args) ? cmd.args : [];
    if (!okOp(op, args)) { console.warn('bfnet: refused a malformed command', op, args); continue; }
    applyToSim({ t: cmd.t | 0, p: cmd.p | 0, s: cmd.s | 0, op, args });
  }
  horizonToSim(b.t | 0);
}

// ── local submits ───────────────────────────────────────────────────────────────────────────
// `NET.onSubmit` lands here with a CMD the sim has already built — { t:-1, p, s, op, args } — so
// the sequence number is the SUBMITTER's, which is what makes the (p, s) ordering mean the same
// thing on every machine. On the host it joins the pending pile; on a guest it goes out and
// comes back stamped.
//
// It is BROADCAST, not addressed to the host: after the run's page navigation the roster's peer
// ids are stale until the `hello` handshake completes, and a send addressed to a dead id is
// silently lost. Every non-host peer drops it on arrival, and at four seats and ~1 action/s the
// bandwidth this costs is not measurable.
function submitCmd(c) {
  if (!S.live || S.ended) return false;
  const rec = { p: S.localIdx, s: c.s | 0, op: String(c.op || ''), args: Array.isArray(c.args) ? c.args : [] };
  if (S.role === 'host') { S.pend.push(rec); return true; }
  if (S.send) fire(S.send.cmd, { v: PROTO, s: rec.s, op: rec.op, args: rec.args });
  return true;
}
// A command this MODULE originates (today: `inherit`) still needs an `s`, and it must come from
// the same well as this peer's player commands — SECTION: NET's own NET.seq — or a transport
// command and a player command could collide on the same (p, s) key inside one tick.
const nextSeq = () => { const N = sim(); return (N && typeof N.seq === 'number') ? N.seq++ : ++S.seq; };

// The manual entry point (the probe, and any caller that has no SECTION: NET under it).
export function submit(op, args) {
  const N = sim();
  if (N && typeof N.submit === 'function' && N.active) return !!N.submit(op, args);
  return submitCmd({ s: nextSeq(), op, args: args || [] });
}

// ── CRC exchange ────────────────────────────────────────────────────────────────────────────
// The safety net GAME_SPEC_9 §B demands. The sim hands us a hash of (gold, lives, rng cursor,
// enemy count + hpSum, tower count) every checkpoint; we make sure the band agrees about it.
// One disagreement is the end of the run, because a lockstep sim that has parted cannot be
// reconciled — v1 recovery is the lobby, and pretending otherwise would just hide the bug.
export function localCRC(tick, hash) {
  if (!S.live || S.ended) return;
  for (const fn of S.crcSinks) { try { fn(tick, hash); } catch (e) { /* */ } }
  if (S.role === 'host') { recordCRC(tick, S.localIdx, hash); judgeCRC(); }
  else if (S.send) fire(S.send.crc, { v: PROTO, t: tick | 0, h: hash >>> 0 });
  emit('crc', { tick: tick | 0, hash: hash >>> 0 });
}

function recordCRC(tick, idx, hash) {
  let e = S.crc.get(tick);
  if (!e) { e = { at: now(), rows: new Map() }; S.crc.set(tick, e); }
  e.rows.set(idx, hash >>> 0);
  if (S.crc.size > 64) { const k = Math.min(...S.crc.keys()); S.crc.delete(k); }
}

// A checkpoint is judged when everyone still in the band has spoken, or when the grace runs out
// and we judge on whoever did — a peer that is merely slow must not stall the verdict forever.
function judgeCRC() {
  if (S.role !== 'host' || S.ended) return;
  const live = S.players.filter((p) => !S.gone.has(p.idx)).map((p) => p.idx);
  for (const [tick, e] of Array.from(S.crc.entries()).sort((a, b) => a[0] - b[0])) {
    const complete = live.every((i) => e.rows.has(i));
    if (!complete && (now() - e.at) < T.crcGrace) continue;
    if (e.rows.size >= 2) {
      const vals = Array.from(e.rows.values());
      if (vals.some((h) => h !== vals[0])) {
        const rows = Array.from(e.rows.entries());
        S.crc.delete(tick);
        if (S.send) fire(S.send.sys, { v: PROTO, k: 'desync', t: tick, rows });
        onDesync(tick, rows);
        return;
      }
    }
    S.crc.delete(tick);
  }
}

function onDesync(tick, rows) {
  if (S.ended) return;
  S.ended = 'desync'; S.desync = tick | 0; S.paused = true;
  pauseSim(true);
  emit('desync', { tick: S.desync, rows: rows || [] });
  veil('desync');
}

// ── liveness, drops, inheritance ────────────────────────────────────────────────────────────
function touch(peerId) { if (peerId) S.seen.set(peerId, now()); }

// ONE MESSAGE DOES BOTH JOBS, and it is a PING rather than a one-shot for two reasons that both
// bite after the run's page navigation:
//
//  · SEAT BINDING. Every peer re-dials with a BRAND NEW peer id, so the roster's ids are all
//    stale and `idx` has to be re-announced. A single hello at start would be lost whenever a
//    peer finishes joining before another peer has attached its handlers — and peers navigate
//    at their own pace, so that race is normal, not exotic.
//  · LIVENESS. A host that is merely quiet is otherwise indistinguishable from a host that has
//    gone, and `sweep()` reads last-seen off the CURRENT id. Without this ping a guest would
//    eventually declare a perfectly healthy captain dead at the 30 s mark.
function hello() {
  if (!S.live || S.ended || !S.send) return;
  fire(S.send.sys, { v: PROTO, k: 'hello', idx: S.localIdx, name: (S.byIdx.get(S.localIdx) || {}).name || '' });
}

function sweep() {
  if (!S.live || S.ended) return;
  const t = now(), was = S.stalling.size;
  for (const p of S.players) {
    if (p.idx === S.localIdx || S.gone.has(p.idx)) continue;
    // A guest only watches the captain; the captain watches everyone. A guest has no standing
    // to declare another guest dropped — that is the sequencer's call and only the sequencer's.
    if (S.role === 'guest' && p.idx !== S.hostIdx) continue;
    const seat = S.byIdx.get(p.idx);
    // A SADDLE THAT HAS NOT ANSWERED ONCE IS NOT SILENT, IT IS STILL COMING BACK. The silence and
    // drop clocks are about a peer that WAS on the wire and stopped; a peer on the far side of the
    // navigation has never been on this session's wire at all, and its world build alone can
    // outlast `silent` on a slow machine. It gets the muster window instead - and when that runs
    // out it is dropped exactly as a silent peer is, so the band can never be held at the gate
    // forever by a browser that closed.
    if (!S.met.has(p.idx)) {
      if (t - S.startedAt > T.muster) {
        if (p.idx === S.hostIdx) { onHostGone(); return; }
        dropPeer(p.idx);
      }
      continue;
    }
    const last = S.seen.get((seat && seat.id) || p.id) || S.startedAt;
    const dt = t - last;
    if (dt > T.drop) {
      if (p.idx === S.hostIdx) { onHostGone(); return; }
      dropPeer(p.idx);
      continue;
    }
    if (dt > T.silent) S.stalling.add(p.idx); else S.stalling.delete(p.idx);
  }
  if (S.stalling.size !== was) {
    if (S.stalling.size) { S.paused = true; pauseSim(true); veil('wait'); emit('pause', { who: Array.from(S.stalling) }); }
    else { S.paused = false; pauseSim(false); veil(''); emit('resume', {}); }
  } else if (S.stalling.size) veil('wait');   // the name in the overlay may have changed
}

// GAME_SPEC_9 §B: their towers REMAIN and the host inherits the rights to them. The transfer is
// a COMMAND, not a local edit — it rides the normal pipeline and is stamped like everything
// else, so all four peers perform the inheritance on the very same tick.
function dropPeer(idx) {
  if (S.gone.has(idx)) return;
  S.gone.add(idx); S.stalling.delete(idx);
  const p = S.byIdx.get(idx); if (p) p.gone = true;
  if (S.role === 'host') {
    if (S.send) fire(S.send.sys, { v: PROTO, k: 'roster', players: S.players.map((q) => ({ idx: q.idx, id: q.id, name: q.name, gone: S.gone.has(q.idx) })) });
    // GAME_SPEC_9 §B. `inherit` is NOT in NET.OPS yet — it is the op the coop-rules stage owns
    // (ownership is recorded today and enforced nowhere). Until it exists NET.recv drops it as an
    // unknown op, which is the correct no-op: the towers simply stay where they are.
    submitCmd({ s: nextSeq(), op: 'inherit', args: [idx, S.hostIdx] });
  }
  emit('drop', { idx, name: nameOf(idx) });
  if (!S.stalling.size) { S.paused = false; pauseSim(false); veil(''); }
}

function onHostGone() {
  if (S.ended) return;
  S.ended = 'hostgone'; S.paused = true;
  pauseSim(true);
  emit('hostgone', {});
  veil('hostgone');
}

// THE REAL PAUSE IS THE HORIZON. A host that stops sealing ticks stops the whole band, itself
// included — SECTION: NET's own NET.pre() refuses to step past NET.horizon and raises
// NET.stalled — so a co-op pause needs no pause switch and must not use one: routing it through
// the `pause` op would make a *player's* pause and a *network* stall the same event. This is a
// best-effort courtesy call for a host that happens to expose one, and a no-op otherwise.
function pauseSim(on) {
  const N = sim(); if (!N) return;
  try { if (typeof N.setPaused === 'function') N.setPaused(!!on); } catch (e) { /* */ }
}

// ── the overlay ─────────────────────────────────────────────────────────────────────────────
// Self-contained: this stage owns js/net.js and nothing in css/. One injected sheet, one node,
// both built on first need and never under SHOT.
let _veil = null;
function veilNode() {
  if (_veil) return _veil;
  const st = document.createElement('style');
  st.textContent = [
    '#bfNetVeil{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;',
    'background:rgba(8,7,10,.72);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
    'font:inherit;color:#e9e2d2;text-align:center;padding:24px}',
    '#bfNetVeil.hidden{display:none}',
    '#bfNetVeil .bfnv{max-width:34em;line-height:1.5}',
    '#bfNetVeil .bfnvT{font-size:1.35em;letter-spacing:.06em;text-transform:uppercase;margin:0 0 .6em;color:#f3e6c0}',
    '#bfNetVeil.bad .bfnvT{color:#e8a08a}',
    '#bfNetVeil .bfnvB{margin:0 0 1.2em;opacity:.86}',
    '#bfNetVeil button{font:inherit;color:#f3e6c0;background:rgba(60,48,34,.9);border:1px solid rgba(200,170,110,.5);',
    'padding:.5em 1.2em;letter-spacing:.05em;cursor:pointer;border-radius:2px}',
    '#bfNetVeil button:hover{background:rgba(84,66,44,.95)}',
  ].join('');
  document.head.appendChild(st);
  const d = document.createElement('div');
  d.id = 'bfNetVeil'; d.className = 'hidden';
  d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite');
  d.innerHTML = '<div class="bfnv"><p class="bfnvT"></p><p class="bfnvB"></p><button type="button" hidden></button></div>';
  document.body.appendChild(d);
  d.querySelector('button').addEventListener('click', () => {
    stop();
    try { if (window.BFCoop && window.BFCoop.open) window.BFCoop.open(); } catch (e) { /* */ }
  });
  _veil = d;
  return d;
}

function veil(kind) {
  if (SHOT) return;
  const d = veilNode();
  const tt = d.querySelector('.bfnvT'), bb = d.querySelector('.bfnvB'), btn = d.querySelector('button');
  if (!kind) { d.classList.add('hidden'); d.classList.remove('bad'); return; }
  d.classList.remove('hidden');
  if (kind === 'wait') {
    d.classList.remove('bad');
    const who = Array.from(S.stalling).map(nameOf);
    tt.textContent = who.length ? L('coop.net.waiting', who.join(', ')) : L('coop.net.waitingAny');
    bb.textContent = L('coop.net.silent');
    btn.hidden = true;
  } else if (kind === 'desync') {
    d.classList.add('bad');
    tt.textContent = L('coop.net.desync');
    bb.textContent = L('coop.net.desyncBody', S.desync);
    btn.hidden = false; btn.textContent = L('coop.net.toLobby');
  } else if (kind === 'gather') {
    d.classList.remove('bad');
    tt.textContent = L('coop.net.gather');
    bb.textContent = L('coop.net.gatherBody');
    btn.hidden = true;
  } else if (kind === 'hostgone') {
    d.classList.add('bad');
    tt.textContent = L('coop.net.hostgone');
    bb.textContent = '';
    btn.hidden = false; btn.textContent = L('coop.net.toLobby');
  }
}

// ── events out ──────────────────────────────────────────────────────────────────────────────
// One event name, a `k` discriminator, so the rules/UI stage subscribes once. Never a
// replacement for the overlay: the overlay is what a player sees when nobody else has wired up.
function emit(k, d) {
  try { document.dispatchEvent(new CustomEvent('bf-coop-net', { detail: { k, ...d } })); } catch (e) { /* */ }
}

// ── session lifecycle ───────────────────────────────────────────────────────────────────────
// `sess` is SECTION: NET's own `NET.session()` — seed, map, mode, diff, code, players, localIdx,
// hostIdx — or, standalone, a `bf-coop-start` detail with the same field names.
export async function start(sess) {
  if (S.live) stop();
  const detail = sess || {};
  if (!Array.isArray(detail.players) || !detail.players.length) return false;

  S.players = detail.players.map((p, i) => ({ ...p, idx: (typeof p.idx === 'number' ? p.idx : i) }));
  S.localIdx = typeof detail.localIdx === 'number' ? detail.localIdx : 0;
  const h = S.players.find((p) => p.host);
  S.hostIdx = typeof detail.hostIdx === 'number' ? detail.hostIdx : (h ? h.idx : 0);
  S.role = S.localIdx === S.hostIdx ? 'host' : 'guest';

  S.byId.clear(); S.byIdx.clear();
  for (const p of S.players) { if (p.id) S.byId.set(p.id, p.idx); S.byIdx.set(p.idx, { id: p.id, name: p.name, gone: false }); }

  // A single player is a solo run wearing a hat. Do not open a socket, do not install a hook.
  if (S.players.length < 2) { console.info('bfnet: one seat — no transport raised'); return false; }

  // THE RE-DIAL. SECTION: NET starts a run by NAVIGATING (`location.search = …`), and the
  // navigation ends the page and `window.BFCoop.room` with it — so on the far side there is no
  // lobby room to borrow and every peer has to raise the channels again from the room CODE. When
  // the run happens to need no navigation the lobby's room is still up and is used as-is.
  let room = null;
  try { if (window.BFCoop && window.BFCoop.room) room = window.BFCoop.room; } catch (e) { /* */ }
  const strat = await transport();
  if (!strat) { console.warn('bfnet:', L('coop.net.nolib')); return false; }
  if (!room) {
    const code = roomCode(detail);
    if (!code) { console.warn('bfnet: no room and no code to re-dial — see RECONCILIATION §5'); return false; }
    try { room = strat.joinRoom({ appId: APP_ID }, 'bf-' + code); } catch (e) { console.warn('bfnet: joinRoom refused —', e && e.message); return false; }
    S.ownRoom = true; S.code = code;
  }
  S.room = room; S.selfId = detail.selfId || strat.selfId;

  const aCmd = act(room, A_CMD), aBun = act(room, A_BUN), aCrc = act(room, A_CRC), aSys = act(room, A_SYS);
  S.send = { cmd: aCmd.send, bun: aBun.send, crc: aCrc.send, sys: aSys.send };

  S.live = true; S.startedAt = now();
  S.tick = -1; S.horizon = -1; S.emitted = -1; S.lastEmit = -1;
  S.pend.length = 0; S.seq = 0; S.buf.clear(); S.gapSince = 0;
  S.crc.clear(); S.crcSinks = []; S.desync = 0;
  S.seen.clear(); S.stalling.clear(); S.gone.clear(); S.paused = false; S.ended = '';
  S.met.clear(); S.met.add(S.localIdx); S.gatherOn = 0;

  aCmd.on((d, m) => {
    const from = pid(m); touch(from);
    if (S.role !== 'host' || !d || d.v !== PROTO || S.ended) return;
    const p = S.byId.get(from);
    if (p === undefined || S.gone.has(p)) return;              // an unseated peer has no vote
    const op = String(d.op || ''), args = Array.isArray(d.args) ? d.args : [];
    if (!okOp(op, args)) { console.warn('bfnet: refused a malformed submit from', p, op); return; }
    S.pend.push({ p, s: d.s | 0, op, args });
  });
  aBun.on((d, m) => { const from = pid(m); touch(from); ingestBundle(d, from); });
  aCrc.on((d, m) => {
    const from = pid(m); touch(from);
    if (S.role !== 'host' || !d || d.v !== PROTO) return;
    const p = S.byId.get(from); if (p === undefined) return;
    recordCRC(d.t | 0, p, d.h >>> 0); judgeCRC();
  });
  aSys.on((d, m) => { const from = pid(m); touch(from); onSys(d, from); });

  onPeer(room, 'onPeerJoin', (id) => touch(id));
  onPeer(room, 'onPeerLeave', (id) => {
    const i = S.byId.get(id);
    if (i === undefined) return;
    if (i === S.hostIdx && S.role === 'guest') { onHostGone(); return; }
    // A clean WebRTC teardown is proof, not a guess — no need to wait out the 30 s.
    if (S.role === 'host') dropPeer(i);
  });

  bindSim();
  hello();

  S.wd = setInterval(() => { sweep(); judgeCRC(); gateWatch(); gapWatch(); }, T.watchdog);
  if (S.role === 'host') S.pmp = setInterval(pump, T.pump);
  S.hbT = setInterval(hello, T.hb);

  emit('start', { role: S.role, localIdx: S.localIdx, players: S.players, strategy: strategyName(), proto: PROTO });
  console.info('bfnet: session live —', S.role, 'idx', S.localIdx, 'of', S.players.length, '[' + strategyName() + ']');
  return true;
}

function onSys(d, from) {
  if (!d || d.v !== PROTO) return;
  if (d.k === 'hello') {
    if (typeof d.idx === 'number' && from) {
      S.byId.set(from, d.idx);
      const r = S.byIdx.get(d.idx);
      if (r) { r.id = from; if (d.name) r.name = String(d.name).slice(0, 14); }
      const q = S.players.find((x) => x.idx === d.idx); if (q) q.id = from;   // keep the roster copy honest
      S.met.add(d.idx);                       // ...and the saddle is answered: see bandPresent()
    }
    return;
  }
  if (d.k === 'hb') return;                                    // the ping IS the payload
  const fi = S.byId.get(from);
  if (fi !== undefined && fi !== S.hostIdx) return;             // only the captain issues orders
  if (d.k === 'desync') { onDesync(d.t | 0, d.rows || []); return; }
  if (d.k === 'roster') {
    if (!Array.isArray(d.players)) return;
    for (const p of d.players) {
      if (p.gone && !S.gone.has(p.idx)) { S.gone.add(p.idx); const r = S.byIdx.get(p.idx); if (r) r.gone = true; S.stalling.delete(p.idx); emit('drop', { idx: p.idx, name: nameOf(p.idx) }); }
    }
    return;
  }
  if (d.k === 'bye') { const i = S.byId.get(from); if (i === S.hostIdx) onHostGone(); else if (i !== undefined) { S.gone.add(i); emit('drop', { idx: i, name: nameOf(i) }); } }
}

// A hole in the bundle stream is not a drop — the peer may be perfectly alive and the stream
// merely late. It still has to say so, because from the player's chair a frozen field with no
// explanation is a bug report.
// The other half of the gate: what a player sees while it is shut. Runs on the watchdog rather
// than the pump, because a GUEST has no pump and is waiting on exactly the same thing.
function gateWatch() {
  if (!S.live || S.ended) return;
  const gathering = S.horizon < 0 || (S.role === 'host' && !bandPresent());
  if (gathering) { S.gatherOn = 1; if (!S.paused && !S.stalling.size) veil('gather'); return; }
  if (S.gatherOn) { S.gatherOn = 0; if (!S.stalling.size && !S.gapSince) veil(''); }
}

function gapWatch() {
  if (!S.gapSince || S.ended || S.horizon < 0) return;   // before the first bundle it is a muster
  if (now() - S.gapSince < T.gapStall) return;
  if (SHOT) return;
  const d = veilNode();
  d.classList.remove('hidden', 'bad');
  d.querySelector('.bfnvT').textContent = L('coop.net.stalled', S.horizon);
  d.querySelector('.bfnvB').textContent = '';
  d.querySelector('button').hidden = true;
}

export function stop() {
  if (S.wd) { clearInterval(S.wd); S.wd = 0; }
  if (S.hbT) { clearInterval(S.hbT); S.hbT = 0; }
  if (S.pmp) { clearInterval(S.pmp); S.pmp = 0; }
  if (S.live && S.send) fire(S.send.sys, { v: PROTO, k: 'bye', idx: S.localIdx });
  unbindSim();
  if (S.ownRoom && S.room) { try { if (S.room.leave) S.room.leave(); } catch (e) { /* */ } }
  S.live = false; S.room = null; S.send = null; S.ownRoom = false; S.role = null;
  S.pend.length = 0; S.buf.clear(); S.crc.clear(); S.seen.clear(); S.stalling.clear();
  S.met.clear(); S.gatherOn = 0;
  veil('');
  emit('stop', {});
}

// Alias: the sim's checkpoint hash, pushed straight in. Same entry the NET.onCRC hook uses.
export const reportCRC = localCRC;

export function status() {
  return {
    live: S.live, role: S.role, proto: PROTO, strategy: strategyName(), tickMode: S.tickMode,
    localIdx: S.localIdx, hostIdx: S.hostIdx, players: S.players.length,
    tick: S.tick, horizon: S.horizon, emitted: S.emitted,
    pending: S.pend.length, buffered: S.buf.size, gap: S.gapSince ? now() - S.gapSince : 0,
    paused: S.paused, ended: S.ended, desyncAt: S.desync,
    stalling: Array.from(S.stalling), gone: Array.from(S.gone),
    met: Array.from(S.met), gathering: !!S.gatherOn,
    lead: (() => { const N = sim(); return (N && typeof N.LEAD === 'number') ? N.LEAD : T.lead; })(),
  };
}

// Test hook — the ONLY way the drop/silence timers move. Accelerating them from a probe is the
// difference between a 30-second assertion and a 300-millisecond one; play never calls it.
export function setTimers(o) {
  for (const k of Object.keys(DEF)) if (o && typeof o[k] === 'number') T[k] = o[k];
  if (S.live) {
    if (S.wd) { clearInterval(S.wd); S.wd = setInterval(() => { sweep(); judgeCRC(); gateWatch(); gapWatch(); }, T.watchdog); }
    if (S.pmp) { clearInterval(S.pmp); S.pmp = setInterval(pump, T.pump); }
    if (S.hbT) { clearInterval(S.hbT); S.hbT = setInterval(hello, T.hb); }
  }
  return { ...T };
}

// ── the room code ───────────────────────────────────────────────────────────────────────────
// SECTION: NET carries `code` through the navigation as `?coop=CODE`, falling back to `?join=`
// on the way in. Both are read here too, because the transport is the half that has to survive
// the reload. `?coop=1` is the sentinel SECTION: NET writes when it had no code to carry —
// which today is every HOST, and is the one gap that needs a line in lobby.js (RECONCILIATION §5).
function roomCode(sess) {
  const clean = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let c = clean(sess && sess.code);
  if (!c) { try { c = clean(window.BFCoop && window.BFCoop.code); } catch (e) { /* */ } }
  if (!c) { const q = clean(P.get('coop')); if (q && q !== '1') c = q; }
  if (!c) c = clean(P.get('join'));
  return c.length === 5 ? c : '';
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────
// NOT a plain `bf-coop-start` listener, because that event does not mean "a run has begun" —
// SECTION: NET answers it by NAVIGATING, and this page is about to die. What actually means a
// run has begun, on BOTH sides of that navigation, is `NET.active` going true. So we watch for
// that instead, and the same three lines serve the no-navigation case and the post-reload case.
//
// The watch costs nothing on a solo boot: it is armed only by the co-op event or by a URL that
// already says co-op, and it stops itself the moment it succeeds or the band never comes.
let _armT = 0;
function armWatch(why) {
  if (SHOT || _armT || S.live) return;
  let n = 0;
  _armT = setInterval(() => {
    const N = sim();
    if (N && N.active && !S.live) {
      clearInterval(_armT); _armT = 0;
      const s = (typeof N.session === 'function') ? N.session() : null;
      start(s).catch((err) => console.warn('bfnet: session failed to start —', err && err.message));
      return;
    }
    if (++n > 600) { clearInterval(_armT); _armT = 0; }        // 60 s and no band: stand down
  }, 100);
  console.info('bfnet: watching for NET.active (' + why + ')');
}

if (!SHOT) {
  // Path 1 — the lobby fired and this page is not navigating away.
  document.addEventListener('bf-coop-start', () => armWatch('bf-coop-start'));
  // Path 2 — the far side of SECTION: NET's navigation. `?coop=` is its own marker.
  if (P.has('coop')) armWatch('?coop=');
}

// `window.BFNet` BELONGS TO SECTION: NET — game.js publishes the command layer under that name
// and the coop-rules stage reads it there. The transport lives next door, at `window.BFCoopNet`,
// and NEVER takes `BFNet` even when it is momentarily free. That is not politeness: game.js is a
// module with a top-level await, so it publishes `BFNet` LATE — this file has finished running
// long before it — and a "claim it if nobody has" fallback would therefore always fire, own the
// name for the whole of the boot, and then be silently replaced. Anything that read it in that
// window would have read the wrong object. There is one name for one thing.
export const TRANSPORT = {
  version: 1, PROTO, STR: NET_STR,
  start, stop, status, submit, setTimers, transport, roomCode,
  get strategy() { return strategyName(); },
  get room() { return S.room; },
  get sim() { return sim(); },
  feedTick, reportCRC: localCRC,
  // The lobby fetches its own transport with a bare `import('trystero')`, which cannot see
  // `?net=bc`. Until lobby.js routes through here (see RECONCILIATION §7) this is how a caller
  // gets a loopback room without one.
  bcStrategy: makeBcStrategy,
};
// Behind the SHOT guard like everything else in this file: the screenshot battery and the
// balance matrix are the two runs whose whole job is to look exactly like they did before co-op
// existed, and that includes the globals they can see.
if (!SHOT) try { window.BFCoopNet = TRANSPORT; } catch (e) { /* never fatal */ }

// ── RECONCILIATION WITH SECTION: NET (js/game.js) ───────────────────────────────────────────
// The command layer landed while this stage was building. Everything below was verified against
// the code, not assumed. The integrate stage CLOSED §5 and §7 (see their entries) and added §8.
//
//  1. NAMES. `window.BFNet` is SECTION: NET's — game.js publishes the command layer there. The
//     transport is `window.BFCoopNet`, and only falls back to `BFNet` when nothing claimed it.
//  2. WIRING. NET.onSubmit / NET.onCRC are SET by us; NET.recv / NET.setHorizon are CALLED by
//     us. CMD is { t, p, s, op, args } with `args` an ARRAY whose arity is NET.OPS[op].a — both
//     inbound paths (a guest's submit, a bundle's command) validate against it at the door.
//  3. THE CLOCK is NET.stamp() (= state.tick + NET.LEAD), read on a 25 ms pump. No second idea
//     of what tick it is exists anywhere in this file.
//  4. ORDER. The sequencer sorts by (p, s), which is byte-for-byte SECTION: NET's own `netCmp`
//     — so the host's bundle order and the receiver's queue order cannot disagree.
//  5. CLOSED (integrate stage). THE HOST CAN RE-DIAL. `get code() { return S.code; }` now sits
//     in js/lobby.js's window.BFCoop block beside `get room()`, so `roomCode()` finds the war-band
//     code on the far side of SECTION: NET's navigation and a captain no longer carries the bare
//     `?coop=1` sentinel. Regression-tested live rather than argued: tools/coopsmoke.mjs asserts
//     `smoke.host.carriedTheRoomCode` against the captain's post-navigation URL.
//  6. `inherit` IS NOT AN OP YET. GAME_SPEC_9 §B's drop rule is submitted as
//     `{op:'inherit', args:[fromIdx, toIdx]}`; NET.OPS has no such entry, so NET.recv drops it
//     as unknown — a clean no-op that leaves the towers standing. The coop-rules stage owns the
//     verb; the wire format above is what it will arrive as.
//  7. CLOSED (integrate stage). js/lobby.js's transport() now asks window.BFCoopNet.transport()
//     first and falls back to the bare import, so `?net=bc` reaches the lobby UI and the lobby and
//     the sequencer share ONE strategy instance and one selfId. That is what lets
//     tools/coopsmoke.mjs drive the real CREATE/JOIN/READY sheet over the loopback.
//  8. THE MUSTER GATE (integrate stage, and it is a RULE CHANGE, not a tidy-up). A captain now
//     seals no tick until every saddle has answered `hello`, and a saddle that has never spoken
//     is measured against T.muster rather than T.silent/T.drop. See bandPresent() above for the
//     failure it closes: without it the first rider back from the navigation was fine and every
//     later one held an unfillable hole at f=0 and never took a tick. Any future stage that makes
//     the host emit earlier than the gate has to bring a retransmit with it.
