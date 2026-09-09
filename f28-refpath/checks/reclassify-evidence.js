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
//   * The corrected rule exempts ONLY the exact browser notice. Every
//     `[frontend.handler]` line is unexpected, in retained evidence and in new
//     runs alike, because same-event provenance is not captured. Where an older
//     run exempted one, that row is now UNEXPLAINED and the run's original
//     "0 unexplained" verdict does not hold.
//
//     Such a row cannot be resolved by running the scenario again — a run that
//     meets the same pre-existing condition reports the same row. It stands as
//     unresolved PRE-EXISTING APPLICATION BEHAVIOUR, reported rather than
//     exempted. An earlier version of this tool told the reader to rerun; that
//     was misleading and is corrected here.
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
    lostExemptionKinds: lostExemption.map(
      (t) => (NOISE.HANDLER_LINE.test(t) ? 'handler-line' : 'other')),
    note: lostExemption.length
      ? 'The corrected rule does not exempt ' + lostExemption.length + ' row(s) this run ' +
        'exempted. Those rows are now UNEXPLAINED, so this run\'s original ' +
        '"0 unexplained" verdict does not hold under the corrected rule.'
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

  // Say plainly what CAN and CANNOT change.
  //
  // The corrected rule exempts only the exact browser notice; OG's companion
  // `[frontend.handler]` line is never exempted, because this harness cannot
  // establish that OG emitted it for the notice rather than for a real failure.
  // So a run that MET that pre-existing condition cannot be resolved by running
  // it again: the row would be unexplained again. Calling for a rerun would be
  // misleading, and an earlier version of this tool did exactly that.
  //
  // What a later run can show is only that the scenario completed WITHOUT
  // meeting the condition. That is a weaker statement and is labelled as one:
  // it does not retroactively explain the earlier row.
  const kindOf = (f) => (f.includes('baseline') ? 'baseline'
                       : (f.includes('feature') ? 'feature' : 'other'));
  for (const row of rows) {
    if (row.status !== 'unresolved') continue;
    const onlyHandlerLines = row.lostExemptionKinds.every((k) => k === 'handler-line');
    row.rerunCanResolve = !onlyHandlerLines;
    const cleanLater = rows.filter((r) => r !== row && kindOf(r.file) === kindOf(row.file) &&
                                          r.status === 'unchanged' && r.file > row.file);
    row.laterCleanRun = cleanLater.length ? cleanLater[cleanLater.length - 1].file : null;
    if (onlyHandlerLines) {
      row.note += " Every lost exemption is OG's own [frontend.handler] line beside the " +
                  'browser notice, which the corrected rule never exempts. NO RERUN CAN ' +
                  'RESOLVE THIS: a run that meets the same pre-existing condition would ' +
                  'report the same unexplained row. It stands as an unresolved ' +
                  'pre-existing condition of the application, not of this feature.';
    } else {
      row.note += ' The narrow scenario should be run again under the corrected rule.';
    }
    if (row.laterCleanRun) {
      row.note += ' A later run of the same scenario, ' + row.laterCleanRun +
                  ', completed without meeting the condition at all — which does not ' +
                  'explain this row, only shows the scenario can pass when the browser ' +
                  'does not signal.';
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
  const rerunnable = unresolved.filter((r) => r.rerunCanResolve);
  for (const r of unresolved) {
    console.log(`[reclassify] ${r.file}: unresolved; ` +
                (r.rerunCanResolve
                  ? 'a rerun could resolve it'
                  : "no rerun can resolve it — it is OG's own handler line beside the " +
                    'browser notice') +
                (r.laterCleanRun ? `; a later clean run exists (${r.laterCleanRun})` : ''));
  }
  if (rerunnable.length) {
    console.log(`[reclassify] ${rerunnable.length} run(s) should be run again`);
  } else if (unresolved.length) {
    console.log('[reclassify] no rerun would change any of these; they stand as ' +
                'unresolved pre-existing application behaviour, reported rather than ' +
                'exempted');
  }
}

module.exports = { reclassifyFile, withDerivedSeq };

if (require.main === module) main();
