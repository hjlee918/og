'use strict';
//
// WHY PLUGINS ENROL AND THEN NEVER LOAD — THE TWO MEASUREMENTS THAT SAY IT.
//
// The 2026-09-10 coexistence batch found all three inventoried plugins
// `registered + enabled` and then `handshake Timeout`, with every sandbox entry
// left as a `file://` URL and a null-origin `postMessage` rejection beside it.
// It could not say WHICH condition failed, and it explicitly left two
// candidates open: `isInstalledInDotRoot` (does `LSPluginCore`'s
// `dotConfigRoot` match the plugin's `localRoot`?) and the `file://` ->
// `lsp://logseq.io/` substitution itself.
//
// THE ANSWER IS NEITHER. `_resolveResourceFullUrl` is
//
//     return !this.options.effect && this.isInstalledInDotRoot
//       ? convertToLSPResource(filePath, this.dotPluginsRoot)
//       : filePath
//
// and there is a THIRD condition in front of both: `!this.options.effect`.
// `effect` is copied straight out of the plugin's own `package.json`, and all
// three inventoried plugins declare `"effect": true` — it is what the Logseq
// plugin template emits. So the rewrite is skipped before the dot-root test is
// ever reached, and the entry stays `file://`. `iir` is TRUE the whole time:
// the isolated build's roots are healthy and are not the fault.
//
// THAT ALONE IS NOT THE FAILURE, WHICH IS WHY THIS FILE HAS TWO PROBES.
// Postmate's child replies with `postMessage(reply, e.origin)`, and `e.origin`
// is the origin of the HOST RENDERER, not the plugin. OG's renderer is a
// `file://` document (`electron/window.cljs` MAIN_WINDOW_ENTRY). Chromium
// changed how a `file:` origin serialises: under this build's Electron 41.7.1
// (Chromium 146) it serialises as the string `"null"`, and `postMessage`
// rejects `"null"` as a target origin. Under Electron 38.4.0 (Chromium 140)
// the same configuration serialises as `"file://"` and the handshake completes.
// So this is a REGRESSION CARRIED IN BY THE FIRST-PARTY ELECTRON UPGRADE
// (`6e7afa8eb Upgrade Electron to 41.7.1`, a dependency-only commit), not a
// third-party plugin defect and not a graph or reference-feature defect.
//
// Both probes are READ-ONLY MEASUREMENTS. They never touch a graph, never read
// or write any application profile, never launch the packaged application or
// the installed one, and never execute plugin code: the entry probe constructs
// a `PluginLocal` against a stub context purely to read its getters, and the
// origin probe talks to a fixture page of our own that contains no plugin.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

class ProbeRefusal extends Error {}

/** The Electron binary this checkout builds against; null when absent. */
function electronBin(repo = REPO) {
  try {
    const p = require(path.join(repo, 'node_modules', 'electron'));
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `f28-handshake-${label}-`));
}

/**
 * Run `main.js` in `dir` under Electron and return the JSON it prints between
 * the two markers. A probe that prints nothing is a refusal, never a silent
 * pass — an unmeasured run must not read as a measured one.
 */
