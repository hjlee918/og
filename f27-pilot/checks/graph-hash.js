'use strict';
//
// Graph content integrity.
//
// "The config file still exists" is not an integrity check. This hashes every
// file in the graph and compares two snapshots, and it separates the two kinds
// of change that a normal Logseq OG session produces:
//
//   CONTENT      pages/, journals/, assets/ -- the user's notes. A change here
//                after a read-only F27 session is a real finding.
//   HOUSEKEEPING logseq/ (config, .recycle, bak, graphs-txid.edn, version
//                files) and .git/ -- written by OG as a matter of course.
//
// Both are reported. Only the first is treated as a content change.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTENT_DIRS = ['pages', 'journals', 'assets'];

// Files Logseq OG creates by itself the first time it opens a graph, and files
// the OS or iCloud drops in. Their APPEARANCE is housekeeping. Any change to a
// file this harness generated is content, and so is any other new content file.
const OG_DEFAULT_ADDITIONS = new Set([
  'pages/contents.md',
  'pages/Contents.md',
  'logseq/custom.css',
  'logseq/config.edn',
  '.DS_Store',
]);

function snapshot(graphDir) {
  const files = {};
  (function walk(rel) {
    const dir = rel ? path.join(graphDir, rel) : graphDir;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { files[r] = { type: 'symlink' }; continue; }
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile()) continue;
      const buf = fs.readFileSync(path.join(graphDir, r));
      files[r] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    }
  })('');
  return files;
}

function isContent(rel) {
  const top = rel.split('/')[0];
  return CONTENT_DIRS.includes(top);
}

function compare(before, after) {
  const changes = [];
  for (const [k, v] of Object.entries(before)) {
    if (!(k in after)) changes.push({ file: k, change: 'removed' });
    else if (JSON.stringify(after[k]) !== JSON.stringify(v)) changes.push({ file: k, change: 'modified' });
  }
  for (const k of Object.keys(after)) {
    if (!(k in before)) changes.push({ file: k, change: 'added' });
  }
  for (const c of changes) {
    const generatedByUs = c.file in before;
    if (!generatedByUs && OG_DEFAULT_ADDITIONS.has(c.file)) {
      // Created by OG or the OS on first open; it did not alter anything we wrote.
      c.kind = 'housekeeping';
      c.note = 'created on first open, not a change to generated content';
    } else {
      c.kind = isContent(c.file) ? 'content' : 'housekeeping';
    }
  }
  return {
    changes,
    content: changes.filter((c) => c.kind === 'content'),
    housekeeping: changes.filter((c) => c.kind === 'housekeeping'),
    beforeCount: Object.keys(before).length,
    afterCount: Object.keys(after).length,
  };
}

module.exports = { snapshot, compare, isContent, CONTENT_DIRS, OG_DEFAULT_ADDITIONS };
