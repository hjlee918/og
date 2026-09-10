'use strict';
//
// THE IDENTITY-SCOPED 'INSIDE' COMPARATOR — shared by the combined workflow's
// cross-view comparisons (C5.14, C6.13, C7.4) and by its unit tests.
//
// What this replaces, and why. The first cut of `insideSetOf` SORTED every
// group's row ids, parent/level tuples and crumb strings, so that a
// sibling-order reversal inside one parent container compared EQUAL — the
// supervisor review (2026-09-10) called this a verification gap, not a product
// defect: OG's unstable ordering of SEPARATE parent containers justifies
// ignoring CONTAINER order, not the order of rows INSIDE each container.
//
// The model. OG assembles a multi-parent group's containers from
// `(group-by :block/parent)` in `->hiccup`'s custom-query branch, a hash map
// whose iteration order is whatever the current rendering produced; probe
// runs drew the 나/가 containers in different orders, and run 4 differed
// across re-entry/reorder re-renders. Each group is therefore reduced to a
// MULTISET OF CONTAINERS:
//
//   * container order ACROSS containers is the ONLY thing ignored — the
//     documented OG nondeterminism, tolerated where it was measured;
//   * inside each container, rows are retained as an ORDERED list —
//     sibling/row order within a container is meaningful and compared;
//   * duplicate occurrences are retained, not deduplicated: the same block
//     can legitimately appear in two containers (the 나 group's rows 0052 and
//     0053 occur in both of its containers), and a duplicated or dropped
//     occurrence must be detected on either side;
//   * each row occurrence carries its parentage (the parent occurrence's
//     BLOCK id), its own block id (membership), its level and its role label
//     attribute — so changed parentage, membership, nesting and roles each
//     fail the comparison on their own;
//   * each container carries its breadcrumb path (steps and elision count),
//     which is the container's own content, in the page's own page names.
//
// What is deliberately NOT compared: the row's prose `text`. RD.read takes it
// from `main.innerText`, which includes the TRANSLATED control words the row
// renders (the child-context button's words, the role label's words), so a
// comparison that must hold across languages (C7.4 switches the interface to
// Korean and back) cannot use it: prose text is language-dependent in this
// reading view. Prose-content changes are the run's declared-write
// accounting's job (the combined scenario's C12.4 reads the written files as
// content facts), not this comparator's.
//
// Fail-closed: the container partition is taken from the group's own
// `.blocks-container`s (RD.read's `crumbs`), aligned against its `rowTree` in
// DOM order. If a future rendering breaks that alignment, the group is
// reported as `unaligned` and every comparison involving it FAILS rather
// than silently degrading to a weaker model.
//
// RD.read itself (and its order-sensitive `insideOf`, load-bearing for the
// accepted 65/65 reforder scenario) is untouched.

const J = (v) => JSON.stringify(v);

// The parent key of a row occurrence: 'top' under no rendered parent, the
// parent occurrence's BLOCK id otherwise, '?' if the section-wide index does
// not resolve (never expected; still compared so it cannot pass silently).
function makeReadModel(r) {
  const byIndex = new Map((r.rows || []).map((x) => [x.i, x.id]));
  return (p) => (p === null || p === undefined ? 'top' : (byIndex.get(p) || '?'));
}

// Reduce one RD.read to { ref -> [container, ...] }. Each container is
// described by its crumb path and its ORDERED, duplicate-preserving rows.
function insideSetOf(r) {
  const parentKey = makeReadModel(r);
  const out = {};
  for (const g of r.groups || []) {
    const treeIds = (g.rowTree || []).map((x) => x.id);
    const flat = [];
    for (const c of g.crumbs || []) flat.push(...(c.ids || []));
    const aligned = flat.length === treeIds.length &&
      flat.every((id, i) => id === treeIds[i]);
    if (!aligned) {
      out[g.ref] = [{ unaligned: true, tree: treeIds, containers: flat }];
      continue;
    }
    const containers = [];
    let i = 0;
    for (const c of g.crumbs || []) {
      const rows = [];
      for (const id of (c.ids || [])) {
        const row = g.rowTree[i++];
        rows.push(`${parentKey(row.parent)}<${row.id}@${row.level}|${row.role}`);
      }
      containers.push({
        crumb: `${(c.steps || []).join('›')}::more=${c.more === undefined ? 0 : c.more}`,
        rows,
      });
    }
    out[g.ref] = containers;
  }
  return out;
}

// Compare two reductions. Returns a list of human-readable differences —
// EMPTY means the readings agree on everything the model compares: same
// groups, same containers as a multiset (duplicate containers counted), and
// within each container the same ordered rows, parentage, levels, roles and
// breadcrumb paths.
function insideCompare(a, b) {
  const diffs = [];
  const refs = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const ref of refs) {
    const ca = a[ref];
    const cb = b[ref];
    if (ca === undefined) { diffs.push(`${ref}: group is missing from the first reading`); continue; }
    if (cb === undefined) { diffs.push(`${ref}: group is missing from the second reading`); continue; }
    if ((ca[0] && ca[0].unaligned) || (cb[0] && cb[0].unaligned)) {
      diffs.push(`${ref}: container partition does not align with the row ` +
        `tree (crumbs vs rowTree) — comparison refused`);
      continue;
    }
    const count = (list) => {
      const m = new Map();
      for (const c of list) { const k = J(c); m.set(k, (m.get(k) || 0) + 1); }
      return m;
    };
    const ma = count(ca);
    const mb = count(cb);
    const changed = [...new Set([...ma.keys(), ...mb.keys()])]
      .filter((k) => (ma.get(k) || 0) !== (mb.get(k) || 0));
    if (changed.length) {
      const example = changed[0];
      diffs.push(`${ref}: ${changed.length} container(s) differ — ` +
        `first reading holds ${ca.length}, second ${cb.length}; ` +
        `e.g. ${example.length > 140 ? example.slice(0, 140) + '…' : example}`);
    }
  }
  return diffs;
}

module.exports = { insideSetOf, insideCompare };