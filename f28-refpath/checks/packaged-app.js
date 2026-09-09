'use strict';
//
// Launching THIS project's packaged build, refusing an outside path first, and
// opening one synthetic graph inside the permitted root.
//
// Every F27 scenario grew its own copy of this sequence. The F28 work needs the
// same sequence twice — once to observe OG's existing behaviour, once to test
// what this feature adds — and copying it a sixth and seventh time would mean
// the two runs could drift apart in exactly the part that must be identical:
// the boundary evidence. So it lives here, once, and both scenarios call it.
//
// What it does NOT do is decide anything about a feature. It launches, proves
// the refusal, opens the graph, asserts the loaded path, and hands back the
// page. Everything a scenario is actually about stays in the scenario.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md): the
// graph handed in must already be proved contained; this module proves it
// again before use, and the "bad" path must be outside and is never created.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));

const sleep = OP.sleep;

// The builds this project produces, newest first. Each is a directory name
// under `development/<dir>/out` and an identity module in the checkout.
const BUILDS = [
  { app: 'Logseq-OG-F28-RefPath', dir: 'f28-refpath', identity: 'f28-refpath/src/feature-identity.js' },
  { app: 'Logseq-OG-F27-Inline', dir: 'f27-inline-context', identity: 'f27-inline/src/feature-identity.js' },
];

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/**
 * Locate a packaged build and run its own pre-load identity check.
 *
 * `prefer` names a build's app name; without it the newest present build wins.
 * The result carries the identity module the build ships, so a caller can
 * assert which build it is looking at rather than inferring it from a path.
 */
function resolve(prefer) {
  const wanted = prefer ? BUILDS.filter((b) => b.app === prefer) : BUILDS;
  for (const b of wanted) {
    const appDir = path.join(FEATURE_DIR, 'out', `${b.app}-darwin-x64`, `${b.app}.app`);
    const exe = path.join(appDir, 'Contents', 'MacOS', b.app);
    const resApp = path.join(appDir, 'Contents', 'Resources', 'app');
    if (!fs.existsSync(exe)) continue;
    const preflight = require(path.join(resApp, 'pilot-preflight.js')).verify(resApp);
    const identity = require(path.join(REPO, b.identity));
    const stateRoot = path.join(os.userInfo().homedir, 'Library', 'Application Support',
                                identity.PRODUCT_NAME, identity.STATE_DIR);
    return {
      appName: b.app, appDir, exe, resApp, preflight, identity,
      stateRoot,
      journal: path.join(stateRoot, 'userData', 'pilot-guard-journal.jsonl'),
    };
  }
  throw new Error(`no packaged build found under ${path.join(FEATURE_DIR, 'out')} ` +
                  `for ${wanted.map((b) => b.app).join(' or ')}`);
}

