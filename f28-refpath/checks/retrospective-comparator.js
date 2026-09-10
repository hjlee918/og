#!/usr/bin/env node
'use strict';
//
// RETROSPECTIVE RE-EVALUATION — the corrected identity-scoped comparator run
// over the RETAINED observations of the accepted combined run
// (evidence/f28-combined-workflow-1789040094173.json, run 5, 87/87).
//
// This is ANALYSIS OF PRESERVED EVIDENCE, not a new run — the supervisor
// review's instruction was to re-evaluate retained ordered observations
// first and to say plainly what is retrospective and what is fresh. Nothing
// here launches an application, writes a graph, or changes the run-5
// evidence file; the result is written to its own clearly-labelled JSON.
//
// What the retained observations can and cannot re-evaluate:
//
//   * RD.lean DROPPED the section-wide `rows` list (it keeps only rowCount),
//     so the parent-index → parent-BLOCK-id mapping the comparator needs is
//     not stored. It is reconstructed here as the concatenation of the
//     groups' rowTrees in group order — validated against the run's own
//     recorded rowCount for every reading used.
//   * The reading C5.14 actually compared (taken at the return of journey 1)
//     is NOT retained: the observation slot `afterReturn` was overwritten
//     later by journey 4's post-filter return. The readings behind C6.13
//     (finalRead) and C7.4 (koRead) were never stored at all.
//   * What IS retained and comparable: the first reading (`original`), the
//     post-exclude-filter reading (`filterExclude`), the alias page's
//     reading, and the post-filter return (`afterReturn`). Two meaningful
//     cross-view pairs exist among them — the comparator is run on both:
//
//       original vs afterReturn   — pre-filter vs post-filter return: the
//                                   ONLY difference must be the group the
//                                   run's own exclude filter removed — a real
//                                   membership change the comparator must
//                                   DETECT, with everything else (including
//                                   within-container order, across a page
//                                   re-entry and a re-render) held stable;
//       filterExclude vs afterReturn — two post-filter readings across the
//                                   alias-page visit and return: 0
//                                   differences expected — the tolerance
//                                   model (ignore whole-container order,
//                                   keep within-container order) holding on
//                                   real re-rendered data.
//
// The exact C5.14/C6.13/C7.4 pairs need a fresh guarded packaged check; this
// analysis is what the retained evidence CAN say. The combined scenario now
// retains its comparator reductions (observations.insideScopes), so a future
// review will not need this reconstruction.
//
const fs = require('fs');
const path = require('path');

const FEATURE_DIR = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
const RUN5 = path.join(EVIDENCE, 'f28-combined-workflow-1789040094173.json');
const IC = require('./inside-containers.js');

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }

const run5 = JSON.parse(fs.readFileSync(RUN5, 'utf8'));
const ob = run5.observations;

// RD.lean dropped `rows`; the section-wide occurrence list is the groups'
// rowTrees concatenated in group order — the document order RD.read read.
// Validated against the run's own recorded rowCount before it is trusted.
function restore(r, label) {
  const flat = r.groups.flatMap((g) => g.rowTree).map((x, i) => ({ i, id: x.id }));
  if (flat.length !== r.rowCount) {
    throw new Error(`${label}: reconstructed ${flat.length} rows, the run recorded ` +
      `rowCount ${r.rowCount} — the reconstruction is invalid and the analysis stops`);
  }
  return { ...r, rows: flat };
}

say('retrospective re-evaluation — corrected identity-scoped comparator');
say(`  source evidence: ${path.basename(RUN5)} (preserved, untouched)`);
say(`  combined run: ${run5.results.filter((x) => x.ok).length}/${run5.results.length} checks`);
say('');

const pairs = [
  ['original', 'afterReturn',
    'pre-filter vs the post-filter return — the only difference must be the ' +
    'group the run\'s own exclude filter removed (a real membership change, ' +
    'to be DETECTED), everything else stable across the re-entry'],
  ['filterExclude', 'afterReturn',
    'two post-filter readings across the alias-page visit and return — ' +
    'expected 0 differences: within-container order and duplicate ' +
    'occurrences stable across real re-renders'],
];

const out = {
  kind: 'retrospective-analysis',
  note: 'the corrected comparator applied to the retained observations of the ' +
    'accepted run-5 evidence; no application was launched and no graph was ' +
    'written. The exact C5.14/C6.13/C7.4 pairs are NOT recoverable from this ' +
    'evidence (lean dropped rows; the C5.14 reading was overwritten by the ' +
    'post-filter return; finalRead and koRead were never retained) — they ' +
    'required a fresh targeted packaged check, reported separately.',
  source: 'evidence/f28-combined-workflow-1789040094173.json',
  sourceSummary: {
    passed: run5.results.filter((x) => x.ok).length,
    total: run5.results.length,
    graph: run5.graph,
  },
  reconstruction: 'rows = groups.flatMap(rowTree) in group order, validated by rowCount',
  comparisons: [],
};

let failed = 0;
for (const [x, y, expectation] of pairs) {
  const a = IC.insideSetOf(restore(ob[x], x));
  const b = IC.insideSetOf(restore(ob[y], y));
  const diffs = IC.insideCompare(a, b);
  const entry = { pair: `${x} vs ${y}`, expectation, differences: diffs };
  out.comparisons.push(entry);
  say(`  ${x} vs ${y}`);
  say(`    expected: ${expectation}`);
  if (diffs.length === 0) say('    result: AGREES (0 differences)');
  else for (const d of diffs) say(`    result: ${d}`);
  say('');
  // The analysis itself is only a failure if the comparator reports something
  // OUTSIDE the documented expectation — recorded, not silently accepted.
  if (x === 'filterExclude' && diffs.length !== 0) failed++;
  if (x === 'original' &&
      !(diffs.length === 1 && /missing from the second reading/.test(diffs[0]))) failed++;
}

const dest = path.join(EVIDENCE, `f28-comparator-retrospective-${Date.now()}.json`);
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
say(`  written: ${dest}`);
if (failed) { say('  UNEXPECTED DIFFERENCES — see above'); process.exitCode = 1; }
else say('  the retained evidence agrees with the corrected comparator everywhere ' +
  'it can be asked');