// Builds the F27 INTEGRATED demonstration graph — the one note set in which
// every accepted F27 slice can be seen from a single reference panel.
//
// It is a NEW graph directory (`f27-integrated-demo`) beside the earlier user
// demonstration graph (`f27-preview-demo`), which is left exactly as it is.
// Nothing here reads, moves, resets or overwrites that graph, the historical
// verification fixtures under development/f27-evidence, or any personal graph.
//
// Synthetic and private-data-free: fifteen short notes in English and Korean,
// and six small files generated here byte by byte — three PNGs drawn pixel by
// pixel, and three placeholder documents of a few bytes each.
//
// One block on "Deep Work" is referenced by nine others, so ONE panel holds:
//
//   Weekly Review   ancestors, children, a task and bold text
//   연구 노트         Korean, and the first step of an inbound chain
//   Habit Loop      the mutual pair with Routine — where a cycle is stopped
//   Quick Capture   a genuine "nothing references this"
//   Field Notes     graph-local pictures, a Korean spaced filename written two
//                   ways, and a file that is not on disk
//   Attachments     a PDF, a document and an audio file — named, never opened
//   Reading List    {{embed ((block))}} — read in place, bounded
//   Study Plan      {{embed [[page]]}} — a bounded page excerpt
//   Link Check      what a panel refuses: a path that climbs out of the graph,
//                   the same path encoded, a picture on the web, a query, a
//                   remote player and raw markup
//
// The ownership, refusal and archive rules are `graph-store.js`'s, shared with
// the user demonstration graph: this generator has no delete path either.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require(path.join(__dirname, 'graph-store.js'));

// ---------------------------------------------------------------------------
// The pictures, generated rather than copied from anywhere.
// ---------------------------------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

// A plain RGB PNG with a visible diagonal, so a thumbnail is recognisable as a
// picture and not as a blank rectangle.
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const near = Math.abs(x / w - y / h) < 0.06;
      const p = off + 1 + x * 3;
      raw[p] = near ? 255 - r : r;
      raw[p + 1] = near ? 255 - g : g;
      raw[p + 2] = near ? 255 - b : b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Names, in one place, so the guide and the self-check assert the same
// spellings the notes actually use.
// ---------------------------------------------------------------------------
const CHART = 'focus-chart.png'; // 1200x900 — far larger than the display bound
const KO_IMG = '집중 노트.png'; // Korean AND a space, written two ways below
const ICON = 'small-icon.png';
const PDF = '현장 기록.pdf';
const DOC = '주간 보고서.docx';
const MP3 = '녹음 메모.mp3';
const GONE = 'not-on-disk.png'; // referenced below; deliberately never written

// A real, readable picture placed exactly where a path that climbs out of the
// graph would land — one level above the graph directory, inside the preview
// tooling's own folder. It is written so that "nothing escaped" is something
// the screen could contradict, rather than a claim about an absent file.
const SENTINEL = 'outside-sentinel.png';

const PAGE_EXCERPT = 'Focus Practice'; // the page Study Plan embeds

// Stable, obviously synthetic identifiers, distinct from the user
// demonstration graph's. Only blocks something actually refers to have one.
const id = (n) => `7f271000-0000-4000-8000-0000000000${n}`;
const TARGET = id('01'); // Deep Work — the block every row refers to
const CHAPTER = id('02'); // the block Reading List embeds
const KO1 = id('03'); // 연구 노트 — first step of the inbound chain
const PLAN = id('04'); // 프로젝트 계획 — second step
const WEEK = id('05'); // the Weekly Review reference, quoted from elsewhere
const CUE = id('06'); // Habit Loop — one half of the mutual pair
const ROUTINE = id('07'); // Routine — the other half
const FIELD = id('08');
const ATTACH = id('09');
const READ = id('10');
const STUDY = id('11');
const LINKS = id('12');
const LONG = id('13'); // a deliberately long passage, quoted from Reading List

// One long paragraph, written as ordinary prose in both languages so it is the
// BOUND being demonstrated and not the atomic-node fallback. It is quoted at
// full width from Reading List (where 160 characters is the preview bound) and
// a longer sibling of it sits on the excerpted page (where 420 is the bound).
const LONG_TEXT =
  'The longer note I keep with the chapter: attention is not willpower, and the hours that survive ' +
  'are the ones nothing else was allowed to claim first. ' +
  '읽을 때마다 같은 문장에 멈춥니다 — 계획이 아니라 지켜진 시간이 결과를 만든다는 부분입니다. ' +
  'Every week that worked looked the same from the outside and completely different from the inside, ' +
  'which is the part a summary always loses. ' +
  '그래서 이 문단은 요약하지 않고 그대로 옮겨 둡니다.';

