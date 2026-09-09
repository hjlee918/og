'use strict';
//
// The ONE pre-existing browser condition this feature's scenarios name, driven
// deterministically — and driven ADVERSARIALLY, because the first version of
// this rule passed its own tests while exempting an unrelated rendering failure
// 500 ms after a notice. The supervisor reproduced that; these tests are what
// make the same mistake impossible to reintroduce quietly.
//
// Every test below states which of H1–H7 it is attacking.
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

test('a PAGE ERROR is never exempted, whatever it says (H1)', () => {
  reset();
  const pe = entry('pageerror', NOTICE_NEW, 1000);
  const r = NOISE.partition([pe], [pe], evidence(1));
  assert.strictEqual(r.noise.length, 0);
  assert.strictEqual(r.remaining.length, 1);
});

test('a page error immediately after a notice is never exempted either (H1)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const pe = entry('pageerror', HANDLER, 1002);
  const r = NOISE.partition([n, pe], [n, pe], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.kind), ['console']);
  assert.deepStrictEqual(r.remaining.map((x) => x.kind), ['pageerror']);
});

// --- the pair, when it is genuinely a pair -----------------------------------

test('the handler line IS exempted when every condition holds', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.strictEqual(r.noise.length, 2);
  assert.strictEqual(r.remaining.length, 0);
  assert.strictEqual(r.refused.length, 0);
  const paired = r.noise.find((x) => NOISE.isHandlerLine(x));
  assert.strictEqual(paired.pairedWithSeq, n.seq);
  assert.strictEqual(paired.pairedGapMs, 2);
  assert.strictEqual(r.evidence.pairsClaimed, 1);
});

// --- H3 : strict adjacency ---------------------------------------------------

test('THE SUPERVISOR CASE: an unrelated failure after a notice is NOT exempted (H3)', () => {
  // Reproduced from the review: a rendering failure 500 ms after a notice.
  // The old rule returned `remaining: []` for it. It must now fail the run.
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const fail = entry('console', RENDER_FAIL, 1500);
  const r = NOISE.partition([n, fail], [n, fail], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [RENDER_FAIL]);
  assert.strictEqual(r.refused.length, 1);
  assert.match(r.refused[0].refusedBecause, /within 250ms/);
});

test('an INTERVENING captured event breaks the pair (H3)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const other = entry('console', 'console: something else entirely', 1001);
  const h = entry('console', HANDLER, 1002);
  const r = NOISE.partition([n, other, h], [n, other, h], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.strictEqual(r.remaining.length, 2);
  assert.match(r.refused[0].refusedBecause, /immediately before it is not the browser notice/);
});

test('a handler line BEFORE the notice is not exempted (H3)', () => {
  reset();
  const h = entry('console', HANDLER, 900);
  const n = entry('console', NOTICE_NEW, 1000);
  const r = NOISE.partition([h, n], [h, n], evidence(1));
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /nothing was captured immediately before it/);
});

test('a handler line with no capture sequence is never exempted (H3)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  delete h.seq;
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /no capture sequence/);
});

// --- H4 : phase ---------------------------------------------------------------

test('a phase mismatch between the notice and the handler line refuses it (H4)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002, { phase: 'disclose', operation: 'press' });
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /different phase/);
});

test('an operation mismatch within one phase refuses it too (H4)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002, { operation: 'a-different-operation' });
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.strictEqual(r.remaining.length, 1);
  assert.match(r.refused[0].refusedBecause, /different phase/);
});

// --- H5 : the window ----------------------------------------------------------

test('a handler line outside the pair window is refused, even when adjacent (H5)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1000 + NOISE.PAIR_WINDOW_MS + 1);
  const r = NOISE.partition([n, h], [n, h], evidence(1));
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /within 250ms/);
});

test('the pair window is tight enough to mean one handler invocation', () => {
  assert.ok(NOISE.PAIR_WINDOW_MS <= 250,
    `${NOISE.PAIR_WINDOW_MS}ms is wide enough for an unrelated failure to land inside`);
});

// --- H6 : one-to-one -----------------------------------------------------------

