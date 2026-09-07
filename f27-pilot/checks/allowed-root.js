'use strict';
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
//
// Graph data may be read, opened, created, edited or tested ONLY inside
//
//   ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test
//
// Nothing in this harness touches a graph path that has not been canonicalised
// and proved to be inside that root. Traversal and symlink escape are rejected
// by resolving the real path and comparing prefixes, not by string matching on
// the path as given.
//
// This is harness-level enforcement plus verification of the application's own
// state -- it is NOT an OS sandbox, and it is not described as one. Every entry
// point the harness uses goes through `assertInsideAllowedRoot`, and the run
// stops rather than continuing on a violation.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOWED_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents',
                               'com~apple~CloudDocs', 'Logseq Test');

class BoundaryViolation extends Error {}

function allowedRootReal() {
  let real;
  try {
    real = fs.realpathSync(ALLOWED_ROOT);
  } catch (e) {
    throw new BoundaryViolation(
      `the permitted graph-data root does not exist or cannot be resolved: ${ALLOWED_ROOT}`);
  }
  const st = fs.lstatSync(ALLOWED_ROOT);
  if (st.isSymbolicLink()) {
    throw new BoundaryViolation(`${ALLOWED_ROOT} is a symbolic link`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new BoundaryViolation(`${real} is not a directory`);
  }
  return real;
}

// Resolve as far as the path exists, so a path that is about to be CREATED can
// still be proved contained before anything is written.
function resolveExistingPrefix(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), tail };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new BoundaryViolation(`${cur}: ${e.code}`);
      const parent = path.dirname(cur);
      if (parent === cur) throw new BoundaryViolation(`no existing ancestor for ${p}`);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function assertInsideAllowedRoot(label, p) {
  const root = allowedRootReal();
  const { real, tail } = resolveExistingPrefix(p);
  const full = tail.length ? path.join(real, ...tail) : real;
  if (!(full === root || full.startsWith(root + path.sep))) {
    throw new BoundaryViolation(
      `${label}: ${p} resolves to ${full}, which is outside the permitted ` +
      `graph-data root ${root}. Refusing.`);
  }
  if (full === root) {
    throw new BoundaryViolation(
      `${label}: refusing to operate on the shared Logseq Test root itself; ` +
      'each run must use its own uniquely named subfolder.');
  }
  return full;
}

// A path that must NOT be touched: anything graph-shaped outside the root.
function isInsideAllowedRoot(p) {
  try { assertInsideAllowedRoot('probe', p); return true; } catch (e) { return false; }
}

module.exports = { ALLOWED_ROOT, allowedRootReal, assertInsideAllowedRoot,
                   isInsideAllowedRoot, BoundaryViolation };
