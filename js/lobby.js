// ══════════════════════ SECTION: CO-OP LOBBY (owner: coop-lobby stage) ══════════════════════
// GAME_SPEC_9 §A — the serverless matchmaking screen. Host raises a war-band, gets a 5-char
// code and a `?join=CODE` summons; friends open the game anywhere, type the code, and the two
// tabs find each other over Trystero's public relays before every byte of play goes direct P2P.
//
// THIS MODULE OWNS NO SIMULATION. It negotiates who is playing, on which road, in which mode,
// at which trial — and then hands that over ONCE, as a DOM event, and gets out of the way.
//
// ── CONTRACT WITH SECTION: SIM / the coop-rules stage ───────────────────────────────────────
//  1. TITLE HOOK.  index.html ships `<button id="btnCoop">` on the title plinth, hidden. This
//     module unhides and wires it in live mode only. The rules stage must NOT re-wire it; if it
//     needs to open the lobby itself it calls `window.BFCoop.open()`.
//  2. START EVENT.  When the countdown ends the module dispatches on `document`:
//        new CustomEvent('bf-coop-start', { detail: {
//          seed:      <int 1000-9999>   the run seed, identical on every peer
//          map:       <int 1-5>         MAPS id
//          mode:      'camp'            (Endless/Horde co-op is v2 — see GAME_SPEC_9 §C)
//          diff:      'squire'|'knight'|'warlord'
//          players:   [ { id, name, idx, crest, host, ready } ]  host first, index order agreed
//          localIdx:  <int>             this browser's index into `players`
//        } })
//     The list is the SAME array, in the SAME order, on every peer — it is the host's
//     broadcast, not a local reconstruction — so `idx` is a legal player id for the command
//     layer's `CMD.player` field.
//  3. TRANSPORT HANDOFF.  `window.BFCoop.room` is the live Trystero room (or null). The netcode
//     stage takes it as-is and calls `room.makeAction(...)` for its own channels; the lobby only
//     ever claims the action names 'seat', 'lobby' and 'go'.
//  4. STRINGS.  `LOBBY_STR` (exported, and mirrored on `window.BF_LOBBY_STR`) is `{en:{},fr:{}}`
//     in game.js's own flat keyspace. The rules stage merges it into STR right after the `_w`
//     flatten loop in SECTION: CORE:
//          import { LOBBY_STR } from './lobby.js';
//          Object.assign(STR.en, LOBBY_STR.en); Object.assign(STR.fr, LOBBY_STR.fr);
//     …or, to keep game.js free of the import, `Object.assign(STR.en, window.BF_LOBBY_STR.en)`
//     guarded on presence. Until that merge lands the lobby localises itself off the same table
//     with the same key resolution, so nothing here reads as a raw key at any point.
//     NOTE: no `data-l` attribute anywhere in this feature's markup. `test=i18n` asserts every
//     data-l key resolves in STR.en, and these keys do not live there until the merge.
//  5. ROAD NAMES.  Optional: `window.BF_COOP_MAPS = [{ id, name, open }]`. When present the road
//     picker uses those names (and dims `open:false`); when absent it falls back to numbered
//     roads, so the lobby renders correctly standalone.
//
// ── INVARIANTS ──────────────────────────────────────────────────────────────────────────────
//  · SHOT/TESTQ: this file installs NOTHING. No listener, no DOM, no import, no timer. The whole
//    of boot() is behind `if (!SHOT)`, exactly like every other live-only writer in the build,
//    so the shot battery and the balance matrix cannot see that co-op exists.
//  · LAZY: #coopLobby ships EMPTY. Its markup is built on the first open and the 63 KB Trystero
//    bundle is fetched by a dynamic `import()` on the first CREATE/JOIN — never on a solo boot.
//  · NO Math.random. Room codes and the run seed come from crypto.getRandomValues (the project
//    bans Math.random outright, and a room code drawn from a predictable stream is a griefing
//    surface even outside the sim).
//  · The import is wrapped: with the vendor bundle absent the lobby still opens and says so.

