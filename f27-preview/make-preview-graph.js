// Builds the F27 user-preview demonstration graph.
//
// Synthetic and private-data-free: eight short notes, written the way a person
// would actually write them, in English and Korean. It exists to make the five
// accepted F27 slices easy to look at, not to stress anything.
//
// Rerunnable: it rewrites the graph from scratch, so a preview always starts
// from known bytes. It writes ONLY inside its own preview directory and never
// touches the evidence fixtures or any personal graph.
const fs = require('fs');
const path = require('path');

const PREVIEW_DIR = path.resolve(__dirname, '../../f27-preview');
const GRAPH = path.join(PREVIEW_DIR, 'graph/f27-preview-demo');
const PAGES = path.join(GRAPH, 'pages');

// Stable, obviously synthetic identifiers. Only blocks that something actually
// refers to need one; the rest are left alone so the notes stay readable.
const id = (n) => `7f270000-0000-4000-8000-0000000000${n}`;
const TARGET = id('01'); // Deep Work — the block the preview starts from
const KO1 = id('03'); // 연구 노트 — start of the inbound chain
const PLAN = id('04'); // 프로젝트 계획 — second step of the chain
const CUE = id('06'); // Habit Loop — one half of the mutual pair
const ROUTINE = id('07'); // Routine — the other half

function build() {
  fs.rmSync(GRAPH, { recursive: true, force: true });
  fs.mkdirSync(PAGES, { recursive: true });
  fs.mkdirSync(path.join(GRAPH, 'logseq'), { recursive: true });

  const w = (name, body) =>
    fs.writeFileSync(path.join(PAGES, name), body.replace(/\n+$/, '') + '\n', 'utf8');

  fs.writeFileSync(
    path.join(GRAPH, 'logseq/config.edn'),
    `;; F27 user-preview demonstration graph. Synthetic, disposable, private-data-free.
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
  fs.writeFileSync(path.join(GRAPH, 'logseq/custom.css'), '/* preview graph */\n', 'utf8');

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
  // Children:  a task, bold text, inline code, plain lines.
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

  return fs.readdirSync(PAGES).sort();
}

if (require.main === module) {
  const files = build();
  console.log('demonstration graph written to ' + GRAPH);
  console.log(files.length + ' pages: ' + files.join(', '));
}

module.exports = { build, GRAPH, PREVIEW_DIR, PAGES, TARGET, KO1, PLAN, CUE, ROUTINE };
