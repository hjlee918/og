#!/usr/bin/env node
'use strict';
//
// The F28 CHILD-CONTEXT fixture.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched. This is a FRESH graph in
// its own uniquely named subfolder; `make-refpath-graph.js`'s graphs are not
// read, reused or referred to.
//
// WHAT THIS FIXTURE IS FOR.
//
// The source-path slices asked "where is this reference FROM?" — upward. This
// one asks the other half of RP3's "preserve surrounding parent and child
// context": when a page's LINKED REFERENCES list shows a referencing block,
// how much of what is written UNDER that block can the reader see?
//
// OG ALREADY SHOWS A REFERENCE'S CHILDREN. That was measured before anything
// was built (`f28-refctx-baseline-*.json`), and it is the reason this fixture
// looks the way it does:
//
//   `frontend.db.model/get-page-referenced-blocks` selects on
//   `:block/path-refs`, which a block inherits from every ancestor, so the
//   result set contains the blocks that name the page AND their descendants.
//   `references*` counts `total` from `:block/refs` (direct mentions only) and
//   attaches the rest as `:block/children`. The ordinary outline renderer draws
//   them: right hierarchy, right order, markup rendered, Korean and emoji
//   intact.
//
// WHERE IT STOPS, measured in the packaged application:
//
//   `frontend.modules.outliner.tree/non-consecutive-blocks->vec-tree` numbers a
//   row's own subtree from 1, and `editor-handler/block-default-collapsed?`
//   collapses a `:ref?` row once `:block/level` reaches
//   `state/get-ref-open-blocks-level` — 2 by default. `block-children` renders
//   nothing for a collapsed row, so everything below the SECOND level of a
//   reference's own subtree is absent from the page, not hidden on it. The
//   baseline run saw levels `[null, 1, 2]` and no others.
//
//   The only thing that reaches it is OG's fold control, and the same run
//   measured 47 of them in the section, 0 that can take focus and 0 with an
//   `href`. It is mouse-only, it appears on hover, and it says nothing about
//   how much is behind it.
//
// So this fixture is built so that every shape either side of THAT wall is a
// separate, falsifiable observation:
//
//   leaf      a referencing block with NO children at all — nothing may appear
//             here, in OG or afterwards;
//   two       two ordinary children, neither naming the page — OG shows both,
//             and nothing this batch does may add anything;
//   mixed     four children, exactly ONE of which names the page, plus
//             grandchildren — the whole subtree is inside OG's two levels, so
//             it is the case that must gain nothing at all;
//   wide      fourteen children at one level — again entirely inside OG's two
//             levels, and again must gain nothing;
//   sibA/sibB two referencing blocks under ONE parent: A has a branch behind
//             the wall and B has none, so a disclosure that leaks between rows
//             of the same group is caught;
//   deep      a six-level chain, so four levels sit behind the wall — and one
//             of them carries an image link, a macro and a page link, so
//             "a disclosed child is plain text, never a rendered block" is
//             measured instead of asserted;
//   batch     twelve blocks behind ONE collapsed row — more than one bounded
//             batch of ten, so a continuation is exercised rather than
//             described;
//   journal   a journal source with Korean and emoji, and a branch behind the
//             wall too.
//
// And the surrounding conditions the batch names: nested parents above every
// case, Korean and English throughout, and a control page that no case names
// and nothing may write.
//
// Nothing in the baseline run writes to this graph. Both scenarios assert the
// bytes are identical afterwards.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

