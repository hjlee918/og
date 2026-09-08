#!/usr/bin/env node
'use strict';
//
// The F27 inline-context LIFECYCLE fixture: a synthetic graph this batch is
// permitted to MUTATE, inside a uniquely named test-owned subfolder of the
// permitted graph-data root.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched.
//
// WHY THIS FIXTURE MUTATES AND THE OTHER ONE DOES NOT.
//
// `make-inline-graph.js` is read-only: its scenario asserts ZERO content
// changes, which is the right claim for a reading feature. The lifecycle
// question the supervisor review raises cannot be asked that way — it is
// precisely "what happens to an OPEN panel when the graph changes underneath
// it". So this graph is written to, through OG's own file watcher, which is
// the same path an external editor or a sync client uses. Every write is
// declared here as an exact whole-file body, so the scenario can assert the
// final bytes rather than merely "something changed".
//
// One page — `Lifecycle Control.md` — is never written and must be
// byte-identical at the end. It is the control for the claim that the writes
// below reached only what they named.
//
// The shape is what the four lifecycle cases need to be able to FAIL:
//
//   1. a target that is EDITED while its panel is open, on a page that is NOT
//      the page being read, so the host block is not re-transacted and the
//      only thing that changed is the target;
//   2. a target that is DELETED while its host reference remains, so the panel
//      must reach an honest unavailable state with no control that cannot work,
//      and nothing may be created to replace it;
//   3. a host whose reference is RETARGETED A -> B -> A. Its block carries an
//      `id::`, so its identity survives the re-parse and React can reuse the
//      component instance — which is the only way the stored-key guard is
//      actually exercised rather than bypassed by a remount;
//   4. one host writing the SAME target twice (independence and focus) and a
//      second host that is REMOVED outright while its panel is open.
//
const fs = require('fs');
const path = require('path');

const B = require('../../f27-pilot/checks/allowed-root.js');