test('REPEATED handler errors after ONE notice: only the adjacent one can pair (H6)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h1 = entry('console', HANDLER, 1002);
  const h2 = entry('console', HANDLER, 1003);
  const h3 = entry('console', HANDLER, 1004);
  const r = NOISE.partition([n, h1, h2, h3], [n, h1, h2, h3], evidence(1));
  assert.strictEqual(r.noise.length, 2, 'the notice and exactly one handler line');
  assert.strictEqual(r.remaining.length, 2);
  assert.strictEqual(r.refused.length, 2);
  for (const x of r.refused) {
    assert.match(x.refusedBecause, /immediately before it is not the browser notice/);
  }
});

test('two notices and two handler lines pair one-to-one, in order (H6)', () => {
  reset();
  const n1 = entry('console', NOTICE_NEW, 1000);
  const h1 = entry('console', HANDLER, 1001);
  const n2 = entry('console', NOTICE_NEW, 2000);
  const h2 = entry('console', HANDLER, 2001);
  const all = [n1, h1, n2, h2];
  const r = NOISE.partition(all, all, evidence(2));
  assert.strictEqual(r.noise.length, 4);
  assert.strictEqual(r.remaining.length, 0);
  assert.strictEqual(r.evidence.pairsClaimed, 2);
});

// --- H7 : structured evidence ---------------------------------------------------

test('WITHOUT the page ErrorEvent log, no handler line is exempted (H7)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const r = NOISE.partition([n, h], [n, h], null);
  assert.deepStrictEqual(r.noise.map((x) => x.text), [NOTICE_NEW]);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /ErrorEvent log was not collected/);
  assert.strictEqual(r.evidence.collected, false);
  assert.strictEqual(r.evidence.nullPayloadNotices, null);
});

test('an EMPTY page ErrorEvent log exempts no handler line (H7)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const r = NOISE.partition([n, h], [n, h], []);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /recorded 0 null-payload/);
});

test('a ResizeObserver event that CARRIED a thrown value is not the condition (H7)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const thrown = [{ seq: 0, message: 'ResizeObserver loop completed with undelivered notifications.',
                    nullPayload: false, errorName: 'TypeError', filename: '', lineno: 0, at: 1000 }];
  const r = NOISE.partition([n, h], [n, h], thrown);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.match(r.refused[0].refusedBecause, /recorded 0 null-payload/);
});

test('more pairs than recorded browser events cannot all be claimed (H7)', () => {
  reset();
  const n1 = entry('console', NOTICE_NEW, 1000);
  const h1 = entry('console', HANDLER, 1001);
  const n2 = entry('console', NOTICE_NEW, 2000);
  const h2 = entry('console', HANDLER, 2001);
  const all = [n1, h1, n2, h2];
  const r = NOISE.partition(all, all, evidence(1));
  assert.strictEqual(r.evidence.pairsClaimed, 1);
  assert.strictEqual(r.remaining.length, 1);
  assert.match(r.refused[0].refusedBecause, /which 1 pair\(s\) already account for/);
});

test('a null-payload event with a DIFFERENT message does not fund a pair (H7)', () => {
  reset();
  const n = entry('console', NOTICE_NEW, 1000);
  const h = entry('console', HANDLER, 1002);
  const other = [{ seq: 0, message: 'Script error.', nullPayload: true, at: 1000 }];
  const r = NOISE.partition([n, h], [n, h], other);
  assert.deepStrictEqual(r.remaining.map((x) => x.text), [HANDLER]);
  assert.strictEqual(NOISE.nullPayloadNotices(other), 0);
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
  // The reason a sequence exists at all: two console lines from ONE handler
  // invocation routinely carry the same `Date.now()`.
  const rec = REC.createRecorder(() => 1234);
  rec.phase('p', 'op');
  const a = rec.record('console', NOTICE_NEW);
  const b = rec.record('console', HANDLER);
  assert.strictEqual(a.at, b.at);
  assert.strictEqual(b.seq, a.seq + 1);
  const r = NOISE.partition([a, b], [a, b], evidence(1));
  assert.strictEqual(r.noise.length, 2, 'a same-millisecond pair must still pair');
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
