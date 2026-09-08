#!/usr/bin/env node
'use strict';
//
// The F27 inline-context LIFECYCLE scenario.
//
//   node f27-inline/checks/inline-lifecycle-checks.js
//
// `inline-loaded-graph-checks.js` establishes the STATIC reading behaviour on a
// graph nothing writes to. This scenario asks the question that one cannot:
// what happens to an OPEN panel when the graph changes underneath it.
//
// It is a separate session, on its own fresh synthetic graph, because the two
// claims are incompatible in one run — that one asserts zero content changes,
// and this one changes content on purpose.
//
// WHAT COUNTS AS A CHANGE HERE. Every write is a whole-file body declared in
// `make-lifecycle-graph.js`, applied through OG's own file watcher — the same
// path an external editor or a sync client uses. Nothing forces a render:
// there is no remount, no refresh control, no navigation to make a panel catch
// up, and no closing and reopening. The scenario WAITS, with a bounded poll,
// for the application to converge on its own, and reports what it observed if
// it does not.
//
// One page is never written and its bytes are compared before and after. Every
// other page's exact end state is asserted against the declared expectation.
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
const LG = require('./make-lifecycle-graph.js');
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
const applied = [];
const observations = {};
const sleep = OP.sleep;

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  // A detail string that throws must never destroy the rest of the run's
  // evidence. The first session of this scenario ended that way: a panel that
  // was closed when the detail assumed it was open threw, and every later
  // check was lost. Same lesson as the outgoing batch, one level down.
  let text;
  try { text = String(typeof detail === 'function' ? detail() : detail); }
  catch (e) { text = `(could not describe this result: ${e.message})`; }
  const detail_ = text;
  detail = detail_;
  results.push({ id, title, ok: !!ok, detail: String(detail) });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${title}\n          ${detail}`);
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 inline context: lifecycle of an OPEN panel while the graph changes ===\n');

  // ---------- L0 : preconditions ----------
  say('L0  preconditions');
  if (!fs.existsSync(EXE)) throw new Error(`packaged feature app not found at ${EXE}`);
  const preflight = require(path.join(RES_APP, 'pilot-preflight.js'));
  const v = preflight.verify(RES_APP);
  record('L0.1', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}, renderer ${v.manifest.builtFrom.rendererRevision}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  record('L0.2', 'this is the inline feature build on this branch',
    v.manifest.schema === ID.SCHEMA &&
      v.manifest.builtFrom.branch === 'feature/f27-inline-context' &&
      v.manifest.rendererBuild.rebuiltHere === true,
    `${v.manifest.schema} / ${v.manifest.builtFrom.branch} / ` +
    `renderer ${v.manifest.builtFrom.rendererRevision}`);

  // ---------- L1 : a fresh, MUTABLE synthetic graph ----------
  say('\nL1  a fresh synthetic graph this run is permitted to change');
  const built = LG.build();
  const GRAPH = B.assertInsideAllowedRoot('lifecycle graph', built.graph);
  record('L1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${built.pages} pages, ${LG.MUTATIONS.length} declared mutations)`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = before[LG.CONTROL_FILE];
  record('L1.2', 'the control page is hashed before anything happens', !!controlBefore,
    controlBefore ? `${LG.CONTROL_FILE} ${controlBefore.sha256.slice(0, 16)}… (${controlBefore.bytes} bytes)`
                  : 'control page missing');

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-inline-lifecycle-inert-probe');
  record('L1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- L2 : launch ----------
  say('\nL2  launch, then a BAD dialog result');
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
    record('L2.1', 'native folder dialog stubbed in the main process, original retained',
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
    record('L2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 140)
                         : 'no boundary refusal was journalled for the bad dialog result');
    record('L2.3', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- L3 : the good path ----------
    say('\nL3  open the synthetic graph through the ordinary workflow');
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
    record('L3.1', "the loaded graph is this run's own, asserted before any feature use",
      loadedPathOk, loadedPathOk ? GRAPH : `no reference to it in ${loadedStr.slice(0, 300)}`);
    const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                       /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
    record('L3.2', 'no graph outside the permitted root is referenced by the app state',
      !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');
    if (!loadedPathOk) throw new Error('the synthetic graph did not load; not proceeding');

    // ---------- helpers ----------
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
    const parkPointer = () => page.mouse.move(5, 5).catch(() => null);

    // Everything about this feature on screen, plus the focus, in one read.
    const ilState = () => page.evaluate(() => {
      const main = document.querySelector('#main-content-container') || document.body;
      const read = (w) => {
        const btn = w.querySelector(':scope > .f27-il-toggle');
        const panel = w.querySelector(':scope > .f27-il-panel');
        const host = w.closest('.block-content');
        const hostEl = w.closest('[blockid]');
        return {
          hostId: hostEl ? hostEl.getAttribute('blockid') : null,
          host: host ? (host.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 46) : '',
          ref: ((w.querySelector('.block-ref-wrap') || {}).innerText || '')
            .replace(/\s+/g, ' ').trim().slice(0, 60),
          warning: !!w.querySelector('.warning'),
          expanded: btn ? btn.getAttribute('aria-expanded') : null,
          btnId: btn ? btn.id : null,
          open: !!panel,
          panel: panel ? {
            id: panel.id,
            label: panel.getAttribute('aria-label') || '',
            crumb: ((panel.querySelector('.f27-il-crumb') || {}).innerText || '')
              .replace(/\s+/g, ' ').trim(),
            unavailable: !!panel.querySelector('.f27-il-unavailable'),
            canOpenTarget: !!panel.querySelector('.f27-il-source'),
            canExpand: !!panel.querySelector('.f27-il-ctx-toggle'),
            ctxOpen: !!panel.querySelector('.f27-ctx'),
            ctxLines: [...panel.querySelectorAll('.f27-ctx-line')]
              .map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70)),
            ctxPage: ((panel.querySelector('.f27-ctx-page') || {}).innerText || '').trim(),
            descLines: [...panel.querySelectorAll('.f27-desc-line')]
              .map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70)),
            text: (panel.innerText || ''),
          } : null,
        };
      };
      return {
        main: [...main.querySelectorAll('.f27-il')].map(read),
        panels: document.querySelectorAll('.f27-il-panel').length,
        active: (document.activeElement && document.activeElement.className) || '',
        activeId: (document.activeElement && document.activeElement.id) || '',
        activeTag: (document.activeElement && document.activeElement.tagName) || '',
        editors: document.querySelectorAll('textarea.editor-input').length,
        hash: location.hash,
      };
    }).catch((e) => ({ error: String(e.message), main: [] }));

    // Wait for the APPLICATION to converge. Nothing here re-renders anything:
    // it polls what is on screen. The elapsed time is reported either way, so a
    // slow convergence and a non-convergence are different observations.
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

    // Both the outer `.ls-block` and its `.block-content` carry `blockid`; the
    // outer one is taken, and `closest('[blockid]')` in `ilState` resolves to
    // the nearest, so a reference is always attributed to the block it is in.
    const hostBlock = (uuid) =>
      page.locator(`#main-content-container [blockid="${uuid}"]`).first();

    const openPanel = async (uuid, nth, label) => {
      await parkPointer();
      await attempt(label, 25000,
        () => hostBlock(uuid).locator('.f27-il-toggle').nth(nth).click(), null);
      await sleep(1600);
    };
    const openContext = async (uuid, label) => {
      await parkPointer();
      await attempt(label, 25000,
        () => hostBlock(uuid).locator('.f27-il-ctx-toggle').first().click(), null);
      await sleep(2500);
    };

    // Apply one DECLARED write and record it. Nothing is derived at run time.
    const mutate = (id) => {
      const m = LG.MUTATIONS.find((x) => x.id === id);
      if (!m) throw new Error(`no declared mutation ${id}`);
      const r = LG.apply(GRAPH, m);
      applied.push(Object.assign({ at: new Date().toISOString() }, r));
      say(`          ✎ ${r.id} wrote ${r.file}: ${r.what} (exact bytes: ${r.wroteExactly})`);
      return r;
    };

    // Let OG's own first-open housekeeping finish before anything is opened.
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

    phase('lifecycle', 'settle-before-any-interaction');
    const settled = await settleGraph(GRAPH, 5000, 90000);
    record('L3.3', 'the graph went quiet before any feature was touched', settled.quiet,
      settled.quiet ? `no file changed for 5s after ${(settled.ms / 1000).toFixed(1)}s`
                    : `still changing after ${(settled.ms / 1000).toFixed(1)}s`);

    await goTo('Lifecycle Reading');
    let st = await ilState();
    observations.initial = st;
    record('L3.4', 'the reading page renders one control per ordinary inline reference',
      st.main.length === 6 && st.main.every((w) => w.expanded === 'false'),
      `${st.main.length} wrapped reference(s), hosts ` +
      `${JSON.stringify([...new Set(st.main.map((w) => (w.host || '').slice(0, 18)))])}`);

    // ================================================================
    // CASE 1 — the target is EDITED while the panel is open
    // ================================================================
    say('\nL4  case 1: the target is edited while the panel is open');
    phase('lifecycle', 'edit-target-while-open');

    await openPanel(LG.UUID.hostEdit, 0, 'open the edited host panel');
    await openContext(LG.UUID.hostEdit, 'open its context');
    st = await ilState();
    const beforeEdit = wrapAt(st, LG.UUID.hostEdit);
    observations.beforeEdit = beforeEdit;
    record('L4.1', 'both disclosures are open and show the target as it is now',
      !!beforeEdit && beforeEdit.open && !!beforeEdit.panel && beforeEdit.panel.ctxOpen &&
        beforeEdit.panel.text.includes(LG.EDIT_TEXT_BEFORE.slice(0, 12)) &&
        beforeEdit.panel.label.includes('편집 전'),
      () => (beforeEdit && beforeEdit.panel
        ? `label ${JSON.stringify(beforeEdit.panel.label.slice(0, 60))}, ` +
          `context open ${beforeEdit.panel.ctxOpen}` : 'the panel did not open'));

    // The CONTROL for this case is the APPLICATION's own record that it handled
    // the change: `handle-add-and-change!` backs the previous content up before
    // re-parsing, so a new file under `logseq/bak/` is proof the watcher ran and
    // the file was transacted — proof that does not depend on anything rendering.
    const baks = () => {
      const d = path.join(GRAPH, 'logseq', 'bak', 'pages', 'Lifecycle Targets');
      try { return fs.readdirSync(d).length; } catch (e) { return 0; }
    };
    const baksBefore = baks();
    mutate('M1');
    const handled = await (async () => {
      const started = Date.now();
      for (;;) {
        if (baks() > baksBefore) return { ok: true, ms: Date.now() - started };
        if (Date.now() - started > 30000) return { ok: false, ms: Date.now() - started };
        await sleep(500);
      }
    })();
    record('L4.2', "the application itself processed the change: it backed the file up and re-parsed it",
      handled.ok, handled.ok
        ? `a new logseq/bak entry appeared after ${(handled.ms / 1000).toFixed(1)}s, ` +
          'which only handle-add-and-change! writes'
        : `no backup after ${(handled.ms / 1000).toFixed(1)}s — the watcher did not process the write`);

    const panelConverged = await waitFor('the open panel updates',
      (s) => {
        const w = wrapAt(s, LG.UUID.hostEdit);
        return !!w && w.open && !!w.panel && w.panel.text.includes('편집 후');
      }, 30000);
    observations.afterEdit = panelConverged.state;
    const afterEdit = wrapAt(panelConverged.state, LG.UUID.hostEdit);

    record('L4.3', 'the OPEN panel converged on the edited target, with no interaction at all',
      panelConverged.ok, panelConverged.ok
        ? `after ${(panelConverged.ms / 1000).toFixed(1)}s, without closing, reopening, ` +
          'navigating or forcing a render'
        : `NOT after ${(panelConverged.ms / 1000).toFixed(1)}s — the panel still reads ` +
          `${JSON.stringify(afterEdit && afterEdit.panel ? afterEdit.panel.text.replace(/\s+/g, ' ').slice(0, 120) : null)}`);

    record('L4.4', 'it stayed open through the change: neither disclosure closed itself',
      !!afterEdit && afterEdit.open && !!afterEdit.panel && afterEdit.panel.ctxOpen,
      () => (afterEdit ? `open ${afterEdit.open}, context ${afterEdit.panel && afterEdit.panel.ctxOpen}`
                       : 'the wrapper is gone'));

    record('L4.5', "the panel's context lines show the new text, not the old",
      !!afterEdit && !!afterEdit.panel &&
        afterEdit.panel.ctxLines.some((l) => l.includes('편집 후')) &&
        !afterEdit.panel.ctxLines.some((l) => l.includes('편집 전')),
      () => (afterEdit && afterEdit.panel ? JSON.stringify(afterEdit.panel.ctxLines) : 'n/a'));

    // OG's OWN inline reference text, recorded rather than required. It has its
    // own reactive subscription, keyed by database id, which a from-disk
    // re-parse invalidates — and `re-render-root!` then discards that query
    // altogether. This slice does not touch that path, and the observation is
    // kept so the record says what the reader actually sees beside the panel.
    observations.ogReferenceAfterEdit = afterEdit ? afterEdit.ref : null;
    record('L4.6', "OG's own reference text beside the panel is recorded as it is, not required",
      true,
      afterEdit
        ? `it reads ${JSON.stringify(afterEdit.ref.slice(0, 46))} — ` +
          (afterEdit.ref.includes('편집 후')
            ? 'it converged too'
            : "still the old text: OG's own block-reference query is keyed by " +
              'database id, which a from-disk re-parse replaces. Pre-existing ' +
              'OG behaviour, unchanged by this slice')
        : 'no reference on screen');

    // A diagnosis, recorded AFTER the assertions above are already made, so it
    // can explain a failure without being able to manufacture a pass: the
    // target's own page is opened and read, which says whether the change
    // reached the database at all.
    await goTo('Lifecycle Targets');
    const targetPageText = await page.evaluate(() =>
      ((document.querySelector('#main-content-container') || document.body).innerText || '')
        .replace(/\s+/g, ' ').slice(0, 400));
    observations.targetPageAfterEdit = targetPageText;
    record('L4.7', "the database itself holds the edit — recorded from the target's own page",
      targetPageText.includes('편집 후'),
      targetPageText.includes('편집 후')
        ? 'the target page shows the new text, so the transaction landed'
        : `the target page shows ${JSON.stringify(targetPageText.slice(0, 120))}`);
    await goTo('Lifecycle Reading');

    // ================================================================
    // CASE 2 — the target is DELETED while the host reference remains
    // ================================================================
    say('\nL5  case 2: the target is deleted while its host reference remains');
    phase('lifecycle', 'delete-target-while-open');

    await openPanel(LG.UUID.hostDel, 0, 'open the deleted host panel');
    await openContext(LG.UUID.hostDel, 'open its context');
    st = await ilState();
    const beforeDelete = wrapAt(st, LG.UUID.hostDel);
    observations.beforeDelete = beforeDelete;
    record('L5.1', 'the panel is open on a target that still exists',
      !!beforeDelete && beforeDelete.open && !!beforeDelete.panel &&
        beforeDelete.panel.ctxOpen && !beforeDelete.panel.unavailable &&
        beforeDelete.panel.canExpand,
      () => (beforeDelete && beforeDelete.panel
        ? `label ${JSON.stringify(beforeDelete.panel.label.slice(0, 50))}` : 'no panel'));

    const pageFiles = () => Object.keys(GH.snapshot(GRAPH))
      .filter((f) => f.startsWith('pages/')).sort();
    const filesBeforeDelete = pageFiles();
    mutate('M2');

    const deleteConverged = await waitFor('the open panel reaches its unavailable state',
      (s) => {
        const w = wrapAt(s, LG.UUID.hostDel);
        return !!w && (!w.open || w.panel.unavailable);
      }, 30000);
    observations.afterDelete = deleteConverged.state;
    const afterDelete = wrapAt(deleteConverged.state, LG.UUID.hostDel);

    record('L5.2', 'the open panel reached an honest state without any interaction',
      deleteConverged.ok, () => (deleteConverged.ok
        ? `after ${(deleteConverged.ms / 1000).toFixed(1)}s: ` +
          (afterDelete && afterDelete.open ? 'unavailable, in place' : 'the panel closed with the host')
        : `NOT after ${(deleteConverged.ms / 1000).toFixed(1)}s — still showing ` +
          `${JSON.stringify(afterDelete && afterDelete.panel ? afterDelete.panel.label.slice(0, 60) : null)}`));

    record('L5.3', 'no stale control that cannot work survives the deletion',
      !!afterDelete && (!afterDelete.open || !afterDelete.panel ||
        (afterDelete.panel.unavailable && !afterDelete.panel.canExpand &&
         !afterDelete.panel.canOpenTarget && !afterDelete.panel.ctxOpen)),
      () => (afterDelete && afterDelete.panel
        ? `unavailable ${afterDelete.panel.unavailable}, context control ` +
          `${afterDelete.panel.canExpand}, open-target control ${afterDelete.panel.canOpenTarget}, ` +
          `stale context ${afterDelete.panel.ctxOpen}`
        : 'the panel is gone'));

    record('L5.4', 'the host reference itself remains, and no identifier reaches the panel',
      !!afterDelete && (!afterDelete.panel || !UUID_RE.test(afterDelete.panel.text)),
      () => (afterDelete
        ? `host still on screen, ref reads ${JSON.stringify(afterDelete.ref.slice(0, 40))}`
        : 'the host is gone, which it must not be'));

    // Only `pages/` counts. OG's own housekeeping — a versioned backup under
    // `logseq/bak/`, `.DS_Store` — is not a page being created to stand in for
    // the deleted target, and counting it as one would make this check say
    // something it does not mean.
    const filesAfterDelete = pageFiles();
    const createdPages = filesAfterDelete.filter((f) => !filesBeforeDelete.includes(f));
    record('L5.5', 'no page was created to stand in for the deleted target',
      createdPages.length === 0,
      `${filesBeforeDelete.length} page file(s) before, ${filesAfterDelete.length} after; ` +
      `created ${JSON.stringify(createdPages)}`);

    // ================================================================
    // CASE 3 — the host reference is RETARGETED A -> B -> A
    // ================================================================
    say('\nL6  case 3: the host reference is retargeted A -> B -> A');
    phase('lifecycle', 'retarget-host');

    await openPanel(LG.UUID.hostRetarget, 0, 'open the retarget host panel');
    await openContext(LG.UUID.hostRetarget, 'open its context');
    st = await ilState();
    const onA = wrapAt(st, LG.UUID.hostRetarget);
    observations.retargetOnA = onA;
    record('L6.1', 'the panel is open on target A',
      !!onA && onA.open && !!onA.panel && onA.panel.ctxOpen && /Target A/.test(onA.panel.label),
      () => (onA && onA.panel ? `label ${JSON.stringify(onA.panel.label.slice(0, 60))}` : 'no panel'));

    mutate('M3');
    const toB = await waitFor('the host reference points at B',
      (s) => {
        const w = wrapAt(s, LG.UUID.hostRetarget);
        return !!w && /Target B/.test(w.ref);
      }, 30000);
    observations.retargetOnB = toB.state;
    const nowB = wrapAt(toB.state, LG.UUID.hostRetarget);
    record('L6.2', "the host now references B, and B never shows A's old context",
      toB.ok && !!nowB && !(nowB.open && nowB.panel && /Target A/.test(nowB.panel.label)),
      () => (toB.ok
        ? `ref ${JSON.stringify(nowB.ref.slice(0, 40))}, panel ` +
          `${nowB.open && nowB.panel ? JSON.stringify(nowB.panel.label.slice(0, 50)) : 'closed'}`
        : `the host did not retarget within ${(toB.ms / 1000).toFixed(1)}s`));

    mutate('M4');
    const backToA = await waitFor('the host reference points at A again',
      (s) => {
        const w = wrapAt(s, LG.UUID.hostRetarget);
        return !!w && /Target A/.test(w.ref);
      }, 30000);
    observations.retargetBackToA = backToA.state;
    const againA = wrapAt(backToA.state, LG.UUID.hostRetarget);
    record('L6.3', 'coming back to A does NOT resurrect the panel that was open on A',
      backToA.ok && !!againA && !againA.open && againA.expanded === 'false',
      () => (backToA.ok
        ? `panel ${againA.open ? 'REAPPEARED without being asked for' : 'stayed closed'}, ` +
          `aria-expanded ${againA.expanded}`
        : `the host did not retarget back within ${(backToA.ms / 1000).toFixed(1)}s`));

    // Navigate away and back: nothing is remembered.
    await openPanel(LG.UUID.hostRetarget, 0, 'open it again on A');
    st = await ilState();
    const reopened = wrapAt(st, LG.UUID.hostRetarget);
    record('L6.4', 'it opens again, on the CURRENT target, with a fresh disclosure state',
      !!reopened && reopened.open && !!reopened.panel &&
        /Target A/.test(reopened.panel.label) && !reopened.panel.ctxOpen,
      () => (reopened && reopened.panel
        ? `label ${JSON.stringify(reopened.panel.label.slice(0, 50))}, ` +
          `context ${reopened.panel.ctxOpen} (must be false: the second disclosure is not remembered)`
        : `no panel opened (open=${reopened && reopened.open})`));

    await goTo('Lifecycle Control');
    const away = await ilState();
    record('L6.5', 'navigating away unmounts every panel',
      away.panels === 0 && away.main.length === 0,
      `${away.panels} panel(s), ${away.main.length} wrapped reference(s) on the control page`);
    await goTo('Lifecycle Reading');
    const back = await ilState();
    observations.afterNavigation = back;
    record('L6.6', 'coming back, nothing is remembered and every control is closed',
      back.main.length >= 5 && back.main.every((w) => !w.open) && back.panels === 0,
      `${back.main.length} reference(s), ${back.main.filter((w) => w.open).length} open`);

    // ================================================================
    // CASE 4 — repeated occurrences, focus, and host removal
    // ================================================================
    say('\nL7  case 4: repeated occurrences, focus, and the host removed underneath');
    phase('lifecycle', 'repeats-focus-and-host-removal');

    await openPanel(LG.UUID.hostTwice, 0, 'open occurrence 1');
    st = await ilState();
    let twice = st.main.filter((w) => w.hostId === LG.UUID.hostTwice);
    record('L7.1', 'opening one occurrence leaves the other closed',
      twice.length === 2 && twice[0].open && !twice[1].open,
      `open flags ${JSON.stringify(twice.map((w) => w.open))}`);

    await openPanel(LG.UUID.hostTwice, 1, 'open occurrence 2');
    st = await ilState();
    twice = st.main.filter((w) => w.hostId === LG.UUID.hostTwice);
    const distinctPanels = new Set(twice.filter((w) => w.open).map((w) => w.panel.id));
    record('L7.2', 'both are open at once, with panels of their own',
      twice.length === 2 && twice[0].open && twice[1].open && distinctPanels.size === 2,
      () => `panel ids ${JSON.stringify(twice.map((w) => (w.panel || {}).id))}`);

    // Escape from INSIDE occurrence 1's panel must return focus to occurrence
    // 1's control — not to occurrence 2's, which is still mounted and open.
    const occ1 = hostBlock(LG.UUID.hostTwice).locator('.f27-il').nth(0);
    await attempt('focus inside occurrence 1', 15000,
      () => occ1.locator('.f27-il-ctx-toggle').first().focus(), null);
    const focusInside = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Escape', 15000, () => page.keyboard.press('Escape'), null);
    await sleep(1200);
    st = await ilState();
    twice = st.main.filter((w) => w.hostId === LG.UUID.hostTwice);
    observations.repeatFocus = { focusInside, active: st.active, activeId: st.activeId,
                                 open: twice.map((w) => w.open) };
    record('L7.3', "Escape closes only its own panel and returns focus to only its own control",
      /f27-il-ctx-toggle/.test(focusInside) &&
        twice.length === 2 && !twice[0].open && twice[1].open &&
        st.activeId === twice[0].btnId,
      () => `focus was ${JSON.stringify(focusInside)}, is now ${JSON.stringify(st.activeId)}; ` +
      `occurrence 1's control is ${JSON.stringify(twice[0] && twice[0].btnId)}; ` +
      `open flags ${JSON.stringify(twice.map((w) => w.open))}`);

    // Now the host that is removed while its panel is open.
    await openPanel(LG.UUID.hostDoomed, 0, 'open the doomed host panel');
    await openContext(LG.UUID.hostDoomed, 'open its context');
    st = await ilState();
    const doomed = wrapAt(st, LG.UUID.hostDoomed);
    const panelsBeforeRemoval = st.panels;
    record('L7.4', 'the doomed host has an open panel before it is removed',
      !!doomed && doomed.open && !!doomed.panel && doomed.panel.ctxOpen &&
        panelsBeforeRemoval === 2,
      `${panelsBeforeRemoval} panel(s) open in total (this one and occurrence 2)`);

    // Focus its own control, so the removal has something to lose.
    await attempt('focus the doomed control', 15000,
      () => hostBlock(LG.UUID.hostDoomed).locator('.f27-il-toggle').first().focus(), null);
    mutate('M5');

    const hostGone = await waitFor('the removed host leaves the page',
      (s) => !s.main.some((w) => w.hostId === LG.UUID.hostDoomed), 30000);
    observations.afterHostRemoval = hostGone.state;
    const post = hostGone.state;
    const survivors = post.main.filter((w) => w.hostId === LG.UUID.hostTwice);
    record('L7.5', 'removing the host takes its panel with it — no orphan is left behind',
      hostGone.ok && post.panels === 1,
      hostGone.ok ? `${post.panels} panel(s) left (occurrence 2's), ` +
                    `after ${(hostGone.ms / 1000).toFixed(1)}s`
                  : `the host was still on screen after ${(hostGone.ms / 1000).toFixed(1)}s`);

    record('L7.6', 'the surviving occurrence keeps its own state, untouched by the removal',
      survivors.length === 2 && !survivors[0].open && survivors[1].open,
      `open flags ${JSON.stringify(survivors.map((w) => w.open))}`);

    record('L7.7', 'focus did not jump to an unrelated occurrence when its owner disappeared',
      !post.main.some((w) => w.btnId && w.btnId === post.activeId),
      `active element is ${JSON.stringify(post.activeTag)} ` +
      `${JSON.stringify(post.activeId || post.active.slice(0, 40))}; ` +
      'no surviving control claims it');

    record('L7.8', 'no editor was opened at any point in this run', post.editors === 0,
      `${post.editors} editor(s) open`);

    // ---------- L8 : restore ----------
    say('\nL8  restore the native dialog');
    phase('shutdown', 'restore-and-close');
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
    record('L8.1', 'the dialog stub was removed and the original restored',
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
      record('L8.2', 'every owned process stopped, addressed by retained PID only',
        stillAlive.length === 0,
        `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
        `stage ${r.stage}` + (stillAlive.length ? `, still alive: ${stillAlive.join(', ')}` : ', none still alive'));
    }
  }

  // ---------- L9 : exactly the changes this run declared ----------
  say('\nL9  the graph, after the application closed');
  errors.endPhase();

  const after = GH.snapshot(GRAPH);
  const controlAfter = after[LG.CONTROL_FILE];
  record('L9.1', 'the control page is byte-identical: this run wrote only what it named',
    !!controlAfter && !!controlBefore && controlAfter.sha256 === controlBefore.sha256 &&
      controlAfter.bytes === controlBefore.bytes,
    controlAfter ? `${LG.CONTROL_FILE} ${controlAfter.sha256.slice(0, 16)}… ` +
                   `(${controlAfter.bytes} bytes), unchanged`
                 : 'the control page is missing');

  const endMismatches = [];
  for (const [rel, want] of Object.entries(LG.EXPECTED_END)) {
    const p = B.assertInsideAllowedRoot('end-state page', path.join(GRAPH, rel));
    const got = fs.readFileSync(p, 'utf8');
    if (got !== want) endMismatches.push({ file: rel, wantBytes: want.length, gotBytes: got.length });
  }
  record('L9.2', 'every page ends at exactly the content this run declared it would',
    endMismatches.length === 0,
    endMismatches.length
      ? `${endMismatches.length} mismatch(es): ${JSON.stringify(endMismatches)}`
      : `${Object.keys(LG.EXPECTED_END).length} page(s) match their declared end state byte for byte`);

  record('L9.3', 'every write this run performed is recorded, and each wrote exactly its declared body',
    applied.length === LG.MUTATIONS.length && applied.every((a) => a.wroteExactly && a.changed),
    `${applied.length} of ${LG.MUTATIONS.length} declared mutations applied: ` +
    applied.map((a) => `${a.id} ${a.file.split('/').pop()}`).join('; '));

  const cmp = GH.compare(before, after);
  const declaredFiles = new Set(Object.keys(LG.EXPECTED_END));
  const undeclared = cmp.content.filter((c) => !declaredFiles.has(c.file));
  record('L9.4', 'no content file changed that this run did not declare',
    undeclared.length === 0,
    `${cmp.content.length} content change(s), all declared: ` +
    `${JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))}` +
    (undeclared.length ? `; UNDECLARED ${JSON.stringify(undeclared)}` : ''));
  record('L9.5', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ${cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 8).join('; ')}`
      : 'none');

  const boundaryEntries = journalSince(0).filter((e) => e.guard === 'graph-boundary');
  record('L9.6', 'boundary refusals were journalled during this run', boundaryEntries.length > 0,
    `${boundaryEntries.length} refusal(s) recorded`);

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(cls.unexpected, 5)) say(`          UNEXPECTED: ${line}`);
  record('L9.7', 'every window error was entitled by the deliberate negative test',
    cls.unexpected.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${cls.unexpected.length} unexpected` +
    (cls.unexpected.length ? `: ${EC.describe(cls.unexpected, 1)[0]}` : ''));
  const duringLifecycle = errors.entries().filter((e) => e.phase === 'lifecycle');
  record('L9.8', 'no uncaught page error arrived while the lifecycle cases ran',
    duringLifecycle.length === 0,
    duringLifecycle.length ? `${duringLifecycle.length}: ${duringLifecycle[0].text.slice(0, 200)}`
                           : '0 during the lifecycle phase');
  record('L9.9', 'nothing that unmounts a panel was thrown', cls.renderFailures.length === 0,
    cls.renderFailures.length ? String(cls.renderFailures[0].text).slice(0, 250)
                              : `0 render failures among ${errors.entries().length} captured line(s)`);

  fs.writeFileSync(path.join(EVIDENCE, 'lifecycle-observations.json'), JSON.stringify({
    graph: GRAPH, applied, observations,
    errors: errors.entries(), phases: errors.phases(),
  }, null, 2));

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'lifecycle-summary.json'), JSON.stringify({
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
    fs.writeFileSync(path.join(EVIDENCE, 'lifecycle-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), applied, results,
    }, null, 2));
    // An aborted run must still leave everything it observed. The first session
    // of this scenario aborted and took its own evidence with it.
    fs.writeFileSync(path.join(EVIDENCE, 'lifecycle-observations.json'), JSON.stringify({
      aborted: String((e && e.message) || e), applied, observations,
      errors: errors.entries(), phases: errors.phases(),
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