// ── i18n ────────────────────────────────────────────────────────────────────────────────────
// French register matches the game's: medieval, terse, properly accented. "compagnie" carries
// WAR-BAND (a company of arms under one captain) and "cor" the war-horn the solo game sounds.
export const LOBBY_STR = {
en: {
  'coop.btn': 'CO-OP',
  'coop.kick': 'Hold the vale together',
  'coop.title': 'THE WAR BAND',
  'coop.lead': 'Two to four captains, one vale. No server stands between you — the game speaks browser to browser.',
  'coop.name': 'Your name',
  'coop.raise': 'Raise a war-band',
  'coop.join': 'Join a war-band',
  'coop.code': 'War-band code',
  'coop.enter': 'Enter the code you were sent',
  'coop.go': 'Ride out',
  'coop.copy': 'Copy the summons',
  'coop.copied': 'Summons copied',
  'coop.summons': 'Send this to your captains:',
  'coop.road': 'Road {0}',
  'coop.mapL': 'Road',
  'coop.modeL': 'Mode',
  'coop.diffL': 'Trial',
  'coop.camp': 'Campaign',
  'coop.endl': 'Endless',
  'coop.horde': 'Horde',
  'coop.v2': 'Campaign only in a war-band — for now',
  'coop.squire': 'Squire',
  'coop.knight': 'Knight',
  'coop.warlord': 'Warlord',
  'coop.squireT': 'A gentle road. The horde comes on thinner.',
  'coop.knightT': 'The road as it was written.',
  'coop.warlordT': 'Champions and captains come on far heavier.',
  'coop.ready': 'Ready',
  'coop.readyT': 'Tell the band you are ready to ride',
  'coop.standby': 'Standing by',
  'coop.unready': 'Stand down again',
  'coop.start': 'Sound the horn',
  'coop.empty': 'Empty saddle',
  'coop.you': 'you',
  'coop.captain': 'Captain',
  'coop.rider': 'Rider',
  'coop.waitBand': 'Waiting for the band — {0} of {1} ready',
  'coop.waitPeer': 'Waiting for riders. Send them the summons.',
  'coop.connecting': 'Calling across the vale…',
  'coop.failed': 'No band answered. Either the code has gone cold, or your network blocks the direct crossing — some routers and campus networks will not let two browsers speak. Try another network, or let the other captain host.',
  'coop.nolib': 'The co-op courier is missing from this build, so no band can be raised.',
  'coop.hostLeft': 'The captain has ridden off. The band is broken.',
  'coop.starting': 'The horn sounds in {0}…',
  'coop.badCode': 'A code is five letters and numbers.',
  'coop.back': '← Back',
  'coop.leave': '← Leave the band',
},
fr: {
  'coop.btn': 'COOPÉRATION',
  'coop.kick': 'Tenir la vallée ensemble',
  'coop.title': 'LA COMPAGNIE',
  'coop.lead': 'De deux à quatre capitaines, une seule vallée. Aucun serveur entre vous — le jeu parle de navigateur à navigateur.',
  'coop.name': 'Votre nom',
  'coop.raise': 'Lever une compagnie',
  'coop.join': 'Rejoindre une compagnie',
  'coop.code': 'Code de compagnie',
  'coop.enter': 'Saisissez le code reçu',
  'coop.go': 'En route',
  'coop.copy': 'Copier la convocation',
  'coop.copied': 'Convocation copiée',
  'coop.summons': 'Envoyez ceci à vos capitaines :',
  'coop.road': 'Route {0}',
  'coop.mapL': 'Route',
  'coop.modeL': 'Mode',
  'coop.diffL': 'Épreuve',
  'coop.camp': 'Campagne',
  'coop.endl': 'Sans fin',
  'coop.horde': 'La Horde',
  'coop.v2': 'Campagne seule en compagnie — pour l’instant',
  'coop.squire': 'Écuyer',
  'coop.knight': 'Chevalier',
  'coop.warlord': 'Seigneur de guerre',
  'coop.squireT': 'Une route clémente. La horde vient plus mince.',
  'coop.knightT': 'La route telle qu’elle fut écrite.',
  'coop.warlordT': 'Champions et capitaines viennent bien plus lourds.',
  'coop.ready': 'Prêt',
  'coop.readyT': 'Dites à la compagnie que vous êtes prêt à partir',
  'coop.standby': 'En attente',
  'coop.unready': 'Se retirer',
  'coop.start': 'Sonner du cor',
  'coop.empty': 'Selle vide',
  'coop.you': 'vous',
  'coop.captain': 'Capitaine',
  'coop.rider': 'Cavalier',
  'coop.waitBand': 'En attente de la compagnie — {0} sur {1} prêts',
  'coop.waitPeer': 'En attente de cavaliers. Envoyez-leur la convocation.',
  'coop.connecting': 'Appel à travers la vallée…',
  'coop.failed': 'Aucune compagnie n’a répondu. Soit le code est éteint, soit votre réseau bloque la liaison directe — certains routeurs et réseaux d’entreprise interdisent à deux navigateurs de se parler. Essayez un autre réseau, ou laissez l’autre capitaine héberger.',
  'coop.nolib': 'Le messager de coopération manque à cette version : aucune compagnie ne peut être levée.',
  'coop.hostLeft': 'Le capitaine est parti. La compagnie est rompue.',
  'coop.starting': 'Le cor sonne dans {0}…',
  'coop.badCode': 'Un code compte cinq lettres et chiffres.',
  'coop.back': '← Retour',
  'coop.leave': '← Quitter la compagnie',
},
};
try { window.BF_LOBBY_STR = LOBBY_STR; } catch (e) { /* never fatal */ }

