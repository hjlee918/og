#!/usr/bin/env node
'use strict';
//
// The F27 inline-context NORMAL-TRANSACTION fixture.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched.
//
// HOW THIS DIFFERS FROM `make-lifecycle-graph.js`, AND WHY BOTH EXIST.
//
// That fixture is changed by WRITING ITS FILES, which reaches the application
// through OG's file watcher — the path an external editor or a sync client
// uses. It stays as regression evidence for that path.
//
// This one is never written to after it is created. Every change is made by the
// application itself: by typing into OG's own editor, and by the ordinary
// application API (`logseq.api.update_block`, `remove_block`, `insert_block`,
// `move_block`), each of which goes through `frontend.handler.editor` and the
// outliner. OG writes the files back itself, so the end state is asserted as
// the content the application produced rather than as bytes this fixture chose
// — with one exception, the control page, which nothing may touch at all.
//
// The shape is what the review's remaining cases need to be able to fail:
//
//   THE FOUR LIFECYCLE CASES, through the application rather than the disk
//     * a target edited while its panel is open — done by TYPING, with the
//       target opened in the right sidebar so the host block is not re-rendered
//       for some other reason and the test cannot pass by accident;
//     * a target deleted while its host reference remains;
//     * a host retargeted A -> B -> A. Through the API, because editing the
//       host in OG's editor replaces the host's rendered content with a
//       textarea and unmounts the panel — the panel could not be "kept open"
//       at all on that path;
//     * one host writing the same target twice, and a second host removed
//       outright while its panel is open.
//
//   WHAT THE PANEL SHOWS THAT IS NOT THE TARGET'S OWN TEXT
//     * a context target whose own text and identity NEVER change, with an
//       original parent, an alternative parent to be moved under, and a block
//       that will later start referring to it — so a breadcrumb change, a child
//       arriving, an inbound reference appearing and a reparent can each be
//       observed while the panel is open.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

const UUID = {
  // The four lifecycle cases.
  tgtEdit: '65f27d00-0000-4000-8000-0000000000e1',
  tgtDel: '65f27d00-0000-4000-8000-0000000000e2',
  tgtA: '65f27d00-0000-4000-8000-0000000000a1',
  tgtB: '65f27d00-0000-4000-8000-0000000000b1',
  tgtRep: '65f27d00-0000-4000-8000-0000000000c1',
  parentEdit: '65f27d00-0000-4000-8000-0000000000d1',

  // Hosts. Each carries an identity so a re-parse keeps it the same block and
  // React can reuse the component instance.
  hostEdit: '65f27d00-0000-4000-8000-0000000000f1',
  hostDel: '65f27d00-0000-4000-8000-0000000000f2',
  hostRetarget: '65f27d00-0000-4000-8000-0000000000f3',
  hostTwice: '65f27d00-0000-4000-8000-0000000000f4',
  hostDoomed: '65f27d00-0000-4000-8000-0000000000f5',
  hostCtx: '65f27d00-0000-4000-8000-0000000000f6',

  // The context case, on a page of its own so its changes cannot disturb the
  // other cases or be disturbed by them.
  tgtCtx: '65f27d00-0000-4000-8000-00000000009a',
  ctxParentA: '65f27d00-0000-4000-8000-00000000009b',
  ctxParentB: '65f27d00-0000-4000-8000-00000000009c',
  ctxReferrer: '65f27d00-0000-4000-8000-00000000009d',
};

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "Txn Reading"}}
`;

// --- the text each case starts from, named so assertions can quote it --------

const TEXT = {
  editParent: 'A PARENT of the edited target, whose own text never changes',
  editBefore: '편집 전 원본 텍스트 — the target BEFORE it is edited',
  editAfter: '편집 후 새 텍스트 — typed into OG editor 🎯',
  editAfterApi: '두 번째 편집 — through the application API 🎯',
  editAfterReindex: '재색인 후 편집 — after the connection was replaced 🎯',
  del: '삭제될 대상 블록 — the target that will be removed',
  a: 'Target A, the first end of the retarget',
  b: 'Target B, the second end of the retarget',
  rep: '반복 참조 대상 — the target written twice',
  ctx: '맥락 대상 블록 — its own text never changes 🎯',
  ctxParentA: 'ORIGINAL PARENT of the context target',
  ctxParentARenamed: 'RENAMED PARENT of the context target',
  ctxParentB: 'ALTERNATIVE PARENT, for the reparent',
  ctxReferrer: 'A block that does not refer to the context target yet',
  ctxChild: 'A NEW CHILD added while the panel was open',
};

const PAGES = {
  'Txn Reading.md': `- # Txn Reading
- Edit host: 편집될 대상을 가리키는 문장 ((${UUID.tgtEdit})) 🎯 and English after it.
  id:: ${UUID.hostEdit}
