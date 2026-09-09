#!/usr/bin/env node
'use strict';
//
// The F28 SOURCE-PATH fixture.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched.
//
// WHAT THIS FIXTURE IS FOR.
//
// One question: when a page's LINKED REFERENCES list shows a referencing block,
// how much of that block's position in its own outline can the reader see?
//
// OG groups the list by source page and then by the referencing block's PARENT,
// and renders one breadcrumb per parent group through
// `frontend.components.block/breadcrumb`, which is asked for `:level-limit 3`.
// That function reads at most `level-limit + 1` ancestors, shows the nearest
// three, and emits a bare `⋯` when a fourth came back.
//
// So the shapes that matter are exactly the ones either side of that boundary,
// and this fixture is built to make each of them a separate, falsifiable
// observation rather than one general impression:
//
//   depth 0   a block written at the top level of its page — no breadcrumb at
//             all, which must stay true;
//   depth 2   under the limit — the whole path is already shown, and nothing
//             this feature does may add a control there;
//   depth 3   EXACTLY the limit — still complete, still no `⋯`;
//   depth 4   one more than the limit — `⋯` appears, and exactly ONE ancestor
//             is behind it, so a disclosure that reports the wrong number
//             cannot pass by accident;
//   depth 7   four ancestors behind the `⋯`, on two branches that share their
//             upper levels, so a path that is merely "deep" is distinguishable
//             from the CORRECT path;
//   depth 4   with every ancestor carrying the SAME TEXT, so a disclosure that
//             shows ancestors without their order or position reads as four
//             identical rows and cannot be called a path.
//
// And the surrounding conditions the supervisor named:
//
//   * TWO references from ONE source page under one parent (one group, two
//     blocks) and further references from other parents of the same page;
//   * a SECOND source page;
//   * a JOURNAL as a third source, deep enough to elide;
//   * Korean and English throughout, plus emoji;
//   * a page reference written in an ANCESTOR, which is what OG's linked-
//     reference FILTER matches on, so filtering can be exercised against a
//     path the reader can also open;
//   * a control page that no case names and nothing may write.
//
// Nothing in the baseline run writes to this graph. The scenario asserts the
// bytes are identical afterwards.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

// Stable identities, so a check can name the exact block it means rather than
// matching on text that another block might share.
const UUID = {
  anchor: '65f28a00-0000-4000-8000-000000000001',

  // depth 7, two leaves under one parent
  deepA: '65f28a00-0000-4000-8000-0000000000a1',
  deepB: '65f28a00-0000-4000-8000-0000000000a2',
  deepParent: '65f28a00-0000-4000-8000-0000000000a7',
  deepTop: '65f28a00-0000-4000-8000-0000000000a8',

  // depth 6, a different branch that shares the upper five levels
  branch: '65f28a00-0000-4000-8000-0000000000b1',

  // the boundary cases
  flat: '65f28a00-0000-4000-8000-0000000000c0',
  two: '65f28a00-0000-4000-8000-0000000000c2',
  three: '65f28a00-0000-4000-8000-0000000000c3',
  four: '65f28a00-0000-4000-8000-0000000000c4',

  // a second source page
  other: '65f28a00-0000-4000-8000-0000000000d1',
  same: '65f28a00-0000-4000-8000-0000000000d2',

  // the journal
  journal: '65f28a00-0000-4000-8000-0000000000e1',

  // depth 14, on its own page: deeper than ONE batch, so the continuation
  // control is exercised rather than described. One of its elided levels
  // carries an image link and a macro, so "a step is plain text, never a
  // rendered block" can be measured instead of asserted.
  deepest: '65f28a00-0000-4000-8000-0000000000f1',
};

