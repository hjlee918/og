#!/usr/bin/env node
'use strict';
//
// F28 SOURCE-PAGE GROUP ORDERING — what OG already does, before anything is written.
//
//   node f28-refpath/checks/reforder-baseline-checks.js
//
// NARROW ON PURPOSE. This is not the baseline process the earlier F28 slices
// ran, and it does not repeat it. It answers exactly the two questions the
// supervisor's next-batch instruction asks first:
//
//   1. in what order does OG draw the SOURCE-PAGE GROUPS of a page's linked
//      references, and
//   2. does OG already offer the reader a way to choose that order?
//
// It implements nothing, and it REFUSES to run against a build whose renderer
// carries `frontend.util.f28_reforder` — a measurement of "what OG does" taken
// inside the feature would be worthless.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own fresh synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal
// graph is opened, read or enumerated, no earlier run's folder is touched, and
// the installed application is never launched. The loaded graph path is
// asserted BEFORE anything is read. This run writes nothing to the graph and
// proves it by comparing every file's hash after the application has closed.
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

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 group ordering: what OG already does, and what it does not offer ===\n');

  // ---------- B0 : this build must NOT contain the feature ----------
  say('B0  preconditions');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('B0.1', 'a packaged build is present and passes its identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  observations.build = {
    app: built.appName,
    branch: v.manifest.builtFrom.branch,
    commit: v.manifest.builtFrom.commit,
    dirty: v.manifest.builtFrom.dirty,
    renderer: v.manifest.builtFrom.rendererRevision,
    buildId: v.manifest.pilotBuildId,
  };
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  const carries = names.some((n) => n.startsWith('frontend.util.f28_reforder'));
  record('B0.2', 'and this build does NOT carry the ordering feature, so what it draws is OG\'s own',
    carries === false,
    `f28_reforder ${carries ? 'PRESENT — this is not a baseline' : 'absent'}; ` +
    `renderer ${v.manifest.builtFrom.rendererRevision}`);
  if (carries) throw new Error('this build contains the feature; it cannot establish the baseline');

  // ---------- B1 : a fresh graph ----------
  say('\nB1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'baseline' });
  const GRAPH = B.assertInsideAllowedRoot('reforder graph', g.graph);
  record('B1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal}); decomposed file name kept as ` +
    `${g.normalizationOnDisk}`);
  observations.fixture = { graph: GRAPH, normalizationOnDisk: g.normalizationOnDisk,
                           onDisk: g.onDisk, journalFile: g.journalFile };
  const before = GH.snapshot(GRAPH);
  record('B1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 1, `${Object.keys(before).length} files`);
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-reforder-inert-probe');
  record('B1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- B2/B3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'B',
  });
  const { page, goTo } = session;
  ownedTree = session.ownedTree;

  try {
    const settle = RD.makeSettle(page, session, say);

    phase('baseline-order', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
    await settle('on the anchor page');
    const r = await RD.read(page);
    observations.baseline = r.present ? RD.lean(r) : r;

    // ---------- B4 : the list itself ----------
    say('\nB4  the list OG draws');
    record('B4.1', 'the linked-references section rendered', r.present === true,
      r.present ? r.heading : `not present: ${r.error}`);
    if (!r.present) throw new Error('no linked-references section; not proceeding');

    record('B4.2', 'every mention is listed, grouped by source page',
      r.heading.includes(String(RG.REFERENCING.length)) && r.groups.length >= 8,
      () => `"${r.heading}" for ${RG.REFERENCING.length} referencing block(s); ` +
        `${r.groups.length} source-page group(s), ${r.rows.length} row(s) drawn`);

    const drawn = r.groups.map((x) => x.ref);
    observations.drawnOrder = drawn;
    observations.drawnTitles = r.groups.map((x) => x.title);
    record('B4.3', 'the order the groups are drawn in, recorded', true,
      () => JSON.stringify(drawn));

    // ---------- B5 : OG offers no way to choose that order ----------
    say('\nB5  what OG offers the reader for choosing it');
    record('B5.1', 'the section contains no ordering control of any kind',
      r.orderControls === 0 && r.selects === 0,
      () => `${r.selects} <select>, ${r.orderControls} element(s) carrying an ordering ` +
        `attribute, ${r.sortWordControls} control(s) whose label mentions sort/order/정렬/순서`);
    record('B5.2', 'and everything in the section a keyboard can stop on is OG\'s own',
      r.focusable.every((f) => !/order|sort|정렬|순서/i.test(
        `${f.label || ''} ${f.text || ''} ${f.cls || ''}`)),
      () => `${r.focusable.length} focusable element(s): ` +
        JSON.stringify([...new Set(r.focusable.map((f) => f.kind))]));

    // ---------- B6 : and the order it draws is not a title order ----------
    say('\nB6  the gap: the drawn order is neither title order');
    const live = r.groups.map((x) => ({ ref: x.ref, title: x.title }));
    const asc = RG.orderTitles(live, 'title-asc').map((x) => x.ref);
    const desc = RG.orderTitles(live, 'title-desc').map((x) => x.ref);
    observations.titleAscending = asc;
    observations.titleDescending = desc;
    record('B6.1', 'OG does not draw the groups in source-page title order, either way',
      JSON.stringify(drawn) !== JSON.stringify(asc) &&
      JSON.stringify(drawn) !== JSON.stringify(desc),
      () => `drawn      ${JSON.stringify(drawn)}\n          ascending  ${JSON.stringify(asc)}` +
        `\n          descending ${JSON.stringify(desc)}`);
    // OG's one ordering rule, visible: `sort-by (comp :block/journal-day first) >`
    // can only see a journal, and puts it first.
    const known = new Set(Object.values(RG.GROUP_IDS));
    const journalRef = drawn.find((d) => !known.has(d));
    record('B6.2', "OG's own rule is visible: the journal group is drawn first",
      journalRef !== undefined && drawn[0] === journalRef,
      () => `first group ${JSON.stringify(drawn[0])}; ` +
        `journal group ${JSON.stringify(journalRef || null)} ` +
        `(:block/journal-day is the only key OG sorts these by)`);

    // ---------- B7 : reading it twice gives the same answer ----------
    phase('baseline-order', 're-read-after-navigating-away-and-back');
    await goTo(RG.APPLE);
    await sleep(1500);
    await goTo(RG.ANCHOR);
    await settle('after returning to the anchor page');
    const again = await RD.read(page);
    observations.baselineAgain = again.present ? RD.lean(again) : again;
    record('B7.1', 'the order OG draws is stable across a redraw',
      again.present && JSON.stringify(again.groups.map((x) => x.ref)) === JSON.stringify(drawn),
      () => JSON.stringify(again.present ? again.groups.map((x) => x.ref) : again));
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- B8 : the graph, afterwards ----------
  say('\nB8  the graph, after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('B8.1', 'nothing in the graph changed; this run only read',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  record('B8.2', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ` +
        cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')
      : 'none');

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
    browserNoise: split.noise.map((e) => ({ seq: e.seq, text: e.text })),
    refusedByRule: split.refused.map((e) => ({ seq: e.seq, text: e.text,
                                               refusedBecause: e.refusedBecause })),
    unexpected: split.remaining.map((e) => ({ seq: e.seq, phase: e.phase, text: e.text })),
    ruleAccounting: split.evidence,
  };
  record('B8.3', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('B8.4', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-reforder-baseline-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-reforder-baseline-summary.json'),
    JSON.stringify({ results: results.map((r) => ({ id: r.id, ok: r.ok, title: r.title })),
                     build: observations.build, graph: GRAPH,
                     drawnOrder: observations.drawnOrder,
                     titleAscending: observations.titleAscending,
                     passed: pass, total: results.length }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
