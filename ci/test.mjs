// AUDIT-1 T7-03 — THE CI RUNNER: a zero-dependency Node (>=20) port of tools\test.ps1, so the same
// gates can run on a GitHub ubuntu-latest runner (or anywhere Chrome and Node exist).
//
//   node ci/test.mjs                  # from anywhere; it finds the tree above itself (or BF_ROOT)
//
// COMMITTED (user-approved, AUDIT-1 T7-03): ci/ is the one tracked exception to "game files only";
// .github/workflows/tests.yml runs this on every pull request. ci/ is SELF-CONTAINED — its helpers
// (static.mjs, coopsmoke.mjs, livetest.mjs, ws.mjs) sit beside this file and nothing here reads the
// gitignored tools\ tree, so a bare checkout runs it. Node 20 has no global WebSocket: ci/ws.mjs is
// a minimal CDP-sized client used only when the global is missing (BF_WS_SHIM=1 forces it).
//
// What it runs, in test.ps1's order and with test.ps1's gates:
//   static   ci/static.mjs (shell contract: sw precache ⊆ tracked files, __BUILD__/__IMM__
//            stamping, import map, manifest, node --check)
//   core/risen/turns/omen/council/councilq   in-page ?test= suites, each with a minimum assert count
//   net x2   the double-PROCESS determinism gate: two fresh Chromes, NETCRC+NETCMD transcripts diffed
//   coop     the two-tab E2E: both TESTPASS, 2 TESTSUM, CRC AGREEMENT, COMMAND ORDER, OWNERSHIP refusal
//   smoke    ci/coopsmoke.mjs (lobby DOM contract + live co-op path, BroadcastChannel loopback)
//   live     ci/livetest.mjs  (run save/restore + deeds, which ?test= cannot reach)
// Differences from test.ps1, all deliberate: it serves the tree itself (node:http on 127.0.0.1:0,
// backlog 1024 — T7-01 was python http.server's backlog of 5 dropping a booting page's burst of
// module/texture requests), it reads console output over CDP (Runtime.consoleAPICalled) instead of parsing
// Chrome's stderr log, and every Chrome binds --remote-debugging-port=0 with a fresh profile.
// Env: CHROME (browser binary), CHROME_EXTRA (space-separated extra flags — CI passes
// "--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader"), BF_ROOT (tree to serve),
// BF_SLOW (boot-wait multiplier for the live suites; CI passes 4 — software GL boots slowly),
// BF_SKIP (comma list of suites to skip, printed as SKIPPED — CI skips `smoke`: two full game tabs
// on SwiftShader never finish booting, measured 26 min / rider never booted even at a 6 min window),
// BF_OUT (where each suite's console transcript is written; default <root>/shots/ci — CI uploads it).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const findRoot = (d) => {
  for (let i = 0; i < 4; i++, d = dirname(d)) if (existsSync(join(d, 'index.html')) && existsSync(join(d, 'js', 'game.js'))) return d;
  throw new Error('cannot find the game tree above ' + HERE + ' (set BF_ROOT)');
};
const ROOT = resolve(process.env.BF_ROOT || findRoot(HERE));
const CHROME = process.env.CHROME || (platform() === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : platform() === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const EXTRA = (process.env.CHROME_EXTRA || '').split(/\s+/).filter(Boolean);
// the helpers live beside this file and nowhere else (ci/ must run from a bare checkout)
const sib = (f) => [join(HERE, f)].find((p) => existsSync(p));
const WebSocket = globalThis.WebSocket && !process.env.BF_WS_SHIM ? globalThis.WebSocket : (await import('./ws.mjs')).default;
const OUT = resolve(process.env.BF_OUT || join(ROOT, 'shots', 'ci'));
try { mkdirSync(OUT, { recursive: true }); } catch { }
const keep = (tag, lines) => { try { writeFileSync(join(OUT, 'test_' + tag + '.log'), lines.join('\n') + '\n'); } catch { } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => console.log(s);
const SKIP = new Set((process.env.BF_SKIP || '').split(',').map((x) => x.trim()).filter(Boolean));
const skipped = (n) => { if (!SKIP.has(n)) return false; out(`SUITE ${n.padEnd(8)} SKIPPED (BF_SKIP) - not a pass; run it where a GPU is available`); return true; };

// ── the static server ──────────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = resolve(ROOT, '.' + p);
  if (!f.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
  let st; try { st = statSync(f); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  createReadStream(f).pipe(res);
});
await new Promise((r, j) => { server.once('error', j); server.listen({ port: 0, host: '127.0.0.1', backlog: 1024 }, r); });
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

// ── Chrome over CDP ─────────────────────────────────────────────────────────────────────────────
async function chrome(flags = []) {
  const prof = mkdtempSync(join(tmpdir(), 'bfci-'));
  const proc = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', '--window-size=800,500', '--remote-debugging-port=0', '--user-data-dir=' + prof,
    ...EXTRA, ...flags, 'about:blank'], { stdio: 'ignore' });
  let exited = false; proc.on('exit', () => { exited = true; });
  proc.on('error', (e) => { exited = true; out(`  CHROME DID NOT START: ${e.message} (CHROME=${CHROME})`); });
  let port = 0;
  for (let i = 0; i < 300 && !port && !exited; i++) {
    try { const l = readFileSync(join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); if (/^\d+$/.test(l)) port = +l; } catch { }
    if (!port) await sleep(100);
  }
  const json = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json();
  return {
    port, json, get exited() { return exited; },
    close: async () => { try { proc.kill(); } catch { } await sleep(500); try { rmSync(prof, { recursive: true, force: true }); } catch { } },
  };
}
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pend = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('Uncaught ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  return { id: target.id, logs, go: (url) => send('Page.navigate', { url }), close: () => { try { ws.close(); } catch { } } };
}
// Title polling, exactly test.ps1's completion signal; 'ERROR' is terminal after 15 s.
async function poll(c, ids, waitS) {
  const sig = Object.fromEntries(ids.map((i) => [i, 'TIMEOUT'])), errAt = {};
  const dl = Date.now() + waitS * 1000;
  while (Date.now() < dl && Object.values(sig).some((v) => v === 'TIMEOUT')) {
    await sleep(900);
    if (c.exited) { for (const i of ids) if (sig[i] === 'TIMEOUT') sig[i] = 'CHROME_EXITED'; break; }
    let list; try { list = await c.json('/json'); } catch { continue; }
    for (const i of ids) {
      if (sig[i] !== 'TIMEOUT') continue;
      const t = list.find((x) => x.id === i); if (!t) continue;
      if (t.title === 'TESTPASS' || t.title === 'TESTFAIL') sig[i] = t.title;
      else if (t.title === 'ERROR') { errAt[i] = errAt[i] || Date.now(); if (Date.now() - errAt[i] > 15000) sig[i] = 'ERROR'; }
    }
  }
  return sig;
}
const diag = (logs) => {
  const last = logs.slice(-6), bad = logs.filter((l) => /Uncaught|ERR_|Failed to load/.test(l)).slice(0, 6);
  if (!last.length && !bad.length) out('  LAST: (no console line at all - the module graph never ran)');
  for (const l of [...last, ...bad]) out('  LAST: ' + l.slice(0, 220));
};

