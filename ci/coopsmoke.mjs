// LIVE TWO-TAB CO-OP SMOKE — the path the ?test=coope2e suite deliberately cannot reach.
//
// The E2E suite proves the SEQUENCER: it replays the lobby's handshake by hand because
// js/lobby.js installs nothing under `?test=`. This script proves everything the suite skips,
// by driving the shipped UI of a LIVE page over CDP and touching no test-only seam at all:
//
//   title plinth -> #btnCoop -> the war-band lobby -> CREATE (a real room code) ->
//   a second browser tab on the `?join=CODE` summons -> READY on both -> "Sound the horn" ->
//   `bf-coop-start` -> SECTION: NET's NAVIGATION (`?coop=CODE&auto=1&seed=&map=`) ->
//   NET.resume() on the far side -> js/net.js re-dialling the room from the code ->
//   two live lockstep peers whose CRCs are compared against each other.
//
// IT IS THE REGRESSION TEST FOR THE HOST RE-DIAL. Before `get code()` landed in js/lobby.js the
// captain navigated with the `?coop=1` sentinel, js/net.js had nothing to dial, and the band was
// stillborn while every rider reconnected. `smoke.host.carriedTheRoomCode` below asserts the
// captain's post-navigation URL carries the five-glyph code and not the sentinel.
//
// Transport is the BroadcastChannel loopback (`?net=bc`), which is why both peers are tabs in
// ONE browser: a BroadcastChannel is per-profile. js/lobby.js reaches it because its transport()
// now routes through window.BFCoopNet.transport() (RECONCILIATION §7).
//
//   node ci/coopsmoke.mjs [--base URL] [--port 9448] [--run 12000]   (ci/test.mjs passes --base)
//   node ci/coopsmoke.mjs --mobile                 # 390x844 TRUE viewport, + fit checks + PNGs
//
// --mobile is the co-op half of the mshots gate. The lobby and the battle's ally band cannot be
// reached by tools/mshots.ps1 at all - both live behind the SHOT guard, deliberately - so the
// only way to make a claim about them on a phone is to drive them live under a real device
// metrics override, which is exactly what mshots.ps1 exists to say (a --window-size of 390 lays
// out at ~500 on Windows and the PNG is a shear). Writes shots/_coLobby_m.png and
// shots/_coBattle_m.png and asserts nothing in either overflows the 390 px rail.
// Prints SMOKE PASS/FAIL lines and SMOKESUM; exit 1 on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const WebSocket = globalThis.WebSocket && !process.env.BF_WS_SHIM ? globalThis.WebSocket : (await import('./ws.mjs')).default;   // Node 20: ci/ws.mjs

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
let port = +arg('port', 0);   // AUDIT-1 T7-07 (was 9448)
const RUNMS = +arg('run', 12000);
// AUDIT-1 T7-03 - boot windows scale for software GL (CI runs on SwiftShader, where two tabs boot
// several times slower): `--slow 3` multiplies every boot/re-arm wait by 3. Default 1 = unchanged.
const SLOW = Math.max(1, +arg('slow', process.env.BF_SLOW || 1));
const BASE = arg('base', 'http://127.0.0.1:8321/index.html');
const MOBILE = argv.includes('--mobile');
const MW = +arg('w', 390), MH = +arg('h', 844);
const SHOTDIR = arg('shots', fileURLToPath(new URL('../shots', import.meta.url)));   // AUDIT-1 T7-11
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';   // AUDIT-1 T7-11
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// AUDIT-1 T7-07 — no fixed CDP port by default: Chrome binds a free one (--remote-debugging-port=0)
// and writes it to <profile>/DevToolsActivePort, so two tools (or two copies of one tool) can never
// answer each other's /json poll. `--port N` still pins one when a caller needs it.
async function devPort() {
  if (port) return port;
  for (let i = 0; i < 200; i++) {
    try { const l = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); if (/^\d+$/.test(l)) return (port = +l); } catch { }
    await sleep(100);
  }
  throw new Error('DevToolsActivePort never appeared in ' + profile);
}


