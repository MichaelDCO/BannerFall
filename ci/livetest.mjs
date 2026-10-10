// AUDIT-1 T7-04 — THE LIVE SUITE: run save/restore and the deeds ledger.
//
// Both systems refuse to run under ?test= by design (runSave/runSnap/runRestore and every deed
// hook are SHOT-gated — SECTION: TEST's harness.persistenceGatedUnderShot pins that), so no
// in-page suite can reach them. This drives LIVE pages instead: `?dbg=1` (which exposes
// window.G and nothing else — no override that would change what is saved) in a FRESH profile
// per phase, over CDP, and asserts on the real localStorage records and on what a reloaded page
// rebuilds from them.
//
//   node ci/livetest.mjs               # prints LIVE PASS/FAIL lines and LIVESUM; exit 1 on any FAIL
//                                      # (needs a server at BF_BASE; ci/test.mjs provides one)
//
// Chrome binds a free CDP port (--remote-debugging-port=0, read back from DevToolsActivePort),
// so this can run beside any other tool. Covered: save -> reload -> restore of the garrison,
// purse, wave and lives; the mid-wave horn rollback (GC-03); snapshot validation and runFits;
// runClear; the trigger of 28 of the 31 deeds (24 granted: all ten counters, the bestiary, the muster
// mark, flawless, wind, omen incl. the replayed-wave rule (GC-12), and nine derived campaign deeds;
// s2..s5 share s1's rule and are asserted NOT granted on a one-star record) plus
// their persistence across a reload and their laurel. NOT covered here: `thousand` (a 1000-body
// horde on a non-mobile tier), `tide` (a broken horde) and `ashes` (the Barrow King's finale
// with no rise) need whole runs; the balance bot is the place for them.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WebSocket = globalThis.WebSocket && !process.env.BF_WS_SHIM ? globalThis.WebSocket : (await import('./ws.mjs')).default;   // Node 20: ci/ws.mjs

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BF_BASE || 'http://127.0.0.1:8321/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOW = Math.max(1, +(process.env.BF_SLOW || 1));   // boot-wait multiplier for software GL (CI)
let total = 0, fails = 0;
const A = (name, ok, why) => { total++; if (ok) console.log('LIVE PASS ' + name); else { fails++; console.log('LIVE FAIL ' + name + (why ? ' - ' + why : '')); } };

async function browser() {
  const profile = mkdtempSync(join(tmpdir(), 'bflive-'));
  const proc = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', '--window-size=1000,700', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, ...(process.env.CHROME_EXTRA || '').split(/\s+/).filter(Boolean), 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) {
    try { const l = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); if (/^\d+$/.test(l)) port = +l; } catch { }
    if (!port) await sleep(100);
  }
  if (!port) throw new Error('DevToolsActivePort never appeared');
  let tgt = null;
  for (let i = 0; i < 100 && !tgt; i++) {
    try { tgt = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { }
    if (!tgt) await sleep(100);
  }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pend = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __threw: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms) => { const dl = Date.now() + ms; for (;;) { if (await ev(expr) === true) return true; if (Date.now() > dl) return false; await sleep(200); } };
  await send('Runtime.enable');
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(400); };
  const close = async () => { try { ws.close(); } catch { } proc.kill(); await sleep(600); try { rmSync(profile, { recursive: true, force: true }); } catch { } };
  return { ev, until, go, close, logs };
}
const READY = '!!(window.G && G.state && G.state.phase === "prewave" && !document.documentElement.classList.contains("booting"))';
const ERRS = 'JSON.stringify((window.__errors || []).slice(0, 3))';

