#!/usr/bin/env node
'use strict';
//
// The F27 inline-context EXPLICIT REFRESH, in the packaged application.
//
//   node f27-inline/checks/inline-refresh-checks.js
//
// WHAT THIS ASKS THAT THE OTHER THREE SCENARIOS CANNOT.
//
// `inline-transaction-checks.js` proves that an OPEN panel converges by itself
// when the graph changes through the application — and records, as an
// observation, the one thing that does not: the incoming-reference section does
// not re-read while it stays open. It loads a level when asked and replays what
// it read, so a source that appears afterwards shows up in a freshly opened
// section and not in one that was already open.
//
// This scenario is about the control that answers that. Refresh reads THIS
// panel's context again — the target, its breadcrumb, and the incoming
// references — without navigating, without re-indexing, without transacting
// anything, and without touching any other panel.
//
// Every graph change here is made by the application, through
// `logseq.api.update_block` and `logseq.api.remove_block`, each of which goes
// through `frontend.handler.editor` and the outliner. Nothing writes a file.
// The intentional changes are recorded in `applied`, separately from the
// read-only assertions; and the refresh-only phase is measured on its own, with
// the graph hashed on both sides of it, so "Refresh writes nothing" is a
// measurement rather than a claim.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted
// BEFORE any feature interaction.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const ID = require(path.join(REPO, 'f27-inline', 'src', 'feature-identity.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const RG = require('./make-refresh-graph.js');
const EC = require('./error-classifier.js');

const APP_NAME = 'Logseq-OG-F27-Inline';
const APP_DIR = path.join(FEATURE_DIR, 'out', `${APP_NAME}-darwin-x64`, `${APP_NAME}.app`);
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', APP_NAME);
const RES_APP = path.join(APP_DIR, 'Contents', 'Resources', 'app');
const STATE_ROOT = path.join(os.userInfo().homedir, 'Library', 'Application Support',
                             ID.PRODUCT_NAME, ID.STATE_DIR);
const JOURNAL = path.join(STATE_ROOT, 'userData', 'pilot-guard-journal.jsonl');
const EVIDENCE = path.join(FEATURE_DIR, 'evidence');

