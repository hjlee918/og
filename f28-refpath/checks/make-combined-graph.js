#!/usr/bin/env node
'use strict';
//
// The synthetic graph for the COMBINED F27/F28 REFERENCE-WORKFLOW checkpoint.
//
//   node f28-refpath/checks/make-combined-graph.js
//
// WHY THIS FIXTURE EXISTS AND THE ORDERING ONE IS NOT EXTENDED IN PLACE.
//
// `make-reforder-graph.js` is the fixture three accepted slices are measured
// against, and its numbers — 10 mentions, 8 groups, 22 rows — are quoted in
// their evidence. The combined checkpoint needs MORE than those pages hold: an
// anchor page with real main-content blocks that carry an F27 badge and an F27
// inline panel, a badge target with ancestors, children and a mutual pair, a
// main target with an outgoing reference, and a joining source that the run
// edits through the application. Writing any of that into the ordering fixture
// would silently invalidate every one of those records. This fixture therefore
// STARTS from the ordering fixture's pages exactly as the accepted runs read
// them — same names, same identities, same depths, so the ordering and
// disclosure questions keep everything they had — and adds the F27 surfaces on
// top. Nothing already measured is moved, renamed or deepened.
//
// WHAT EACH ADDITION IS FOR.
//
//   * THE ANCHOR PAGE'S MAIN CONTENT — an ordinary page is not only its
//     linked-references list. The anchor gains a tagged parent carrying the
//     badge row (a block reference whose badge opens the F27 compact overview)
//     and a host row carrying an inline panel. The list below them is exactly
//     what the accepted runs measured, because the additions never mention the
//     anchor or its alias.
//
//   * THE BADGE TARGET — five ancestors (so the overview row's context has a
//     path), a task child, a tagged child and a bold child (so the children
//     disclosure carries a marker, a tag and emphasis), and its own text
//     pointing at a CYCLE PARTNER that points back (so the inbound explorer
//     meets an identity already on its path and must mark the boundary rather
//     than follow it).
//
//   * A THIRD SOURCE for the badge target, also carrying the `#핵심` tag, so
//     the Crystal marker has TWO real previews to show rather than one, and a
//     `#question` tag elsewhere so the marker list offers more than one of the
//     graph's own tags.
//
//   * THE MAIN TARGET of the inline panel, whose own text points OUTWARD at
//     another block (so the outgoing section has a row), and whose sources
//     change while the panel is open: one that stays, and one the run first
//     joins and then detaches through `logseq.api.update_block` — the declared
//     mutation the documented Refresh behaviour is measured against.
//
// DECLARED WRITES, IN ADVANCE. Two actions in the combined run write, and both
// are the application's own at this run's explicit request:
//
//   * the joining-sources page, when the run calls `logseq.api.update_block`
//     on the joining block (twice: to add the reference, then to remove it);
//   * the anchor page, when a real exclude-filter click makes OG's own
//     `page-handler/save-filter!` persist a `filters::` property.
//
// Everything else — the overview, the Crystal marker, the row contexts, the
// inbound walk, the source-path and child-context disclosures, the ordering,
// the language switch, the keyboard, the sidebar — is read-only, and the run
// proves it by hashing the graph while the application is still open, before
// the first declared write.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Everything is created fresh inside the permitted root under a unique name,
// through `allowed-root.js`, which rejects traversal and symlink escape. No
// existing folder is reused, renamed, reset or deleted.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');
// The ordering fixture, VERBATIM: its pages are this fixture's first pages,
// unchanged. Requiring the module (rather than copying its text) is what keeps
// the two from drifting apart, because this file cannot silently alter a page
// the accepted runs measured.
const RO = require('./make-reforder-graph.js');

// --- the ordering fixture's own names, identities and rules, re-exported ----

const ANCHOR = RO.ANCHOR;
const ALIAS = RO.ALIAS;
const UUID = { ...RO.UUID };
const TEXT = { ...RO.TEXT };
const CHILDREN = { ...RO.CHILDREN };
const REFERENCING = RO.REFERENCING.slice();
const GROUP_IDS = { ...RO.GROUP_IDS };
const CONTROL_FILE = RO.CONTROL_FILE;

// --- the new identities (no overlap with the ordering fixture's 001–083) ----

