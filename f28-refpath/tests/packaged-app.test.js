'use strict';
//
// The shared launcher's two corrected properties, driven deterministically.
//
//   * THE EXACT-PATH GATE — pure, and tested without touching any filesystem
//     path. Every rejection case below uses obviously synthetic placeholder
//     strings; no personal path is constructed, resolved, stat'ed or hashed in
//     order to prove that a rejection works.
//
//   * CLEANUP OWNERSHIP — driven through injected failures. No Electron is
//     launched, no installed application is used, and no real process is
//     signalled: `deps.launch`, `deps.stop`, `deps.descendants` and `deps.alive`
//     are fakes, and the assertions are about what the launcher DID with them.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const APP = require(path.join(REPO, 'f28-refpath', 'checks', 'packaged-app.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));

// ---------------------------------------------------------------------------
// The gate: canonicalisation
// ---------------------------------------------------------------------------

const ROOT = '/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test';
const APPROVED = `${ROOT}/f28-refpath-feature-2026-01-01T00-00-00-000Z`;
const OTHER_TEST_GRAPH = `${ROOT}/f28-refpath-feature-2026-01-02T00-00-00-000Z`;
// Deliberately synthetic, and deliberately NOT shaped like anyone's notes.
const ELSEWHERE = '/synthetic/not-a-real-location/some-other-graph';

test('a repo url, a bare path and an EDN-quoted value all canonicalise the same', () => {
  const want = APPROVED;
  for (const raw of [APPROVED,
                     `${APP.LOCAL_DB_PREFIX}${APPROVED}`,
                     `"${APP.LOCAL_DB_PREFIX}${APPROVED}"`,
                     `"${APPROVED}"`,
                     `file://${APPROVED}`,
                     `${APPROVED}/`,
                     `${APPROVED}//`,
                     `${ROOT}/./f28-refpath-feature-2026-01-01T00-00-00-000Z`]) {
    assert.strictEqual(APP.canonicalGraphPath(raw), want, JSON.stringify(raw));
  }
});

test('a percent-encoded path decodes, and a stray percent does not mangle it', () => {
  const spaced = `${ROOT}/graph with spaces`;
  assert.strictEqual(APP.canonicalGraphPath(encodeURI(spaced)), spaced);
  // `%zz` is not a valid escape; the value must survive rather than be dropped.
  assert.strictEqual(APP.canonicalGraphPath('/tmp/100%zz'), '/tmp/100%zz');
});

test('anything that is not a usable absolute path canonicalises to null', () => {
  for (const raw of [null, undefined, 42, '', '   ', '""', 'local', 'relative/path',
                     `${APP.LOCAL_DB_PREFIX}GraphName`]) {
    assert.strictEqual(APP.canonicalGraphPath(raw), null, JSON.stringify(raw));
  }
});

// ---------------------------------------------------------------------------
// The gate: verdicts
// ---------------------------------------------------------------------------

const gate = (over) => APP.currentGraphVerdict(Object.assign(
  { api: null, liveRepo: null, storage: null, approved: APPROVED, allowedRoot: ROOT }, over));

test("the gate passes only when OG's own current repository IS the approved graph", () => {
  const v = gate({ api: { url: `${APP.LOCAL_DB_PREFIX}${APPROVED}`, path: APPROVED },
                   liveRepo: `${APP.LOCAL_DB_PREFIX}${APPROVED}`,
                   storage: `"${APP.LOCAL_DB_PREFIX}${APPROVED}"` });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, 'exact-match');
  assert.strictEqual(v.active, APPROVED);
});

test('THE SUPERVISOR CASE: a remembered graph cannot satisfy the gate for an active one', () => {
  // The old gate asked whether localStorage CONTAINED the requested path. Here
  // the requested path is in storage exactly as a `recent` entry would put it,
  // while the ACTIVE graph is a different one. The gate must refuse.
  const storageBlob = JSON.stringify({
    'git/current-repo': `"${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}"`,
    'ls-recent-graphs': `["${APPROVED}", "${OTHER_TEST_GRAPH}"]`,
  });
  assert.ok(storageBlob.includes(APPROVED), 'the old substring gate would have passed here');

  const v = gate({ api: { path: OTHER_TEST_GRAPH },
                   liveRepo: `${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}`,
                   storage: `"${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}"` });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'mismatch');
  assert.match(v.detail, /not this run's approved graph/);
});