const P = new URLSearchParams(location.search);
// The harness discipline, read exactly as SECTION: CORE reads it. Everything below the boot
// guard is unreachable when this is set.
const SHOT = P.get('shot') || (P.get('test') ? '__test__' : null);

const LANG_KEY = 'bannerfall.lang';
const LANG = (() => {
  const q = (P.get('lang') || '').toLowerCase();
  if (q === 'fr' || q === 'en') return q;
  if (SHOT) return 'en';
  try { const s = localStorage.getItem(LANG_KEY); if (s === 'fr' || s === 'en') return s; } catch (e) { /* private mode */ }
  return /^fr/i.test(navigator.language || '') ? 'fr' : 'en';
})();
// Same shape as game.js's L(): per-key English fallback, and a missing key prints as the key
// rather than as blank, because a blank label is a bug that hides and a key is a bug report.
const L = (k, ...a) => {
  let s = LOBBY_STR[LANG][k];
  if (s === undefined) s = LOBBY_STR.en[k];
  if (s === undefined) return k;
  return a.length ? s.replace(/\{(\d)\}/g, (m, i) => (a[i] === undefined ? m : a[i])) : s;
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── room codes ──────────────────────────────────────────────────────────────────────────────
// 32 glyphs, and the four that a player would mistype off a phone screen or a voice call are
// not among them: I/1 and O/0. 32 divides 256 exactly, so masking a random byte with 31 is
// uniform — no modulo bias, no rejection loop.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const APP_ID = 'bannerfall';
const rand = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
const newCode = () => { let s = ''; for (const x of rand(5)) s += ALPHA[x & 31]; return s; };
// The run seed lives in the same 1000-9999 domain SECTION: CORE draws a solo war seed from, so
// a co-op run's seed tag reads like every other run's and `&seed=` round-trips it.
const newSeed = () => 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
const NAMES = ['Aldric', 'Brannoc', 'Cadfael', 'Dunstan', 'Eirik', 'Godric', 'Hakon', 'Ivar',
  'Leofric', 'Maerwyn', 'Osric', 'Rowan', 'Sigrun', 'Torvald', 'Ulric', 'Wystan'];

// ── heraldry ────────────────────────────────────────────────────────────────────────────────
// A seat is a CREST, not a colour swatch: §3's crimson belongs to the horde, so the four
// player tinctures are the heraldic four the banner-work already uses — azure, vert, purpure,
// or — each with its own charge, so the roster survives a colour-blind reading and a 20px pip.
const TINCT = [['#3f74bd', '#16305c'], ['#4e9152', '#1c4024'], ['#8163b4', '#372357'], ['#d8a94b', '#7a5312']];
const CHARGE = [
  '<path d="M4.6 19.2l7.4-5.4 7.4 5.4v3.2L12 17.2 4.6 22.4z" fill="#f4e2b4"/>',
  '<path d="M10.3 5.8h3.4V11h5.2v3.4h-5.2v6.4h-3.4v-6.4H5.1V11h5.2z" fill="#f4e2b4"/>',
  '<path d="M12 5.6l5 6.9-5 6.9-5-6.9z" fill="#f4e2b4"/>',
  '<g fill="#f4e2b4"><circle cx="8.1" cy="10" r="2.5"/><circle cx="15.9" cy="10" r="2.5"/><circle cx="12" cy="17" r="2.5"/></g>',
];
const SHIELD = 'M2.2 2.2h19.6v14.2c0 7.4-6.1 10.2-9.8 11.4C8.3 26.6 2.2 23.8 2.2 16.4z';
const crest = (i) => {
  const t = TINCT[i & 3];
  return '<svg class="clCr" viewBox="0 0 24 28" aria-hidden="true">' +
    '<path d="' + SHIELD + '" fill="' + t[0] + '"/>' +
    '<path d="M2.2 16.4c0 7.4 6.1 10.2 9.8 11.4 3.7-1.2 9.8-4 9.8-11.4z" fill="' + t[1] + '" opacity=".55"/>' +
    CHARGE[i & 3] +
    '<path d="' + SHIELD + '" fill="none" stroke="#e8b64c" stroke-width="1.6"/></svg>';
};

// ── lobby state ─────────────────────────────────────────────────────────────────────────────
// `net` is the whole state machine GAME_SPEC_9 §A asks for, in one field:
//   idle → connecting → live → starting        (the happy road)
//                     ↘ failed | nolib | hostleft
const S = {
  built: false, open: false, view: 'home', role: null,
  net: 'idle', code: '', seed: 0, map: 1, mode: 'camp', diff: 'knight',
  name: '', ready: false, selfId: 'me', hostId: null,
  room: null, send: null, tryst: undefined, peers: new Map(), players: [],
  count: 0, ct: 0, to: 0, go: null, copied: false,
};

const NAME_KEY = 'bannerfall.coop.name';
const loadName = () => {
  try { const s = localStorage.getItem(NAME_KEY); if (s) return s.slice(0, 14); } catch (e) { /* private mode */ }
  return NAMES[rand(1)[0] & 15];
};
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* private mode */ } };

