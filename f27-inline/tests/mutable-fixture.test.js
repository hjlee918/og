'use strict';
//
// The three MUTABLE fixtures' own rules, checked WITHOUT touching the permitted
// graph-data root.
//
// Nothing here creates, reads or enumerates a graph. `build()` is deliberately
// not called: creating a graph is what the packaged scenarios do, once each,
// inside the permitted root. This exercises the templates, the declared
// changes, and the declared end states as data.
//
// The rule that matters most here is the LAST one in each group: an end-state
// assertion is worthless if it could not fail. A string asserted PRESENT at the
// end must not already be in the fixture, and a string asserted ABSENT must be.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const LG = require(path.join(REPO, 'f27-inline', 'checks', 'make-lifecycle-graph.js'));
const TG = require(path.join(REPO, 'f27-inline', 'checks', 'make-transaction-graph.js'));
const RG = require(path.join(REPO, 'f27-inline', 'checks', 'make-refresh-graph.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- both fixtures ----------------------------------------------------------

for (const [name, F] of [['lifecycle', LG], ['transaction', TG], ['refresh', RG]]) {
  test(`${name}: every identity it writes is a well-formed, distinct uuid`, () => {
    const ids = Object.values(F.UUID);
    for (const [k, u] of Object.entries(F.UUID)) assert.match(u, UUID_RE, `${k} is not a uuid`);
    assert.strictEqual(new Set(ids).size, ids.length, 'identities collide');
  });

  test(`${name}: the control page is named, present, and never a declared change`, () => {
    const rel = F.CONTROL_FILE;
    assert.ok(rel.startsWith('pages/'));
    const base = rel.slice('pages/'.length);
    assert.ok(F.PAGES[base], `${base} is missing from the fixture`);
    // It may be DECLARED — the lifecycle fixture lists every page's end state,
    // including this one — but only as unchanged from the template.
    const declared = F.EXPECTED_END[rel];
    if (declared !== undefined) {
      assert.strictEqual(declared, F.PAGES[base],
        'the control page may only be declared as ending exactly where it started');
    }
    assert.ok(!/\(\([0-9a-f-]{36}\)\)/.test(F.PAGES[base]),
      'the control page must carry no reference, so nothing that happens to a target reaches it');
  });
}

// --- the lifecycle (external-file) fixture ----------------------------------

test('lifecycle: every declared mutation names a page it is allowed to write', () => {
  assert.ok(LG.MUTATIONS.length > 0);
  for (const m of LG.MUTATIONS) {
    assert.ok(m.id && m.file && m.what && typeof m.body === 'string', JSON.stringify(m));
    assert.ok(m.file.startsWith('pages/'), `${m.id} writes outside pages/`);
    assert.notStrictEqual(m.file, LG.CONTROL_FILE, `${m.id} writes the control page`);
  }
  assert.strictEqual(new Set(LG.MUTATIONS.map((m) => m.id)).size, LG.MUTATIONS.length);
});

test('lifecycle: the declared end state is what the last write to each page produced', () => {
  const last = {};
  for (const m of LG.MUTATIONS) last[m.file] = m.body;
  for (const [rel, body] of Object.entries(last)) {
    assert.strictEqual(LG.EXPECTED_END[rel], body,
      `${rel}: the expected end state is not the last body written to it`);
  }
  // The control is in the end state too, unchanged from the template.
  assert.strictEqual(LG.EXPECTED_END[LG.CONTROL_FILE],
    LG.PAGES[LG.CONTROL_FILE.slice('pages/'.length)]);
});

test('lifecycle: its end state differs from where it started, so the check can fail', () => {
  let differing = 0;
  for (const [rel, want] of Object.entries(LG.EXPECTED_END)) {
    const start = LG.PAGES[rel.slice('pages/'.length)];
    if (start !== want) differing += 1;
  }
  assert.strictEqual(differing, 2,
    'exactly the two pages this run writes must end different from how they started');
});

// --- the transaction (application-path) fixture -----------------------------

test('transaction: the edited target lives on a DIFFERENT page from its host', () => {
  // Otherwise editing it would re-render the host for another reason, and the
  // panel could converge without the subscription under test doing anything.
  const reading = TG.PAGES['Txn Reading.md'];
  const targets = TG.PAGES['Txn Targets.md'];
  assert.ok(reading.includes(`((${TG.UUID.tgtEdit}))`), 'the host references it');
  assert.ok(!reading.includes(`id:: ${TG.UUID.tgtEdit}`), 'but does not contain it');
  assert.ok(targets.includes(`id:: ${TG.UUID.tgtEdit}`), 'the target page does');
});

test('transaction: the context case is isolated on a page of its own', () => {
  const ctx = TG.PAGES['Txn Context.md'];
  for (const k of ['tgtCtx', 'ctxParentA', 'ctxParentB', 'ctxReferrer']) {
    assert.ok(ctx.includes(`id:: ${TG.UUID[k]}`), `${k} must live on Txn Context.md`);
  }
  assert.ok(!ctx.includes(`id:: ${TG.UUID.tgtEdit}`),
    'and nothing from the other cases may share that page');
  assert.ok(!ctx.includes(`((${TG.UUID.tgtCtx}))`),
    'nothing on it refers to the context target yet — the inbound case adds that');
});

test('transaction: the retarget host starts on A, and B is a different block', () => {
  const reading = TG.PAGES['Txn Reading.md'];
  assert.ok(reading.includes(`((${TG.UUID.tgtA}))`));
  assert.ok(!reading.includes(`((${TG.UUID.tgtB}))`));
  assert.notStrictEqual(TG.UUID.tgtA, TG.UUID.tgtB);
  assert.ok(TG.PAGES['Txn Targets.md'].includes(`id:: ${TG.UUID.tgtB}`));
});

test('transaction: one host writes the SAME target twice, and another writes it once', () => {
  const line = TG.PAGES['Txn Reading.md'].split('\n').find((l) => l.startsWith('- Twice host:'));
  const written = [...line.matchAll(/\(\(([0-9a-f-]{36})\)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(written, [TG.UUID.tgtRep, TG.UUID.tgtRep]);
  const doomed = TG.PAGES['Txn Reading.md'].split('\n').find((l) => l.startsWith('- Doomed host:'));
  assert.ok(doomed.includes(`((${TG.UUID.tgtRep}))`));
});

test('transaction: every host block carries an identity, so a re-parse keeps it', () => {
  const reading = TG.PAGES['Txn Reading.md'];
  for (const k of ['hostEdit', 'hostDel', 'hostRetarget', 'hostTwice', 'hostDoomed', 'hostCtx']) {
    assert.ok(reading.includes(`id:: ${TG.UUID[k]}`), `${k} has no identity`);
  }
});

test('transaction: what the run expects to ADD is not there already', () => {
  // The check that stops an end-state assertion from being vacuous.
  const all = Object.values(TG.PAGES).join('\n');
  for (const s of [TG.TEXT.editAfter, TG.TEXT.editAfterApi, TG.TEXT.editAfterReindex,
                   TG.TEXT.ctxParentARenamed, TG.TEXT.ctxChild]) {
    assert.ok(!all.includes(s), `${JSON.stringify(s)} is already in the fixture`);
  }
});

test('transaction: what the run expects to REMOVE is there to begin with', () => {
  for (const [rel, want] of Object.entries(TG.EXPECTED_END)) {
    const start = TG.PAGES[rel.slice('pages/'.length)];
    for (const s of (want.absent || [])) {
      assert.ok(start.includes(s),
        `${rel}: ${JSON.stringify(s.slice(0, 40))} is asserted absent at the end ` +
        'but was never present, so the assertion could not fail');
    }
  }
});

test('transaction: text the run adds and then removes is declared as such, separately', () => {
  // `absentAfterBeingAdded` is the one kind of absence that cannot be checked
  // against the starting state. It is kept apart so the check above stays
  // strict, and asserted here to be genuinely absent at the start — otherwise
  // it belongs in `absent`.
  const reading = TG.EXPECTED_END['pages/Txn Reading.md'];
  assert.deepStrictEqual(reading.absentAfterBeingAdded, [`((${TG.UUID.tgtB}))`]);
  assert.ok(!TG.PAGES['Txn Reading.md'].includes(`((${TG.UUID.tgtB}))`));
  for (const [rel, want] of Object.entries(TG.EXPECTED_END)) {
    for (const s of (want.absentAfterBeingAdded || [])) {
      assert.ok(!TG.PAGES[rel.slice('pages/'.length)].includes(s),
        `${rel}: ${JSON.stringify(s)} IS in the fixture, so it belongs in absent`);
    }
  }
});

test('transaction: nothing declares a change to a page it does not own', () => {
  for (const rel of Object.keys(TG.EXPECTED_END)) {
    assert.ok(rel.startsWith('pages/'));
    assert.ok(TG.PAGES[rel.slice('pages/'.length)], `${rel} is not a fixture page`);
    assert.notStrictEqual(rel, TG.CONTROL_FILE);
  }
});

// --- the refresh fixture ----------------------------------------------------

test('refresh: the reading page is a second control and is never declared', () => {
  // Every case is driven from a host on it, and no case edits a host. Leaving
  // it out of the declared end states is what makes any change to it fail as
  // undeclared, so this pins that it is genuinely left out.
  assert.ok(RG.PAGES[RG.READING_FILE.slice('pages/'.length)], 'the reading page is missing');
  assert.strictEqual(RG.EXPECTED_END[RG.READING_FILE], undefined);
  assert.notStrictEqual(RG.READING_FILE, RG.CONTROL_FILE);
});

test('refresh: exactly one page is declared to change, and it is the sources page', () => {
  assert.deepStrictEqual(Object.keys(RG.EXPECTED_END), ['pages/Refresh Sources.md']);
  for (const rel of Object.keys(RG.EXPECTED_END)) {
    assert.ok(RG.PAGES[rel.slice('pages/'.length)], `${rel} is not a fixture page`);
    assert.notStrictEqual(rel, RG.CONTROL_FILE);
  }
});

test('refresh: the main target has sources that stay, join, and are removed', () => {
  const src = RG.PAGES['Refresh Sources.md'];
  const ref = `((${RG.UUID.tgtMain}))`;
  const line = (id) => src.split('\n- ').find((l) => l.includes(`id:: ${id}`));
  assert.ok(line(RG.UUID.srcKeep).includes(ref), 'the permanent source refers to the target');
  assert.ok(line(RG.UUID.srcGone).includes(ref), 'the removed source refers to it too');
  assert.ok(!line(RG.UUID.srcJoins).includes(ref),
    'the joining source must NOT refer to it yet, or "it appears" could not fail');
});

test('refresh: the declared inbound counts match the fixture and each other', () => {
  const src = RG.PAGES['Refresh Sources.md'];
  const reading = RG.PAGES[RG.READING_FILE.slice('pages/'.length)];
  const ref = new RegExp(`\\(\\(${RG.UUID.tgtMain}\\)\\)`, 'g');
  const atStart = (src.match(ref) || []).length + (reading.match(ref) || []).length;
  assert.strictEqual(RG.MAIN_INBOUND.atStart, atStart,
    'the declared starting count is not what the fixture actually writes');
  assert.strictEqual(RG.MAIN_INBOUND.afterJoin, RG.MAIN_INBOUND.atStart + 1);
  assert.strictEqual(RG.MAIN_INBOUND.afterLeave, RG.MAIN_INBOUND.atStart);
  assert.strictEqual(RG.MAIN_INBOUND.afterRemoval, RG.MAIN_INBOUND.atStart - 1);
  assert.strictEqual(RG.MAIN_INBOUND.afterRejoin, RG.MAIN_INBOUND.afterRemoval + 1);
});

test('refresh: one source has a source of its own, so the walk has a level to enter', () => {
  // The explorer only offers a step where the row's own probe found something.
  // Without this block every row in the target's list is a dead end, and the
  // inner walk a refresh resets could not be walked at all — which is exactly
  // what the first packaged run of this scenario observed.
  const src = RG.PAGES['Refresh Sources.md'];
  assert.ok(src.includes(`${RG.TEXT.srcKeepRef} ((${RG.UUID.srcKeep}))`),
    'nothing refers to the permanent source');
  assert.ok(!src.includes(`${RG.TEXT.srcKeepRef} ((${RG.UUID.tgtMain}))`),
    'and it must refer to the SOURCE, not to the target, or it would be a first-level row');
});

test('refresh: the second target has its own sources and its own host', () => {
  const src = RG.PAGES['Refresh Sources.md'];
  const ref = `((${RG.UUID.tgtOther}))`;
  assert.ok(src.includes(`${RG.TEXT.srcOtherKeep} ${ref}`));
  assert.ok(!src.includes(RG.TEXT.srcOtherJoinsAfter),
    'the second target\'s joining source must not refer to it yet');
  assert.ok(RG.PAGES[RG.READING_FILE.slice('pages/'.length)].includes(ref));
  assert.notStrictEqual(RG.UUID.tgtMain, RG.UUID.tgtOther);
});

test('refresh: the mutual pair really is mutual, and is isolated on its own page', () => {
  const cyc = RG.PAGES['Refresh Cycle.md'];
  assert.ok(cyc.includes(`id:: ${RG.UUID.tgtCycle}`) && cyc.includes(`((${RG.UUID.cycOther}))`));
  assert.ok(cyc.includes(`id:: ${RG.UUID.cycOther}`) && cyc.includes(`((${RG.UUID.tgtCycle}))`));
  assert.ok(!cyc.includes(RG.UUID.tgtMain), 'the cycle page shares nothing with the other cases');
});

test('refresh: the stub identity is written NOWHERE but the one host that names it', () => {
  // The unavailable state is only honest if nothing was ever written for the
  // identity. Every page is checked, not just the target page.
  for (const [file, body] of Object.entries(RG.PAGES)) {
    assert.ok(!body.includes(`id:: ${RG.UUID.tgtStub}`), `${file} defines the stub block`);
  }
  const naming = Object.entries(RG.PAGES).filter(([, b]) => b.includes(RG.UUID.tgtStub));
  assert.deepStrictEqual(naming.map(([f]) => f), [RG.READING_FILE.slice('pages/'.length)]);
});

test('refresh: every host block carries an identity, so a re-parse keeps it', () => {
  const reading = RG.PAGES[RG.READING_FILE.slice('pages/'.length)];
  for (const k of ['hostMain', 'hostOther', 'hostStub', 'hostCycle']) {
    assert.ok(reading.includes(`id:: ${RG.UUID[k]}`), `${k} has no identity`);
  }
});

test('refresh: what the run expects to ADD is not there already', () => {
  const all = Object.values(RG.PAGES).join('\n');
  for (const s of [RG.TEXT.srcJoinsAfter, RG.TEXT.srcJoinsRemoved, RG.TEXT.srcOtherJoinsAfter]) {
    assert.ok(!all.includes(s), `${JSON.stringify(s.slice(0, 40))} is already in the fixture`);
  }
});

test('refresh: what the run expects to REMOVE is there to begin with', () => {
  for (const [rel, want] of Object.entries(RG.EXPECTED_END)) {
    const start = RG.PAGES[rel.slice('pages/'.length)];
    for (const s of (want.absent || [])) {
      assert.ok(start.includes(s),
        `${rel}: ${JSON.stringify(s.slice(0, 40))} is asserted absent at the end ` +
        'but was never present, so the assertion could not fail');
    }
    // At least one asserted-present string must be NEW, or the whole end state
    // could be satisfied by the fixture never having been touched at all.
    const added = (want.present || []).filter((s) => !start.includes(s));
    assert.ok(added.length > 0,
      `${rel}: every asserted-present string is already in the fixture, so the ` +
      'end state could be satisfied by nothing happening at all');
  }
});

test('refresh: text the run adds and then removes is declared as such, separately', () => {
  for (const [rel, want] of Object.entries(RG.EXPECTED_END)) {
    for (const s of (want.absentAfterBeingAdded || [])) {
      assert.ok(!RG.PAGES[rel.slice('pages/'.length)].includes(s),
        `${rel}: ${JSON.stringify(s)} IS in the fixture, so it belongs in absent`);
    }
  }
  assert.deepStrictEqual(RG.EXPECTED_END['pages/Refresh Sources.md'].absentAfterBeingAdded,
                         [RG.TEXT.srcJoinsAfter]);
});

test('refresh: every fixture string an assertion quotes is distinctive', () => {
  // The end-state checks are substring tests. Two source texts sharing a prefix
  // would let a check that should fail pass.
  const vals = Object.values(RG.TEXT);
  for (const a of vals) {
    for (const b of vals) {
      if (a === b) continue;
      assert.ok(!a.includes(b), `${JSON.stringify(b.slice(0, 30))} is a substring of another`);
    }
  }
});