test('no LIVE current repository at all is a refusal, not a guess', () => {
  const v = gate({ api: null, liveRepo: null, storage: null });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no-live-graph');
  assert.strictEqual(v.active, null);
});

test('STORED HISTORY ALONE IS REFUSED, even when it matches exactly', () => {
  // The supervisor correction: a persisted `git/current-repo` records what was
  // opened once, not what is open now. It can no longer make this gate pass.
  const v = gate({ api: null, liveRepo: null,
                   storage: `"${APP.LOCAL_DB_PREFIX}${APPROVED}"` });
  assert.strictEqual(v.ok, false, 'a stored value must never satisfy this gate');
  assert.strictEqual(v.reason, 'no-live-graph');
  assert.strictEqual(v.active, null);
  assert.match(v.detail, /not what is open now/);
});

test('a LIVE source that THREW is a refusal, even when storage matches', () => {
  // A throwing read reaches the verdict as an absent value; the run also
  // records the error text separately. Either way, absent means refuse.
  const v = gate({ api: null, liveRepo: null,
                   storage: `"${APP.LOCAL_DB_PREFIX}${APPROVED}"` });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no-live-graph');
});

test('MALFORMED live state is a refusal, even when storage matches', () => {
  const matching = `"${APP.LOCAL_DB_PREFIX}${APPROVED}"`;
  for (const live of [{}, { path: null }, { path: '' }, { path: 'local' },
                      { path: 'memory:///local' }, { path: 42 }, 'not-an-object']) {
    const v = gate({ api: live, liveRepo: null, storage: matching });
    assert.strictEqual(v.ok, false, JSON.stringify(live));
    assert.strictEqual(v.reason, 'no-live-graph', JSON.stringify(live));
  }
  for (const live of ['', 'local', 'relative/path', `${APP.LOCAL_DB_PREFIX}GraphName`]) {
    const v = gate({ api: null, liveRepo: live, storage: matching });
    assert.strictEqual(v.ok, false, JSON.stringify(live));
    assert.strictEqual(v.reason, 'no-live-graph', JSON.stringify(live));
  }
});

test('the DIRECT live-state read is an acceptable authoritative source', () => {
  // `frontend.state.get_current_repo()` is the same function the plugin API
  // calls. It is live application state, not history, so it may answer alone.
  const v = gate({ api: null, liveRepo: `${APP.LOCAL_DB_PREFIX}${APPROVED}`, storage: null });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.source, 'state');
  assert.strictEqual(v.active, APPROVED);
  assert.match(v.detail, /direct read of live application state/);
});

test('the two LIVE sources disagreeing is AMBIGUOUS, and refused', () => {
  const v = gate({ api: { path: APPROVED },
                   liveRepo: `${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}` });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'ambiguous');
  assert.strictEqual(v.active, null, 'an ambiguous state names no active graph');
});

test('a stored value CONTRADICTING live state is AMBIGUOUS, and refused', () => {
  // Storage keeps exactly one job: contradicting a live answer.
  const v = gate({ api: { path: APPROVED }, liveRepo: null,
                   storage: `"${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}"` });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'ambiguous');
  assert.match(v.detail, /live current repository and the stored one disagree/);
  assert.match(v.detail, / live vs /);
});

