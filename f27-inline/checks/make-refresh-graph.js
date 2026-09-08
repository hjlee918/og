#!/usr/bin/env node
'use strict';
//
// The F27 inline-context EXPLICIT-REFRESH fixture.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched.
//
// WHY A FOURTH FIXTURE.
//
// The three that exist answer three different questions and none of them can
// answer this one:
//
//   `make-inline-graph.js`      static reading; its whole claim is that NOTHING
//                               in it changed, so it cannot host a case that
//                               changes an incoming source;
//   `make-lifecycle-graph.js`   changed by WRITING ITS FILES, which reaches OG
//                               through the file watcher;
//   `make-transaction-graph.js` changed by the application, and its end state
//                               is declared against the four lifecycle cases.
//
// This one exists for one question: what an explicit REFRESH does to a panel
// whose sections were read earlier. That needs incoming sources that appear and
// disappear WHILE a section is open, which is a mutation, and it needs them not
// to disturb the declared end states of a run that is already accepted.
//
// Nothing writes these files after they are created. Every change is made by
// the application through `logseq.api.update_block` and `logseq.api.remove_block`,
// each of which goes through `frontend.handler.editor` and the outliner. OG
// writes the files back itself, so the end state is asserted as the content the
// application produced rather than as bytes this fixture chose.
//
// THE SHAPE, and what each part is able to falsify:
//
//   THE MAIN TARGET, whose incoming references change while a panel is open
//     * one source that never changes, so a refreshed list that lost it fails;
//     * one source that STARTS referring to it and then STOPS, so both
//       directions of "the list is current" can fail;
//     * one source removed OUTRIGHT, so a list that keeps a deleted block fails.
//
//   A SECOND TARGET on the same reading page, whose panel is opened at the same
//   time and deliberately NOT refreshed — the only way "a refresh reaches its
//   own panel and no other" can actually fail.
//
//   A MUTUAL PAIR, so the inbound explorer can be walked one level and meet an
//   identity already on its path: the repeat is marked rather than followed,
//   and a refresh returns the walk to its root.
//
//   A REFERENCE TO AN IDENTITY NOBODY HAS WRITTEN, so refreshing the honest
//   unavailable state can be exercised — and proved to create no page and no
//   block for the identity it names.
//
//   A CONTROL PAGE that no case names and nothing may write.
//
// The reading page is a second control: no case edits a host, so any change to
// it is undeclared and fails.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