// Stable identities, so a check can name the exact block it means rather than
// matching on text that another block might share.
const UUID = {
  anchor: '65f28c00-0000-4000-8000-000000000001',

  // --- 자식 출처 Child Source -------------------------------------------
  outer: '65f28c00-0000-4000-8000-0000000000a0',
  inner: '65f28c00-0000-4000-8000-0000000000a1',
  leaf: '65f28c00-0000-4000-8000-0000000000a2',
  two: '65f28c00-0000-4000-8000-0000000000a3',
  twoC1: '65f28c00-0000-4000-8000-0000000000a4',
  twoC2: '65f28c00-0000-4000-8000-0000000000a5',
  mixed: '65f28c00-0000-4000-8000-0000000000a6',
  mixedC1: '65f28c00-0000-4000-8000-0000000000a7',
  // the one child that names the page: OG attaches THIS one and no other
  mixedRef: '65f28c00-0000-4000-8000-0000000000a8',
  mixedRefC1: '65f28c00-0000-4000-8000-0000000000a9',
  mixedRefC2: '65f28c00-0000-4000-8000-0000000000aa',
  mixedC3: '65f28c00-0000-4000-8000-0000000000ab',
  // the child carrying markup
  markup: '65f28c00-0000-4000-8000-0000000000ac',

  shared: '65f28c00-0000-4000-8000-0000000000b0',
  sibA: '65f28c00-0000-4000-8000-0000000000b1',
  sibAC1: '65f28c00-0000-4000-8000-0000000000b2',
  sibAC2: '65f28c00-0000-4000-8000-0000000000b3',
  // sibA's branch behind the wall: a level-2 row with children of its own
  sibAG1: '65f28c00-0000-4000-8000-0000000000b7',
  sibAGG1: '65f28c00-0000-4000-8000-0000000000b8',
  sibAGG2: '65f28c00-0000-4000-8000-0000000000b9',
  sibB: '65f28c00-0000-4000-8000-0000000000b4',
  sibBC1: '65f28c00-0000-4000-8000-0000000000b5',
  sibBC2: '65f28c00-0000-4000-8000-0000000000b6',

  // --- 묶음 출처 Batch Source -------------------------------------------
  batchParent: '65f28c00-0000-4000-8000-0000000000f0',
  batch: '65f28c00-0000-4000-8000-0000000000f1',
  batchC1: '65f28c00-0000-4000-8000-0000000000f2',
  batchG1: '65f28c00-0000-4000-8000-0000000000f3',

  // --- 넓은 출처 Wide Source --------------------------------------------
  wideParent: '65f28c00-0000-4000-8000-0000000000c0',
  wide: '65f28c00-0000-4000-8000-0000000000c1',

  // --- 깊은 자식 Deep Children ------------------------------------------
  deepParent: '65f28c00-0000-4000-8000-0000000000d0',
  deep: '65f28c00-0000-4000-8000-0000000000d1',
  // the six levels below `deep`, outermost first; d2 is the row OG collapses
  deepD1: '65f28c00-0000-4000-8000-0000000000d2',
  deepD2: '65f28c00-0000-4000-8000-0000000000d3',
  deepD3: '65f28c00-0000-4000-8000-0000000000d4',
  deepD4: '65f28c00-0000-4000-8000-0000000000d5',
  deepD5: '65f28c00-0000-4000-8000-0000000000d6',
  deepD6: '65f28c00-0000-4000-8000-0000000000d7',

  // --- the journal ------------------------------------------------------
  jTop: '65f28c00-0000-4000-8000-0000000000e0',
  jParent: '65f28c00-0000-4000-8000-0000000000e1',
  journal: '65f28c00-0000-4000-8000-0000000000e2',
  jC1: '65f28c00-0000-4000-8000-0000000000e3',
  jC1a: '65f28c00-0000-4000-8000-0000000000e6',
  jC1a1: '65f28c00-0000-4000-8000-0000000000e7',
  jC1a2: '65f28c00-0000-4000-8000-0000000000e8',
  jC2: '65f28c00-0000-4000-8000-0000000000e4',
  jC3: '65f28c00-0000-4000-8000-0000000000e5',
};