const ANCHOR = '연결 대상 Anchor';
const FILTER_TAG = '필터 태그 Filter Tag';

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "${ANCHOR}"}}
`;

// --- the text each level carries -------------------------------------------
//
// Every ancestor string is distinctive EXCEPT the deliberate `same` chain, and
// each names its own depth in words, so a disclosure that shows the wrong
// ancestor, or the right ancestors in the wrong order, is visible in the
// observation rather than inferred from a count.

const TEXT = {
  // depth 7 chain on the deep source page
  d1: 'L1 · 최상위 조상 — the outermost level',
  d2: 'L2 · 두 번째 조상 — second from the top',
  // The page link sits HERE, on a level OG elides for BOTH deep branches, so
  // the filter and the disclosure concern the same otherwise-invisible part of
  // a path. It was on L5 first, which OG shows for both — asserted, and caught,
  // by `tests/graph-fixture.test.js`.
  d3: `L3 · 세 번째 조상 — carries a page link [[${FILTER_TAG}]]`,
  d4: 'L4 · 네 번째 조상 — fourth from the top',
  d5: 'L5 · 다섯 번째 조상 — fifth from the top',
  d6: 'L6 · 여섯 번째 조상 — sixth from the top',
  d7: 'L7 · 일곱 번째 조상 — the nearest parent of the deep references',
  deepA: `깊은 참조 A — 일곱 조상 아래 [[${ANCHOR}]] 🎯`,
  deepB: `깊은 참조 B — 같은 부모, 두 번째 [[${ANCHOR}]] 🎯`,

  // a sibling branch under L5, so the upper five levels are shared
  b6: 'L6b · 여섯 번째 조상 (다른 가지) — the other branch',
  branch: `다른 가지 참조 — 여섯 조상 아래 [[${ANCHOR}]] 🌿`,

  // boundary cases, on the same page
  flat: `얕은 참조 — 최상위에서 바로 [[${ANCHOR}]] (no ancestors at all)`,
  t2a: '둘 · 바깥 조상 — outer of two',
  t2b: '둘 · 안쪽 조상 — inner of two',
  two: `조상이 둘인 참조 [[${ANCHOR}]] (under the limit)`,
  t3a: '셋 · 첫 번째 조상',
  t3b: '셋 · 두 번째 조상',
  t3c: '셋 · 세 번째 조상',
  three: `조상이 정확히 셋인 참조 [[${ANCHOR}]] (exactly the limit)`,
  t4a: '넷 · 첫 번째 조상 — the one OG hides',
  t4b: '넷 · 두 번째 조상',
  t4c: '넷 · 세 번째 조상',
  t4d: '넷 · 네 번째 조상',
  four: `조상이 정확히 넷인 참조 [[${ANCHOR}]] (one past the limit)`,

  // the second source page
  o1: '프로젝트 · Project',
  o2: '회의 · Meeting',
  o3: '결정 · Decision',
  o4: '세부 · Detail',
  other: `다른 페이지의 참조 — 네 조상 아래 [[${ANCHOR}]] 🔗`,
  sameName: '같은 이름 Same Name',
  same: `이름이 같은 조상 아래의 참조 [[${ANCHOR}]] ♻️`,

  // the journal
  j1: '오늘의 기록 — journal root',
  j2: '아침 · Morning',
  j3: '정리 · Review',
  j4: '기록 · Note',
  journal: `저널에서 온 참조 — 네 조상 아래 [[${ANCHOR}]] 📅`,

  // the 14-level chain
  x4: '깊이 4 · 조상 — ![그림 picture](../assets/f28-not-a-real-file.png) ' +
      'and {{query (todo TODO)}} written in an ANCESTOR',
  deepest: `가장 깊은 참조 — 열네 조상 아래 [[${ANCHOR}]] 🪜`,
};

/**
 * The 14 levels above `deepest`, outermost first.
 *
 * Written as a generated list rather than fourteen hand-typed constants: what
 * matters is that each is distinctive and that level 4 is the one carrying
 * markup, and a generated list cannot drift out of step with the markdown that
 * is generated from the same array.
 */
const DEEPEST_LEVELS = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  if (n === 4) return TEXT.x4;
  return `깊이 ${n} · 조상 — level ${n} of fourteen`;
});

/**
 * How many BLOCK ancestors each referencing block has, declared here rather
 * than counted in the scenario, so the scenario cannot quietly agree with
 * whatever it happened to render.
 *
 * `visible` is what OG's breadcrumb shows (`level-limit` 3), and `hidden` is
 * what its bare `⋯` stands for. `hidden` 0 means no `⋯` at all.
 */
const DEPTH = {
  flat:   { depth: 0, visible: 0, hidden: 0 },
  two:    { depth: 2, visible: 2, hidden: 0 },
  three:  { depth: 3, visible: 3, hidden: 0 },
  four:   { depth: 4, visible: 3, hidden: 1 },
  deepA:  { depth: 7, visible: 3, hidden: 4 },
  deepB:  { depth: 7, visible: 3, hidden: 4 },
  branch: { depth: 6, visible: 3, hidden: 3 },
  other:  { depth: 4, visible: 3, hidden: 1 },
  same:   { depth: 4, visible: 3, hidden: 1 },
  journal:{ depth: 4, visible: 3, hidden: 1 },
  deepest:{ depth: 14, visible: 3, hidden: 11 },
};

/**
 * The complete ancestor path of each referencing block, OUTERMOST FIRST — what
 * a reader asking "where does this come from?" should end up seeing.
 */
const PATHS = {
  deepA:  [TEXT.d1, TEXT.d2, TEXT.d3, TEXT.d4, TEXT.d5, TEXT.d6, TEXT.d7],
  deepB:  [TEXT.d1, TEXT.d2, TEXT.d3, TEXT.d4, TEXT.d5, TEXT.d6, TEXT.d7],
  branch: [TEXT.d1, TEXT.d2, TEXT.d3, TEXT.d4, TEXT.d5, TEXT.b6],
  four:   [TEXT.t4a, TEXT.t4b, TEXT.t4c, TEXT.t4d],
  three:  [TEXT.t3a, TEXT.t3b, TEXT.t3c],
  two:    [TEXT.t2a, TEXT.t2b],
  flat:   [],
  other:  [TEXT.o1, TEXT.o2, TEXT.o3, TEXT.o4],
  same:   [TEXT.sameName, TEXT.sameName, TEXT.sameName, TEXT.sameName],
  journal:[TEXT.j1, TEXT.j2, TEXT.j3, TEXT.j4],
  deepest: DEEPEST_LEVELS,
};

/**
 * What the disclosure must do on the 14-deep path, press by press.
 *
 * Declared here so the scenario cannot agree with whatever it rendered. The
 * first press loads `og-visible-levels + batch` = 11 levels, of which OG is
 * already showing 3; the second asks for 19, reaches the page, and completes.
 */
const DEEPEST_PRESSES = [
  { press: 1, shows: 8, complete: false, continues: true },
  { press: 2, shows: 11, complete: true, continues: false },
];

const DEEP_PAGE = '깊은 출처 Deep Source';
const OTHER_PAGE = '다른 출처 Other Source';
const DEEPEST_PAGE = '가장 깊은 출처 Deepest Source';

const PAGES = {
  [`${ANCHOR}.md`]: `- # ${ANCHOR}
  id:: ${UUID.anchor}