const ROADS = () => (Array.isArray(window.BF_COOP_MAPS) && window.BF_COOP_MAPS.length
  ? window.BF_COOP_MAPS.slice(0, 5)
  : [1, 2, 3, 4, 5].map(id => ({ id, name: L('coop.road', ['', 'I', 'II', 'III', 'IV', 'V'][id]), open: true })));

// ── markup, built once on the first open ────────────────────────────────────────────────────
function build() {
  if (S.built) return;
  const r = $('coopLobby'); if (!r) return;
  S.built = true;
  S.name = loadName();
  r.innerHTML =
    '<div id="clKick">' + esc(L('coop.kick')) + '</div>' +
    '<h2 id="clT">' + esc(L('coop.title')) + '</h2>' +
    '<div id="clRule" class="rule"></div>' +
    '<div id="clPlate" class="iron frmB">' +

      '<p id="clLead">' + esc(L('coop.lead')) + '</p>' +
      // The name is asked ONCE, above the views rather than inside one, because a player who
      // arrived on a `?join=` summons lands straight on the JOIN sheet and would otherwise have
      // no way to say who they are before the roster shows them to three strangers.
      '<div id="clNameRow"><label for="clName">' + esc(L('coop.name')) + '</label>' +
        '<input id="clName" type="text" maxlength="14" autocomplete="off" spellcheck="false"></div>' +

      // ── HOME ─────────────────────────────────────────────────────────
      '<div id="clHome" class="clV">' +
        '<button id="btnClCreate" class="clBig">' + esc(L('coop.raise')) + '</button>' +
        '<button id="btnClJoin" class="clBig sec">' + esc(L('coop.join')) + '</button>' +
      '</div>' +

      // ── JOIN (code entry) ────────────────────────────────────────────
      '<div id="clEntry" class="clV">' +
        '<label id="clInL" for="clIn">' + esc(L('coop.enter')) + '</label>' +
        '<input id="clIn" type="text" maxlength="5" autocomplete="off" spellcheck="false" ' +
          'autocapitalize="characters" inputmode="text" aria-describedby="clInErr">' +
        '<div id="clInErr" class="clErr"></div>' +
        '<button id="btnClGo" class="clBig">' + esc(L('coop.go')) + '</button>' +
      '</div>' +

      // ── ROOM (host and guest share it; role gates the pickers) ───────
      '<div id="clRoom" class="clV">' +
        '<div id="clCodeRow">' +
          '<div class="clCodeB"><em>' + esc(L('coop.code')) + '</em><b id="clCode">—</b></div>' +
          '<button id="btnClCopy" class="clChip">' + esc(L('coop.copy')) + '</button>' +
        '</div>' +
        '<div id="clLinkRow"><em>' + esc(L('coop.summons')) + '</em><code id="clLink"></code></div>' +
        '<ul id="clRoster"></ul>' +
        '<div id="clPicks">' +
          '<div class="clPk" data-k="map"><em>' + esc(L('coop.mapL')) + '</em><div class="clCs"></div></div>' +
          '<div class="clPk" data-k="mode"><em>' + esc(L('coop.modeL')) + '</em><div class="clCs"></div></div>' +
          '<div class="clPk" data-k="diff"><em>' + esc(L('coop.diffL')) + '</em><div class="clCs"></div></div>' +
        '</div>' +
        '<div id="clStatus" role="status" aria-live="polite"></div>' +
        '<div id="clActs">' +
          '<button id="btnClReady" class="clBig sec"></button>' +
          '<button id="btnClStart" class="clBig">' + esc(L('coop.start')) + '</button>' +
        '</div>' +
      '</div>' +

    '</div>' +
    '<div id="clFoot"><button id="btnClBack" class="frm">' + esc(L('coop.back')) + '</button></div>';

  buildPicks();

  const nm = $('clName');
  nm.value = S.name;
  nm.addEventListener('input', () => {
    S.name = nm.value.replace(/[<>&"']/g, '').slice(0, 14) || NAMES[0];
    saveName(S.name); pushSeat();
  });

  $('btnClCreate').addEventListener('click', () => host());
  $('btnClJoin').addEventListener('click', () => { S.view = 'join'; render(); const i = $('clIn'); if (i) i.focus(); });
  $('btnClGo').addEventListener('click', () => tryJoin());
  $('clIn').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    $('clInErr').textContent = '';
  });
  $('clIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
  $('btnClCopy').addEventListener('click', () => copySummons());
  $('btnClReady').addEventListener('click', () => { S.ready = !S.ready; pushSeat(); render(); });
  $('btnClStart').addEventListener('click', () => launch());
  $('btnClBack').addEventListener('click', () => back());
  $('clPlate').addEventListener('scroll', scrollCue, { passive: true });
  addEventListener('resize', scrollCue);
}

// The three picker rails. Modes past Campaign are SHOWN and locked rather than hidden: a player
// has to be able to see that a mode exists before co-op earns it (GAME_SPEC_9 §C puts Endless
// and Horde co-op in v2), the same reading the map card's mode chips already ship with.
function buildPicks() {
  const rails = {
    map: ROADS().map(m => ({ v: String(m.id), t: m.name, lk: m.open === false, tip: m.name })),
    mode: [{ v: 'camp', t: L('coop.camp') }, { v: 'endl', t: L('coop.endl'), lk: true, tip: L('coop.v2') },
           { v: 'horde', t: L('coop.horde'), lk: true, tip: L('coop.v2') }],
    diff: ['squire', 'knight', 'warlord'].map(d => ({ v: d, t: L('coop.' + d), tip: L('coop.' + d + 'T') })),
  };
  for (const k in rails) {
    const box = document.querySelector('#clPicks .clPk[data-k="' + k + '"] .clCs');
    box.innerHTML = rails[k].map(c => '<button class="clC' + (c.lk ? ' lk' : '') + '" data-v="' + esc(c.v) + '"' +
      (c.tip ? ' title="' + esc(c.tip) + '"' : '') + '>' + esc(c.t) + '</button>').join('');
    for (const b of box.children) b.addEventListener('click', () => {
      if (S.role !== 'host' || b.classList.contains('lk')) return;
      S[k] = k === 'map' ? +b.dataset.v : b.dataset.v;
      pushLobby(); render();
    });
  }
}

// ── render ──────────────────────────────────────────────────────────────────────────────────
function render() {
  const r = $('coopLobby'); if (!r || !S.built) return;
  r.dataset.view = S.view;
  r.dataset.role = S.role || 'none';
  r.dataset.net = S.net;

  $('btnClBack').textContent = S.room ? L('coop.leave') : L('coop.back');
  // rAF-deferred, so it reads the layout this pass produces no matter where it is called from
  // — and it has to run on the home and join sheets too, or a `.scr` left over from the room
  // sheet would paint a chevron on a sheet with nothing under the fold.
  scrollCue();
  if (S.view !== 'room') return;

  $('clCode').textContent = S.code || '—';
  $('clLink').textContent = shareURL();
  $('btnClCopy').textContent = S.copied ? L('coop.copied') : L('coop.copy');
  $('btnClCopy').classList.toggle('on', S.copied);

  for (const b of document.querySelectorAll('#clPicks .clC'))
    b.classList.toggle('on', b.dataset.v === String(S[b.parentElement.parentElement.dataset.k]));

  drawRoster();

  const n = S.players.length, rdy = S.players.filter(p => p.ready).length;
  let msg = '';
  if (S.net === 'connecting') msg = L('coop.connecting');
  else if (S.net === 'failed') msg = L('coop.failed');
  else if (S.net === 'nolib') msg = L('coop.nolib');
  else if (S.net === 'hostleft') msg = L('coop.hostLeft');
  else if (S.net === 'starting') msg = L('coop.starting', S.count);
  else if (n < 2) msg = L('coop.waitPeer');
  else msg = L('coop.waitBand', rdy, n);
  $('clStatus').textContent = msg;

  // The label states the STATE and the plate states whether it is struck — never the reverse.
  // A latched gold button reading "Stand down" says two opposite things at once: the fill says
  // you are ready and the word says you are not. The check mark and the gold carry the latch;
  // the tooltip carries what a second press would do.
  const rb = $('btnClReady');
  rb.textContent = L('coop.ready');
  rb.title = S.ready ? L('coop.unready') : L('coop.readyT');
  rb.classList.toggle('on', S.ready);
  rb.disabled = S.net === 'starting' || S.net === 'hostleft';

  const sb = $('btnClStart');
  sb.disabled = !(S.role === 'host' && S.net === 'live' && n >= 2 && rdy === n);
}

// The phone's sheet is a bounded scroller (main.css, the max-width:760 block) and the two calls
// at its foot are the whole point of the screen, so it needs the same honest cue #settings
// wears: `.scr` ONLY when the content genuinely overflows, `.atEnd` the moment it is read out.
// Measured after a paint, because the roster and the picker rails are written by this same
// render pass and scrollHeight before layout is the previous frame's answer.
function scrollCue() {
  const p = $('clPlate'); if (!p) return;
  requestAnimationFrame(() => {
    const over = p.scrollHeight > p.clientHeight + 1;
    p.classList.toggle('scr', over);
    p.classList.toggle('atEnd', !over || p.scrollTop + p.clientHeight >= p.scrollHeight - 2);
  });
}

function drawRoster() {
  let h = '';
  for (let i = 0; i < 4; i++) {
    const p = S.players[i];
    if (!p) { h += '<li class="clP em"><span class="clCrW"></span><span class="clN">' + esc(L('coop.empty')) + '</span></li>'; continue; }
    h += '<li class="clP' + (p.ready ? ' rdy' : '') + (p.id === S.selfId ? ' me' : '') + '">' +
      '<span class="clCrW">' + crest(p.crest) + '</span>' +
      '<span class="clN">' + esc(p.name) + (p.id === S.selfId ? '<u>' + esc(L('coop.you')) + '</u>' : '') + '</span>' +
      '<span class="clTag">' + esc(p.host ? L('coop.captain') : L('coop.rider')) + '</span>' +
      '<i class="clPip" title="' + esc(p.ready ? L('coop.ready') : L('coop.standby')) + '"></i></li>';
  }
  $('clRoster').innerHTML = h;
}

const shareURL = () => location.origin + location.pathname + '?join=' + (S.code || '');

async function copySummons() {
  const t = shareURL();
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; } catch (e) { /* insecure context, or denied */ }
  if (!ok) {
    // The clipboard API is gated on a secure context and on permission; the summons is printed
    // in full under the code either way, so the fallback only has to try, never to succeed.
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
    } catch (e) { /* nothing else to try */ }
  }
  S.copied = ok; render();
  if (ok) setTimeout(() => { S.copied = false; render(); }, 2400);
}

