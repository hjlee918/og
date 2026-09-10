'use strict';
//
// WHAT MOVING THE ORIGIN DOES TO STORED STATE, MEASURED RATHER THAN ASSERTED.
//
// Browsers partition `localStorage`, `sessionStorage`, IndexedDB and the Cache
// API BY ORIGIN. Moving the renderer from `file://` to `lsp://logseq.com`
// therefore does not delete anything — it stops the application being able to
// SEE what it stored before, which looks identical to deletion from inside the
// app and is not the same thing at all from outside it.
//
// Nothing the MAIN process owns moves: the graph's Markdown, `<dot-root>/config`,
// `<dot-root>/settings/*.json` (plugin settings), `<dot-root>/graphs`,
// `userData/configs.edn` and `window-state.json` are path-keyed, not
// origin-keyed. That asymmetry is the whole of the migration question.
//
// EVERYTHING HERE IS SYNTHETIC. `syntheticProof` runs a disposable Electron
// application, in a throwaway `userData` directory, over fixture pages of our
// own. It never opens the product, never reads a real profile and never
// migrates one — migrating an existing profile is explicitly NOT authorised.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

class StorageRefusal extends Error {}

// ---------------------------------------------------------------------------
// Classification: what a migration MUST carry, and what it may leave behind.
// ---------------------------------------------------------------------------
//
// The distinction is not cosmetic. A rebuildable value costs the user time; a
// non-rebuildable one is data loss. Anything unrecognised is treated as
// NON-rebuildable, because guessing in the other direction is the expensive
// mistake.
// Only the fixture's explicit synthetic cache is classified as rebuildable.
// Real product keys need a measured, versioned inventory; names alone do not
// establish that a preference containing 'search' may be discarded.
const REBUILDABLE = [/^logseq-db\/synthetic$/];

function classify(keys) {
  const rebuildable = [];
  const mustCarry = [];
  for (const k of keys) {
    (REBUILDABLE.some((re) => re.test(k)) ? rebuildable : mustCarry).push(k);
  }
  return { rebuildable, mustCarry };
}

/** Read the origin-keyed footprint of whatever page is given, from inside it. */
async function inventoryFromPage(page) {
  return page.evaluate(async () => {
    const out = { origin: null, href: null, localStorage: {}, sessionStorageKeys: [],
                  indexedDbNames: [], error: null };
    try {
      out.origin = location.origin;
      out.href = location.href;
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          out.localStorage[k] = (localStorage.getItem(k) || '').length;
        }
      } catch (e) { out.error = 'localStorage: ' + String(e && e.message); }
      try {
        for (let i = 0; i < sessionStorage.length; i += 1) {
          out.sessionStorageKeys.push(sessionStorage.key(i));
        }
      } catch (e) { /* recorded via error above if it matters */ }
      try {
        if (indexedDB.databases) {
          out.indexedDbNames = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
        }
      } catch (e) { /* not fatal */ }
    } catch (e) { out.error = String(e && e.message); }
    return out;
  }).catch((e) => ({ origin: null, error: String(e && e.message), localStorage: {},
                     sessionStorageKeys: [], indexedDbNames: [] }));
}

/**
 * Which origins have on-disk storage in a profile's `sessionData`.
 *
 * Chromium keeps every origin's `localStorage` in ONE leveldb keyed by origin,
 * so the honest measurement is "does this origin's name appear in the store",
 * not a parse of it. IndexedDB is per-origin directories, which can be listed.
 */
