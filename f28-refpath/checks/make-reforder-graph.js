#!/usr/bin/env node
'use strict';
//
// The synthetic graph for the F28 SOURCE-PAGE GROUP ORDERING slice.
//
//   node f28-refpath/checks/make-reforder-graph.js
//
// WHY THIS FIXTURE EXISTS AND THE CHILD-CONTEXT ONE IS NOT REUSED.
//
// `make-refctx-graph.js` is the fixture three accepted slices are measured
// against, and its numbers — 10 mentions, 47 rows, 5 source pages — are quoted
// in their evidence. Adding source pages to it to make an ordering question
// interesting would silently invalidate every one of those records. This
// fixture is therefore its own, and the child-context fixture is left exactly
// as the accepted runs found it.
//
// WHAT THE TITLES ARE FOR. Group ordering is a question about TITLES, so the
// source pages are chosen so that a wrong rule is VISIBLE rather than merely
// unproven:
//
//   * `apple source` / `Banana Source` / `Zebra Source` — if the comparison
//     did not case-fold, `Banana` (U+0042) and `Zebra` (U+005A) would both
//     sort BEFORE `apple` (U+0061). They must not;
//   * `가 …` `나 …` `다 …` `하 …` — composed Hangul syllables are laid out
//     alphabetically in U+AC00–U+D7A3, so a correct rule puts them in that
//     order and after every Latin title;
//   * `하 출처 Ha Source` is written to disk with a **decomposed (NFD)** file
//     name. Decomposed Hangul is U+1112 U+1161 …, which sorts BEFORE a
//     composed `가` (U+AC00) — so a rule that skips OG's own NFC step puts
//     this page first instead of last. macOS hands out decomposed names
//     routinely, so this is a real condition rather than a contrived one.
//     Whether the filesystem PRESERVED the decomposition is read back and
//     reported rather than assumed (`normalizationOnDisk`);
//   * a journal page, whose title is a formatted date string, is the only
//     group OG's own `:block/journal-day` ordering can see. Under `original`
//     it comes first; under a title order it sorts under `s`, which is limit
//     O1 of the specification made visible.
//
// The anchor carries an ALIAS, and one source page mentions the ALIAS rather
// than the anchor, so the ordering runs over a list whose membership OG built
// through `db/page-alias-set` — the alias handling the slice must not disturb.
//
// One referencing block (`naChild`) is a CHILD of another referencing block, so
// OG draws it twice, once as its own counted result and once as context. Row
// identity across a reorder therefore has to survive a block that legitimately
// appears more than once, and the "do not deduplicate" rule has something to
// be true of.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Everything is created fresh inside the permitted root under a unique name,
// through `allowed-root.js`, which rejects traversal and symlink escape. No
// existing folder is reused, renamed, reset or deleted.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

const ANCHOR = '기준 대상 Anchor Page';
const ALIAS = '기준 별칭 Anchor Nickname';

// Fixed identities, so a row can be named in an assertion rather than matched
// by the words it happens to carry.
const UUID = {
  anchor: '68c00000-0000-4000-8000-000000000001',
  appleA1: '68c00000-0000-4000-8000-000000000005',
  appleA2: '68c00000-0000-4000-8000-000000000006',
  appleA3: '68c00000-0000-4000-8000-000000000007',
  appleA4: '68c00000-0000-4000-8000-000000000008',
  appleA5: '68c00000-0000-4000-8000-000000000009',
  appleRef: '68c00000-0000-4000-8000-000000000010',
  appleC1: '68c00000-0000-4000-8000-000000000011',
  appleC2: '68c00000-0000-4000-8000-000000000012',
  appleC3: '68c00000-0000-4000-8000-000000000013',
  bananaRef: '68c00000-0000-4000-8000-000000000020',
  zebraTop: '68c00000-0000-4000-8000-000000000030',
  zebraRef: '68c00000-0000-4000-8000-000000000031',
  zebraC1: '68c00000-0000-4000-8000-000000000032',
  zebraC2: '68c00000-0000-4000-8000-000000000033',
  zebraG1: '68c00000-0000-4000-8000-000000000034',
  zebraGG1: '68c00000-0000-4000-8000-000000000035',
  gaTopA: '68c00000-0000-4000-8000-000000000040',
  gaRef: '68c00000-0000-4000-8000-000000000041',
  gaTopB: '68c00000-0000-4000-8000-000000000042',
  gaRef2: '68c00000-0000-4000-8000-000000000043',
  naTop: '68c00000-0000-4000-8000-000000000050',
  naRef: '68c00000-0000-4000-8000-000000000051',
  naChild: '68c00000-0000-4000-8000-000000000052',
  naGrand: '68c00000-0000-4000-8000-000000000053',
  daRef: '68c00000-0000-4000-8000-000000000060',
  haTop: '68c00000-0000-4000-8000-000000000070',
  haRef: '68c00000-0000-4000-8000-000000000071',
  haC1: '68c00000-0000-4000-8000-000000000072',
  jTop: '68c00000-0000-4000-8000-000000000080',
  journalRef: '68c00000-0000-4000-8000-000000000081',
  jC1: '68c00000-0000-4000-8000-000000000082',
  jC2: '68c00000-0000-4000-8000-000000000083',
};