// ── PHASE 1: run save / restore ──────────────────────────────────────────────────────────────
async function saveRestore() {
  const b = await browser();
  try {
    await b.go(BASE + '?dbg=1&map=1&auto=1');
    A('save.booted', await b.until(READY, 120000 * SLOW), 'never reached prewave');
    const s1 = await b.ev(`(() => { const s = G.state;
      const lives0 = s.lives, wave0 = s.wave;
      G.placeTower(32, -31, 'archer', 1, true); s.gold = 777;
      const ok = G.runSave(true);
      const snap = JSON.parse(localStorage.getItem('bannerfall.run') || 'null');
      return { ok, lives0, wave0, snap }; })()`);
    const sn = s1.snap || {};
    A('save.prewave.writes', s1.ok === true && !!s1.snap, JSON.stringify(s1).slice(0, 200));
    A('save.prewave.shape', sn.v === 1 && sn.map === 1 && sn.mode === 'campaign' && Array.isArray(sn.tw) && sn.tw.length === 1 &&
      sn.tw[0][2] === 'archer' && sn.tw[0][0] === 32 && sn.tw[0][1] === -31 && sn.gold === 777 && sn.lives === s1.lives0 &&
      sn.wave === s1.wave0 && Array.isArray(sn.dd) && sn.dd.length === 4 && Array.isArray(sn.tal), JSON.stringify(sn).slice(0, 240));
    // the horn: a mid-wave toggle save rolls the wave back and keeps the PRE-horn purse (GC-03)
    const s2 = await b.ev(`(() => { const s = G.state; const w = s.wave;
      const called = G.callWave(); const mid = s.phase; const goldAfterHorn = s.gold;
      const ok = G.runSave(true); const snap = JSON.parse(localStorage.getItem('bannerfall.run'));
      return { called, mid, w, goldAfterHorn, ok, wave: snap.wave, gold: snap.gold, tw: snap.tw.length }; })()`);
    A('save.midwave.rollsBackTheHorn', s2.called === true && s2.mid === 'wave' && s2.ok === true && s2.wave === s2.w &&
      s2.gold === 777 && s2.tw === 1, JSON.stringify(s2));
    A('save.refusedOutsideABoundary', await b.ev('G.runSave(false) === false'), 'a non-toggle save mid-wave must refuse');
    A('save.noPageErrors', await b.ev('(window.__errors || []).length === 0'), await b.ev(ERRS));
    // reload on the snapshot's identity: the restore runs in MAIN's boot pipeline
    await b.go(BASE + '?dbg=1&map=1&resume=1&seed=' + sn.seed);
    A('restore.booted', await b.until(READY + ' && G.towersList.length > 0', 120000 * SLOW), 'restore never reached prewave with a garrison');
    const r = await b.ev(`(() => { const s = G.state, t = G.towersList;
      return { n: t.length, type: t[0] && t[0].type, x: t[0] && t[0].x, z: t[0] && t[0].z, gold: s.gold, wave: s.wave,
        lives: s.lives, phase: s.phase, errs: (window.__errors || []).length }; })()`);
    A('restore.garrison', r.n === 1 && r.type === 'archer' && Math.abs(r.x - 32) < 1e-3 && Math.abs(r.z + 31) < 1e-3, JSON.stringify(r));
    A('restore.purseWaveLives', r.gold === 777 && r.wave === s2.w && r.lives === s1.lives0 && r.phase === 'prewave', JSON.stringify(r));
    A('restore.noPageErrors', r.errs === 0, await b.ev(ERRS));
    // validation: a snapshot that does not fit / is dead / is gone is never offered
    const v = await b.ev(`(() => { const raw = localStorage.getItem('bannerfall.run'); const s = G.runSnap();
      const fits = G.runFits(s), otherSeed = G.runFits(Object.assign({}, s, { seed: (s.seed + 1) >>> 0 })),
        otherMap = G.runFits(Object.assign({}, s, { map: 2 }));
      localStorage.setItem('bannerfall.run', JSON.stringify(Object.assign(JSON.parse(raw), { lives: 0 }))); const dead = G.runSnap();
      localStorage.setItem('bannerfall.run', JSON.stringify(Object.assign(JSON.parse(raw), { v: 999 }))); const future = G.runSnap();
      localStorage.setItem('bannerfall.run', JSON.stringify(Object.assign(JSON.parse(raw), { tw: [[1, 2, 'nosuchtower', 1, 'first']] })));
      const junkTw = G.runSnap();
      localStorage.setItem('bannerfall.run', raw); G.runClear();
      return { fits, otherSeed, otherMap, dead, future, junkTw: junkTw && junkTw.tw.length, cleared: localStorage.getItem('bannerfall.run') === null && G.runSnap() === null }; })()`);
    A('snap.fitsItsOwnPage', v.fits === true, JSON.stringify(v));
    A('snap.otherSeedOrMapDoesNotFit', v.otherSeed === false && v.otherMap === false, JSON.stringify(v));
    A('snap.deadOrFutureRejected', v.dead === null && v.future === null, JSON.stringify(v));
    A('snap.unknownTowerDropped', v.junkTw === 0, JSON.stringify(v));
    A('snap.runClear', v.cleared === true, JSON.stringify(v));
  } finally { await b.close(); }
}