const UUID = {
  // Edited in place while its panel is open.
  tgtEdit: '65f27c00-0000-4000-8000-0000000000e1',
  // Deleted while its host reference remains.
  tgtDel: '65f27c00-0000-4000-8000-0000000000e2',
  // The two ends of the retarget.
  tgtA: '65f27c00-0000-4000-8000-0000000000a1',
  tgtB: '65f27c00-0000-4000-8000-0000000000b1',
  // Written twice in one block, and once more in the host that is removed.
  tgtRep: '65f27c00-0000-4000-8000-0000000000c1',

  // Host blocks carry identities of their own, so a re-parse of the reading
  // page keeps them the same blocks. Without this every host would be a NEW
  // block after each write, React would remount, and case 3 would pass for the
  // wrong reason — a remount, not the guard under test.
  hostEdit: '65f27c00-0000-4000-8000-0000000000f1',
  hostDel: '65f27c00-0000-4000-8000-0000000000f2',
  hostRetarget: '65f27c00-0000-4000-8000-0000000000f3',
  hostTwice: '65f27c00-0000-4000-8000-0000000000f4',
  hostDoomed: '65f27c00-0000-4000-8000-0000000000f5',
};

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "Lifecycle Reading"}}
`;

// --- the reading page, as lines, so a mutation names exactly one of them -----

const READING_HEAD = '- # Lifecycle Reading';

const L_EDIT =
  `- Edited host: 편집될 대상을 가리키는 문장 ((${UUID.tgtEdit})) 🎯 and English after it.\n` +
  `  id:: ${UUID.hostEdit}`;

const L_DEL =
  `- Deleted host: 삭제될 대상을 가리키는 문장 ((${UUID.tgtDel})) which stays after the target goes.\n` +
  `  id:: ${UUID.hostDel}`;

const retargetLine = (target) =>
  `- Retarget host: 지금 가리키는 대상 ((${target})) 입니다.\n` +
  `  id:: ${UUID.hostRetarget}`;

const L_TWICE =
  `- Twice host: ((${UUID.tgtRep})) 그리고 다시 ((${UUID.tgtRep})) 입니다.\n` +
  `  id:: ${UUID.hostTwice}`;

const L_DOOMED =
  `- Doomed host: ((${UUID.tgtRep})) — this whole block is removed while its panel is open.\n` +
  `  id:: ${UUID.hostDoomed}`;

const readingPage = ({ retarget = UUID.tgtA, doomed = true } = {}) =>
  [READING_HEAD, L_EDIT, L_DEL, retargetLine(retarget), L_TWICE]
    .concat(doomed ? [L_DOOMED] : [])
    .join('\n') + '\n';

// --- the targets page -------------------------------------------------------

const EDIT_TEXT_BEFORE = '편집 전 원본 텍스트 — the target BEFORE it is edited';
const EDIT_TEXT_AFTER = '편집 후 새 텍스트 — the target AFTER it was edited 🎯';

const T_EDIT = (text) =>
  `- A PARENT of the edited target\n` +
  `\t- ${text}\n` +
  `\t  id:: ${UUID.tgtEdit}\n` +
  `\t\t- A CHILD of the edited target`;

const T_DEL =
  `- 삭제될 대상 블록 — the target that will be removed\n` +
  `  id:: ${UUID.tgtDel}`;

const T_REST =
  `- Target A, the first end of the retarget\n` +
  `  id:: ${UUID.tgtA}\n` +
  `- Target B, the second end of the retarget\n` +
  `  id:: ${UUID.tgtB}\n` +
  `- 반복 참조 대상 — the target written twice\n` +
  `  id:: ${UUID.tgtRep}`;

const targetsPage = ({ editText = EDIT_TEXT_BEFORE, deleted = false } = {}) =>
  [T_EDIT(editText)].concat(deleted ? [] : [T_DEL]).concat([T_REST]).join('\n') + '\n';

// --- the control ------------------------------------------------------------

const CONTROL = `- # Lifecycle Control
- 이 페이지는 이번 실행에서 한 번도 쓰이지 않습니다. This page is never written by this run.
- It carries no reference of its own, so nothing that happens to a target can reach it.
- Its bytes are compared before and after, and must be identical.
`;

const PAGES = {
  'Lifecycle Reading.md': readingPage(),
  'Lifecycle Targets.md': targetsPage(),
  'Lifecycle Control.md': CONTROL,
};

/**
 * The writes this run performs, in order. Each is a WHOLE-FILE body, declared
 * here rather than computed at run time, so the scenario asserts an expected
 * end state it did not derive from what it happened to do.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: 'pages/Lifecycle Targets.md',
    what: "the edited target's own text, on a page that is not being read",
    body: targetsPage({ editText: EDIT_TEXT_AFTER }),
  },
  {
    id: 'M2',
    file: 'pages/Lifecycle Targets.md',
    what: 'the deleted target block, removed outright',
    body: targetsPage({ editText: EDIT_TEXT_AFTER, deleted: true }),
  },
  {
    id: 'M3',
    file: 'pages/Lifecycle Reading.md',
    what: 'the retarget host, pointed at B',
    body: readingPage({ retarget: UUID.tgtB }),
  },
  {
    id: 'M4',
    file: 'pages/Lifecycle Reading.md',
    what: 'the retarget host, pointed back at A',
    body: readingPage({ retarget: UUID.tgtA }),
  },
  {
    id: 'M5',
    file: 'pages/Lifecycle Reading.md',
    what: 'the doomed host block, removed outright',
    body: readingPage({ retarget: UUID.tgtA, doomed: false }),
  },
];

/** What every page must contain when the run is over. */
const EXPECTED_END = {
  'pages/Lifecycle Reading.md': readingPage({ retarget: UUID.tgtA, doomed: false }),
  'pages/Lifecycle Targets.md': targetsPage({ editText: EDIT_TEXT_AFTER, deleted: true }),
  'pages/Lifecycle Control.md': CONTROL,
};

/** The page this run must never write. */
const CONTROL_FILE = 'pages/Lifecycle Control.md';

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f27-inline-lifecycle-${stamp}`;
  const graph = B.assertInsideAllowedRoot('lifecycle graph',
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
    '- Synthetic journal entry for the F27 inline-context lifecycle run.\n');

  return { graph, name, pages: Object.keys(PAGES).length, uuids: UUID };
}

/**
 * Apply one declared mutation. Containment is proved again here rather than
 * trusted from `build()`, because this writes while an application is running.
 */
function apply(graph, mutation) {
  B.assertInsideAllowedRoot('lifecycle graph', graph);
  const p = B.assertInsideAllowedRoot('mutated page', path.join(graph, mutation.file));
  const st = fs.lstatSync(p);
  if (!st.isFile()) throw new B.BoundaryViolation(`${p} is not a regular file`);
  const before = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, mutation.body);
  const after = fs.readFileSync(p, 'utf8');
  return { id: mutation.id, file: mutation.file, what: mutation.what,
           changed: before !== after, wroteExactly: after === mutation.body };
}

module.exports = {
  build, apply, PAGES, MUTATIONS, EXPECTED_END, CONTROL_FILE, UUID, CONFIG,
  EDIT_TEXT_BEFORE, EDIT_TEXT_AFTER, readingPage, targetsPage,
};

if (require.main === module) {
  const r = build();
  console.log(`[lifecycle-graph] ${r.graph}`);
  console.log(`[lifecycle-graph] ${r.pages} pages, ${MUTATIONS.length} declared mutations`);
}