// --- the source pages, and the sort keys their titles must produce ----------
//
// `key` is §3 of `project-notes/F28_REFERENCE_ORDER_SPEC.md` applied by hand:
// NFC, then lower-case. It is written out here so the expected order below is
// a stated consequence of the rule rather than a list somebody arranged.

const APPLE = 'apple source';
const BANANA = 'Banana Source';
const ZEBRA = 'Zebra Source';
const GA = '가 출처 Ga Source';
const NA = '나 출처 Na Source';
const DA = '다 Mixed 출처 Da Source';
const HA = '하 출처 Ha Source';

/** Written to disk DECOMPOSED; see the header. */
const HA_FILE_TITLE = HA.normalize('NFD');

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "${ANCHOR}"}}
`;

const TEXT = {
  // Five ancestors above the reference, so OG's breadcrumb (`:level-limit 3`)
  // shows the nearest three and emits its bare `⋯` — which is where the F28
  // source-path control lives. Without a path this long there would be no such
  // control on this fixture, and "the earlier slices' controls still work after
  // a reorder" would have nothing to be true of.
  appleA1: '사과 조상 1 · outermost ancestor',
  appleA2: '사과 조상 2 · second level',
  appleA3: '사과 조상 3 · third level',
  appleA4: '사과 조상 4 · fourth level',
  appleA5: '사과 조상 5 · the reference sits under this one',
  appleRef: `사과 출처의 참조 — the lower-case Latin source [[${ANCHOR}]] 🍎`,
  appleC1: '사과 자식 1 · first child, written first',
  appleC2: '사과 자식 2 · second child, written second',
  appleC3: '사과 자식 3 · third child, written third',

  bananaRef: `바나나 출처의 참조 — capital B, and no children [[${ANCHOR}]] 🍌`,

  zebraTop: '얼룩말 상위 · Zebra parent, for a breadcrumb',
  zebraRef: `얼룩말 출처의 참조 — this one names the ALIAS [[${ALIAS}]] 🦓`,
  zebraC1: '얼룩말 자식 1 · first',
  // A level-THREE descendant, so OG stops at two (`ref/default-open-blocks-level`)
  // and the F28 child-context control appears on the row above it.
  zebraG1: '얼룩말 손자 · a level-two row with something behind it',
  zebraGG1: '얼룩말 증손 · behind the wall, under the zebra source',
  zebraC2: '얼룩말 자식 2 · second',

  gaTopA: '가 상위 A · first parent on this page',
  gaRef: `가 출처의 첫 참조 — one of two groups on one page [[${ANCHOR}]] 🅰️`,
  gaTopB: '가 상위 B · second parent on this page',
  gaRef2: `가 출처의 둘째 참조 — the second group on the same page [[${ANCHOR}]] 🅱️`,

  naTop: '나 상위 · Na parent',
  naRef: `나 출처의 참조 — its child also names the page [[${ANCHOR}]] 🌊`,
  naChild: `나 출처의 자식 참조 — drawn twice, and a mention both times [[${ANCHOR}]] 🔁`,
  naGrand: '나 손자 · under the child that mentions the page',

  daRef: `다 출처의 참조 — a title that mixes 한글 and Latin [[${ANCHOR}]] 🌗`,

  haTop: '하 상위 · Ha parent',
  haRef: `하 출처의 참조 — this page's file name is decomposed [[${ANCHOR}]] 🌸`,
  haC1: '하 자식 1 · only child',

  jTop: '오늘의 기록 · journal root',
  journalRef: `저널에서 온 참조 — the only group OG's own order can see [[${ANCHOR}]] 📅`,
  jC1: '저널 자식 1 · 아침 — written in the morning',
  jC2: '저널 자식 2 · 저녁 — written in the evening 🌙',
};

