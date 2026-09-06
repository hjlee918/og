// Builds the F27 user-preview demonstration graph.
//
// Synthetic and private-data-free: nine short notes, written the way a person
// would actually write them, in English and Korean. They exist to make the five
// accepted F27 slices easy to look at, not to stress anything.
//
// IT NEVER DELETES ANYTHING. The demonstration notes are ordinary editable
// notes — the preview does not disable OG's editor — so a reader may well have
// changed them on purpose. An existing graph is therefore either left alone or,
// on an explicit reset, MOVED into a dated archive beside it. `create` refuses
// outright if anything is already there.
//
// Every write and every reset validates first that the target really is this
// preview's own graph directory: inside the preview root, reached without
// traversing a symlink, and carrying this generator's own signature.
const fs = require('fs');
const path = require('path');

const PREVIEW_DIR = path.resolve(__dirname, '../../f27-preview');
const GRAPH_DIR_NAME = 'f27-preview-demo';

// Written into every graph this generator creates, and recognised on any graph
// it is later asked to archive. A directory without one of these is not ours
// and is never touched.
const MARKER = '.f27-preview-demo';
const SIGNATURE = ';; F27 user-preview demonstration graph.';

class PreviewGraphError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PreviewGraphError';
    this.code = code;
  }
}

// Stable, obviously synthetic identifiers. Only blocks that something actually
// refers to need one; the rest are left alone so the notes stay readable.
const id = (n) => `7f270000-0000-4000-8000-0000000000${n}`;
const TARGET = id('01'); // Deep Work — the block the preview starts from
const KO1 = id('03'); // 연구 노트 — start of the inbound chain
const PLAN = id('04'); // 프로젝트 계획 — second step of the chain
const CUE = id('06'); // Habit Loop — one half of the mutual pair
const ROUTINE = id('07'); // Routine — the other half

const EXPECTED_PAGES = 9;

// ---------------------------------------------------------------------------
// Path ownership. Nothing below writes, renames or reads for a decision until
// these have passed.
// ---------------------------------------------------------------------------

