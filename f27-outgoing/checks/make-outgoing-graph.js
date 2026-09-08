#!/usr/bin/env node
'use strict';
//
// Generates ONE fresh synthetic graph for the F27 outgoing feature batch, from
// templates in this file, inside a uniquely named test-owned subfolder of the
// permitted graph-data root.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md):
// every path is proved contained by `f27-pilot/checks/allowed-root.js` before
// anything is written. No existing graph is copied, migrated, reused, renamed
// or deleted, and no earlier run's folder is touched. Nothing is read from any
// fixture directory outside the permitted root.
//
// The shape is what THIS batch needs to be able to fail:
//
//   OUTGOING (this slice)
//     * one block writing several references in a KNOWN order, so "source
//       order" is falsifiable rather than asserted;
//     * the same target written twice, so dedup and the repeat count are
//       observable;
//     * one block that references ITSELF *and* a uuid no block carries, so
//       both stopping conditions are on screen in one section;
//     * a block whose scan is CUT OFF after some links were found, so a
//       partial count can be seen to be qualified rather than presented as a
//       total;
//     * a block whose scan is CUT OFF before any link was found, so "nothing
//       was found in the part that was scanned" can be seen NOT to be said as
//       "this block contains no link";
//     * a block whose references are ONLY page links, tags, an embed and an
//       address, so "no block reference is written inside this block" can be
//       distinguished from a failure — and so a page link can be seen NOT to
//       be listed as a block reference;
//     * more distinct targets than one request shows, so the continuation and
//       the retention statement are exercised;
//     * a target with long Korean/English/emoji text, so the bound and the
//       grapheme-safe cut are visible.
//
//   EXISTING behaviour that must still hold (regression)
//     * an anchor block referenced from several sources, with breadcrumbs;
//     * tagged sources for the Crystal marker;
//     * children under a reference;
//     * an A -> B -> A cycle;
//     * a real image, a missing one, and one pointing outside the graph;
//     * a block embed and a page embed.
//
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const B = require('../../f27-pilot/checks/allowed-root.js');