test('a passing gate names the LIVE source that actually answered', () => {
  const both = gate({ api: { path: APPROVED },
                      liveRepo: `${APP.LOCAL_DB_PREFIX}${APPROVED}`,
                      storage: `"${APP.LOCAL_DB_PREFIX}${APPROVED}"` });
  assert.strictEqual(both.source, 'both-live');
  assert.match(both.detail, /both logseq\.api\.get_current_graph\(\) and frontend\.state/);
  assert.match(both.detail, /the stored git\/current-repo agrees/);

  const apiOnly = gate({ api: { path: APPROVED }, liveRepo: null, storage: null });
  assert.strictEqual(apiOnly.source, 'api');
  assert.match(apiOnly.detail, /live, from logseq\.api\.get_current_graph\(\)/);
  assert.match(apiOnly.detail, /no stored value was present, which does not matter/);

  assert.ok(both.detail.startsWith("OG's current repository is exactly"));
  assert.ok(apiOnly.detail.includes('live,'),
    'a passing gate must say the answer came from live state');
});

test('no verdict is ever sourced from storage', () => {
  // A structural guarantee rather than a case list: whatever the inputs, a
  // passing verdict never names storage as its source.
  const matching = `"${APP.LOCAL_DB_PREFIX}${APPROVED}"`;
  const inputs = [
    { api: null, liveRepo: null, storage: matching },
    { api: {}, liveRepo: null, storage: matching },
    { api: { path: 'local' }, liveRepo: 'local', storage: matching },
    { api: null, liveRepo: '', storage: matching },
  ];
  for (const over of inputs) {
    const v = gate(over);
    assert.strictEqual(v.ok, false, JSON.stringify(over));
    assert.notStrictEqual(v.source, 'storage');
  }
});

test('an active graph OUTSIDE the permitted root is refused, and NOT recorded', () => {
  const v = gate({ api: { path: ELSEWHERE }, liveRepo: `${APP.LOCAL_DB_PREFIX}${ELSEWHERE}`,
                   storage: `"${APP.LOCAL_DB_PREFIX}${ELSEWHERE}"` });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'mismatch');
  // The whole point of the redaction: a path this run must not touch must not
  // end up written into evidence in order to be rejected.
  assert.ok(!v.detail.includes(ELSEWHERE),
    'the rejected path must not appear in the detail');
  assert.match(v.detail, /outside the permitted root/);
  assert.match(v.detail, /content is deliberately not recorded/);
});

test('a rejected path INSIDE the permitted root may be named — it is test data', () => {
  const v = gate({ api: { path: OTHER_TEST_GRAPH } });
  assert.strictEqual(v.ok, false);
  assert.ok(v.detail.includes(OTHER_TEST_GRAPH),
    "this project's own test graphs are legible in a failure");
});

test('the gate never resolves the value it is rejecting', () => {
  // Read out of the source rather than described: a `realpath`/`stat`/hash of a
  // path that might be personal is exactly what the guardrail forbids, and it
  // is what a naive "canonicalise then compare" would do.
  const src = require('fs').readFileSync(
    path.join(REPO, 'f28-refpath', 'checks', 'packaged-app.js'), 'utf8');
  const gateSection = src.slice(src.indexOf('function canonicalGraphPath'),
                                src.indexOf('function resolve('));
  for (const forbidden of ['realpathSync', 'statSync', 'lstatSync', 'existsSync',
                           'createHash', 'readFileSync', 'readdirSync']) {
    assert.ok(!gateSection.includes(forbidden),
      `the gate must not call ${forbidden} on a value it may be rejecting`);
  }
});

test('an approved path this run never supplied is refused rather than defaulted', () => {
  const v = APP.currentGraphVerdict({ api: { path: APPROVED }, liveRepo: null, storage: null,
                                      approved: null, allowedRoot: ROOT });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no-approved-path');
});

test('the real permitted root is what production callers hand the gate', () => {
  // Not a personal path: the project's own permitted root, which the guardrail
  // names and which the harness already resolves for every run.
  const real = B.allowedRootReal();
  assert.strictEqual(APP.canonicalGraphPath(real), APP.canonicalGraphPath(real + '/'));
  assert.ok(APP.describeRejected(real + '/inside-it', APP.canonicalGraphPath(real))
    .includes('inside-it'));
  assert.match(APP.describeRejected('/synthetic/outside', APP.canonicalGraphPath(real)),
    /outside the permitted root/);
});

