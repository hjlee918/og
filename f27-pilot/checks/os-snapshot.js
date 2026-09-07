'use strict';
//
// Non-recursive name+mtime snapshots of the OS locations a desktop application
// can write to, used to attribute what the pilot run changed.
//
// Deliberately NOT recursive: a recursive walk of ~/Library or the home
// directory would amount to inspecting personal state, which is out of scope
// and forbidden. A top-level snapshot is enough to attribute a new application
// footprint, and its limits are stated rather than papered over: it can show
// that an entry appeared or its mtime moved, and it cannot prove who wrote it.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.userInfo().homedir;

const WATCHED = [
  path.join(HOME, 'Library', 'Application Support'),
  path.join(HOME, 'Library', 'Logs'),
  path.join(HOME, 'Library', 'Preferences'),
  path.join(HOME, 'Library', 'Saved Application State'),
  path.join(HOME, 'Library', 'Caches'),
  path.join(HOME, 'Library', 'HTTPStorages'),
  path.join(HOME, 'Library', 'WebKit'),
  path.join(HOME, 'Library', 'Logs', 'DiagnosticReports'),
  HOME,
];

function snapshotDir(dir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: e.code || e.message };
  }
  for (const e of entries) {
    let st;
    try { st = fs.lstatSync(path.join(dir, e.name)); } catch (err) { continue; }
    out[e.name] = {
      type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file',
      mtimeMs: Math.round(st.mtimeMs),
    };
  }
  return out;
}

function snapshot() {
  const at = new Date().toISOString();
  const dirs = {};
  for (const d of WATCHED) dirs[d] = snapshotDir(d);
  return { at, dirs };
}

// Classify what changed. The pilot's own footprint is enumerated by exact name;
// nothing is matched by wildcard.
function classify(before, after, ids) {
  // pilot-identity.js exports SCREAMING_SNAKE constants. Reading `productName`
  // / `bundleId` off it silently yielded undefined, so the pilot's own paths
  // fell through to the "Logseq-named but not the pilot" branch and were
  // reported as a breach. Both spellings are accepted now, and a missing
  // identity is a hard error rather than a quiet misclassification.
  const productName = ids.PRODUCT_NAME || ids.productName;
  const bundleId = ids.BUNDLE_ID || ids.bundleId;
  if (!productName || !bundleId) {
    throw new Error('classify(): the pilot identity is missing; refusing to classify');
  }
  const HOME_ = HOME;
  const pilotExact = new Set([
    productName,                                  // Application Support / Logs
    `${bundleId}.plist`,                          // Preferences
    `${bundleId}.savedState`,                     // Saved Application State
    bundleId,                                     // Caches / HTTPStorages / WebKit
    `${bundleId}.binarycookies`,
  ]);

  const rows = [];
  for (const dir of Object.keys(after.dirs)) {
    const b = before.dirs[dir] || {};
    const a = after.dirs[dir] || {};
    if (a.error || b.error) continue;
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const n of names) {
      const wasThere = Object.prototype.hasOwnProperty.call(b, n);
      const isThere = Object.prototype.hasOwnProperty.call(a, n);
      let change = null;
      if (!wasThere && isThere) change = 'added';
      else if (wasThere && !isThere) change = 'removed';
      else if (a[n].mtimeMs !== b[n].mtimeMs) change = 'touched';
      if (!change) continue;

      const lower = n.toLowerCase();
      let verdict;
      if (pilotExact.has(n)) verdict = 'pilot';
      else if (lower.includes('logseq')) verdict = 'LOGSEQ-NOT-PILOT';
      else if (dir === HOME_ && (n === '.logseq-og' || n === '.logseq')) verdict = 'LOGSEQ-NOT-PILOT';
      else verdict = 'not-attributed-to-pilot';
      rows.push({ dir, name: n, change, verdict });
    }
  }
  return rows;
}

module.exports = { snapshot, classify, WATCHED, HOME };