Object.assign(UUID, {
  // The badge journey. The badge target's five-ancestor chain, its children,
  // the cycle partner row that points back at it, the anchor-page rows that
  // carry the badge, and a third source on its own page.
  badgeTarget: '68c00000-0000-4000-8000-000000000101',
  badgeB1: '68c00000-0000-4000-8000-000000000102',
  badgeB2: '68c00000-0000-4000-8000-000000000103',
  badgeB3: '68c00000-0000-4000-8000-000000000104',
  badgeB4: '68c00000-0000-4000-8000-000000000105',
  badgeB5: '68c00000-0000-4000-8000-000000000106',
  badgeK1: '68c00000-0000-4000-8000-000000000107',
  badgeK2: '68c00000-0000-4000-8000-000000000108',
  badgeK3: '68c00000-0000-4000-8000-000000000109',
  cycRow: '68c00000-0000-4000-8000-000000000110',
  badgeHost: '68c00000-0000-4000-8000-000000000111',
  badgeHostChild: '68c00000-0000-4000-8000-000000000112',
  badgeParent: '68c00000-0000-4000-8000-000000000113',
  badgeThirdTop: '68c00000-0000-4000-8000-000000000114',
  badgeThird: '68c00000-0000-4000-8000-000000000115',

  // The inline-panel journey. The main target points outward at the outgoing
  // target; the anchor page's host row carries the panel.
  tgtMain: '68c00000-0000-4000-8000-000000000201',
  outTgt: '68c00000-0000-4000-8000-000000000202',
  hostMain: '68c00000-0000-4000-8000-000000000203',
  outTgtChild: '68c00000-0000-4000-8000-000000000204',

  // The sources of the main target that change while the panel is open.
  srcKeep: '68c00000-0000-4000-8000-000000000301',
  srcJoins: '68c00000-0000-4000-8000-000000000302',
  srcKeepRef: '68c00000-0000-4000-8000-000000000303',
});

// --- the new page names ------------------------------------------------------

const BADGE_PAGE = 'F27 배지 대상 Badge Target';
const CYCLE_PAGE = 'F27 순환 짝 Badge Cycle Partner';
const THIRD_PAGE = 'F27 배지 세 출처 Badge Third Source';
const MAIN_TARGET_PAGE = 'F27 본 대상 Main Target';
const OUTGOING_PAGE = 'F27 나가는 대상 Outgoing Target';
const JOINING_PAGE = 'F27 합류 출처 Joining Sources';

// --- the new text, each string distinctive so a substring assertion that
//     should fail cannot pass by sharing a prefix with another ----------------

Object.assign(TEXT, {
  badgeParent: '핵심으로 묶은 상위 · the tagged parent of the badge row',
  badgeHost: `배지가 붙는 참조 · this row carries the badge ((${UUID.badgeTarget})) #핵심`,
  badgeHostChild: "배지 참조의 자식 · a child, so the row's own disclosure has something to show",

  badgeB1: '배지 사슬 1 · outermost ancestor of the badge target',
  badgeB2: '배지 사슬 2 · second level',
  badgeB3: '배지 사슬 3 · third level',
  badgeB4: '배지 사슬 4 · fourth level',
  badgeB5: '배지 사슬 5 · the target sits under this one',
  badgeTarget: `배지 대상 본문 · the target itself, pointing at its cycle partner ((${UUID.cycRow})) 🎯`,
  badgeK1: 'TODO 배지 대상의 할 일 · a task child',
  badgeK2: '배지 대상의 의문 · a question child #question',
  badgeK3: '**굵은 자식** · a bold child, so emphasis survives the disclosure',

  cycRow: `순환 짝의 참조 · it points back at the badge target ((${UUID.badgeTarget})) 🔁`,
  badgeThird: `세 번째 출처의 참조 · also carries the 핵심 tag ((${UUID.badgeTarget})) #핵심`,

  tgtMain: `본 대상 본문 · the inline panel's target, pointing outward ((${UUID.outTgt})) 🎯`,
  outTgt: '나가는 대상 본문 · the block the main target points at',
  outTgtChild: '나가는 대상의 자식 · a child, so the outgoing row can be expanded',
  hostMain: `본문 패널의 호스트 · the inline panel host ((${UUID.tgtMain}))`,

  srcKeep: `출처 하나 · this source stays for the whole run ((${UUID.tgtMain}))`,
  srcJoinsBefore: '출처 둘 · 아직 대상을 참조하지 않습니다 (not a source yet)',
  srcJoinsAfter: `출처 둘 · 이제 대상을 참조합니다 (added while the section was open) ((${UUID.tgtMain}))`,
  srcJoinsRemoved: '출처 둘 · 참조를 다시 뗐습니다 (no longer a source)',
  srcKeepRef: `두 번째 층 · one level further in ((${UUID.srcKeep}))`,
});

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "${ANCHOR}"}}
`;

// --- the pages ---------------------------------------------------------------
//
// The ordering fixture's pages come first, UNCHANGED, except the anchor page,
// which GAINS main-content blocks after the lines the accepted runs measured.
// The `alias::` line stays the file's first line with no bullet — the one shape
// OG reads as a page property.

const ANCHOR_TAIL = `- ${TEXT.badgeParent}
  id:: ${UUID.badgeParent}