const UUID = {
  // The main target and its hosts.
  tgtMain: '65f27e00-0000-4000-8000-0000000000a1',
  hostMain: '65f27e00-0000-4000-8000-0000000000f1',

  // The second target, whose panel is opened at the same time and left alone.
  tgtOther: '65f27e00-0000-4000-8000-0000000000a2',
  hostOther: '65f27e00-0000-4000-8000-0000000000f2',

  // The identity nobody has written. It appears in exactly one place — the
  // host below — and in no page of its own, which is what the run asserts is
  // still true after the unavailable panel has been refreshed.
  tgtStub: '65f27e00-0000-4000-8000-00000000dead',
  hostStub: '65f27e00-0000-4000-8000-0000000000f3',

  // The mutual pair.
  tgtCycle: '65f27e00-0000-4000-8000-0000000000c1',
  cycOther: '65f27e00-0000-4000-8000-0000000000c2',
  hostCycle: '65f27e00-0000-4000-8000-0000000000f4',

  // Sources for the main target.
  srcKeep: '65f27e00-0000-4000-8000-0000000000b1',
  srcJoins: '65f27e00-0000-4000-8000-0000000000b2',
  srcGone: '65f27e00-0000-4000-8000-0000000000b3',

  // A SECOND level under the permanent source: a block that refers to it
  // rather than to the target. Without one, no row in the target's own list
  // has anything to explore, and the walk this run resets could not be walked
  // in the first place — observed, and the reason this block exists.
  srcKeepRef: '65f27e00-0000-4000-8000-0000000000b6',

  // Sources for the second target.
  srcOtherKeep: '65f27e00-0000-4000-8000-0000000000b4',
  srcOtherJoins: '65f27e00-0000-4000-8000-0000000000b5',
};

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "Refresh Reading"}}
`;

// --- the text each case starts from, named so assertions can quote it --------
//
// Every string is distinctive on its own, because the end-state assertions are
// substring tests: two sources whose text shared a prefix would let a check
// that should fail pass.

const TEXT = {
  main: '새로 읽기 대상 — its own text never changes 🎯',
  other: '두 번째 대상 — the panel that is deliberately NOT refreshed 🎯',

  srcKeep: '출처 하나 — 이 출처는 실행 내내 그대로 남습니다 (the source that always stays)',
  srcJoinsBefore: '출처 둘 — 아직 대상을 참조하지 않습니다 (not a source yet)',
  srcJoinsAfter: '출처 둘 — 이제 대상을 참조합니다 (added while the section was open)',
  srcJoinsRemoved: '출처 둘 — 참조를 다시 뗐습니다 (no longer a source)',
  srcGone: '출처 셋 — 이 블록은 통째로 삭제됩니다 (removed outright while the section was open)',
  srcKeepRef: '두 번째 층 — 출처 하나를 가리키는 블록 (one level further in)',

  srcOtherKeep: '다른 대상의 출처 하나 — always there',
  srcOtherJoinsBefore: '다른 대상의 출처 둘 — not a source yet',
  srcOtherJoinsAfter: '다른 대상의 출처 둘 — now a source of the second target',

  cycle: '순환 대상 — points back at the block that points at it 🔁',
  cycOther: '순환 짝 — the other end of the mutual pair 🔁',
};

const PAGES = {
  'Refresh Reading.md': `- # Refresh Reading
- Main host: 새로 읽기를 시험할 문장 ((${UUID.tgtMain})) and English after it.
  id:: ${UUID.hostMain}
- Other host: 같은 페이지의 두 번째 패널 ((${UUID.tgtOther})) — refreshed only at the end.
  id:: ${UUID.hostOther}
- Stub host: 아무도 쓰지 않은 식별자 ((${UUID.tgtStub})) — nothing was ever written for it.
  id:: ${UUID.hostStub}
- Cycle host: 상호 참조 ((${UUID.tgtCycle})) — the explorer marks the repeat instead of following it.
  id:: ${UUID.hostCycle}
`,

  'Refresh Targets.md': `- ${TEXT.main}
  id:: ${UUID.tgtMain}
- ${TEXT.other}
  id:: ${UUID.tgtOther}
`,

  'Refresh Sources.md': `- ${TEXT.srcKeep} ((${UUID.tgtMain}))
  id:: ${UUID.srcKeep}
- ${TEXT.srcJoinsBefore}
  id:: ${UUID.srcJoins}
- ${TEXT.srcGone} ((${UUID.tgtMain}))
  id:: ${UUID.srcGone}
- ${TEXT.srcKeepRef} ((${UUID.srcKeep}))
  id:: ${UUID.srcKeepRef}
- ${TEXT.srcOtherKeep} ((${UUID.tgtOther}))
  id:: ${UUID.srcOtherKeep}
- ${TEXT.srcOtherJoinsBefore}
  id:: ${UUID.srcOtherJoins}
`,

  'Refresh Cycle.md': `- ${TEXT.cycle} ((${UUID.cycOther}))
  id:: ${UUID.tgtCycle}
- ${TEXT.cycOther} ((${UUID.tgtCycle}))
  id:: ${UUID.cycOther}
`,

  'Refresh Control.md': `- # Refresh Control