const SIGNATURE = ';; F27 integrated-preview demonstration graph.';
const MARKER = '.f27-integrated-demo';

const s = store.createStore({
  dirName: 'f27-integrated-demo',
  marker: MARKER,
  signature: SIGNATURE,
  expectedPages: 15,
  expectedAssets: 6,
  markerText:
    'This directory is the F27 INTEGRATED preview demonstration graph, generated\n' +
    'by f27-preview/make-integrated-graph.js. It is synthetic and disposable.\n' +
    'The launcher recognises this file as proof of ownership before it will\n' +
    'archive the directory. Delete it and the launcher will refuse to touch\n' +
    'this directory at all.\n',
  config: `${SIGNATURE} Synthetic, disposable, private-data-free.
;; Rebuilt by f27-preview/make-integrated-graph.js. Not a personal graph.
{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :todo
 :file/name-format :triple-lowbar
 :journal/page-title-format "MMM do, yyyy"
 :journal/file-name-format "yyyy_MM_dd"
 :default-home {:page "Deep Work"}
 :ref/linked-references-collapsed-threshold 100}
`,
  write: ({ graph, writePage: w, writeAsset }) => {
    // --- the files this graph really holds ---------------------------------
    writeAsset(CHART, png(1200, 900, [60, 90, 160]));
    writeAsset(KO_IMG, png(800, 600, [150, 80, 60]));
    writeAsset(ICON, png(48, 32, [70, 140, 90]));
    // Named by a panel and never opened, so their only job is to exist under
    // these names.
    writeAsset(PDF, Buffer.from('%PDF-1.4\n% synthetic F27 demonstration file — never opened\n%%EOF\n', 'utf8'));
    writeAsset(DOC, Buffer.from('synthetic F27 demonstration attachment\n', 'utf8'));
    writeAsset(MP3, Buffer.from('synthetic F27 demonstration attachment — never played\n', 'utf8'));
    // `GONE` is deliberately NOT written: Field Notes points at it so the
    // "file not found" state is a real one rather than a description.

    // The sentinel, one level above the graph — where `assets/../../x` lands.
    // It is inside the preview tooling's own directory and is validated the
    // same way every other write here is.
    const sentinel = path.join(path.dirname(graph), SENTINEL);
    store.assertOwnedPath('the containment sentinel', sentinel, path.resolve(path.dirname(graph), '..'));
    fs.writeFileSync(sentinel, png(400, 300, [200, 40, 40]));

    // --- the block every row refers to, and the block Reading List embeds ---
    w(
      'Deep Work.md',
      `- Deep Work — reading notes 📖
\t- Chapter 2 — Attention
\t\t- Focus is a skill you practise, not a mood you wait for.
\t\t  id:: ${TARGET}
\t\t- The rest of the chapter is not needed for this preview.
\t\t- ${LONG_TEXT}
\t\t  id:: ${LONG}
\t- Chapter 3 — Practice
\t\t- Practice beats intention: the week I actually kept ((${WEEK})) is the one pinned beside ![small icon](../assets/${ICON}) on the wall.
\t\t  id:: ${CHAPTER}`
    );

    // --- ancestors, children, a task and bold text -------------------------
    // Ancestors: Weekly review › Week 36 › What worked.
    w(
      'Weekly Review.md',
      `- Weekly review
\t- Week 36
\t\t- What worked
\t\t\t- Two protected hours each morning matched ((${TARGET})) almost exactly. #핵심
\t\t\t  id:: ${WEEK}
\t\t\t\t- TODO Keep the same two hours next week
\t\t\t\t- **Monday** — two full hours, no interruptions
\t\t\t\t- Wednesday — lost the block to errands
\t\t\t\t- Friday — two hours again, easier than Monday
\t\t- What did not work
\t\t\t- Afternoon attempts were interrupted every day.`
    );

    // --- Korean, and the first step of the inbound chain -------------------
    w(
      '연구 노트.md',
      `- 연구 노트 📚
\t- 집중력 실험 #핵심
\t\t- 아침 두 시간 집중이 ((${TARGET})) 의 주장과 잘 맞았습니다.
\t\t  id:: ${KO1}
\t\t\t- 5일 중 3일 성공, 2일 실패`
    );
    w(
      '프로젝트 계획.md',
      `- 프로젝트 계획
\t- 9월 계획
\t\t- 실험 결과를 이번 달 계획에 반영합니다 ((${KO1}))
\t\t  id:: ${PLAN}`
    );
    w(
      '회의 기록.md',
      `- 회의 기록
\t- 9월 첫째 주
\t\t- 계획 항목을 회의에서 함께 확인했습니다 ((${PLAN}))`
    );

    // --- the mutual pair, where a cycle is stopped -------------------------
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

    // --- a genuine "nothing references this" -------------------------------
    w(
      'Quick Capture.md',
      `- Quick capture ✍️
\t- Re-read the focus chapter before the trip ((${TARGET}))`
    );

    // --- pictures: a large one, a Korean spaced name written two ways, and a
    //     file that is not on disk ------------------------------------------
    w(
      'Field Notes.md',
      `- Field notes 🗒️
\t- 현장 기록
\t\t- The chart from the trial ![focus chart](../assets/${CHART}) sits beside 사진 ![집중 노트](../assets/${KO_IMG}) and the same file written in code ![](../assets/${encodeURIComponent(
        KO_IMG
      )}), while one picture is gone ![gone](../assets/${GONE}) — notes for ((${TARGET})). #자료
\t\t  id:: ${FIELD}
\t\t\t- A child block with its own small picture ![small icon](../assets/${ICON}) and a line of words after it.`
    );

    // --- attachments: named, never opened, never played --------------------
    w(
      'Attachments.md',
      `- Attachments
\t- 보고서 [현장 기록](../assets/${PDF}) 와 [주간 보고서](../assets/${DOC}), 그리고 [녹음 메모](../assets/${MP3}) 를 함께 둡니다 ((${TARGET})).
\t  id:: ${ATTACH}`
    );

    // --- a block embed, read in place --------------------------------------
    w(
      'Reading List.md',
      `- Reading list
\t- The paragraph I keep coming back to {{embed ((${CHAPTER}))}}, together with the long note beside it ((${LONG})) — worth re-reading before ((${TARGET})).
\t  id:: ${READ}`
    );

    // --- a page embed, read as a bounded excerpt ---------------------------
    w(
      'Study Plan.md',
      `- Study plan
\t- This month follows one page {{embed [[${PAGE_EXCERPT}]]}}, which is where ((${TARGET})) turns into a routine.
\t  id:: ${STUDY}`
    );

    // --- what a panel refuses ----------------------------------------------
    // Every path below satisfies OG's `^[./]*assets` recogniser, and none of
    // them is inside this graph's asset directory. The sentinel written above
    // is exactly where the first two would land.
    w(
      'Link Check.md',
      `- Link check
\t- Nothing here is fetched or followed: a path that climbs out ![lexical](../assets/../../${SENTINEL}), the same path encoded ![encoded](../assets/%2e%2e/%2e%2e/${SENTINEL}), a picture on the web ![web](https://example.invalid/remote-picture.png), a query {{query (page "Deep Work")}}, a player {{youtube https://example.invalid/watch?v=abc}} and some markup <b>bold html</b> — beside ((${TARGET})).
\t  id:: ${LINKS}`
    );

    // --- the page Study Plan embeds ----------------------------------------
    // Eight TOP-LEVEL blocks, so five are shown first and three follow on
    // request. Two of them carry real children with real words in them, so
    // "children are stated and never shown" is a claim the screen could
    // contradict.
    w(
      `${PAGE_EXCERPT}.md`,
      `- 첫 번째 최상위 블록입니다 — Korean, English and an emoji ✨ in one line.
\t- A CHILD of the first block, which an excerpt never shows.
\t\t- A GRANDCHILD, further still, which it never reaches either.
- ## Mornings are the only hours that survive contact with the day
- TODO Protect two hours before the first meeting
- The chart from the same trial ![focus chart](../assets/${CHART}) belongs with this page.
- The paragraph this plan is built on ((${CHAPTER})) says the same thing more slowly.
- 여섯 번째 블록 — 아래에 하위 항목이 있습니다.
\t- 발췌에는 나타나지 않는 하위 블록입니다.
- 일곱 번째 블록은 일부러 길게 썼습니다. ${LONG_TEXT} ${LONG_TEXT}
- The eighth and last top-level block of this page.`
    );

    w('contents.md', '-');
  },
});

if (require.main === module) {
  const reset = process.argv.slice(2).includes('--reset');
  try {
    const r = s.build({ reset });
    if (r.archived) console.log('previous demonstration graph archived to ' + r.archived);
    console.log('integrated demonstration graph written to ' + r.graph);
    console.log(r.files.length + ' pages: ' + r.files.join(', '));
    console.log(r.assets.length + ' files: ' + r.assets.join(', '));
  } catch (e) {
    console.log((e && e.message) || e);
    process.exit(1);
  }
}

module.exports = Object.assign({}, s, {
  TARGET, CHAPTER, KO1, PLAN, WEEK, CUE, ROUTINE, FIELD, ATTACH, READ, STUDY, LINKS, LONG, LONG_TEXT,
  CHART, KO_IMG, ICON, PDF, DOC, MP3, GONE, SENTINEL, PAGE_EXCERPT,
});