// ── transport ───────────────────────────────────────────────────────────────────────────────
// The one place the 63 KB Trystero bundle is fetched, and it is fetched no earlier than the
// click that needs it. `null` is a first-class answer: with the vendor file absent (or the
// import map not carrying it yet) the lobby still opens, still renders, and says so.
async function transport() {
  if (S.tryst !== undefined) return S.tryst;
  try { S.tryst = await import('trystero'); }
  catch (e) { S.tryst = null; console.warn('co-op: trystero unavailable —', e && e.message); }
  return S.tryst;
}

// ── the two shapes Trystero has shipped ─────────────────────────────────────────────────────
// VERIFIED against the vendored 0.25.4 bundle, because the two generations of this API differ
// in a way that throws rather than degrades — and a throw inside an async click handler is an
// unhandled rejection, which in this game sets `document.title = 'ERROR'`, the harness's own
// failure marker. So none of it is assumed:
//   0.25  room.makeAction(n)  -> { send(data, opts), get/set onMessage }   ← PROPERTY, not call
//         room.onPeerJoin / onPeerLeave                                     ← PROPERTY, not call
//         handler signature    (payload, { peerId, ...metadata })           ← OBJECT, not string
//   ≤0.21 room.makeAction(n)  -> [ send, onMessage ]   (tuple, both functions)
//         room.onPeerJoin(fn)                          (call)
//         handler signature    (payload, peerId)       (string)
// One adapter each, so re-pinning the vendor bundle cannot silently break the lobby.
const act = (room, name) => {
  const a = room.makeAction(name);
  if (Array.isArray(a)) return { send: a[0], on: a[1] };
  return { send: (d) => a.send(d), on: (fn) => { a.onMessage = fn; } };
};
const onPeer = (room, key, fn) => {
  if (typeof room[key] === 'function') room[key](fn); else room[key] = fn;
};
// 0.25 hands the sender as `{peerId}`; ≤0.21 handed the id itself.
const pid = (m) => (m && typeof m === 'object' && m.peerId) ? m.peerId : m;