function runElectron(dir, bin, { timeoutMs = 120000 } = {}) {
  fs.writeFileSync(path.join(dir, 'package.json'),
                   JSON.stringify({ name: 'f28-probe', version: '1.0.0', main: 'main.js' }));
  let out;
  try {
    out = execFileSync(bin, [dir], {
      encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    if (!/PROBE_START/.test(out)) {
      throw new ProbeRefusal(`electron probe produced no result: ${e.message}\n${out.slice(0, 800)}`);
    }
  }
  const m = out.match(/PROBE_START\n([\s\S]*?)\nPROBE_END/);
  if (!m) throw new ProbeRefusal(`electron probe produced no result block:\n${out.slice(0, 800)}`);
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// PROBE 1 — what entry URL the SHIPPED plugin host resolves, and why.
// ---------------------------------------------------------------------------

/**
 * Read `iir` / `lsr` / the resolved entry out of a real `js/lsplugin.core.js`,
 * for a plugin at `pluginRoot` under `dotRoot`, once per `effect` value.
 *
 * `lsp` is registered exactly as `electron/core.cljs` registers it (standard +
 * secure), because `safetyPathJoin` resolves `lsp://logseq.io/` through the
 * renderer's URL parser: with the scheme unregistered the same code yields the
 * malformed `null/logseq.io/...`, which would be a measurement of the probe
 * rather than of the product.
 */
function resolveEntry({ coreJs, dotRoot, pluginRoot, effects = [true, false], bin = electronBin() }) {
  if (!bin) throw new ProbeRefusal('no Electron binary in this checkout');
  if (!fs.existsSync(coreJs)) throw new ProbeRefusal(`no plugin host bundle at ${coreJs}`);
  const dir = tmpdir('entry');

  const page = `<!doctype html><meta charset="utf-8"><title>entry</title><body>
<script>window.__LSP__HOST__ = true;<\/script>
<script src="${'file://' + coreJs}"><\/script>
<script>
const out = { coreLoaded: !!window.LSPlugin, cases: [] };
try {
  const { PluginLocal } = window.LSPlugin;
  const ctx = { options: { dotConfigRoot: ${JSON.stringify(dotRoot)} } };
  for (const effect of ${JSON.stringify(effects)}) {
    const p = new PluginLocal({ key: 'probe', url: ${JSON.stringify(pluginRoot)}, effect }, ctx, ctx);
    p._localRoot = ${JSON.stringify(pluginRoot)};
    out.cases.push({ manifestEffect: effect, iir: p.isInstalledInDotRoot,
      dotConfigRoot: p.dotConfigRoot, dotPluginsRoot: p.dotPluginsRoot,
      localRoot: p.localRoot, lsr: p._resolveResourceFullUrl('/'),
      entry: p._resolveResourceFullUrl('dist/index.html', ${JSON.stringify(pluginRoot)}) });
  }
} catch (e) { out.error = String((e && e.stack) || e); }
window.__r = out;
<\/script></body>`;
  fs.writeFileSync(path.join(dir, 'p.html'), page);

  fs.writeFileSync(path.join(dir, 'main.js'), `'use strict';
const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
protocol.registerSchemesAsPrivileged([
  { scheme: 'lsp', privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
]);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences:
    { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true } });
  await win.loadURL('file://' + path.join(__dirname, 'p.html'));
  await new Promise((r) => setTimeout(r, 900));
  let r; try { r = await win.webContents.executeJavaScript('window.__r'); }
  catch (e) { r = { evalError: String(e && e.message) }; }
  console.log('PROBE_START');
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, ...r }, null, 1));
  console.log('PROBE_END');
  win.destroy(); app.quit();
});
app.on('window-all-closed', () => {});
`);
  try { return runElectron(dir, bin); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// PROBE 2 — whether a Postmate-shaped handshake can complete at all, per
// parent/child scheme pairing, under a given Electron.
// ---------------------------------------------------------------------------

/**
 * The child answers a handshake exactly as Postmate's `Model` does —
 * `e.source.postMessage(reply, e.origin)` — and reports the origin it saw and
 * whether that call threw. `'*'` is used ONLY as a last-resort reporting
 * channel for a failure that has already happened, never as the handshake
 * itself: the point is to measure the rejection, not to work around it.
 */
function originMatrix({ bin = electronBin(), timeoutMs = 120000 } = {}) {
  if (!bin) throw new ProbeRefusal('no Electron binary in this checkout');
  const dir = tmpdir('origin');

  fs.writeFileSync(path.join(dir, 'child.html'), `<!doctype html><meta charset="utf-8"><body><script>
window.addEventListener('message', function (e) {
  if (!e.data || e.data.probe !== 'handshake') return;
  var res = { childOrigin: location.origin, seenParentOrigin: e.origin, replyErr: null };
  try { e.source.postMessage({ probe: 'reply', res: res }, e.origin); }
  catch (err) {
    res.replyErr = String((err && err.message) || err);
    e.source.postMessage({ probe: 'reply', res: res }, '*');
  }
}, false);
<\/script></body>`);

  fs.writeFileSync(path.join(dir, 'parent.html'), `<!doctype html><meta charset="utf-8"><body><script>
const CHILD = new URLSearchParams(location.search).get('child');
const out = { parentOrigin: location.origin, childUrl: CHILD, childLoaded: false,
              handshakeDelivered: false, reply: null };
// Publish immediately, then keep updating: a blocked child never fires a
// load event, and an unset result would read as not-measured, not refused.
window.__r = out;
const f = document.createElement('iframe');
f.src = CHILD;
window.addEventListener('message', (e) => {
  if (e.data && e.data.probe === 'reply') { out.reply = e.data.res; out.handshakeDelivered = true; window.__r = out; }
});
f.addEventListener('load', () => {
  out.childLoaded = true;
  const a = document.createElement('a'); a.href = CHILD;
  out.resolvedChildOrigin = a.origin || (a.protocol + '//' + a.host);
  try { f.contentWindow.postMessage({ probe: 'handshake' }, out.resolvedChildOrigin); }
  catch (err) { out.parentPostErr = String((err && err.message) || err); }
  window.__r = out;
});
document.body.appendChild(f);
setTimeout(() => { window.__r = out; }, 500);
<\/script></body>`);

  fs.writeFileSync(path.join(dir, 'main.js'), `'use strict';
const { app, protocol, BrowserWindow } = require('electron');
const path = require('path');
const DIR = __dirname;
protocol.registerSchemesAsPrivileged([
  { scheme: 'lsp', privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
]);
const results = [];
async function probe(label, parentUrl, childUrl) {
  const win = new BrowserWindow({ show: false, webPreferences:
    { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true } });
  const rec = { label, loadErr: null, blocked: [] };
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (/Not allowed to load local resource/.test(String(msg))) rec.blocked.push(String(msg).slice(0, 160));
  });
  const sep = parentUrl.includes('?') ? '&' : '?';
  try { await win.loadURL(parentUrl + sep + 'child=' + encodeURIComponent(childUrl)); }
  catch (e) { rec.loadErr = String(e && e.message); }
  await new Promise((r) => setTimeout(r, 1400));
  try { Object.assign(rec, await win.webContents.executeJavaScript('window.__r || {}')); }
  catch (e) { rec.evalError = String(e && e.message); }
  results.push(rec); win.destroy();
}
app.whenReady().then(async () => {
  protocol.registerFileProtocol('lsp', (req, cb) => {
    const u = new URL(req.url); cb({ path: path.join(DIR, u.pathname) });
  });
  const FILE = (n) => 'file://' + path.join(DIR, n);
  await probe('file-parent/file-child', FILE('parent.html'), FILE('child.html'));
  await probe('file-parent/lsp-child',  FILE('parent.html'), 'lsp://logseq.io/child.html');
  await probe('lsp-parent/lsp-child',   'lsp://logseq.com/parent.html', 'lsp://logseq.io/child.html');
  await probe('lsp-parent/file-child',  'lsp://logseq.com/parent.html', FILE('child.html'));
  console.log('PROBE_START');
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, results }, null, 1));
  console.log('PROBE_END');
  app.quit();
});
app.on('window-all-closed', () => {});
`);
  try { return runElectron(dir, bin, { timeoutMs }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The inventoried plugin manifests, read where the artifacts actually are. */
function manifestEffects(root) {
  const out = {};
  for (const id of fs.readdirSync(root)) {
    const pj = path.join(root, id, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
    out[id] = { effect: pkg.effect, main: pkg.main };
  }
  return out;
}

module.exports = { ProbeRefusal, electronBin, resolveEntry, originMatrix, manifestEffects, REPO };
