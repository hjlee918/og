'use strict';
//
// The ONE pre-existing browser condition this feature's scenarios name, driven
// deterministically — and driven ADVERSARIALLY, because TWO earlier versions of
// this rule passed their own tests while exempting an unrelated failure:
//
//   * the first paired any `[frontend.handler]` line within one second of any
//     notice, and swallowed a rendering failure 500 ms later;
//   * the second added adjacency, one-to-one pairing and a 250 ms window, and
//     checked the page's ErrorEvent log — but as a global COUNT, so a
//     null-payload event recorded at 1 ms funded an unrelated `Error` at
//     1010 ms. `remaining: []` again.
//
// The rule now exempts ONLY the exact browser notice. Every handler line stays
// unexpected. Both reproductions are tests below, by name, and the tests that
// encoded the withdrawn pairing contract are gone rather than relaxed.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const NOISE = require(path.join(REPO, 'f28-refpath', 'checks', 'browser-noise.js'));
const REC = require(path.join(REPO, 'f28-refpath', 'checks', 'recorder.js'));

const NOTICE_NEW = 'console: ResizeObserver loop completed with undelivered notifications.';
const NOTICE_OLD = 'console: ResizeObserver loop limit exceeded';
const HANDLER = 'console: [frontend.handler] {meta: null, cnt: 2, arr: Array(4)}';
const RENDER_FAIL = 'console: [frontend.handler] Cannot read properties of null (reading "x")';

let seq = 0;
function entry(kind, text, at, extra) {
  return Object.assign({ kind, text, at, seq: seq++, phase: 'read-linked-references',
                         operation: 'open-the-anchor-page' }, extra || {});
}
function reset() { seq = 0; }

/** Structured evidence: n null-payload ResizeObserver events in the page. */
function evidence(n, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ seq: i, message: 'ResizeObserver loop completed with undelivered notifications.',
               nullPayload: true, errorName: null, filename: '', lineno: 0, at: 1000 + i });
  }
  return out.concat(extra || []);
}

// --- the notice itself ------------------------------------------------------

test("Chromium's own notice is exempted, in both of its wordings", () => {
  for (const text of [NOTICE_NEW, NOTICE_OLD]) {
    reset();
    const e = entry('console', text, 1000);
    const r = NOISE.partition([e], [e], evidence(1));
    assert.strictEqual(r.noise.length, 1, text);
    assert.strictEqual(r.remaining.length, 0);
  }
});

test('the notice is exempted even with NO structured evidence — it names itself', () => {
  reset();
  const e = entry('console', NOTICE_NEW, 1000);
  const r = NOISE.partition([e], [e], null);
  assert.strictEqual(r.noise.length, 1);
  assert.strictEqual(r.remaining.length, 0);
});

test('a line that merely CONTAINS or BEGINS like the notice is not matched', () => {
  for (const text of ['console: something went wrong: ResizeObserver loop limit exceeded',
                      'console: ResizeObserver loop limit exceeded while rendering the panel',
                      'console: ResizeObserver loop something else']) {
    reset();
    const e = entry('console', text, 1000);
    const r = NOISE.partition([e], [e], evidence(1));
    assert.strictEqual(r.noise.length, 0, text);
    assert.deepStrictEqual(r.remaining.map((x) => x.text), [text]);
  }
});

test('a PAGE ERROR is never exempted, whatever it says — a page error is never exempted', () => {
  reset();
  const pe = entry('pageerror', NOTICE_NEW, 1000);
  const r = NOISE.partition([pe], [pe], evidence(1));
  assert.strictEqual(r.noise.length, 0);
  assert.strictEqual(r.remaining.length, 1);
});

test('a page error immediately after a notice is never exempted either — a page error is never exempted', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const pe = entry('pageerror', HANDLER, 1002);
  const r = NOISE.partition([n, pe], [n, pe], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.kind), ['console']);
  assert.deepStrictEqual(r.remaining.map((x) => x.kind), ['pageerror']);
});