- 이 페이지는 여러 곳에서 참조됩니다. This page is referenced from several places, at several depths.
- The list below the page is OG's own linked-references section. Nothing on this page describes it.
`,

  [`${DEEP_PAGE}.md`]: `- ${TEXT.d1}
  id:: ${UUID.deepTop}
\t- ${TEXT.d2}
\t\t- ${TEXT.d3}
\t\t\t- ${TEXT.d4}
\t\t\t\t- ${TEXT.d5}
\t\t\t\t\t- ${TEXT.d6}
\t\t\t\t\t\t- ${TEXT.d7}
\t\t\t\t\t\t  id:: ${UUID.deepParent}
\t\t\t\t\t\t\t- ${TEXT.deepA}
\t\t\t\t\t\t\t  id:: ${UUID.deepA}
\t\t\t\t\t\t\t- ${TEXT.deepB}
\t\t\t\t\t\t\t  id:: ${UUID.deepB}
\t\t\t\t\t- ${TEXT.b6}
\t\t\t\t\t\t- ${TEXT.branch}
\t\t\t\t\t\t  id:: ${UUID.branch}
- ${TEXT.flat}
  id:: ${UUID.flat}
- ${TEXT.t2a}
\t- ${TEXT.t2b}
\t\t- ${TEXT.two}
\t\t  id:: ${UUID.two}
- ${TEXT.t3a}
\t- ${TEXT.t3b}
\t\t- ${TEXT.t3c}
\t\t\t- ${TEXT.three}
\t\t\t  id:: ${UUID.three}
- ${TEXT.t4a}
\t- ${TEXT.t4b}
\t\t- ${TEXT.t4c}
\t\t\t- ${TEXT.t4d}
\t\t\t\t- ${TEXT.four}
\t\t\t\t  id:: ${UUID.four}
`,

  [`${OTHER_PAGE}.md`]: `- ${TEXT.o1}
