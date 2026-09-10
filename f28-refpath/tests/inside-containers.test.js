'use strict';
//
// The IDENTITY-SCOPED 'INSIDE' COMPARATOR's own semantics — the correction the
// supervisor review (2026-09-10) required, stated as executable claims.
//
// The comparator's contract, each clause asserted here against the PRODUCTION
// module (`checks/inside-containers.js` — the same code C5.14/C6.13/C7.4
// run), not against a copy:
//
//   * whole CONTAINER reordering is tolerated — OG assembles a multi-parent
//     group's containers from `(group-by :block/parent)`, a hash map whose
//     iteration order differs between renderings; swapping two intact
//     containers must therefore compare EQUAL;
//   * sibling/row order INSIDE a container is meaningful and a reversal with
//     nothing else changed must compare DIFFERENT — the first cut sorted
//     every row id and tuple and could not see this;
//   * duplicate occurrences are retained, not deduplicated: dropping or
//     duplicating an occurrence (or a whole container) must compare
//     DIFFERENT;
//   * changed parentage, role, level or breadcrumb path each compare
//     DIFFERENT on their own;
//   * a group whose crumb partition no longer aligns with its row tree is
//     REFUSED (fail-closed), never silently degraded.
//
// The fixtures mirror the combined graph's real reading structure (verified
// against run-5's retained evidence): a single-container journal group with
// two TRUE siblings under one parent, and a multi-parent group whose rows
// n2/n3 occur in BOTH of its containers. The builder compiles block-id
// parents into the section-wide INDICES RD.read actually reports, assigning
// them in DOM order exactly as a rendering would.
//
// Nothing here writes a graph, launches an application or reads one.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const IC = require(path.join(__dirname, '..', 'checks', 'inside-containers.js'));

// Compile a readable spec into an RD.read-shaped object: containers in DOM
// order, each row occurrence given a section-wide index, parents (block ids
// in the spec) rewritten to the index of their occurrence. Parent occurrences
// precede their children in every fixture here.
function compile(spec) {
  const rows = [];
  const groups = spec.map((g) => {
    const rowTree = [];
    const crumbs = g.containers.map((c) => {
      const ids = [];
      const where = new Map();
      for (const r of c.rows) {
        const i = rows.length;
        where.set(r.id, i);
        rows.push({ i, id: r.id });
        rowTree.push({ id: r.id, level: r.level, role: r.role,
                       parent: r.parent === null ? null : where.get(r.parent) });
        ids.push(r.id);
      }
      return { steps: c.steps, more: c.more || 0, ids };
    });
    return { ref: g.ref, rowTree, crumbs };
  });
  return { rows, groups };
}