const results = [];
let ownedTree = [];
const errors = EC.createRecorder();
// Every INTENTIONAL change this run makes to the graph, with the call that made
// it. Kept apart from the read-only assertions on purpose: a scenario that
// mixes the two cannot say which of its observations were caused by itself.
const applied = [];
const observations = {};
const sleep = OP.sleep;

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  let text;
  try { text = String(typeof detail === 'function' ? detail() : detail); }
  catch (e) { text = `(could not describe this result: ${e.message})`; }
  results.push({ id, title, ok: !!ok, detail: text });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${title}\n          ${text}`);
  return ok;
}
function phase(name, operation) {
  errors.phase(name, operation);
  say(`  ┈ phase: ${name}${operation ? ` (${operation})` : ''}`);
}
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms); }),
  ]);
}
async function attempt(label, ms, fn, fallback) {
  try { return await withTimeout(fn(), ms, label); }
  catch (e) { say(`          (${label}: ${e.message})`); return fallback; }
}
const journalLines = () => (fs.existsSync(JOURNAL)
  ? fs.readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).length : 0);
function journalSince(n) {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean)
    .slice(n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

const U = RG.UUID;
const T = RG.TEXT;

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 inline context: reading the panel again, on purpose ===\n');

  // ---------- R0 : preconditions ----------
  say('R0  preconditions');
  if (!fs.existsSync(EXE)) throw new Error(`packaged feature app not found at ${EXE}`);
  const preflight = require(path.join(RES_APP, 'pilot-preflight.js'));
  const v = preflight.verify(RES_APP);
  record('R0.1', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}, renderer ${v.manifest.builtFrom.rendererRevision}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  record('R0.2', 'this is the inline feature build on this branch',
    v.manifest.schema === ID.SCHEMA &&
      v.manifest.builtFrom.branch === 'feature/f27-inline-context' &&
      v.manifest.rendererBuild.rebuiltHere === true,
    `${v.manifest.schema} / ${v.manifest.builtFrom.branch} / ` +
    `renderer ${v.manifest.builtFrom.rendererRevision}`);

  // ---------- R1 : a fresh graph ----------
  say('\nR1  a fresh synthetic graph; nothing writes its files but the application');
  const built = RG.build();
  const GRAPH = B.assertInsideAllowedRoot('refresh graph', built.graph);
  record('R1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${built.pages} pages)`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = before[RG.CONTROL_FILE];
  const readingBefore = before[RG.READING_FILE];
  record('R1.2', 'the control page and the reading page are hashed before anything happens',
    !!controlBefore && !!readingBefore,
    () => `${RG.CONTROL_FILE} ${controlBefore.sha256.slice(0, 16)}…, ` +
          `${RG.READING_FILE} ${readingBefore.sha256.slice(0, 16)}…`);

  const stubBefore = RG.filesMentioning(GRAPH, U.tgtStub);
  record('R1.3', 'the unwritten identity appears in exactly one file, and defines no block',
    stubBefore.length === 1 && stubBefore[0] === RG.READING_FILE,
    JSON.stringify(stubBefore));

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-inline-refresh-inert-probe');
  record('R1.4', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- R2 : launch ----------
  say('\nR2  launch, then a BAD dialog result');
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));
  let app = null;
  for (let a = 1; a <= 2 && !app; a++) {
    try {
      app = await withTimeout(_electron.launch({ executablePath: EXE, timeout: 120000 }),
                              180000, 'electron launch');
    } catch (e) {
      if (a === 2) throw e;
      say(`  (launch attempt ${a} failed: ${String(e.message).split('\n')[0]}; retrying once)`);
      await sleep(10000);
    }
  }
  let appPid = null;
  let stubInstalled = false;
  try {
    appPid = await attempt('main pid', 20000, () => app.evaluate(() => process.pid), null);
    if (appPid) ownedTree = OP.descendants(appPid);
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
      dialog.showOpenDialog = async () =>
        ({ canceled: false, filePaths: [global.__pilotDialogPath] });
      return typeof global.__pilotOrigShowOpenDialog === 'function';
    }, BAD);
    stubInstalled = true;
    record('R2.1', 'native folder dialog stubbed in the main process, original retained',
      installed === true, `returning ${BAD}`);

    const markBad = journalLines();
    const chooseFolder = async (label) => {
      await page.evaluate(() => { location.hash = '#/repo/add'; });
      await sleep(2500);
      return attempt(label, 30000, () => page.locator('.choose').first().click(), null);
    };
    phase(EC.NEGATIVE_PHASE, EC.NEGATIVE_OPERATION);
    await chooseFolder('choose folder (bad)');
    await sleep(7000);
    errors.endPhase();
    const badRefusals = journalSince(markBad)
      .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
    record('R2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 140)
                         : 'no boundary refusal was journalled for the bad dialog result');
    record('R2.3', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- R3 : the good path ----------
    say('\nR3  open the synthetic graph through the ordinary workflow');
    phase('open-graph', 'choose-folder-permitted-root');
    await app.evaluate((_e, p) => { global.__pilotDialogPath = p; }, GRAPH);
    await chooseFolder('choose folder (good)');
    await sleep(22000);

    phase('assert-loaded-path', 'read-the-application-state');
    const loaded = await attempt('loaded repo', 20000, () => page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/repo|graph/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 300);
      }
      return { ls: out, hash: location.hash };
    }), {});
    const loadedStr = JSON.stringify(loaded.ls || {});
    const loadedPathOk = loadedStr.includes(GRAPH);
    record('R3.1', "the loaded graph is this run's own, asserted before any feature use",
      loadedPathOk, loadedPathOk ? GRAPH : `no reference to it in ${loadedStr.slice(0, 300)}`);
    const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                       /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
    record('R3.2', 'no graph outside the permitted root is referenced by the app state',
      !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');
    if (!loadedPathOk) throw new Error('the synthetic graph did not load; not proceeding');

    // ================= helpers =================
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const parkPointer = () => page.mouse.move(5, 5).catch(() => null);
    const hashNow = () => page.evaluate(() => location.hash);

    // One reading of every wrapped reference on the page, and of the panel each
    // one has open. Nothing here clicks: it is the observation the assertions
    // below are made from.
    const ilState = () => page.evaluate(() => {
      const main = document.querySelector('#main-content-container') || document.body;
      const read = (w) => {
        const btn = w.querySelector(':scope > .f27-il-toggle');
        const panel = w.querySelector(':scope > .f27-il-panel');
        const hostEl = w.closest('[blockid]');
        const inBody = panel ? panel.querySelector('.f27-in-body') : null;
        return {
          hostId: hostEl ? hostEl.getAttribute('blockid') : null,
          expanded: btn ? btn.getAttribute('aria-expanded') : null,
          btnId: btn ? btn.id : null,
          open: !!panel,
          panel: panel ? {
            id: panel.id,
            label: panel.getAttribute('aria-label') || '',
            crumb: ((panel.querySelector('.f27-il-crumb') || {}).innerText || '')
              .replace(/\s+/g, ' ').trim(),
            snapshotNote: ((panel.querySelector('.f27-il-snapshot') || {}).innerText || '')
              .replace(/\s+/g, ' ').trim(),
            refreshControls: panel.querySelectorAll('.f27-il-refresh').length,
            refreshLabel: (() => {
              const r = panel.querySelector('.f27-il-refresh');
              return (r && r.getAttribute('aria-label')) || '';
            })(),
            unavailable: !!panel.querySelector('.f27-il-unavailable'),
            canOpenTarget: !!panel.querySelector('.f27-il-source'),
            ctxOpen: !!panel.querySelector('.f27-ctx'),
            ctxToggle: ((panel.querySelector('.f27-il-ctx-toggle') || {}).innerText || '').trim(),
            inOpen: !!inBody,
            inToggle: ((panel.querySelector('.f27-in-toggle') || {}).innerText || '').trim(),
            inCount: ((panel.querySelector('.f27-in-count') || {}).innerText || '').trim(),
            // The referring blocks' OWN text is what identifies a source. The
            // breadcrumb only names the page they live on, and every source in
            // this fixture lives on the same page.
            inTexts: [...panel.querySelectorAll('.f27-in-text')]
              .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90)),
            inMarks: [...panel.querySelectorAll('.f27-in-mark')]
              .map((x) => (x.innerText || '').trim()),
            inPath: [...panel.querySelectorAll('.f27-in-path-step')]
              .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)),
            inExplorable: panel.querySelectorAll('.f27-in-explore').length,
            inNote: ((panel.querySelector('.f27-in-body .f27-ctx-note') || {}).innerText || '').trim(),
          } : null,
        };
      };
      return {
        main: [...main.querySelectorAll('.f27-il')].map(read),
        panels: document.querySelectorAll('.f27-il-panel').length,
        active: (document.activeElement && document.activeElement.className) || '',
        activeId: (document.activeElement && document.activeElement.id) || '',
        activeTag: (document.activeElement && document.activeElement.tagName) || '',
        editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
        hash: location.hash,
      };
    }).catch((e) => ({ error: String(e.message), main: [] }));

    const waitFor = async (label, predicate, ms = 30000) => {
      const started = Date.now();
      let last = null;
      for (;;) {
        last = await ilState();
        let hit = false;
        try { hit = predicate(last); } catch (e) { hit = false; }
        if (hit) return { ok: true, ms: Date.now() - started, state: last };
        if (Date.now() - started > ms) return { ok: false, ms: Date.now() - started, state: last };
        await sleep(500);
      }
    };

    const wrapAt = (state, hostUuid, nth = 0) =>
      state.main.filter((w) => w.hostId === hostUuid)[nth] || null;
    const hostBlock = (uuid) =>
      page.locator(`#main-content-container [blockid="${uuid}"]`).first();
    const clickIn = async (uuid, sel, label, nth = 0) => {
      await parkPointer();
      await attempt(label, 25000, () => hostBlock(uuid).locator(sel).nth(nth).click(), null);
      await sleep(1600);
    };
    const openPanel = (uuid, label) => clickIn(uuid, '.f27-il-toggle', label);
    const openContext = (uuid, label) => clickIn(uuid, '.f27-il-ctx-toggle', label);
    const openInbound = async (uuid, label) => {
      await clickIn(uuid, '.f27-in-toggle', label);
      await sleep(2500);
    };
    const refresh = async (uuid, label) => {
      await clickIn(uuid, '.f27-il-refresh', label);
      await sleep(2500);
    };

    // The ORDINARY APPLICATION API. Each of these goes through
    // `frontend.handler.editor` and the outliner — the same path a plugin, a
    // command or the UI itself takes. Nothing here writes a file.
    const api = async (fn, args, what) => {
      const r = await page.evaluate(([f, a]) => {
        const ns = globalThis.logseq && globalThis.logseq.api;
        if (!ns || typeof ns[f] !== 'function') {
          return { ok: false, error: `logseq.api.${f} is not available` };
        }
        try { ns[f].apply(null, a); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }, [fn, args]);
      applied.push({ at: new Date().toISOString(), via: `logseq.api.${fn}`, args, what,
                     ok: !!r.ok, error: r.error || null });
      say(`          ✎ logseq.api.${fn} — ${what}${r.ok ? '' : ` (FAILED: ${r.error})`}`);
      await sleep(1500);
      return r;
    };

    const settleGraph = async (dir, quietMs, maxMs) => {
      const stamp = () => {
        const out = [];
        (function walk(d) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
              const st = fs.statSync(p);
              out.push(`${p}:${st.size}:${st.mtimeMs}`);
            }
          }
        })(dir);
        return out.sort().join('\n');
      };
      const started = Date.now();
      let last = stamp();
      let lastChange = Date.now();
      for (;;) {
        if (Date.now() - started > maxMs) return { quiet: false, ms: Date.now() - started };
        await sleep(1000);
        const now = stamp();
        if (now !== last) { last = now; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= quietMs) return { quiet: true, ms: Date.now() - started };
      }
    };

    // Datascript's own listener table, in the running application, plus the
    // identity of the connection itself — a re-index REPLACES the connection,
    // so a stable identity is what proves none happened.
    const listeners = () => page.evaluate(() => {
      try {
        const repo = frontend.state.get_current_repo();
        const conn = frontend.db.conn.get_db.cljs$core$IFn$_invoke$arity$2(repo, false);
        const keys = frontend.util.f27_inline_watch.listener_keys(conn);
        if (!globalThis.__f27conn) globalThis.__f27conn = conn;
        return {
          ok: true,
          count: cljs.core.count(keys),
          keys: cljs.core.pr_str(keys),
          sameConn: globalThis.__f27conn === conn,
        };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });

    // Read once here, so `sameConn` below compares against the connection this
    // run started on rather than one taken half way through it.
    const listenersAtStart = await listeners();
    record('R3.3', 'the connection is recorded now, and no panel holds a listener yet',
      listenersAtStart.ok && listenersAtStart.count === 0,
      () => `${listenersAtStart.count} listener(s): ${listenersAtStart.keys}`);

    phase('refresh', 'settle-before-any-interaction');
    const settled = await settleGraph(GRAPH, 5000, 90000);
    record('R3.4', 'the graph went quiet before any feature was touched', settled.quiet,
      settled.quiet ? `no file changed for 5s after ${(settled.ms / 1000).toFixed(1)}s`
                    : `still changing after ${(settled.ms / 1000).toFixed(1)}s`);

    await goTo('Refresh Reading');
    let st = await ilState();
    record('R3.5', 'the reading page renders one control per ordinary inline reference',
      st.main.length === 4 && st.main.every((w) => w.expanded === 'false'),
      `${st.main.length} wrapped reference(s), all closed: ` +
      `${st.main.every((w) => w.expanded === 'false')}`);

    // ================================================================
    // R4 — the first reading, and what the panel says about it
    // ================================================================
    say('\nR4  open the panel, its context and its incoming references');
    phase('refresh', 'open-the-first-reading');
    await openPanel(U.hostMain, 'open the main panel');
    await openContext(U.hostMain, 'open its context');
    await openInbound(U.hostMain, 'open its incoming references');

    const firstRead = await waitFor('the first reading of the incoming references',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inTexts.length > 0;
      }, 30000);
    st = firstRead.state;
    let w0 = wrapAt(st, U.hostMain);
    observations.firstRead = w0 && w0.panel;
    record('R4.1', 'the incoming-reference section lists exactly the sources the fixture wrote',
      firstRead.ok && !!w0 && w0.panel.inTexts.length === RG.MAIN_INBOUND.atStart &&
        w0.panel.inTexts.some((x) => x.includes('출처 하나')) &&
        w0.panel.inTexts.some((x) => x.includes('출처 셋')),
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), declared ` +
            `${RG.MAIN_INBOUND.atStart}: ${JSON.stringify(w0 && w0.panel ? w0.panel.inTexts : null)}`);

    record('R4.2', 'the panel offers a Refresh control, above the content and again at its end',
      !!w0 && w0.panel.refreshControls === 2 && w0.panel.refreshLabel.length > 0,
      () => `${w0 && w0.panel ? w0.panel.refreshControls : 0} control(s), ` +
            `named ${JSON.stringify(w0 && w0.panel ? w0.panel.refreshLabel : null)}`);

    record('R4.3', 'and it says in words that its lists are read rather than live',
      !!w0 && /Refresh/.test(w0.panel.snapshotNote) && w0.panel.snapshotNote.length > 40,
      () => JSON.stringify(w0 && w0.panel ? w0.panel.snapshotNote.slice(0, 200) : null));

    // ================================================================
    // R5 — a source APPEARS while the section is open
    // ================================================================
    say('\nR5  a block starts referring to the target while the section is open');
    phase('refresh', 'add-an-incoming-source');
    const preJoin = wrapAt(await ilState(), U.hostMain);
    const beforeJoin = (preJoin && preJoin.panel ? preJoin.panel.inTexts : []).slice();
    await api('update_block',
              [U.srcJoins, `${T.srcJoinsAfter} ((${U.tgtMain}))`, null],
              'a block that STARTS referring to the main target');
    await sleep(6000);

    st = await ilState();
    w0 = wrapAt(st, U.hostMain);
    // OBSERVED, not assumed, and the reason this control exists: the section
    // replays the level it read, so a source that appears afterwards is not in
    // it. This is the accepted inbound behaviour (B3/B7), not a defect.
    record('R5.1', 'the OPEN section still shows what it read: it is a snapshot',
      !!w0 && w0.panel.inOpen &&
        !w0.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다')) &&
        w0.panel.inTexts.length === beforeJoin.length,
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), unchanged from ` +
            `${beforeJoin.length}; the new source is ${w0 && w0.panel &&
              w0.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다')) ? 'PRESENT' : 'absent'}`);

    const hashBeforeRefresh = await hashNow();
    await refresh(U.hostMain, 'press Refresh on the main panel');
    const joined = await waitFor('the new source after Refresh',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen &&
               w.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다'));
      }, 30000);
    st = joined.state;
    w0 = wrapAt(st, U.hostMain);
    observations.afterJoinRefresh = w0 && w0.panel;
    record('R5.2', 'Refresh shows the current list, with the source that has just appeared',
      joined.ok && !!w0 && w0.panel.inTexts.length === RG.MAIN_INBOUND.afterJoin,
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), declared ` +
            `${RG.MAIN_INBOUND.afterJoin}: ${JSON.stringify(w0 && w0.panel ? w0.panel.inTexts : null)}`);

    record('R5.3', 'the panel was not closed and re-opened: every disclosure the reader opened is still open',
      !!w0 && w0.open && w0.expanded === 'true' && w0.panel.ctxOpen && w0.panel.inOpen &&
        w0.panel.id === (observations.firstRead || {}).id,
      () => `open=${w0 && w0.open}, context=${w0 && w0.panel && w0.panel.ctxOpen}, ` +
            `section=${w0 && w0.panel && w0.panel.inOpen}, ` +
            `same panel id=${!!w0 && w0.panel.id === (observations.firstRead || {}).id}`);

    record('R5.4', 'and nothing navigated', (await hashNow()) === hashBeforeRefresh,
      `${hashBeforeRefresh} → ${await hashNow()}`);

    // ================================================================
    // R6 — a source GOES AWAY while the section is open
    // ================================================================
    say('\nR6  a source stops referring, and another is removed outright');
    phase('refresh', 'remove-incoming-sources');
    await api('update_block', [U.srcJoins, T.srcJoinsRemoved, null],
              'the same block, no longer referring to the main target');
    await api('remove_block', [U.srcGone, null],
              'a source block removed outright while the section is open');
    await sleep(6000);

    st = await ilState();
    w0 = wrapAt(st, U.hostMain);
    record('R6.1', 'the open section still shows both of them: still a snapshot',
      !!w0 && w0.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다')) &&
        w0.panel.inTexts.some((x) => x.includes('출처 셋')),
      () => JSON.stringify(w0 && w0.panel ? w0.panel.inTexts : null));

    await refresh(U.hostMain, 'press Refresh again');
    const shrunk = await waitFor('the shortened list after Refresh',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen &&
               !w.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다')) &&
               !w.panel.inTexts.some((x) => x.includes('출처 셋'));
      }, 30000);
    st = shrunk.state;
    w0 = wrapAt(st, U.hostMain);
    observations.afterRemovalRefresh = w0 && w0.panel;
    record('R6.2', 'Refresh drops the source that stopped referring and the one that was deleted',
      shrunk.ok && !!w0 && w0.panel.inTexts.length === RG.MAIN_INBOUND.afterRemoval &&
        w0.panel.inTexts.some((x) => x.includes('출처 하나')),
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), declared ` +
            `${RG.MAIN_INBOUND.afterRemoval}: ${JSON.stringify(w0 && w0.panel ? w0.panel.inTexts : null)}`);

    // ================================================================
    // R7 — the keyboard
    // ================================================================
    say('\nR7  the keyboard alone');
    phase('refresh', 'keyboard-operation');
    const tabbed = await page.evaluate((btnId) => {
      const b = document.getElementById(btnId);
      if (!b) return { ok: false, error: 'the toggle control is not on screen' };
      b.focus();
      return { ok: true, from: document.activeElement.className };
    }, w0.btnId);
    await page.keyboard.press('Tab');
    await sleep(700);
    st = await ilState();
    record('R7.1', "Tab from the reference's own control reaches Refresh first",
      tabbed.ok && /f27-il-refresh/.test(st.active) && st.activeTag === 'BUTTON',
      () => `focus moved from ${JSON.stringify(tabbed.from)} to ` +
            `${JSON.stringify(st.active)} <${st.activeTag}>`);

    // Enter on the focused control. Something must have changed for this to be
    // observable, so a source is added first — through the ordinary API.
    await api('update_block', [U.srcJoins, `${T.srcJoinsAfter} ((${U.tgtMain}))`, null],
              'the joining source refers to the target again, for the keyboard case');
    await sleep(5000);
    await page.evaluate(() => {
      const b = document.querySelector('.f27-il-panel .f27-il-refresh');
      if (b) b.focus();
    });
    await page.keyboard.press('Enter');
    await sleep(3000);
    const byEnter = await waitFor('the list after Enter on Refresh',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen &&
               w.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다'));
      }, 30000);
    st = byEnter.state;
    w0 = wrapAt(st, U.hostMain);
    record('R7.2', 'Enter on the focused Refresh control reads the list again',
      byEnter.ok && !!w0 && w0.open && w0.panel.ctxOpen && w0.panel.inOpen &&
        w0.panel.inTexts.length === RG.MAIN_INBOUND.afterRejoin,
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), declared ` +
            `${RG.MAIN_INBOUND.afterRejoin}: ` +
            `${JSON.stringify(w0 && w0.panel ? w0.panel.inTexts : null)}`);

    record('R7.3', 'and the focus is still on the control that was pressed',
      /f27-il-refresh/.test(st.active), JSON.stringify(st.active));

    // ================================================================
    // R8 — the inner walk, and where a refresh leaves it
    // ================================================================
    say('\nR8  walking one level in, and what Refresh does to the walk');
    phase('refresh', 'inner-traversal-reset');
    st = await ilState();
    w0 = wrapAt(st, U.hostMain);
    const pathBefore = w0.panel.inPath.slice();
    record('R8.0', 'exactly one row in the list has a source of its own to step into',
      !!w0 && w0.panel.inExplorable === 1,
      () => `${w0 && w0.panel ? w0.panel.inExplorable : '?'} explorable row(s) among ` +
            `${w0 && w0.panel ? w0.panel.inTexts.length : 0}`);
    await clickIn(U.hostMain, '.f27-in-explore', 'step into one of the sources');
    await sleep(3500);
    const walked = await waitFor('a second step on the path',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inPath.length > pathBefore.length;
      }, 30000);
    st = walked.state;
    w0 = wrapAt(st, U.hostMain);
    observations.walked = w0 && w0.panel;
    record('R8.1', 'the explorer walked one level in, and the path records both steps',
      walked.ok && !!w0 && w0.panel.inPath.length === pathBefore.length + 1,
      () => `path ${JSON.stringify(w0 && w0.panel ? w0.panel.inPath : null)}`);

    await page.evaluate(() => {
      const b = document.querySelector('.f27-il-panel .f27-il-refresh');
      if (b) b.focus();
    });
    await page.keyboard.press(' ');
    await sleep(3500);
    const reset = await waitFor('the walk back at its root after Refresh',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inPath.length === pathBefore.length;
      }, 30000);
    st = reset.state;
    w0 = wrapAt(st, U.hostMain);
    observations.afterReset = w0 && w0.panel;
    record('R8.2', 'Space on Refresh works too, and returns the walk to this block',
      reset.ok && !!w0 && w0.panel.inPath.length === pathBefore.length &&
        w0.panel.inTexts.length === RG.MAIN_INBOUND.afterRejoin,
      () => `path ${JSON.stringify(w0 && w0.panel ? w0.panel.inPath : null)}, ` +
            `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s)`);

    record('R8.3', 'the section stayed OPEN across the reset: it was re-read, not collapsed',
      !!w0 && w0.panel.inOpen && w0.panel.ctxOpen && w0.open,
      () => `panel=${w0 && w0.open}, context=${w0 && w0.panel && w0.panel.ctxOpen}, ` +
            `section=${w0 && w0.panel && w0.panel.inOpen}`);

    // ================================================================
    // R9 — repeat presses, and a cycle
    // ================================================================
    say('\nR9  pressing it repeatedly, and a reference cycle');
    phase('refresh', 'repeat-and-cycle');
    const listBeforeRepeat = w0.panel.inTexts.slice();
    for (let i = 0; i < 3; i++) await refresh(U.hostMain, `repeat refresh ${i + 1}`);
    st = await ilState();
    w0 = wrapAt(st, U.hostMain);
    record('R9.1', 'three presses in a row leave the same panel and the same list',
      !!w0 && w0.open && w0.panel.inOpen &&
        JSON.stringify(w0.panel.inTexts.slice().sort()) ===
          JSON.stringify(listBeforeRepeat.slice().sort()),
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), was ` +
            `${listBeforeRepeat.length}`);

    await clickIn(U.hostMain, '.f27-il-close', 'close the main panel');
    await sleep(1500);

    await openPanel(U.hostCycle, 'open the cycle panel');
    await openContext(U.hostCycle, 'open its context');
    await openInbound(U.hostCycle, 'open its incoming references');
    const cyc0 = await waitFor('the cycle target\'s incoming references',
      (s) => {
        const w = wrapAt(s, U.hostCycle);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inTexts.length > 0;
      }, 30000);
    let wc = wrapAt(cyc0.state, U.hostCycle);
    observations.cycleFirst = wc && wc.panel;
    record('R9.2', 'the mutual pair is listed as an ordinary source at the first level',
      cyc0.ok && !!wc && wc.panel.inTexts.some((x) => x.includes('순환 짝')),
      () => JSON.stringify(wc && wc.panel ? wc.panel.inTexts : null));

    await clickIn(U.hostCycle, '.f27-in-explore', 'step into the other end of the pair');
    await sleep(3500);
    const cycStep = await waitFor('the repeat marked at the second level',
      (s) => {
        const w = wrapAt(s, U.hostCycle);
        return !!w && !!w.panel && w.panel.inMarks.includes('↻');
      }, 30000);
    wc = wrapAt(cycStep.state, U.hostCycle);
    observations.cycleStep = wc && wc.panel;
    record('R9.3', 'stepping in meets an identity already on the path, and it is MARKED, not followed',
      cycStep.ok && !!wc && wc.panel.inMarks.includes('↻') && wc.panel.inExplorable === 0,
      () => `marks ${JSON.stringify(wc && wc.panel ? wc.panel.inMarks : null)}, ` +
            `${wc && wc.panel ? wc.panel.inExplorable : '?'} explorable row(s), ` +
            `path ${JSON.stringify(wc && wc.panel ? wc.panel.inPath : null)}`);

    await refresh(U.hostCycle, 'refresh the cycle panel');
    const cycReset = await waitFor('the cycle walk back at its root',
      (s) => {
        const w = wrapAt(s, U.hostCycle);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inPath.length === 1;
      }, 30000);
    wc = wrapAt(cycReset.state, U.hostCycle);
    record('R9.4', 'a refresh returns the cycle walk to its root and reads it again',
      cycReset.ok && !!wc && wc.panel.inPath.length === 1 &&
        wc.panel.inTexts.some((x) => x.includes('순환 짝')),
      () => `path ${JSON.stringify(wc && wc.panel ? wc.panel.inPath : null)}, ` +
            `${JSON.stringify(wc && wc.panel ? wc.panel.inTexts : null)}`);
    await clickIn(U.hostCycle, '.f27-il-close', 'close the cycle panel');
    await sleep(1200);

    // ================================================================
    // R10 — an identity nobody wrote
    // ================================================================
    say('\nR10 refreshing a panel whose target was never written');
    phase('refresh', 'missing-target');
    await openPanel(U.hostStub, 'open the stub panel');
    st = await ilState();
    let ws = wrapAt(st, U.hostStub);
    record('R10.1', 'it says the target could not be read, and offers no context to expand',
      !!ws && ws.open && !!ws.panel && ws.panel.unavailable && !ws.panel.canOpenTarget,
      () => `unavailable=${ws && ws.panel && ws.panel.unavailable}, ` +
            `open-target offered=${ws && ws.panel && ws.panel.canOpenTarget}`);
    record('R10.2', 'and it still offers Refresh, so an unreadable target can be re-checked',
      !!ws && ws.panel.refreshControls === 2,
      () => `${ws && ws.panel ? ws.panel.refreshControls : 0} control(s)`);

    const errsBeforeStub = errors.entries().length;
    await refresh(U.hostStub, 'refresh the unavailable panel');
    await refresh(U.hostStub, 'refresh it again');
    st = await ilState();
    ws = wrapAt(st, U.hostStub);
    record('R10.3', 'refreshing it keeps the honest state and throws nothing',
      !!ws && ws.open && ws.panel.unavailable && !ws.panel.canOpenTarget &&
        errors.entries().length === errsBeforeStub,
      () => `still unavailable=${ws && ws.panel && ws.panel.unavailable}; ` +
            `${errors.entries().length - errsBeforeStub} new window error(s)`);
    await clickIn(U.hostStub, '.f27-il-close', 'close the stub panel');
    await sleep(1200);

    // ================================================================
    // R11 — two panels, one refreshed
    // ================================================================
    say('\nR11 two panels open at once; only one is refreshed');
    phase('refresh', 'two-independent-panels');
    await openPanel(U.hostMain, 'open the main panel again');
    await openContext(U.hostMain, 'open its context');
    await openInbound(U.hostMain, 'open its incoming references');
    await openPanel(U.hostOther, 'open the second panel');
    await openContext(U.hostOther, 'open its context');
    await openInbound(U.hostOther, 'open its incoming references');

    const both = await waitFor('both sections read',
      (s) => {
        const a = wrapAt(s, U.hostMain);
        const b = wrapAt(s, U.hostOther);
        return !!a && !!b && a.panel && b.panel && a.panel.inOpen && b.panel.inOpen &&
               a.panel.inTexts.length > 0 && b.panel.inTexts.length > 0;
      }, 40000);
    st = both.state;
    const otherBefore = wrapAt(st, U.hostOther).panel.inTexts.slice();
    const mainBefore = wrapAt(st, U.hostMain).panel.inTexts.slice();
    record('R11.1', 'two panels are open at once, each with its own list',
      both.ok && st.panels === 2,
      () => `${st.panels} panel(s); main ${mainBefore.length} row(s), ` +
            `other ${otherBefore.length} row(s)`);

    await api('update_block', [U.srcOtherJoins, `${T.srcOtherJoinsAfter} ((${U.tgtOther}))`, null],
              'a block that starts referring to the SECOND target');
    await api('update_block', [U.srcJoins, T.srcJoinsRemoved, null],
              'the joining source stops referring to the main target again');
    await sleep(6000);

    await refresh(U.hostMain, 'refresh the MAIN panel only');
    const oneRefreshed = await waitFor('the main list current, the other unchanged',
      (s) => {
        const a = wrapAt(s, U.hostMain);
        return !!a && !!a.panel &&
               !a.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다'));
      }, 30000);
    st = oneRefreshed.state;
    const mainAfter = wrapAt(st, U.hostMain);
    const otherAfter = wrapAt(st, U.hostOther);
    observations.mainAfterOnlyRefresh = mainAfter && mainAfter.panel;
    observations.otherAfterOnlyRefresh = otherAfter && otherAfter.panel;
    record('R11.2', 'the panel that was refreshed shows the current list',
      oneRefreshed.ok && !!mainAfter &&
        mainAfter.panel.inTexts.length === RG.MAIN_INBOUND.afterRemoval,
      () => `${mainAfter && mainAfter.panel ? mainAfter.panel.inTexts.length : 0} row(s), ` +
            `declared ${RG.MAIN_INBOUND.afterRemoval}: ` +
            `${JSON.stringify(mainAfter && mainAfter.panel ? mainAfter.panel.inTexts : null)}`);
    record('R11.3', 'and the OTHER panel was not refreshed: it still shows what IT read',
      !!otherAfter && otherAfter.open && otherAfter.panel.inOpen &&
        !otherAfter.panel.inTexts.some((x) => x.includes('now a source of the second target')) &&
        JSON.stringify(otherAfter.panel.inTexts) === JSON.stringify(otherBefore),
      () => `${JSON.stringify(otherAfter && otherAfter.panel ? otherAfter.panel.inTexts : null)} ` +
            `(was ${JSON.stringify(otherBefore)})`);

    await refresh(U.hostOther, 'now refresh the second panel too');
    const otherRefreshed = await waitFor('the second list current as well',
      (s) => {
        const b = wrapAt(s, U.hostOther);
        return !!b && !!b.panel && b.panel.inOpen &&
               b.panel.inTexts.some((x) => x.includes('now a source of the second target'));
      }, 30000);
    const otherNow = wrapAt(otherRefreshed.state, U.hostOther);
    record('R11.4', 'refreshing it in turn shows its own new source, and only its own',
      otherRefreshed.ok && !!otherNow &&
        otherNow.panel.inTexts.length === otherBefore.length + 1,
      () => `${otherNow && otherNow.panel ? otherNow.panel.inTexts.length : 0} row(s), ` +
            `was ${otherBefore.length}: ` +
            `${JSON.stringify(otherNow && otherNow.panel ? otherNow.panel.inTexts : null)}`);

    // ================================================================
    // R12 — what Refresh itself costs
    // ================================================================
    say('\nR12 a refresh-only burst: no write, no listener churn, no re-index, no navigation');
    phase('refresh', 'refresh-only-burst');
    const quietBefore = await settleGraph(GRAPH, 5000, 90000);
    const hashBefore = GH.snapshot(GRAPH);
    const listenersBefore = await listeners();
    const hashUrlBefore = await hashNow();
    record('R12.1', 'the graph is quiet, and both open panels hold exactly one listener each',
      quietBefore.quiet && listenersBefore.ok && listenersBefore.count === 2,
      () => `quiet=${quietBefore.quiet}; ${listenersBefore.count} listener(s): ` +
            `${listenersBefore.keys}`);

    for (let i = 0; i < 6; i++) {
      await refresh(i % 2 ? U.hostOther : U.hostMain, `burst refresh ${i + 1}`);
    }
    const quietAfter = await settleGraph(GRAPH, 5000, 60000);
    const hashAfter = GH.snapshot(GRAPH);
    const listenersAfter = await listeners();
    const cmpBurst = GH.compare(hashBefore, hashAfter);
    record('R12.2', 'six refreshes wrote nothing into the graph',
      quietAfter.quiet && cmpBurst.content.length === 0,
      () => `${cmpBurst.content.length} content change(s) across the burst: ` +
            `${JSON.stringify(cmpBurst.content.map((c) => `${c.change} ${c.file}`))}` +
            `; graph quiet afterwards: ${quietAfter.quiet}`);
    record('R12.2b', 'and OG wrote no housekeeping of its own during it either',
      cmpBurst.housekeeping.length === 0,
      () => (cmpBurst.housekeeping.length
        ? `${cmpBurst.housekeeping.length}: ` +
          JSON.stringify(cmpBurst.housekeeping.map((c) => `${c.change} ${c.file}`))
        : 'none'));
    record('R12.3', 'the listener count and the listener keys are exactly what they were',
      listenersAfter.ok && listenersAfter.count === listenersBefore.count &&
        listenersAfter.keys === listenersBefore.keys,
      () => `${listenersBefore.count} → ${listenersAfter.count}; ` +
            `keys ${listenersAfter.keys === listenersBefore.keys ? 'identical' : 'CHANGED'}`);
    record('R12.4', 'the datascript connection was never replaced, so nothing re-indexed',
      listenersAfter.ok && listenersAfter.sameConn === true,
      () => `same connection object: ${listenersAfter.sameConn}`);
    record('R12.5', 'and nothing navigated', (await hashNow()) === hashUrlBefore,
      `${hashUrlBefore} → ${await hashNow()}`);

    st = await ilState();
    record('R12.6', 'no editor was opened by any of this', st.editors === 0,
      `${st.editors} editor(s) open`);

    const stubAfter = RG.filesMentioning(GRAPH, U.tgtStub);
    record('R12.7', 'refreshing an unreadable target created no page and no block for it',
      stubAfter.length === 1 && stubAfter[0] === RG.READING_FILE &&
        !RG.readPage(GRAPH, RG.READING_FILE).includes(`id:: ${U.tgtStub}`),
      JSON.stringify(stubAfter));

    // ---------- R13 : restore ----------
    say('\nR13 restore the native dialog');
    phase('shutdown', 'restore-and-close');
    await settleGraph(GRAPH, 4000, 60000);
    const restored = await app.evaluate(({ dialog }) => {
      if (global.__pilotOrigShowOpenDialog) {
        dialog.showOpenDialog = global.__pilotOrigShowOpenDialog;
        delete global.__pilotOrigShowOpenDialog;
        delete global.__pilotDialogPath;
      }
      return { stubGone: !global.__pilotOrigShowOpenDialog,
               isFunction: typeof dialog.showOpenDialog === 'function' };
    });
    stubInstalled = false;
    record('R13.1', 'the dialog stub was removed and the original restored',
      restored.stubGone && restored.isFunction, JSON.stringify(restored));
  } finally {
    if (stubInstalled) {
      await attempt('restore stub (cleanup)', 15000, () => app.evaluate(({ dialog }) => {
        if (global.__pilotOrigShowOpenDialog) {
          dialog.showOpenDialog = global.__pilotOrigShowOpenDialog;
          delete global.__pilotOrigShowOpenDialog;
        }
        return true;
      }), null);
    }
    try { await withTimeout(app.close(), 30000, 'app.close'); }
    catch (e) { say(`          (app.close: ${e.message})`); }
    if (appPid) {
      const r = await OP.stop(appPid, (m) => say('          ' + m));
      const stillAlive = ownedTree.filter(OP.alive);
      record('R13.2', 'every owned process stopped, addressed by retained PID only',
        stillAlive.length === 0,
        `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
        `stage ${r.stage}` + (stillAlive.length ? `, still alive: ${stillAlive.join(', ')}` : ', none still alive'));
    }
  }

  // ---------- R14 : the graph, afterwards ----------
  say('\nR14 the graph, after the application closed');
  errors.endPhase();

  const after = GH.snapshot(GRAPH);
  const controlAfter = after[RG.CONTROL_FILE];
  record('R14.1', 'the control page is byte-identical: nothing in this run reached it',
    !!controlAfter && !!controlBefore && controlAfter.sha256 === controlBefore.sha256 &&
      controlAfter.bytes === controlBefore.bytes,
    controlAfter ? `${RG.CONTROL_FILE} ${controlAfter.sha256.slice(0, 16)}… ` +
                   `(${controlAfter.bytes} bytes), unchanged`
                 : 'the control page is missing');

  const readingAfter = after[RG.READING_FILE];
  record('R14.2', 'the reading page is byte-identical too: every case was driven from it, and none edited it',
    !!readingAfter && !!readingBefore && readingAfter.sha256 === readingBefore.sha256,
    readingAfter ? `${RG.READING_FILE} ${readingAfter.sha256.slice(0, 16)}…, unchanged`
                 : 'the reading page is missing');

  const endProblems = [];
  const finalContents = {};
  for (const [rel, want] of Object.entries(RG.EXPECTED_END)) {
    let body = '';
    try { body = RG.readPage(GRAPH, rel); } catch (e) { endProblems.push(`${rel}: ${e.message}`); continue; }
    finalContents[rel] = body;
    for (const s of want.present) {
      if (!body.includes(s)) endProblems.push(`${rel}: missing ${JSON.stringify(s.slice(0, 40))}`);
    }
    for (const s of (want.absent || []).concat(want.absentAfterBeingAdded || [])) {
      if (body.includes(s)) endProblems.push(`${rel}: still contains ${JSON.stringify(s.slice(0, 40))}`);
    }
  }
  record('R14.3', 'the one page the application changed ended in the state this run declared',
    endProblems.length === 0,
    endProblems.length ? JSON.stringify(endProblems)
                       : `${Object.keys(RG.EXPECTED_END).length} page(s) carry exactly the ` +
                         'text this run added and none of the text it removed');

  record('R14.4', 'every change this run made is recorded, with the call that made it',
    applied.length > 0 && applied.every((a) => a.ok !== false),
    `${applied.length} change(s): ` +
    applied.map((a) => a.via.replace('logseq.api.', '')).join(', '));

  const cmp = GH.compare(before, after);
  const declared = new Set(Object.keys(RG.EXPECTED_END));
  const undeclared = cmp.content.filter((c) => !declared.has(c.file));
  record('R14.5', 'no content file changed that this run did not declare',
    undeclared.length === 0,
    `${cmp.content.length} content change(s): ` +
    `${JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))}` +
    (undeclared.length ? `; UNDECLARED ${JSON.stringify(undeclared)}` : ''));
  record('R14.6', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ${cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')}`
      : 'none');

  const boundaryEntries = journalSince(0).filter((e) => e.guard === 'graph-boundary');
  record('R14.7', 'boundary refusals were journalled during this run', boundaryEntries.length > 0,
    `${boundaryEntries.length} refusal(s) recorded`);

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(cls.unexpected, 5)) say(`          UNEXPECTED: ${line}`);
  record('R14.8', 'every window error was entitled by the deliberate negative test',
    cls.unexpected.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${cls.unexpected.length} unexpected` +
    (cls.unexpected.length ? `: ${EC.describe(cls.unexpected, 1)[0]}` : ''));
  const duringRefresh = errors.entries().filter((e) => e.phase === 'refresh');
  record('R14.9', 'no uncaught page error arrived while the refresh cases ran',
    duringRefresh.length === 0,
    duringRefresh.length ? `${duringRefresh.length}: ${duringRefresh[0].text.slice(0, 200)}`
                         : '0 during the refresh phase');
  record('R14.10', 'nothing that unmounts a panel was thrown', cls.renderFailures.length === 0,
    cls.renderFailures.length ? String(cls.renderFailures[0].text).slice(0, 250)
                              : `0 render failures among ${errors.entries().length} captured line(s)`);

  fs.writeFileSync(path.join(EVIDENCE, 'refresh-observations.json'), JSON.stringify({
    graph: GRAPH, applied, observations, finalContents,
    errors: errors.entries(), phases: errors.phases(),
  }, null, 2));

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'refresh-summary.json'), JSON.stringify({
    at: new Date().toISOString(), app: APP_DIR, graph: GRAPH, applied,
    passed: results.length - failed.length, failed: failed.length, results,
  }, null, 2));
  say(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) say(`  FAILED ${f.id} ${f.title}\n      ${f.detail}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  say('\n' + String((e && e.stack) || e) + '\n');
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'refresh-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), applied, results,
    }, null, 2));
    fs.writeFileSync(path.join(EVIDENCE, 'refresh-observations.json'), JSON.stringify({
      aborted: String((e && e.message) || e), applied, observations,
      errors: errors.entries(), phases: errors.phases(),
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
