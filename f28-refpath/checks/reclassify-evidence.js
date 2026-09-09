#!/usr/bin/env node
'use strict';
//
// Re-read RETAINED evidence under the corrected error rule.
//
//   node f28-refpath/checks/reclassify-evidence.js
//
// The supervisor review of `0d5f45555` required that existing evidence be
// reclassified honestly rather than deleted or quietly superseded. This does
// exactly that, and nothing else: it opens each retained evidence file
// READ-ONLY, applies `browser-noise.partition` as it now stands, and writes a
// SEPARATE reclassification record. No retained file is modified, renamed or
// removed.
//
// TWO THINGS IT CANNOT DO, AND SAYS SO.
//
//   * The retained entries carry no capture SEQUENCE — the recorder that stamps
//     one did not exist when they were written. Arrival order is recovered from
//     the array order, which is the order `createRecorder` pushed them in, and
//     every conclusion below is labelled as resting on that.
//
//   * The retained runs collected no window ErrorEvent log, because the
//     instrumentation did not exist either. H7 therefore cannot be satisfied by
//     ANY retained run, so no `[frontend.handler]` line in retained evidence can
//     be exempted. Where an old run exempted one, that row becomes UNRESOLVED —
//     not "now a failure", because the old rule's verdict was made on evidence
//     this rule cannot check, and not "still fine", because it cannot be
//     checked. Unresolved means the narrow scenario has to be run again.
//
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
const NOISE = require('./browser-noise.js');

/** Retained entries, in the order they were pushed, with a DERIVED sequence. */
function withDerivedSeq(entries) {
  return (entries || []).map((e, i) => Object.assign({}, e, { seq: i, seqDerived: true }));
}

function reclassifyFile(file) {
  const full = path.join(EVIDENCE, file);
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  const errs = (j.observations && j.observations.errors) || null;
  if (!errs || !Array.isArray(errs.entries)) {
    return { file, status: 'no-error-record',
             note: 'this run recorded no error block, so there is nothing to reclassify' };
  }

  const entries = withDerivedSeq(errs.entries);
  const oldNoise = (errs.browserNoise || []).map((x) => (typeof x === 'string' ? x : x.text));
  const oldUnexpected = (errs.unexpected || []).map((x) => (typeof x === 'string' ? x : x.text));

  // Everything the OLD run treated as not-expected: what it exempted plus what
  // it left over. That is the set this rule is asked to judge again.
  const reconsider = entries.filter((e) => oldNoise.includes(e.text) ||
                                           oldUnexpected.includes(e.text));

  // Retained runs have no window ErrorEvent log. Passing `null` is the truth,
  // and it is what makes H7 refuse every handler line below.
  const evidence = Array.isArray(errs.windowErrorEvents) ? errs.windowErrorEvents : null;
  const r = NOISE.partition(reconsider, entries, evidence);

  const nowExempt = r.noise.map((e) => e.text);
  const nowRefused = r.refused.map((e) => ({ text: e.text, because: e.refusedBecause }));
  const lostExemption = oldNoise.filter((t) => !nowExempt.includes(t));

  return {
    file,
    status: lostExemption.length ? 'unresolved' : 'unchanged',
    capturedEntries: entries.length,
    sequenceDerivedFromArrayOrder: true,
    windowErrorEventsCollected: Array.isArray(evidence),
    oldRule: { exempted: oldNoise, unexplained: oldUnexpected },
    correctedRule: { exempted: nowExempt, refused: nowRefused,
                     accounting: r.evidence },
    lostExemption,
    note: lostExemption.length
      ? 'The corrected rule cannot exempt ' + lostExemption.length + ' row(s) this run ' +
        'exempted, because the run collected no window ErrorEvent log (H7). This is ' +
        'UNRESOLVED, not refuted: the evidence needed to decide it was never taken. ' +
        'The narrow scenario must be run again under the corrected rule.'
      : 'The corrected rule exempts exactly what this run exempted, so its verdict stands.',
  };
}

function main() {
  if (!fs.existsSync(EVIDENCE)) {
    console.log(`[reclassify] no evidence directory at ${EVIDENCE}`);
    return;
  }
  const files = fs.readdirSync(EVIDENCE)
    .filter((f) => /^f28-refpath-.*\.json$/.test(f) && !/reclassification/.test(f))
    .sort();

  const rows = [];
  for (const f of files) {
    let row;
    try { row = reclassifyFile(f); }
    catch (e) { row = { file: f, status: 'unreadable', note: String(e.message) }; }
    rows.push(row);
    const extra = row.status === 'unresolved'
      ? ` — ${row.lostExemption.length} row(s) can no longer be exempted` : '';
    console.log(`[reclassify] ${row.status.padEnd(16)} ${f}${extra}`);
    for (const x of (row.correctedRule ? row.correctedRule.refused : [])) {
      console.log(`             refused: ${x.because}`);
      console.log(`                      ${String(x.text).slice(0, 120)}`);
    }
  }

  // An UNRESOLVED retained run stays unresolved for ever — the evidence it
  // needed was never taken. What can change is whether a LATER run of the same
  // scenario answered the same question under the corrected rule. Saying so is
  // the difference between an open question and a closed one.
  const kindOf = (f) => (f.includes('baseline') ? 'baseline'
                       : (f.includes('feature') ? 'feature' : 'other'));
  for (const row of rows) {
    if (row.status !== 'unresolved') continue;
    const later = rows.filter((r) => r !== row && kindOf(r.file) === kindOf(row.file) &&
                                     r.status === 'unchanged' &&
                                     r.windowErrorEventsCollected === true &&
                                     r.file > row.file);
    if (later.length) {
      row.supersededBy = later[later.length - 1].file;
      row.note += ' It has since been superseded by ' + row.supersededBy +
                  ', which answered the same question with the evidence the rule requires.';
    } else {
      row.supersededBy = null;
      row.note += ' No later run of this scenario has yet answered it under the corrected rule.';
    }
  }

  const out = path.join(EVIDENCE, 'f28-refpath-reclassification.json');
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    rule: {
      pairWindowMs: NOISE.PAIR_WINDOW_MS,
      noticeWordings: NOISE.NOTICE_BODIES,
      requiresWindowErrorEvidence: true,
      requiresStrictAdjacency: true,
    },
    caveat: 'Retained entries carry no recorded capture sequence; arrival order is ' +
            'recovered from the retained array order. Retained runs collected no window ' +
            'ErrorEvent log, so H7 cannot be satisfied by any of them.',
    rows,
  }, null, 2));
  console.log(`[reclassify] wrote ${out}`);
  console.log('[reclassify] no retained file was modified, renamed or removed');

  const unresolved = rows.filter((r) => r.status === 'unresolved');
  const open = unresolved.filter((r) => !r.supersededBy);
  for (const r of unresolved) {
    console.log(`[reclassify] ${r.file} is unresolved and ` +
                (r.supersededBy ? `superseded by ${r.supersededBy}`
                                : 'NOT yet superseded'));
  }
  if (open.length) {
    console.log(`[reclassify] ${open.length} run(s) still need the narrow scenario ` +
                'run again under the corrected rule');
  } else if (unresolved.length) {
    console.log('[reclassify] every unresolved run has been superseded by a later one');
  }
}

module.exports = { reclassifyFile, withDerivedSeq };

if (require.main === module) main();