// The two shapes the combined fixture really produces (run-5 evidence):
// journal — one container, j2/j3 TRUE siblings under j1;
// na      — two containers, n2/n3 recurring in both.
const BASE = () => [
  { ref: 'journal source', containers: [
    { steps: ['sep 10th, 2026'], more: 0, rows: [
      { id: 'j1', parent: null, level: null, role: 'direct' },
      { id: 'j2', parent: 'j1', level: '1', role: 'context' },
      { id: 'j3', parent: 'j1', level: '1', role: 'context' },
    ] },
  ] },
  { ref: 'na source', containers: [
    { steps: ['나 출처'], more: 1, rows: [
      { id: 'n1', parent: null, level: null, role: 'direct' },
      { id: 'n2', parent: 'n1', level: '1', role: 'context' },
      { id: 'n3', parent: 'n2', level: '2', role: 'context' },
    ] },
    { steps: [], more: 0, rows: [
      { id: 'n2', parent: null, level: null, role: 'direct' },
      { id: 'n3', parent: 'n2', level: '1', role: 'context' },
    ] },
  ] },
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const readOf = (spec) => compile(spec);
const diffOf = (a, b) => IC.insideCompare(IC.insideSetOf(readOf(a)), IC.insideSetOf(readOf(b)));

test('the baseline agrees with itself, and the model keeps rows ordered inside each container', () => {
  assert.deepStrictEqual(diffOf(BASE(), BASE()), []);
  const inside = IC.insideSetOf(readOf(BASE()));
  assert.deepStrictEqual(inside['journal source'].map((c) => c.rows.length), [3],
    'one container');
  assert.deepStrictEqual(inside['na source'].map((c) => c.rows.length), [3, 2],
    'two containers, the recurring rows kept per container');
  // The descriptor list is the DOM order — the ordered thing the old sorted
  // comparator threw away.
  assert.deepStrictEqual(inside['journal source'][0].rows, [
    'top<j1@null|direct', 'j1<j2@1|context', 'j1<j3@1|context',
  ]);
  assert.deepStrictEqual(inside['na source'][0].crumb, '나 출처::more=1');
});

test('NEGATIVE: reversing only sibling order inside one container FAILS the comparison', () => {
  const rev = BASE();
  const rows = rev[0].containers[0].rows;
  [rows[1], rows[2]] = [rows[2], rows[1]]; // [j1, j3, j2] — nothing else changes
  const diffs = diffOf(BASE(), rev);
  assert.ok(diffs.length > 0, 'a sibling-order-only reversal must not compare equal');
  assert.ok(diffs.some((d) => d.startsWith('journal source:')),
    `the diff must name the group: ${JSON.stringify(diffs)}`);
  // And it is genuinely the ORDER the model saw, not a side effect: the same
  // rows, parents, levels and roles, in the other sequence.
  const inside = IC.insideSetOf(readOf(rev));
  assert.deepStrictEqual(inside['journal source'][0].rows, [
    'top<j1@null|direct', 'j1<j3@1|context', 'j1<j2@1|context',
  ]);
});

test('POSITIVE: swapping two intact parent containers PASSES the comparison', () => {
  const swapped = clone(BASE());
  const na = swapped[1].containers;
  [na[0], na[1]] = [na[1], na[0]]; // the whole containers trade places
  assert.deepStrictEqual(diffOf(BASE(), swapped), [],
    'container order across containers is the documented OG nondeterminism and is tolerated');
  // The tolerance is exactly one granularity: the same swap with the rows
  // inside ONE container also reversed must FAIL.
  const both = clone(swapped);
  const rows = both[0].containers[0].rows;
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.ok(diffOf(BASE(), both).length > 0,
    'tolerating container swaps must not tolerate sibling reversal underneath');
});

test('NEGATIVE: an occurrence dropped or duplicated FAILS the comparison', () => {
  // dropped: n3 no longer occurs in the first na container
  const dropped = clone(BASE());
  dropped[1].containers[0].rows.splice(2, 1);
  assert.ok(diffOf(BASE(), dropped).some((d) => d.startsWith('na source:')),
    'a dropped occurrence must be detected');
  // duplicated: n3 occurs twice in the second na container
  const duplicated = clone(BASE());
  duplicated[1].containers[1].rows.push({ id: 'n3', parent: 'n2', level: '1', role: 'context' });
  assert.ok(diffOf(BASE(), duplicated).some((d) => d.startsWith('na source:')),
    'a duplicated occurrence must be detected, not deduplicated away');
  // a whole container duplicated
  const cloned = clone(BASE());
  cloned[1].containers.push(clone(cloned[1].containers[1]));
  assert.ok(diffOf(BASE(), cloned).some((d) => d.startsWith('na source:')),
    'a duplicated whole container must be detected');
});

test('NEGATIVE: changed parentage, role, level or breadcrumb path each FAIL alone', () => {
  const parentage = clone(BASE());
  parentage[0].containers[0].rows[2].parent = 'j2'; // j3 under j2, not j1
  assert.ok(diffOf(BASE(), parentage).length > 0, 'parentage is compared');
  const role = clone(BASE());
  role[1].containers[0].rows[1].role = 'changed';
  assert.ok(diffOf(BASE(), role).length > 0, 'the role label attribute is compared');
  const level = clone(BASE());
  level[1].containers[0].rows[2].level = '9';
  assert.ok(diffOf(BASE(), level).length > 0, 'the level is compared');
  const crumb = clone(BASE());
  crumb[0].containers[0].steps = ['a different path'];
  assert.ok(diffOf(BASE(), crumb).length > 0, 'the container\'s breadcrumb path is compared');
});

test('fail-closed: a group whose crumb partition does not align with its row tree is refused', () => {
  const misaligned = readOf(BASE());
  misaligned.groups[1].rowTree.splice(0, 1); // a row the crumbs still claim
  const diffs = IC.insideCompare(IC.insideSetOf(readOf(BASE())), IC.insideSetOf(misaligned));
  assert.ok(diffs.some((d) => d.includes('does not align')),
    'the comparison must refuse a broken partition, not weaken silently');
});