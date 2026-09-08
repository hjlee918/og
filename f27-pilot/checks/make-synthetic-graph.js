#!/usr/bin/env node
'use strict';
//
// Generates a fresh synthetic graph for one pilot run, from templates in this
// file, inside a uniquely named test-owned subfolder of the permitted
// graph-data root. No existing graph is copied, migrated or reused, and no
// other run's folder is touched.
//
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const B = require('./allowed-root.js');

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
 :default-home {:page "Pilot Target"}}
`;

// Content templates, written here rather than copied from anywhere. The older
// fixture directories outside the permitted root are never read.
//
// The shape is what F27 needs in order to have anything to show:
//   * one TARGET page referenced from several sources, each with a breadcrumb
//   * children under a reference, for the context/children control
//   * a tag on some references, for the Crystal marker
//   * a chain A -> B -> C and a cycle A <-> B, for chained/cyclic following
//   * a real image, a missing one, and one pointing outside the graph
//   * a block embed and a page embed, for the excerpt controls
const UUID = {
  // The ANCHOR block. F27's compact overview is reached from the incoming
  // reference badge on a BLOCK (components/block.cljs `block-refs-count`,
  // driven by :block/_refs), so every source below references this block with
  // ((uuid)). Page links alone produce Linked References and no badge -- which
  // is exactly why the first version of this graph rendered no F27 at all.
  anchor: '65f27a11-0000-4000-8000-0000000000a0',
  alpha: '65f27a11-0000-4000-8000-0000000000a1',
  beta: '65f27a11-0000-4000-8000-0000000000b2',
  // Following a reference means walking INCOMING block references, so a chain
  // needs each step to be referenced by the next with ((uuid)). Outgoing
  // [[page]] links produce no step at all -- measured, not assumed.
  chain1: '65f27a11-0000-4000-8000-0000000000c1',
  chain2: '65f27a11-0000-4000-8000-0000000000c2',
  cycleA: '65f27a11-0000-4000-8000-0000000000d1',
  cycleB: '65f27a11-0000-4000-8000-0000000000d2',
};

const A = `((${UUID.anchor}))`;

const PAGES = {
  'Pilot Target.md': `- # Pilot Target
- The anchor block that every source references. Synthetic, no personal data.
  id:: ${UUID.anchor}
`,

  'Weekly Review.md': `- Reviewing progress against ${A} #crystal
	- A CHILD of the review block, which the context control reveals.
		- A GRANDCHILD, which an excerpt must not flatten into the parent.
`,

  'Field Notes.md': `- ${'Padding text to make this reference long enough to be cut. '.repeat(12)}${A}
	- Child note with **bold text** and \`inline code\` to exercise trimming.
`,

  'Reading List.md': `- Reading queue for ${A} #crystal
	- Chapter one
	- Chapter two
`,

  'Attachments.md': `- Attachments relating to ${A}
	- A generated image: ![pilot dot](../assets/pilot-dot.png)
	- A missing one: ![gone](../assets/does-not-exist.png)
	- One pointing outside the graph, which must not be served: ![escape](../../../outside-the-graph.png)
`,

  'Study Plan.md': `- Plan referencing ${A}
	- Block excerpt: {{embed ((${UUID.alpha}))}}
	- Page excerpt: {{embed [[Pilot Excerpt Source]]}}
`,

  'Pilot Excerpt Source.md': `- First top-level block of the excerpt source.
	- A CHILD that a page excerpt must report but not read.
- Second top-level block.
- Third top-level block.
`,

  'Pilot Blocks.md': `- target-block-alpha, referenced by the block excerpt above
  id:: ${UUID.alpha}
- target-block-beta
  id:: ${UUID.beta}
`,

  // Chain: the overview row is Chain 1; following incoming references reaches
  // Chain 2, and from there Chain 3.
  'Pilot Chain 1.md': `- Chain start, referencing ${A}
  id:: ${UUID.chain1}
`,
  'Pilot Chain 2.md': `- Chain middle, referencing ((${UUID.chain1}))
  id:: ${UUID.chain2}
`,
  'Pilot Chain 3.md': `- Chain end, referencing ((${UUID.chain2}))
`,

  // Cycle: A is referenced by B, and B is referenced by A. Following from the
  // A row must stop rather than walk round for ever.
  'Pilot Cycle A.md': `- Cycle side A, referencing ${A} and ((${UUID.cycleB}))
  id:: ${UUID.cycleA}
`,
  'Pilot Cycle B.md': `- Cycle side B, referencing ((${UUID.cycleA}))
  id:: ${UUID.cycleB}
`,

  'Link Check.md': `- Another source for ${A} #crystal
`,
  'Quick Capture.md': `- Captured thought about ${A}
`,
};

function build(opts = {}) {
  const stamp = opts.stamp ||
    new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const name = `f27-pilot-run-${stamp}`;
  const graph = B.assertInsideAllowedRoot('synthetic graph', path.join(B.allowedRootReal(), name));

  if (fs.existsSync(graph)) {
    throw new B.BoundaryViolation(`${graph} already exists; refusing to reuse another run`);
  }
  fs.mkdirSync(graph, { recursive: false });

  for (const sub of ['logseq', 'pages', 'journals', 'assets']) {
    fs.mkdirSync(B.assertInsideAllowedRoot('graph subdir', path.join(graph, sub)));
  }
  fs.writeFileSync(path.join(graph, 'logseq', 'config.edn'), CONFIG);
  for (const [file, body] of Object.entries(PAGES)) {
    fs.writeFileSync(path.join(graph, 'pages', file), body);
  }
  const today = new Date();
  const j = `${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_` +
            `${String(today.getDate()).padStart(2, '0')}.md`;
  fs.writeFileSync(path.join(graph, 'journals', j),
    '- Synthetic journal entry for the F27 pilot run.\n');
  fs.writeFileSync(path.join(graph, 'assets', 'pilot-dot.png'), tinyPng());

  return { graph, name, pages: Object.keys(PAGES).length, uuids: UUID };
}

module.exports = { build, PAGES, UUID };

if (require.main === module) {
  const r = build();
  console.log(`[synthetic-graph] ${r.graph}`);
  console.log(`[synthetic-graph] ${r.pages} pages, 1 journal, 1 asset`);
}