/**
 * Every block that names the anchor or its alias — what the heading counts,
 * and the set whose membership must be IDENTICAL under all three orders.
 */
const REFERENCING = ['appleRef', 'bananaRef', 'zebraRef', 'gaRef', 'gaRef2',
                     'naRef', 'naChild', 'daRef', 'haRef', 'journalRef'];

/**
 * The children each referencing block carries, in the outline order they are
 * written. This is what "the order inside a group does not move" is checked
 * against, one group at a time, under every order.
 */
const CHILDREN = {
  appleRef: ['appleC1', 'appleC2', 'appleC3'],
  bananaRef: [],
  zebraRef: ['zebraC1', 'zebraG1', 'zebraC2'],
  gaRef: [],
  gaRef2: [],
  naRef: ['naChild', 'naGrand'],
  naChild: ['naGrand'],
  daRef: [],
  haRef: ['haC1'],
  journalRef: ['jC1', 'jC2'],
};

const PAGES = {
  // The alias line is the FILE'S FIRST LINE and carries no bullet, because that
  // is the only shape OG reads as a PAGE property. The first baseline run of
  // this fixture wrote it as a property of the heading block instead, so it
  // became a block property, the alias page was never created, and the source
  // page that mentions the alias was missing from the list entirely — 9
  // references across 7 groups where the fixture says 10 across 8.
  [`${ANCHOR}.md`]: `alias:: ${ALIAS}
- # ${ANCHOR}
- 이 페이지는 여러 출처 페이지에서 참조됩니다. This page is referenced from several source pages.
- Nothing on this page says anything about how the list below it is arranged.
`,

  [`${APPLE}.md`]: `- ${TEXT.appleA1}
  id:: ${UUID.appleA1}
\t- ${TEXT.appleA2}
\t  id:: ${UUID.appleA2}
\t\t- ${TEXT.appleA3}
\t\t  id:: ${UUID.appleA3}
\t\t\t- ${TEXT.appleA4}
\t\t\t  id:: ${UUID.appleA4}
\t\t\t\t- ${TEXT.appleA5}
\t\t\t\t  id:: ${UUID.appleA5}
\t\t\t\t\t- ${TEXT.appleRef}
\t\t\t\t\t  id:: ${UUID.appleRef}
\t\t\t\t\t\t- ${TEXT.appleC1}
\t\t\t\t\t\t  id:: ${UUID.appleC1}
\t\t\t\t\t\t- ${TEXT.appleC2}
\t\t\t\t\t\t  id:: ${UUID.appleC2}
\t\t\t\t\t\t- ${TEXT.appleC3}
\t\t\t\t\t\t  id:: ${UUID.appleC3}
`,

  [`${BANANA}.md`]: `- ${TEXT.bananaRef}
  id:: ${UUID.bananaRef}
`,

  [`${ZEBRA}.md`]: `- ${TEXT.zebraTop}
  id:: ${UUID.zebraTop}
\t- ${TEXT.zebraRef}
\t  id:: ${UUID.zebraRef}
\t\t- ${TEXT.zebraC1}
\t\t  id:: ${UUID.zebraC1}
\t\t\t- ${TEXT.zebraG1}
\t\t\t  id:: ${UUID.zebraG1}
\t\t\t\t- ${TEXT.zebraGG1}
\t\t\t\t  id:: ${UUID.zebraGG1}
\t\t- ${TEXT.zebraC2}
\t\t  id:: ${UUID.zebraC2}
`,

  [`${GA}.md`]: `- ${TEXT.gaTopA}
  id:: ${UUID.gaTopA}
\t- ${TEXT.gaRef}
\t  id:: ${UUID.gaRef}
- ${TEXT.gaTopB}
  id:: ${UUID.gaTopB}
\t- ${TEXT.gaRef2}
\t  id:: ${UUID.gaRef2}
`,

  [`${NA}.md`]: `- ${TEXT.naTop}
  id:: ${UUID.naTop}
\t- ${TEXT.naRef}
\t  id:: ${UUID.naRef}
\t\t- ${TEXT.naChild}
\t\t  id:: ${UUID.naChild}
\t\t\t- ${TEXT.naGrand}
\t\t\t  id:: ${UUID.naGrand}
`,

  [`${DA}.md`]: `- ${TEXT.daRef}
  id:: ${UUID.daRef}
`,

  [`${HA_FILE_TITLE}.md`]: `- ${TEXT.haTop}
  id:: ${UUID.haTop}
\t- ${TEXT.haRef}
\t  id:: ${UUID.haRef}
\t\t- ${TEXT.haC1}
\t\t  id:: ${UUID.haC1}
`,

  'F28 Order Control.md': `- # F28 Order Control
- 이 페이지는 이번 실행에서 한 번도 바뀌지 않습니다. Nothing in this run changes this page.
- No case names it, and no reference points into it.
- Its bytes are compared before and after, and must be identical.
`,
};