// --- no handler line is ever exempted ----------------------------------------

test("THE SUPERVISOR'S SECOND REPRODUCTION: an Error payload beside a notice is NOT exempted", () => {
  // Exactly the case from the correction review, verbatim: the exact notice at
  // 1000 ms, an unrelated rendering failure adjacent at 1010 ms in the same
  // phase and operation, and one null-payload ResizeObserver ErrorEvent
  // recorded at 1 ms. The previous rule returned `remaining: []` — a historical
  // event funding an unrelated error. A count is not same-event provenance.
  reset();
  const notice = entry('console', NOTICE_NEW, 1000);
  const unrelated = entry(
    'console', 'console: [frontend.handler] Error: unrelated rendering failure', 1010);
  const ev = [{ seq: 0, message: 'ResizeObserver loop completed with undelivered notifications.',
                nullPayload: true, errorName: null, filename: '', lineno: 0, at: 1 }];
  const r = NOISE.partition([notice, unrelated], [notice, unrelated], ev);

  assert.deepStrictEqual(r.remaining.map((x) => x.text), [unrelated.text],
    'the unrelated failure must fail the run');
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW],
    'only the browser notice is exempted');
  assert.strictEqual(r.refused.length, 1);
  assert.match(r.refused[0].refusedBecause, /never exempted/);
  assert.strictEqual(r.evidence.pairsClaimed, 0);
});

test("OG's own companion line is NOT exempted either, however well it fits", () => {
  // Adjacent, same phase, 2 ms apart, with a matching browser event recorded —
  // every condition the withdrawn pairing rule asked for. It still fails,
  // because provenance was never established, only inferred.
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.strictEqual(r.refused.length, 1);
});

test('no arrangement of notices and handler lines exempts a handler line', () => {
  const shapes = [
    [[NOTICE_NEW, 1000], [HANDLER, 1000]],            // same millisecond
    [[NOTICE_NEW, 1000], [HANDLER, 1001]],            // adjacent
    [[NOTICE_OLD, 1000], [HANDLER, 1001]],            // the older wording
    [[HANDLER, 1000], [NOTICE_NEW, 1001]],            // reversed
    [[NOTICE_NEW, 1000], [HANDLER, 1001], [HANDLER, 1002]],  // repeated
    [[NOTICE_NEW, 1000], [NOTICE_NEW, 1001], [HANDLER, 1002]], // two notices
  ];
  for (const shape of shapes) {
    reset();
    const rows = shape.map(([t, at]) => entry('console', t, at));
    const r = NOISE.partition(rows, rows, evidence(5));
    const exemptedHandler = r.noise.filter((x) => NOISE.isHandlerLine(x));
    assert.strictEqual(exemptedHandler.length, 0, JSON.stringify(shape));
    assert.strictEqual(r.evidence.pairsClaimed, 0);
  }
});

test('the browser ErrorEvent log is CONTEXT and funds nothing', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1001);
  // Ten recorded browser events cannot buy a single exemption.
  const r = NOISE.partition([n, h], [n, h], evidence(10));
  assert.strictEqual(r.evidence.nullPayloadNotices, 10, 'still reported, for a reader');
  assert.strictEqual(r.evidence.pairsClaimed, 0, 'and still used by no decision');
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
});

test('the notice is exempted with the log absent, present or empty — it names itself', () => {
  for (const ev of [null, undefined, [], evidence(1)]) {
    reset();
    const n = entry('console', NOTICE_NEW, 1000);
    const r = NOISE.partition([n], [n], ev);
    assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
    assert.strictEqual(r.remaining.length, 0);
  }
});

test('the withdrawn pairing surface is gone, not merely unused', () => {
  // A pairing knob left exported invites the next author to reconnect it.
  assert.strictEqual(NOISE.PAIR_WINDOW_MS, undefined,
    'the time window must not survive as a tunable');
  const src = require('fs').readFileSync(
    path.join(REPO, 'f28-refpath', 'checks', 'browser-noise.js'), 'utf8');
  assert.ok(!/pairedWithSeq|pairedNotice|pairedGapMs/.test(src),
    'no pairing bookkeeping may remain in the rule');
});

