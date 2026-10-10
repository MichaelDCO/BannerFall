// AUDIT-1 T7-06 — the browser-free SHELL CONTRACT check. First step of ci/test.mjs (and of the
// local tools\test.ps1). No browser, no server: it reads the tracked tree and asserts that what the
// service worker precaches, what index.html loads, what pages.yml stamps and what the manifest
// and import map point at all agree. Exit 1 on any FAIL.
// Usage: node ci/static.mjs [root]           (root defaults to the checkout this file lives in)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const R = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
let fail = 0, n = 0;
const T = (name, ok, d = '') => { n++; if (!ok) fail++; console.log('STATIC ' + (ok ? 'PASS ' : 'FAIL ') + name + (ok || !d ? '' : ' - ' + d)); };
const rd = p => readFileSync(join(R, p), 'utf8');
const tracked = new Set(execFileSync('git', ['-C', R, 'ls-files'], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean));
const stripC = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
const sw = rd('sw.js'), idx = rd('index.html'), man = JSON.parse(rd('manifest.webmanifest'));
const yml = rd('.github/workflows/pages.yml');

// -- the precache lists, read from their array literals only (comments stripped) ----------------
const list = (name) => {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];').exec(sw);
  return m ? [...stripC(m[1]).matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]) : null;
};
const SHELL = list('SHELL'), VENDOR = list('VENDOR'), TEXTURES = list('TEXTURES');
T('sw.listsParse', !!(SHELL && VENDOR && TEXTURES) && SHELL.length > 0 && VENDOR.length > 0 && TEXTURES.length > 0,
  'SHELL/VENDOR/TEXTURES not found as array literals');
const pre = [...(SHELL || []), ...(VENDOR || []), ...(TEXTURES || [])];
const bare = p => p.split('?')[0];
const missing = pre.filter(p => p !== './' && !tracked.has(bare(p)));
T('sw.precacheSubsetOfTracked', missing.length === 0, missing.join(','));
const dup = pre.filter((p, i) => pre.indexOf(p) !== i);
T('sw.precacheNoDuplicates', dup.length === 0, dup.join(','));
const shipped = [...tracked].filter(f => /^(js|css|icons|textures)\//.test(f) || ['index.html', 'manifest.webmanifest'].includes(f));
const notPre = shipped.filter(f => !pre.some(p => bare(p) === f));
T('sw.everyShippedFilePrecached', notPre.length === 0, notPre.join(','));
T('sw.versionStamped', /const VERSION = 'bannerfall-__BUILD__'/.test(sw), 'VERSION must carry __BUILD__');
T('sw.immStamped', /const IMM = 'bannerfall-imm-__IMM__'/.test(sw), 'IMM must carry __IMM__');
// stamped shell entries are exactly OUR files; vendor/texture entries are bare (IMM cache)
const shellStamped = (SHELL || []).filter(p => /\?v=__BUILD__$/.test(p)).map(bare);
T('sw.shellStampsOurCode', ['css/main.css', 'js/game.js', 'js/lobby.js', 'js/net.js'].every(f => shellStamped.includes(f)),
  'stamped=' + shellStamped.join(','));
T('sw.immutableListsBare', [...(VENDOR || []), ...(TEXTURES || [])].every(p => !p.includes('?')));

// -- __BUILD__ stamping coverage ----------------------------------------------------------------
const stamped = [...idx.matchAll(/(?:src|href)="\.?\/?([^"]+\?v=__BUILD__)"/g)].map(m => m[1]);
const unst = stamped.filter(u => !pre.includes(u));
T('stamp.indexStampsMatchSwShell', stamped.length >= 5 && unst.length === 0, 'refs=' + stamped.length + ' not in SHELL: ' + unst.join(','));
const ourShell = ['js/game.js', 'js/net.js', 'js/lobby.js', 'css/main.css'];
const unstampedRefs = ourShell.filter(f => new RegExp('(src|href)="\\.?/?' + f.replace(/\./g, '\\.') + '"').test(idx));
T('stamp.noUnstampedShellRef', unstampedRefs.length === 0, unstampedRefs.join(','));
T('stamp.swRegisterStamped', /serviceWorker\.register\('sw\.js\?v=__BUILD__'\)/.test(idx));
// ci/ (the committed test runner) names the tokens in its own checks and comments; it is not shipped
const tokenFiles = (tok) => [...tracked].filter(f => /\.(m?js|html|css|webmanifest|json)$/.test(f) && !f.startsWith('.github/') && !f.startsWith('ci/'))
  .filter(f => { try { return rd(f).includes(tok); } catch { return false; } });
const bTok = tokenFiles('__BUILD__').sort().join(',');
T('stamp.onlyPagesYmlTargetsCarryToken', bTok === 'index.html,sw.js', 'files carrying __BUILD__: ' + bTok);
const iTok = tokenFiles('__IMM__').sort().join(',');
T('stamp.immTokenOnlyInSw', iTok === 'sw.js', 'files carrying __IMM__: ' + iTok);
T('stamp.pagesYmlStampsBoth', /sed -i "s\/__BUILD__\/[^"]*" index\.html sw\.js/.test(yml), 'pages.yml must sed __BUILD__ in index.html and sw.js');
T('stamp.pagesYmlStampsImm', /sed -i "s\/__IMM__\/[^"]*" sw\.js/.test(yml), 'pages.yml must sed __IMM__ in sw.js');
// the stamp step must run before the artifact upload
T('stamp.pagesYmlOrder', yml.indexOf('__BUILD__') >= 0 && yml.indexOf('__BUILD__') < yml.indexOf('upload-pages-artifact'));

// -- import map, modulepreload, manifest ----------------------------------------------------------
let im = {};
try { im = JSON.parse(idx.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports; } catch (e) { im = null; }
T('importmap.parses', !!im);
const imBad = Object.values(im || {}).filter(v => v.endsWith('/') ? ![...tracked].some(f => f.startsWith(v.replace(/^\.\//, ''))) : !tracked.has(v.replace(/^\.\//, '')));
T('importmap.targetsExist', imBad.length === 0, imBad.join(','));
const mp = [...idx.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(m => m[1]);
const mpBad = mp.filter(h => !tracked.has(bare(h).replace(/^\.\//, '')));
T('modulepreload.targetsExist', mpBad.length === 0, mpBad.join(','));
const icBad = (man.icons || []).map(i => i.src).filter(s => !tracked.has(s.replace(/^\.\//, '')));
T('manifest.iconsExist', (man.icons || []).length > 0 && icBad.length === 0, icBad.join(','));
T('manifest.linked', /<link rel="manifest" href="manifest\.webmanifest"/.test(idx));

// -- syntax of every non-vendor script (vendor too: node --check is cheap and catches truncation)
for (const f of [...tracked].filter(f => /\.(m?js)$/.test(f))) {
  let ok = true, e = '';
  try { execFileSync(process.execPath, ['--check', join(R, f)], { stdio: 'pipe' }); } catch (x) { ok = false; e = String(x.stderr).slice(0, 200); }
  T('syntax.' + f, ok, e);
}
console.log(`STATICSUM total=${n} pass=${n - fail} fail=${fail}`);
process.exit(fail ? 1 : 0);