let fails = 0; const red = [];
const failSuite = (n) => { fails++; red.push(n); };

// ── STEP 0: static ──────────────────────────────────────────────────────────────────────────────
async function node(file, args = [], env = {}) {
  return new Promise((r) => {
    const p = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; });
    p.on('close', (code) => r({ code, lines: buf.split(/\r?\n/) }));
  });
}
if (!skipped('static')) {   // BF_SKIP covers static too (e.g. a replica of the stamped deploy copy, which is not a git tree)
  const f = sib('static.mjs');
  const r = f ? await node(f, [ROOT]) : { code: 1, lines: ['STATICSUM missing static.mjs'] };
  keep('static', r.lines);
  const sum = r.lines.filter((l) => /STATICSUM/.test(l)).pop() || 'NO_SUMMARY';
  out(`SUITE ${'static'.padEnd(8)} ${sum.replace(/^STATICSUM /, '')}`);
  for (const l of r.lines.filter((l) => /^STATIC FAIL /.test(l))) out('  FAIL: ' + l.replace(/^STATIC FAIL /, ''));
  if (r.code !== 0) failSuite('static');
}

// ── the in-page suites ──────────────────────────────────────────────────────────────────────────
const SUITES = [
  { name: 'core', q: 'test=audio,sim,place,ui,i18n,harness', min: 27, wait: 90 },
  { name: 'risen', q: 'test=risen&map=4', min: 2, wait: 90 },
  { name: 'turns', q: 'test=turns&map=5', min: 3, wait: 90 },
  { name: 'omen', q: 'test=omen&map=1', min: 17, wait: 90 },
  { name: 'council', q: 'test=council&map=1', min: 7, wait: 90 },
  { name: 'councilq', q: 'test=council&map=1&talents=q2,d1,e3', min: 7, wait: 90 },
  { name: 'net', q: 'test=net,cmd,coop&map=1', min: 59, wait: 120, runs: 2 },
];
for (const s of SUITES) {
  if (skipped(s.name)) continue;
  const runs = s.runs || 1, sets = []; let bad = false;
  for (let r = 1; r <= runs; r++) {
    const tag = runs > 1 ? s.name + r : s.name;
    const c = await chrome();
    let sig = 'NO_DEVTOOLS_PORT', logs = [];
    if (c.port) {
      const tgt = (await c.json('/json')).find((t) => t.type === 'page');
      const pg = await attach(tgt);
      await pg.go(BASE + '?' + s.q);
      sig = (await poll(c, [tgt.id], s.wait))[tgt.id];
      logs = pg.logs.slice(); pg.close();
    }
    await c.close();
    keep(tag, logs);
    const sum = logs.filter((l) => l.startsWith('TESTSUM ')).pop();
    if (!sum) { out(`SUITE ${tag.padEnd(8)} NO_TESTSUM (signal=${sig})`); diag(logs); bad = true; continue; }
    const tot = +((/total=(\d+)/.exec(sum) || [])[1] || 0);
    out(`SUITE ${tag.padEnd(8)} ${sum.replace(/^TESTSUM /, '')}`);
    for (const l of logs.filter((l) => l.startsWith('TESTLOG FAIL '))) out('  FAIL: ' + l.replace(/^TESTLOG FAIL /, ''));
    if (!/fail=0/.test(sum)) bad = true;
    if (tot < s.min) { out(`  BELOW MIN: ${tot} assert(s) ran, this suite must run at least ${s.min}`); bad = true; }
    sets.push(logs.filter((l) => /^(NETCRC|NETCMD) /.test(l)).map((l) => l.trimEnd()));
  }
  if (runs > 1) {   // GAME_SPEC_9 SB — the double-PROCESS determinism gate
    if (sets.length < runs) { out(`  DETERMINISM: RED - only ${sets.length}/${runs} run(s) produced a transcript`); bad = true; }
    else if (!sets[0].length) { out('  DETERMINISM: RED - no NETCRC/NETCMD lines emitted'); bad = true; }
    else {
      const [a, b] = sets, n = Math.max(a.length, b.length), diff = [];
      for (let k = 0; k < n; k++) if (a[k] !== b[k]) diff.push(`    line ${k + 1}:\n      run1: ${a[k] ?? '<missing>'}\n      run2: ${b[k] ?? '<missing>'}`);
      if (diff.length) { out(`  DETERMINISM: RED - ${diff.length} of ${n} transcript line(s) differ across runs`); diff.slice(0, 4).forEach(out); bad = true; }
      else out(`  DETERMINISM: GREEN - ${a.length} transcript line(s) identical across ${runs} runs`);
    }
  }
  if (bad) failSuite(s.name);
}

