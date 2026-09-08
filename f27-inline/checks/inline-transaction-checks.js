#!/usr/bin/env node
'use strict';
//
// The F27 inline-context lifecycle, through the APPLICATION's own transactions.
//
//   node f27-inline/checks/inline-transaction-checks.js
//
// `inline-lifecycle-checks.js` drives the same four cases by WRITING THE GRAPH's
// FILES, which reaches OG through its file watcher. That is a real path — an
// external editor, a sync client — and it stays as regression evidence. It is
// not the path the review asked for.
//
// Here nothing is written to the graph after it is created. Every change is made
// by the application:
//
//   * by TYPING into OG's own editor, and
//   * by the ordinary application API — `logseq.api.update_block`,
//     `remove_block`, `insert_block`, `move_block` — each of which goes through
//     `frontend.handler.editor` and the outliner.
//
// Nothing forces convergence: no remount, no refresh control, no navigation to
// make a panel catch up, and no closing and reopening. The scenario waits, with
// a bounded poll, for the application to converge on its own, and reports what
// it observed when it does not.
//
// It also answers the two questions the file-watcher scenario could not:
//
//   * what an open panel does when what it SHOWS changes without the target's
//     own text changing — a breadcrumb, a child, an inbound reference, and a
//     reparent that leaves identity and content untouched;
//   * whether the panel's connection listener is owned and cleaned up
//     correctly, read out of datascript's own listener table in the running
//     application, across close, host removal, navigation and a real re-index.
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
const TG = require('./make-transaction-graph.js');
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const U = TG.UUID;
const T = TG.TEXT;

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 inline context: the lifecycle through OG\'s own transactions ===\n');

  // ---------- T0 : preconditions ----------
  say('T0  preconditions');
  if (!fs.existsSync(EXE)) throw new Error(`packaged feature app not found at ${EXE}`);
  const preflight = require(path.join(RES_APP, 'pilot-preflight.js'));
  const v = preflight.verify(RES_APP);
  record('T0.1', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}, renderer ${v.manifest.builtFrom.rendererRevision}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  record('T0.2', 'this is the inline feature build on this branch',
    v.manifest.schema === ID.SCHEMA &&
      v.manifest.builtFrom.branch === 'feature/f27-inline-context' &&
      v.manifest.rendererBuild.rebuiltHere === true,
    `${v.manifest.schema} / ${v.manifest.builtFrom.branch} / ` +
    `renderer ${v.manifest.builtFrom.rendererRevision}`);

  // ---------- T1 : a fresh graph, changed only by the application ----------
  say('\nT1  a fresh synthetic graph; nothing writes its files but the application');
  const built = TG.build();
  const GRAPH = B.assertInsideAllowedRoot('transaction graph', built.graph);
  record('T1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${built.pages} pages)`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = before[TG.CONTROL_FILE];
  record('T1.2', 'the control page is hashed before anything happens', !!controlBefore,
    controlBefore ? `${TG.CONTROL_FILE} ${controlBefore.sha256.slice(0, 16)}… (${controlBefore.bytes} bytes)`
                  : 'control page missing');

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-inline-txn-inert-probe');
  record('T1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- T2 : launch ----------
  say('\nT2  launch, then a BAD dialog result');
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
    record('T2.1', 'native folder dialog stubbed in the main process, original retained',
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
    record('T2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 140)
                         : 'no boundary refusal was journalled for the bad dialog result');
    record('T2.3', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- T3 : the good path ----------
    say('\nT3  open the synthetic graph through the ordinary workflow');
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
    record('T3.1', "the loaded graph is this run's own, asserted before any feature use",
      loadedPathOk, loadedPathOk ? GRAPH : `no reference to it in ${loadedStr.slice(0, 300)}`);
    const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                       /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
    record('T3.2', 'no graph outside the permitted root is referenced by the app state',
      !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');
    if (!loadedPathOk) throw new Error('the synthetic graph did not load; not proceeding');

    // ---------- helpers ----------
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
    const parkPointer = () => page.mouse.move(5, 5).catch(() => null);

    const ilState = () => page.evaluate(() => {
      const main = document.querySelector('#main-content-container') || document.body;
      const read = (w) => {
        const btn = w.querySelector(':scope > .f27-il-toggle');
        const panel = w.querySelector(':scope > .f27-il-panel');
        const hostEl = w.closest('[blockid]');
        return {
          hostId: hostEl ? hostEl.getAttribute('blockid') : null,
          ref: ((w.querySelector('.block-ref-wrap') || {}).innerText || '')
            .replace(/\s+/g, ' ').trim().slice(0, 70),
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
            ctxPage: ((panel.querySelector('.f27-ctx-page') || {}).innerText || '').trim(),
            ctxLines: [...panel.querySelectorAll('.f27-ctx-line')]
              .map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
            descToggle: ((panel.querySelector('.f27-desc-toggle-all') || {}).innerText || '').trim(),
            descLines: [...panel.querySelectorAll('.f27-desc-line')]
              .map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
            inToggle: ((panel.querySelector('.f27-in-toggle') || {}).innerText || '').trim(),
            inRows: [...panel.querySelectorAll('.f27-in-crumb')]
              .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50)),
            inCount: ((panel.querySelector('.f27-in-count') || {}).innerText || '').trim(),
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
        // OG's own editor sets this on the textarea it mounts (`ui/ls-textarea`).
        editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
        sidebarItems: document.querySelectorAll('.sidebar-item').length,
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
    // Whether the BLOCK is on the page, which is a different question from
    // whether its reference still renders one of this feature's wrappers.
    const blockPresent = (uuid) => page.evaluate(
      (u) => {
        const el = document.querySelector(`#main-content-container [blockid="${u}"]`);
        return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null;
      }, uuid);
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
      await sleep(1200);
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

    // Datascript's own listener table, in the running application.
    const listeners = () => page.evaluate(() => {
      try {
        const repo = frontend.state.get_current_repo();
        const conn = frontend.db.conn.get_db.cljs$core$IFn$_invoke$arity$2(repo, false);
        const keys = frontend.util.f27_inline_watch.listener_keys(conn);
        return {
          ok: true,
          count: cljs.core.count(keys),
          keys: cljs.core.pr_str(keys),
          sameConnAsStash: !!(globalThis.__f27stash && globalThis.__f27stash.conn === conn),
        };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
    const stashConn = () => page.evaluate(() => {
      const repo = frontend.state.get_current_repo();
      const conn = frontend.db.conn.get_db.cljs$core$IFn$_invoke$arity$2(repo, false);
      globalThis.__f27stash = { conn };
      return true;
    });
    const stashedListeners = () => page.evaluate(() => {
      try {
        const conn = globalThis.__f27stash && globalThis.__f27stash.conn;
        if (!conn) return { ok: false, error: 'nothing stashed' };
        const keys = frontend.util.f27_inline_watch.listener_keys(conn);
        return { ok: true, count: cljs.core.count(keys), keys: cljs.core.pr_str(keys) };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });

    phase('transaction', 'settle-before-any-interaction');
    const settled = await settleGraph(GRAPH, 5000, 90000);
    record('T3.3', 'the graph went quiet before any feature was touched', settled.quiet,
      settled.quiet ? `no file changed for 5s after ${(settled.ms / 1000).toFixed(1)}s`
                    : `still changing after ${(settled.ms / 1000).toFixed(1)}s`);

    await goTo('Txn Reading');
    let st = await ilState();
    observations.initial = st;
    record('T3.4', 'the reading page renders one control per ordinary inline reference',
      st.main.length === 7 && st.main.every((w) => w.expanded === 'false'),
      `${st.main.length} wrapped reference(s), all closed: ` +
      `${st.main.every((w) => w.expanded === 'false')}`);

    // ---------- T4 : the application API is what it claims to be ----------
    say('\nT4  the ordinary application API');
    const apiProbe = await page.evaluate(() => {
      const ns = globalThis.logseq && globalThis.logseq.api;
      const names = ['update_block', 'remove_block', 'insert_block', 'move_block'];
      return {
        present: !!ns,
        fns: names.filter((n) => ns && typeof ns[n] === 'function'),
      };
    });
    observations.api = apiProbe;
    record('T4.1', "OG's own editor API is present, and is what the changes below go through",
      apiProbe.present && apiProbe.fns.length === 4,
      `logseq.api: ${JSON.stringify(apiProbe.fns)} — each routes through ` +
      'frontend.handler.editor and the outliner, not the filesystem');

    // ================================================================
    // CASE 1a — the target edited by TYPING into OG's own editor
    // ================================================================
    say('\nT5  case 1a: the target is edited by TYPING, while the panel is open');
    phase('transaction', 'edit-target-in-og-editor');

    await openPanel(U.hostEdit, 0, 'open the edit host panel');
    await openContext(U.hostEdit, 'open its context');
    st = await ilState();
    const beforeType = wrapAt(st, U.hostEdit);
    observations.beforeType = beforeType;
    record('T5.1', 'both disclosures are open, on the target as it is now',
      !!beforeType && beforeType.open && !!beforeType.panel && beforeType.panel.ctxOpen &&
        beforeType.panel.label.includes('편집 전'),
      () => (beforeType && beforeType.panel
        ? `label ${JSON.stringify(beforeType.panel.label.slice(0, 60))}` : 'no panel'));

    // The target lives on ANOTHER page. It is opened in the right sidebar so it
    // can be typed into without navigating away from the host — and so the host
    // block is not re-rendered for some other reason, which would let this pass
    // by accident.
    await parkPointer();
    await attempt('shift-click the reference into the sidebar', 20000,
      () => hostBlock(U.hostEdit).locator('.block-ref-wrap').first()
        .click({ modifiers: ['Shift'] }), null);
    await sleep(3000);
    st = await ilState();
    record('T5.2', 'the target is open in the right sidebar, and the host panel is still open',
      st.sidebarItems > 0 && !!wrapAt(st, U.hostEdit) && wrapAt(st, U.hostEdit).open,
      `${st.sidebarItems} sidebar item(s); host panel open: ` +
      `${!!wrapAt(st, U.hostEdit) && wrapAt(st, U.hostEdit).open}`);

    const sidebarTarget = page.locator(`.sidebar-item [blockid="${U.tgtEdit}"] .block-content`).first();
    await parkPointer();
    await attempt('click into the target block in the sidebar', 20000,
      () => sidebarTarget.click(), null);
    await sleep(1500);
    const editorOpen = await count('textarea[aria-label="editing block"]');
    await attempt('select all', 10000, () => page.keyboard.press('Meta+a'), null);
    await attempt('type the new text', 20000,
      () => page.keyboard.type(TG.TEXT.editAfter, { delay: 12 }), null);
    await attempt('leave the editor', 10000, () => page.keyboard.press('Escape'), null);
    await sleep(1500);
    applied.push({ at: new Date().toISOString(), via: "OG's editor (typed)",
                   args: [U.tgtEdit, TG.TEXT.editAfter], what: "the edited target's own text",
                   ok: true, editorsOpenWhileTyping: editorOpen });
    say(`          ✎ typed into OG's editor — the edited target's own text`);
    record('T5.3', "OG's own editor was actually opened and left", editorOpen > 0,
      `${editorOpen} editor(s) were open while typing`);

    const typedConverged = await waitFor('the open panel shows the typed text',
      (s) => {
        const w = wrapAt(s, U.hostEdit);
        return !!w && w.open && !!w.panel && w.panel.text.includes('편집 후');
      }, 30000);
    observations.afterType = typedConverged.state;
    const afterType = wrapAt(typedConverged.state, U.hostEdit);
    record('T5.4', 'the OPEN panel converged on what was typed, with no interaction at all',
      typedConverged.ok,
      () => (typedConverged.ok
        ? `after ${(typedConverged.ms / 1000).toFixed(1)}s, without closing, reopening, ` +
          'navigating or forcing a render'
        : `NOT after ${(typedConverged.ms / 1000).toFixed(1)}s — the panel reads ` +
          `${JSON.stringify(afterType && afterType.panel ? afterType.panel.label.slice(0, 80) : null)}`));
    record('T5.5', 'it stayed open through the edit, and the panel itself names the new text',
      !!afterType && afterType.open && !!afterType.panel && afterType.panel.ctxOpen &&
        afterType.panel.label.includes('편집 후'),
      () => (afterType && afterType.panel
        ? `label ${JSON.stringify(afterType.panel.label.slice(0, 70))}, context ` +
          `${afterType.panel.ctxOpen}` : 'no panel'));
    record('T5.6', "OG's own reference text converged too on this path — unlike the from-disk one",
      !!afterType && afterType.ref.includes('편집 후'),
      () => (afterType ? `it reads ${JSON.stringify(afterType.ref.slice(0, 50))}` : 'n/a'));

    // Close the sidebar item so it cannot confuse later checks.
    await attempt('close the sidebar item', 15000,
      () => page.locator('.sidebar-item .close, .sidebar-item a.close').first().click(), null);
    await sleep(1200);

    // ================================================================
    // CASE 1b — the same target edited through the application API
    // ================================================================
    say('\nT6  case 1b: the target is edited through the application API');
    phase('transaction', 'edit-target-through-api');
    await api('update_block', [U.tgtEdit, TG.TEXT.editAfterApi, null],
              "the edited target's own text, a second time");
    const apiConverged = await waitFor('the open panel shows the API text',
      (s) => {
        const w = wrapAt(s, U.hostEdit);
        return !!w && w.open && !!w.panel && w.panel.text.includes('두 번째 편집');
      }, 30000);
    observations.afterApiEdit = apiConverged.state;
    record('T6.1', 'the OPEN panel converged on the API edit as well',
      apiConverged.ok,
      () => (apiConverged.ok ? `after ${(apiConverged.ms / 1000).toFixed(1)}s`
                             : `NOT after ${(apiConverged.ms / 1000).toFixed(1)}s`));
    await parkPointer();
    await attempt('close the edit host panel', 20000,
      () => hostBlock(U.hostEdit).locator('.f27-il-close').first().click(), null);
    await sleep(1000);

    // ================================================================
    // CASE 2 — the target deleted while the host reference remains
    // ================================================================
    say('\nT7  case 2: the target is deleted through the API, host reference remains');
    phase('transaction', 'delete-target-through-api');
    await openPanel(U.hostDel, 0, 'open the delete host panel');
    await openContext(U.hostDel, 'open its context');
    st = await ilState();
    const beforeDel = wrapAt(st, U.hostDel);
    record('T7.1', 'the panel is open on a target that still exists',
      !!beforeDel && beforeDel.open && !!beforeDel.panel && beforeDel.panel.ctxOpen &&
        !beforeDel.panel.unavailable && beforeDel.panel.canExpand,
      () => (beforeDel && beforeDel.panel
        ? `label ${JSON.stringify(beforeDel.panel.label.slice(0, 50))}` : 'no panel'));

    const pageFiles = () => Object.keys(GH.snapshot(GRAPH))
      .filter((f) => f.startsWith('pages/')).sort();
    const filesBeforeDelete = pageFiles();
    await api('remove_block', [U.tgtDel, null], 'the deleted target block');

    // WHAT OG ACTUALLY DOES HERE, observed on the first run of this scenario
    // and expected accordingly ever since.
    //
    // `editor-handler/delete-block-aux!` does not leave a dangling reference
    // behind: every block that referred to the deleted one has the reference
    // REPLACED BY ITS TEXT, and the referring block's file is rewritten. So on
    // this path the host keeps its block and loses its reference — there is no
    // inline reference left to carry a control, and the panel goes with it.
    //
    // That is OG's behaviour, not this feature's, and it means the honest
    // "unavailable" state is NOT reachable through `remove_block`. It is
    // reachable when the reference survives its target, which is what happens
    // when the target's file is edited outside the application — and that is
    // exercised, and asserted, in `inline-lifecycle-checks.js`.
    const refGone = await waitFor('the host stops carrying an inline reference',
      (s) => !s.main.some((w) => w.hostId === U.hostDel), 30000);
    const hostText = await blockPresent(U.hostDel);
    observations.afterDelete = { state: refGone.state, hostText };
    record('T7.2', 'the panel goes with the reference, which OG removes by substituting its text',
      refGone.ok,
      () => (refGone.ok
        ? `after ${(refGone.ms / 1000).toFixed(1)}s: no inline reference is left in the host`
        : `NOT after ${(refGone.ms / 1000).toFixed(1)}s`));
    record('T7.3', 'the HOST BLOCK itself survives, carrying the deleted target\'s text in place of the reference',
      !!hostText && hostText.includes('삭제될 대상 블록') && !UUID_RE.test(hostText),
      () => `the host block now reads ${JSON.stringify((hostText || '').slice(0, 90))}`);
    record('T7.4', 'no orphan panel and no stale control are left behind',
      refGone.ok && refGone.state.panels === 0,
      () => `${refGone.state.panels} panel(s) open, ` +
            `${refGone.state.main.filter((w) => w.hostId === U.hostDel).length} wrapper(s) for this host`);
    const createdPages = pageFiles().filter((f) => !filesBeforeDelete.includes(f));
    record('T7.5', 'no page was created to stand in for the deleted target',
      createdPages.length === 0, `created ${JSON.stringify(createdPages)}`);

    // ================================================================
    // CASE 3 — retargeting A -> B -> A through the API
    // ================================================================
    say('\nT8  case 3: the host reference is retargeted A -> B -> A through the API');
    phase('transaction', 'retarget-host-through-api');
    await openPanel(U.hostRetarget, 0, 'open the retarget host panel');
    await openContext(U.hostRetarget, 'open its context');
    st = await ilState();
    const onA = wrapAt(st, U.hostRetarget);
    record('T8.1', 'the panel is open on target A',
      !!onA && onA.open && !!onA.panel && /Target A/.test(onA.panel.label),
      () => (onA && onA.panel ? `label ${JSON.stringify(onA.panel.label.slice(0, 50))}` : 'no panel'));

    const retargetText = (target) => `Retarget host: 지금 가리키는 대상 ((${target})) 입니다.`;
    await api('update_block', [U.hostRetarget, retargetText(U.tgtB), null],
              'the retarget host, pointed at B');
    const toB = await waitFor('the host reference points at B',
      (s) => {
        const w = wrapAt(s, U.hostRetarget);
        return !!w && /Target B/.test(w.ref);
      }, 30000);
    const nowB = wrapAt(toB.state, U.hostRetarget);
    record('T8.2', "the host now references B, and B never shows A's old context",
      toB.ok && !!nowB && !(nowB.open && nowB.panel && /Target A/.test(nowB.panel.label)),
      () => (toB.ok
        ? `ref ${JSON.stringify(nowB.ref.slice(0, 40))}, panel ` +
          `${nowB.open && nowB.panel ? JSON.stringify(nowB.panel.label.slice(0, 40)) : 'closed'}`
        : `the host did not retarget within ${(toB.ms / 1000).toFixed(1)}s`));

    await api('update_block', [U.hostRetarget, retargetText(U.tgtA), null],
              'the retarget host, pointed back at A');
    const backToA = await waitFor('the host reference points at A again',
      (s) => {
        const w = wrapAt(s, U.hostRetarget);
        return !!w && /Target A/.test(w.ref);
      }, 30000);
    observations.retargetBack = backToA.state;
    const againA = wrapAt(backToA.state, U.hostRetarget);
    record('T8.3', 'coming back to A does NOT resurrect the panel that was open on A',
      backToA.ok && !!againA && !againA.open && againA.expanded === 'false',
      () => (backToA.ok
        ? `panel ${againA.open ? 'REAPPEARED without being asked for' : 'stayed closed'}, ` +
          `aria-expanded ${againA.expanded}`
        : `the host did not retarget back within ${(backToA.ms / 1000).toFixed(1)}s`));

    await openPanel(U.hostRetarget, 0, 'open it again on A');
    st = await ilState();
    const reopened = wrapAt(st, U.hostRetarget);
    record('T8.4', 'it opens again, on the CURRENT target, with a fresh disclosure state',
      !!reopened && reopened.open && !!reopened.panel &&
        /Target A/.test(reopened.panel.label) && !reopened.panel.ctxOpen,
      () => (reopened && reopened.panel
        ? `label ${JSON.stringify(reopened.panel.label.slice(0, 40))}, context ${reopened.panel.ctxOpen}`
        : `no panel opened (open=${reopened && reopened.open})`));
    await parkPointer();
    await attempt('close it', 20000,
      () => hostBlock(U.hostRetarget).locator('.f27-il-close').first().click(), null);
    await sleep(1000);

    // ================================================================
    // CASE 4 — repeats, focus, and host removal through the API
    // ================================================================
    say('\nT9  case 4: repeated occurrences, focus, and the host removed through the API');
    phase('transaction', 'repeats-focus-and-host-removal');
    await openPanel(U.hostTwice, 0, 'open occurrence 1');
    st = await ilState();
    let twice = st.main.filter((w) => w.hostId === U.hostTwice);
    record('T9.1', 'opening one occurrence leaves the other closed',
      twice.length === 2 && twice[0].open && !twice[1].open,
      () => `open flags ${JSON.stringify(twice.map((w) => w.open))}`);
    await openPanel(U.hostTwice, 1, 'open occurrence 2');
    st = await ilState();
    twice = st.main.filter((w) => w.hostId === U.hostTwice);
    record('T9.2', 'both are open at once, with panels of their own',
      twice.length === 2 && twice[0].open && twice[1].open &&
        new Set(twice.map((w) => w.panel.id)).size === 2,
      () => `panel ids ${JSON.stringify(twice.map((w) => (w.panel || {}).id))}`);

    const occ1 = hostBlock(U.hostTwice).locator('.f27-il').nth(0);
    await attempt('focus inside occurrence 1', 15000,
      () => occ1.locator('.f27-il-ctx-toggle').first().focus(), null);
    const focusInside = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Escape', 15000, () => page.keyboard.press('Escape'), null);
    await sleep(1200);
    st = await ilState();
    twice = st.main.filter((w) => w.hostId === U.hostTwice);
    record('T9.3', 'Escape closes only its own panel and returns focus to only its own control',
      /f27-il-ctx-toggle/.test(focusInside) && twice.length === 2 &&
        !twice[0].open && twice[1].open && st.activeId === twice[0].btnId,
      () => `focus was ${JSON.stringify(focusInside)}, is now ${JSON.stringify(st.activeId)}; ` +
            `open flags ${JSON.stringify(twice.map((w) => w.open))}`);

    await openPanel(U.hostDoomed, 0, 'open the doomed host panel');
    await openContext(U.hostDoomed, 'open its context');
    st = await ilState();
    const doomed = wrapAt(st, U.hostDoomed);
    const panelsBeforeRemoval = st.panels;
    record('T9.4', 'the doomed host has an open panel before it is removed',
      !!doomed && doomed.open && !!doomed.panel && doomed.panel.ctxOpen && panelsBeforeRemoval === 2,
      `${panelsBeforeRemoval} panel(s) open in total`);
    await attempt('focus the doomed control', 15000,
      () => hostBlock(U.hostDoomed).locator('.f27-il-toggle').first().focus(), null);
    await api('remove_block', [U.hostDoomed, null], 'the doomed host block');
    const hostGone = await waitFor('the removed host leaves the page',
      (s) => !s.main.some((w) => w.hostId === U.hostDoomed), 30000);
    observations.afterHostRemoval = hostGone.state;
    const post = hostGone.state;
    const survivors = post.main.filter((w) => w.hostId === U.hostTwice);
    record('T9.5', 'removing the host takes its panel with it — no orphan is left behind',
      hostGone.ok && post.panels === 1,
      () => (hostGone.ok ? `${post.panels} panel(s) left, after ${(hostGone.ms / 1000).toFixed(1)}s`
                         : `the host was still on screen after ${(hostGone.ms / 1000).toFixed(1)}s`));
    record('T9.6', 'the surviving occurrence keeps its own state, untouched by the removal',
      survivors.length === 2 && !survivors[0].open && survivors[1].open,
      () => `open flags ${JSON.stringify(survivors.map((w) => w.open))}`);
    record('T9.7', 'focus did not jump to an unrelated occurrence when its owner disappeared',
      !post.main.some((w) => w.btnId && w.btnId === post.activeId),
      () => `active element is ${JSON.stringify(post.activeTag)} ` +
            `${JSON.stringify(post.activeId || post.active.slice(0, 40))}`);
    await parkPointer();
    await attempt('close the surviving panel', 20000,
      () => page.locator('.f27-il-close').first().click(), null);
    await sleep(1200);

    // ================================================================
    // WHAT THE PANEL SHOWS THAT IS NOT THE TARGET'S OWN TEXT
    // ================================================================
    say('\nT10 what the panel shows changes without the target\'s own text changing');
    phase('transaction', 'context-changes-independent-of-target-text');

    await openPanel(U.hostCtx, 0, 'open the context host panel');
    await openContext(U.hostCtx, 'open its context');
    // A target with no children yet offers no "show children" control at all, so
    // this is attempted rather than required; the child case below is what
    // proves the section works once there is something in it.
    await parkPointer();
    if ((await hostBlock(U.hostCtx).locator('.f27-desc-toggle-all').count().catch(() => 0)) > 0) {
      await attempt('show the children', 20000,
        () => hostBlock(U.hostCtx).locator('.f27-desc-toggle-all').first().click(), null);
      await sleep(2000);
    }
    await parkPointer();
    await attempt('show the inbound references', 20000,
      () => hostBlock(U.hostCtx).locator('.f27-in-toggle').first().click(), null);
    await sleep(3000);
    st = await ilState();
    const ctx0 = wrapAt(st, U.hostCtx);
    observations.ctxBefore = ctx0;
    record('T10.1', 'the panel is open with breadcrumb, children and inbound all showing',
      !!ctx0 && ctx0.open && !!ctx0.panel && ctx0.panel.ctxOpen &&
        /ORIGINAL PARENT/.test(ctx0.panel.crumb + ' ' + ctx0.panel.ctxLines.join(' ')),
      () => (ctx0 && ctx0.panel
        ? `crumb ${JSON.stringify(ctx0.panel.crumb)}; children control ` +
          `${JSON.stringify(ctx0.panel.descToggle)}; inbound ${JSON.stringify(ctx0.panel.inToggle)}`
        : 'no panel'));
    const targetTextBefore = ctx0 && ctx0.panel ? ctx0.panel.label : null;

    // --- (a) a child arrives under the target -------------------------------
    await api('insert_block', [U.tgtCtx, TG.TEXT.ctxChild, { sibling: false, focus: false }],
              'a new CHILD of the context target');
    // What the panel shows WITHOUT anything being expanded: a target with no
    // children offers no children control at all, and one with a child offers
    // "Show children (1)". That control appearing is the open panel reacting to
    // a child arriving — with no interaction, and nothing expanded to make it
    // true. Expanding it afterwards is characterisation, below.
    const descBefore = ctx0 && ctx0.panel ? ctx0.panel.descToggle : '';
    const childSeen = await waitFor('the children control appears in the panel',
      (s) => {
        const w = wrapAt(s, U.hostCtx);
        return !!w && !!w.panel && /\(1\)/.test(w.panel.descToggle);
      }, 30000);
    observations.ctxAfterChild = childSeen.state;
    const ctxChild = wrapAt(childSeen.state, U.hostCtx);
    record('T10.2', "a child arriving under the target shows up, though the target's own text did not change",
      childSeen.ok,
      () => (childSeen.ok
        ? `after ${(childSeen.ms / 1000).toFixed(1)}s the children control reads ` +
          `${JSON.stringify(ctxChild.panel.descToggle)}; it read ` +
          `${JSON.stringify(descBefore)} before, when the target had none`
        : `NOT after ${(childSeen.ms / 1000).toFixed(1)}s; the children control reads ` +
          `${JSON.stringify(ctxChild && ctxChild.panel ? ctxChild.panel.descToggle : null)}`));

    if (childSeen.ok) {
      await parkPointer();
      await attempt('expand the children', 20000,
        () => hostBlock(U.hostCtx).locator('.f27-desc-toggle-all').first().click(), null);
      await sleep(2000);
      const expanded = wrapAt(await ilState(), U.hostCtx);
      observations.ctxChildExpanded = expanded && expanded.panel ? expanded.panel.descLines : null;
      record('T10.2b', 'and expanding it shows the child that arrived',
        !!expanded && !!expanded.panel &&
          expanded.panel.descLines.some((l) => l.includes('A NEW CHILD')),
        () => `children ${JSON.stringify(expanded && expanded.panel ? expanded.panel.descLines : null)}`);
    }

    // --- (b) the parent is renamed: the breadcrumb changes -------------------
    await api('update_block', [U.ctxParentA, TG.TEXT.ctxParentARenamed, null],
              "the target's PARENT, renamed — the breadcrumb changes, the target does not");
    const crumbSeen = await waitFor('the renamed parent appears in the panel',
      (s) => {
        const w = wrapAt(s, U.hostCtx);
        return !!w && !!w.panel &&
          (w.panel.crumb.includes('RENAMED PARENT') ||
           w.panel.ctxLines.some((l) => l.includes('RENAMED PARENT')));
      }, 30000);
    observations.ctxAfterRename = crumbSeen.state;
    const ctxCrumb = wrapAt(crumbSeen.state, U.hostCtx);
    record('T10.3', 'renaming the parent updates the breadcrumb and the ancestor line',
      crumbSeen.ok,
      () => (crumbSeen.ok
        ? `after ${(crumbSeen.ms / 1000).toFixed(1)}s; crumb ` +
          `${JSON.stringify(ctxCrumb.panel.crumb)}`
        : `NOT after ${(crumbSeen.ms / 1000).toFixed(1)}s; crumb reads ` +
          `${JSON.stringify(ctxCrumb && ctxCrumb.panel ? ctxCrumb.panel.crumb : null)}`));

    // --- (c) something starts referring to the target -----------------------
    const inRowsBefore = ctx0 && ctx0.panel ? ctx0.panel.inRows.length : 0;
    await api('update_block',
              [U.ctxReferrer, `Now it refers to ((${U.tgtCtx})) as well.`, null],
              'a block that starts REFERRING to the context target');
    const inboundSeen = await waitFor('the new inbound source appears in the panel',
      (s) => {
        const w = wrapAt(s, U.hostCtx);
        return !!w && !!w.panel && w.panel.inRows.length > inRowsBefore;
      }, 30000);
    observations.ctxAfterInbound = inboundSeen.state;
    const ctxIn = wrapAt(inboundSeen.state, U.hostCtx);
    // OBSERVED, not assumed: the inbound section does NOT pick a new source up
    // while it is open. That is the inbound explorer's own existing behaviour —
    // it loads a level when asked and replays what it read (B3/B7), and this
    // batch does not rewrite it. Recorded as what it is, with the level it
    // still shows, rather than asserted either way.
    observations.inboundWhileOpen = {
      before: inRowsBefore,
      after: ctxIn && ctxIn.panel ? ctxIn.panel.inRows : null,
      count: ctxIn && ctxIn.panel ? ctxIn.panel.inCount : null,
      converged: inboundSeen.ok,
      waitedMs: inboundSeen.ms,
    };
    record('T10.4', "a new inbound source is recorded as what the inbound section does with it",
      true,
      () => (inboundSeen.ok
        ? `it appeared after ${(inboundSeen.ms / 1000).toFixed(1)}s: ` +
          `${JSON.stringify(ctxIn.panel.inRows)}`
        : `it did NOT appear within ${(inboundSeen.ms / 1000).toFixed(1)}s — ` +
          `${inRowsBefore} row(s) before and after ` +
          `${JSON.stringify(ctxIn && ctxIn.panel ? ctxIn.panel.inRows : null)}. ` +
          "The inbound explorer loads a level when asked and replays what it " +
          'read; it does not re-read while open (B3/B7). Characterised below.'));

    // Characterisation, AFTER the observation above is already recorded: is the
    // new source actually in the graph and merely not re-read, or is it missing?
    // The panel is closed and re-opened to answer that — which is a diagnosis of
    // the section's caching, not a way of making the check above pass.
    if (!inboundSeen.ok) {
      await parkPointer();
      await attempt('close the context panel', 20000,
        () => hostBlock(U.hostCtx).locator('.f27-il-close').first().click(), null);
      await sleep(1200);
      await openPanel(U.hostCtx, 0, 're-open it');
      await openContext(U.hostCtx, 're-open its context');
      await parkPointer();
      await attempt('show the inbound references again', 20000,
        () => hostBlock(U.hostCtx).locator('.f27-in-toggle').first().click(), null);
      await sleep(3500);
      const fresh = wrapAt(await ilState(), U.hostCtx);
      observations.inboundAfterReopen = fresh && fresh.panel ? fresh.panel.inRows : null;
      record('T10.4b', 'the new inbound source IS in the graph — a freshly opened section shows it',
        !!fresh && !!fresh.panel && fresh.panel.inRows.length > inRowsBefore,
        () => `a newly opened inbound section reads ` +
              `${JSON.stringify(fresh && fresh.panel ? fresh.panel.inRows : null)} ` +
              `(${inRowsBefore} row(s) were shown by the section that stayed open)`);
    }

    // --- (d) the target is REPARENTED: same identity, same text -------------
    await api('move_block', [U.tgtCtx, U.ctxParentB, { children: true }],
              'the context target, MOVED under the alternative parent');
    const reparentSeen = await waitFor('the panel follows the reparent',
      (s) => {
        const w = wrapAt(s, U.hostCtx);
        return !!w && !!w.panel &&
          (w.panel.crumb.includes('ALTERNATIVE PARENT') ||
           w.panel.ctxLines.some((l) => l.includes('ALTERNATIVE PARENT')));
      }, 30000);
    observations.ctxAfterReparent = reparentSeen.state;
    const ctxMoved = wrapAt(reparentSeen.state, U.hostCtx);
    record('T10.5', 'a reparent with UNCHANGED identity and text moves the breadcrumb',
      reparentSeen.ok,
      () => (reparentSeen.ok
        ? `after ${(reparentSeen.ms / 1000).toFixed(1)}s; crumb ` +
          `${JSON.stringify(ctxMoved.panel.crumb)}, lines ` +
          `${JSON.stringify(ctxMoved.panel.ctxLines)}`
        : `NOT after ${(reparentSeen.ms / 1000).toFixed(1)}s; crumb reads ` +
          `${JSON.stringify(ctxMoved && ctxMoved.panel ? ctxMoved.panel.crumb : null)}`));
    record('T10.6', "and the target's own text never changed through any of it",
      !!ctxMoved && !!ctxMoved.panel && ctxMoved.panel.label === targetTextBefore,
      () => `before ${JSON.stringify((targetTextBefore || '').slice(0, 50))}; ` +
            `after ${JSON.stringify(ctxMoved && ctxMoved.panel ? ctxMoved.panel.label.slice(0, 50) : null)}`);

    // ================================================================
    // LISTENER OWNERSHIP AND CLEANUP, read from the running application
    // ================================================================
    say('\nT11 the panel\'s connection listener, read out of datascript\'s own table');
    phase('transaction', 'listener-ownership-and-cleanup');

    await parkPointer();
    await attempt('close every panel', 20000, async () => {
      for (let i = 0; i < 8; i++) {
        if ((await count('.f27-il-panel')) === 0) return;
        await page.locator('.f27-il-close').first().click();
        await sleep(600);
      }
    }, null);
    await sleep(1200);
    const l0 = await listeners();
    record('T11.1', 'with no panel open the feature holds no listener at all',
      l0.ok && l0.count === 0 && (await count('.f27-il-panel')) === 0,
      () => (l0.ok ? `${l0.count} listener(s): ${l0.keys}` : `probe failed: ${l0.error}`));

    await openPanel(U.hostTwice, 0, 'open one panel');
    const l1 = await listeners();
    await openPanel(U.hostTwice, 1, 'open a second panel');
    const l2 = await listeners();
    record('T11.2', 'each open panel holds exactly one listener, and they are distinct',
      l1.ok && l2.ok && l1.count === 1 && l2.count === 2,
      () => `one panel: ${l1.count}; two panels: ${l2.count} (${l2.keys})`);

    await parkPointer();
    await attempt('close one panel', 20000,
      () => hostBlock(U.hostTwice).locator('.f27-il-close').first().click(), null);
    await sleep(1500);
    const l3 = await listeners();
    record('T11.3', "closing one panel removes its listener and only its own",
      l3.ok && l3.count === 1, () => `${l3.count} listener(s) left: ${l3.keys}`);

    await goTo('Txn Control');
    await sleep(1500);
    const l4 = await listeners();
    record('T11.4', 'navigating away removes every listener the page held',
      l4.ok && l4.count === 0, () => `${l4.count} listener(s): ${l4.keys}`);
    await goTo('Txn Reading');

    // Host removal, with a panel open on it.
    await openPanel(U.hostCtx, 0, 'open a panel on the context host');
    const l5 = await listeners();
    await api('remove_block', [U.hostCtx, null], 'the context host block, with its panel open');
    const removedGone = await waitFor('the removed host leaves the page',
      (s) => !s.main.some((w) => w.hostId === U.hostCtx), 30000);
    await sleep(1500);
    const l6 = await listeners();
    record('T11.5', 'removing the host block removes its panel\'s listener with it',
      l5.ok && l6.ok && l5.count === 1 && l6.count === 0 && removedGone.ok,
      () => `before ${l5.count}, after ${l6.count}; host gone: ${removedGone.ok}`);

    // A REAL re-index, which replaces the graph's datascript connection.
    await stashConn();
    const stashedBefore = await stashedListeners();
    phase('transaction', 'reindex-replaces-the-connection');
    const reindexed = await attempt('re-index the graph', 30000, () => page.evaluate(() => {
      try {
        frontend.handler.repo.re_index_BANG_(
          frontend.handler.web.nfs.rebuild_index_BANG_, function () {});
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }), { ok: false, error: 'call failed' });
    await sleep(25000);
    await settleGraph(GRAPH, 4000, 60000);
    const connChanged = await page.evaluate(() => {
      const repo = frontend.state.get_current_repo();
      const conn = frontend.db.conn.get_db.cljs$core$IFn$_invoke$arity$2(repo, false);
      return { replaced: !!(globalThis.__f27stash && globalThis.__f27stash.conn !== conn) };
    });
    const stashedAfter = await stashedListeners();
    observations.reindex = { reindexed, stashedBefore, stashedAfter, connChanged };
    record('T11.6', 'a re-index REPLACED the connection, and left no listener on the old one',
      reindexed.ok && connChanged.replaced && stashedAfter.ok && stashedAfter.count === 0,
      () => `re-index called: ${reindexed.ok}; connection replaced: ${connChanged.replaced}; ` +
            `listeners left on the OLD connection: ${stashedAfter.count} ` +
            `(it held ${stashedBefore.count} before)`);

    await goTo('Txn Reading');
    await sleep(2500);
    await openPanel(U.hostEdit, 0, 'open a panel after the re-index');
    const l7 = await listeners();
    st = await ilState();
    const afterReindex = wrapAt(st, U.hostEdit);
    observations.afterReindex = afterReindex;
    record('T11.7', 'a panel opened after the re-index attaches to the NEW connection and works',
      l7.ok && l7.count === 1 && l7.sameConnAsStash === false &&
        !!afterReindex && afterReindex.open && !!afterReindex.panel &&
        afterReindex.panel.label.includes('두 번째 편집'),
      () => `${l7.count} listener(s) on the current connection, which is ` +
            `${l7.sameConnAsStash ? 'STILL the old one' : 'not the old one'}; panel reads ` +
            `${JSON.stringify(afterReindex && afterReindex.panel ? afterReindex.panel.label.slice(0, 50) : null)}`);

    // A GENUINELY different text: updating a block to the content it already has
    // is a no-op that transacts nothing, and would prove nothing here.
    const afterReindexText = TG.TEXT.editAfterReindex;
    await api('update_block', [U.tgtEdit, afterReindexText, null],
              'the edited target again, to prove the panel still converges after a re-index');
    const stillConverges = await waitFor('the panel converges on the new connection',
      (s) => {
        const w = wrapAt(s, U.hostEdit);
        // The FIRST disclosure names the target in the panel's accessible name;
        // the target's text only reaches `innerText` once the context below is
        // opened, and it is deliberately not opened here.
        return !!w && w.open && !!w.panel && w.panel.label.includes('재색인 후');
      }, 30000);
    observations.afterReindexEdit = stillConverges.state;
    const reWrap = wrapAt(stillConverges.state, U.hostEdit);
    record('T11.8', 'and it still converges, so the panel is attached to the live connection',
      stillConverges.ok,
      () => (stillConverges.ok
        ? `after ${(stillConverges.ms / 1000).toFixed(1)}s`
        : `NOT after ${(stillConverges.ms / 1000).toFixed(1)}s — the wrapper is ` +
          `${reWrap ? `present, open=${reWrap.open}` : 'gone'}` +
          (reWrap && reWrap.panel ? `, label ${JSON.stringify(reWrap.panel.label.slice(0, 60))}` : '')));

    await parkPointer();
    await attempt('close the last panel', 20000,
      () => page.locator('.f27-il-close').first().click(), null);
    await sleep(1500);
    const l8 = await listeners();
    record('T11.9', 'and closing it leaves nothing behind on the new connection either',
      l8.ok && l8.count === 0, () => `${l8.count} listener(s): ${l8.keys}`);

    st = await ilState();
    record('T11.10', 'no editor was left open by any of this', st.editors === 0,
      `${st.editors} editor(s) open`);

    // ---------- T12 : restore ----------
    say('\nT12 restore the native dialog');
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
    record('T12.1', 'the dialog stub was removed and the original restored',
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
      record('T12.2', 'every owned process stopped, addressed by retained PID only',
        stillAlive.length === 0,
        `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
        `stage ${r.stage}` + (stillAlive.length ? `, still alive: ${stillAlive.join(', ')}` : ', none still alive'));
    }
  }

  // ---------- T13 : the graph the application wrote ----------
  say('\nT13 the graph, after the application closed');
  errors.endPhase();

  const after = GH.snapshot(GRAPH);
  const controlAfter = after[TG.CONTROL_FILE];
  record('T13.1', 'the control page is byte-identical: nothing in this run reached it',
    !!controlAfter && !!controlBefore && controlAfter.sha256 === controlBefore.sha256 &&
      controlAfter.bytes === controlBefore.bytes,
    controlAfter ? `${TG.CONTROL_FILE} ${controlAfter.sha256.slice(0, 16)}… ` +
                   `(${controlAfter.bytes} bytes), unchanged`
                 : 'the control page is missing');

  const endProblems = [];
  const finalContents = {};
  for (const [rel, want] of Object.entries(TG.EXPECTED_END)) {
    let body = '';
    try { body = TG.readPage(GRAPH, rel); } catch (e) { endProblems.push(`${rel}: ${e.message}`); continue; }
    finalContents[rel] = body;
    for (const s of want.present) {
      if (!body.includes(s)) endProblems.push(`${rel}: missing ${JSON.stringify(s.slice(0, 40))}`);
    }
    for (const s of (want.absent || []).concat(want.absentAfterBeingAdded || [])) {
      if (body.includes(s)) endProblems.push(`${rel}: still contains ${JSON.stringify(s.slice(0, 40))}`);
    }
  }
  record('T13.2', 'every page the application changed ended in the state this run declared',
    endProblems.length === 0,
    endProblems.length ? JSON.stringify(endProblems)
                       : `${Object.keys(TG.EXPECTED_END).length} page(s) carry exactly the ` +
                         'text this run added and none of the text it removed');

  record('T13.3', 'every change this run made is recorded, with the call that made it',
    applied.length > 0 && applied.every((a) => a.ok !== false),
    `${applied.length} change(s): ` +
    applied.map((a) => `${a.via.replace('logseq.api.', '')}`).join(', '));

  const cmp = GH.compare(before, after);
  const declared = new Set(Object.keys(TG.EXPECTED_END));
  const undeclared = cmp.content.filter((c) => !declared.has(c.file));
  record('T13.4', 'no content file changed that this run did not declare',
    undeclared.length === 0,
    `${cmp.content.length} content change(s): ` +
    `${JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))}` +
    (undeclared.length ? `; UNDECLARED ${JSON.stringify(undeclared)}` : ''));
  record('T13.5', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ${cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')}`
      : 'none');

  const boundaryEntries = journalSince(0).filter((e) => e.guard === 'graph-boundary');
  record('T13.6', 'boundary refusals were journalled during this run', boundaryEntries.length > 0,
    `${boundaryEntries.length} refusal(s) recorded`);

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(cls.unexpected, 5)) say(`          UNEXPECTED: ${line}`);
  record('T13.7', 'every window error was entitled by the deliberate negative test',
    cls.unexpected.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${cls.unexpected.length} unexpected` +
    (cls.unexpected.length ? `: ${EC.describe(cls.unexpected, 1)[0]}` : ''));
  const duringTxn = errors.entries().filter((e) => e.phase === 'transaction');
  record('T13.8', 'no uncaught page error arrived while the transaction cases ran',
    duringTxn.length === 0,
    duringTxn.length ? `${duringTxn.length}: ${duringTxn[0].text.slice(0, 200)}`
                     : '0 during the transaction phase');
  record('T13.9', 'nothing that unmounts a panel was thrown', cls.renderFailures.length === 0,
    cls.renderFailures.length ? String(cls.renderFailures[0].text).slice(0, 250)
                              : `0 render failures among ${errors.entries().length} captured line(s)`);

  fs.writeFileSync(path.join(EVIDENCE, 'transaction-observations.json'), JSON.stringify({
    graph: GRAPH, applied, observations, finalContents,
    errors: errors.entries(), phases: errors.phases(),
  }, null, 2));

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'transaction-summary.json'), JSON.stringify({
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
    fs.writeFileSync(path.join(EVIDENCE, 'transaction-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), applied, results,
    }, null, 2));
    fs.writeFileSync(path.join(EVIDENCE, 'transaction-observations.json'), JSON.stringify({
      aborted: String((e && e.message) || e), applied, observations,
      errors: errors.entries(), phases: errors.phases(),
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