\t- ${TEXT.badgeHost}
\t  id:: ${UUID.badgeHost}
\t\t- ${TEXT.badgeHostChild}
\t\t  id:: ${UUID.badgeHostChild}
- ${TEXT.hostMain}
  id:: ${UUID.hostMain}
`;

const PAGES = {
  ...RO.PAGES,
  [`${ANCHOR}.md`]: RO.PAGES[`${ANCHOR}.md`] + ANCHOR_TAIL,

  [`${BADGE_PAGE}.md`]: `- # ${BADGE_PAGE}
- 배지 대상의 소개 · the block whose badge the anchor page carries
- ${TEXT.badgeB1}
  id:: ${UUID.badgeB1}
\t- ${TEXT.badgeB2}
\t  id:: ${UUID.badgeB2}
\t\t- ${TEXT.badgeB3}
\t\t  id:: ${UUID.badgeB3}
\t\t\t- ${TEXT.badgeB4}
\t\t\t  id:: ${UUID.badgeB4}
\t\t\t\t- ${TEXT.badgeB5}
\t\t\t\t  id:: ${UUID.badgeB5}
\t\t\t\t\t- ${TEXT.badgeTarget}
\t\t\t\t\t  id:: ${UUID.badgeTarget}
\t\t\t\t\t\t- ${TEXT.badgeK1}
\t\t\t\t\t\t  id:: ${UUID.badgeK1}
\t\t\t\t\t\t- ${TEXT.badgeK2}
\t\t\t\t\t\t  id:: ${UUID.badgeK2}
\t\t\t\t\t\t- ${TEXT.badgeK3}
\t\t\t\t\t\t  id:: ${UUID.badgeK3}
`,

  [`${CYCLE_PAGE}.md`]: `- # ${CYCLE_PAGE}
- 순환 짝의 상위 · a parent, so the row carries a breadcrumb
\t- ${TEXT.cycRow}
\t  id:: ${UUID.cycRow}
`,

  [`${THIRD_PAGE}.md`]: `- # ${THIRD_PAGE}
- 세 번째 출처의 상위 · a parent, so the row carries a breadcrumb
\t- ${TEXT.badgeThird}
\t  id:: ${UUID.badgeThird}
`,

  [`${MAIN_TARGET_PAGE}.md`]: `- # ${MAIN_TARGET_PAGE}
- 본 대상의 소개 · the target of the anchor page's inline panel
- ${TEXT.tgtMain}
  id:: ${UUID.tgtMain}
`,

  [`${OUTGOING_PAGE}.md`]: `- # ${OUTGOING_PAGE}
- 나가는 대상의 소개 · what the main target points at
- ${TEXT.outTgt}
  id:: ${UUID.outTgt}
\t- ${TEXT.outTgtChild}
\t  id:: ${UUID.outTgtChild}
`,

  [`${JOINING_PAGE}.md`]: `- # ${JOINING_PAGE}
- 합류 출처의 소개 · the sources of the main target that change while a panel is open
- ${TEXT.srcKeep}
  id:: ${UUID.srcKeep}
\t- ${TEXT.srcKeepRef}
\t  id:: ${UUID.srcKeepRef}
- ${TEXT.srcJoinsBefore}
  id:: ${UUID.srcJoins}
