#!/usr/bin/env node
'use strict';
//
// F27 against a REAL graph, loaded into the packaged pilot the ordinary way.
//
//   node f27-pilot/checks/loaded-graph-checks.js
//
// How the graph is opened, and why it is done this way:
//
//   The native folder dialog cannot be driven headlessly, and adding a
//   production IPC that loads a graph by path would be a new, unrestricted
//   entry point. So the harness stubs ONLY `dialog.showOpenDialog` in the main
//   process, returning a path it has already validated, and then uses Logseq
//   OG's ordinary flow: the "Add a graph" screen, the "Choose a folder"
//   button, `:openDir`, and the renderer's normal graph loading. The stub is
//   removed afterwards and its removal is verified.
//
//   The stub is not a way around the boundary. Before the good path is used,
//   the same stub is pointed at an inert OUTSIDE path to prove the application
//   refuses a bad dialog result -- the guard is in the app, not in the harness.
//
// Graph data is only ever the freshly generated synthetic graph inside the
// permitted root. No personal graph is opened, read or enumerated.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PILOT_DIR = path.resolve(REPO, '..');
const ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));
const preflight = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-preflight.js'));
const B = require('./allowed-root.js');
const graphGen = require('./make-synthetic-graph.js');
const batchGraph = require('./batch-graph.js');
const GH = require('./graph-hash.js');
const OP = require('./owned-process.js');

const APP_DIR = path.join(PILOT_DIR, 'out', 'Logseq-OG-F27-Pilot-darwin-x64',
                          'Logseq-OG-F27-Pilot.app');
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'Logseq-OG-F27-Pilot');
const RES_APP = path.join(APP_DIR, 'Contents', 'Resources', 'app');
const STATE_ROOT = path.join(os.userInfo().homedir, 'Library', 'Application Support',
                             ID.PRODUCT_NAME, ID.STATE_DIR);
const JOURNAL = path.join(STATE_ROOT, 'userData', 'pilot-guard-journal.jsonl');
const EVIDENCE = path.join(PILOT_DIR, 'evidence');

