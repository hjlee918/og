'use strict';
//
// The ONE pre-existing browser condition this feature's scenarios name, driven
// deterministically.
//
// A rule that only ever runs when a real browser happens to emit a real notice
// is a rule nobody has tested. The scenarios that use it also report both
// numbers — with the rule applied and without it — but the rule's own boundary
// has to be provable here, especially the part that must NOT be excused: OG's
// `[frontend.handler]` line with no notice in front of it.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const NOISE = require(path.join(REPO, 'f28-refpath', 'checks', 'browser-noise.js'));

const entry = (kind, text, at) => ({ kind, text, at, phase: 'read-linked-references' });

const NOTICE_NEW =
  'console: ResizeObserver loop completed with undelivered notifications.';
const NOTICE_OLD = 'console: ResizeObserver loop limit exceeded';
const HANDLER = 'console: [frontend.handler] {meta: null, cnt: 2, arr: Array(4)}';

test("Chromium's own notice is named, in both of its wordings", () => {
  for (const text of [NOTICE_NEW, NOTICE_OLD]) {
    const e = entry('console', text, 1000);
    const { noise, remaining } = NOISE.partition([e], [e]);
    assert.strictEqual(noise.length, 1, text);
    assert.strictEqual(remaining.length, 0);
  }
});

test("OG's own log of that notice is excused ONLY when the notice came first", () => {
  const notice = entry('console', NOTICE_NEW, 1000);
  const handler = entry('console', HANDLER, 1005);
  const { noise, remaining } = NOISE.partition([notice, handler], [notice, handler]);
  assert.strictEqual(noise.length, 2);
  assert.strictEqual(remaining.length, 0);
});

test('the same handler line with NO notice in front of it is NOT excused', () => {
  // This is the regression that makes the rule worth having: a substring
  // exemption would swallow it, and it is exactly the shape a real defect in
  // `frontend.handler` would arrive in.
  const handler = entry('console', HANDLER, 1005);
  const { noise, remaining } = NOISE.partition([handler], [handler]);
  assert.strictEqual(noise.length, 0);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0], handler);
});

test('a handler line too long after the notice is NOT excused', () => {
  const notice = entry('console', NOTICE_NEW, 1000);
  const late = entry('console', HANDLER, 1000 + NOISE.PAIR_WINDOW_MS + 1);
  const { noise, remaining } = NOISE.partition([notice, late], [notice, late]);
  assert.deepStrictEqual(noise, [notice]);
  assert.deepStrictEqual(remaining, [late]);
});

test('a handler line BEFORE the notice is NOT excused', () => {
  const early = entry('console', HANDLER, 900);
  const notice = entry('console', NOTICE_NEW, 1000);
  const { noise, remaining } = NOISE.partition([early, notice], [early, notice]);
  assert.deepStrictEqual(noise, [notice]);
  assert.deepStrictEqual(remaining, [early]);
});

test('a PAGE ERROR is never excused, whatever it says', () => {
  // The notice arrives through `window.onerror` as a console line. An uncaught
  // page error carrying the same words is a different event and fails.
  const pe = entry('pageerror', NOTICE_NEW, 1000);
  const { noise, remaining } = NOISE.partition([pe], [pe]);
  assert.strictEqual(noise.length, 0);
  assert.deepStrictEqual(remaining, [pe]);
});

test('an ordinary application error is never excused, even beside a notice', () => {
  const notice = entry('console', NOTICE_NEW, 1000);
  const real = entry('console', 'console: TypeError: x is not a function', 1002);
  const { noise, remaining } = NOISE.partition([notice, real], [notice, real]);
  assert.deepStrictEqual(noise, [notice]);
  assert.deepStrictEqual(remaining, [real]);
});

test('a notice that only STARTS like the real one is not matched', () => {
  const near = entry('console', 'console: ResizeObserver loop something else', 1000);
  const { noise, remaining } = NOISE.partition([near], [near]);
  assert.strictEqual(noise.length, 0);
  assert.deepStrictEqual(remaining, [near]);
});

test('a line merely CONTAINING the notice is not matched; the rule anchors', () => {
  const wrapped = entry(
    'console', 'console: something went wrong: ResizeObserver loop limit exceeded', 1000);
  const { noise, remaining } = NOISE.partition([wrapped], [wrapped]);
  assert.strictEqual(noise.length, 0);
  assert.deepStrictEqual(remaining, [wrapped]);
});

test('nothing at all is a clean partition rather than an error', () => {
  const { noise, remaining } = NOISE.partition([], []);
  assert.deepStrictEqual(noise, []);
  assert.deepStrictEqual(remaining, []);
  assert.deepStrictEqual(NOISE.partition([], null).remaining, []);
});

test('the correlation window is small enough to be one handler invocation', () => {
  assert.ok(NOISE.PAIR_WINDOW_MS <= 1000,
    `${NOISE.PAIR_WINDOW_MS}ms is long enough for an unrelated error to borrow`);
});

test('the rule cannot excuse an entry the classifier never called unexpected', () => {
  // `partition` only ever splits the list it is given. An expected entry stays
  // where the classifier put it; this rule can only ever move things OUT of
  // "unexpected", never into it.
  const notice = entry('console', NOTICE_NEW, 1000);
  const other = entry('console', 'console: unrelated', 1001);
  const { noise, remaining } = NOISE.partition([other], [notice, other]);
  assert.deepStrictEqual(noise, []);
  assert.deepStrictEqual(remaining, [other]);
});
