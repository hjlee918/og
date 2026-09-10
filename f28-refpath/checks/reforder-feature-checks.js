#!/usr/bin/env node
'use strict';
//
// F28 SOURCE-PAGE GROUP ORDERING — the feature, in the packaged application.
//
//   node f28-refpath/checks/reforder-feature-checks.js
//
// What `reforder-baseline-checks.js` established on the same fixture, in a
// build without this feature: the groups are drawn journal-first and otherwise
// in neither title order, and the section offers no ordering control of any
// kind. This run establishes what one `<select>` adds, and that everything the
// baseline observed as working still works.
//
// WHAT IS ASSERTED, AND WHAT IS MERELY RECORDED.
//
// Asserted: the three orders, the restoration, that membership and every count
// are identical under all three, that nothing inside a group moves, that a
// group survives being moved rather than being rebuilt in its new place, that
// the earlier F28 slices' controls still address their own blocks afterwards,
// that the sidebar's copy is untouched, and that sorting writes nothing to the
// graph.
//
// Recorded: which rows OG happens to have drawn at each moment. This list
// renders behind `ui/lazy-visible`, so what is on screen is a function of
// scrolling; every reading here settles first, and the settled reading is what
// is compared.
//
// THE FILTER'S WRITE IS DECLARED IN ADVANCE. Applying a filter makes OG's own
// `page-handler/save-filter!` persist the choice as a `filters::` property in
// the anchor page's FILE. That is OG's normal behaviour at this run's explicit
// request, NOT a write by the ordering, which only reads titles. The graph is
// therefore hashed a SECOND time while the application is still open, after
// every sorting phase and BEFORE the filter is touched (P12), so the ordering's
// read-only claim stands on its own rather than on subtracting a known write
// from a total.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own fresh synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal
// graph is opened, read or enumerated, no earlier run's folder is touched, and
// the installed application is never launched. The loaded graph path is
// asserted BEFORE any feature interaction.
//
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));
const RG = require('./make-reforder-graph.js');
const APP = require('./packaged-app.js');
const NOISE = require('./browser-noise.js');
const REC = require('./recorder.js');
const RD = require('./reforder-read.js');

const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
const FEATURE_APP = 'Logseq-OG-F28-RefPath';