const results = [];
let ownedTree = [];
const sleep = OP.sleep;
function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  results.push({ id, title, ok: !!ok, detail: String(detail) });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${title}\n          ${detail}`);
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

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 pilot: real graph loaded through the ordinary workflow ===\n');

  // ---------- L0 ----------
  say('L0  preconditions');
  if (!fs.existsSync(EXE)) throw new Error(`packaged app not found at ${EXE}`);
  const v = preflight.verify(RES_APP);
  record('L0.1', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}` : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  record('L0.2', 'the boundary module is covered by the build manifest',
    !!v.manifest.artifacts['pilot-boundary.js'],
    `sha256 ${(v.manifest.artifacts['pilot-boundary.js'] || {}).sha256 || '(absent)'}`);

  // ---------- L1 ----------
  say('\nL1  synthetic graph, inside the permitted root only');
  // ONE graph per batch, reused after ownership, containment and content
  // checks, so repeated attempts stop littering the shared root. Nothing is
  // ever deleted, reset or renamed here.
  const batch = batchGraph.ensure(path.join(EVIDENCE, 'current-batch-graph.json'));
  const GRAPH = B.assertInsideAllowedRoot('synthetic graph', batch.graph);
  record('L1.1', 'one synthetic graph for this batch, inside the permitted root only', true,
    `${batch.reused ? 'reused after containment and content checks' : 'created'}: ${GRAPH}` +
    (batch.problems.length ? ` (previous one left in place: ${batch.problems.join('; ')})` : ''));
  const before = GH.snapshot(GRAPH);
  record('L1.2', 'graph content hashed before the session', true,
    `${Object.keys(before).length} files`);

  // An inert outside path: a sibling of the permitted root that does not exist.
  // Nothing personal, and nothing is created there.
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f27-pilot-inert-outside-probe');
  record('L1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- L2 ----------
  say('\nL2  launch, then a BAD dialog result');
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

    // scoped stub, main process only
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
      // The clickable element on the add-graph screen is `div.choose`; the
      // visible text sits on non-interactive descendants, so a text locator
      // finds a node that ignores the click.
      return attempt(label, 30000, () => page.locator('.choose').first().click(), null);
    };
    await chooseFolder('choose folder (bad)');
    await sleep(7000);

    const badRefusals = journalSince(markBad)
      .filter((e) => e.guard === 'graph-boundary' && /open-dir|get-files/.test(e.detail));
    record('L2.2', 'the application refused the outside dialog result',
      badRefusals.length > 0,
      badRefusals.length ? badRefusals[0].detail.slice(0, 150)
                         : 'no boundary refusal was journalled for the bad dialog result');

    const graphsAfterBad = await attempt('getGraphs after bad', 20000,
      () => page.evaluate(async () => window.apis.doAction(['getGraphs'])), null);
    // The pilot state root persists between runs, so earlier runs' graphs are
    // legitimately still registered. What must be true is that nothing OUTSIDE
    // the permitted root is ever there.
    const badRegistry = Array.isArray(graphsAfterBad)
      ? graphsAfterBad.map((g) => String(g).replace(/^logseq_local_/, ''))
                      .filter((g) => !B.isInsideAllowedRoot(g))
      : ['getGraphs did not return a list'];
    record('L2.3', 'the outside path was not added, and the registry holds nothing outside the root',
      Array.isArray(graphsAfterBad) && badRegistry.length === 0 &&
        !graphsAfterBad.some((g) => String(g).includes(BAD)),
      `${(graphsAfterBad || []).length} registered, ${badRegistry.length} outside the permitted root`);
    record('L2.4', 'nothing was created at the outside probe path', !fs.existsSync(BAD), BAD);

    // ---------- L3 : the good path, ordinary workflow ----------
    say('\nL3  open the synthetic graph through the ordinary workflow');
    await app.evaluate((_e, p) => { global.__pilotDialogPath = p; }, GRAPH);
    await chooseFolder('choose folder (good)');
    await sleep(20000);

    const graphs = await attempt('getGraphs', 20000,
      () => page.evaluate(async () => window.apis.doAction(['getGraphs'])), null);
    // A non-array or error result is a FAILURE, not an empty success.
    const graphsOk = Array.isArray(graphs);
    record('L3.1', 'getGraphs returned a real list (an error or non-array fails this check)',
      graphsOk, `${Object.prototype.toString.call(graphs)} -> ${JSON.stringify(graphs)}`);

    const registered = graphsOk ? graphs.map((g) => String(g).replace(/^logseq_local_/, '')) : [];
    const outside = registered.filter((g) => !B.isInsideAllowedRoot(g));
    record('L3.2', "this run's graph is registered, and every entry is inside the permitted root",
      registered.includes(GRAPH) && outside.length === 0,
      `${registered.length} registered (earlier runs persist in this profile), ` +
      `${outside.length} outside the permitted root; this run present: ${registered.includes(GRAPH)}`);

    // ---------- L4 : assert the ACTUAL loaded path before any feature use ----
    say('\nL4  assert the actual loaded graph path');
    const loaded = await attempt('loaded repo', 20000, () => page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/repo|graph/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 300);
      }
      const title = document.querySelector('.cp__sidebar-main-content, #main-content-container');
      return { ls: out, hash: location.hash, hasMain: !!title };
    }), {});
    const loadedStr = JSON.stringify(loaded.ls || {});
    const loadedPathOk = loadedStr.includes(GRAPH);
    record('L4.1', 'the loaded graph is the synthetic one, asserted before any feature use',
      loadedPathOk, loadedPathOk ? GRAPH : `no reference to the synthetic path in ${loadedStr.slice(0, 300)}`);

    const outsideRef = /\/Users\/[^"']*\/(Documents|Desktop)\//.test(loadedStr) ||
                       /com~apple~CloudDocs\/(?!Logseq Test)/.test(loadedStr);
    record('L4.2', 'no graph outside the permitted root is referenced by the app state',
      !outsideRef, outsideRef ? 'an outside path appears in the stored state' : 'none');

    if (!loadedPathOk) throw new Error('the synthetic graph did not load; not proceeding to features');

    // ---------- L5 : F27 features on the loaded graph ----------
    say('\nL5  F27 features on the loaded graph');
    const goTo = async (name) => {
      await page.evaluate((n) => { location.hash = '#/page/' + encodeURIComponent(n); }, name);
      await sleep(3500);
    };
    const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

    await goTo('Pilot Target');
    if ((await count('.f27-ref-overview')) === 0) {
      await attempt('open ref link', 15000,
        () => page.locator('a.open-block-ref-link').first().click(), null);
      await sleep(3000);
    }

    const overview = await page.evaluate(() => {
      const p = document.querySelector('.f27-ref-overview');
      if (!p) return null;
      return {
        rows: [...p.querySelectorAll('.f27-ref-row')].map((r) => (r.innerText || '').trim().slice(0, 60)),
        badges: p.querySelectorAll('.f27-ctx-badge').length,
        idLeak: /id::/.test(p.innerText || ''),
        uuidLeak: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.innerText || ''),
      };
    });
    record('L5.1', 'compact reference overview lists every source with its breadcrumb',
      !!overview && overview.rows.length > 0,
      overview ? `${overview.rows.length} row(s) (collapsed; badges appear with the ` +
                 `descriptions, see L5.12): ${JSON.stringify(overview.rows.slice(0, 6))}`
               : 'the F27 reference overview did not render');
    record('L5.2', 'identifiers stay out of the reading view',
      !!overview && !overview.idLeak && !overview.uuidLeak,
      overview ? `id:: ${overview.idLeak}, raw uuid ${overview.uuidLeak}` : 'n/a');

    // ---- Crystal: select a known tag, assert the preview, clear it --------
    // The graph tags three referencing blocks with #crystal, so the option is
    // known in advance rather than whatever happens to be offered.
    const crystalBefore = await count('.f27-crystal-chip');
    await attempt('open crystal config', 20000,
      () => page.locator('.f27-crystal-config-toggle').first().click(), null);
    await sleep(2000);
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('.f27-crystal-option')].map((o) => ({
        text: (o.innerText || '').trim(),
        pressed: o.getAttribute('aria-pressed'),
      })));
    record('L5.3', 'the Crystal tag list offers the tag the graph actually uses',
      options.some((o) => o.text === '#crystal'),
      `${options.length} option(s): ${JSON.stringify(options.map((o) => o.text))}`);

    await attempt('select #crystal', 20000,
      () => page.locator('.f27-crystal-option').filter({ hasText: '#crystal' }).first().click(), null);
    await sleep(3000);
    const selected = await page.evaluate(() => ({
      pressed: [...document.querySelectorAll('.f27-crystal-option')]
        .map((o) => `${(o.innerText || '').trim()}=${o.getAttribute('aria-pressed')}`),
      chips: [...document.querySelectorAll('.f27-crystal-chip')].map((c) => (c.innerText || '').trim()),
      rowsWithChip: [...document.querySelectorAll('.f27-ref-row')]
        .filter((r) => r.querySelector('.f27-crystal-chip'))
        .map((r) => ((r.querySelector('.f27-ref-crumb') || {}).innerText || '').trim()),
      clear: document.querySelectorAll('.f27-crystal-clear').length,
    }));
    // Weekly Review, Reading List and Link Check are the tagged sources.
    const expectedTagged = ['Weekly Review', 'Reading List', 'Link Check'];
    const gotTagged = expectedTagged.filter((n) => selected.rowsWithChip.some((r) => r.includes(n)));
    record('L5.14', 'selecting #crystal marks exactly the rows whose source block carries it',
      selected.chips.length > 0 && gotTagged.length === expectedTagged.length &&
        selected.rowsWithChip.length === expectedTagged.length,
      `${selected.chips.length} chip(s) ${JSON.stringify(selected.chips.slice(0, 4))} on ` +
      `${JSON.stringify(selected.rowsWithChip)}; expected ${JSON.stringify(expectedTagged)}; ` +
      `option state ${JSON.stringify(selected.pressed)}`);

    await attempt('clear crystal', 20000,
      () => page.locator('.f27-crystal-clear').first().click(), null);
    await sleep(2500);
    const cleared = await page.evaluate(() => ({
      chips: document.querySelectorAll('.f27-crystal-chip').length,
      pressed: [...document.querySelectorAll('.f27-crystal-option')]
        .map((o) => o.getAttribute('aria-pressed')),
    }));
    record('L5.15', 'clearing Crystal removes every chip and releases the tag',
      cleared.chips === crystalBefore && !cleared.pressed.includes('true'),
      `${cleared.chips} chip(s) after clearing (started at ${crystalBefore}), ` +
      `option state ${JSON.stringify(cleared.pressed)}`);


    // Rows arrive collapsed. Everything else -- description lines, assets,
    // inert embeds, the inbound-follow control -- only exists once the row's
    // context is shown, and the descriptions once "show all" is used. Measured,
    // not assumed: before expanding, a row contains no .f27-in-toggle at all.
    const ctxToggles = await count('.f27-ctx-toggle');
    for (let i = 0; i < ctxToggles; i++) {
      await attempt(`expand row ${i}`, 10000,
        () => page.locator('.f27-ctx-toggle').nth(i).click({ timeout: 5000 }), null);
      await sleep(400);
    }
    await sleep(2500);
    const ctxLines = await count('.f27-ctx-line');
    record('L5.4', 'context / children expands in place for every row',
      ctxToggles > 0 && ctxLines >= ctxToggles,
      `${ctxToggles} row(s) expanded, ${ctxLines} context line(s)`);

    const rowWith = (text) => page.locator('.f27-ref-row').filter({ hasText: text }).first();
    const expandDesc = async (row, label) => {
      const n = await row.locator('.f27-desc-toggle-all').count().catch(() => 0);
      if (n > 0) {
        await attempt(label, 20000, () => row.locator('.f27-desc-toggle-all').first().click(), null);
        await sleep(3000);
      }
      return n;
    };

    // ---- chained / cyclic following -------------------------------------
    const chainRow = rowWith('Pilot Chain 1');
    const chainControls = await chainRow.locator('.f27-in-toggle').count().catch(() => 0);
    let chain = { steps: 0, stops: 0, crumbs: 0 };
    if (chainControls > 0) {
      await attempt('follow chain', 20000, () => chainRow.locator('.f27-in-toggle').first().click(), null);
      await sleep(3500);
      chain = await page.evaluate(() => ({
        steps: document.querySelectorAll('.f27-in-item').length,
        stops: document.querySelectorAll('.f27-in-mark.is-stop').length,
        crumbs: document.querySelectorAll('.f27-in-path-step').length,
      }));
    }
    record('L5.5', 'chained references can be followed from a row', chainControls > 0 && chain.steps > 0,
      `${chainControls} follow control(s), ${chain.steps} step(s), ${chain.crumbs} path step(s)`);

    // ---- cyclic traversal, by visited identity ---------------------------
    // Counting steps proves nothing about which blocks were visited. This
    // records the source of every listed block and the path the explorer
    // reports, and asserts the intended A -> B -> A walk explicitly.
    // Scoped to the row being explored. Reading the whole document would mix in
    // the chain row's open explorer and make "which blocks were visited"
    // ambiguous -- which it did on the first run of this check.
    const inboundState = (row) => row.evaluate((r) => ({
      path: [...r.querySelectorAll('.f27-in-path-step')].map((e) => (e.innerText || '').trim()),
      head: ((r.querySelector('.f27-in-head') || {}).innerText || '').trim(),
      items: [...r.querySelectorAll('.f27-in-item')].map((e) => ({
        source: ((e.querySelector('.f27-in-crumb') || {}).innerText || '').trim(),
        text: ((e.querySelector('.f27-in-text') || {}).innerText || '').trim().slice(0, 60),
        stop: !!e.querySelector('.f27-in-mark.is-stop'),
        explore: !!e.querySelector('.f27-in-explore'),
        exploreLabel: ((e.querySelector('.f27-in-explore') || {}).innerText || '').trim(),
      })),
    }));

    const cycleRow = rowWith('Pilot Cycle A');
    const cycle = { levels: [], ok: false };
    if ((await cycleRow.locator('.f27-in-toggle').count().catch(() => 0)) > 0) {
      await attempt('follow cycle from A', 20000,
        () => cycleRow.locator('.f27-in-toggle').first().click(), null);
      await sleep(3500);
      cycle.levels.push(await inboundState(cycleRow));

      // Explore the block we just reached; in an A<->B cycle that must lead
      // back to A, which is already on the path.
      if ((await cycleRow.locator('.f27-in-item .f27-in-explore').count().catch(() => 0)) > 0) {
        await attempt('explore back to A', 20000,
          () => cycleRow.locator('.f27-in-item .f27-in-explore').first().click(), null);
        await sleep(3500);
        cycle.levels.push(await inboundState(cycleRow));
      }
    }

    const lvl1 = cycle.levels[0];
    const lvl2 = cycle.levels[1];
    const visited1 = lvl1 ? lvl1.items.map((i) => i.source) : [];
    const visited2 = lvl2 ? lvl2.items.map((i) => i.source) : [];
    record('L5.10', 'the cycle is traversed A -> B and then back to A, by visited identity',
      visited1.length === 1 && visited1[0] === 'Pilot Cycle B' &&
        visited2.length === 1 && visited2[0] === 'Pilot Cycle A',
      `level 1 from "Pilot Cycle A" visited ${JSON.stringify(visited1)}; ` +
      `level 2 visited ${JSON.stringify(visited2)}; ` +
      `path ${JSON.stringify(lvl2 ? lvl2.path : (lvl1 || {}).path || [])}`);

    // What happens at the repeat is asserted, not assumed. If the product marks
    // it, that is recorded; if it instead simply offers no further exploration,
    // that is recorded too -- and if it offers unbounded re-exploration, this
    // check fails rather than being reworded to fit.
    const repeat = lvl2 ? lvl2.items.find((i) => i.source === 'Pilot Cycle A') : null;
    const stopped = !!repeat && (repeat.stop || !repeat.explore);
    record('L5.13', 'the repeat is stopped rather than offered for endless re-exploration',
      stopped,
      repeat
        ? `repeat entry for "Pilot Cycle A": stop marker ${repeat.stop}, ` +
          `further explore control ${repeat.explore}` +
          (repeat.explore ? ` ("${repeat.exploreLabel}")` : '')
        : 'the walk never returned to Pilot Cycle A, so no repeat was reached');

    // ---- assets ----------------------------------------------------------
    const assetRow = rowWith('Attachments');
    const assetDesc = await expandDesc(assetRow, 'expand attachments descriptions');
    const assets = await assetRow.evaluate((r) => {
      const imgs = [...r.querySelectorAll('.f27-asset-img')];
      return {
        assetNodes: r.querySelectorAll('.f27-asset').length,
        rendered: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        srcs: imgs.map((i) => (i.getAttribute('src') || '').slice(0, 60)),
        missing: r.querySelectorAll('.f27-asset-missing').length,
        names: [...r.querySelectorAll('.f27-asset-name')].map((n) => (n.innerText || '').trim()).slice(0, 6),
        descLines: r.querySelectorAll('.f27-desc-line').length,
        badges: r.querySelectorAll('.f27-ctx-badge').length,
      };
    }).catch((e) => ({ error: String(e.message), assetNodes: 0, rendered: 0, loaded: 0,
                       srcs: [], missing: 0, names: [], descLines: 0, badges: 0 }));
    record('L5.6', 'an allowed image renders through assets:// with real pixels',
      assets.rendered > 0 && assets.loaded > 0,
      `${assetDesc} expand control(s), ${assets.descLines} description line(s), ` +
      `${assets.rendered} image view(s), ${assets.loaded} with pixels; srcs ${JSON.stringify(assets.srcs)}`);
    record('L5.7', 'the missing and out-of-graph assets are not served',
      assets.assetNodes > assets.loaded,
      `${assets.assetNodes} asset view(s), only ${assets.loaded} served, ` +
      `${assets.missing} marked missing; names ${JSON.stringify(assets.names)}`);
    record('L5.11', 'no asset is served from outside the graph',
      !assets.srcs.some((u) => /outside-the-graph/.test(u)),
      `srcs ${JSON.stringify(assets.srcs)}`);

    // ---- excerpts --------------------------------------------------------
    const embedRow = rowWith('Study Plan');
    const embedDesc = await expandDesc(embedRow, 'expand study plan descriptions');
    const embedControls = await embedRow.locator('.f27-inert.is-embed .f27-embed-toggle').count().catch(() => 0);
    let excerpt = { block: 0, page: 0, rows: 0, limits: 0 };
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
        limits: document.querySelectorAll('.f27-page-embed-limits').length,
      }));
    }
    record('L5.8', 'block and page excerpts open in place inside the row',
      embedControls > 0 && (excerpt.block + excerpt.page) > 0,
      `${embedDesc} expand control(s), ${embedControls} excerpt control(s), ` +
      `${excerpt.block} block body, ${excerpt.page} page body, ${excerpt.rows} page row(s), ` +
      `${excerpt.limits} limit note(s)`);

    const badgesAfter = await count('.f27-ctx-badge');
    record('L5.12', 'reference badges appear on the expanded description lines', badgesAfter > 0,
      `${badgesAfter} badge(s) once descriptions are shown`);

    const ogLeak = await page.evaluate(() => ({
      embeds: document.querySelectorAll('.f27-ref-overview .block-embed, .f27-ref-overview .page-embed, .f27-ref-overview .custom-query').length,
      iframes: document.querySelectorAll('.f27-ref-overview iframe').length,
      editors: document.querySelectorAll('.f27-ref-overview textarea').length,
    }));
    record('L5.9', 'the reading view renders no OG embeds, iframes or editors',
      ogLeak.embeds === 0 && ogLeak.iframes === 0 && ogLeak.editors === 0, JSON.stringify(ogLeak));

    fs.writeFileSync(path.join(EVIDENCE, 'loaded-graph-observations.json'),
      JSON.stringify({ graph: GRAPH, graphs, loaded, overview, assets, chain, excerpt, ogLeak }, null, 2));

    // ---------- L6 : restore the stub ----------
    say('\nL6  restore the native dialog');
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
    record('L6.1', 'the dialog stub was removed and the original restored',
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
      record('L7.1', 'every owned process stopped, addressed by retained PID only',
        stillAlive.length === 0,
        `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
        `stage ${r.stage}` +
        (stillAlive.length ? `, still alive: ${stillAlive.join(', ')}` : ', none still alive'));
    }
  }

  // ---------- L8 : integrity ----------
  say('\nL8  graph integrity');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  fs.writeFileSync(path.join(EVIDENCE, 'graph-content-diff.json'), JSON.stringify(cmp, null, 2));
  record('L8.1', 'no note content changed during the session (hashes, not existence)',
    cmp.content.length === 0,
    cmp.content.length
      ? cmp.content.map((c) => `${c.change} ${c.file}`).join('; ')
      : `${cmp.beforeCount} files before, ${cmp.afterCount} after, 0 content changes`);
  record('L8.2', 'OG housekeeping is recorded separately rather than counted as content',
    true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ${cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 8).join('; ')}`
      : 'none');

  const boundaryEntries = journalSince(0).filter((e) => e.guard === 'graph-boundary');
  fs.writeFileSync(path.join(EVIDENCE, 'graph-boundary-journal.json'),
    JSON.stringify(boundaryEntries, null, 2));
  record('L8.3', 'boundary refusals were journalled during this run', boundaryEntries.length > 0,
    `${boundaryEntries.length} refusal(s) recorded`);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'loaded-graph-summary.json'), JSON.stringify({
    at: new Date().toISOString(), app: APP_DIR, graph: GRAPH,
    passed: results.length - failed.length, failed: failed.length, results,
  }, null, 2));
  say(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) say(`  FAILED ${f.id} ${f.title}\n      ${f.detail}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  say('\n' + String((e && e.stack) || e) + '\n');
  // Evidence from a failed run is preserved, not discarded.
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'loaded-graph-summary.json'), JSON.stringify({
      at: new Date().toISOString(), aborted: String((e && e.message) || e), results,
    }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