const ANCHOR = '맥락 대상 Context Anchor';
const FILTER_TAG = '맥락 필터 Context Filter';

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "${ANCHOR}"}}
`;

// --- the text each block carries -------------------------------------------
//
// Every string is distinctive and says what it is, so a disclosure that shows
// the wrong child, or the right children in the wrong order or under the wrong
// row, is visible in the observation rather than inferred from a count.

const TEXT = {
  outer: '상위 맥락 · Outer parent of the child-context cases',
  inner: '안쪽 맥락 · Inner parent — the breadcrumb OG already draws',

  leaf: `자식 없는 참조 — nothing is written under this one [[${ANCHOR}]] 🍃`,

  two: `자식 둘인 참조 — two ordinary children below [[${ANCHOR}]] 🌱`,
  twoC1: '자식 1 · 첫 번째 — the first thing written under it',
  twoC2: '자식 2 · 두 번째 — the second thing written under it',

  mixed: `섞인 참조 — four children, exactly one of them names the page [[${ANCHOR}]] 🧩`,
  mixedC1: '섞인 자식 1 · 페이지를 언급하지 않음 — says nothing about the page',
  mixedRef: `섞인 자식 2 · 이 자식은 페이지를 언급함 [[${ANCHOR}]] — OG attaches THIS one`,
  mixedRefC1: '손자 1 · 언급한 자식의 자식 — under the child that names the page',
  mixedRefC2: '손자 2 · 언급한 자식의 두 번째 자식',
  mixedC3: '섞인 자식 3 · 역시 언급하지 않음 — also says nothing about the page',
  markup: '섞인 자식 4 · ![그림 picture](../assets/f28-refctx-dot.png) ' +
          `and {{query (todo TODO)}} and a link to [[${FILTER_TAG}]] 🖼️`,

  shared: '형제 부모 · One parent, two referencing blocks under it',
  sibA: `형제 참조 A — 같은 부모 아래 첫 번째 [[${ANCHOR}]] 🅰️`,
  sibAC1: 'A의 자식 1 · only A has this one',
  sibAG1: 'A의 손자 · a level-two row WITH children of its own',
  sibAGG1: 'A의 증손 1 · behind the wall, under A only',
  sibAGG2: 'A의 증손 2 · behind the wall, under A only',
  sibAC2: 'A의 자식 2 · A의 두 번째',
  sibB: `형제 참조 B — 같은 부모 아래 두 번째 [[${ANCHOR}]] 🅱️`,
  sibBC1: 'B의 자식 1 · only B has this one',
  sibBC2: 'B의 자식 2 · B의 두 번째',

  wideParent: '넓은 부모 · Wide parent',
  wide: `자식이 열넷인 참조 — fourteen children, past one batch [[${ANCHOR}]] 📚`,

  batchParent: '묶음 부모 · Batch parent',
  batch: `한 줄 뒤에 열둘인 참조 — twelve blocks behind one row [[${ANCHOR}]] 📦`,
  batchC1: '묶음 자식 · the level-one row, which OG shows',
  batchG1: '묶음 손자 · a level-two row with twelve children behind it',

  deepParent: '깊은 부모 · Deep parent',
  deep: `자손이 깊은 참조 — six levels below it [[${ANCHOR}]] 🪜`,

  jTop: '오늘의 기록 · journal root',
  jParent: '아침 정리 · Morning review',
  journal: `저널에서 온 참조 — 자식 셋 [[${ANCHOR}]] 📅`,
  jC1: '저널 자식 1 · 아침에 적은 것 — written in the morning',
  jC1a: '저널 손자 · a level-two row with two children behind it 🌱',
  jC1a1: '저널 증손 1 · behind the wall, in a journal 🌙',
  jC1a2: '저널 증손 2 · behind the wall, in a journal ✨',
  jC2: '저널 자식 2 · 점심에 적은 것 — written at noon 🍚',
  jC3: '저널 자식 3 · 저녁에 적은 것 — written in the evening 🌙',
};

/** The twelve blocks behind `batchG1`, in outline order. */
const BATCH_CHILDREN = Array.from({ length: 12 }, (_, i) =>
  `묶음 증손 ${i + 1} · hidden grandchild ${i + 1} of twelve`);

/** The fourteen children of `wide`, in outline order. */
const WIDE_CHILDREN = Array.from({ length: 14 }, (_, i) =>
  `넓은 자식 ${i + 1} · child ${i + 1} of fourteen`);

/**
 * The six levels below `deep`, outermost first. Level 5 is the last one
 * `f27-children/max-depth` allows to be opened, so level 6 is the one behind
 * the depth safeguard.
 */
const DEEP_LEVELS = Array.from({ length: 6 }, (_, i) => {
  const n = i + 1;
  // Level 3 is BEHIND the wall, and carries everything a rich renderer would
  // expand. `markup` (which OG does show) is its visible twin, so the two
  // presentations can be compared in one run.
  if (n === 3) {
    return `깊은 자손 3 · ![숨은 그림 hidden picture](../assets/f28-refctx-dot.png) ` +
           `and {{query (todo TODO)}} and a link to [[${FILTER_TAG}]] 🕳️`;
  }
  return `깊은 자손 ${n} · descendant level ${n} of six`;
});

/**
 * What is written under each referencing block, declared here rather than
 * counted in the scenario, so the scenario cannot quietly agree with whatever
 * it happened to render.
 *
 *   own        immediate children in the OUTLINE
 *   namesPage  immediate children that DIRECTLY reference the page — OG's list
 *              is selected on `:block/path-refs` (inherited from every
 *              ancestor) and COUNTED on `:block/refs` (direct mentions only)
 *   descend    total descendants at every depth
 *   maxDepth   how many levels below the row the deepest descendant sits
 *   ogShows    descendants OG actually draws: its own subtree levels 1 and 2,
 *              because it collapses at `ref/default-open-blocks-level` (2)
 *   behind     descend - ogShows: what is absent from the page altogether
 */
const CHILDREN = {
  leaf:    { own: 0,  namesPage: 0, descend: 0,  maxDepth: 0, ogShows: 0,  behind: 0 },
  two:     { own: 2,  namesPage: 0, descend: 2,  maxDepth: 1, ogShows: 2,  behind: 0 },
  mixed:   { own: 4,  namesPage: 1, descend: 6,  maxDepth: 2, ogShows: 6,  behind: 0 },
  mixedRef:{ own: 2,  namesPage: 0, descend: 2,  maxDepth: 1, ogShows: 2,  behind: 0 },
  sibA:    { own: 2,  namesPage: 0, descend: 5,  maxDepth: 3, ogShows: 3,  behind: 2 },
  sibB:    { own: 2,  namesPage: 0, descend: 2,  maxDepth: 1, ogShows: 2,  behind: 0 },
  wide:    { own: 14, namesPage: 0, descend: 14, maxDepth: 1, ogShows: 14, behind: 0 },
  deep:    { own: 1,  namesPage: 0, descend: 6,  maxDepth: 6, ogShows: 2,  behind: 4 },
  batch:   { own: 1,  namesPage: 0, descend: 14, maxDepth: 3, ogShows: 2,  behind: 12 },
  journal: { own: 3,  namesPage: 0, descend: 6,  maxDepth: 3, ogShows: 4,  behind: 2 },
};

/**
 * Every row OG COLLAPSES inside this list, and what is behind each of them.
 *
 * This is the whole subject of the batch, so it is declared rather than
 * discovered: a row at `:block/level` 2 of a reference's own subtree that has
 * children of its own. `hidden` counts every block behind it, at every depth.
 */
const WALL = {
  sibAG1: { under: 'sibA',    hidden: 2,  levels: 1,
            why: 'a branch behind the wall in a group whose OTHER reference has none' },
  deepD2: { under: 'deep',    hidden: 4,  levels: 4,
            why: 'a chain, so a bounded disclosure has to keep going downward' },
  batchG1:{ under: 'batch',   hidden: 12, levels: 1,
            why: 'more than one bounded batch of ten' },
  jC1a:   { under: 'journal', hidden: 2,  levels: 1,
            why: 'a journal source, Korean and emoji' },
};


/**
 * How many BLOCK ancestors each referencing block has — the parent context OG
 * already draws, which this batch must leave exactly as it is.
 */
const DEPTH = {
  leaf:    { depth: 2, visible: 2, hidden: 0 },
  two:     { depth: 2, visible: 2, hidden: 0 },
  mixed:   { depth: 2, visible: 2, hidden: 0 },
  mixedRef:{ depth: 3, visible: 3, hidden: 0 },
  sibA:    { depth: 1, visible: 1, hidden: 0 },
  sibB:    { depth: 1, visible: 1, hidden: 0 },
  wide:    { depth: 1, visible: 1, hidden: 0 },
  deep:    { depth: 1, visible: 1, hidden: 0 },
  batch:   { depth: 1, visible: 1, hidden: 0 },
  journal: { depth: 2, visible: 2, hidden: 0 },
};

/**
 * The immediate children of each case, in outline order — what a reader asking
 * "what is written under this?" should end up seeing.
 */
const KIDS = {
  leaf: [],
  two: [TEXT.twoC1, TEXT.twoC2],
  mixed: [TEXT.mixedC1, TEXT.mixedRef, TEXT.mixedC3, TEXT.markup],
  mixedRef: [TEXT.mixedRefC1, TEXT.mixedRefC2],
  sibA: [TEXT.sibAC1, TEXT.sibAC2],
  sibB: [TEXT.sibBC1, TEXT.sibBC2],
  wide: WIDE_CHILDREN,
  deep: [DEEP_LEVELS[0]],
  batch: [TEXT.batchC1],
  journal: [TEXT.jC1, TEXT.jC2, TEXT.jC3],
};

/**
 * What a bounded disclosure must do behind `batchG1`, press by press. Declared
 * here so the scenario cannot agree with whatever it rendered: `f27-children`'s
 * batch is 10 and its continuation adds another 10, which covers all twelve.
 */
const BATCH_PRESSES = [
  { press: 1, shows: 10, remaining: 2, continues: true },
  { press: 2, shows: 12, remaining: 0, continues: false },
];

const CHILD_PAGE = '자식 출처 Child Source';
const WIDE_PAGE = '넓은 출처 Wide Source';
const BATCH_PAGE = '묶음 출처 Batch Source';
const DEEP_PAGE = '깊은 자식 Deep Children';

const PAGES = {
  [`${ANCHOR}.md`]: `- # ${ANCHOR}
  id:: ${UUID.anchor}
