#!/usr/bin/env node
'use strict';
//
// The F27 OUTGOING feature against a REAL graph, loaded into the packaged
// feature build the ordinary way.
//
//   node f27-outgoing/checks/outgoing-loaded-graph-checks.js
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
const ID = require(path.join(REPO, 'f27-outgoing', 'src', 'feature-identity.js'));
const PILOT_ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const batchGraph = require('./outgoing-batch-graph.js');
const graphGen = require('./make-outgoing-graph.js');

const APP_NAME = 'Logseq-OG-F27-Outgoing';
const APP_DIR = path.join(FEATURE_DIR, 'out', `${APP_NAME}-darwin-x64`, `${APP_NAME}.app`);
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', APP_NAME);
const RES_APP = path.join(APP_DIR, 'Contents', 'Resources', 'app');
const STATE_ROOT = path.join(os.userInfo().homedir, 'Library', 'Application Support',
                             ID.PRODUCT_NAME, ID.STATE_DIR);
const JOURNAL = path.join(STATE_ROOT, 'userData', 'pilot-guard-journal.jsonl');
const EVIDENCE = path.join(FEATURE_DIR, 'evidence');

const results = [];
let ownedTree = [];
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
  say('\n=== F27 outgoing feature: real graph loaded through the ordinary workflow ===\n');

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
      v.manifest.builtFrom.branch === 'feature/f27-outgoing-context',
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

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-outgoing-inert-outside-probe');
  record('O1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- O2 : launch, then a BAD dialog result ----------
  say('\nO2  launch, then a BAD dialog result');
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));
  const app = await withTimeout(_electron.launch({ executablePath: EXE, timeout: 120000 }),
                                180000, 'electron launch');
  let appPid = null;
  let stubInstalled = false;
  try {
    appPid = await attempt('main pid', 20000, () => app.evaluate(() => process.pid), null);
    if (appPid) ownedTree = OP.descendants(appPid);
    const page = await withTimeout(app.firstWindow(), 60000, 'firstWindow');
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
    await chooseFolder('choose folder (bad)');
    await sleep(7000);

    const badRefusals = journalSince(markBad)
      .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
    record('O2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 150)
                         : 'no boundary refusal was journalled for the bad dialog result');
    record('O2.3', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- O3 : the good path, ordinary workflow ----------
    say('\nO3  open the synthetic graph through the ordinary workflow');
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

    // ---------- O5 : the outgoing feature ----------
    say('\nO5  Links in this block');
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

    await goTo('Outgoing Target');
    if ((await count('.f27-ref-overview')) === 0) {
      await attempt('open ref link', 15000,
        () => page.locator('a.open-block-ref-link').first().click(), null);
      await sleep(3000);
    }
    const rowCount = await count('.f27-ref-row');
    record('O5.0', 'the reference overview lists every source, so every outgoing section is on screen',
      rowCount === 10, `${rowCount} row(s); the overview renders at most 10 and the graph has 10 sources`);

    // Expand every row's context — the outgoing control lives inside it.
    const ctxToggles = await count('.f27-ctx-toggle');
    for (let i = 0; i < ctxToggles; i++) {
      await attempt(`expand row ${i}`, 10000,
        () => page.locator('.f27-ctx-toggle').nth(i).click({ timeout: 5000 }), null);
      await sleep(300);
    }
    await sleep(2500);

    const rowWith = (text) => page.locator('.f27-ref-row').filter({ hasText: text }).first();
    const outState = (row) => row.evaluate((r) => {
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
    const openOutgoing = async (row, label) => {
      await attempt(label, 20000, () => row.locator('.f27-out-toggle').first().click(), null);
      await sleep(1500);
      return outState(row);
    };

    // ---- source order, deduplication and the direction statement ----------
    const orderedRow = rowWith('Ordered Links');
    const closed = await outState(orderedRow);
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
    const repeated = await openOutgoing(rowWith('Repeated Links'), 'open repeated links');
    const repeatRow = repeated ? repeated.rows.find((r) => /target-one/.test(r.label)) : null;
    record('O5.6', 'a target written three times is ONE row that counts its repeats',
      !!repeated && repeated.rows.length === 3 && !!repeatRow && /2/.test(repeatRow.repeats),
      repeated ? `${repeated.rows.length} row(s) ${JSON.stringify(repeated.rows.map((r) => r.label))}; ` +
                 `repeat note ${JSON.stringify(repeatRow ? repeatRow.repeats : null)}` : 'n/a');

    // ---- self reference ----------------------------------------------------
    const selfSec = await openOutgoing(rowWith('Self Link'), 'open self link');
    const selfRow = selfSec ? selfSec.rows.find((r) => r.self) : null;
    record('O5.7', 'a self-reference is marked, explained, and cannot be opened in place',
      !!selfRow && selfRow.mark === '↻' && !selfRow.canExpand &&
        selfSec.notes.some((n) => /itself/i.test(n)),
      selfSec ? `self row ${JSON.stringify(selfRow)}; notes ${JSON.stringify(selfSec.notes)}` : 'n/a');

    // ---- missing target ----------------------------------------------------
    const missingSec = await openOutgoing(rowWith('Missing Link'), 'open missing link');
    const missingRow = missingSec ? missingSec.rows.find((r) => r.missing) : null;
    record('O5.8', 'a link whose target is gone says so and offers no control that cannot work',
      !!missingRow && missingRow.mark === '⚠' && !missingRow.canExpand && !missingRow.canOpen &&
        !UUID_RE.test(missingSec.text),
      missingSec ? `missing row ${JSON.stringify(missingRow)}` : 'n/a');

    // ---- genuinely empty, and an embed is not an inline block reference ----
    const emptySec = await openOutgoing(rowWith('Embed Only'), 'open embed-only');
    record('O5.9', 'a block that only EMBEDS the target has no inline block reference, and says so',
      !!emptySec && emptySec.rows.length === 0 &&
        emptySec.notes.some((n) => /No block reference is written/i.test(n)) &&
        !emptySec.notes.some((n) => /could not/i.test(n)),
      emptySec ? `${emptySec.rows.length} row(s); notes ${JSON.stringify(emptySec.notes)}; ` +
                 `control reads ${JSON.stringify(emptySec.toggle)}` : 'n/a');

    // ---- pagination and the retention cap ---------------------------------
    const manyRow = rowWith('Many Links');
    let many = await openOutgoing(manyRow, 'open many links');
    const firstPage = many ? many.rows.length : 0;
    await attempt('show more links', 20000,
      () => manyRow.locator('.f27-out-more').first().click(), null);
    await sleep(1500);
    const many2 = await outState(manyRow);
    record('O5.10', 'links arrive a request at a time, and the continuation advances',
      firstPage === 5 && !!many2 && many2.rows.length === 10 && many.more,
      `${firstPage} shown, then ${many2 ? many2.rows.length : 0}; ` +
      `continuation offered: ${many ? many.more : null}`);

    // Reach the retention cap: 25 distinct links, 20 retained.
    for (let i = 0; i < 3; i++) {
      const has = await manyRow.locator('.f27-out-more').count().catch(() => 0);
      if (!has) break;
      await attempt(`show more links ${i + 2}`, 20000,
        () => manyRow.locator('.f27-out-more').first().click(), null);
      await sleep(1200);
    }
    const capped = await outState(manyRow);
    record('O5.11', 'at the retention cap the remainder is STATED and the source is offered, not a dead control',
      !!capped && capped.rows.length === 20 && !capped.more && capped.openSource &&
        capped.notes.some((n) => /beyond the 20 kept here/i.test(n)),
      capped ? `${capped.rows.length} row(s), continuation offered: ${capped.more}, ` +
               `source offered: ${capped.openSource}; notes ${JSON.stringify(capped.notes.slice(-3))}` : 'n/a');

    // ---- one hop, bounded, and the keyboard --------------------------------
    const longRow = rowWith('Long Target Link');
    const longSec = await openOutgoing(longRow, 'open long target link');
    // Operated from the KEYBOARD, not clicked: focus the control and press Enter.
    const expandBtn = longRow.locator('.f27-out-toggle-text').last();
    await attempt('focus expand control', 15000, () => expandBtn.focus(), null);
    const focused = await page.evaluate(() =>
      (document.activeElement && document.activeElement.className) || '');
    await attempt('press Enter', 15000, () => page.keyboard.press('Enter'), null);
    await sleep(2000);
    const expanded = await outState(longRow);
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

    const bothDirections = await rowWith('Ordered Links').evaluate((r) => ({
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
    const orderedRow2 = rowWith('Ordered Links');
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
    const cycleRow = rowWith('Outgoing Cycle A');
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
    const assetRow = rowWith('Attachments');
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
    const embedRow = rowWith('Study Plan');
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

    const consoleDepth = await page.evaluate(() =>
      document.body.innerText.includes('Block ref nesting is too deep'));
    record('O6.10', 'no runaway reference substitution anywhere on the page', !consoleDepth,
      consoleDepth ? 'OG printed its depth ceiling warning' : '0 depth warnings');

    fs.writeFileSync(path.join(EVIDENCE, 'outgoing-observations.json'), JSON.stringify({
      graph: GRAPH, build: v.manifest.pilotBuildId,
      ordered, repeated, selfSec, missingSec, emptySec, capped, expanded,
      overview, assets, excerpt, ogLeak, outLeak,
    }, null, 2));

    // ---------- O7 : restore the stub ----------
    say('\nO7  restore the native dialog');
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
    `graph built from f27-outgoing/checks/make-outgoing-graph.js (${Object.keys(graphGen.PAGES).length} pages)`);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'outgoing-loaded-graph-summary.json'), JSON.stringify({
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
    fs.writeFileSync(path.join(EVIDENCE, 'outgoing-loaded-graph-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), results,
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