function originsOnDisk(sessionDataDir, origins) {
  const out = {};
  for (const o of origins) out[o] = { localStorage: false, indexedDb: [] };

  const lsDir = path.join(sessionDataDir, 'Local Storage', 'leveldb');
  if (fs.existsSync(lsDir)) {
    let blob = '';
    for (const f of fs.readdirSync(lsDir)) {
      try { blob += fs.readFileSync(path.join(lsDir, f), 'latin1'); } catch (e) { /* skip */ }
    }
    for (const o of origins) if (blob.includes(o)) out[o].localStorage = true;
  }
  const idbDir = path.join(sessionDataDir, 'IndexedDB');
  if (fs.existsSync(idbDir)) {
    const entries = fs.readdirSync(idbDir);
    for (const o of origins) {
      // Chromium's directory name form: `lsp_logseq.com_0.indexeddb.leveldb`,
      // `file__0.indexeddb.leveldb`.
      const token = o.replace('://', '_').replace(/:/g, '_');
      out[o].indexedDb = entries.filter((e) => e.startsWith(token) || (o === 'file://' && e.startsWith('file__')));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The synthetic proof, and the migration it demonstrates
// ---------------------------------------------------------------------------

// DESIGN ONLY: syntheticProof below does not implement a completion marker,
// interruption recovery, destination rollback or accepted-app rollback.
const MIGRATION = {
  name: 'one-time origin carry-over',
  summary:
    'On first start at the new origin, and only then, read the OLD origin\'s ' +
    'localStorage through a hidden same-session page, copy the keys a ' +
    'migration must carry, verify every one of them by reading it back at the ' +
    'new origin, and only then write a completion marker. Nothing is deleted ' +
    'at the old origin, ever.',
  properties: [
    'idempotent: the completion marker is written LAST, so an interrupted run ' +
    'must recover from a durable journal and refuse destination conflicts; ' +
    'blindly repeating writes can overwrite preferences changed after interruption',
    'non-destructive: the old origin keeps every value, which is what makes ' +
    'rollback to the previous build possible at all',
    'verified: each carried key is read back at the new origin and compared ' +
    'byte for byte; a mismatch fails the migration',
    'fail-closed: on any failure no marker is written, the new origin is left ' +
    'as it was found, and the failure is reported rather than swallowed',
    'bounded: rebuildable caches are NOT carried — they are re-derived, which ' +
    'is cheaper and cannot corrupt anything',
  ],
};

function electronBin(repo) {
  try {
    const p = require(path.join(repo, 'node_modules', 'electron'));
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

/**
 * Demonstrate, end to end and on synthetic data only:
 *   1. a value written at `file://` is INVISIBLE at `lsp://logseq.com`;
 *   2. the migration carries it, and verifies it;
 *   3. a corrupted carry is REFUSED rather than reported as success;
 *   4. rollback: the old origin still has everything, untouched.
 */
function syntheticProof({ bin, timeoutMs = 180000 }) {
  if (!bin) throw new StorageRefusal('no Electron binary available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f28-origin-storage-'));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);

  fs.writeFileSync(path.join(dir, 'page.html'),
    '<!doctype html><meta charset="utf-8"><title>s</title><body><script>window.__ready=1;<\/script></body>');

  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'f28-origin-storage', version: '1.0.0', main: 'main.js' }));

  fs.writeFileSync(path.join(dir, 'main.js'), `'use strict';
const { app, protocol, BrowserWindow, session } = require('electron');
const path = require('path');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('sessionData', ${JSON.stringify(userData)});
protocol.registerSchemesAsPrivileged([
  { scheme: 'lsp', privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
]);
const OLD = 'file://' + path.join(__dirname, 'page.html');
const NEW = 'lsp://logseq.com/page.html';
const out = { steps: [] };
const step = (name, data) => out.steps.push(Object.assign({ name }, data));

async function at(url, fn, arg) {
  const win = new BrowserWindow({ show: false, webPreferences:
    { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true } });
  await win.loadURL(url);
  const r = await win.webContents.executeJavaScript(
    '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')');
  win.destroy();
  return r;
}

const readAll = (_) => {
  const o = { origin: location.origin, keys: {} };
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o.keys[k] = localStorage.getItem(k); }
  return o;
};
const writeAll = (kv) => {
  for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]);
  return { origin: location.origin, count: Object.keys(kv).length };
};

app.whenReady().then(async () => {
  // Fixture-only control installed before constructing any window. No plugins
  // or IPC service bridges exist in this fixture; this is not product coverage.
  session.defaultSession.webRequest.onBeforeRequest((req, cb) => {
    cb({ cancel: ![OLD, NEW].includes(req.url) });
  });
  protocol.registerFileProtocol('lsp', (req, cb) => {
    if (req.url !== NEW) return cb({ error: -10 });
    cb({ path: path.join(__dirname, 'page.html') });
  });

  // --- 1. synthetic state at the OLD origin ---------------------------------
  const SEED = { 'ui/sidebar-open': 'true', 'ui/theme': 'dark',
                 'git/current-repo': 'logseq_local_synthetic',
                 'logseq-db/synthetic': 'REBUILDABLE-CACHE' };
  step('seed-old-origin', await at(OLD, writeAll, SEED));
  step('read-old-origin', await at(OLD, readAll));

  // --- 2. the new origin cannot see any of it -------------------------------
  const fresh = await at(NEW, readAll);
  step('new-origin-before-migration', fresh);

  // --- 3. migrate: carry only what must be carried, then verify -------------
  const old = await at(OLD, readAll);
  const CARRY = {};
  for (const k of Object.keys(old.keys)) if (!/^logseq-db/.test(k)) CARRY[k] = old.keys[k];
  step('carry-set', { keys: Object.keys(CARRY) });
  await at(NEW, writeAll, CARRY);
  const after = await at(NEW, readAll);
  const verified = Object.keys(CARRY).every((k) => after.keys[k] === CARRY[k]);
  step('new-origin-after-migration', { origin: after.origin, keys: Object.keys(after.keys), verified });

  // --- 4. a corrupted carry must be REFUSED, not reported as success --------
  const bad = Object.assign({}, CARRY, { 'ui/theme': 'CORRUPTED' });
  const badVerified = Object.keys(CARRY).every((k) => bad[k] === CARRY[k]);
  step('corrupted-carry-detected', { verifierSaysOk: badVerified });

  // --- 5. rollback: the OLD origin still has everything, untouched ----------
  const rolledBack = await at(OLD, readAll);
  const intact = Object.keys(SEED).every((k) => rolledBack.keys[k] === SEED[k]);
  step('old-origin-after-everything', { acceptedAppRollback: false, origin: rolledBack.origin, intact,
                                        keys: Object.keys(rolledBack.keys) });

  console.log('STORAGE_PROOF_START');
  console.log(JSON.stringify(out, null, 1));
  console.log('STORAGE_PROOF_END');
  app.quit();
});
app.on('window-all-closed', () => {});
`);

  let stdout;
  try {
    stdout = execFileSync(bin, [dir], { encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stdout = (e.stdout || '') + (e.stderr || '');
  }
  const m = stdout.match(/STORAGE_PROOF_START\n([\s\S]*?)\nSTORAGE_PROOF_END/);
  const result = m ? JSON.parse(m[1]) : null;
  return { dir, userData, result, raw: m ? null : stdout.slice(0, 1200) };
}

module.exports = { StorageRefusal, REBUILDABLE, classify, inventoryFromPage,
                   originsOnDisk, MIGRATION, electronBin, syntheticProof };