const results = [];
let ownedTree = [];
const errors = REC.createRecorder();
const observations = {};
let errorEvidence = null;
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
const J = (v) => JSON.stringify(v);

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 group ordering: three orders over the source-page groups ===\n');

  const filterAccounting = {
    anchorFile: `pages/${RG.ANCHOR}.md`,
    anchorBefore: null,
    page: null,
  };

  // ---------- P0 : preconditions ----------
  say('P0  preconditions');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('P0.1', 'this build is present and passes its identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}, ` +
           `dirty ${v.manifest.builtFrom.dirty}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  observations.build = {
    app: built.appName,
    schema: v.manifest.schema,
    branch: v.manifest.builtFrom.branch,
    commit: v.manifest.builtFrom.commit,
    dirty: v.manifest.builtFrom.dirty,
    renderer: v.manifest.builtFrom.rendererRevision,
    buildId: v.manifest.pilotBuildId,
  };
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  record('P0.2', 'the packaged renderer really carries this feature',
    names.some((n) => n.startsWith('frontend.util.f28_reforder')),
    `f28_reforder ${names.some((n) => n.startsWith('frontend.util.f28_reforder'))}, ` +
    `f28_refrole ${names.some((n) => n.startsWith('frontend.util.f28_refrole'))}, ` +
    `f28_refctx ${names.some((n) => n.startsWith('frontend.util.f28_refctx'))}, ` +
    `f28_refpath ${names.some((n) => n.startsWith('frontend.util.f28_refpath'))}`);
  // The compiled renderer must carry the RULE, not merely a namespace with the
  // right name. A dictionary entry or a CSS class proves neither.
  let compiled = '';
  for (const f of names.filter((n) => n.startsWith('frontend.util.f28_reforder'))) {
    compiled += fs.readFileSync(path.join(runtime, f), 'utf8');
  }
  const has = (re) => re.test(compiled);
  record('P0.3', 'and carries the comparison itself, compiled',
    has(/order_groups/) && has(/compare_titles/) && has(/code_points/) && has(/NFC/),
    `order-groups ${has(/order_groups/)}, compare-titles ${has(/compare_titles/)}, ` +
    `code-points ${has(/code_points/)}, NFC ${has(/NFC/)} ` +
    `(${compiled.length} bytes of compiled namespace)`);

  // ---------- P1 : a fresh graph ----------
  say('\nP1  a fresh synthetic graph');
  const g = RG.build({ kind: 'feature' });
  const GRAPH = B.assertInsideAllowedRoot('reforder graph', g.graph);
  record('P1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal})`);
  record('P1.2', 'the decomposed source-page file name survived to disk',
    g.normalizationOnDisk === 'NFD',
    `the file written as NFD is on disk as ${g.normalizationOnDisk} ` +
    `(${J(g.onDisk)}); this is what makes the NFC step in the rule load-bearing ` +
    `rather than decorative`);
  observations.fixture = { graph: GRAPH, normalizationOnDisk: g.normalizationOnDisk,
                           onDisk: g.onDisk, journalFile: g.journalFile };
  const before = GH.snapshot(GRAPH);
  filterAccounting.anchorBefore = RG.readPage(GRAPH, filterAccounting.anchorFile);
  const controlBefore = RG.readPage(GRAPH, RG.CONTROL_FILE);
  record('P1.3', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 1, `${Object.keys(before).length} files`);
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-reforder-inert-probe');
  record('P1.4', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- P2/P3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'P',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    const settle = RD.makeSettle(page, session, say);

    /** Choose an order through the control, then settle and read. */
    const choose = async (value, why) => {
      const out = { value, changed: false, error: null };
      try {
        await page.selectOption('select.f28-order-select', value, { timeout: 15000 });
        out.changed = true;
      } catch (e) {
        out.error = String(e && e.message).split('\n')[0].slice(0, 200);
      }
      await sleep(1500);
      await settle(why);
      return out;
    };

    // ---------- P4 : OG's own list, and the control ----------
    say("\nP4  OG's own list, and the control this feature adds");
    phase('ordering', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
    await settle('on the anchor page');
    const original = await RD.read(page);
    observations.original = original.present ? RD.lean(original) : original;
    record('P4.1', 'the linked-references section rendered', original.present === true,
      original.present ? original.heading : `not present: ${original.error}`);
    if (!original.present) throw new Error('no linked-references section; not proceeding');

    record('P4.2', 'the count still counts mentions, and every source page is a group',
      original.heading.includes(String(RG.REFERENCING.length)) &&
      original.groups.length === 8 && original.groups.every((x) => x.ref),
      () => `"${original.heading}" for ${RG.REFERENCING.length} referencing block(s); ` +
        `${original.groups.length} group(s), ${original.rows.length} row(s)`);
    record('P4.3', 'the list opens in OG\'s OWN order, journal first, exactly as the baseline saw it',
      original.wrapOrder === 'original' && original.controlOrder === 'original' &&
      original.groups[0].ref === original.groups.map((x) => x.ref)
        .find((r) => !Object.values(RG.GROUP_IDS).includes(r)),
      () => `list ${J(original.wrapOrder)}, control ${J(original.controlOrder)}; ` +
        `drawn ${J(RD.orderOf(original))}`);
    record('P4.4', 'the control is one <select>, in the heading, and says what it chose',
      original.selects === 1 && original.controlInHeading === true &&
      original.controlOptions.length === 3 &&
      J(original.controlOptions.map((o) => o.value)) ===
        J(['original', 'title-asc', 'title-desc']) &&
      original.controlTabIndex === null,
      () => `${original.selects} select, in the heading ${original.controlInHeading}, ` +
        `options ${J(original.controlOptions)}, tabindex ${J(original.controlTabIndex)}`);
    record('P4.5', 'it names itself and explains itself, in words from the dictionary',
      !!original.controlLabel && !!original.controlTitle &&
      /source page/i.test(original.controlLabel) &&
      /nothing is written to your notes/i.test(original.controlTitle),
      () => `aria-label ${J(original.controlLabel)}\n          title ${J(original.controlTitle)}`);
    record('P4.6', "OG's own filter, unlinked references, editing and the earlier F28 controls " +
      'are all still there',
      original.filterControl === true && original.unlinked === true &&
      original.editors === 0 && original.labels === original.rows.length &&
      original.ctxControls > 0 && original.pathControls > 0,
      () => `filter ${original.filterControl}, unlinked ${original.unlinked}, ` +
        `${original.editors} editor(s), ${original.labels} role label(s) on ` +
        `${original.rows.length} row(s), ${original.ctxControls} child-context control(s), ` +
        `${original.pathControls} source-path control(s)`);

    // The keys the order is decided by, read from the titles the application
    // actually holds. Recorded so the order below is a stated consequence of
    // the rule rather than a list somebody arranged.
    const live = original.groups.map((x) => ({ ref: x.ref, title: x.title }));
    const keys = live.map((x) => RG.sortKey(x.title));
    observations.sortKeys = live.map((x, i) => ({ ref: x.ref, title: x.title, key: keys[i] }));
    const expectAsc = RG.orderTitles(live, 'title-asc').map((x) => x.ref);
    const expectDesc = RG.orderTitles(live, 'title-desc').map((x) => x.ref);
    observations.expected = { ascending: expectAsc, descending: expectDesc };
    record('P4.7', 'no two source pages share a sort key, so no tie can decide this order',
      new Set(keys).size === keys.length,
      () => `${new Set(keys).size} distinct key(s) for ${keys.length} group(s); ` +
        `the key is OG's own page-identity mandate, which is unique per page, so a ` +
        `tie between two DISTINCT source pages cannot be constructed here — the tie ` +
        `rule is established at unit scale instead (f28_reforder_test.cljs)`);

    const originalOrder = RD.orderOf(original);
    const originalInside = RD.insideOf(original);
    const originalRowSet = new Set(original.rows.map((r) => r.id));
    const originalRowCount = original.rows.length;

    // ---------- P5 : ascending ----------
    say('\nP5  source-page title, ascending');
    phase('ordering', 'choose-title-ascending');
    const ascPick = await choose('title-asc', 'under title-ascending');
    const asc = await RD.read(page);
    observations.ascending = asc.present ? RD.lean(asc) : asc;
    record('P5.1', 'the groups are drawn in source-page title order, ascending',
      ascPick.changed && asc.present && J(RD.orderOf(asc)) === J(expectAsc),
      () => `drawn    ${J(RD.orderOf(asc))}\n          expected ${J(expectAsc)}` +
        (ascPick.error ? `\n          (the control: ${ascPick.error})` : ''));
    record('P5.2', 'and that order is what the rule predicts from the titles the application holds',
      asc.present && J(RD.orderOf(asc)) === J(expectAsc) &&
      J(RD.orderOf(asc)) !== J(originalOrder),
      () => `Latin before Hangul, 가·나·다·하 in that order, and the decomposed title ` +
        `LAST rather than first: ${J(RD.orderOf(asc).slice(-1))}`);
    record('P5.3', 'the list and the control agree on what was applied',
      asc.wrapOrder === 'title-asc' && asc.controlOrder === 'title-asc' &&
      asc.controlValue === 'title-asc',
      () => `list ${J(asc.wrapOrder)}, control ${J(asc.controlOrder)}, ` +
        `value ${J(asc.controlValue)}`);
    record('P5.4', 'case alone did not decide it: "apple source" is before "Banana Source"',
      asc.present &&
      RD.orderOf(asc).indexOf(RG.GROUP_IDS.apple) < RD.orderOf(asc).indexOf(RG.GROUP_IDS.banana) &&
      RD.orderOf(asc).indexOf(RG.GROUP_IDS.banana) < RD.orderOf(asc).indexOf(RG.GROUP_IDS.zebra),
      () => `apple ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.apple)}, ` +
        `Banana ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.banana)}, ` +
        `Zebra ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.zebra)} ` +
        `(a code-point sort without lower-casing would put both capitals first)`);
    record('P5.5', 'the decomposed Korean title sorted where its composed form belongs',
      asc.present &&
      RD.orderOf(asc).indexOf(RG.GROUP_IDS.ha) === RD.orderOf(asc).length - 1 &&
      RD.orderOf(asc).indexOf(RG.GROUP_IDS.ga) < RD.orderOf(asc).indexOf(RG.GROUP_IDS.na),
      () => `하(NFD on disk) at ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.ha)} of ` +
        `${RD.orderOf(asc).length - 1}; 가 ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.ga)} < ` +
        `나 ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.na)} < ` +
        `다 ${RD.orderOf(asc).indexOf(RG.GROUP_IDS.da)} ` +
        `(without NFC the decomposed title would sort FIRST of the four)`);

    // ---------- P6 : descending ----------
    say('\nP6  source-page title, descending');
    phase('ordering', 'choose-title-descending');
    const descPick = await choose('title-desc', 'under title-descending');
    const desc = await RD.read(page);
    observations.descending = desc.present ? RD.lean(desc) : desc;
    record('P6.1', 'the groups are drawn in source-page title order, descending',
      descPick.changed && desc.present && J(RD.orderOf(desc)) === J(expectDesc),
      () => `drawn    ${J(RD.orderOf(desc))}\n          expected ${J(expectDesc)}`);
    record('P6.2', 'the list and the control agree on what was applied',
      desc.wrapOrder === 'title-desc' && desc.controlOrder === 'title-desc',
      () => `list ${J(desc.wrapOrder)}, control ${J(desc.controlOrder)}`);

    // ---------- P7 : restoration ----------
    say("\nP7  back to OG's own order");
    phase('ordering', 'choose-the-original-order-again');
    const backPick = await choose('original', 'back under the original order');
    const back = await RD.read(page);
    observations.restored = back.present ? RD.lean(back) : back;
    record('P7.1', "choosing Original restores exactly the order OG drew, group for group",
      backPick.changed && back.present && J(RD.orderOf(back)) === J(originalOrder),
      () => `restored ${J(RD.orderOf(back))}\n          OG's own ${J(originalOrder)}`);
    record('P7.2', 'and the list says so',
      back.wrapOrder === 'original' && back.controlOrder === 'original',
      () => `list ${J(back.wrapOrder)}, control ${J(back.controlOrder)}`);

    // ---------- P8 : nothing but the order changed ----------
    say('\nP8  what did NOT change under any of the three orders');
    const readings = { original, 'title-asc': asc, 'title-desc': desc, restored: back };
    const rowSets = {};
    const insides = {};
    for (const [name, r] of Object.entries(readings)) {
      rowSets[name] = r.present ? r.rows.map((x) => x.id).sort() : null;
      insides[name] = r.present ? RD.insideOf(r) : null;
    }
    observations.membership = Object.fromEntries(
      Object.entries(rowSets).map(([k, v]) => [k, v ? v.length : null]));
    record('P8.1', 'every reading holds exactly the same rows — none added, none lost',
      Object.values(rowSets).every((s) => s && J(s) === J(rowSets.original)),
      () => Object.entries(rowSets).map(([k, s]) => `${k}:${s ? s.length : '—'}`).join(' ') +
        `; identical multisets ` +
        `${Object.values(rowSets).every((s) => s && J(s) === J(rowSets.original))}`);
    record('P8.2', 'a block drawn twice is still drawn twice; nothing was deduplicated',
      original.rows.filter((r) => r.id === RG.UUID.naChild).length === 2 &&
      Object.values(readings).every((r) =>
        r.present && r.rows.filter((x) => x.id === RG.UUID.naChild).length === 2),
      () => Object.entries(readings).map(([k, r]) =>
        `${k}:${r.present ? r.rows.filter((x) => x.id === RG.UUID.naChild).length : '—'}`)
        .join(' ') + ' appearance(s) of the child that also mentions the page');
    record('P8.3', 'the count in the heading never moved',
      Object.values(readings).every((r) => r.present && r.heading === original.heading),
      () => Object.entries(readings).map(([k, r]) => `${k}: ${J(r.heading)}`).join('; '));
    // COMPARED GROUP BY GROUP, NEVER MAP AGAINST MAP. `insideOf` builds its
    // result by walking the groups in DOM order, so the object's KEY order IS
    // the group order — and `JSON.stringify` preserves it. The first two runs
    // of this scenario compared the two maps whole and failed on exactly the
    // thing the feature is supposed to change, while every group's rows,
    // nesting, levels and breadcrumbs were identical in all three readings.
    const insideDiffs = [];
    for (const [name, ins] of Object.entries(insides)) {
      if (!ins) { insideDiffs.push(`${name}: no reading`); continue; }
      for (const ref of new Set([...Object.keys(originalInside), ...Object.keys(ins)])) {
        if (J(ins[ref]) !== J(originalInside[ref])) insideDiffs.push(`${name}/${ref}`);
      }
    }
    record('P8.4', 'and INSIDE every group nothing moved: same rows, same nesting, same breadcrumbs',
      insideDiffs.length === 0,
      () => insideDiffs.length
        ? `differs: ${J(insideDiffs)}`
        : `${Object.keys(originalInside).length} group(s) × ` +
          `${Object.keys(insides).length} reading(s) compared by row order, parent BLOCK ` +
          `(never position), level and breadcrumb — 0 differences`);
    record('P8.5', 'the role labels, child-context and source-path controls are all still there',
      Object.values(readings).every((r) => r.present &&
        r.labels === r.rows.length &&
        r.ctxControls === original.ctxControls &&
        r.pathControls === original.pathControls),
      () => Object.entries(readings).map(([k, r]) =>
        `${k}: ${r.labels} label(s)/${r.ctxControls} ctx/${r.pathControls} path`).join('; '));

    // ---------- P9 : the same question twice gives the same answer ----------
    say('\nP9  determinism');
    phase('ordering', 'ask-for-each-order-a-second-time');
    await choose('title-asc', 'under title-ascending, again');
    const asc2 = await RD.read(page);
    await choose('title-desc', 'under title-descending, again');
    const desc2 = await RD.read(page);
    await choose('original', 'back under the original order, again');
    const back2 = await RD.read(page);
    observations.secondPass = {
      ascending: RD.orderOf(asc2), descending: RD.orderOf(desc2), restored: RD.orderOf(back2),
    };
    record('P9.1', 'asking for the same order again draws the same order',
      J(RD.orderOf(asc2)) === J(RD.orderOf(asc)) &&
      J(RD.orderOf(desc2)) === J(RD.orderOf(desc)) &&
      J(RD.orderOf(back2)) === J(originalOrder),
      () => `ascending ${J(RD.orderOf(asc2)) === J(RD.orderOf(asc))}, ` +
        `descending ${J(RD.orderOf(desc2)) === J(RD.orderOf(desc))}, ` +
        `original ${J(RD.orderOf(back2)) === J(originalOrder)}`);
    record('P9.2', 'descending is the negated comparison, not the ascending list reversed',
      J(RD.orderOf(desc)) === J(expectDesc) &&
      J(expectDesc) === J([...expectAsc].reverse()),
      () => `with no tied keys the two coincide here, which is why the difference is ` +
        `established at unit scale instead: ties keep OG's order in BOTH directions ` +
        `(f28_reforder_test.cljs, tied-groups-keep-ogs-own-order-in-both-directions)`);

    // ---------- P10 : identity and focus survive a reorder ----------
    say('\nP10 identity through reordering');
    phase('ordering', 'reorder-and-compare-the-ids-the-controls-address');
    const domIdsOf = (r) => Object.fromEntries(
      (r.groups || []).map((gp) => [gp.ref, gp.domIds]));
    const idsOriginal = domIdsOf(back2);
    // Focus the control the way a reader does BEFORE reordering with it.
    // Playwright's `selectOption` sets the value and dispatches the events; it
    // is not a click and does not leave focus behind, so the first run of this
    // scenario asked whether focus had survived something that never gave it
    // focus in the first place. What is worth asserting is that the reorder
    // does not TAKE focus away from the control that caused it.
    await page.locator('select.f28-order-select').first().focus().catch(() => null);
    const focusBefore = await page.evaluate(() => !!(document.activeElement &&
      document.activeElement.classList &&
      document.activeElement.classList.contains('f28-order-select'))).catch(() => false);
    await choose('title-asc', 'under title-ascending, for the identity comparison');
    const idsAsc = await RD.read(page);
    observations.identity = {
      original: idsOriginal,
      ascending: domIdsOf(idsAsc),
    };
    const preserved = Object.keys(idsOriginal).filter((ref) =>
      J(idsOriginal[ref]) === J(domIdsOf(idsAsc)[ref]));
    record('P10.1', 'every group kept the DOM ids it had before it was moved',
      preserved.length === Object.keys(idsOriginal).length &&
      Object.values(idsOriginal).every((v) => v.length > 0),
      () => `${preserved.length}/${Object.keys(idsOriginal).length} groups kept every ` +
        `\`ls-block-<container>-<uuid>\` id across the reorder. Without a key on the ` +
        `lazy-visible wrapper this list reconciles by POSITION, and every one of them ` +
        `would have been rebuilt with a new container id`);
    const ctxOf = (r) => Object.fromEntries((r.rows || [])
      .filter((x) => x.ctxControl)
      .map((x) => [`${x.id}@${x.domId}`, x.ctxControls]));
    record('P10.2', "the child-context controls still name their own row's panel",
      J(ctxOf(idsAsc)) === J(ctxOf(back2)) && Object.keys(ctxOf(back2)).length > 0,
      () => `${Object.keys(ctxOf(back2)).length} control(s) before, ` +
        `${Object.keys(ctxOf(idsAsc)).length} after; aria-controls identical ` +
        `${J(ctxOf(idsAsc)) === J(ctxOf(back2))}`);
    // The control the reader was using must still be the control they are using.
    const focusAfter = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el ? el.tagName.toLowerCase() : null,
               cls: el && typeof el.className === 'string' ? el.className : null };
    }).catch(() => null);
    record('P10.3', 'and focus stayed on the control that did the reordering',
      focusBefore === true && !!focusAfter && focusAfter.tag === 'select' &&
      /f28-order-select/.test(focusAfter.cls || ''),
      () => `focused before the reorder: ${focusBefore}; after: ${J(focusAfter)}`);

    // ---------- P11 : the keyboard, and the language ----------
    say('\nP11 the keyboard, and the interface language');
    phase('ordering', 'operate-the-control-from-the-keyboard');
    await choose('original', 'back under the original order, for the keyboard');
    const kb = { reached: false, routes: [], value: null };
    // Reached by Tab from the group header before it — a real keyboard walk,
    // not a scripted focus() call.
    // The control is the FIRST keyboard stop in the section — the heading comes
    // before the groups, and OG's own filter link takes no focus at all (it has
    // neither `href` nor `tabindex`). The first run of this scenario tabbed
    // FORWARD from the first group link, which walks away from the select and
    // never comes back; the walk is now made in the direction the control
    // actually lies in, and both directions are recorded.
    await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      const h = sec && sec.querySelector('h2');
      if (h) h.scrollIntoView({ block: 'center' });
      const first = sec && sec.querySelector('.references-blocks-item a[tabindex], ' +
                                             '.references-blocks-item a[href]');
      if (first) first.focus();
    }).catch(() => null);
    const isSelect = () => page.evaluate(() =>
      !!(document.activeElement && document.activeElement.classList &&
         document.activeElement.classList.contains('f28-order-select'))).catch(() => false);
    kb.startedInsideTheList = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? (el.tagName.toLowerCase() +
        (typeof el.className === 'string' && el.className ?
          '.' + el.className.trim().split(/\s+/)[0] : '')) : null;
    }).catch(() => null);
    for (let i = 0; i < 6 && !kb.reached; i++) {
      await page.keyboard.press('Shift+Tab');
      await sleep(250);
      kb.reached = await isSelect();
      kb.shiftTabPresses = i + 1;
    }
    record('P11.1', 'the control is reachable with the keyboard alone',
      kb.reached === true,
      kb.reached
        ? `Shift+Tab from the first link inside the list (${kb.startedInsideTheList}) ` +
          `reached the select in ${kb.shiftTabPresses} press(es) — it is the first ` +
          `keyboard stop in the section, because the heading precedes the groups and ` +
          `OG's own filter link takes no focus at all`
        : `never reached the select from ${kb.startedInsideTheList}`);
    // Which keyboard routes actually operate a closed <select> is a platform
    // question, so every route is TRIED and what happened is recorded; the
    // assertion is that at least one of them works without the mouse.
    if (kb.reached) {
      for (const keys of [['ArrowDown'], ['ArrowDown', 'ArrowDown'], ['s'], ['End'], ['Home']]) {
        const beforeVal = await page.evaluate(() =>
          document.querySelector('select.f28-order-select').value).catch(() => null);
        for (const k of keys) { await page.keyboard.press(k); await sleep(400); }
        await sleep(900);
        const afterVal = await page.evaluate(() =>
          document.querySelector('select.f28-order-select').value).catch(() => null);
        kb.routes.push({ keys: keys.join('+'), from: beforeVal, to: afterVal,
                         changed: beforeVal !== afterVal });
        if (beforeVal !== afterVal) break;
      }
    }
    await settle('after the keyboard');
    const kbRead = await RD.read(page);
    kb.value = kbRead.controlValue;
    observations.keyboard = kb;
    const worked = kb.routes.find((r) => r.changed) || null;
    record('P11.2', 'and it can be operated from the keyboard, with no mouse at all',
      !!worked,
      () => `routes tried: ${J(kb.routes)}` +
        (worked ? `; ${worked.keys} changed it ${worked.from} → ${worked.to}` : ''));
    record('P11.3', 'and whatever the keyboard chose, the list drew that order',
      kbRead.present && kbRead.wrapOrder === kbRead.controlValue &&
      J(RD.orderOf(kbRead)) === J(
        kbRead.controlValue === 'original' ? originalOrder
          : kbRead.controlValue === 'title-asc' ? expectAsc : expectDesc),
      () => `control ${J(kbRead.controlValue)}, list ${J(kbRead.wrapOrder)}, ` +
        `drawn ${J(RD.orderOf(kbRead))}`);
    record('P11.4', 'operating it opened no editor and navigated nowhere',
      kbRead.present && kbRead.editors === 0 && kbRead.groups.length === 8,
      () => `${kbRead.editors} editor(s), ${kbRead.groups.length} group(s) still drawn`);

    phase('ordering', 'switch-the-interface-to-korean');
    const setLanguage = (lang) => page.evaluate((l) => {
      const st = window.frontend && window.frontend.state;
      const fn = st && st.set_preferred_language_BANG_;
      if (typeof fn !== 'function') return { ok: false, reason: 'no language seam' };
      fn(l);
      return { ok: true };
    }, lang).catch((e) => ({ ok: false, reason: String(e.message) }));
    await choose('title-asc', 'in English, before the language switch');
    const beforeKo = await RD.read(page);
    const switched = await setLanguage('ko');
    await sleep(3500);
    await settle('in Korean');
    const ko = await RD.read(page);
    observations.korean = ko.present ? {
      label: ko.controlLabel, title: ko.controlTitle, options: ko.controlOptions,
      order: RD.orderOf(ko), value: ko.controlValue,
    } : ko;
    record('P11.5', 'the interface language really changed', switched.ok === true,
      switched.ok ? 'frontend.state/set-preferred-language! → ko'
                  : `not switched: ${switched.reason}`);
    record('P11.6', "the control's own words are Korean, and none of them stayed English",
      ko.present && /[가-힣]/.test(ko.controlLabel || '') &&
      ko.controlOptions.length === 3 &&
      ko.controlOptions.every((o) => /[가-힣]/.test(o.text)) &&
      !ko.controlOptions.some((o) => /Source page title/i.test(o.text)),
      () => `aria-label ${J(ko.controlLabel)}, options ${J(ko.controlOptions.map((o) => o.text))}`);
    record('P11.7', 'and the ORDER is unchanged by the language — the rule is not a locale',
      ko.present && J(RD.orderOf(ko)) === J(RD.orderOf(beforeKo)) &&
      ko.controlValue === beforeKo.controlValue,
      () => `English ${J(RD.orderOf(beforeKo))}\n          Korean  ${J(RD.orderOf(ko))}`);
    record('P11.8', "the graph's own Korean and emoji still read correctly",
      ko.present && ko.groups.every((x) => !/�/.test(x.title)) &&
      ko.groups.some((x) => /[가-힣]/.test(x.title)),
      () => J(ko.groups.map((x) => x.title)));
    await setLanguage('en');
    await sleep(3000);
    await settle('back in English');

    // ---------- P12 : the graph, mid-run, before any filter ----------
    say('\nP12 the graph while the application is open, after every sorting phase');
    phase('ordering', 'hash-the-graph-before-any-filter-is-touched');
    const midway = GH.snapshot(GRAPH);
    const midCmp = GH.compare(before, midway);
    observations.midRun = {
      content: midCmp.content.map((c) => `${c.change} ${c.file}`),
      housekeeping: midCmp.housekeeping.map((c) => `${c.change} ${c.file}`),
    };
    record('P12.1', 'sorting wrote nothing at all; this is the ordering\'s own read-only claim',
      midCmp.content.length === 0,
      midCmp.content.length ? J(midCmp.content.map((c) => `${c.change} ${c.file}`))
                            : `0 content changes across ${midCmp.afterCount} files, after ` +
                              `${observations.secondPass ? 'eight' : 'several'} order changes ` +
                              `and a language switch`);
    record('P12.2', 'and the control page is byte-identical while the application is open',
      RG.readPage(GRAPH, RG.CONTROL_FILE) === controlBefore, RG.CONTROL_FILE);

    // ---------- P13 : the filter, applied, then sorted ----------
    say('\nP13 the filter applied for real, and then sorted on top of it');
    const chosenRef = RG.GROUP_IDS.ga;
    const chosenGroup = original.groups.find((x) => x.ref === chosenRef);
    filterAccounting.page = RG.GA;
    const chosenIds = new Set(chosenGroup.rowIds);
    const headingNow = () => page.evaluate(() => {
      const h = document.querySelector('.references.page-linked h2');
      return h ? (h.innerText || '').replace(/\s+/g, ' ').trim() : null;
    }).catch(() => null);
    const dialogState = () => page.evaluate(() => ({
      open: !!document.querySelector('.ls-filters'),
      buttons: [...document.querySelectorAll('.ls-filters button')]
        .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 12),
    })).catch(() => ({ open: false, buttons: [] }));
    const filterDiagnostics = [];
    const openFilter = async () => {
      const diag = { step: 'open', clickError: null, dialog: null };
      try {
        await page.evaluate(() => {
          const a = document.querySelector('.references.page-linked a.filter');
          if (a) a.scrollIntoView({ block: 'center' });
        }).catch(() => null);
        await page.locator('.references.page-linked a.filter').first()
          .click({ timeout: 15000 });
      } catch (e) {
        diag.clickError = String(e && e.message).split('\n')[0].slice(0, 200);
      }
      await sleep(2500);
      diag.dialog = await dialogState();
      filterDiagnostics.push(diag);
      return diag;
    };
    // OG's own gesture: a real click with the real modifier. A synthetic
    // dispatch was what run 3 of the reference-role scenario got wrong, and a
    // swallowed click is indistinguishable from a filter that did not apply —
    // so the click is trusted only once its EFFECT is visible in the heading.
    const clickFilterButton = async (pageName, exclude, headingBefore) => {
      const diag = { step: exclude ? 'exclude' : 'toggle', clicked: false, applied: false,
                     clickError: null, headingAfter: null };
      try {
        await page.locator('.ls-filters button', { hasText: pageName }).first()
          .click({ timeout: 8000, modifiers: exclude ? ['Shift'] : [] });
        diag.clicked = true;
      } catch (e) {
        diag.clickError = String(e && e.message).split('\n')[0].slice(0, 220);
      }
      for (let i = 0; i < 5 && !diag.applied; i++) {
        await sleep(1200);
        const after = await headingNow();
        diag.applied = after !== null && after !== headingBefore;
        if (diag.applied) diag.headingAfter = after;
      }
      filterDiagnostics.push(diag);
      return diag;
    };

    phase('filtering', 'apply-an-exclude-filter-then-sort');
    await choose('original', 'before the filter is applied');
    const preFilter = await RD.read(page);
    await openFilter();
    const excluded = await clickFilterButton(RG.GA, true, preFilter.heading);
    await page.keyboard.press('Escape').catch(() => null);
    await settle('under the exclude filter');
    const filtered = await RD.read(page);
    observations.filterExclude = filtered.present ? RD.lean(filtered) : filtered;
    record('P13.1', 'excluding a source page really removes its group and its rows',
      excluded.applied && filtered.present &&
      !RD.orderOf(filtered).includes(chosenRef) &&
      filtered.rows.every((r) => !chosenIds.has(r.id) || !chosenIds.size),
      () => `${excluded.applied ? 'applied' : 'did NOT apply'} the exclude of ${J(RG.GA)}; ` +
        `${filtered.groups.length} group(s) left, ${filtered.rows.length} row(s), ` +
        `heading ${J(filtered.heading)}`);
    // WHAT THE FIRST RUN OF THIS SCENARIO GOT WRONG, AND WHAT IT MEASURED.
    //
    // This check expected the filtered `original` order to be the unfiltered
    // one with the excluded group removed. It is not, and the difference is
    // OG's, not this feature's: `references*` builds the groups with
    // `(group-by :block/page …)`, whose seq order is a hash map's, so removing
    // a key can reorder the ones that remain. The measurement is kept as
    // evidence — it is the sharpest statement of §1 of the specification, that
    // OG's order for ordinary pages is not a property anybody chose — and what
    // is ASSERTED here is what this feature owns: with `original` selected it
    // applied nothing, so what is drawn is OG's own order and not a title one.
    observations.ogOrderUnderFilter = {
      unfiltered: originalOrder,
      unfilteredMinusExcluded: originalOrder.filter((r) => r !== chosenRef),
      filtered: RD.orderOf(filtered),
      sameAsUnfilteredMinusExcluded:
        J(RD.orderOf(filtered)) === J(originalOrder.filter((r) => r !== chosenRef)),
    };
    const keptAsc = expectAsc.filter((r) => r !== chosenRef);
    const keptDesc = expectDesc.filter((r) => r !== chosenRef);
    record('P13.2', 'with Original selected the feature applied nothing: what is drawn is ' +
      "OG's own order for the set the filter kept",
      filtered.present && filtered.wrapOrder === 'original' &&
      J(RD.orderOf(filtered)) !== J(keptAsc) &&
      J(RD.orderOf(filtered)) !== J(keptDesc),
      () => `drawn ${J(RD.orderOf(filtered))}\n          ` +
        `and NOT ${J(keptAsc)} / ${J(keptDesc)}\n          ` +
        `(recorded: OG's own order for the kept set ` +
        `${observations.ogOrderUnderFilter.sameAsUnfilteredMinusExcluded ? 'is' : 'is NOT'} ` +
        `the unfiltered order minus the excluded group — ` +
        `${J(observations.ogOrderUnderFilter.unfilteredMinusExcluded)}. ` +
        `\`group-by\` is a hash map, so removing a key can reorder the rest; that is ` +
        `OG's, and it is why "Original" is defined as "hand OG's own sequence back" ` +
        `rather than as any particular sequence)`);

    phase('filtering', 'sort-the-filtered-list');
    const fAscPick = await choose('title-asc', 'under the exclude filter, ascending');
    const fAsc = await RD.read(page);
    observations.filterExcludeSorted = fAsc.present ? RD.lean(fAsc) : fAsc;
    record('P13.3', 'the filter chooses WHICH groups; the order then arranges what it kept',
      fAscPick.changed && fAsc.present &&
      J(RD.orderOf(fAsc)) === J(expectAsc.filter((r) => r !== chosenRef)) &&
      !RD.orderOf(fAsc).includes(chosenRef),
      () => `drawn    ${J(RD.orderOf(fAsc))}\n          ` +
        `expected ${J(expectAsc.filter((r) => r !== chosenRef))}`);
    record('P13.4', 'the filtered count is untouched by the ordering',
      fAsc.present && fAsc.heading === filtered.heading,
      () => `${J(filtered.heading)} → ${J(fAsc.heading)}`);
    record('P13.5', 'and every row still drawn keeps its role label',
      fAsc.present && fAsc.labels === fAsc.rows.length && fAsc.rows.length > 0,
      () => `${fAsc.labels} label(s) on ${fAsc.rows.length} row(s)`);
    // Back to Original, under the filter. What is ASSERTED is that the feature
    // applied nothing; whether OG's own sequence is the same one it produced a
    // few seconds ago is OG's business and is RECORDED.
    //
    // It was not, in the run that first asked: applying a filter makes OG write
    // `filters::` to the anchor page's file, OG's own watcher re-parses that
    // file, and the transaction re-renders `references*`, which rebuilds
    // `(group-by :block/page …)` from a fresh query. A hash map's seq order is
    // not a promise, so the groups came back in a different order — with the
    // same membership, the same counts and nothing moved inside any of them.
    // That is the same property §1 of the specification names, seen at its
    // sharpest, and it is the reason `:original` is defined as "hand OG's own
    // sequence back" rather than as any particular sequence. Unfiltered, with
    // no such write in between, the restoration IS exact — P7.1 and P9.1.
    const fBackPick = await choose('original', 'back under the exclude filter, original');
    const fBack = await RD.read(page);
    observations.filteredRestore = {
      whenTheFilterWasApplied: RD.orderOf(filtered),
      afterSortingAndBack: RD.orderOf(fBack),
      identical: J(RD.orderOf(fBack)) === J(RD.orderOf(filtered)),
      sameGroups: J([...RD.orderOf(fBack)].sort()) === J([...RD.orderOf(filtered)].sort()),
    };
    record('P13.6', 'choosing Original again under the filter applies no ordering, and the ' +
      'same groups come back',
      fBackPick.changed && fBack.present && fBack.wrapOrder === 'original' &&
      J(RD.orderOf(fBack)) !== J(keptAsc) && J(RD.orderOf(fBack)) !== J(keptDesc) &&
      observations.filteredRestore.sameGroups &&
      fBack.heading === filtered.heading,
      () => `drawn ${J(RD.orderOf(fBack))}\n          ` +
        `when the filter was applied ${J(RD.orderOf(filtered))}\n          ` +
        `identical: ${observations.filteredRestore.identical}; same groups: ` +
        `${observations.filteredRestore.sameGroups}; heading ${J(fBack.heading)}` +
        (observations.filteredRestore.identical ? ''
          : ` — OG re-queried and its own hash-map seq order came back different; ` +
            `see the note above this check`));

    phase('filtering', 'remove-the-exclude-then-apply-an-include-and-sort');
    await openFilter();
    const h1 = await headingNow();
    const removed = await clickFilterButton(RG.GA, false, h1);
    const h2 = await headingNow();
    const included = await clickFilterButton(RG.GA, false, h2);
    await page.keyboard.press('Escape').catch(() => null);
    await choose('original', 'under the include filter, original');
    const inclOrig = await RD.read(page);
    const incPick = await choose('title-desc', 'under the include filter, descending');
    const incl = await RD.read(page);
    observations.filterInclude = incl.present ? RD.lean(incl) : incl;
    record('P13.7', 'including one source page keeps only that group, whatever the order',
      removed.applied && included.applied && incPick.changed && incl.present &&
      J(RD.orderOf(incl)) === J([chosenRef]) && J(RD.orderOf(inclOrig)) === J([chosenRef]),
      () => `${removed.applied ? 'removed the exclude' : 'did NOT remove the exclude'}, ` +
        `${included.applied ? 'applied the include' : 'did NOT apply the include'}; ` +
        `groups ${J(RD.orderOf(incl))}, heading ${J(incl.heading)}`);
    // Compared against the reading taken under the SAME filter a moment ago,
    // because OG rebuilds each group's parent map when the filter changes and
    // `(group-by :block/parent …)` is a hash map too — a difference across a
    // filter change is OG's own and says nothing about the ordering. Both
    // comparisons are recorded; the ASSERTION is the one this feature owns.
    observations.includedGroupInside = {
      unfiltered: originalInside[chosenRef] || null,
      includeOriginal: RD.insideOf(inclOrig)[chosenRef] || null,
      includeDescending: RD.insideOf(incl)[chosenRef] || null,
    };
    record('P13.8', 'and changing the order under that filter moved nothing inside the group ' +
      'it kept',
      incl.present && incl.groups.length === 1 &&
      J(RD.insideOf(incl)[chosenRef]) === J(RD.insideOf(inclOrig)[chosenRef]),
      () => `original   ${J(RD.insideOf(inclOrig)[chosenRef] || null)}\n          ` +
        `descending ${J(RD.insideOf(incl)[chosenRef] || null)}\n          ` +
        `(unfiltered, for the record: ${J(originalInside[chosenRef] || null)})`);
    const liveState = await page.evaluate((display) => {
      const out = { filters: null, error: null };
      try {
        const api = window.logseq && window.logseq.api;
        const p = api && typeof api.get_page === 'function' ? api.get_page(display) : null;
        out.filters = p && p.properties ? p.properties.filters : null;
      } catch (e) { out.error = String(e && e.message); }
      return out;
    }, RG.ANCHOR).catch((e) => ({ filters: null, error: String(e && e.message) }));
    observations.filterLiveState = liveState;
    observations.filterClicks = filterDiagnostics;
    record('P13.9', "the application reports the include as the page's own filter property",
      liveState.filters !== null && liveState.filters !== undefined &&
      J(liveState.filters).toLowerCase().includes(RG.GA.toLowerCase()),
      () => `get_page(...).properties.filters = ${J(liveState.filters)}` +
        (liveState.error ? ` (error: ${liveState.error})` : ''));

    // ---------- P14 : the right sidebar ----------
    say('\nP14 the right sidebar, a named exclusion, measured live');
    phase('ordering', 'open-the-anchor-in-the-right-sidebar');
    await goTo(RG.NA);
    await sleep(2500);
    await parkPointer();
    let opened = { found: false };
    try {
      await page.locator(`#main-content-container a.page-ref:text-is("${RG.ANCHOR}")`)
        .first().click({ modifiers: ['Shift'], timeout: 20000 });
      opened = { found: true };
    } catch (e) {
      opened = { found: false, error: String(e.message).split('\n')[0] };
    }
    await sleep(6000);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        for (const sel of ['#right-sidebar .sidebar-item-list', '#right-sidebar',
                           '.sidebar-item-list']) {
          const sb = document.querySelector(sel);
          if (sb) sb.scrollTop = sb.scrollHeight;
        }
      }).catch(() => null);
      await sleep(1300);
    }
    const sidebar = await page.evaluate(() => ({
      present: !!document.querySelector('#right-sidebar'),
      items: document.querySelectorAll('.sidebar-item').length,
      refs: document.querySelectorAll('.sidebar-item .references.page-linked').length,
      rows: document.querySelectorAll(
        '.sidebar-item .references.page-linked .ls-block[blockid]').length,
      groups: [...document.querySelectorAll(
        '.sidebar-item .references.page-linked .references-blocks-item')]
        .map((it) => {
          const a = it.querySelector('.foldable-title a.page-ref, .foldable-title a.tag');
          return a ? a.getAttribute('data-ref') : null;
        }),
      selects: document.querySelectorAll('.sidebar-item .f28-order-select').length,
      orderAttrs: document.querySelectorAll('.sidebar-item [data-f28-order]').length,
    })).catch(() => null);
    observations.sidebar = sidebar;
    record('P14.1', 'a linked-references list really is rendered in the right sidebar',
      !!sidebar && sidebar.items > 0 && sidebar.rows > 0,
      () => J(sidebar) + ` (shift-click found a link: ${opened.found})`);
    record('P14.2', 'and it carries NO ordering control and NO order at all',
      !!sidebar && sidebar.rows > 0 && sidebar.selects === 0 && sidebar.orderAttrs === 0,
      () => sidebar ? `${sidebar.rows} sidebar row(s), ${sidebar.selects} select(s), ` +
        `${sidebar.orderAttrs} element(s) carrying an order` : 'no reading');
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- P15 : the graph, after the application has closed ----------
  say('\nP15 the graph, after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  const filterWrite = cmp.content.filter((c) =>
    c.file === filterAccounting.anchorFile && c.change === 'modified');
  const otherContent = cmp.content.filter((c) => !filterWrite.includes(c));
  record('P15.1', 'nothing changed except the one filter write this run asked OG for',
    otherContent.length === 0 && filterWrite.length === 1,
    otherContent.length
      ? J(otherContent.map((c) => `${c.change} ${c.file}`))
      : `${filterWrite.length} filter write(s) to ${filterAccounting.anchorFile} ` +
        `(recorded under P15.3); 0 other content changes across ${cmp.afterCount} files`);
  record('P15.2', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ` +
        cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')
      : 'none');
  const anchorAfter = RG.readPage(GRAPH, filterAccounting.anchorFile);
  const beforeLines = (filterAccounting.anchorBefore || '').split('\n');
  const afterLines = anchorAfter.split('\n');
  const added = afterLines.filter((l) => !beforeLines.includes(l));
  const gone = beforeLines.filter((l) => !afterLines.includes(l));
  const filterLine = added.find((l) => l.includes('filters::')) || null;
  observations.filterWrite = { added, gone, filterLine };
  record('P15.3', 'the filter write is exactly `filters::` line(s) in the anchor page, and nothing ' +
    'the page said before was lost',
    filterWrite.length === 1 && added.length >= 1 &&
    added.every((l) => l.includes('filters::')) &&
    gone.every((l) => afterLines.some((a) => a.trim() === l.trim())),
    () => `added ${J(added)}, removed ${J(gone)}`);

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  const split = NOISE.partition(cls.unexpected, errors.entries(), errorEvidence);
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(split.noise, 3)) say(`          pre-existing: ${line}`);
  for (const r of split.refused.slice(0, 5)) {
    say(`          REFUSED BY THE RULE: ${r.refusedBecause}\n            ` +
        `${String(r.text).slice(0, 160)}`);
  }
  for (const line of EC.describe(split.remaining, 5)) say(`          UNEXPECTED: ${line}`);
  observations.errors = {
    entries: errors.entries(),
    phases: errors.phases(),
    windowErrorEvents: errorEvidence,
    expected: cls.expected.map((e) => ({ seq: e.seq, phase: e.phase, reason: e.reason, text: e.text })),
    browserNoise: split.noise.map((e) => ({ seq: e.seq, text: e.text,
                                            pairedWithSeq: e.pairedWithSeq === undefined
                                              ? null : e.pairedWithSeq })),
    refusedByRule: split.refused.map((e) => ({ seq: e.seq, text: e.text,
                                               refusedBecause: e.refusedBecause })),
    unexpected: split.remaining.map((e) => ({ seq: e.seq, phase: e.phase, text: e.text })),
    ruleAccounting: split.evidence,
  };
  const featurePhases = ['ordering', 'filtering'];
  const inFeature = split.remaining.filter((e) => featurePhases.includes(e.phase));
  record('P15.4', 'no window error arrived in any phase that operated this feature',
    inFeature.length === 0,
    `${inFeature.length} in ${J(featurePhases)}; ${split.remaining.length} unexplained in total` +
    (split.remaining.length ? ` (${split.remaining.map((e) => e.phase).join(', ')})` : ''));
  record('P15.5', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${J(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('P15.6', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? J(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-reforder-feature-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-reforder-feature-summary.json'),
    JSON.stringify({ results: results.map((r) => ({ id: r.id, ok: r.ok, title: r.title })),
                     build: observations.build, graph: GRAPH,
                     expected: observations.expected,
                     passed: pass, total: results.length }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
