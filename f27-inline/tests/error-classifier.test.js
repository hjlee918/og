'use strict';
//
// The harness's error classification, driven deterministically.
//
// This exists because of a named qualification on the outgoing slice's
// acceptance (F27_OUTGOING_SUPERVISOR_ACCEPTANCE.md): the previous classifier
// exempted EVERY `frontend.handler.web.nfs` error that did not contain the test
// graph path, which is too broad to support any claim that the run was free of
// runtime errors. The rule is now correlation with the deliberate negative test,
// and these tests are what make that falsifiable — including the regression the
// acceptance record asks for by name: an unrelated, path-free NFS error must
// FAIL.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const C = require(path.join(__dirname, '..', 'checks', 'error-classifier.js'));

const OUTSIDE = '/Users/someone/Library/Mobile Documents/f27-inline-inert-outside-probe';
const GRAPH = '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/f27-inline-run-x';

// A path-free filesystem error, of exactly the shape the previous classifier
// exempted globally. Nothing in it names any path at all.
const PATH_FREE_NFS =
  'console: ERROR [frontend.handler.web.nfs] Error: The request is not allowed ' +
  'by the user agent or the platform in the current context.';

function clock() {
  let t = 1000;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function runWithPhases(events) {
  const now = clock();
  const rec = C.createRecorder(now);
  for (const e of events) {
    if (e.phase) rec.phase(e.phase, e.operation);
    if (e.end) rec.endPhase();
    if (e.error) rec.record(e.kind || 'console', e.error);
    if (e.wait) now.advance(e.wait);
  }
  return { rec, ctx: { outsidePath: OUTSIDE, graphPath: GRAPH, phases: rec.phases() } };
}

test('the deliberate outside-path refusal is expected, and stays visible', () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { error: `console: ERROR [electron] refused open-dir for ${OUTSIDE}` },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.unexpected.length, 0);
  assert.strictEqual(s.expected.length, 1);
  assert.match(s.expected[0].reason, /by name/);
  assert.strictEqual(C.describe(s.expected).length, 1,
    'an expected refusal must still be printable, never folded into a clean claim');
});

test('the handler log the deliberate refusal provokes is expected WITHIN that phase', () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { error: PATH_FREE_NFS },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.unexpected.length, 0, JSON.stringify(s.unexpected));
  assert.match(s.expected[0].reason, /correlated to that operation/);
});

// THE REGRESSION THE ACCEPTANCE RECORD ASKS FOR, BY NAME.
test('the SAME path-free NFS error fails when it arrives during feature use', () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { end: true },
    { phase: 'inline-context', operation: 'open-the-inline-panel' },
    { error: PATH_FREE_NFS },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.expected.length, 0);
  assert.strictEqual(s.unexpected.length, 1);
  assert.match(s.unexpected[0].reason, /arrived in phase "inline-context"/);
});

test('an NFS error before any phase fails', () => {
  const { rec, ctx } = runWithPhases([{ error: PATH_FREE_NFS }]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.unexpected.length, 1);
  assert.match(s.unexpected[0].reason, /before-any-phase/);
});

test('an NFS error in the negative PHASE but a different operation fails', () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: 'restoring-the-dialog-stub' },
    { error: PATH_FREE_NFS },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.unexpected.length, 1);
  assert.match(s.unexpected[0].reason, /not the deliberate refusal/);
});

test('an error is not excused for arriving long after the deliberate operation ended', () => {
  const now = clock();
  const rec = C.createRecorder(now);
  const p = rec.phase(C.NEGATIVE_PHASE, C.NEGATIVE_OPERATION);
  // The phase ends, and the entry is recorded while it is still current but
  // far later than the grace allows. (The harness ends a phase before the next
  // begins; this pins the time bound independently of that ordering.)
  now.advance(C.CORRELATION_GRACE_MS + 5000);
  const e = rec.record('console', PATH_FREE_NFS);
  p.endedAt = p.startedAt; // the operation finished immediately
  const s = C.summarise([e], { outsidePath: OUTSIDE, graphPath: GRAPH, phases: rec.phases() });
  assert.strictEqual(s.unexpected.length, 1);
  assert.match(s.unexpected[0].reason, /beyond the .*correlation window/);
});

test("an error naming this run's own graph is never expected, not even in the negative phase", () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { error: `console: ERROR [frontend.handler.web.nfs] failed for ${GRAPH}/pages/x.md` },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.expected.length, 0);
  assert.match(s.unexpected[0].reason, /names this run's own graph/);
});

test('an unrelated error in the negative phase is not expected merely for being there', () => {
  const { rec, ctx } = runWithPhases([
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { kind: 'pageerror', error: 'TypeError: x.y is not a function' },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.expected.length, 0);
  assert.match(s.unexpected[0].reason, /neither the refusal nor/);
});

test('every uncaught page error during feature use is unexpected', () => {
  const { rec, ctx } = runWithPhases([
    { phase: 'inline-context', operation: 'open-the-inline-panel' },
    { kind: 'pageerror', error: 'Error: No matching clause: ready' },
    { kind: 'pageerror', error: 'TypeError: Cannot read properties of undefined' },
    { kind: 'console', error: 'console: ERROR [frontend.handler.web.nfs] whatever' },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.expected.length, 0);
  assert.strictEqual(s.unexpected.length, 3);
});

test('the shapes that unmount a React subtree are reported separately as well', () => {
  const { rec, ctx } = runWithPhases([
    { phase: 'inline-context', operation: 'open-the-inline-panel' },
    { kind: 'pageerror', error: 'Error: No matching clause: ready' },
    { kind: 'pageerror', error: 'Minified React error #310' },
    { kind: 'pageerror', error: 'RangeError: Maximum call stack size exceeded' },
    { kind: 'console', error: 'console: something ordinary and harmless' },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.renderFailures.length, 3);
  assert.strictEqual(s.unexpected.length, 4,
    'the primary gate fails them all regardless of what the render regex names');
});

test('a ClojureScript protocol dispatch on nil is named as a render failure', () => {
  // This shape unmounted every inline reference on screen during the lifecycle
  // batch while the render-failure list did not name it. The primary gate
  // failed the run anyway; the list is widened so the narrower report agrees.
  const { rec, ctx } = runWithPhases([
    { phase: 'lifecycle', operation: 'edit-target-while-open' },
    { kind: 'console', error: 'console: Error: No protocol method IDeref.-deref defined for type null' },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.strictEqual(s.renderFailures.length, 1);
  assert.strictEqual(s.unexpected.length, 1, 'and the primary gate fails it regardless');
});

test('the phase of every entry is recorded, not derived afterwards', () => {
  const { rec } = runWithPhases([
    { phase: 'startup' },
    { error: 'a' },
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { error: 'b' },
    { phase: 'inline-context', operation: 'open-the-inline-panel' },
    { error: 'c' },
  ]);
  assert.deepStrictEqual(rec.entries().map((e) => e.phase),
    ['startup', C.NEGATIVE_PHASE, 'inline-context']);
  assert.deepStrictEqual(rec.entries().map((e) => e.operation),
    [null, C.NEGATIVE_OPERATION, 'open-the-inline-panel']);
});

test('a clean run classifies as clean', () => {
  const { rec, ctx } = runWithPhases([
    { phase: 'startup' },
    { phase: C.NEGATIVE_PHASE, operation: C.NEGATIVE_OPERATION },
    { end: true },
    { phase: 'inline-context', operation: 'open-the-inline-panel' },
  ]);
  const s = C.summarise(rec.entries(), ctx);
  assert.deepStrictEqual(s, { expected: [], unexpected: [], renderFailures: [], byPhase: {} });
});