async function connect(role, code) {
  S.role = role; S.code = code; S.view = 'room'; S.net = 'connecting'; S.copied = false;
  S.peers.clear(); S.players = []; S.ready = false;
  render();

  const T = await transport();
  if (!T) { S.net = 'nolib'; render(); return; }

  let room;
  try { room = T.joinRoom({ appId: APP_ID }, 'bf-' + code); }
  catch (e) { console.warn('co-op: joinRoom refused —', e && e.message); S.net = 'failed'; render(); return; }
  S.room = room; S.selfId = T.selfId;

  const aSeat = act(room, 'seat'), aLobby = act(room, 'lobby'), aGo = act(room, 'go');
  const onSeat = aSeat.on, onLobby = aLobby.on, onGo = aGo.on;
  S.send = { seat: aSeat.send, lobby: aLobby.send, go: aGo.send };

  if (role === 'host') {
    S.hostId = S.selfId; S.seed = newSeed(); S.net = 'live';
    rebuildRoster(); pushLobby();
    onPeer(room, 'onPeerJoin', (id) => {
      if (S.peers.size >= 3) return;                      // 4 seats, host included
      S.peers.set(id, { id, name: L('coop.rider'), ready: false });
      rebuildRoster(); pushLobby(); render();
    });
    onPeer(room, 'onPeerLeave', (id) => { S.peers.delete(id); rebuildRoster(); pushLobby(); render(); });
    onSeat((d, m) => {
      const p = S.peers.get(pid(m)); if (!p || !d) return;
      if (typeof d.name === 'string') p.name = d.name.slice(0, 14) || L('coop.rider');
      p.ready = !!d.ready;
      rebuildRoster(); pushLobby(); render();
    });
  } else {
    // A guest is silent until the host answers. If nothing answers inside 20 s the code is cold
    // or the two networks cannot be bridged without a TURN relay (GAME_SPEC_9 §A.2) — which is
    // exactly the case that has to say so in words rather than spin forever.
    onPeer(room, 'onPeerJoin', () => pushSeat());
    onPeer(room, 'onPeerLeave', (id) => { if (id === S.hostId) { S.net = 'hostleft'; render(); } });
    onLobby((d) => {
      if (!d || !Array.isArray(d.players)) return;
      clearTimeout(S.to);
      S.net = S.net === 'starting' ? 'starting' : 'live';
      S.hostId = d.host; S.seed = d.seed; S.map = d.map; S.mode = d.mode; S.diff = d.diff;
      S.players = d.players;
      const me = d.players.find(p => p.id === S.selfId);
      if (me) S.ready = !!me.ready;
      render();
    });
    onGo((d) => { if (d && Array.isArray(d.players)) countdown(d); });
    pushSeat();
    S.to = setTimeout(() => { if (S.net === 'connecting') { S.net = 'failed'; render(); } }, 20000);
  }
  render();
}