// A 1x1 PNG, generated here rather than copied from anywhere, so the asset
// pipeline has something real to serve over assets:// without importing data.
function tinyPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = zlib.deflateSync(Buffer.from([0x00, 0x33, 0x88, 0xcc]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? false
 :default-home {:page "Outgoing Target"}}
`;

const UUID = {
  // The ANCHOR. F27's overview opens from the incoming-reference badge on a
  // BLOCK, so every source below references this block with ((uuid)).
  anchor: '65f27b00-0000-4000-8000-0000000000a0',

  // Targets the ordered source block links to, in this written order.
  t1: '65f27b00-0000-4000-8000-000000000001',
  t2: '65f27b00-0000-4000-8000-000000000002',
  t3: '65f27b00-0000-4000-8000-000000000003',

  // A target whose text is long, Korean/English/emoji mixed.
  longKo: '65f27b00-0000-4000-8000-00000000001f',

  // The self-referencing block.
  selfRef: '65f27b00-0000-4000-8000-0000000000e0',

  // A uuid no block carries. Written as a reference on purpose.
  ghost: '65f27b00-0000-4000-8000-0000000000ff',

  // Cycle, preserved from the pilot fixture's shape.
  cycleA: '65f27b00-0000-4000-8000-0000000000d1',
  cycleB: '65f27b00-0000-4000-8000-0000000000d2',

  // Block-embed target.
  embedded: '65f27b00-0000-4000-8000-0000000000eb',
};

// Further targets for the pagination and retention cases. With the anchor and
// the three named targets, one block writes 25 distinct links — more than one
// request shows (5) and more than a section may retain (20) — so BOTH the
// continuation and the retention cap are observable on screen rather than only
// in a unit test.
const MANY = [];
for (let i = 0; i < 21; i++) {
  MANY.push(`65f27b00-0000-4000-8000-0000000000${(0x20 + i).toString(16)}`);
}

const A = `((${UUID.anchor}))`;

// Filler that costs AST NODES rather than characters, so a block can exceed the
// scan's node bound (`f27-outgoing/max-scan-nodes`, 4096) without being an
// absurd wall of text.
//
// Measured against OG's own parser rather than guessed: one `*x* ` repetition
// costs exactly 8 inline AST nodes (1 rep -> 9 visited, 10 -> 81, 100 -> 801).
// 600 repetitions is 4,800 nodes in 2,400 characters — comfortably past the
// bound, and small enough that the block still renders as ordinary text.
const FILLER_REPS = 600;
const FILLER = '*x* '.repeat(FILLER_REPS);

// EXACTLY TEN blocks reference the anchor, because the compact overview renders
// at most ten rows (`f27-ref-overview/max-rows`). An eleventh source would be
// counted as a remainder and its row — and therefore its outgoing section —
// would not be on screen for this scenario to check.
const PAGES = {
  'Outgoing Target.md': `- # Outgoing Target
- The anchor block that every source references. Synthetic, no personal data.
  id:: ${UUID.anchor}
`,

  // ORDER: the links are written anchor, t2, t3, t1 — deliberately NOT the
  // order their identities sort in, so a list that happened to sort would be
  // visibly wrong. Korean and emoji sit between them.
  'Ordered Links.md': `- Source referencing ${A} 한국어 링크 ((${UUID.t2})) 그리고 🎯 ((${UUID.t3})) then ((${UUID.t1})) #crystal
	- A CHILD of the ordered source, which the context control reveals.
		- A GRANDCHILD, which an excerpt must not flatten into the parent.
`,

  // REPEAT: one target written three times, plus one other.
  'Repeated Links.md': `- Source referencing ${A} that writes ((${UUID.t1})) twice more: ((${UUID.t1})) and again ((${UUID.t1})), plus ((${UUID.t2}))
`,

  // SELF and MISSING in ONE block, so both stopping conditions are visible in
  // one section — and so the fixture stays within the compact overview's
  // ten-row limit while the two partial-scan sources below are added.
  'Self And Missing.md': `- Source referencing ${A} that also refers to itself ((${UUID.selfRef})) and to a block that is gone ((${UUID.ghost}))
  id:: ${UUID.selfRef}
`,

  // GENUINELY EMPTY: this block reaches the anchor ONLY through an embed macro,
  // so OG counts it as a referencing block and this slice — which does not
  // claim embeds — finds no inline block reference in it. It is the one shape
  // that can produce an empty outgoing section on a row of an INCOMING
  // reference list, and it is what makes "an embed is not an inline block
  // reference" observable rather than merely asserted.
  'Embed Only.md': `- Source that only embeds the target: {{embed ${A}}} plus [[Outgoing Excerpt Source]], #focus and https://example.com/nothing
`,

  // PARTIAL SCAN, WITH LINKS FOUND. Three references, then enough nodes to
  // exhaust the scan bound, then a fourth reference the scan never reaches.
  // What the section may say about this block is "at least three" — never a
  // total — and it must offer the source, which is the only place the rest of
  // the text can be read. The last found link is the long Korean/English/emoji
  // target, so the bounded one-hop expansion is checked here too.
  'Partial Links.md': `- Source referencing ${A} then ((${UUID.t1})) 한국어 링크 🎯 ((${UUID.longKo})) then a long run: ${FILLER} and finally ((${UUID.t2}))
`,

  // PARTIAL SCAN, WITH NOTHING FOUND. This block reaches the anchor only
  // through an embed macro — which this slice does not claim — so the scan
  // finds no link before the bound stops it, and the real reference at the end
  // is never reached. The section must say that nothing was found IN THE PART
  // IT SCANNED, and must NOT say the block contains no link.
  'Late Link.md': `- Source that only embeds the target: {{embed ${A}}} then a long run: ${FILLER} and finally ((${UUID.t1}))
`,

  // PAGINATION AND CAP: 25 distinct targets written in one block.
  'Many Links.md': `- Source referencing ${A} writing many links: ${
    [UUID.t1, UUID.t2, UUID.t3].concat(MANY).map((u) => `((${u}))`).join(' ')
  }
`,

  'Attachments.md': `- Attachments relating to ${A}
	- A generated image: ![outgoing dot](../assets/outgoing-dot.png)
	- A missing one: ![gone](../assets/does-not-exist.png)
	- One pointing outside the graph, which must not be served: ![escape](../../../outside-the-graph.png)
`,

  'Study Plan.md': `- Plan referencing ${A} #crystal
	- Block excerpt: {{embed ((${UUID.embedded}))}}
	- Page excerpt: {{embed [[Outgoing Excerpt Source]]}}
`,

  'Outgoing Cycle A.md': `- Cycle side A, referencing ${A} and ((${UUID.cycleB}))
  id:: ${UUID.cycleA}
`,

  // ---- pages that are NOT sources of the anchor -------------------------
  // Cycle side B closes the A -> B -> A walk without adding an overview row.
  'Outgoing Cycle B.md': `- Cycle side B, referencing ((${UUID.cycleA}))
  id:: ${UUID.cycleB}
`,

  'Outgoing Blocks.md': `- target-one, the first link target
  id:: ${UUID.t1}
- target-two, the second link target
  id:: ${UUID.t2}
- target-three, the third link target
  id:: ${UUID.t3}
- target for the block excerpt control
  id:: ${UUID.embedded}
${MANY.map((u, i) => `- extra-target-${i + 1}\n  id:: ${u}`).join('\n')}
`,

  'Long Target.md': `- ${'긴 한국어 문장입니다 with English mixed in 🎯 and more text to exceed the bound. '.repeat(12)}
  id:: ${UUID.longKo}
`,

  'Outgoing Excerpt Source.md': `- First top-level block of the excerpt source.
	- A CHILD that a page excerpt must report but not read.
- Second top-level block.
- Third top-level block.
`,
};

function build(opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const name = `f27-outgoing-run-${stamp}`;
  const graph = B.assertInsideAllowedRoot('synthetic graph',
                                          path.join(B.allowedRootReal(), name));

  if (fs.existsSync(graph)) {
    throw new B.BoundaryViolation(`${graph} already exists; refusing to reuse another run`);
  }
  fs.mkdirSync(graph, { recursive: false });

  for (const sub of ['logseq', 'pages', 'journals', 'assets']) {
    fs.mkdirSync(B.assertInsideAllowedRoot('graph subdir', path.join(graph, sub)));
  }
  fs.writeFileSync(B.assertInsideAllowedRoot('graph config', path.join(graph, 'logseq', 'config.edn')),
                   CONFIG);
  for (const [file, body] of Object.entries(PAGES)) {
    fs.writeFileSync(B.assertInsideAllowedRoot('graph page', path.join(graph, 'pages', file)), body);
  }
  const today = new Date();
  const j = `${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_` +
            `${String(today.getDate()).padStart(2, '0')}.md`;
  fs.writeFileSync(B.assertInsideAllowedRoot('graph journal', path.join(graph, 'journals', j)),
                   '- Synthetic journal entry for the F27 outgoing feature run.\n');
  fs.writeFileSync(B.assertInsideAllowedRoot('graph asset', path.join(graph, 'assets', 'outgoing-dot.png')),
                   tinyPng());

  return { graph, name, pages: Object.keys(PAGES).length, uuids: UUID, many: MANY };
}

module.exports = { build, PAGES, UUID, MANY, CONFIG };

if (require.main === module) {
  const r = build();
  console.log(`[outgoing-graph] ${r.graph}`);
  console.log(`[outgoing-graph] ${r.pages} pages, 1 journal, 1 asset`);
}