- 이 페이지는 여러 곳에서 참조됩니다. This page is referenced from several places.
- Each referencing block has a different amount written UNDER it. Nothing on
  this page describes the list below it.
`,

  [`${CHILD_PAGE}.md`]: `- ${TEXT.outer}
  id:: ${UUID.outer}
\t- ${TEXT.inner}
\t  id:: ${UUID.inner}
\t\t- ${TEXT.leaf}
\t\t  id:: ${UUID.leaf}
\t\t- ${TEXT.two}
\t\t  id:: ${UUID.two}
\t\t\t- ${TEXT.twoC1}
\t\t\t  id:: ${UUID.twoC1}
\t\t\t- ${TEXT.twoC2}
\t\t\t  id:: ${UUID.twoC2}
\t\t- ${TEXT.mixed}
\t\t  id:: ${UUID.mixed}
\t\t\t- ${TEXT.mixedC1}
\t\t\t  id:: ${UUID.mixedC1}
\t\t\t- ${TEXT.mixedRef}
\t\t\t  id:: ${UUID.mixedRef}
\t\t\t\t- ${TEXT.mixedRefC1}
\t\t\t\t  id:: ${UUID.mixedRefC1}
\t\t\t\t- ${TEXT.mixedRefC2}
\t\t\t\t  id:: ${UUID.mixedRefC2}
\t\t\t- ${TEXT.mixedC3}
\t\t\t  id:: ${UUID.mixedC3}
\t\t\t- ${TEXT.markup}
\t\t\t  id:: ${UUID.markup}
- ${TEXT.shared}
  id:: ${UUID.shared}