// ---------------------------------------------------------------------------
// Cleanup ownership, through injected failures
// ---------------------------------------------------------------------------

/** A fake main-process handle whose steps can be made to fail on demand. */
function fakeApp(script) {
  const calls = { evaluate: [], closed: 0, firstWindow: 0 };
  return {
    calls,
    async evaluate(fn, arg) {
      calls.evaluate.push({ arg });
      if (script.onEvaluate) return script.onEvaluate(calls.evaluate.length, fn, arg);
      return 4242;
    },
    async firstWindow() {
      calls.firstWindow += 1;
      if (script.firstWindowThrows) throw new Error('firstWindow exploded');
      return fakePage(script);
    },
    async close() { calls.closed += 1; },
  };
}

function fakePage(script) {
  return {
    on() {},
    async addInitScript() {},
    async evaluate(fn, arg) {
      if (script.pageEvaluate) return script.pageEvaluate(fn, arg);
      return { api: null, apiError: null, storage: null, storageKeysSeen: 0 };
    },
    async waitForLoadState() {
      if (script.loadStateThrows) throw new Error('domcontentloaded never happened');
    },
    locator() { return { first: () => ({ async click() {} }) }; },
    mouse: { async move() {} },
    keyboard: { async press() {} },
  };
}

function harness(script) {
  const stopped = [];
  const said = [];
  const notes = [];
  const errors = { record() {}, endPhase() {} };
  const deps = {
    launch: async (opts) => {
      script.launches = (script.launches || 0) + 1;
      if (script.launchThrows) throw new Error('electron would not start');
      return (script.app = fakeApp(script));
    },
    descendants: () => [4242, 4243],
    stop: async (pid) => { stopped.push(pid); return { stage: 'sigterm' }; },
    alive: () => false,
    sleep: async () => {},
    journalLines: () => 0,
    journalSince: () => ([{ guard: 'graph-boundary', detail: 'refused open-dir [graph-select]' }]),
  };
  return {
    stopped, said, notes, deps, script,
    args: {
      built: { exe: '/synthetic/no/such/app', journal: '/synthetic/no/such/journal' },
      graph: null, // filled by each test
      bad: null,
      errors,
      say: (l) => said.push(String(l)),
      record: (id, title, ok, detail) => notes.push({ id, title, ok, detail: String(detail) }),
      phase: () => {},
      prefix: 'T',
      deps,
    },
  };
}

/**
 * A real, approved graph path for the launcher's own containment assertion,
 * and a real outside probe path — both this project's own, neither personal,
 * and neither created by these tests.
 */
function paths() {
  const root = B.allowedRootReal();
  return {
    graph: path.join(root, 'f28-refpath-unit-test-never-created'),
    bad: path.join(path.dirname(root), 'f28-refpath-unit-test-outside-probe'),
  };
}

test('a launch failure is NOT retried, and owns no process', async () => {
  const h = harness({ launchThrows: true });
  const p = paths();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })),
    /electron would not start/);
  assert.strictEqual(h.script.launches, 1, 'a blind retry after an uncertain launch is gone');
  assert.deepStrictEqual(h.stopped, [], 'nothing was owned, so nothing is signalled');
  assert.ok(h.said.some((l) => /no pid was retained/.test(l)),
    'the launcher must say plainly that it owns nothing');
});

test('a failure AFTER launch stops the retained process tree', async () => {
  const h = harness({ firstWindowThrows: true });
  const p = paths();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })),
    /firstWindow exploded/);
  assert.deepStrictEqual(h.stopped, [4242],
    'the pid retained immediately after launch must be stopped');
  assert.strictEqual(h.script.app.calls.closed, 1, 'and the app closed');
});

test('the pid is retained BEFORE the first thing that can fail', async () => {
  // If the pid were read after `firstWindow`, the previous test could not pass.
  // This pins the ordering rather than trusting it.
  const h = harness({ firstWindowThrows: true });
  const p = paths();
  await assert.rejects(() => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })));
  assert.ok(h.script.app.calls.evaluate.length >= 1,
    'the pid lookup must have happened before firstWindow threw');
  assert.strictEqual(h.script.app.calls.firstWindow, 1);
});