// ── PHASE 2: deeds ───────────────────────────────────────────────────────────────────────────
// Thresholds are the SPEC6 §C / SPEC_8 §F design numbers; a change to one is a design change
// and should be made here on purpose.
const COUNTED = { pyre: ['burn', 100], storm: ['storm', 500], steel: ['steel', 300], trap: ['trap', 150],
  sky: ['wyv', 100], hand: ['power', 75], champ: ['champ', 25], twice: ['risen', 200], chain: ['hex', 10], frost: ['slow', 500] };
const BESTIARY = ['grunt', 'runner', 'brute', 'shield', 'hound', 'marauder', 'ogre', 'ironclad', 'ashwraith', 'frostrevenant',
  'warshaman', 'ram', 'wyvern', 'gravemold', 'moldling', 'necromancer', 'skeleton', 'wardedone', 'cutpurse', 'hexbinder',
  'dunestalker', 'charger', 'rimeborntroll', 'boss', 'matriarch', 'emberlord', 'cinderqueen', 'barrowking', 'flanklord'];
async function deeds() {
  const b = await browser();
  try {
    await b.go(BASE + '?dbg=1&map=1&auto=1');
    A('deeds.booted', await b.until(READY, 120000 * SLOW), 'never reached prewave');
    const ids = await b.ev('G.DEEDS.map(d => d[0])');
    A('deeds.table.31', Array.isArray(ids) && ids.length === 31 && Object.keys(COUNTED).every((k) => ids.includes(k)),
      'ids=' + JSON.stringify(ids));
    A('deeds.freshProfileIsEmpty', await b.ev('G.deedCount() === 0 && G.laurelsEarned() === 0'), 'a fresh profile must start at zero');
    // 1. the DERIVED campaign deeds, off a staged record (run first: setProgress replaces the ledger)
    const d = await b.ev(`(() => {
      G.UI.setProgress({ 1: 3, 2: 1, 3: 1, 4: 1, 5: 1 }, { endless: { 1: 20 },
        daily: { 20260101: { won: true }, 20260102: { won: true }, 20260103: { won: true }, 20260104: { won: true }, 20260105: { won: true } } });
      G.deedRunEnd(false);
      return ['m1', 'm2', 'm3', 'm4', 'm5', 's1', 'warden', 'watch', 'daily', 's2', 's5'].map(id => G.deedHas(id)); })()`);
    A('deeds.derived.campaign', Array.isArray(d) && d.slice(0, 9).every(Boolean) && !d[9] && !d[10],
      'm1..m5,s1,warden,watch,daily should be true, s2/s5 false: ' + JSON.stringify(d));
    // 2. every COUNTED deed lands on its threshold, not one bump before
    for (const [id, [key, n]] of Object.entries(COUNTED)) {
      const r = await b.ev(`(() => { const L0 = G.laurelsEarned();
        for (let i = 0; i < ${n - 1}; i++) G.deedBump('${key}');
        const before = G.deedHas('${id}'); G.deedBump('${key}');
        return { before, after: G.deedHas('${id}'), laurel: G.laurelsEarned() - L0 }; })()`);
      A('deeds.counter.' + id + '.at' + n, r.before === false && r.after === true && r.laurel === 1, JSON.stringify(r));
    }
    // 3. the bestiary: every kind, and not one short
    const be = await b.ev(`(() => { const K = ${JSON.stringify(BESTIARY)};
      for (const k of K.slice(0, -1)) { G.deedBump('kind', k); G.deedBump('kind', k); }
      const before = G.deedHas('bestiary'); G.deedBump('kind', K[K.length - 1]);
      return { before, after: G.deedHas('bestiary') }; })()`);
    A('deeds.bestiary.everyKind', be.before === false && be.after === true, JSON.stringify(be));
    // 4. the muster mark is a high-water event at fourteen standards
    const mu = await b.ev(`(() => { G.deedMark('muster', 13); const a = G.deedHas('muster'); G.deedMark('muster', 14); return [a, G.deedHas('muster')]; })()`);
    A('deeds.muster.at14', mu[0] === false && mu[1] === true, JSON.stringify(mu));
    // 5. the run's own deeds, judged on the plate
    const rd = await b.ev(`(() => { const s = G.state, L = s.lives, out = {};
      // Omen Gambler, NEGATIVE: a replayed wave's banner does not count its omen twice (GC-12)
      G.deedRunReset(); s.omen = 'march'; G.deedOmen(5); G.deedOmen(5); G.deedOmen(6);
      out.replay = G.deedRunState(); G.deedRunEnd(true); out.omenAfter2 = G.deedHas('omen'); out.flawless = G.deedHas('flawless');
      // ...and a wave below the omen horizon is not an omen wave at all
      G.deedRunReset(); G.deedOmen(G.OMEN_FROM - 1); out.belowFrom = G.deedRunState();
      // a boon taken spoils the run for the deed
      G.deedRunReset(); s.omen = 'march'; G.deedOmen(5); G.deedOmen(6); s.omen = 'thin'; G.deedOmen(7); out.spoiled = G.deedRunState();
      G.deedRunEnd(true); out.omenSpoiled = G.deedHas('omen');
      // Omen Gambler, POSITIVE: three challenges, nothing else
      G.deedRunReset(); s.omen = 'ironskin'; G.deedOmen(5); G.deedOmen(6); G.deedOmen(7); G.deedRunEnd(true); out.omen = G.deedHas('omen');
      // Second Wind: below five lives at some point, and still won
      G.deedRunReset(); s.lives = 4; G.deedRunEnd(false); out.windOnLoss = G.deedHas('wind'); s.lives = 10; G.deedRunEnd(true); out.wind = G.deedHas('wind');
      // the ledger round-trips (it rides the run snapshot)
      G.deedRunLoad([true, false, 3, 9]); out.load = G.deedRunState(); G.deedRunReset();
      s.lives = L; s.omen = ''; return out; })()`);
    A('deeds.flawless.fullGarrisonWin', rd.flawless === true, JSON.stringify(rd));
    A('deeds.omen.replayedWaveCountsOnce', JSON.stringify(rd.replay) === '[false,true,2,6]' && rd.omenAfter2 === false, JSON.stringify(rd.replay));
    A('deeds.omen.belowHorizonIgnored', JSON.stringify(rd.belowFrom) === '[false,true,0,0]', JSON.stringify(rd.belowFrom));
    A('deeds.omen.boonSpoilsIt', rd.spoiled && rd.spoiled[1] === false && rd.omenSpoiled === false, JSON.stringify(rd.spoiled));
    A('deeds.omen.threeChallenges', rd.omen === true, JSON.stringify(rd));
    A('deeds.wind.lowThenWon', rd.windOnLoss === false && rd.wind === true, JSON.stringify(rd));
    A('deeds.runLedger.roundTrip', JSON.stringify(rd.load) === '[true,false,3,9]', JSON.stringify(rd.load));
    // 6. persistence: flushed to the progress record, and a reloaded page reads the same ledger
    const want = await b.ev('(() => { G.deedFlush(); return Object.keys(G.deedsRecord()).sort(); })()');
    const stored = await b.ev(`Object.keys((JSON.parse(localStorage.getItem('bannerfall.progress') || '{}').deeds) || {}).sort()`);
    A('deeds.persisted', Array.isArray(want) && want.length === 24 && JSON.stringify(stored) === JSON.stringify(want),
      'granted=' + (want && want.length) + ' stored=' + (stored && stored.length));
    A('deeds.noPageErrors', await b.ev('(window.__errors || []).length === 0'), await b.ev(ERRS));
    await b.go(BASE + '?dbg=1&map=1&auto=1');
    A('deeds.reload.booted', await b.until(READY, 120000 * SLOW), 'reload never reached prewave');
    const re = await b.ev('({ n: G.deedCount(), ids: Object.keys(G.deedsRecord()).sort(), today: G.deedsRecord().pyre === G.TODAY, laurels: G.laurelsEarned() })');
    A('deeds.reload.sameLedger', re.n === want.length && JSON.stringify(re.ids) === JSON.stringify(want) && re.today === true,
      JSON.stringify(re).slice(0, 200));
    // 24 deeds + map stars (3+2, then 1+2 x4 = 17) + five daily wins (x2 = 10) + endless past the finale
    A('deeds.reload.laurels', re.laurels >= 24 + 17 + 10, 'laurelsEarned=' + re.laurels);
  } finally { await b.close(); }
}

try {
  await saveRestore();
  await deeds();
} catch (e) {
  A('live.harness', false, String(e && e.stack || e).slice(0, 300));
}
console.log(`LIVESUM total=${total} pass=${total - fails} fail=${fails}`);
process.exit(fails ? 1 : 0);
