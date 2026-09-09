'use strict';
//
// Launching THIS project's packaged build, refusing an outside path first, and
// opening one synthetic graph inside the permitted root.
//
// Two things in here were rewritten after the supervisor review of
// `0d5f45555`, and both were real:
//
// 1. THE LOADED-GRAPH GATE CHECKED STORED HISTORY, NOT THE CURRENT GRAPH.
//    It asked whether `JSON.stringify(localStorage)` CONTAINED this run's graph
//    path — which a remembered graph in `recent` satisfies while an entirely
//    different graph is active. It now reads OG's OWN current repository
//    (`logseq.api.get_current_graph()`, which is `state/get-current-repo`),
//    cross-checks it against the `git/current-repo` key, decodes both, and
//    compares the result to this run's approved graph by EXACT equality.
//    Anything else — missing, ambiguous, or a different path — aborts before
//    any feature interaction. `outsideRef` used to record a failure and carry
//    on; nothing records-and-carries-on any more.
//
//    No untrusted path is ever resolved on the filesystem. The comparison is
//    pure string canonicalisation against the ALREADY-RESOLVED approved path,
//    so a rejected value is never `stat`ed, `realpath`ed or hashed — a graph
//    this run must not touch is not touched in order to reject it, and a
//    rejection reports the path's shape rather than its content.
//
// 2. A FAILED STARTUP COULD BYPASS OWNED-PROCESS CLEANUP.
//    Both scenarios `await APP.open(...)` BEFORE entering their `try/finally`,
//    so anything that threw inside `open` after the application had launched
//    left a process nobody owned. `open` now owns cleanup from the moment it
//    has a pid until it successfully hands a session to its caller: it retains
//    the process tree immediately after launch, restores the dialog stub if it
//    installed one, stops only its own retained pids, and rethrows. The
//    launch RETRY is gone: a launch that failed for an unknown reason may have
//    left a process this harness cannot address, and retrying on top of that is
//    exactly the blind step the review names.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md): the
// graph handed in must already be proved contained; this module proves it again
// before use, and the "bad" path must be outside and is never created.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));
const NOISE = require('./browser-noise.js');

const sleep = OP.sleep;

// The builds this project produces, newest first. Each is a directory name
// under `development/<dir>/out` and an identity module in the checkout.
const BUILDS = [
  { app: 'Logseq-OG-F28-RefPath', dir: 'f28-refpath', identity: 'f28-refpath/src/feature-identity.js' },
  { app: 'Logseq-OG-F27-Inline', dir: 'f27-inline-context', identity: 'f27-inline/src/feature-identity.js' },
];

// OG's own prefix for a local graph repo url (`frontend.config/local-db-prefix`).
const LOCAL_DB_PREFIX = 'logseq_local_';
// Where OG persists the current repo (`frontend.state`, via `frontend.storage`).
const CURRENT_REPO_KEY = 'git/current-repo';

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// The exact-path gate. Pure, so every rule below is testable without a browser
// and without touching any filesystem path at all.
// ---------------------------------------------------------------------------

/**
 * One graph path in the single form both sides of the comparison use.
 *
 * Percent-decoding, `file://`, a `logseq_local_` prefix, EDN's surrounding
 * quotes, redundant separators, a trailing separator and Unicode composition
 * are all differences of SPELLING, not of location. Nothing here reads the
 * filesystem: the value being canonicalised may be a path this run must never
 * touch, and normalising it must not become a way of touching it.
 *
 * Returns null for anything that is not a usable absolute path.
 */
function canonicalGraphPath(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // EDN prints a string with its quotes; `localStorage` holds exactly that.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = s.trim();
  if (!s) return null;
  if (s.startsWith(LOCAL_DB_PREFIX)) s = s.slice(LOCAL_DB_PREFIX.length);
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  // A percent-encoded path decodes; a path containing a stray `%` does not, and
  // is used as written rather than being silently mangled.
  try { s = decodeURIComponent(s); } catch (e) { /* use it as written */ }
  s = s.replace(/\\/g, '/');
  if (!s.startsWith('/')) return null;
  s = path.posix.normalize(s);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // macOS hands out decomposed filenames; NFC is the canonical form both sides
  // are put into so that the same name spelled two ways compares equal.
  try { s = s.normalize('NFC'); } catch (e) { /* keep it as it is */ }
  return s || null;
}

