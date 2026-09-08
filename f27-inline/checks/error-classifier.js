'use strict';
//
// What the window said, and whether this run was entitled to it.
//
// WHY THIS EXISTS. The outgoing batch's harness classified a captured window
// error as expected when it either named the deliberate outside probe path OR
// came from `frontend.handler.web.nfs` and did not contain the test graph path.
// The supervisor's acceptance record (F27_OUTGOING_SUPERVISOR_ACCEPTANCE.md)
// named that second clause as too broad to support any general claim of
// absence: a filesystem error arriving at ANY moment of the run, for ANY
// reason, was exempted merely for not mentioning one path. Acceptance rested on
// the specific functional assertions instead.
//
// The rule here is correlation with the deliberate negative test, not a
// substring:
//
//   * every captured error records the PHASE it arrived in, the OPERATION that
//     phase was performing, and when — structured, not a bare string;
//   * an error is expected ONLY when it arrived in the deliberate negative-test
//     phase, while that phase's own operation was in flight (plus a bounded
//     grace for a handler log that lags the call that caused it), AND its shape
//     is one of the two that refusal produces;
//   * an NFS error is never exempt for omitting the graph path. The same text
//     arriving in a feature phase is unexpected and fails;
//   * an error naming this run's own graph is unexpected wherever it arrives,
//     including inside the negative phase, because the deliberate operation is
//     about a path OUTSIDE the permitted root;
//   * expected refusals stay visible: they are counted, named and printed,
//     never folded into a "clean" claim.
//
// Pure and dependency-free, so `f27-inline/tests/error-classifier.test.js` can
// drive every rule deterministically — including the regression the acceptance
// record asks for: an unrelated, path-free NFS error must FAIL.
//

// The one phase in which a refusal is deliberate, and the one operation in it
// that is allowed to produce one. Anything else, anywhere else, is a failure.
const NEGATIVE_PHASE = 'negative-dialog';
const NEGATIVE_OPERATION = 'choose-folder-outside-permitted-root';

// A handler log can be written slightly after the call that provoked it
// returns. Bounded, and small enough that a later phase cannot borrow it: the
// harness closes the negative phase before it opens the good one, and the good
// one takes far longer than this to reach any feature.
const CORRELATION_GRACE_MS = 15000;

// The shapes that unmount a React subtree, whatever else they are classified
// as. Kept as a SECOND, narrower report beside the primary one — the primary
// gate is "no unexpected error at all", so a render failure fails the run
// whether or not this list happens to name its wording.
const RENDER_FAILURE = new RegExp([
  'No matching clause',
  'Cannot read (?:property|properties)',
  'Cannot destructure',
  'is not a function',
  'is not iterable',
  'undefined is not an object',
  'null is not an object',
  'Maximum update depth',
  'Minified React error',
  'Rendered fewer hooks',
  'Invalid hook call',
  'Objects are not valid as a React child',
  'Too much recursion',
  'Maximum call stack size exceeded',
].join('|'));

const FILESYSTEM_HANDLER = /frontend\.handler\.web\.nfs/;

/**
 * Collects window errors together with the phase they arrived in.
 *
 * The harness calls `phase(name, operation)` as it moves through the run and
 * `record(kind, text)` from the page's own error listeners. Nothing here
 * decides anything — classification is a separate, pure step over the result.
 */
function createRecorder(now = () => Date.now()) {
  const entries = [];
  const phases = [];
  let current = null;

  function phase(name, operation) {
    if (current) current.endedAt = now();
    current = { name, operation: operation || null, startedAt: now(), endedAt: null };
    phases.push(current);
    return current;
  }

  function endPhase() {
    if (current) { current.endedAt = now(); current = null; }
  }

  function record(kind, text) {
    const at = now();
    entries.push({
      kind,
      text: String(text == null ? '' : text),
      at,
      phase: current ? current.name : 'before-any-phase',
      operation: current ? current.operation : null,
      // Captured as it is recorded rather than derived later, so a phase that
      // has already ended cannot retroactively claim an error.
      phaseStartedAt: current ? current.startedAt : null,
    });
    return entries[entries.length - 1];
  }

  return {
    phase,
    endPhase,
    record,
    entries: () => entries.slice(),
    phases: () => phases.map((p) => Object.assign({}, p)),
    current: () => (current ? Object.assign({}, current) : null),
  };
}