/** The page nothing in this run may change. */
const CONTROL_FILE = 'pages/F28 Order Control.md';

/**
 * The source pages that will appear as groups, by the identity OG registers
 * them under — `page-name-sanity-lc`, which is NFC then lower-case. This is
 * what `a.page-ref[data-ref]` in each group header carries, and it is what the
 * scenario compares orders by. The journal is added at run time, because its
 * title is today's date.
 */
const GROUP_IDS = {
  apple: APPLE.normalize('NFC').toLowerCase(),
  banana: BANANA.normalize('NFC').toLowerCase(),
  zebra: ZEBRA.normalize('NFC').toLowerCase(),
  ga: GA.normalize('NFC').toLowerCase(),
  na: NA.normalize('NFC').toLowerCase(),
  da: DA.normalize('NFC').toLowerCase(),
  ha: HA.normalize('NFC').toLowerCase(),
};

/**
 * §3 of the specification, in JavaScript, used ONLY as a cross-check against
 * the ClojureScript rule the product actually runs. The scenario asserts the
 * drawn order against a written-down expectation FIRST; this exists so that a
 * disagreement between the two implementations is also caught.
 */
function sortKey(title) {
  return String(title == null ? '' : title).normalize('NFC').toLowerCase();
}

function codePoints(s) {
  return Array.from(s).map((c) => c.codePointAt(0));
}

function compareTitles(a, b) {
  const x = codePoints(sortKey(a));
  const y = codePoints(sortKey(b));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  if (x.length === y.length) return 0;
  return x.length < y.length ? -1 : 1;
}

/** Stable, and ties keep the input order in BOTH directions (spec §4). */
function orderTitles(entries, mode) {
  if (mode === 'original') return entries.slice();
  const sign = mode === 'title-desc' ? -1 : 1;
  return entries
    .map((e, i) => [e, i])
    .sort((p, q) => {
      const c = sign * compareTitles(p[0].title, q[0].title);
      return c !== 0 ? c : p[1] - q[1];
    })
    .map((p) => p[0]);
}

function journalName(d = new Date()) {
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_` +
         `${String(d.getDate()).padStart(2, '0')}.md`;
}

function journalBody() {
  return `- ${TEXT.jTop}
  id:: ${UUID.jTop}
\t- ${TEXT.journalRef}
\t  id:: ${UUID.journalRef}
\t\t- ${TEXT.jC1}
\t\t  id:: ${UUID.jC1}
\t\t- ${TEXT.jC2}
\t\t  id:: ${UUID.jC2}
`;
}

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f28-reforder-${opts.kind || 'run'}-${stamp}`;
  const graph = B.assertInsideAllowedRoot('reforder graph',
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
  const jn = journalName();
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph journal', path.join(graph, 'journals', jn)), journalBody());

  // What the filesystem actually kept for the decomposed name. APFS is
  // normalization-preserving, but that is a property of this machine's volume
  // and not something a check may assume, so it is measured and reported.
  const onDisk = fs.readdirSync(path.join(graph, 'pages'))
    .find((f) => f.normalize('NFC') === `${HA}.md`) || null;
  const normalizationOnDisk = onDisk === null
    ? 'absent'
    : (onDisk === `${HA_FILE_TITLE}.md` ? 'NFD'
       : (onDisk === `${HA}.md` ? 'NFC' : 'other'));

  return { graph, name, pages: Object.keys(PAGES).length, journal: `journals/${jn}`,
           journalFile: jn, normalizationOnDisk, onDisk, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('reforder graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  build, readPage, sortKey, compareTitles, orderTitles, codePoints,
  journalName, journalBody,
  PAGES, TEXT, UUID, CONFIG, CHILDREN, REFERENCING, CONTROL_FILE, GROUP_IDS,
  ANCHOR, ALIAS, APPLE, BANANA, ZEBRA, GA, NA, DA, HA, HA_FILE_TITLE,
};

if (require.main === module) {
  const r = build();
  console.log(`[reforder-graph] ${r.graph}`);
  console.log(`[reforder-graph] ${r.pages} pages + ${r.journal}; ` +
              `decomposed name on disk: ${r.normalizationOnDisk}`);
}