- 이 페이지는 이번 실행에서 한 번도 바뀌지 않습니다. Nothing in this run changes this page.
- No case below names it, and no reference points into it.
- Its bytes are compared before and after, and must be identical.
`,
};

/** The page nothing in this run may change. */
const CONTROL_FILE = 'pages/Refresh Control.md';

/**
 * The reading page is a SECOND control, and a stricter one: it carries the
 * hosts every case is driven from, and no case edits any of them. It is
 * deliberately absent from `EXPECTED_END` below, so a change to it is
 * undeclared and fails — and it is hashed separately as well, so the reason it
 * failed is visible rather than buried in a list of undeclared files.
 */
const READING_FILE = 'pages/Refresh Reading.md';

/**
 * What must be true of each page's content when the run is over.
 *
 * Declared as facts rather than as bytes because the APPLICATION writes these
 * files, not this fixture. Every string below is one the run put there or took
 * away on purpose.
 *
 * `absent` is for text that IS in the fixture and must be gone;
 * `absentAfterBeingAdded` is for text the run introduces and then removes,
 * which cannot be checked against the starting state and is named separately so
 * it is never mistaken for the first kind.
 *
 * ONE page is declared. The targets, the cycle, the reading page and the
 * control page are all expected to be untouched, and their absence from this
 * map is what makes a change to any of them fail.
 */
const EXPECTED_END = {
  'pages/Refresh Sources.md': {
    present: [TEXT.srcKeep, TEXT.srcJoinsRemoved, TEXT.srcOtherKeep, TEXT.srcOtherJoinsAfter,
              TEXT.srcKeepRef, `((${UUID.tgtOther}))`, `((${UUID.srcKeep}))`],
    // In the fixture at the start, and gone by the end.
    absent: [TEXT.srcGone, TEXT.srcJoinsBefore, TEXT.srcOtherJoinsBefore],
    // Never in the fixture: the run WRITES the reference into the joining
    // source and then takes it away again. Kept apart from `absent` because the
    // two prove different things, and because a check that could not tell them
    // apart would call this one vacuous.
    absentAfterBeingAdded: [TEXT.srcJoinsAfter],
  },
};

/**
 * How many blocks refer to the main target at each stage of the run, counting
 * the reading page's own host.
 *
 * Declared here rather than computed in the scenario so the scenario cannot
 * quietly agree with whatever it happened to render.
 */
const MAIN_INBOUND = {
  atStart: 3,      // srcKeep, srcGone, hostMain
  afterJoin: 4,    // + srcJoins
  afterLeave: 3,   // - srcJoins
  afterRemoval: 2, // - srcGone, and - srcJoins: srcKeep and hostMain remain
  afterRejoin: 3,  // + srcJoins again, for the keyboard case
};

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f27-inline-refresh-${stamp}`;
  const graph = B.assertInsideAllowedRoot('refresh graph',
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
  const today = new Date();
  const j = `${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_` +
            `${String(today.getDate()).padStart(2, '0')}.md`;
  fs.writeFileSync(
    B.assertInsideAllowedRoot('graph journal', path.join(graph, 'journals', j)),
    '- Synthetic journal entry for the F27 inline-context refresh run.\n');

  return { graph, name, pages: Object.keys(PAGES).length, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('refresh graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

/**
 * Every file in the graph that mentions `needle`, with containment proved at
 * read time. Used to show that refreshing a panel whose target is an identity
 * nobody wrote created no page and no block for that identity.
 */
function filesMentioning(graph, needle) {
  B.assertInsideAllowedRoot('refresh graph', graph);
  const hits = [];
  (function walk(rel) {
    const dir = rel ? path.join(graph, rel) : graph;
    for (const e of fs.readdirSync(B.assertInsideAllowedRoot('graph dir', dir),
                                   { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = B.assertInsideAllowedRoot('graph entry', path.join(graph, r));
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile()) continue;
      let body = '';
      try { body = fs.readFileSync(p, 'utf8'); } catch (x) { continue; }
      if (body.includes(needle)) hits.push(r);
    }
  })('');
  return hits.sort();
}

module.exports = { build, readPage, filesMentioning, PAGES, TEXT, UUID, CONFIG,
                   EXPECTED_END, CONTROL_FILE, READING_FILE, MAIN_INBOUND };

if (require.main === module) {
  const r = build();
  console.log(`[refresh-graph] ${r.graph}`);
  console.log(`[refresh-graph] ${r.pages} pages; every change is made by the application`);
}