// --- shape and safety ------------------------------------------------------------

test('an ordinary application error is never exempted, even beside a notice', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const real = entry('console', 'console: TypeError: x is not a function', 1001);
  const r = NOISE.partition([n, real], [n, real], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [real.text]);
});

test('nothing at all is a clean partition rather than an error', () => {
  const r = NOISE.partition([], [], null);
  assert.deepStrictEqual(r.noise, []);
  assert.deepStrictEqual(r.remaining, []);
  assert.deepStrictEqual(r.refused, []);
  assert.deepStrictEqual(NOISE.partition([], null, null).remaining, []);
  assert.deepStrictEqual(NOISE.partition(null, null, null).remaining, []);
});

test('the rule can only ever move rows OUT of unexpected, never into it', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const other = entry('console', 'console: unrelated', 1001);
  // `other` is the only row the classifier called unexpected.
  const r = NOISE.partition([other], [n, other], evidence(1));
  assert.deepStrictEqual(r.noise, []);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), ['console: unrelated']);
});

test('every refused row also stays in `remaining`, so a run still fails on it', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const fail = entry('console', RENDER_FAIL, 1500);
  const r = NOISE.partition([n, fail], [n, fail], evidence(1));
  for (const x of r.refused) {
    assert.ok(r.remaining.some((y) => y.text === x.text && y.seq === x.seq),
      'a refused row that is not in `remaining` would be silently dropped');
  }
});

test('the input rows are not mutated; refusal and pairing are recorded on copies', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const before = JSON.stringify([n, h]);
  NOISE.partition([n, h], [n, h], evidence(1));
  assert.strictEqual(JSON.stringify([n, h]), before,
    'raw captured evidence must survive classification unchanged');
});

// --- the recorder the rule depends on --------------------------------------------

test('the recorder stamps a capture sequence on every entry, in order', () => {
  const rec = REC.createRecorder();
  rec.phase('p', 'op');
  const a = rec.record('console', 'one');
  const b = rec.record('pageerror', 'two');
  assert.strictEqual(a.seq, 0);
  assert.strictEqual(b.seq, 1);
  assert.deepStrictEqual(rec.entries().map((e) => e.seq), [0, 1]);
  assert.strictEqual(rec.nextSeq(), 2);
});

test('the sequence orders entries that share a millisecond', () => {
  // Two console lines from ONE handler invocation routinely carry the same
  // `Date.now()`. The sequence is what lets RAW EVIDENCE be read in the order
  // it arrived. It is no longer input to any exemption decision — the rule
  // exempts only the notice — and this test asserts the ordering, not a pair.
  const rec = REC.createRecorder(() => 1234);
  rec.phase('p', 'op');
  const a = rec.record('console', NOTICE_NEW);
  const b = rec.record('console', HANDLER);
  assert.strictEqual(a.at, b.at, 'the timestamps really do collide');
  assert.strictEqual(b.seq, a.seq + 1, 'the sequence still separates them');

  const r = NOISE.partition([a, b], [a, b], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER],
    'sharing a millisecond with the notice buys the handler line nothing');
});

test('the page instrumentation records a payload rather than inferring one', () => {
  // Read out of the script rather than described: `nullPayload` must come from
  // the event, and the script must never swallow or cancel anything.
  assert.match(NOISE.INIT_SCRIPT, /nullPayload: !\(ev && ev\.error\)/);
  assert.match(NOISE.INIT_SCRIPT, /addEventListener\('error'/);
  assert.ok(!/preventDefault|stopPropagation|return true/.test(NOISE.INIT_SCRIPT),
    'the instrument must not suppress any error it observes');
  assert.ok(!/window\.onerror\s*=/.test(NOISE.INIT_SCRIPT),
    "the instrument must not replace OG's own handler");
});