`,
};

/** The pages this run may WRITE to, and why — declared before anything runs. */
const DECLARED_WRITES = {
  [`${JOINING_PAGE}.md`]: 'logseq.api.update_block on the joining source, twice: add the reference, then remove it',
  [`${ANCHOR}.md`]: "OG's own page-handler/save-filter!, at this run's explicit exclude-filter click",
};

/**
 * What must be true of the joining page's content when the run is over.
 *
 * Declared as facts rather than as bytes because the APPLICATION writes the
 * file, not this fixture. The run leaves the joining source WITHOUT the
 * reference (added, then removed), so the fixture's original `srcJoinsBefore`
 * text must be gone and never come back.
 */
const EXPECTED_END = {
  [`${JOINING_PAGE}.md`]: {
    present: [TEXT.srcKeep, TEXT.srcKeepRef, TEXT.srcJoinsRemoved, `((${UUID.srcKeep}))`],
    absent: [TEXT.srcJoinsBefore],
    absentAfterBeingAdded: [TEXT.srcJoinsAfter],
  },
};

/**
 * How many blocks refer to each changing target at each stage, counting the
 * anchor page's own host. Declared here rather than computed in the scenario,
 * so the scenario cannot quietly agree with whatever it happened to render.
 */
const MAIN_INBOUND = {
  atStart: 2,    // hostMain, srcKeep
  afterJoin: 3,  // + srcJoins
  afterLeave: 2, // - srcJoins
};

/** How many blocks refer to the badge target: the three the overview lists. */
const BADGE_INBOUND = 3; // badgeHost, cycRow, badgeThird

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f28-combined-${opts.kind || 'run'}-${stamp}`;
  const graph = B.assertInsideAllowedRoot('combined graph',
                                          path.join(B.allowedRootReal(), name));

  if (fs.existsSync(graph)) {
    throw new B.BoundaryViolation(`${graph} already exists; refusing to reuse another run`);
  }
  fs.mkdirSync(graph, { recursive: false });

  for (const sub of ['logseq', 'pages', 'journals']) {
    fs.mkdirSync(B.assertInsideAllowedRoot('graph subdir', path.join(graph, sub)));
  }
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph config', path.join(graph, 'logseq', 'config.edn')), CONFIG);
  for (const [file, body] of Object.entries(PAGES)) {
    fs.writeFileSync(
      B.assertInsideAllowedRoot('graph page', path.join(graph, 'pages', file)), body);
  }
  const jn = RO.journalName();
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph journal', path.join(graph, 'journals', jn)),
    RO.journalBody());

  // What the filesystem actually kept for the decomposed name — measured, never
  // assumed; see the ordering fixture's header for why this matters here too.
  const onDisk = fs.readdirSync(path.join(graph, 'pages'))
    .find((f) => f.normalize('NFC') === `${RO.HA}.md`) || null;
  const normalizationOnDisk = onDisk === null
    ? 'absent'
    : (onDisk === `${RO.HA_FILE_TITLE}.md` ? 'NFD'
       : (onDisk === `${RO.HA}.md` ? 'NFC' : 'other'));

  return { graph, name, pages: Object.keys(PAGES).length, journal: `journals/${jn}`,
           journalFile: jn, normalizationOnDisk, onDisk, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('combined graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  build, readPage,
  // The ordering fixture's own vocabulary, unchanged, so the combined scenario
  // asserts ordering against the same identities the accepted runs used.
  sortKey: RO.sortKey, compareTitles: RO.compareTitles, orderTitles: RO.orderTitles,
  codePoints: RO.codePoints, journalName: RO.journalName, journalBody: RO.journalBody,
  PAGES, TEXT, UUID, CONFIG, CHILDREN, REFERENCING, CONTROL_FILE, GROUP_IDS,
  EXPECTED_END, DECLARED_WRITES, MAIN_INBOUND, BADGE_INBOUND,
  ANCHOR, ALIAS,
  APPLE: RO.APPLE, BANANA: RO.BANANA, ZEBRA: RO.ZEBRA,
  GA: RO.GA, NA: RO.NA, DA: RO.DA, HA: RO.HA, HA_FILE_TITLE: RO.HA_FILE_TITLE,
  BADGE_PAGE, CYCLE_PAGE, THIRD_PAGE, MAIN_TARGET_PAGE, OUTGOING_PAGE, JOINING_PAGE,
};

if (require.main === module) {
  const r = build();
  console.log(`[combined-graph] ${r.graph}`);
  console.log(`[combined-graph] ${r.pages} pages + ${r.journal}; ` +
              `decomposed name on disk: ${r.normalizationOnDisk}`);
  console.log(`[combined-graph] declared writes: ${JSON.stringify(Object.keys(DECLARED_WRITES))}`);
}