\t- ${TEXT.o2}
\t\t- ${TEXT.o3}
\t\t\t- ${TEXT.o4}
\t\t\t\t- ${TEXT.other}
\t\t\t\t  id:: ${UUID.other}
- ${TEXT.sameName}
\t- ${TEXT.sameName}
\t\t- ${TEXT.sameName}
\t\t\t- ${TEXT.sameName}
\t\t\t\t- ${TEXT.same}
\t\t\t\t  id:: ${UUID.same}
`,

  [`${FILTER_TAG}.md`]: `- # ${FILTER_TAG}
- 이 페이지는 깊은 경로의 조상 하나에서만 링크됩니다.
- It is linked from ONE ancestor inside the deep path, which is what OG's
  linked-reference filter matches on.
`,

  [`${DEEPEST_PAGE}.md`]: DEEPEST_LEVELS
    .map((t, i) => `${'\t'.repeat(i)}- ${t}`)
    .concat([`${'\t'.repeat(14)}- ${TEXT.deepest}`,
             `${'\t'.repeat(14)}  id:: ${UUID.deepest}`])
    .join('\n') + '\n',

  'F28 Control.md': `- # F28 Control
- 이 페이지는 이번 실행에서 한 번도 바뀌지 않습니다. Nothing in this run changes this page.
- No case names it, and no reference points into it.
- Its bytes are compared before and after, and must be identical.
`,
};

/** The page nothing in this run may change. */
const CONTROL_FILE = 'pages/F28 Control.md';

function journalName(d = new Date()) {
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_` +
         `${String(d.getDate()).padStart(2, '0')}.md`;
}

function journalBody() {
  return `- ${TEXT.j1}
\t- ${TEXT.j2}
\t\t- ${TEXT.j3}
\t\t\t- ${TEXT.j4}
\t\t\t\t- ${TEXT.journal}
\t\t\t\t  id:: ${UUID.journal}
`;
}

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f28-refpath-${opts.kind || 'run'}-${stamp}`;
  const graph = B.assertInsideAllowedRoot('refpath graph',
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

  return { graph, name, pages: Object.keys(PAGES).length, journal: `journals/${jn}`, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('refpath graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  build, readPage, PAGES, TEXT, UUID, CONFIG, DEPTH, PATHS,
  DEEPEST_LEVELS, DEEPEST_PRESSES, CONTROL_FILE, ANCHOR, FILTER_TAG,
  DEEP_PAGE, OTHER_PAGE, DEEPEST_PAGE, journalName, journalBody,
};

if (require.main === module) {
  const r = build();
  console.log(`[refpath-graph] ${r.graph}`);
  console.log(`[refpath-graph] ${r.pages} pages + ${r.journal}; nothing writes them afterwards`);
}