function journalLines(built) {
  return fs.existsSync(built.journal)
    ? fs.readFileSync(built.journal, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}
function journalSince(built, n) {
  if (!fs.existsSync(built.journal)) return [];
  return fs.readFileSync(built.journal, 'utf8').trim().split('\n').filter(Boolean)
    .slice(n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

/**
 * Launch, refuse an outside dialog result, then open `graph` and assert that
 * the application really loaded it.
 *
 * `record`, `say` and `phase` come from the calling scenario, so its checks
 * are numbered in its own sequence. `prefix` is the letter that sequence uses.
 */
async function open({ built, graph, bad, errors, say, record, phase, prefix = 'L' }) {
  const GRAPH = B.assertInsideAllowedRoot('graph to open', graph);
  if (B.isInsideAllowedRoot(bad)) throw new Error(`the refusal probe ${bad} is inside the root`);

  say(`\n${prefix}2  launch, then a BAD dialog result`);
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));
  let app = null;
  for (let a = 1; a <= 2 && !app; a++) {
    try {
      app = await withTimeout(_electron.launch({ executablePath: built.exe, timeout: 120000 }),
                              180000, 'electron launch');
    } catch (e) {
      if (a === 2) throw e;
      say(`  (launch attempt ${a} failed: ${String(e.message).split('\n')[0]}; retrying once)`);
      await sleep(10000);
    }
  }

  const appPid = await app.evaluate(() => process.pid).catch(() => null);
  const ownedTree = appPid ? OP.descendants(appPid) : [];
  const page = await withTimeout(app.firstWindow(), 60000, 'firstWindow');

  page.on('pageerror', (e) => errors.record('pageerror',
    String((e && e.stack) || (e && e.message) || e).slice(0, 600)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.record('console', 'console: ' + m.text().slice(0, 600));
  });

  phase('startup', 'load-the-window');
  await withTimeout(page.waitForLoadState('domcontentloaded'), 60000, 'domcontentloaded');
  await sleep(7000);

  const installed = await app.evaluate(({ dialog }, p) => {
    if (!global.__pilotOrigShowOpenDialog) {
      global.__pilotOrigShowOpenDialog = dialog.showOpenDialog;
    }
    global.__pilotDialogPath = p;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [global.__pilotDialogPath] });
    return typeof global.__pilotOrigShowOpenDialog === 'function';
  }, bad);
  record(`${prefix}2.1`, 'native folder dialog stubbed in the main process, original retained',
    installed === true, `returning ${bad}`);

  const chooseFolder = async () => {
    await page.evaluate(() => { location.hash = '#/repo/add'; });
    await sleep(2500);
    try { await page.locator('.choose').first().click({ timeout: 30000 }); }
    catch (e) { say(`          (choose folder: ${e.message.split('\n')[0]})`); }
  };

  const markBad = journalLines(built);
  phase(EC.NEGATIVE_PHASE, EC.NEGATIVE_OPERATION);
  await chooseFolder();
  await sleep(7000);
  errors.endPhase();
  const badRefusals = journalSince(built, markBad)
    .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
  record(`${prefix}2.2`, 'the application refused the outside dialog result',
    badRefusals.length > 0,
    badRefusals.length ? badRefusals[0].detail.slice(0, 140)
                       : 'no boundary refusal was journalled for the bad dialog result');
  record(`${prefix}2.3`, 'nothing was created at the outside probe path', !fs.existsSync(bad), bad);

  say(`\n${prefix}3  open the synthetic graph through the ordinary workflow`);
  phase('open-graph', 'choose-folder-permitted-root');
  await app.evaluate((_e, p) => { global.__pilotDialogPath = p; }, GRAPH);
  await chooseFolder();
  await sleep(22000);

  phase('assert-loaded-path', 'read-the-application-state');
  const loaded = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/repo|graph/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 300);
    }
    return { ls: out, hash: location.hash };
  }).catch(() => ({ ls: {} }));
  const loadedStr = JSON.stringify(loaded.ls || {});
  const loadedPathOk = loadedStr.includes(GRAPH);
  record(`${prefix}3.1`, "the loaded graph is this run's own, asserted before any feature use",
    loadedPathOk, loadedPathOk ? GRAPH : `no reference to it in ${loadedStr.slice(0, 300)}`);
  const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                     /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
  record(`${prefix}3.2`, 'no graph outside the permitted root is referenced by the app state',
    !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');
  if (!loadedPathOk) {
    await close({ app, appPid, ownedTree, built }, { say });
    throw new Error('the synthetic graph did not load; not proceeding');
  }

  const goTo = async (name) => {
    await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
    await sleep(3500);
  };
  const parkPointer = () => page.mouse.move(5, 5).catch(() => null);

  return { app, page, appPid, ownedTree, built, graph: GRAPH, goTo, parkPointer,
           journalSince: (n) => journalSince(built, n), journalLines: () => journalLines(built) };
}

/** Restore the dialog stub and stop only the processes this run started. */
async function close(session, { say = () => {} } = {}) {
  const { app, appPid, ownedTree = [] } = session;
  if (app) {
    try {
      await withTimeout(app.evaluate(({ dialog }) => {
        if (global.__pilotOrigShowOpenDialog) {
          dialog.showOpenDialog = global.__pilotOrigShowOpenDialog;
          delete global.__pilotOrigShowOpenDialog;
          delete global.__pilotDialogPath;
        }
        return true;
      }), 15000, 'restore dialog');
    } catch (e) { say(`          (restore dialog: ${e.message})`); }
    try { await withTimeout(app.close(), 30000, 'app.close'); }
    catch (e) { say(`          (app.close: ${e.message})`); }
  }
  let stage = 'no-pid';
  if (appPid) {
    const r = await OP.stop(appPid, (m) => say('          ' + m));
    stage = r.stage;
  }
  return { stage, stillAlive: ownedTree.filter(OP.alive) };
}

module.exports = { resolve, open, close, withTimeout, sleep, BUILDS };
