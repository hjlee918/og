'use strict';
//
// The COMBINED-WORKFLOW fixture's own rules.
//
// The fixture is what makes a wrong integration claim VISIBLE rather than
// merely unproven, so its own properties are asserted here rather than assumed
// by the scenario that reads it:
//
//   * the ordering fixture's pages really are unchanged underneath the
//     additions — the accepted runs' numbers (10 mentions, 8 groups, 22 rows)
//     are quoted in their evidence and must still be what this fixture holds;
//   * the anchor's additions really are main-content blocks that never mention
//     the anchor or its alias, so the linked-references list keeps its
//     measured shape;
//   * the badge target really has the ancestors, children, mutual pair and
//     third source the badge journey needs;
//   * the Crystal marker really has two of the badge target's rows to preview
//     and the graph really offers more than one of its own tags;
//   * the inline panel's target really points outward, and its joining source
//     really starts without the reference the run will add and remove;
//   * the declared writes really are the only two pages the run mutates.
//
// Nothing here writes a graph, launches an application or reads one.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CG = require(path.join(__dirname, '..', 'checks', 'make-combined-graph.js'));
const RO = require(path.join(__dirname, '..', 'checks', 'make-reforder-graph.js'));

const U = CG.UUID;
const T = CG.TEXT;
const allBodies = () => Object.values(CG.PAGES).join('\n') + CG.journalBody();
const times = (needle) => allBodies().split(needle).length - 1;

// --- the ordering fixture, unchanged underneath -------------------------------

test('every ordering-fixture page except the anchor is byte-identical', () => {
  for (const [file, body] of Object.entries(RO.PAGES)) {
    if (file === `${CG.ANCHOR}.md`) continue;
    assert.ok(CG.PAGES[file], `${file} must still exist`);
    assert.strictEqual(CG.PAGES[file], body, `${file} must be unchanged`);
  }
});

test('the anchor page keeps the alias as its first line and its measured lines before the tail', () => {
  const anchor = CG.PAGES[`${CG.ANCHOR}.md`];
  assert.ok(anchor.startsWith(`alias:: ${CG.ALIAS}\n`),
    'the alias must stay a PAGE property on the first line, or the alias page is ' +
    'never created and the source page that mentions it goes missing');
  const original = RO.PAGES[`${CG.ANCHOR}.md`];
  assert.ok(anchor.startsWith(original),
    'the ordering runs measured the anchor as it was; the additions must come after');
});

test("the anchor's additions never mention the anchor or its alias", () => {
  const tail = CG.PAGES[`${CG.ANCHOR}.md`].slice(RO.PAGES[`${CG.ANCHOR}.md`].length);
  assert.ok(!tail.includes(`[[${CG.ANCHOR}]]`) && !tail.includes(`[[${CG.ALIAS}]]`),
    'a mention in the tail would change the linked-references count the accepted runs quoted');
  assert.strictEqual(CG.REFERENCING.length, 10);
});

test('the journal is the ordering fixture’s own, unchanged', () => {
  assert.strictEqual(CG.journalBody(), RO.journalBody());
});

// --- the badge journey's shape -------------------------------------------------

test('the badge target has five ancestors written one inside the next', () => {
  const page = CG.PAGES[`${CG.BADGE_PAGE}.md`];
  const chain = ['badgeB1', 'badgeB2', 'badgeB3', 'badgeB4', 'badgeB5'];
  let last = -1;
  for (const k of chain) {
    const at = page.indexOf(U[k]);
    assert.ok(at > last, `${k} must be written outside the level below it`);
    last = at;
  }
  assert.ok(page.indexOf(U.badgeTarget) > last, 'the target must sit under all five');
});

test('the badge target is referenced by exactly three blocks, and points at its cycle partner', () => {
  assert.strictEqual(times(U.badgeTarget), 4,
    'one id:: on its own page plus ((…)) in badgeHost, cycRow and badgeThird');
  for (const k of ['badgeHost', 'cycRow', 'badgeThird']) {
    assert.ok(T[k].includes(`((${U.badgeTarget}))`), `${k} must reference the badge target`);
  }
  assert.ok(T.badgeTarget.includes(`((${U.cycRow}))`),
    'the target must point at the cycle partner, or there is no mutual pair to stop at');
  assert.ok(T.cycRow.includes(`((${U.badgeTarget}))`),
    'and the partner must point back, or there is no cycle at all');
  assert.strictEqual(CG.BADGE_INBOUND, 3);
});

test('the badge target has a task child, a tagged child and a bold child', () => {
  assert.ok(T.badgeK1.startsWith('TODO '), 'the task child must carry a real marker');
  assert.ok(T.badgeK2.includes('#question'), 'the question child must carry a real tag');
  assert.ok(/^\*\*/.test(T.badgeK3), 'the third child must be bold, so emphasis is load-bearing');
  const page = CG.PAGES[`${CG.BADGE_PAGE}.md`];
  for (const k of ['badgeK1', 'badgeK2', 'badgeK3']) {
    assert.ok(page.indexOf(U[k]) > page.indexOf(U.badgeTarget),
      `${k} must be written under the target`);
  }
});

test('the Crystal marker has two of the badge target’s rows to preview, and the graph offers two tags', () => {
  const tagged = ['badgeHost', 'badgeThird'];
  for (const k of tagged) assert.ok(T[k].includes('#핵심'), `${k} must carry the tag`);
  assert.ok(!T.cycRow.includes('#'),
    'the cycle row must stay untagged, so the preview count is exactly two and not three');
  assert.ok(times('#핵심') >= 2, 'the tag must really exist in the graph');
  assert.ok(times('#question') >= 1, 'a second tag must really exist, or the marker list offers one');
});

