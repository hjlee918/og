#!/usr/bin/env node
'use strict';
//
// The F27 INLINE-CONTEXT feature against a REAL graph, loaded into the packaged
// feature build the ordinary way.
//
//   node f27-inline/checks/inline-loaded-graph-checks.js
//
// The new interaction is section I. Sections O5 and O6 are the outgoing slice's
// own scenario, kept verbatim as regression coverage for the F27 behaviour this
// batch must not break.
//
// Same method as the accepted pilot's loaded-graph run, and for the same
// reasons: the native folder dialog cannot be driven headlessly, and adding a
// production IPC that loads a graph by path would be a new, unrestricted entry
// point. So the harness stubs ONLY `dialog.showOpenDialog` in the main process,
// returning a path it has already validated, and then uses OG's ordinary flow.
// The stub is removed afterwards and its removal is verified. Before the good
// path is used, the same stub is pointed at an inert OUTSIDE path to prove the
// application refuses a bad dialog result — the guard is in the app, not here.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this batch's synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, and the installed application is never
// launched. The loaded graph path is asserted BEFORE any feature interaction,
// and the graph's content hashes are compared after the application has closed.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const ID = require(path.join(REPO, 'f27-inline', 'src', 'feature-identity.js'));
const PILOT_ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const batchGraph = require('./inline-batch-graph.js');
const graphGen = require('./make-inline-graph.js');
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
// Counted here rather than inside the session, because it is reported after it.
let repairs = 0;
// Every window error is recorded WITH the phase and operation it arrived in.
// The outgoing acceptance record required this: a substring exemption for
// filesystem errors was too broad to prove anything about the rest of the run.
// See f27-inline/checks/error-classifier.js and its deterministic tests.
const errors = EC.createRecorder();
const pageErrors = [];   // the raw strings, for the evidence file only
function phase(name, operation) {
  const p = errors.phase(name, operation);
  say(`  ┈ phase: ${name}${operation ? ` (${operation})` : ''}`);
  return p;
}
const sleep = OP.sleep;
function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  results.push({ id, title, ok: !!ok, detail: String(detail) });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${title}\n          ${detail}`);
  return ok;
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
function journalSince(n) {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean)
    .slice(n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const journalLines = () => (fs.existsSync(JOURNAL)
  ? fs.readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).length : 0);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 inline context: real graph loaded through the ordinary workflow ===\n');

  // ---------- O0 : preconditions ----------
  say('O0  preconditions');
  if (!fs.existsSync(EXE)) throw new Error(`packaged feature app not found at ${EXE}`);
  // Verified with the identity that actually ships inside the package, which is
  // the feature identity — not the pilot's.
  const preflight = require(path.join(RES_APP, 'pilot-preflight.js'));
  const v = preflight.verify(RES_APP);
  record('O0.1', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}` : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');

  record('O0.2', 'this is the FEATURE build and is not labelled as the accepted pilot',
    v.manifest.schema === ID.SCHEMA &&
      v.manifest.productName === ID.PRODUCT_NAME &&
      v.manifest.bundleId === ID.BUNDLE_ID &&
      v.manifest.productName !== PILOT_ID.PRODUCT_NAME &&
      v.manifest.bundleId !== PILOT_ID.BUNDLE_ID,
    `${v.manifest.schema} / ${v.manifest.productName} / ${v.manifest.bundleId} ` +
    `(pilot is ${PILOT_ID.PRODUCT_NAME} / ${PILOT_ID.BUNDLE_ID})`);

  record('O0.3', 'the renderer is declared as rebuilt here, not as the accepted artifact',
    !!(v.manifest.rendererBuild && v.manifest.rendererBuild.rebuiltHere === true) &&
      v.manifest.builtFrom.branch === 'feature/f27-inline-context',
    `renderer revision ${v.manifest.builtFrom.rendererRevision}, ` +
    `${v.manifest.rendererAssetCount} artifacts, branch ${v.manifest.builtFrom.branch}`);

  record('O0.4', 'the main-process guards are compiled in',
    v.manifest.closureDefines['electron.pilot/PILOT'] === true &&
      !!v.manifest.artifacts['pilot-boundary.js'],
    `PILOT=${v.manifest.closureDefines['electron.pilot/PILOT']}, boundary sha256 ` +
    `${(v.manifest.artifacts['pilot-boundary.js'] || {}).sha256 || '(absent)'}`);

  // ---------- O1 : the graph ----------
  say('\nO1  synthetic graph, inside the permitted root only');
  const batch = batchGraph.ensure(path.join(EVIDENCE, 'current-batch-graph.json'));
  const GRAPH = B.assertInsideAllowedRoot('synthetic graph', batch.graph);
  record('O1.1', 'one synthetic graph for this batch, inside the permitted root only', true,
    `${batch.reused ? 'reused after per-file containment and content checks' : 'created'}: ${GRAPH}` +
    (batch.problems.length ? ` (previous one left in place: ${batch.problems.join('; ')})` : ''));
  const before = GH.snapshot(GRAPH);
  record('O1.2', 'graph content hashed before the session', true,
    `${Object.keys(before).length} files`);

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-inline-inert-outside-probe');
  record('O1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- O2 : launch, then a BAD dialog result ----------
  say('\nO2  launch, then a BAD dialog result');
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));

  // One bounded retry. A launch immediately after the bundle was repackaged can
  // find the target already gone, and losing a whole session to that is not
  // worth it. Nothing is matched by name and no process is signalled here — the
  // launcher owns only its own child, which the incident record requires.
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

    // The window's own errors. A React render that throws unmounts the subtree
    // it was rendering, which from outside looks exactly like "the panel
    // disappeared" — and without this the harness can only report the symptom.
    page.on('pageerror', (e) => {
      const text = String((e && e.stack) || (e && e.message) || e).slice(0, 600);
      pageErrors.push(text);
      errors.record('pageerror', text);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const text = 'console: ' + m.text().slice(0, 600);
        pageErrors.push(text);
        errors.record('console', text);
      }
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
    record('O2.1', 'native folder dialog stubbed in the main process, original retained',
      installed === true, `returning ${BAD}`);

    const markBad = journalLines();
    const chooseFolder = async (label) => {
      await page.evaluate(() => { location.hash = '#/repo/add'; });
      await sleep(2500);
      return attempt(label, 30000, () => page.locator('.choose').first().click(), null);
    };
    // The ONE phase in which a refusal is deliberate, and the one operation in
    // it that is allowed to produce one. It is closed again before anything
    // else happens, so nothing later can borrow its entitlement.
    phase(EC.NEGATIVE_PHASE, EC.NEGATIVE_OPERATION);
    await chooseFolder('choose folder (bad)');
    await sleep(7000);
    errors.endPhase();

    const badRefusals = journalSince(markBad)
      .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
    record('O2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 150)
                         : 'no boundary refusal was journalled for the bad dialog result');
    record('O2.3', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- O3 : the good path, ordinary workflow ----------
    say('\nO3  open the synthetic graph through the ordinary workflow');
    phase('open-graph', 'choose-folder-permitted-root');
    await app.evaluate((_e, p) => { global.__pilotDialogPath = p; }, GRAPH);
    await chooseFolder('choose folder (good)');
    await sleep(22000);

    const graphs = await attempt('getGraphs', 20000,
      () => page.evaluate(async () => window.apis.doAction(['getGraphs'])), null);
    const graphsOk = Array.isArray(graphs);
    const registered = graphsOk ? graphs.map((g) => String(g).replace(/^logseq_local_/, '')) : [];
    const outside = registered.filter((g) => !B.isInsideAllowedRoot(g));
    record('O3.1', "this run's graph is registered, and every entry is inside the permitted root",
      graphsOk && registered.includes(GRAPH) && outside.length === 0,
      `${registered.length} registered, ${outside.length} outside the permitted root; ` +
      `this run present: ${registered.includes(GRAPH)}`);

    // ---------- O4 : assert the ACTUAL loaded path before any feature use ----
    say('\nO4  assert the actual loaded graph path');
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
    record('O4.1', 'the loaded graph is this batch\'s synthetic one, asserted before any feature use',
      loadedPathOk, loadedPathOk ? GRAPH : `no reference to the synthetic path in ${loadedStr.slice(0, 300)}`);

    const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                       /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
    record('O4.2', 'no graph outside the permitted root is referenced by the app state',
      !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');

    if (!loadedPathOk) throw new Error('the synthetic graph did not load; not proceeding to features');

    // ---------- feature interaction ----------
    // Section I is this slice. Sections O5 and O6 are the outgoing slice's own
    // scenario, kept as regression coverage and run in the same session.
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

    // Where the page is, and whether the overview is still on it. A click that
    // lands on a block reference instead of a control NAVIGATES, and the whole
    // overview then ceases to exist — which reads as "the row disappeared".
    const pageState = () => page.evaluate(() => ({
      hash: location.hash,
      overviews: document.querySelectorAll('.f27-ref-overview').length,
      rows: document.querySelectorAll('.f27-ref-row').length,
    })).catch((e) => ({ error: String(e.message) }));

    // OG renders its own hover preview (tippy) over a block reference, and it
    // floats above this panel's controls. A recorded failure from slice 5: the
    // preview swallowed a click. The pointer is therefore parked away from the
    // text before every interaction, exactly as a reader's would not be resting
    // on it.
    const parkPointer = () => page.mouse.move(5, 5).catch(() => null);

    // OG writes into a graph the first time it opens one — this run's own
    // evidence: a brand-new graph gained `logseq/custom.css`. Each such write
    // reaches the file watcher, which re-renders, which resets the reference
    // overview's COMPONENT-LOCAL open state and closes it underneath whatever
    // the harness was doing. The previous batch never saw it because it reused
    // a graph that had already been through first-open housekeeping.
    //
    // So the graph is allowed to go quiet before any feature is touched. The
    // directory is the run's own, already proved contained; nothing is written
    // and nothing outside it is read.
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
        else if (Date.now() - lastChange >= quietMs) {
          return { quiet: true, ms: Date.now() - started };
        }
      }
    };

    const openOverview = async () => {
      await goTo('Outgoing Target');
      if ((await count('.f27-ref-overview')) === 0) {
        await parkPointer();
        await attempt('open ref badge', 20000,
          () => page.locator('a.open-block-ref-link').first().click(), null);
        await sleep(3500);
      }
    };

    // Repairs, and SAYS it had to. A silent repair would hide exactly the
    // instability that made this run necessary.
    const ensureOverview = async (why) => {
      const st = await pageState();
      if (st.overviews > 0) return false;
      repairs += 1;
      say(`          (re-opening the overview before ${why}; page was ${JSON.stringify(st)})`);
      await openOverview();
      return true;
    };

    const rowLocator = (text) => page.locator('.f27-ref-row').filter({ hasText: text }).first();

    const expandAllContexts = async () => {
      const toggles = await count('.f27-ctx-toggle');
      for (let i = 0; i < toggles; i++) {
        const row = page.locator('.f27-ref-row').nth(i);
        if ((await row.locator('.f27-out').count().catch(() => 0)) > 0) continue;
        await parkPointer();
        await attempt(`expand row ${i}`, 25000,
          () => row.locator('.f27-ctx-toggle').first().click({ timeout: 20000 }), null);
        await sleep(400);
      }
      await sleep(2000);
      return toggles;
    };

    // The overview is open, this row exists, and its context is expanded.
    const ensureRow = async (text) => {
      await ensureOverview(`"${text}"`);
      let row = rowLocator(text);
      if ((await row.locator('.f27-out').count().catch(() => 0)) === 0) {
        await parkPointer();
        await attempt(`expand context for "${text}"`, 25000,
          () => row.locator('.f27-ctx-toggle').first().click({ timeout: 20000 }), null);
        await sleep(1200);
        row = rowLocator(text);
      }
      return row;
    };


    const settled = await settleGraph(GRAPH, 5000, 90000);
    record('O5.20', 'the graph went quiet before any feature was touched',
      settled.quiet,
      settled.quiet
        ? `no file changed for 5s after ${(settled.ms / 1000).toFixed(1)}s`
        : `still changing after ${(settled.ms / 1000).toFixed(1)}s; OG's first-open ` +
          'housekeeping re-renders and resets the overview, so results below may be unstable');

    // ---------- I : the inline reference context (this slice) ----------
    say('\nI   the inline reference context');
    phase('inline-context', 'open-the-inline-panel');

    // One block's own content, addressed by words a reader can see. A parent's
    // `.block-content` does not contain its children's text — children live in
    // a sibling container — so this is one sentence, not a subtree.
    const sentence = (text) =>
      page.locator('#main-content-container .block-content').filter({ hasText: text }).first();

    // Everything on screen about this feature, read in one pass.
    const inlineState = () => page.evaluate(() => {
      const read = (root) => [...root.querySelectorAll('.f27-il')].map((w) => {
        const btn = w.querySelector(':scope > .f27-il-toggle');
        const panel = w.querySelector(':scope > .f27-il-panel');
        const host = w.closest('.block-content');
        return {
          host: host ? (host.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 46) : '',
          ref: ((w.querySelector('.block-ref-wrap') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          warning: !!w.querySelector('.warning'),
          hasControl: !!btn,
          expanded: btn ? btn.getAttribute('aria-expanded') : null,
          controls: btn ? btn.getAttribute('aria-controls') : null,
          glyph: btn ? (btn.innerText || '').trim() : null,
          controlInsideRef: !!w.querySelector('.block-ref-wrap .f27-il-toggle'),
          controlInsideLink: !!w.querySelector('a .f27-il-toggle'),
          open: !!panel,
          panel: panel ? {
            id: panel.id,
            label: panel.getAttribute('aria-label') || '',
            role: panel.getAttribute('role'),
            direction: ((panel.querySelector('.f27-il-direction') || {}).innerText || '').trim(),
            crumb: ((panel.querySelector('.f27-il-crumb') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
            unavailable: !!panel.querySelector('.f27-il-unavailable'),
            canOpenTarget: !!panel.querySelector('.f27-il-source'),
            canExpand: !!panel.querySelector('.f27-il-ctx-toggle'),
            ctxOpen: !!panel.querySelector('.f27-ctx'),
            ctxLines: [...panel.querySelectorAll('.f27-ctx-line')]
              .map((l) => (l.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)),
            ctxPage: ((panel.querySelector('.f27-ctx-page') || {}).innerText || '').trim(),
            outSection: !!panel.querySelector('.f27-out'),
            outToggle: ((panel.querySelector('.f27-out-toggle') || {}).innerText || '').trim(),
            outRows: [...panel.querySelectorAll('.f27-out-row .f27-out-label')]
              .map((x) => (x.innerText || '').trim().slice(0, 40)),
            inSection: !!panel.querySelector('.f27-in'),
            inRows: [...panel.querySelectorAll('.f27-in-crumb')]
              .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 46)),
            descSection: !!panel.querySelector('.f27-desc'),
            descLines: [...panel.querySelectorAll('.f27-desc-line')]
              .map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)),
            nestedControls: panel.querySelectorAll('.f27-il-toggle').length,
            closeControls: panel.querySelectorAll('.f27-il-close').length,
            buttons: panel.querySelectorAll('button').length,
            editors: panel.querySelectorAll('textarea').length,
            embeds: panel.querySelectorAll('.block-embed, .page-embed, .custom-query, iframe').length,
            text: (panel.innerText || ''),
          } : null,
        };
      });
      const main = document.querySelector('#main-content-container') || document.body;
      return {
        main: read(main),
        // Excluded surfaces, counted where they live.
        inSidebar: document.querySelectorAll('.sidebar-item .f27-il-toggle').length,
        sidebarItems: document.querySelectorAll('.sidebar-item').length,
        sidebarRefs: document.querySelectorAll('.sidebar-item .block-ref-wrap').length,
        inEmbed: document.querySelectorAll('.embed-block .f27-il-toggle').length,
        embedRefs: document.querySelectorAll('.embed-block .block-ref-wrap').length,
        inF27Panel: document.querySelectorAll('.f27-ctx .f27-il-toggle, .f27-ref-overview .f27-il-toggle').length,
        insideAnchor: document.querySelectorAll('a .f27-il-toggle').length,
        insideRefWrap: document.querySelectorAll('.block-ref-wrap .f27-il-toggle').length,
        tippies: document.querySelectorAll('.tippy-wrapper').length,
        editorsOpen: document.querySelectorAll('textarea.editor-input').length,
        hash: location.hash,
      };
    }).catch((e) => ({ error: String(e.message), main: [] }));

    const inlineEvidence = {};
    const goInline = async () => { await goTo('Inline Reading'); await sleep(1200); };
    await goInline();

    let il = await inlineState();
    inlineEvidence.initial = il;
    const withControl = il.main.filter((r) => r.hasControl);
    record('I1.1', 'every ordinary inline reference in the reading content carries the control',
      withControl.length === 6 && il.main.length === 6,
      `${il.main.length} wrapped reference(s), ${withControl.length} with a control; ` +
      `hosts ${JSON.stringify(il.main.map((r) => r.host))}`);

    record('I1.2', 'the control is a SIBLING of the reference, never inside it and never inside a link',
      il.insideRefWrap === 0 && il.insideAnchor === 0 &&
        il.main.every((r) => !r.controlInsideRef && !r.controlInsideLink),
      `inside .block-ref-wrap: ${il.insideRefWrap}, inside an <a>: ${il.insideAnchor}`);

    record('I1.3', 'an EMBED surface renders its reference with no control at all',
      il.embedRefs > 0 && il.inEmbed === 0,
      `${il.embedRefs} reference(s) inside the embedded block, ${il.inEmbed} control(s)`);

    // ---- opening, from the keyboard ---------------------------------------
    const twoTargets = sentence('두 대상');
    const firstToggle = twoTargets.locator('.f27-il-toggle').nth(0);
    const secondToggle = twoTargets.locator('.f27-il-toggle').nth(1);

    await parkPointer();
    await attempt('focus the first control', 15000, () => firstToggle.focus(), null);
    const focusedClass = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Enter', 15000, () => page.keyboard.press('Enter'), null);
    await sleep(1800);
    il = await inlineState();
    inlineEvidence.openedByKeyboard = il;
    const opened = il.main.filter((r) => r.open);
    record('I2.1', 'the control opens the panel from the KEYBOARD, and says it is expanded',
      /f27-il-toggle/.test(focusedClass) && opened.length === 1 &&
        opened[0].expanded === 'true' && !!opened[0].panel &&
        opened[0].panel.role === 'group',
      `focused ${JSON.stringify(focusedClass)}; ${opened.length} panel(s) open; ` +
      `aria-expanded ${opened.length ? opened[0].expanded : null}`);

    record('I2.2', 'nothing navigated: the reader is still on the page they were reading',
      /Inline%20Reading|Inline Reading/i.test(il.hash) && il.editorsOpen === 0,
      `hash ${JSON.stringify(il.hash)}, editors open ${il.editorsOpen}`);

    const p1 = opened.length ? opened[0].panel : null;
    record('I2.3', "the first disclosure names the TARGET's source page and its parent, not the page being read",
      !!p1 && /Inline Target Source/.test(p1.crumb) && /A PARENT block/.test(p1.crumb) &&
        !/Inline Reading/.test(p1.crumb),
      p1 ? `breadcrumb ${JSON.stringify(p1.crumb)}` : 'no panel');

    record('I2.4', "the panel states whose context this is, and carries no raw identifier",
      !!p1 && /TARGET/i.test(p1.direction) && /not the context of the block you are reading/i.test(p1.direction) &&
        !UUID_RE.test(p1.text),
      p1 ? `${JSON.stringify(p1.direction.slice(0, 90))}; raw uuid on screen: ${UUID_RE.test(p1.text)}` : 'n/a');

    record('I2.5', 'the panel is read-only: no editor, no OG embed, no iframe, and every control is a button',
      !!p1 && p1.editors === 0 && p1.embeds === 0 && p1.buttons > 0 && p1.closeControls === 2,
      p1 ? `editors ${p1.editors}, embeds/iframes ${p1.embeds}, buttons ${p1.buttons}, ` +
           `close controls ${p1.closeControls} (above and at the end)` : 'n/a');

    record('I2.6', 'no control is injected inside the panel — F27 previews do not sprout more of them',
      !!p1 && p1.nestedControls === 0 && il.inF27Panel === 0,
      p1 ? `${p1.nestedControls} inside this panel, ${il.inF27Panel} inside any F27 panel` : 'n/a');

    // ---- two DIFFERENT targets in one sentence -----------------------------
    record('I3.1', 'the OTHER reference in the same sentence stayed closed',
      il.main.filter((r) => r.open).length === 1,
      `${il.main.filter((r) => r.open).length} of ${il.main.length} open`);

    await parkPointer();
    await attempt('open the second target', 20000, () => secondToggle.click(), null);
    await sleep(1800);
    il = await inlineState();
    inlineEvidence.bothOpen = il;
    const bothOpen = il.main.filter((r) => r.open);
    const labels = bothOpen.map((r) => r.panel.label);
    record('I3.2', 'two references to DIFFERENT targets open independently, each naming its own target',
      bothOpen.length === 2 && labels[0] !== labels[1] &&
        labels.some((l) => /인라인 대상 블록/.test(l)) &&
        labels.some((l) => /other inline target/i.test(l)),
      `labels ${JSON.stringify(labels)}`);

    record('I3.3', 'their panels have distinct identities, so aria-controls points at the right one',
      bothOpen.length === 2 && bothOpen[0].panel.id !== bothOpen[1].panel.id &&
        bothOpen.every((r) => r.controls === r.panel.id),
      `panel ids ${JSON.stringify(bothOpen.map((r) => r.panel.id))}, ` +
      `aria-controls ${JSON.stringify(bothOpen.map((r) => r.controls))}`);

    // Close them both, from the panel's own control, before the next case.
    for (let i = 0; i < 2; i++) {
      await parkPointer();
      await attempt(`close panel ${i}`, 20000,
        () => twoTargets.locator('.f27-il-close').first().click(), null);
      await sleep(900);
    }
    il = await inlineState();
    record('I3.4', 'Close closes exactly the panel it belongs to, and leaves the sentence as it was',
      il.main.filter((r) => r.open).length === 0 && il.main.length === 6,
      `${il.main.filter((r) => r.open).length} still open, ${il.main.length} references still wrapped`);

    // ---- the SAME target written twice -------------------------------------
    const twice = sentence('The same target twice');
    await parkPointer();
    await attempt('open the first occurrence', 20000,
      () => twice.locator('.f27-il-toggle').nth(0).click(), null);
    await sleep(1600);
    const afterFirst = await twice.evaluate((el) => [...el.querySelectorAll('.f27-il')]
      .map((w) => !!w.querySelector(':scope > .f27-il-panel')));
    await parkPointer();
    await attempt('open the second occurrence', 20000,
      () => twice.locator('.f27-il-toggle').nth(1).click(), null);
    await sleep(1600);
    const afterSecond = await twice.evaluate((el) => [...el.querySelectorAll('.f27-il')]
      .map((w) => !!w.querySelector(':scope > .f27-il-panel')));
    await parkPointer();
    await attempt('close the first occurrence', 20000,
      () => twice.locator('.f27-il').nth(0).locator('.f27-il-close').first().click(), null);
    await sleep(1600);
    const afterClose = await twice.evaluate((el) => [...el.querySelectorAll('.f27-il')]
      .map((w) => !!w.querySelector(':scope > .f27-il-panel')));
    inlineEvidence.repeatedTarget = { afterFirst, afterSecond, afterClose };
    record('I4.1', 'two occurrences of the SAME target do not share state',
      JSON.stringify(afterFirst) === JSON.stringify([true, false]) &&
        JSON.stringify(afterSecond) === JSON.stringify([true, true]) &&
        JSON.stringify(afterClose) === JSON.stringify([false, true]),
      `after opening the first ${JSON.stringify(afterFirst)}, ` +
      `after the second ${JSON.stringify(afterSecond)}, ` +
      `after closing the first ${JSON.stringify(afterClose)}`);

    // ---- Escape returns focus to the control it came from -------------------
    const secondWrap = twice.locator('.f27-il').nth(1);
    await attempt('focus a control inside the panel', 15000,
      () => secondWrap.locator('.f27-il-ctx-toggle').first().focus(), null);
    const insideFocus = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Escape', 15000, () => page.keyboard.press('Escape'), null);
    await sleep(1200);
    const afterEscape = await page.evaluate(() => ({
      active: (document.activeElement && document.activeElement.className) || '',
      activeId: (document.activeElement && document.activeElement.id) || '',
      expanded: document.activeElement ? document.activeElement.getAttribute('aria-expanded') : null,
      panels: document.querySelectorAll('.f27-il-panel').length,
    }));
    inlineEvidence.escape = { insideFocus, afterEscape };
    record('I4.2', 'Escape from inside the panel closes it and returns focus to its own control',
      /f27-il-ctx-toggle/.test(insideFocus) &&
        /f27-il-toggle/.test(afterEscape.active) &&
        afterEscape.expanded === 'false' && afterEscape.panels === 0,
      `focus was ${JSON.stringify(insideFocus)}, is now ${JSON.stringify(afterEscape.active)} ` +
      `(${afterEscape.activeId}); ${afterEscape.panels} panel(s) left`);

    // ---- the second disclosure: the existing engine, for the TARGET --------
    await parkPointer();
    await attempt('reopen the first target', 20000, () => firstToggle.click(), null);
    await sleep(1600);
    await parkPointer();
    await attempt('show the full context', 25000,
      () => twoTargets.locator('.f27-il-ctx-toggle').first().click(), null);
    await sleep(3000);
    il = await inlineState();
    inlineEvidence.contextOpen = il;
    const withCtx = il.main.find((r) => r.open && r.panel.ctxOpen);
    record('I5.1', 'the second disclosure opens the EXISTING context engine, with all four sections',
      !!withCtx && withCtx.panel.ctxLines.length >= 2 && withCtx.panel.descSection &&
        withCtx.panel.outSection && withCtx.panel.inSection,
      withCtx ? `${withCtx.panel.ctxLines.length} context line(s), descendants ` +
                `${withCtx.panel.descSection}, links-in-block ${withCtx.panel.outSection}, ` +
                `inbound ${withCtx.panel.inSection}` : 'no context opened');

    record('I5.2', "the ancestors and the source page are the TARGET's",
      !!withCtx && /Inline Target Source/.test(withCtx.panel.ctxPage) &&
        withCtx.panel.ctxLines.some((l) => /A PARENT block/.test(l)) &&
        withCtx.panel.ctxLines.some((l) => /인라인 대상 블록/.test(l)),
      withCtx ? `page ${JSON.stringify(withCtx.panel.ctxPage)}; lines ` +
                `${JSON.stringify(withCtx.panel.ctxLines)}` : 'n/a');

    record('I5.3', 'Korean and emoji in the target survive into the panel',
      !!withCtx && /한국어|인라인/.test(withCtx.panel.text) && /🎯/.test(withCtx.panel.text),
      withCtx ? 'the target block mixes Korean, English and emoji' : 'n/a');

    // *Links in this block* here must be the TARGET's own links, not the
    // host's. The host sentence links to the inline target and the other one;
    // the TARGET links to target-one. They cannot be confused.
    const ctxWrap = twoTargets.locator('.f27-il').nth(0);
    await parkPointer();
    await attempt('open links in this block', 25000,
      () => ctxWrap.locator('.f27-out-toggle').first().click(), null);
    await sleep(2000);
    il = await inlineState();
    const outOpen = il.main.find((r) => r.open && r.panel.outRows.length > 0);
    inlineEvidence.outgoingInPanel = outOpen ? outOpen.panel.outRows : [];
    record('I5.4', "the links section lists the TARGET's own links, not the host sentence's",
      !!outOpen && outOpen.panel.outRows.length === 1 &&
        /target-one/.test(outOpen.panel.outRows[0]) &&
        !outOpen.panel.outRows.some((r) => /other inline target|인라인 대상/.test(r)),
      outOpen ? `rows ${JSON.stringify(outOpen.panel.outRows)}` : 'no links section opened');

    // Inbound here must be references TO THE TARGET, which are the two
    // sentences in Inline Reading — not the host block's own incoming
    // references, of which it has none.
    await parkPointer();
    await attempt('open references to this block', 25000,
      () => ctxWrap.locator('.f27-in-toggle').first().click(), null);
    await sleep(3000);
    il = await inlineState();
    const inOpen = il.main.find((r) => r.open && r.panel.inRows.length > 0);
    inlineEvidence.inboundInPanel = inOpen ? inOpen.panel.inRows : [];
    // The HOST block has no incoming reference of its own, so a section showing
    // the host's inbound would be empty. Two rows, both the reading page's own
    // sentences, is what the TARGET's inbound looks like.
    record('I5.5', 'the inbound section is what refers to the TARGET, not to the block being read',
      !!inOpen && inOpen.panel.inRows.filter((r) => /Inline Reading/.test(r)).length === 2,
      inOpen ? `rows ${JSON.stringify(inOpen.panel.inRows)}` : 'no inbound section opened');

    // Descendants of the target.
    await parkPointer();
    await attempt('show the children', 25000,
      () => ctxWrap.locator('.f27-desc-toggle-all').first().click(), null);
    await sleep(2500);
    il = await inlineState();
    const descOpen = il.main.find((r) => r.open && r.panel.descLines.length > 0);
    inlineEvidence.descendantsInPanel = descOpen ? descOpen.panel.descLines : [];
    record('I5.6', "the descendants are the TARGET's child, revealed on request",
      !!descOpen && descOpen.panel.descLines.some((l) => /A CHILD of the inline target/.test(l)),
      descOpen ? `lines ${JSON.stringify(descOpen.panel.descLines)}` : 'no descendants opened');

    record('I5.7', 'still no control inside any F27 panel, with everything expanded',
      il.inF27Panel === 0 && il.main.every((r) => !r.panel || r.panel.nestedControls === 0),
      `${il.inF27Panel} control(s) inside an F27 panel`);

    // Where OG's own substitution ceiling is reached, and where it is not.
    //
    // This run's first packaged session found the warning on the page and the
    // check that looked at the whole body could not say whose it was. It is
    // OG's: an inline reference to one side of a MUTUAL PAIR is substituted by
    // OG's ordinary renderer until `max-depth-of-links` (5), exactly as it
    // always has been — this batch's fixture is simply the first to write that
    // shape into ordinary reading content.
    //
    // Proved rather than asserted: the same pair is ALSO written inside the
    // embedded block, which is an excluded surface carrying no control at all.
    // If the warning appears there too, this slice cannot be its cause.
    const depth = await page.evaluate(() => {
      const NEEDLE = 'Block ref nesting is too deep';
      const all = [...document.querySelectorAll('.warning')]
        .filter((w) => (w.innerText || '').includes(NEEDLE));
      const within = (sel) => all.filter((w) => w.closest(sel)).length;
      return {
        total: all.length,
        inF27: within('.f27-il-panel, .f27-ctx, .f27-ref-overview'),
        inEmbedSurface: within('.embed-block'),
        inOgSubstitution: within('.block-ref-wrap'),
      };
    });
    inlineEvidence.depth = depth;
    record('I5.8', "no runaway reference substitution inside any F27 surface",
      depth.inF27 === 0,
      `${depth.inF27} inside an F27 panel, overview or context, of ${depth.total} on the page`);

    record('I5.9', "OG's own substitution ceiling behaves as it always did, on a surface " +
                   'this slice adds nothing to as well as on one it does',
      depth.total === 0 ||
        (depth.inEmbedSurface > 0 && depth.inOgSubstitution === depth.total),
      `${depth.total} ceiling notice(s): ${depth.inEmbedSurface} inside the EMBED ` +
      "surface, which carries no control at all, and all of them inside OG's own " +
      `substitution (${depth.inOgSubstitution}/${depth.total}). A mutual pair written ` +
      'in running text is substituted to max-depth-of-links by OG and always was; ' +
      'this slice changes neither the depth nor its accounting.');

    // ---- a target nobody wrote ---------------------------------------------
    const ghostSentence = sentence('nobody wrote');
    await parkPointer();
    await attempt('open the missing target', 20000,
      () => ghostSentence.locator('.f27-il-toggle').first().click(), null);
    await sleep(1600);
    il = await inlineState();
    const ghost = il.main.find((r) => r.open && r.panel.unavailable);
    inlineEvidence.missingTarget = ghost ? ghost.panel : null;
    record('I6.1', 'a reference to a block nobody wrote says so, and offers no control that cannot work',
      !!ghost && ghost.panel.unavailable && !ghost.panel.canExpand &&
        !ghost.panel.canOpenTarget && /could not be read/i.test(ghost.panel.text) &&
        !UUID_RE.test(ghost.panel.text),
      ghost ? `unavailable=${ghost.panel.unavailable}, context control=${ghost.panel.canExpand}, ` +
              `open-target control=${ghost.panel.canOpenTarget}, ` +
              `raw uuid in the panel: ${UUID_RE.test(ghost.panel.text)}`
            : 'the missing-target panel did not open');
    await parkPointer();
    await attempt('close the missing target', 20000,
      () => ghostSentence.locator('.f27-il-close').first().click(), null);
    await sleep(900);

    // ---- a cycle, inside the panel -----------------------------------------
    const cycleSentence = sentence('mutual pair');
    await parkPointer();
    await attempt('open the cycle side', 20000,
      () => cycleSentence.locator('.f27-il-toggle').first().click(), null);
    await sleep(1600);
    await parkPointer();
    await attempt('show the cycle context', 25000,
      () => cycleSentence.locator('.f27-il-ctx-toggle').first().click(), null);
    await sleep(3000);
    const cycleBody = await cycleSentence.evaluate((el) => {
      const p = el.querySelector('.f27-il-panel');
      if (!p) return null;
      return {
        chips: [...p.querySelectorAll('.f27-body-ref')].map((c) => ({
          kind: c.className, mark: ((c.querySelector('.f27-body-ref-mark') || {}).innerText || '').trim(),
        })),
        depth: (p.innerText || '').includes('Block ref nesting is too deep'),
        uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.innerText || ''),
      };
    });
    inlineEvidence.cycle = cycleBody;
    record('I6.2', 'a reference inside the panel is previewed once and never followed recursively',
      !!cycleBody && cycleBody.chips.length > 0 && !cycleBody.depth && !cycleBody.uuid,
      cycleBody ? `${cycleBody.chips.length} bounded chip(s) ${JSON.stringify(cycleBody.chips)}; ` +
                  `depth warning ${cycleBody.depth}; raw uuid ${cycleBody.uuid}` : 'no panel');
    await parkPointer();
    await attempt('close the cycle panel', 20000,
      () => cycleSentence.locator('.f27-il-close').first().click(), null);
    await sleep(900);

    // ---- OG's own behaviour, preserved --------------------------------------
    phase('inline-context', 'ogs-own-reference-behaviour');

    // Hover. The state the measurement is made in is ASSERTED rather than
    // assumed: this run's first session measured "closed" while a panel from an
    // earlier check was still open and reported the result exactly inverted.
    const refOf = (s) => s.locator('.block-ref-wrap').first();
    const closeEveryPanel = async (why) => {
      for (let i = 0; i < 8; i++) {
        const open = await count('.f27-il-panel');
        if (open === 0) return 0;
        await parkPointer();
        await attempt(`close a panel before ${why}`, 20000,
          () => page.locator('.f27-il-close').first().click(), null);
        await sleep(700);
      }
      return count('.f27-il-panel');
    };

    const panelsBeforeClosedHover = await closeEveryPanel('the closed hover');
    await parkPointer();
    await attempt('hover the reference (closed)', 20000,
      () => refOf(twoTargets).hover(), null);
    await sleep(3500);
    const hoverClosed = await count('.tippy-wrapper');
    await parkPointer();
    await sleep(1500);

    // … and is suppressed while it is OPEN, so it cannot cover the panel.
    await attempt('open the first target', 20000, () => firstToggle.click(), null);
    await sleep(1600);
    const panelsBeforeOpenHover = await count('.f27-il-panel');
    await attempt('hover the reference (open)', 20000,
      () => refOf(twoTargets).hover(), null);
    await sleep(3500);
    const hoverOpen = await count('.tippy-wrapper');
    await parkPointer();
    await sleep(1000);
    inlineEvidence.hover = {
      hoverClosed, hoverOpen, panelsBeforeClosedHover, panelsBeforeOpenHover,
    };
    record('I7.1', "OG's hover preview still appears, and is suppressed only while the panel is open",
      panelsBeforeClosedHover === 0 && panelsBeforeOpenHover === 1 &&
        hoverClosed > 0 && hoverOpen === 0,
      `${hoverClosed} preview(s) with ${panelsBeforeClosedHover} panel(s) open, ` +
      `${hoverOpen} with ${panelsBeforeOpenHover}`);

    // Close it again so the click checks below are on an ordinary reference,
    // and the preview is restored.
    const leftOpen = await closeEveryPanel('the click checks');
    await parkPointer();
    await attempt('hover the reference (restored)', 20000,
      () => refOf(twoTargets).hover(), null);
    await sleep(3500);
    const hoverRestored = await count('.tippy-wrapper');
    await parkPointer();
    await sleep(1200);
    inlineEvidence.hover.hoverRestored = hoverRestored;
    inlineEvidence.hover.leftOpen = leftOpen;
    record('I7.1b', 'closing the panel RESTORES the hover preview — the suppression is not permanent',
      leftOpen === 0 && hoverRestored > 0,
      `${leftOpen} panel(s) open, ${hoverRestored} preview(s)`);

    // Right-click: OG's block-reference context menu, unchanged.
    await parkPointer();
    await attempt('right-click the reference', 20000,
      () => refOf(twoTargets).click({ button: 'right' }), null);
    await sleep(2000);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('#custom-context-menu');
      return { present: !!m, text: m ? (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '' };
    });
    inlineEvidence.contextMenu = menu;
    record('I7.2', "right-click still opens OG's own block-reference menu",
      menu.present && /Open in sidebar/i.test(menu.text) && /Copy this reference/i.test(menu.text),
      JSON.stringify(menu));
    await attempt('dismiss the menu', 15000, () => page.keyboard.press('Escape'), null);
    await sleep(1200);

    // Shift-click: straight to the right sidebar, and the sidebar carries no
    // control — it is not the main reading content this slice claims.
    await parkPointer();
    await attempt('shift-click the reference', 20000,
      () => refOf(twoTargets).click({ modifiers: ['Shift'] }), null);
    await sleep(3000);
    il = await inlineState();
    inlineEvidence.sidebar = {
      items: il.sidebarItems, refs: il.sidebarRefs, controls: il.inSidebar, hash: il.hash,
    };
    record('I7.3', 'Shift-click still sends the block to the right sidebar, and did not navigate',
      il.sidebarItems > 0 && /Inline%20Reading|Inline Reading/i.test(il.hash),
      `${il.sidebarItems} sidebar item(s); hash ${JSON.stringify(il.hash)}`);
    record('I7.4', 'the right sidebar renders references with NO control — an excluded surface',
      il.sidebarRefs > 0 && il.inSidebar === 0,
      `${il.sidebarRefs} reference(s) in the sidebar, ${il.inSidebar} control(s)`);

    // Ordinary click: still opens the target.
    await parkPointer();
    await attempt('click the reference', 20000, () => refOf(twoTargets).click(), null);
    await sleep(3000);
    const afterClick = await page.evaluate(() => ({ hash: location.hash }));
    inlineEvidence.ordinaryClick = afterClick;
    record('I7.5', "an ordinary click still opens the target, exactly as OG's reference always did",
      afterClick.hash.toLowerCase().includes(graphGen.UUID.inlineTarget) ||
        (/page\//.test(afterClick.hash) && !/Inline%20Reading/i.test(afterClick.hash)),
      `hash ${JSON.stringify(afterClick.hash)}`);

    await goInline();
    const back = await inlineState();
    record('I7.6', 'coming back, the controls are there again and nothing was remembered',
      back.main.length === 6 && back.main.every((r) => !r.open) && back.editorsOpen === 0,
      `${back.main.length} reference(s), ${back.main.filter((r) => r.open).length} open, ` +
      `${back.editorsOpen} editor(s)`);
    inlineEvidence.afterReturn = back;

    // ---------- O5 : the outgoing feature (regression) ----------
    say('\nO5  Links in this block');
    phase('outgoing-context', 'open-the-reference-overview');

    await openOverview();
    const rowCount = await count('.f27-ref-row');
    record('O5.0', 'the reference overview lists every source, so every outgoing section is on screen',
      rowCount === 10, `${rowCount} row(s); the overview renders at most 10 and the graph has 10 sources`);

    // Expand every row's context — the outgoing control lives inside it.
    const ctxToggles = await expandAllContexts();
    say(`          (after expanding: ${JSON.stringify(await pageState())})`);

    const outStateRaw = (row) => row.evaluate((r) => {
      const sec = r.querySelector('.f27-out');
      if (!sec) return null;
      const body = sec.querySelector('.f27-out-body');
      return {
        toggle: ((sec.querySelector('.f27-out-toggle') || {}).innerText || '').trim(),
        open: !!body,
        head: ((sec.querySelector('.f27-out-head') || {}).innerText || '').trim(),
        direction: ((sec.querySelector('.f27-out-direction') || {}).innerText || '').trim(),
        count: ((sec.querySelector('.f27-out-count') || {}).innerText || '').trim(),
        notes: [...sec.querySelectorAll('.f27-ctx-note')].map((n) => (n.innerText || '').trim()),
        sourceControls: sec.querySelectorAll('.f27-out-open-source').length,
        rows: [...sec.querySelectorAll('.f27-out-row')].map((x) => ({
          pos: ((x.querySelector('.f27-out-pos') || {}).innerText || '').trim(),
          mark: ((x.querySelector('.f27-out-mark') || {}).innerText || '').trim(),
          label: ((x.querySelector('.f27-out-label') || {}).innerText || '').trim(),
          crumb: ((x.querySelector('.f27-out-crumb') || {}).innerText || '').trim(),
          repeats: ((x.querySelector('.f27-out-repeats') || {}).innerText || '').trim(),
          missing: !!x.querySelector('.f27-out-missing'),
          self: x.classList.contains('is-self'),
          canExpand: !!x.querySelector('.f27-out-toggle-text'),
          canOpen: !!x.querySelector('.f27-out-source'),
          target: ((x.querySelector('.f27-out-target-text') || {}).innerText || ''),
        })),
        more: !!sec.querySelector('.f27-out-more'),
        openSource: !!sec.querySelector('.f27-out-open-source'),
        text: (sec.innerText || ''),
      };
    });
    // Never lets a slow render or a vanished row end the session: the check
    // that asked for the state fails with a diagnosis instead.
    const outState = async (row, label) => {
      const st = await attempt(`read section (${label || 'row'})`, 60000,
                               () => outStateRaw(row), null);
      if (st === null) {
        say(`          (page at failure: ${JSON.stringify(await pageState())})`);
        if (pageErrors.length) {
          say(`          (window errors so far, most recent last:)`);
          for (const e of pageErrors.slice(-3)) say(`            ${e.replace(/\n/g, '\n            ')}`);
        } else {
          say('          (the window reported no error)');
        }
      }
      return st;
    };

    const openOutgoing = async (row, label) => {
      await parkPointer();
      await attempt(label, 30000, () => row.locator('.f27-out-toggle').first().click(), null);
      await sleep(1500);
      return outState(row, label);
    };

    // ---- source order, deduplication and the direction statement ----------
    const orderedRow = await ensureRow('Ordered Links');
    const closed = await outState(orderedRow, 'ordered (closed)');
    record('O5.1', 'the control is offered inside the expanded context, collapsed, and counts the links',
      !!closed && !closed.open && /\(4\)/.test(closed.toggle),
      closed ? `control reads ${JSON.stringify(closed.toggle)}, open=${closed.open}` : 'no outgoing section rendered');

    const ordered = await openOutgoing(orderedRow, 'open ordered links');
    const orderedLabels = ordered ? ordered.rows.map((r) => r.label) : [];
    const expectedOrder = ['The anchor block', 'target-two', 'target-three', 'target-one'];
    const orderOk = orderedLabels.length === 4 &&
      expectedOrder.every((want, i) => (orderedLabels[i] || '').startsWith(want));
    record('O5.2', 'links are listed in SOURCE order, which is not their identity order',
      orderOk,
      `positions ${JSON.stringify(ordered ? ordered.rows.map((r) => r.pos) : [])}, ` +
      `labels ${JSON.stringify(orderedLabels)}; expected to start with ${JSON.stringify(expectedOrder)}`);

    record('O5.3', 'the section states its direction and its scope in words',
      !!ordered && /INSIDE this block/i.test(ordered.direction) &&
        /not the blocks that refer to it/i.test(ordered.direction) &&
        /page link/i.test(ordered.text),
      ordered ? JSON.stringify(ordered.direction.slice(0, 120)) : 'n/a');

    record('O5.4', 'every row carries source context and a target control, and no identifier',
      !!ordered && ordered.rows.every((r) => r.crumb.length > 0 && r.canOpen) &&
        !UUID_RE.test(ordered.text),
      ordered ? `crumbs ${JSON.stringify(ordered.rows.map((r) => r.crumb))}, ` +
                `raw uuid on screen: ${UUID_RE.test(ordered.text)}` : 'n/a');

    record('O5.5', 'Korean and emoji written around the links survive',
      !!ordered && /한국어/.test(await orderedRow.evaluate((r) => (r.innerText || ''))) &&
        /🎯/.test(await orderedRow.evaluate((r) => (r.innerText || ''))),
      'the source block mixes Korean, English and emoji between its links');

    // ---- repeats -----------------------------------------------------------
    const repeated = await openOutgoing(await ensureRow('Repeated Links'), 'open repeated links');
    const repeatRow = repeated ? repeated.rows.find((r) => /target-one/.test(r.label)) : null;
    record('O5.6', 'a target written three times is ONE row that counts its repeats',
      !!repeated && repeated.rows.length === 3 && !!repeatRow && /2/.test(repeatRow.repeats),
      repeated ? `${repeated.rows.length} row(s) ${JSON.stringify(repeated.rows.map((r) => r.label))}; ` +
                 `repeat note ${JSON.stringify(repeatRow ? repeatRow.repeats : null)}` : 'n/a');

    // ---- self reference and missing target, in one section -----------------
    const selfSec = await openOutgoing(await ensureRow('Self And Missing'), 'open self-and-missing');
    const selfRow = selfSec ? selfSec.rows.find((r) => r.self) : null;
    record('O5.7', 'a self-reference is marked, explained, and cannot be opened in place',
      !!selfRow && selfRow.mark === '↻' && !selfRow.canExpand &&
        selfSec.notes.some((n) => /itself/i.test(n)),
      selfSec ? `self row ${JSON.stringify(selfRow)}; notes ${JSON.stringify(selfSec.notes)}` : 'n/a');

    const missingRow = selfSec ? selfSec.rows.find((r) => r.missing) : null;
    record('O5.8', 'a link whose target is gone says so and offers no control that cannot work',
      !!missingRow && missingRow.mark === '⚠' && !missingRow.canExpand && !missingRow.canOpen &&
        !UUID_RE.test(selfSec.text),
      selfSec ? `missing row ${JSON.stringify(missingRow)}; ` +
                `${selfSec.rows.length} rows in one section` : 'n/a');

    // ---- genuinely empty, and an embed is not an inline block reference ----
    const emptySec = await openOutgoing(await ensureRow('Embed Only'), 'open embed-only');
    record('O5.9', 'a block that only EMBEDS the target has no inline block reference, and says so',
      !!emptySec && emptySec.rows.length === 0 &&
        emptySec.notes.some((n) => /No block reference is written/i.test(n)) &&
        !emptySec.notes.some((n) => /could not/i.test(n)) &&
        // A COMPLETE scan found nothing. It must not borrow the partial
        // sentence, and it must not offer the source as if more were unread.
        !emptySec.notes.some((n) => /part of this block|too long to scan/i.test(n)) &&
        emptySec.sourceControls === 0,
      emptySec ? `${emptySec.rows.length} row(s); notes ${JSON.stringify(emptySec.notes)}; ` +
                 `source controls ${emptySec.sourceControls}; ` +
                 `control reads ${JSON.stringify(emptySec.toggle)}` : 'n/a');

    // ---- pagination and the retention cap ---------------------------------
    const manyRow = await ensureRow('Many Links');
    let many = await openOutgoing(manyRow, 'open many links');
    const firstPage = many ? many.rows.length : 0;
    await parkPointer();
    await attempt('show more links', 20000,
      () => manyRow.locator('.f27-out-more').first().click(), null);
    await sleep(1500);
    const many2 = await outState(manyRow, 'many (page 2)');
    record('O5.10', 'links arrive a request at a time, and the continuation advances',
      firstPage === 5 && !!many2 && many2.rows.length === 10 && many.more,
      `${firstPage} shown, then ${many2 ? many2.rows.length : 0}; ` +
      `continuation offered: ${many ? many.more : null}`);

    // Reach the retention cap: 25 distinct links, 20 retained.
    for (let i = 0; i < 3; i++) {
      const has = await manyRow.locator('.f27-out-more').count().catch(() => 0);
      if (!has) break;
      await parkPointer();
      await attempt(`show more links ${i + 2}`, 20000,
        () => manyRow.locator('.f27-out-more').first().click(), null);
      await sleep(1200);
    }
    const capped = await outState(manyRow, 'many (capped)');
    record('O5.11', 'at the retention cap the remainder is STATED and the source is offered, not a dead control',
      !!capped && capped.rows.length === 20 && !capped.more && capped.openSource &&
        capped.notes.some((n) => /beyond the 20 kept here/i.test(n)),
      capped ? `${capped.rows.length} row(s), continuation offered: ${capped.more}, ` +
               `source offered: ${capped.openSource}; notes ${JSON.stringify(capped.notes.slice(-3))}` : 'n/a');

    // ---- partial scan, WITH links found ------------------------------------
    //
    // Three references are reachable, then the node bound stops the scan, then
    // a fourth reference sits beyond it. Everything the section says about this
    // block must be a floor rather than a total — in the collapsed control as
    // well as the body — and the source must be offered, because it is the only
    // place the rest of the text can be read.
    const longRow = await ensureRow('Partial Links');
    const partialClosed = await outState(longRow, 'partial (closed)');
    record('O5.16', 'a partial count is qualified in the COLLAPSED control, never shown as a total',
      !!partialClosed && !partialClosed.open &&
        /at least 3/i.test(partialClosed.toggle) && !/\(3\)/.test(partialClosed.toggle),
      partialClosed ? `control reads ${JSON.stringify(partialClosed.toggle)}`
                    : 'no outgoing section rendered');

    const longSec = await openOutgoing(longRow, 'open partial links');
    record('O5.17', 'the expanded body qualifies the count, says the scan was incomplete, and offers the source',
      !!longSec && longSec.rows.length === 3 &&
        /at least 3/i.test(longSec.count) &&
        longSec.notes.some((n) => /too long to scan completely/i.test(n)) &&
        longSec.sourceControls > 0,
      longSec ? `${longSec.rows.length} row(s); count ${JSON.stringify(longSec.count)}; ` +
                `notes ${JSON.stringify(longSec.notes)}; ` +
                `source controls ${longSec.sourceControls}` : 'n/a');

    // Operated from the KEYBOARD, not clicked: focus the control and press
    // Enter. The long Korean/English/emoji target is the LAST link found before
    // the cut, and is addressed by its own text rather than by position.
    const expandBtn = longRow.locator('.f27-out-row')
      .filter({ hasText: '긴 한국어' }).first()
      .locator('.f27-out-toggle-text').first();
    await attempt('focus expand control', 15000, () => expandBtn.focus(), null);
    const focused = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Enter', 15000, () => page.keyboard.press('Enter'), null);
    await sleep(2000);
    const expanded = await outState(longRow, 'partial (expanded)');
    const targetRow = expanded ? expanded.rows.find((r) => r.target && r.target.length > 0) : null;
    const shownLen = targetRow ? [...targetRow.target].length : 0;
    record('O5.12', "one target's own text opens in place from the KEYBOARD, bounded",
      /f27-out-toggle-text/.test(focused) && !!targetRow && shownLen > 0 && shownLen <= 460 &&
        expanded.notes.some((n) => /Shortened here/i.test(n)),
      `focused ${JSON.stringify(focused)}; ${shownLen} displayed character(s) ` +
      `(bound 420 plus chrome); notes ${JSON.stringify(expanded ? expanded.notes.slice(-2) : [])}`);

    record('O5.13', 'the expanded target keeps Korean and emoji, and states that it is one hop only',
      !!targetRow && /한국어/.test(targetRow.target) && /🎯/.test(targetRow.target) &&
        expanded.notes.some((n) => /One step only/i.test(n)),
      targetRow ? JSON.stringify(targetRow.target.slice(0, 80)) : 'n/a');

    const outLeak = await page.evaluate(() => ({
      editors: document.querySelectorAll('.f27-out textarea').length,
      embeds: document.querySelectorAll('.f27-out .block-embed, .f27-out .page-embed, .f27-out .custom-query').length,
      iframes: document.querySelectorAll('.f27-out iframe').length,
      images: document.querySelectorAll('.f27-out img').length,
      buttons: document.querySelectorAll('.f27-out button').length,
      nonButtons: [...document.querySelectorAll('.f27-out [onclick]')].length,
    }));
    record('O5.14', 'the outgoing surface stays read-only and every control is a real button',
      outLeak.editors === 0 && outLeak.embeds === 0 && outLeak.iframes === 0 &&
        outLeak.buttons > 0 && outLeak.nonButtons === 0,
      JSON.stringify(outLeak));

    // ---- partial scan, with NOTHING found ----------------------------------
    //
    // This block's only reachable route to the anchor is an embed macro, and
    // the real reference it contains sits beyond the node bound. The section
    // must say that nothing was found IN THE PART IT SCANNED. Saying "No block
    // reference is written inside this block" here would be a claim the scan
    // never established — and it is exactly what the code did before this
    // correction, immediately contradicted by a partial-scan warning below it.
    const lateSec = await openOutgoing(await ensureRow('Late Link'), 'open late link');
    record('O5.18', 'a scan cut off BEFORE any link never claims the block has none',
      !!lateSec && lateSec.rows.length === 0 &&
        lateSec.notes.some((n) => /part of this block that could be scanned/i.test(n)) &&
        !lateSec.notes.some((n) => /No block reference is written inside this block/i.test(n)) &&
        lateSec.sourceControls > 0 &&
        lateSec.count === '',
      lateSec ? `${lateSec.rows.length} row(s); notes ${JSON.stringify(lateSec.notes)}; ` +
                `count ${JSON.stringify(lateSec.count)}; ` +
                `source controls ${lateSec.sourceControls}; ` +
                `control reads ${JSON.stringify(lateSec.toggle)}` : 'n/a');

    record('O5.19', 'the two "found nothing" answers are different sentences on screen',
      !!lateSec && !!emptySec &&
        JSON.stringify(lateSec.notes) !== JSON.stringify(emptySec.notes),
      `complete: ${JSON.stringify(emptySec ? emptySec.notes : null)}; ` +
      `partial: ${JSON.stringify(lateSec ? lateSec.notes : null)}`);

    const bothDirections = await (await ensureRow('Ordered Links')).evaluate((r) => ({
      outgoing: !!r.querySelector('.f27-out'),
      inbound: !!r.querySelector('.f27-in'),
      outText: ((r.querySelector('.f27-out-head') || {}).innerText || '').trim(),
      inText: ((r.querySelector('.f27-in-toggle') || {}).innerText || '').trim(),
    }));
    record('O5.15', 'the two directions are separate sections with different words',
      bothDirections.outgoing && bothDirections.inbound &&
        bothDirections.outText !== bothDirections.inText,
      JSON.stringify(bothDirections));

    // ---------- O6 : existing behaviour, unchanged ----------
    say('\nO6  existing F27 behaviour on the same graph');
    phase('existing-f27', 'exercise-the-shipped-behaviour');

    // Whole-overview counts below only mean something if every row is expanded,
    // so anything a mid-run reset collapsed is restored first.
    await ensureOverview('the whole-overview checks');
    await expandAllContexts();

    const overview = await page.evaluate(() => {
      const p = document.querySelector('.f27-ref-overview');
      if (!p) return null;
      return {
        rows: [...p.querySelectorAll('.f27-ref-row')].map((r) => (r.innerText || '').trim().slice(0, 50)),
        idLeak: /id::/.test(p.innerText || ''),
        uuidLeak: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.innerText || ''),
        ctxLines: p.querySelectorAll('.f27-ctx-line').length,
      };
    });
    record('O6.1', 'the compact overview, its breadcrumbs and its context lines still render',
      !!overview && overview.rows.length === 10 && overview.ctxLines >= 10,
      overview ? `${overview.rows.length} row(s), ${overview.ctxLines} context line(s)` : 'n/a');
    record('O6.2', 'identifiers still stay out of the reading view',
      !!overview && !overview.idLeak && !overview.uuidLeak,
      overview ? `id:: ${overview.idLeak}, raw uuid ${overview.uuidLeak}` : 'n/a');

    // ---- Crystal -----------------------------------------------------------
    const crystalBefore = await count('.f27-crystal-chip');
    await attempt('open crystal config', 20000,
      () => page.locator('.f27-crystal-config-toggle').first().click(), null);
    await sleep(2000);
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('.f27-crystal-option')].map((o) => (o.innerText || '').trim()));
    await attempt('select #crystal', 20000,
      () => page.locator('.f27-crystal-option').filter({ hasText: '#crystal' }).first().click(), null);
    await sleep(3000);
    const selected = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.f27-crystal-chip')].map((c) => (c.innerText || '').trim()),
      rowsWithChip: [...document.querySelectorAll('.f27-ref-row')]
        .filter((r) => r.querySelector('.f27-crystal-chip'))
        .map((r) => ((r.querySelector('.f27-ref-crumb') || {}).innerText || '').trim()),
    }));
    const expectedTagged = ['Ordered Links', 'Study Plan'];
    const gotTagged = expectedTagged.filter((n) => selected.rowsWithChip.some((r) => r.includes(n)));
    record('O6.3', 'the Crystal marker still marks exactly the rows whose source block carries the tag',
      options.includes('#crystal') && gotTagged.length === expectedTagged.length &&
        selected.rowsWithChip.length === expectedTagged.length,
      `options ${JSON.stringify(options)}; marked ${JSON.stringify(selected.rowsWithChip)}; ` +
      `expected ${JSON.stringify(expectedTagged)}`);

    await attempt('clear crystal', 20000,
      () => page.locator('.f27-crystal-clear').first().click(), null);
    await sleep(2500);
    const clearedChips = await count('.f27-crystal-chip');
    record('O6.4', 'clearing the marker still removes every chip',
      clearedChips === crystalBefore, `${clearedChips} chip(s) after clearing (started at ${crystalBefore})`);

    // ---- children ----------------------------------------------------------
    const orderedRow2 = await ensureRow('Ordered Links');
    const kidControls = await orderedRow2.locator('.f27-desc-toggle-all').count().catch(() => 0);
    if (kidControls > 0) {
      await attempt('show children', 20000,
        () => orderedRow2.locator('.f27-desc-toggle-all').first().click(), null);
      await sleep(3000);
    }
    const descLines = await orderedRow2.locator('.f27-desc-line').count().catch(() => 0);
    record('O6.5', 'descendants still expand in place', kidControls > 0 && descLines > 0,
      `${kidControls} control(s), ${descLines} descendant line(s)`);

    // ---- inbound following and the cycle ----------------------------------
    const cycleRow = await ensureRow('Outgoing Cycle A');
    const inboundState = (row) => row.evaluate((r) => ({
      items: [...r.querySelectorAll('.f27-in-item')].map((e) => ({
        source: ((e.querySelector('.f27-in-crumb') || {}).innerText || '').trim(),
        stop: !!e.querySelector('.f27-in-mark.is-stop'),
        explore: !!e.querySelector('.f27-in-explore'),
      })),
      path: [...r.querySelectorAll('.f27-in-path-step')].map((e) => (e.innerText || '').trim()),
    }));
    const levels = [];
    if ((await cycleRow.locator('.f27-in-toggle').count().catch(() => 0)) > 0) {
      await attempt('follow cycle from A', 20000,
        () => cycleRow.locator('.f27-in-toggle').first().click(), null);
      await sleep(3500);
      levels.push(await inboundState(cycleRow));
      if ((await cycleRow.locator('.f27-in-item .f27-in-explore').count().catch(() => 0)) > 0) {
        await attempt('explore back to A', 20000,
          () => cycleRow.locator('.f27-in-item .f27-in-explore').first().click(), null);
        await sleep(3500);
        levels.push(await inboundState(cycleRow));
      }
    }
    const v1 = levels[0] ? levels[0].items.map((i) => i.source) : [];
    const v2 = levels[1] ? levels[1].items.map((i) => i.source) : [];
    const repeat = levels[1] ? levels[1].items.find((i) => /Outgoing Cycle A/.test(i.source)) : null;
    record('O6.6', 'inbound exploration still walks A -> B and then back to A, and stops at the repeat',
      v1.length === 1 && /Outgoing Cycle B/.test(v1[0]) &&
        v2.length === 1 && /Outgoing Cycle A/.test(v2[0]) &&
        !!repeat && (repeat.stop || !repeat.explore),
      `level 1 ${JSON.stringify(v1)}, level 2 ${JSON.stringify(v2)}, ` +
      `repeat stop=${repeat ? repeat.stop : null} explore=${repeat ? repeat.explore : null}`);

    // ---- assets ------------------------------------------------------------
    const assetRow = await ensureRow('Attachments');
    if ((await assetRow.locator('.f27-desc-toggle-all').count().catch(() => 0)) > 0) {
      await attempt('expand attachments', 20000,
        () => assetRow.locator('.f27-desc-toggle-all').first().click(), null);
      await sleep(3000);
    }
    const assets = await assetRow.evaluate((r) => {
      const imgs = [...r.querySelectorAll('.f27-asset-img')];
      return {
        nodes: r.querySelectorAll('.f27-asset').length,
        rendered: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        srcs: imgs.map((i) => (i.getAttribute('src') || '').slice(0, 60)),
        missing: r.querySelectorAll('.f27-asset-missing').length,
      };
    }).catch(() => ({ nodes: 0, rendered: 0, loaded: 0, srcs: [], missing: 0 }));
    record('O6.7', 'a graph-local image still renders with real pixels, and the other two do not',
      assets.loaded > 0 && assets.nodes > assets.loaded &&
        !assets.srcs.some((u) => /outside-the-graph/.test(u)),
      `${assets.nodes} asset view(s), ${assets.loaded} served, ${assets.missing} marked missing; ` +
      `srcs ${JSON.stringify(assets.srcs)}`);

    // ---- excerpts ----------------------------------------------------------
    const embedRow = await ensureRow('Study Plan');
    if ((await embedRow.locator('.f27-desc-toggle-all').count().catch(() => 0)) > 0) {
      await attempt('expand study plan', 20000,
        () => embedRow.locator('.f27-desc-toggle-all').first().click(), null);
      await sleep(3000);
    }
    const embedControls = await embedRow.locator('.f27-inert.is-embed .f27-embed-toggle').count().catch(() => 0);
    let excerpt = { block: 0, page: 0, rows: 0 };
    if (embedControls > 0) {
      await attempt('block excerpt', 20000,
        () => embedRow.locator('.f27-inert.is-embed:not(.is-page) .f27-embed-toggle').first().click(), null);
      await sleep(2500);
      await attempt('page excerpt', 20000,
        () => embedRow.locator('.f27-inert.is-embed.is-page .f27-embed-toggle').first().click(), null);
      await sleep(3000);
      excerpt = await page.evaluate(() => ({
        block: document.querySelectorAll('.f27-embed-body').length,
        page: document.querySelectorAll('.f27-page-embed-body').length,
        rows: document.querySelectorAll('.f27-page-embed-row').length,
      }));
    }
    record('O6.8', 'block and page excerpts still open in place',
      embedControls > 0 && (excerpt.block + excerpt.page) > 0,
      `${embedControls} excerpt control(s), ${excerpt.block} block body, ` +
      `${excerpt.page} page body, ${excerpt.rows} page row(s)`);

    const ogLeak = await page.evaluate(() => ({
      embeds: document.querySelectorAll('.f27-ref-overview .block-embed, .f27-ref-overview .page-embed, .f27-ref-overview .custom-query').length,
      iframes: document.querySelectorAll('.f27-ref-overview iframe').length,
      editors: document.querySelectorAll('.f27-ref-overview textarea').length,
    }));
    record('O6.9', 'the whole reading view still renders no OG embeds, iframes or editors',
      ogLeak.embeds === 0 && ogLeak.iframes === 0 && ogLeak.editors === 0, JSON.stringify(ogLeak));

    // Where OG's substitution ceiling is reached, and where it is not — the same
    // treatment I5.8/I5.9 already give it. As a body-wide boolean this check
    // could not say WHOSE notice it had found, and this batch's fixture is the
    // first to put a mutual pair into ordinary reading content, which OG
    // substitutes to `max-depth-of-links` exactly as it always has.
    const depthHere = await page.evaluate(() => {
      const NEEDLE = 'Block ref nesting is too deep';
      const all = [...document.querySelectorAll('.warning')]
        .filter((w) => (w.innerText || '').includes(NEEDLE));
      const within = (sel) => all.filter((w) => w.closest(sel)).length;
      return {
        total: all.length,
        inF27: within('.f27-il-panel, .f27-ctx, .f27-ref-overview'),
        inSidebar: within('.sidebar-item'),
        inEmbedSurface: within('.embed-block'),
        inOgSubstitution: within('.block-ref-wrap'),
        hosts: all.map((w) => {
          const b = w.closest('[blockid]');
          return (b ? (b.innerText || '') : '').replace(/\s+/g, ' ').trim().slice(0, 40);
        }),
      };
    });
    record('O6.10', 'no runaway reference substitution inside any F27 surface',
      depthHere.inF27 === 0,
      `${depthHere.inF27} inside an F27 panel, overview or context, of ${depthHere.total} ` +
      `on the page (${depthHere.inSidebar} in the right sidebar, ` +
      `${depthHere.inEmbedSurface} in an embed surface, ` +
      `${depthHere.inOgSubstitution} inside OG's own substitution); ` +
      `blocks ${JSON.stringify(depthHere.hosts)}`);

    fs.writeFileSync(path.join(EVIDENCE, 'inline-observations.json'), JSON.stringify({
      graph: GRAPH, build: v.manifest.pilotBuildId,
      ordered, repeated, selfSec, emptySec, capped, expanded,
      partialClosed, partialOpen: longSec, lateSec,
      overview, assets, excerpt, ogLeak, outLeak,
      inline: inlineEvidence,
      errors: errors.entries(), phases: errors.phases(),
    }, null, 2));

    // ---------- O7 : restore the stub ----------
    say('\nO7  restore the native dialog');
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
    record('O7.1', 'the dialog stub was removed and the original restored',
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
      record('O7.2', 'every owned process stopped, addressed by retained PID only',
        stillAlive.length === 0,
        `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
        `stage ${r.stage}` + (stillAlive.length ? `, still alive: ${stillAlive.join(', ')}` : ', none still alive'));
    }
  }

  // ---------- O8 : integrity ----------
  say('\nO8  graph integrity');
  // This run DELIBERATELY provokes one refusal: it points the folder dialog at
  // an inert path outside the permitted root and requires the application to
  // refuse it (O2.2). OG logs that refusal, and its filesystem handler logs the
  // failed call beside it.
  //
  // Those two are NAMED rather than folded into a "clean" claim, and — this is
  // what changed after the outgoing acceptance record — they are entitled by
  // CORRELATION with that operation, not by a substring. A filesystem error is
  // no longer exempt for omitting the graph path: the same text arriving in a
  // feature phase fails, which `f27-inline/tests/error-classifier.test.js`
  // proves deterministically with a path-free NFS error.
  errors.endPhase();
  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  fs.writeFileSync(path.join(EVIDENCE, 'window-errors.json'), JSON.stringify({
    phases: errors.phases(), entries: errors.entries(),
    expected: cls.expected, unexpected: cls.unexpected, byPhase: cls.byPhase,
  }, null, 2));
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(cls.unexpected, 5)) say(`          UNEXPECTED: ${line}`);

  record('O8.6', 'every window error was entitled by the deliberate negative test, ' +
                 'and no other error was thrown at any point',
    cls.unexpected.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected (correlated to ` +
    `${EC.NEGATIVE_PHASE}/${EC.NEGATIVE_OPERATION}), ${cls.unexpected.length} unexpected` +
    (cls.unexpected.length ? `: ${EC.describe(cls.unexpected, 1)[0]}` : ''));

  const featurePhases = ['inline-context', 'outgoing-context', 'existing-f27'];
  const duringFeatureUse = errors.entries().filter((e) => featurePhases.includes(e.phase));
  record('O8.8', 'no uncaught page error at all arrived while the features were being used',
    duringFeatureUse.length === 0,
    duringFeatureUse.length
      ? `${duringFeatureUse.length}: ${EC.describe(duringFeatureUse.map(
          (e) => Object.assign({ reason: 'during feature use' }, e)), 3).join(' | ')}`
      : `0 across ${featurePhases.join(', ')}`);

  // The shapes that unmount a React subtree, whatever else they are classified
  // as. This is a SECOND, narrower report: the gate above already fails any
  // unexpected error, so a render failure whose wording this list does not
  // happen to name still fails the run.
  record('O8.7', 'nothing that unmounts a panel was thrown while the panels were used',
    cls.renderFailures.length === 0,
    cls.renderFailures.length
      ? `${cls.renderFailures.length}: ${String(cls.renderFailures[0].text).slice(0, 300)}`
      : `0 render failures among ${errors.entries().length} captured line(s)`);
  record('O8.5', 'how often a panel had to be re-opened mid-run', true,
    repairs === 0
      ? '0 — every panel stayed open for as long as the run needed it'
      : `${repairs} — OG re-rendered and reset component-local state; each ` +
        'repair is logged above and the checks around it still had to pass');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  fs.writeFileSync(path.join(EVIDENCE, 'graph-content-diff.json'), JSON.stringify(cmp, null, 2));
  record('O8.1', 'no note content changed during the session (hashes, not existence)',
    cmp.content.length === 0,
    cmp.content.length ? cmp.content.map((c) => `${c.change} ${c.file}`).join('; ')
                       : `${cmp.beforeCount} files before, ${cmp.afterCount} after, 0 content changes`);
  record('O8.2', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ${cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 8).join('; ')}`
      : 'none');

  const boundaryEntries = journalSince(0).filter((e) => e.guard === 'graph-boundary');
  fs.writeFileSync(path.join(EVIDENCE, 'graph-boundary-journal.json'),
    JSON.stringify(boundaryEntries, null, 2));
  record('O8.3', 'boundary refusals were journalled during this run', boundaryEntries.length > 0,
    `${boundaryEntries.length} refusal(s) recorded`);

  record('O8.4', 'the accepted pilot fixture generator was not used by this run', true,
    `graph built from f27-inline/checks/make-inline-graph.js (${Object.keys(graphGen.PAGES).length} pages)`);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'inline-loaded-graph-summary.json'), JSON.stringify({
    at: new Date().toISOString(), app: APP_DIR, graph: GRAPH,
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
    fs.writeFileSync(path.join(EVIDENCE, 'inline-loaded-graph-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), results,
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