- Delete host: 삭제될 대상을 가리키는 문장 ((${UUID.tgtDel})) which stays after the target goes.
  id:: ${UUID.hostDel}
- Retarget host: 지금 가리키는 대상 ((${UUID.tgtA})) 입니다.
  id:: ${UUID.hostRetarget}
- Twice host: ((${UUID.tgtRep})) 그리고 다시 ((${UUID.tgtRep})) 입니다.
  id:: ${UUID.hostTwice}
- Doomed host: ((${UUID.tgtRep})) — this whole block is removed while its panel is open.
  id:: ${UUID.hostDoomed}
- Context host: ((${UUID.tgtCtx})) — what this panel shows changes without the target's own text changing.
  id:: ${UUID.hostCtx}
`,

  'Txn Targets.md': `- ${TEXT.editParent}
  id:: ${UUID.parentEdit}
	- ${TEXT.editBefore}
	  id:: ${UUID.tgtEdit}
		- A CHILD of the edited target
- ${TEXT.del}
  id:: ${UUID.tgtDel}
- ${TEXT.a}
  id:: ${UUID.tgtA}
- ${TEXT.b}
  id:: ${UUID.tgtB}
- ${TEXT.rep}
  id:: ${UUID.tgtRep}
`,

  'Txn Context.md': `- ${TEXT.ctxParentA}
  id:: ${UUID.ctxParentA}
	- ${TEXT.ctx}
	  id:: ${UUID.tgtCtx}
- ${TEXT.ctxParentB}
  id:: ${UUID.ctxParentB}
- ${TEXT.ctxReferrer}
  id:: ${UUID.ctxReferrer}
`,

  'Txn Control.md': `- # Txn Control
- 이 페이지는 이번 실행에서 한 번도 바뀌지 않습니다. Nothing in this run changes this page.
- It carries no reference of its own, and no case below names it.
- Its bytes are compared before and after, and must be identical.
`,
};

/** The page nothing in this run may change. */
const CONTROL_FILE = 'pages/Txn Control.md';

/**
 * What must be true of each page's content when the run is over.
 *
 * Declared as facts rather than as bytes because the APPLICATION writes these
 * files, not this fixture: OG normalises what it writes (it adds an `id::` to a
 * block something has started to reference, for one), so an exact-byte
 * expectation would assert this fixture's formatting rather than the outcome.
 * Every string below is one the run put there or took away on purpose.
 *
 * `absent` is for text that IS in the fixture and must be gone;
 * `absentAfterBeingAdded` is for text the run introduces and then removes, which
 * cannot be checked against the starting state and is named separately so it is
 * never mistaken for the first kind.
 */
const EXPECTED_END = {
  'pages/Txn Targets.md': {
    present: [TEXT.editAfterReindex, TEXT.editParent, TEXT.a, TEXT.b, TEXT.rep],
    absent: [TEXT.editBefore, TEXT.del],
    // Written mid-run and then replaced by the post-re-index edit.
    absentAfterBeingAdded: [TEXT.editAfterApi],
  },
  'pages/Txn Reading.md': {
    present: [`((${UUID.tgtA}))`, `id:: ${UUID.hostRetarget}`, `id:: ${UUID.hostTwice}`],
    // Gone by the end, and here at the start — so the assertion can fail.
    absent: [`id:: ${UUID.hostDoomed}`],
    // Gone by the end, but never here at the start: the run WRITES it (the
    // retarget's B end) and then takes it away again. Kept apart from `absent`
    // because the two prove different things, and because a check that cannot
    // tell them apart would call this one vacuous.
    absentAfterBeingAdded: [`((${UUID.tgtB}))`],
  },
  'pages/Txn Context.md': {
    present: [TEXT.ctx, TEXT.ctxParentARenamed, TEXT.ctxParentB, TEXT.ctxChild,
              `((${UUID.tgtCtx}))`],
    absent: [TEXT.ctxParentA],
  },
};

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f27-inline-txn-${stamp}`;
  const graph = B.assertInsideAllowedRoot('transaction graph',
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
    '- Synthetic journal entry for the F27 inline-context transaction run.\n');

  return { graph, name, pages: Object.keys(PAGES).length, uuids: UUID };
}

/** Read one page back, with containment proved again at read time. */
function readPage(graph, rel) {
  B.assertInsideAllowedRoot('transaction graph', graph);
  const p = B.assertInsideAllowedRoot('graph page', path.join(graph, rel));
  return fs.readFileSync(p, 'utf8');
}

module.exports = { build, readPage, PAGES, TEXT, UUID, CONFIG, EXPECTED_END, CONTROL_FILE };

if (require.main === module) {
  const r = build();
  console.log(`[transaction-graph] ${r.graph}`);
  console.log(`[transaction-graph] ${r.pages} pages; every change is made by the application`);
}