// The widest visible descendant of a root, in CSS px, against the real viewport width. Same
// question tools/measure.mjs's overflow() answers, inlined so this script stays standalone.
const OVER = (sel) => `(()=>{const r=document.querySelector(${JSON.stringify(sel)});if(!r)return null;
 let m=0,w='';const vw=innerWidth;
 for(const e of r.querySelectorAll('*')){const c=getComputedStyle(e);
  if(c.display==='none'||c.visibility==='hidden')continue;const b=e.getBoundingClientRect();
  if(!b.width&&!b.height)continue;
  if(b.right>m){m=b.right;w=e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+((e.className&&typeof e.className==='string')?'.'+e.className.trim().split(/\\s+/).slice(0,2).join('.'):'');}}
 return {vw,maxRight:+m.toFixed(1),worst:w};})()`;

let fails = 0, total = 0;
const A = (name, ok, why) => {
  total++;
  if (ok) console.log('SMOKE PASS ' + name);
  else { fails++; console.log('SMOKE FAIL ' + name + (why ? ' - ' + why : '')); }
};

class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) { this.pend.get(m.id)(m); this.pend.delete(m.id); return; }
      // A screencast is only started when a tab reports itself hidden; the frames have to be
      // acked or Chrome stops producing them, and producing them is the whole point.
      if (m.method === 'Page.screencastFrame') this.send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new Conn(ws);
  }
  send(method, params = {}) {
    return new Promise((res) => { const i = ++this.id; this.pend.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return null;      // mid-navigation: no context yet
    return r.result && r.result.result ? r.result.result.value : null;
  }
  // Polls a boolean expression. Returns true on success, false on timeout.
  async until(expr, ms) {
    const dl = Date.now() + ms;
    for (;;) { if (await this.ev(expr) === true) return true; if (Date.now() > dl) return false; await sleep(150); }
  }
  async val(expr, pred, ms) {
    const dl = Date.now() + ms;
    for (;;) { const v = await this.ev(expr); if (pred(v)) return v; if (Date.now() > dl) return v; await sleep(150); }
  }
}

const profile = mkdtempSync(join(tmpdir(), 'bfcoopsmoke-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--window-size=1100,760',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', ...(process.env.CHROME_EXTRA || '').split(/\s+/).filter(Boolean), 'about:blank'], { stdio: 'ignore' });

// The title plinth is up and the world is built: `html.booting` is SECTION: CORE's own read-out
// and it is the same gate #btnCoop's own click handler keeps.
const BOOTED = '(!document.documentElement.classList.contains("booting") && !!document.getElementById("btnCoop") && !document.getElementById("btnCoop").classList.contains("hidden"))';

async function main() {
  await devPort();
  let ver = null;
  for (let i = 0; i < 80; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  if (!ver) throw new Error('devtools never came up');
  const B = await Conn.open(ver.webSocketDebuggerUrl);

  const mk = async (url) => {
    // Created blank so a device-metrics override can be installed BEFORE the document loads -
    // every vw unit and media query in the page then resolves against the real phone width
    // rather than against the ~500 px minimum a Windows window can be.
    const r = await B.send('Target.createTarget', { url: MOBILE ? 'about:blank' : url, newWindow: true });
    const tid = r.result.targetId;
    for (let i = 0; i < 100; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.id === tid && x.webSocketDebuggerUrl);
      if (t) {
        const c = await Conn.open(t.webSocketDebuggerUrl);
        if (MOBILE) {
          await c.send('Emulation.setDeviceMetricsOverride', { width: MW, height: MH, deviceScaleFactor: 1, mobile: true });
          await c.send('Page.enable');
          await c.send('Page.navigate', { url });
          await sleep(400);
        }
        // rAF does not run in a hidden page, and the game's whole loop is rAF. A headless window
        // is normally visible; if this one is not, a minimal screencast keeps frames coming.
        const vis = await c.val('document.visibilityState', (v) => !!v, 8000);
        if (vis !== 'visible') {
          await c.send('Page.enable');
          await c.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1 });
        }
        c.vis = vis;
        return c;
      }
      await sleep(150);
    }
    throw new Error('no target for ' + url);
  };

  // ── 1. THE CAPTAIN RAISES A WAR-BAND, off the title plinth ────────────────────────────────
  const H = await mk(BASE + '?net=bc');
  A('smoke.host.booted', await H.until(BOOTED, 90000 * SLOW), 'the title plinth never came up');
  A('smoke.host.coopDoorIsOnThePlinth', await H.ev('!document.getElementById("btnCoop").classList.contains("hidden")') === true);
  await H.ev('document.getElementById("btnCoop").click()');
  A('smoke.host.lobbyOpens', await H.until('!document.getElementById("coopLobby").classList.contains("hidden") && !!document.getElementById("btnClCreate")', 15000));
  await H.ev('document.getElementById("btnClCreate").click()');
  const CODE = await H.val('(document.getElementById("clCode")||{}).textContent', (v) => /^[A-Z0-9]{5}$/.test(v || ''), 30000);
  A('smoke.host.roomCodeMinted', /^[A-Z0-9]{5}$/.test(CODE || ''), 'code=' + CODE);
  A('smoke.host.roomIsLive', await H.until('document.getElementById("coopLobby").dataset.net==="live"', 20000),
    await H.ev('document.getElementById("coopLobby").dataset.net'));
  A('smoke.host.lobbyPublishesTheCode', await H.ev('window.BFCoop && window.BFCoop.code') === CODE,
    'BFCoop.code=' + await H.ev('window.BFCoop && window.BFCoop.code'));
  if (!/^[A-Z0-9]{5}$/.test(CODE || '')) throw new Error('no room code - nothing further is testable');

  // ── 2. THE RIDER ANSWERS THE SUMMONS (?join=CODE, the share URL the lobby prints) ─────────
  const Gt = await mk(BASE + '?net=bc&join=' + CODE);
  A('smoke.guest.booted', await Gt.until(BOOTED, 90000 * SLOW), 'the rider never booted');
  A('smoke.guest.summonsPrefilledTheCode',
    await Gt.until('(()=>{const i=document.getElementById("clIn");return !!i&&i.value==="' + CODE + '";})()', 30000));
  await Gt.ev('document.getElementById("btnClGo").click()');
  A('smoke.guest.joinedTheBand', await Gt.until('document.getElementById("coopLobby").dataset.net==="live"', 30000),
    await Gt.ev('document.getElementById("coopLobby").dataset.net'));
  const ROSTER2 = 'document.querySelectorAll("#clRoster .clP:not(.em)").length===2';
  A('smoke.host.rosterShowsTwoCaptains', await H.until(ROSTER2, 20000),
    'seats=' + await H.ev('document.querySelectorAll("#clRoster .clP:not(.em)").length'));
  A('smoke.guest.rosterShowsTwoCaptains', await Gt.until(ROSTER2, 20000));

  const shoot = async (c, name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) { writeFileSync(join(SHOTDIR, name), Buffer.from(r.result.data, 'base64')); console.log('SMOKEPNG ' + name); }
  };
  const fit = async (c, sel, label) => {
    const o = await c.ev(OVER(sel));
    console.log('SMOKEFIT ' + label + ' ' + JSON.stringify(o));
    A(label, !!o && o.maxRight <= o.vw + 0.5, o ? ('widest ' + o.worst + ' at ' + o.maxRight + ' of ' + o.vw) : 'no ' + sel);
  };
  if (MOBILE) { await shoot(H, '_coLobby_m.png'); await fit(H, '#coopLobby', 'smoke.mobile.lobbyFitsTheRail'); }

  // ── 3. READY-CHECK, then the horn ─────────────────────────────────────────────────────────
  await Gt.ev('document.getElementById("btnClReady").click()');
  await H.ev('document.getElementById("btnClReady").click()');
  A('smoke.host.startUnlocksOnFullReady', await H.until('!document.getElementById("btnClStart").disabled', 20000),
    'status=' + await H.ev('(document.getElementById("clStatus")||{}).textContent'));
  await H.ev('document.getElementById("btnClStart").click()');

  // ── 4. THE NAVIGATION, and the re-dial on the far side ────────────────────────────────────
  // The countdown is 3 s, then `bf-coop-start` -> NET.start() -> location.search. Both pages die
  // and come back; NET.resume() re-arms the sim and js/net.js raises the channels from the code.
  const ARMED = '(!!window.BFNet && window.BFNet.active===true && !!window.BFCoopNet && window.BFCoopNet.status().live===true)';
  A('smoke.host.rearmedAfterNavigation', await H.until(ARMED, 120000 * SLOW),
    'search=' + await H.ev('location.search') + ' net=' + JSON.stringify(await H.ev('window.BFCoopNet?window.BFCoopNet.status():null')));
  A('smoke.guest.rearmedAfterNavigation', await Gt.until(ARMED, 120000 * SLOW),
    'search=' + await Gt.ev('location.search') + ' net=' + JSON.stringify(await Gt.ev('window.BFCoopNet?window.BFCoopNet.status():null')));

  const hs = await H.ev('location.search'), gs = await Gt.ev('location.search');
  A('smoke.host.carriedTheRoomCode', typeof hs === 'string' && hs.indexOf('coop=' + CODE) >= 0,
    'the captain navigated with ' + hs + ' (the `?coop=1` sentinel here is the stillborn-band bug)');
  A('smoke.guest.carriedTheRoomCode', typeof gs === 'string' && gs.indexOf('coop=' + CODE) >= 0, gs);
  A('smoke.host.isTheSequencer', await H.ev('window.BFCoopNet.status().role') === 'host' &&
    await H.ev('window.BFNet.isHost()') === true);
  A('smoke.guest.isARider', await Gt.ev('window.BFCoopNet.status().role') === 'guest' &&
    await Gt.ev('window.BFNet.isHost()') === false);
  A('smoke.band.twoSeatsOnBothPeers', await H.ev('window.BFCoopNet.status().players') === 2 &&
    await Gt.ev('window.BFCoopNet.status().players') === 2);
  A('smoke.band.sameSeed', (await H.ev('window.BFNet.seed>>>0')) === (await Gt.ev('window.BFNet.seed>>>0')),
    'host=' + await H.ev('window.BFNet.seed>>>0') + ' guest=' + await Gt.ev('window.BFNet.seed>>>0'));
  A('smoke.band.seatsAreDistinct', (await H.ev('window.BFNet.localIdx')) === 0 && (await Gt.ev('window.BFNet.localIdx')) === 1);

  // ── 5. AND IT RUNS. The frame loop, the horizon, the CRC gossip — no scripting at all now. ─
  const CRCX = '(window.BFNet && window.BFNet.crc) ? (window.BFNet.crc.tick + ":" + ((window.BFNet.crc.crc>>>0).toString(16))) : ""';
  const collect = async (c, ms) => {
    const m = new Map(); const dl = Date.now() + ms;
    while (Date.now() < dl) {
      const v = await c.ev(CRCX);
      if (typeof v === 'string' && v) { const k = v.split(':'); m.set(+k[0], k[1]); }
      await sleep(100);
    }
    return m;
  };
  const [mh, mg] = await Promise.all([collect(H, RUNMS), collect(Gt, RUNMS)]);
  const common = [...mh.keys()].filter((k) => mg.has(k)).sort((a, b) => a - b);
  const bad = common.filter((k) => mh.get(k) !== mg.get(k));
  A('smoke.run.bothPeersAdvanced', common.length >= 5,
    'shared checkpoints=' + common.length + ' host=' + mh.size + ' guest=' + mg.size);
  A('smoke.run.crcAgreesAcrossTheBand', common.length >= 5 && bad.length === 0,
    bad.length ? ('parted at tick ' + bad[0] + ': ' + mh.get(bad[0]) + ' vs ' + mg.get(bad[0]))
               : ('ticks ' + common[0] + '..' + common[common.length - 1]));
  const st = async (c) => await c.ev('JSON.stringify({s:window.BFCoopNet.status(),late:window.BFNet.late,applied:window.BFNet.applied,refused:window.BFNet.refused,horizon:window.BFNet.horizon})');
  const sh = JSON.parse(await st(H) || '{}'), sg = JSON.parse(await st(Gt) || '{}');
  console.log('SMOKESTATE host  ' + JSON.stringify(sh));
  console.log('SMOKESTATE guest ' + JSON.stringify(sg));
  A('smoke.run.noLateCommands', sh.late === 0 && sg.late === 0, 'host=' + sh.late + ' guest=' + sg.late);
  A('smoke.run.noDesyncDeclared', sh.s && sg.s && sh.s.ended === '' && sg.s.ended === '' &&
    sh.s.desyncAt === 0 && sg.s.desyncAt === 0, JSON.stringify([sh.s && sh.s.ended, sg.s && sg.s.ended]));
  A('smoke.run.horizonLedTheBand', sh.horizon > 0 && sg.horizon > 0 && sh.s.tick > 0,
    'host horizon=' + sh.horizon + ' guest horizon=' + sg.horizon);
  // ── 6. THE CO-OP UI IS LIVE, and the funnel runs through it ───────────────────────────────
  // The ally band is the rules stage's HUD row and it only exists at seats > 1. Reading it off
  // the DOM on both peers is also the cheapest honest check that the two SCREENS agree, not just
  // the two CRCs.
  const PURSES = '[...document.querySelectorAll("#coBand .coP b")].map(x=>x.textContent).join("|")';
  const bandUp = 'document.getElementById("coBand") && !document.getElementById("coBand").classList.contains("hidden") && document.querySelectorAll("#coBand .coP").length===2';
  A('smoke.ui.allyBandOnBothScreens', await H.until(bandUp, 10000) && await Gt.until(bandUp, 10000),
    'host=' + await H.ev('document.querySelectorAll("#coBand .coP").length') +
    ' guest=' + await Gt.ev('document.querySelectorAll("#coBand .coP").length'));
  A('smoke.ui.hornTallyShowsTheBand', await H.ev('!!document.querySelector("#btnWave .coHn")') === true);
  const p0 = await H.ev(PURSES);
  // SEND-GOLD, clicked on the real HUD button. It is `NET.hold('gold', ...)` under there, so this
  // is the whole funnel - a click, a submit, the captain's stamp, a bundle, and the SAME purses
  // on both screens - driven by nothing but a DOM click.
  await H.ev('document.querySelector("#coBand .coS").click()');
  const moved = await H.until('window.BFNet.pending.gold>=50', 15000) &&
                await Gt.until('window.BFNet.pending.gold>=50', 15000);
  A('smoke.ui.sendGoldRodeTheWire', moved,
    'host pending=' + await H.ev('window.BFNet.pending.gold') + ' guest pending=' + await Gt.ev('window.BFNet.pending.gold'));
  const ph = await H.ev(PURSES), pg = await Gt.ev(PURSES);
  A('smoke.ui.pursesAgreeOnBothScreens', !!ph && ph === pg, 'host=' + ph + ' guest=' + pg + ' (was ' + p0 + ')');
  A('smoke.ui.pursesActuallyMoved', ph !== p0, 'before=' + p0 + ' after=' + ph);

  const eh = await H.ev('(window.__errors||[]).slice(0,3)'), eg = await Gt.ev('(window.__errors||[]).slice(0,3)');
  A('smoke.run.noPageErrors', (eh || []).length === 0 && (eg || []).length === 0,
    JSON.stringify([eh, eg]));
  // The battle fit is measured on #hud, not on #ui. #ui legitimately holds things that fly off
  // the viewport by design - damage floaters, and the build bar's horizontal `.cRail` scroller,
  // whose cards are MEANT to run past the right edge (the solo baseline measures 675 there too,
  // and mshots.ps1 prints that number rather than gating on it). #hud is the row co-op actually
  // widens: the ally band adds a purse chip per captain, and that is what has to fit the phone.
  if (MOBILE) {
    await shoot(H, '_coBattle_m.png');
    await fit(H, '#hud', 'smoke.mobile.hudFitsTheRail');
    await fit(H, '#hudL', 'smoke.mobile.allyBandFitsTheRail');
    console.log('SMOKEFIT (not gated) #ui ' + JSON.stringify(await H.ev(OVER('#ui'))));
  }
  console.log('SMOKEVIS host=' + H.vis + ' guest=' + Gt.vis + ' room=' + CODE);
}

main().catch((e) => { fails++; console.log('SMOKE FAIL harness - ' + e.message); })
  .finally(async () => {
    console.log('SMOKESUM total=' + total + ' pass=' + (total - fails) + ' fail=' + fails);
    chrome.kill(); await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { }
    process.exit(fails ? 1 : 0);
  });