// ── coop: the two-tab E2E (two tabs, ONE profile: a BroadcastChannel is per-profile) ─────────────
{
  let cf = 0;
  const q = 'test=coope2e&net=bc&map=1&seed=4242&room=E2E01&role=';
  const c = await chrome(['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
  let hs = 'TIMEOUT', gs = 'TIMEOUT', logs = [];
  if (c.port) {
    const ht = (await c.json('/json')).find((t) => t.type === 'page');
    const hp = await attach(ht); await hp.go(BASE + '?' + q + 'host');
    const gt = await c.json('/json/new?about:blank', 'PUT');
    const gp = await attach(gt); await gp.go(BASE + '?' + q + 'guest');
    const sig = await poll(c, [ht.id, gt.id], 180);
    hs = sig[ht.id]; gs = sig[gt.id];
    logs = [...hp.logs, ...gp.logs]; hp.close(); gp.close();
  } else cf++;
  await c.close();
  keep('coop', logs);
  const pick = (re) => logs.map((l) => re.exec(l)).filter(Boolean).map((m) => m[1].trimEnd());
  const sums = logs.filter((l) => l.startsWith('TESTSUM '));
  const crcH = pick(/^NETCRC\[host\] (.*)$/), crcG = pick(/^NETCRC\[guest\] (.*)$/);
  const apH = pick(/^NETAPPLY\[host\] (.*)$/), apG = pick(/^NETAPPLY\[guest\] (.*)$/);
  out(`SUITE coop     host=${hs} guest=${gs} crcMarks=${crcH.length}/${crcG.length} commands=${apH.length}/${apG.length}`);
  for (const s of sums) out('  ' + s.replace(/^TESTSUM /, ''));
  for (const l of logs.filter((l) => l.startsWith('TESTLOG FAIL '))) out('  FAIL: ' + l.replace(/^TESTLOG FAIL /, ''));
  if (hs !== 'TESTPASS' || gs !== 'TESTPASS') { cf++; if (sums.length < 2) diag(logs); }
  if (sums.length !== 2) { out('  GATE: RED - expected 2 TESTSUM lines, saw ' + sums.length); cf++; }
  for (const s of sums) { if (!/fail=0/.test(s)) cf++; if (+((/total=(\d+)/.exec(s) || [])[1] || 0) < 19) { out('  BELOW MIN: ' + s); cf++; } }
  for (const [what, a, b] of [['CRC AGREEMENT', crcH, crcG], ['COMMAND ORDER', apH, apG]]) {
    if (!a.length || !b.length) { out(`  ${what}: RED - a peer emitted nothing (${a.length}/${b.length})`); cf++; continue; }
    const n = Math.max(a.length, b.length), diff = [];
    for (let k = 0; k < n; k++) if (a[k] !== b[k]) diff.push(`    line ${k + 1}:\n      host : ${a[k] ?? '<missing>'}\n      guest: ${b[k] ?? '<missing>'}`);
    if (diff.length) { out(`  ${what}: RED - ${diff.length} of ${n} line(s) differ between the two browsers`); diff.slice(0, 4).forEach(out); cf++; }
    else out(`  ${what}: GREEN - ${a.length} line(s) identical on both browsers`);
  }
  const rej = (ap) => ap.filter((l) => /op=sell/.test(l) && / p=1 /.test(l) && /ok=0/.test(l));
  if (rej(apH).length && rej(apG).length) out(`  OWNERSHIP: GREEN - the rider's sell of the captain's tower was refused on both browsers (${rej(apH)[0]})`);
  else { out(`  OWNERSHIP: RED - refusal not seen on both browsers (host=${rej(apH).length} guest=${rej(apG).length})`); cf++; }
  if (cf) failSuite('coop');
}

// ── the live suites ─────────────────────────────────────────────────────────────────────────────
for (const ls of [
  { name: 'smoke', js: 'coopsmoke.mjs', sum: 'SMOKESUM', fail: /^SMOKE FAIL /, min: 32, args: ['--base', BASE] },
  { name: 'live', js: 'livetest.mjs', sum: 'LIVESUM', fail: /^LIVE FAIL /, min: 43, args: [] },
]) {
  if (skipped(ls.name)) continue;
  const f = sib(ls.js);
  const r = f ? await node(f, ls.args, { CHROME, CHROME_EXTRA: EXTRA.join(' '), BF_BASE: BASE, BF_SLOW: process.env.BF_SLOW || '1' }) : { code: 1, lines: [] };
  keep(ls.name, r.lines);
  const sum = r.lines.filter((l) => l.startsWith(ls.sum)).pop() || `NO_SUMMARY (exit=${r.code}${f ? '' : ', ' + ls.js + ' not found'})`;
  const tot = +((/total=(\d+)/.exec(sum) || [])[1] || 0);
  out(`SUITE ${ls.name.padEnd(8)} ${sum.replace(new RegExp('^' + ls.sum + ' '), '')}`);
  for (const l of r.lines.filter((l) => ls.fail.test(l))) out('  FAIL: ' + l.replace(ls.fail, ''));
  if (tot < ls.min) out(`  BELOW MIN: ${tot} assert(s) ran, this suite must run at least ${ls.min}`);
  if (r.code !== 0 || tot < ls.min) failSuite(ls.name);
}

server.close();
const sk = SKIP.size ? ` (skipped: ${[...SKIP].join(',')})` : '';
if (fails) { out(`TESTS: RED (${fails} suite(s) failing: ${red.join(', ')})${sk}`); process.exit(1); }
out('TESTS: GREEN' + sk);
process.exit(0);