\t- ${TEXT.sibA}
\t  id:: ${UUID.sibA}
\t\t- ${TEXT.sibAC1}
\t\t  id:: ${UUID.sibAC1}
\t\t\t- ${TEXT.sibAG1}
\t\t\t  id:: ${UUID.sibAG1}
\t\t\t\t- ${TEXT.sibAGG1}
\t\t\t\t  id:: ${UUID.sibAGG1}
\t\t\t\t- ${TEXT.sibAGG2}
\t\t\t\t  id:: ${UUID.sibAGG2}
\t\t- ${TEXT.sibAC2}
\t\t  id:: ${UUID.sibAC2}
\t- ${TEXT.sibB}
\t  id:: ${UUID.sibB}
\t\t- ${TEXT.sibBC1}
\t\t  id:: ${UUID.sibBC1}
\t\t- ${TEXT.sibBC2}
\t\t  id:: ${UUID.sibBC2}
`,

  [`${WIDE_PAGE}.md`]: `- ${TEXT.wideParent}
  id:: ${UUID.wideParent}
\t- ${TEXT.wide}
\t  id:: ${UUID.wide}
${WIDE_CHILDREN.map((t) => `\t\t- ${t}`).join('\n')}
`,

  [`${BATCH_PAGE}.md`]: `- ${TEXT.batchParent}
  id:: ${UUID.batchParent}
\t- ${TEXT.batch}
\t  id:: ${UUID.batch}
\t\t- ${TEXT.batchC1}
\t\t  id:: ${UUID.batchC1}
\t\t\t- ${TEXT.batchG1}
\t\t\t  id:: ${UUID.batchG1}
${BATCH_CHILDREN.map((t) => `\t\t\t\t- ${t}`).join('\n')}
`,

  [`${DEEP_PAGE}.md`]: `- ${TEXT.deepParent}
  id:: ${UUID.deepParent}
\t- ${TEXT.deep}
\t  id:: ${UUID.deep}
${DEEP_LEVELS.map((t, i) => `${'\t'.repeat(i + 2)}- ${t}\n${'\t'.repeat(i + 2)}  id:: ${UUID[`deepD${i + 1}`]}`).join('\n')}
`,

  [`${FILTER_TAG}.md`]: `- # ${FILTER_TAG}