/**
 * Describe a REJECTED path without recording it.
 *
 * A path this run must not touch may be a personal graph, and the review is
 * explicit that no personal path may be inspected in order to validate a
 * rejection. So a value that is not lexically inside the permitted root is
 * reported by its SHAPE — how long it is, how many segments — and never by its
 * content. A value that IS lexically inside the permitted root is this
 * project's own test data and may be named in full.
 */
function describeRejected(canonical, allowedRootCanonical) {
  if (canonical === null) return '(no usable path)';
  const inside = allowedRootCanonical &&
    (canonical === allowedRootCanonical || canonical.startsWith(allowedRootCanonical + '/'));
  if (inside) return canonical;
  return `(a path outside the permitted root: ${canonical.length} characters, ` +
         `${canonical.split('/').filter(Boolean).length} segments; ` +
         'its content is deliberately not recorded)';
}

/**
 * Is OG currently on exactly this run's approved graph?
 *
 * @param {object} state
 *   api      the object `logseq.api.get_current_graph()` returned, or null
 *   storage  the raw `git/current-repo` string from localStorage, or null
 *   approved the approved graph path, ALREADY canonically resolved by the caller
 *   allowedRoot the permitted root, already resolved, for redaction decisions
 * @returns {{ok:boolean, reason:string, detail:string, active:string|null}}
 *
 * Fails closed on every uncertainty: no reported graph, an unusable value, the
 * two sources disagreeing, or any path that is not exactly the approved one.
 */
function currentGraphVerdict({ api, storage, approved, allowedRoot }) {
  const want = canonicalGraphPath(approved);
  const root = canonicalGraphPath(allowedRoot);
  if (!want) {
    return { ok: false, reason: 'no-approved-path', active: null,
             detail: 'the run did not supply a resolved approved graph path' };
  }

  const fromApi = api && typeof api === 'object'
    ? canonicalGraphPath(api.path || api.url || null) : null;
  const fromStorage = canonicalGraphPath(storage);

  if (!fromApi && !fromStorage) {
    return { ok: false, reason: 'no-current-graph', active: null,
             detail: 'OG reported no current repository at all; refusing to guess one' };
  }
  if (fromApi && fromStorage && fromApi !== fromStorage) {
    return { ok: false, reason: 'ambiguous', active: null,
             detail: 'OG\'s current repository and the stored one disagree: ' +
                     `${describeRejected(fromApi, root)} vs ` +
                     `${describeRejected(fromStorage, root)}` };
  }
  // The API is OG's live state; storage is only a cross-check and is used alone
  // solely when the API is unavailable.
  const active = fromApi || fromStorage;
  if (active !== want) {
    return { ok: false, reason: 'mismatch', active,
             detail: `the active graph is ${describeRejected(active, root)}, ` +
                     `not this run's approved graph ${want}` };
  }
  // Name the source that actually answered. The first version of this line had
  // ONE else-branch for two different situations and so credited the stored
  // value for an answer the API had given — found by its own run, and exactly
  // the kind of misdescription this batch exists to remove.
  const source = fromApi && fromStorage
    ? 'both logseq.api.get_current_graph() and the stored git/current-repo agree'
    : (fromApi
       ? 'from logseq.api.get_current_graph(); no usable stored value was present'
       : 'from the stored git/current-repo; the API reported none');
  return { ok: true, reason: 'exact-match', active,
           detail: `OG's current repository is exactly ${want} (${source})`,
           source: fromApi && fromStorage ? 'both' : (fromApi ? 'api' : 'storage') };
}

// ---------------------------------------------------------------------------
// Build resolution
// ---------------------------------------------------------------------------

/**
 * Locate a packaged build and run its own pre-load identity check.
 *
 * `prefer` names a build's app name; without it the newest present build wins.
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

// ---------------------------------------------------------------------------
// Launch, with cleanup owned here until the session is handed over
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    launch: (opts) => require(path.join(REPO, 'node_modules', 'playwright'))
      ._electron.launch(opts),
    descendants: OP.descendants,
    stop: OP.stop,
    alive: OP.alive,
    sleep,
    journalLines,
    journalSince,
  };
}

/**
 * Launch, refuse an outside dialog result, open `graph`, and prove OG is on it.
 *
 * `record`, `say` and `phase` come from the calling scenario, so its checks are
 * numbered in its own sequence. `prefix` is the letter that sequence uses.
 * `deps` exists so the failure paths below can be driven deterministically by
 * `tests/packaged-app.test.js`; production callers never pass it.
 *
 * ON ANY FAILURE after the application has launched, this function restores the
 * dialog stub it installed and stops the processes it retained, then rethrows.
 * Ownership transfers to the caller only by returning a session.
 */