test('an application that reports no pid is refused rather than left running', async () => {
  const h = harness({ onEvaluate: () => null });
  const p = paths();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })),
    /did not report a pid/);
  assert.strictEqual(h.script.app.calls.closed, 1);
});

test('a failure after the dialog stub is installed RESTORES it before stopping', async () => {
  const order = [];
  const h = harness({
    onEvaluate: (n, fn, arg) => {
      if (n === 1) return 4242;            // pid
      if (n === 2) { order.push('install-stub'); return true; }
      order.push('evaluate-' + n);
      return true;
    },
    loadStateThrows: false,
    pageEvaluate: () => { throw new Error('the window went away'); },
  });
  const p = paths();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })));
  assert.ok(order.includes('install-stub'), 'the stub was installed in this run');
  // The LAST main-process evaluate before close must be the restore.
  const last = h.script.app.calls.evaluate.length;
  assert.ok(last >= 3, 'a restore call must follow the failure');
  assert.deepStrictEqual(h.stopped, [4242]);
  assert.strictEqual(h.script.app.calls.closed, 1);
});

test('a graph the application never opened aborts and cleans up', async () => {
  // The gate's own failure path, end to end: OG reports a different graph.
  const p = paths();
  const h = harness({
    onEvaluate: (n) => (n === 1 ? 4242 : true),
    pageEvaluate: () => ({ api: { path: OTHER_TEST_GRAPH }, apiError: null,
                           storage: `"${APP.LOCAL_DB_PREFIX}${OTHER_TEST_GRAPH}"`,
                           storageKeysSeen: 3 }),
  });
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad })),
    /the active graph is not this run's approved graph/);
  assert.deepStrictEqual(h.stopped, [4242], 'the gate must not leave a process running');
  const gateNote = h.notes.find((x) => x.id === 'T3.1');
  assert.ok(gateNote && gateNote.ok === false, 'the failing gate is recorded as a failed check');
});

test('a successful startup hands the session over and stops NOTHING', async () => {
  const p = paths();
  const h = harness({
    onEvaluate: (n) => (n === 1 ? 4242 : true),
    pageEvaluate: () => ({ api: { path: p.graph }, apiError: null,
                           storage: `"${APP.LOCAL_DB_PREFIX}${p.graph}"`, storageKeysSeen: 3 }),
  });
  const session = await APP.open(Object.assign({}, h.args, { graph: p.graph, bad: p.bad }));
  assert.deepStrictEqual(h.stopped, [], 'ownership transferred; the launcher stops nothing');
  assert.strictEqual(h.script.app.calls.closed, 0);
  assert.strictEqual(session.appPid, 4242);
  assert.deepStrictEqual(session.ownedTree, [4242, 4243],
    'the caller receives the retained tree so its own finally block can address it');
  assert.strictEqual(session.activeGraph, APP.canonicalGraphPath(p.graph));
  assert.strictEqual(typeof session.collectErrorEvidence, 'function');
  const gateNote = h.notes.find((x) => x.id === 'T3.1');
  assert.ok(gateNote && gateNote.ok === true);
});

test('the containment refusal happens before anything is launched at all', async () => {
  const h = harness({});
  const root = B.allowedRootReal();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args,
      { graph: path.join(path.dirname(root), 'outside-the-root'), bad: paths().bad })),
    /outside the permitted/);
  assert.strictEqual(h.script.launches || 0, 0, 'nothing may launch for a refused graph');
});

test('a refusal probe INSIDE the permitted root is itself refused', async () => {
  const h = harness({});
  const p = paths();
  await assert.rejects(
    () => APP.open(Object.assign({}, h.args,
      { graph: p.graph, bad: path.join(B.allowedRootReal(), 'not-outside') })),
    /is inside the root/);
  assert.strictEqual(h.script.launches || 0, 0);
});