- 이 페이지는 자식 블록에서만 링크됩니다.
- It is linked from children only — one OG shows and one behind the wall.
`,

  'F28 Context Control.md': `- # F28 Context Control
- 이 페이지는 이번 실행에서 한 번도 바뀌지 않습니다. Nothing in this run changes this page.
- No case names it, and no reference points into it.
- Its bytes are compared before and after, and must be identical.
`,
};

/** The page nothing in this run may change. */
const CONTROL_FILE = 'pages/F28 Context Control.md';

/**
 * The one asset the markup child names, and why it is REAL.
 *
 * The first reading of this fixture named a file that did not exist. OG renders
 * a linked reference's children through its ordinary outline renderer, so the
 * image was actually requested, and Chromium reported
 * `net::ERR_FILE_NOT_FOUND` — a genuine window error that the conservative
 * classifier correctly refused to explain away. The fix is to make the fixture
 * stop provoking it rather than to widen any exemption: a 1x1 PNG, written by
 * this generator, inside this run's own graph.
 */
const ASSET_FILE = 'assets/f28-refctx-dot.png';
const ASSET_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM' +
  'IQAAAABJRU5ErkJggg==', 'base64');

function journalName(d = new Date()) {
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_` +
         `${String(d.getDate()).padStart(2, '0')}.md`;
}

function journalBody() {
  return `- ${TEXT.jTop}
  id:: ${UUID.jTop}
\t- ${TEXT.jParent}
\t  id:: ${UUID.jParent}
\t\t- ${TEXT.journal}
\t\t  id:: ${UUID.journal}
\t\t\t- ${TEXT.jC1}
\t\t\t  id:: ${UUID.jC1}
\t\t\t\t- ${TEXT.jC1a}
\t\t\t\t  id:: ${UUID.jC1a}
\t\t\t\t\t- ${TEXT.jC1a1}
\t\t\t\t\t  id:: ${UUID.jC1a1}
\t\t\t\t\t- ${TEXT.jC1a2}
\t\t\t\t\t  id:: ${UUID.jC1a2}
\t\t\t- ${TEXT.jC2}
\t\t\t  id:: ${UUID.jC2}
\t\t\t- ${TEXT.jC3}
\t\t\t  id:: ${UUID.jC3}
`;
}

/** Every referencing block in the fixture — what the list's count must match. */
const REFERENCING = ['leaf', 'two', 'mixed', 'mixedRef', 'sibA', 'sibB',
                     'wide', 'deep', 'batch', 'journal'];

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f28-refctx-${opts.kind || 'run'}-${stamp}`;
  const graph = B.assertInsideAllowedRoot('refctx graph',
                                          path.join(B.allowedRootReal(), name));

  if (fs.existsSync(graph)) {
    throw new B.BoundaryViolation(`${graph} already exists; refusing to reuse another run`);
  }
  fs.mkdirSync(graph, { recursive: false });

  for (const sub of ['logseq', 'pages', 'journals', 'assets']) {
    fs.mkdirSync(B.assertInsideAllowedRoot('graph subdir', path.join(graph, sub)));
  }
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph config', path.join(graph, 'logseq', 'config.edn')), CONFIG);
  for (const [file, body] of Object.entries(PAGES)) {
    fs.writeFileSync(
      B.assertInsideAllowedRoot('graph page', path.join(graph, 'pages', file)), body);
  }
  const jn = journalName();
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph journal', path.join(graph, 'journals', jn)), journalBody());
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph asset', path.join(graph, ASSET_FILE)), ASSET_BYTES);

  return { graph, name, pages: Object.keys(PAGES).length, journal: `journals/${jn}`,
           asset: ASSET_FILE, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('refctx graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  build, readPage, PAGES, TEXT, UUID, CONFIG, CHILDREN, DEPTH, KIDS, WALL,
  WIDE_CHILDREN, BATCH_CHILDREN, DEEP_LEVELS, BATCH_PRESSES, REFERENCING,
  CONTROL_FILE, ASSET_FILE, ASSET_BYTES, ANCHOR, FILTER_TAG,
  CHILD_PAGE, WIDE_PAGE, BATCH_PAGE, DEEP_PAGE, journalName, journalBody,
};

if (require.main === module) {
  const r = build();
  console.log(`[refctx-graph] ${r.graph}`);
  console.log(`[refctx-graph] ${r.pages} pages + ${r.journal}; nothing writes them afterwards`);
}