// Resolve without requiring the path to exist: realpath the nearest existing
// ancestor, so `..` segments and symlinks cannot be used to escape.
function resolveStrict(p) {
  const abs = path.resolve(p);
  let probe = abs;
  for (;;) {
    if (fs.existsSync(probe)) return path.join(fs.realpathSync(probe), path.relative(probe, abs));
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    probe = parent;
  }
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The target must sit inside the preview root AND be reachable without passing
// through a symlink, so neither a replaced directory nor a crafted link can
// redirect a write or an archive move somewhere else.
function assertOwnedPath(label, p, root) {
  const abs = path.resolve(p);
  const real = resolveStrict(abs);
  if (real !== abs) {
    throw new PreviewGraphError(
      `${label} is reached through a symbolic link (${abs} resolves to ${real}); refusing to touch it`,
      'SYMLINK'
    );
  }
  const realRoot = resolveStrict(root);
  if (!inside(realRoot, real)) {
    throw new PreviewGraphError(`${label} resolves outside the preview directory (${real})`, 'ESCAPE');
  }
  return real;
}

function layout(root) {
  const previewDir = path.resolve(root || PREVIEW_DIR);
  return {
    previewDir,
    graphRoot: path.join(previewDir, 'graph'),
    graph: path.join(previewDir, 'graph', GRAPH_DIR_NAME),
    archiveRoot: path.join(previewDir, 'graph-archive'),
  };
}

const entriesOf = (d) => fs.readdirSync(d).filter((n) => n !== '.DS_Store');

// ---------------------------------------------------------------------------
// What is actually on disk, decided before anything is written.
// ---------------------------------------------------------------------------
function inspect(root) {
  const L = layout(root);
  assertOwnedPath('the demonstration graph', L.graph, L.previewDir);

  if (!fs.existsSync(L.graph)) return { status: 'absent', graph: L.graph, detail: 'nothing is there yet' };
  const st = fs.lstatSync(L.graph);
  if (st.isSymbolicLink()) {
    throw new PreviewGraphError(`the demonstration graph path is a symbolic link; refusing to touch it`, 'SYMLINK');
  }
  if (!st.isDirectory()) {
    return { status: 'foreign', graph: L.graph, detail: 'a file exists where the graph directory should be' };
  }
  if (entriesOf(L.graph).length === 0) return { status: 'empty', graph: L.graph, detail: 'the directory is empty' };

  const configPath = path.join(L.graph, 'logseq/config.edn');
  let signed = false;
  if (fs.existsSync(configPath)) {
    try {
      signed = fs.readFileSync(configPath, 'utf8').includes(SIGNATURE);
    } catch (e) {
      signed = false;
    }
  }
  const marked = fs.existsSync(path.join(L.graph, MARKER));
  if (!signed && !marked) {
    return {
      status: 'foreign',
      graph: L.graph,
      detail: 'it carries neither this generator\'s signature nor its marker file, so it is not this preview\'s graph',
    };
  }

  const pagesDir = path.join(L.graph, 'pages');
  const pages = fs.existsSync(pagesDir) ? entriesOf(pagesDir).filter((f) => f.endsWith('.md')) : [];
  if (!fs.existsSync(configPath) || pages.length < EXPECTED_PAGES) {
    return {
      status: 'owned-incomplete',
      graph: L.graph,
      pages: pages.length,
      detail: `${fs.existsSync(configPath) ? '' : 'logseq/config.edn is missing; '}${pages.length} of ${EXPECTED_PAGES} pages present`,
    };
  }
  return { status: 'owned-complete', graph: L.graph, pages: pages.length, detail: `${pages.length} pages present` };
}

// ---------------------------------------------------------------------------
// Archive, never delete. A rename inside the preview directory, so the notes
// survive intact and the reader is told exactly where they went.
// ---------------------------------------------------------------------------
function archive(root) {
  const L = layout(root);
  assertOwnedPath('the demonstration graph', L.graph, L.previewDir);
  const state = inspect(root);
  if (state.status === 'absent' || state.status === 'empty') return null;
  if (state.status === 'foreign') {
    throw new PreviewGraphError(
      `${L.graph} exists but ${state.detail}. Nothing there will be moved or deleted. ` +
        'Move it aside yourself if you want a fresh demonstration graph.',
      'FOREIGN'
    );
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
  let dest = path.join(L.archiveRoot, `${GRAPH_DIR_NAME}-${stamp}`);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(L.archiveRoot, `${GRAPH_DIR_NAME}-${stamp}-${n++}`);
  assertOwnedPath('the archive destination', dest, L.previewDir);
  fs.mkdirSync(L.archiveRoot, { recursive: true });
  fs.renameSync(L.graph, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Create. Refuses if anything is already there; `reset` archives first.
// ---------------------------------------------------------------------------
function build(opts = {}) {
  const root = opts.root;
  const L = layout(root);
  assertOwnedPath('the demonstration graph', L.graph, L.previewDir);

  const state = inspect(root);
  let archived = null;
  if (state.status !== 'absent' && state.status !== 'empty') {
    if (!opts.reset) {
      throw new PreviewGraphError(
        `${L.graph} already exists (${state.detail}). It will not be overwritten or deleted. ` +
          'Use --reset to move it into a dated archive first.',
        state.status === 'foreign' ? 'FOREIGN' : 'EXISTS'
      );
    }
    archived = archive(root);
  }

  const PAGES = path.join(L.graph, 'pages');
  fs.mkdirSync(PAGES, { recursive: true });
  fs.mkdirSync(path.join(L.graph, 'logseq'), { recursive: true });

  const w = (name, body) =>
    fs.writeFileSync(path.join(PAGES, name), body.replace(/\n+$/, '') + '\n', 'utf8');

  fs.writeFileSync(
    path.join(L.graph, MARKER),
    'This directory is the F27 preview demonstration graph, generated by\n' +
      'f27-preview/make-preview-graph.js. It is synthetic and disposable.\n' +
      'The launcher recognises this file as proof of ownership before it will\n' +
      'archive the directory. Delete it and the launcher will refuse to touch\n' +
      'this directory at all.\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(L.graph, 'logseq/config.edn'),
    `${SIGNATURE} Synthetic, disposable, private-data-free.
;; Rebuilt by f27-preview/make-preview-graph.js. Not a personal graph.
{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :todo
 :file/name-format :triple-lowbar
 :journal/page-title-format "MMM do, yyyy"
 :journal/file-name-format "yyyy_MM_dd"
 :default-home {:page "Deep Work"}
 :ref/linked-references-collapsed-threshold 100}
`,
    'utf8'
  );
  fs.writeFileSync(path.join(L.graph, 'logseq/custom.css'), '/* preview graph */\n', 'utf8');

  // --- The block everything in the walkthrough starts from ------------------
  // Four blocks refer to it, so its reference badge reads 4.
  w(
    'Deep Work.md',
    `- Deep Work — reading notes 📖
\t- Chapter 2 — Attention
\t\t- Focus is a skill you practise, not a mood you wait for.
\t\t  id:: ${TARGET}
\t\t- The rest of the chapter is not needed for this preview.`
  );

  // --- A referencing block with real ancestors AND real children ------------
  // Ancestors: Weekly review › Week 36 › What worked.
  // Children:  a task, bold text, plain lines.
  w(
    'Weekly Review.md',
    `- Weekly review
\t- Week 36
\t\t- What worked
\t\t\t- Two protected hours each morning matched ((${TARGET})) almost exactly. #핵심
\t\t\t\t- TODO Keep the same two hours next week
\t\t\t\t- **Monday** — two full hours, no interruptions
\t\t\t\t- Wednesday — lost the block to errands
\t\t\t\t- Friday — two hours again, easier than Monday
\t\t- What did not work
\t\t\t- Afternoon attempts were interrupted every day.`
  );

  // --- Korean source, and the start of the inbound chain --------------------
  w(
    '연구 노트.md',
    `- 연구 노트 📚
\t- 집중력 실험 #핵심
\t\t- 아침 두 시간 집중이 ((${TARGET})) 의 주장과 잘 맞았습니다.
\t\t  id:: ${KO1}
\t\t\t- 5일 중 3일 성공, 2일 실패`
  );

  // --- Step 2 of the chain: this refers to the Korean research note ---------
  w(
    '프로젝트 계획.md',
    `- 프로젝트 계획
\t- 9월 계획
\t\t- 실험 결과를 이번 달 계획에 반영합니다 ((${KO1}))
\t\t  id:: ${PLAN}`
  );

  // --- Step 3 of the chain: this refers to the plan -------------------------
  w(
    '회의 기록.md',
    `- 회의 기록
\t- 9월 첫째 주
\t\t- 계획 항목을 회의에서 함께 확인했습니다 ((${PLAN}))`
  );

  // --- The mutual pair: each note refers to the other -----------------------
  // Habit Loop refers to Routine, Routine refers back to Habit Loop. Following
  // the chain from Habit Loop reaches Routine, and the next step reaches Habit
  // Loop again — which is where the cycle boundary appears.
  w(
    'Habit Loop.md',
    `- Habit loop
\t- A cue only matters because of the routine it starts ((${ROUTINE})), which is why ((${TARGET})) calls focus a practice. #question
\t  id:: ${CUE}`
  );
  w(
    'Routine.md',
    `- Routine
\t- The routine is whatever the cue leads to ((${CUE})).
\t  id:: ${ROUTINE}`
  );

  // --- A referencing block that nothing refers to ---------------------------
  // Asking "references to this block" here gives a real, honest empty answer.
  w(
    'Quick Capture.md',
    `- Quick capture ✍️
\t- Re-read the focus chapter before the trip ((${TARGET}))`
  );

  w('contents.md', '-');

  const files = entriesOf(PAGES).sort();
  return { files, archived, graph: L.graph };
}

if (require.main === module) {
  const reset = process.argv.slice(2).includes('--reset');
  try {
    const r = build({ reset });
    if (r.archived) console.log('previous demonstration graph archived to ' + r.archived);
    console.log('demonstration graph written to ' + r.graph);
    console.log(r.files.length + ' pages: ' + r.files.join(', '));
  } catch (e) {
    console.log((e && e.message) || e);
    process.exit(1);
  }
}

module.exports = {
  build,
  inspect,
  archive,
  layout,
  assertOwnedPath,
  PreviewGraphError,
  PREVIEW_DIR,
  GRAPH_DIR_NAME,
  MARKER,
  SIGNATURE,
  EXPECTED_PAGES,
  TARGET,
  KO1,
  PLAN,
  CUE,
  ROUTINE,
};