async function open({ built, graph, bad, errors, say, record, phase, prefix = 'L', deps }) {
  const d = Object.assign(defaultDeps(), deps || {});
  const log = say || (() => {});
  const note = record || (() => {});
  const mark = phase || (() => {});

  const GRAPH = B.assertInsideAllowedRoot('graph to open', graph);
  if (B.isInsideAllowedRoot(bad)) throw new Error(`the refusal probe ${bad} is inside the root`);

  let app = null;
  let appPid = null;
  let ownedTree = [];
  let stubInstalled = false;
  let handedOver = false;

  /**
   * Give up whatever this function has taken, in the order that matters.
   * Never throws: it runs on a path that is already failing.
   */
  async function abandon(why) {
    log(`          (startup failed: ${why}; releasing what this launcher owned)`);
    if (app && stubInstalled) {
      try {
        await withTimeout(app.evaluate(({ dialog }) => {
          if (global.__pilotOrigShowOpenDialog) {
            dialog.showOpenDialog = global.__pilotOrigShowOpenDialog;
            delete global.__pilotOrigShowOpenDialog;
            delete global.__pilotDialogPath;
          }
          return true;
        }), 15000, 'restore dialog (abandon)');
        stubInstalled = false;
      } catch (e) { log(`          (could not restore the dialog stub: ${e.message})`); }
    }
    if (app) {
      try { await withTimeout(app.close(), 30000, 'app.close (abandon)'); }
      catch (e) { log(`          (app.close: ${e.message})`); }
    }
    if (appPid) {
      try {
        const r = await d.stop(appPid, (m) => log('          ' + m));
        const left = ownedTree.filter(d.alive);
        log(`          (owned processes stopped: stage ${r.stage}, ` +
            `${left.length} of ${ownedTree.length} still alive)`);
      } catch (e) { log(`          (could not stop owned processes: ${e.message})`); }
    } else {
      log('          (no pid was retained, so no process is owned by this launcher)');
    }
  }

  try {
    log(`\n${prefix}2  launch, then a BAD dialog result`);

    // NO RETRY. A launch that failed for an unknown reason may have left a
    // process this harness has no handle on, and launching a second one on top
    // of it is the blind step the supervisor review names. A failure here is
    // reported and the batch is rerun deliberately.
    app = await withTimeout(d.launch({ executablePath: built.exe, timeout: 120000 }),
                            180000, 'electron launch');

    // Retained IMMEDIATELY, before anything else can throw, so `abandon` has
    // something to address for every failure below this line.
    appPid = await app.evaluate(() => process.pid).catch(() => null);
    ownedTree = appPid ? d.descendants(appPid) : [];
    if (!appPid) {
      throw new Error('the launched application did not report a pid; refusing to ' +
                      'proceed with a process this launcher cannot stop');
    }

    const page = await withTimeout(app.firstWindow(), 60000, 'firstWindow');

    // Registered before any application code runs, so it observes the same
    // events OG's own `window.onerror` observes. It records; it suppresses
    // nothing.
    try { await page.addInitScript(NOISE.INIT_SCRIPT); }
    catch (e) { log(`          (could not install the error instrument: ${e.message})`); }
    try { await page.evaluate(NOISE.INIT_SCRIPT); } catch (e) { /* the init script covers reloads */ }

    page.on('pageerror', (e) => errors.record('pageerror',
      String((e && e.stack) || (e && e.message) || e).slice(0, 600)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.record('console', 'console: ' + m.text().slice(0, 600));
    });

    mark('startup', 'load-the-window');
    await withTimeout(page.waitForLoadState('domcontentloaded'), 60000, 'domcontentloaded');
    await d.sleep(7000);

    const installed = await app.evaluate(({ dialog }, p) => {
      if (!global.__pilotOrigShowOpenDialog) {
        global.__pilotOrigShowOpenDialog = dialog.showOpenDialog;
      }
      global.__pilotDialogPath = p;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [global.__pilotDialogPath] });
      return typeof global.__pilotOrigShowOpenDialog === 'function';
    }, bad);
    stubInstalled = true;
    note(`${prefix}2.1`, 'native folder dialog stubbed in the main process, original retained',
      installed === true, `returning ${bad}`);

    const chooseFolder = async () => {
      await page.evaluate(() => { location.hash = '#/repo/add'; });
      await d.sleep(2500);
      try { await page.locator('.choose').first().click({ timeout: 30000 }); }
      catch (e) { log(`          (choose folder: ${String(e.message).split('\n')[0]})`); }
    };

    const markBad = d.journalLines(built);
    mark(EC.NEGATIVE_PHASE, EC.NEGATIVE_OPERATION);
    await chooseFolder();
    await d.sleep(7000);
    errors.endPhase();
    const badRefusals = d.journalSince(built, markBad)
      .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
    note(`${prefix}2.2`, 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 140)
                         : 'no boundary refusal was journalled for the bad dialog result');
    note(`${prefix}2.3`, 'nothing was created at the outside probe path', !fs.existsSync(bad), bad);

    log(`\n${prefix}3  open the synthetic graph through the ordinary workflow`);
    mark('open-graph', 'choose-folder-permitted-root');
    await app.evaluate((_e, p) => { global.__pilotDialogPath = p; }, GRAPH);
    await chooseFolder();
    await d.sleep(22000);

    // ---------------- the exact-path gate ----------------
    mark('assert-loaded-path', 'read-ogs-own-current-repository');
    const reported = await page.evaluate((key) => {
      const out = { api: null, apiError: null, storage: null, storageKeysSeen: 0 };
      try {
        const api = (window.logseq && window.logseq.api) || null;
        out.api = api && typeof api.get_current_graph === 'function'
          ? api.get_current_graph() : null;
        if (out.api && typeof out.api === 'object') {
          out.api = { url: out.api.url || null, name: out.api.name || null,
                      path: out.api.path || null };
        }
      } catch (e) { out.apiError = String(e && e.message); }
      try {
        out.storage = localStorage.getItem(key);
        out.storageKeysSeen = localStorage.length;
      } catch (e) { /* storage may be unavailable; the verdict fails closed */ }
      return out;
    }, CURRENT_REPO_KEY).catch((e) => ({ api: null, apiError: String(e.message),
                                         storage: null, storageKeysSeen: 0 }));

    const verdict = currentGraphVerdict({
      api: reported.api,
      storage: reported.storage,
      approved: GRAPH,
      allowedRoot: B.allowedRootReal(),
    });

    note(`${prefix}3.1`,
      "OG's OWN current repository is exactly this run's graph, asserted before any feature use",
      verdict.ok, `${verdict.reason}: ${verdict.detail}`);
    note(`${prefix}3.2`,
      'the gate compares the ACTIVE graph, not stored history, and fails closed',
      verdict.ok,
      `answered by ${verdict.source || 'nothing'}; ` +
      `API ${reported.api ? 'reported a graph' : `reported none${reported.apiError ? ` (${reported.apiError})` : ''}`}, ` +
      `${CURRENT_REPO_KEY} ${reported.storage ? 'present' : 'absent'}; ` +
      `${reported.storageKeysSeen} localStorage key(s) present, none of which can satisfy ` +
      'this check by merely mentioning the path');

    if (!verdict.ok) {
      throw new Error(`the active graph is not this run's approved graph ` +
                      `(${verdict.reason}: ${verdict.detail})`);
    }

    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await d.sleep(3500);
    };
    const parkPointer = () => page.mouse.move(5, 5).catch(() => null);

    const session = {
      app, page, appPid, ownedTree, built, graph: GRAPH, goTo, parkPointer,
      activeGraph: verdict.active,
      journalSince: (n) => d.journalSince(built, n),
      journalLines: () => d.journalLines(built),
      collectErrorEvidence: () => NOISE.collectEvidence(page),
    };
    handedOver = true;
    return session;
  } catch (e) {
    if (!handedOver) await abandon(String((e && e.message) || e));
    throw e;
  }
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

module.exports = {
  resolve, open, close, withTimeout, sleep, BUILDS,
  canonicalGraphPath, currentGraphVerdict, describeRejected,
  LOCAL_DB_PREFIX, CURRENT_REPO_KEY,
};