// The host's roster IS the roster: one ordered array, broadcast whole, so `idx` means the same
// thing in every tab and the command layer can address a player by it.
function rebuildRoster() {
  const list = [{ id: S.selfId, name: S.name, ready: S.ready, host: true }];
  for (const p of S.peers.values()) list.push({ id: p.id, name: p.name, ready: !!p.ready, host: false });
  S.players = list.slice(0, 4).map((p, i) => ({ ...p, idx: i, crest: i }));
}

function pushLobby() {
  if (S.role !== 'host' || !S.send) return;
  S.send.lobby({ host: S.selfId, seed: S.seed, map: S.map, mode: S.mode, diff: S.diff, players: S.players });
}
function pushSeat() {
  if (!S.send) { if (S.role === 'host') { rebuildRoster(); pushLobby(); } return; }
  if (S.role === 'host') { rebuildRoster(); pushLobby(); return; }
  S.send.seat({ name: S.name, ready: S.ready });
}

// connect() is async and is called from a click handler, so ANY throw inside it would surface
// as an unhandled rejection — and SECTION: CORE's global handler turns one of those into
// `document.title = 'ERROR'`, which is the harness's own failure marker. It cannot be allowed
// to escape: a transport that misbehaves is a `failed` state with words in it, not a page error.
const start = (role, code) => connect(role, code).catch((e) => {
  console.warn('co-op: lobby transport failed —', e && e.message);
  S.net = 'failed'; render();
});