/**
 * Whether ONE captured error was something this run was entitled to.
 *
 * @param {object} entry    from `createRecorder().record`
 * @param {object} ctx      { outsidePath, graphPath, phases, graceMs }
 * @returns {{expected:boolean, reason:string}}
 */
function classify(entry, ctx) {
  const text = String((entry && entry.text) || '');
  const graceMs = typeof ctx.graceMs === 'number' ? ctx.graceMs : CORRELATION_GRACE_MS;

  // An error naming this run's own graph is never expected. It is checked
  // FIRST so it cannot be excused by the phase it happens to land in.
  if (ctx.graphPath && text.includes(ctx.graphPath)) {
    return { expected: false, reason: "names this run's own graph" };
  }

  if (entry.phase !== NEGATIVE_PHASE) {
    return {
      expected: false,
      reason: `arrived in phase "${entry.phase}", not the deliberate negative test`,
    };
  }
  if (entry.operation !== NEGATIVE_OPERATION) {
    return {
      expected: false,
      reason: `arrived during operation "${entry.operation}", not the deliberate refusal`,
    };
  }

  // Bounded in time as well as by phase: the operation must have been in
  // flight, or have finished within the grace a lagging handler log needs.
  const phaseRecord = (ctx.phases || []).find(
    (p) => p.name === NEGATIVE_PHASE && p.startedAt === entry.phaseStartedAt);
  if (phaseRecord && phaseRecord.endedAt !== null &&
      entry.at > phaseRecord.endedAt + graceMs) {
    return {
      expected: false,
      reason: `arrived ${entry.at - phaseRecord.endedAt}ms after the deliberate ` +
              `operation ended, beyond the ${graceMs}ms correlation window`,
    };
  }

  if (ctx.outsidePath && text.includes(ctx.outsidePath)) {
    return { expected: true, reason: 'the refusal of the deliberate outside path, by name' };
  }
  if (FILESYSTEM_HANDLER.test(text)) {
    return {
      expected: true,
      reason: 'the filesystem handler call the deliberate refusal provokes, ' +
              'correlated to that operation rather than exempted by substring',
    };
  }
  return {
    expected: false,
    reason: 'arrived in the negative-test phase but is neither the refusal nor ' +
            'the handler call it provokes',
  };
}

/**
 * Classify every captured error.
 *
 * @returns {{expected:Array, unexpected:Array, renderFailures:Array, byPhase:object}}
 */
function summarise(entries, ctx) {
  const expected = [];
  const unexpected = [];
  const byPhase = {};
  for (const e of entries) {
    const verdict = classify(e, ctx);
    const row = Object.assign({}, e, verdict);
    (verdict.expected ? expected : unexpected).push(row);
    byPhase[e.phase] = (byPhase[e.phase] || 0) + 1;
  }
  return {
    expected,
    unexpected,
    renderFailures: entries.filter((e) => RENDER_FAILURE.test(String(e.text || ''))),
    byPhase,
  };
}

/** One line per error, for the run's own output. Expected ones stay visible. */
function describe(rows, max = 3) {
  return rows.slice(0, max)
    .map((r) => `[${r.phase}/${r.operation || '-'}] ${r.reason}: ` +
                `${String(r.text).replace(/\s+/g, ' ').slice(0, 220)}`);
}

module.exports = {
  NEGATIVE_PHASE,
  NEGATIVE_OPERATION,
  CORRELATION_GRACE_MS,
  RENDER_FAILURE,
  FILESYSTEM_HANDLER,
  createRecorder,
  classify,
  summarise,
  describe,
};