test('the badge row has a parent and a child of its own', () => {
  const anchor = CG.PAGES[`${CG.ANCHOR}.md`];
  assert.ok(anchor.indexOf(U.badgeHost) > anchor.indexOf(U.badgeParent),
    'the badge row must sit under its parent, or the row context has no ancestor');
  assert.ok(anchor.indexOf(U.badgeHostChild) > anchor.indexOf(U.badgeHost),
    'and must have a child, or the row context has nothing to disclose');
});

// --- the inline-panel journey's shape ------------------------------------------

test('the main target is referenced by exactly the two blocks that start with it', () => {
  assert.strictEqual(times(U.tgtMain), 3,
    'one id:: on its own page plus ((…)) in hostMain and srcKeep');
  assert.ok(T.hostMain.includes(`((${U.tgtMain}))`));
  assert.ok(T.srcKeep.includes(`((${U.tgtMain}))`));
  assert.strictEqual(CG.MAIN_INBOUND.atStart, 2);
  assert.strictEqual(CG.MAIN_INBOUND.afterJoin, 3);
  assert.strictEqual(CG.MAIN_INBOUND.afterLeave, 2);
});

test('the joining source starts WITHOUT the reference, and both edit targets are stated', () => {
  assert.ok(!T.srcJoinsBefore.includes('(('), 'the joining source must not be a source yet');
  assert.ok(T.srcJoinsAfter.includes(`((${U.tgtMain}))`), 'the join text must add the reference');
  assert.ok(!T.srcJoinsRemoved.includes('(('), 'and the leave text must take it away again');
  // Every string is distinctive ON ITS OWN, because the end-state assertions
  // are substring tests: no two of the three may contain one another, and no
  // OTHER text in the fixture may contain any of them.
  const three = [T.srcJoinsBefore, T.srcJoinsAfter, T.srcJoinsRemoved];
  for (let i = 0; i < three.length; i++) {
    for (let j = 0; j < three.length; j++) {
      if (i === j) continue;
      assert.ok(!three[i].includes(three[j]), 'no joining text may contain another');
    }
  }
  for (const [k, v] of Object.entries(T)) {
    if (k.startsWith('srcJoins')) continue;
    for (const s of three) {
      assert.ok(!v.includes(s), `${k} must not contain a joining text`);
    }
  }
});

test('the main target points outward, and the outgoing target has a child to expand', () => {
  assert.ok(T.tgtMain.includes(`((${U.outTgt}))`),
    'the target must point outward, or the outgoing section has no row');
  assert.strictEqual(times(U.outTgt), 2, 'one id:: plus the reference from the main target');
  const page = CG.PAGES[`${CG.OUTGOING_PAGE}.md`];
  assert.ok(page.indexOf(U.outTgtChild) > page.indexOf(U.outTgt),
    'the outgoing target must have a child, or its row cannot be expanded');
});

test('the permanent source has a second level pointing at IT, not at the target', () => {
  assert.ok(T.srcKeepRef.includes(`((${U.srcKeep}))`));
  assert.ok(!T.srcKeepRef.includes(`((${U.tgtMain}))`),
    'the second level must reference the source, or the inbound walk has nothing to walk');
  assert.strictEqual(times(U.srcKeep), 2, 'one id:: plus the second-level reference');
});

// --- the writes this run declares ----------------------------------------------

test('the declared writes are exactly the two pages the run mutates, and nothing else', () => {
  assert.deepStrictEqual(Object.keys(CG.DECLARED_WRITES).sort(),
    [`${CG.ANCHOR}.md`, `${CG.JOINING_PAGE}.md`].sort());
  // The pages the run reads but must never write.
  for (const page of [CG.BADGE_PAGE, CG.CYCLE_PAGE, CG.THIRD_PAGE,
                      CG.MAIN_TARGET_PAGE, CG.OUTGOING_PAGE, 'F28 Order Control']) {
    assert.ok(!CG.DECLARED_WRITES[`${page}.md`], `${page} must not be declared as written`);
  }
});

test('the expected end state is consistent with the texts the run will write', () => {
  const end = CG.EXPECTED_END[`${CG.JOINING_PAGE}.md`];
  assert.ok(end, 'the joining page must have a declared end state');
  for (const s of end.present) assert.ok(typeof s === 'string' && s.length > 0);
  assert.ok(end.absent.includes(T.srcJoinsBefore),
    'the fixture’s original joining text must be gone, and never come back');
  assert.ok(end.absentAfterBeingAdded.includes(T.srcJoinsAfter),
    'the added text must be named separately, so its absence is never mistaken for the first kind');
});

test('the combined fixture is the ordering fixture plus exactly six new pages', () => {
  const ro = new Set(Object.keys(RO.PAGES));
  const added = Object.keys(CG.PAGES).filter((f) => !ro.has(f));
  assert.deepStrictEqual(added.sort(), [
    `${CG.BADGE_PAGE}.md`, `${CG.CYCLE_PAGE}.md`, `${CG.THIRD_PAGE}.md`,
    `${CG.MAIN_TARGET_PAGE}.md`, `${CG.OUTGOING_PAGE}.md`, `${CG.JOINING_PAGE}.md`,
  ].sort());
  for (const f of added) assert.ok(!ro.has(f), `${f} must not shadow an ordering page`);
});

test('the control page is still named by nothing, including the new pages', () => {
  const others = Object.entries(CG.PAGES)
    .filter(([f]) => f !== 'F28 Order Control.md').map(([, b]) => b).join('\n');
  assert.ok(!others.includes('F28 Order Control'), 'nothing may point at it');
});