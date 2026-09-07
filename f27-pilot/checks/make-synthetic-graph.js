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
 :default-home {:page "F27 Pilot Home"}}
`;

const PAGES = {
  'F27 Pilot Home.md': `- # F27 Pilot Home
- This graph is synthetic test data generated for one isolated pilot run.
- It contains no personal content.
- Reference to [[F27 Pilot Assets]]
- Reference to [[F27 Pilot Targets]]
`,
  'F27 Pilot Assets.md': `- # Assets
- A locally generated image served over the internal assets protocol:
- ![pilot dot](../assets/pilot-dot.png)
- The image above exercises \`assets://\`; it is not user content.
`,
  'F27 Pilot Targets.md': `- # Targets
- target-block-alpha
  id:: 65f27a11-0000-4000-8000-00000000a001
- target-block-beta
  id:: 65f27a11-0000-4000-8000-00000000b002
`,
  'F27 Pilot Embeds.md': `- # Embeds
- Block embed:
- {{embed ((65f27a11-0000-4000-8000-00000000a001))}}
- Page embed:
- {{embed [[F27 Pilot Targets]]}}
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

  return { graph, name, pages: Object.keys(PAGES).length };
}

module.exports = { build };

if (require.main === module) {
  const r = build();
  console.log(`[synthetic-graph] ${r.graph}`);
  console.log(`[synthetic-graph] ${r.pages} pages, 1 journal, 1 asset`);
}