function host() { start('host', newCode()); }

function tryJoin() {
  const v = ($('clIn').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 5) { $('clInErr').textContent = L('coop.badCode'); return; }
  start('guest', v);
}

// ── launch ──────────────────────────────────────────────────────────────────────────────────
function launch() {
  if (S.role !== 'host') return;
  const d = { seed: S.seed, map: S.map, mode: S.mode, diff: S.diff, players: S.players };
  if (S.send) S.send.go(d);
  countdown(d);
}

function countdown(d) {
  S.go = d; S.net = 'starting'; S.count = 3; render();
  clearInterval(S.ct);
  S.ct = setInterval(() => {
    S.count--;
    if (S.count > 0) { render(); return; }
    clearInterval(S.ct); S.ct = 0; fire(d);
  }, 1000);
}

function fire(d) {
  const i = d.players.findIndex(p => p.id === S.selfId);
  const detail = { seed: d.seed, map: d.map, mode: d.mode, diff: d.diff,
    players: d.players, localIdx: i < 0 ? 0 : i };
  hide();
  // The ONE handoff. Everything after this belongs to the command layer; the lobby keeps the
  // room open on window.BFCoop.room and touches nothing else.
  document.dispatchEvent(new CustomEvent('bf-coop-start', { detail }));
}

// ── open / close ────────────────────────────────────────────────────────────────────────────
function show() {
  build();
  const r = $('coopLobby'); if (!r) return;
  S.open = true;
  const t = $('title'); if (t) t.classList.add('hidden');
  r.classList.remove('hidden');
  r.removeAttribute('aria-hidden');
  render();
}
function hide() {
  const r = $('coopLobby'); if (!r) return;
  S.open = false;
  r.classList.add('hidden');
  r.setAttribute('aria-hidden', 'true');
}
function back() {
  if (S.room) { leave(); S.view = 'home'; render(); return; }
  hide();
  const t = $('title'); if (t) t.classList.remove('hidden');
}
function leave() {
  clearTimeout(S.to); clearInterval(S.ct); S.ct = 0;
  try { if (S.room && S.room.leave) S.room.leave(); } catch (e) { /* already gone */ }
  S.room = null; S.send = null; S.role = null; S.net = 'idle';
  S.peers.clear(); S.players = []; S.ready = false; S.code = ''; S.go = null;
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────
// EVERYTHING is behind this guard. Under `?shot=` or `?test=` not one listener is attached, not
// one node is written and #btnCoop stays hidden — so the shot battery frames the title plinth
// exactly as it did before co-op existed, and the balance matrix cannot see this file at all.
function boot() {
  const btn = $('btnCoop');
  if (btn) {
    btn.textContent = L('coop.btn');
    btn.title = L('coop.title');
    btn.classList.remove('hidden');
    // The same gate #btnPlay keeps: the world has to exist before a war-band can march on it,
    // and `html.booting` is SECTION: CORE's own published read-out of that.
    btn.addEventListener('click', () => {
      if (document.documentElement.classList.contains('booting')) return;
      show();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.open && S.net !== 'starting') back();
  });

  // `?join=CODE` — the summons. It opens the lobby on the JOIN sheet with the code already in,
  // but it waits for the boot bar first: `html.booting` hides every child of #ui but #title.
  const j = (P.get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (j.length === 5) {
    let n = 0;
    const t = setInterval(() => {
      if (++n > 600) { clearInterval(t); return; }
      if (document.documentElement.classList.contains('booting')) return;
      clearInterval(t);
      show(); S.view = 'join'; render();
      const i = $('clIn'); if (i) { i.value = j; i.focus(); }
    }, 200);
  }
}

if (!SHOT) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

// The handle the coop-rules / netcode stages take the transport from. Read-only by design: the
// lobby owns the room's lifetime, and a stage that wants the lobby open asks for it by name.
try {
  window.BFCoop = {
    version: 1,
    STR: LOBBY_STR,
    get room() { return S.room; },
    get session() { return S.go; },
    get localIdx() { return S.go ? S.go.players.findIndex(p => p.id === S.selfId) : -1; },
    open: show, close: hide, leave,
  };
} catch (e) { /* never fatal */ }
