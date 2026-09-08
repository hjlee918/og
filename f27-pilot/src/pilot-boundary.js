'use strict';
//
// The graph-data boundary, as pure path arithmetic.
//
// This lives in plain JavaScript, next to electron/utils.js, for one reason:
// the ClojureScript main process is compiled with :advanced, so nothing inside
// it can be called from a test. Here the same code that ships in the bundle can
// be driven directly from Node with a MOCKED filesystem, which is the only way
// to prove the property that matters:
//
//   a path outside the permitted roots is refused BEFORE any filesystem call
//   touches it.
//
// The test asserts that by counting calls on the injected fs. A lexical
// rejection must record zero.
//
// Two stages, in this order:
//
//   1. LEXICAL. path.resolve normalises `..`, so traversal is resolved away
//      before comparison. A path not under a permitted root is refused here,
//      with no filesystem access at all.
//   2. CANONICAL. The longest existing ancestor is resolved with realpath and
//      the missing tail re-appended, then re-tested against the REAL roots. A
//      symlink pointing out of a permitted root is refused here, even though
//      stage 1 accepted the path as written.
//
// Fail closed: a boundary with no roots permits nothing.

function createBoundary(opts) {
  const fs = opts.fs;
  const path = opts.path;
  // [{ declared, real }] -- `real` may equal `declared` when it cannot resolve.
  const roots = (opts.roots || []).filter((r) => r && r.declared);

  function under(root, p) {
    if (typeof root !== 'string' || typeof p !== 'string' || !root || !p) return false;
    return p === root || p.startsWith(root + path.sep);
  }

  // realpath of the longest existing ancestor, with the missing tail appended.
  function realOrNearest(p) {
    let cur = p;
    const tail = [];
    for (;;) {
      try {
        const real = fs.realpathSync(cur);
        return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
      } catch (e) {
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
  }

  function check(p) {
    if (typeof p !== 'string' || p.length === 0) {
      return { ok: false, stage: 'input', reason: 'not a non-empty path string' };
    }
    if (roots.length === 0) {
      return { ok: false, stage: 'config', reason: 'no permitted root is configured' };
    }

    const resolved = path.resolve(p);

    // Stage 1 -- no filesystem access on this path yet.
    if (!roots.some((r) => under(r.declared, resolved))) {
      return { ok: false, stage: 'lexical', reason: 'outside every permitted root', resolved };
    }

    // Stage 2 -- only now may the filesystem be consulted.
    const real = realOrNearest(resolved);
    if (real === null) {
      return { ok: false, stage: 'canonical', reason: 'no resolvable ancestor', resolved };
    }
    if (!roots.some((r) => under(r.real || r.declared, real))) {
      return { ok: false, stage: 'canonical', reason: 'escapes the permitted roots via a link',
               resolved, real };
    }
    return { ok: true, resolved, real };
  }

  return {
    check,
    permitted: (p) => check(p).ok,
    roots: () => roots.slice(),
  };
}

// Built from the roots the pilot entry and Electron supply. A null or blank
// root is dropped rather than widened to its parent.
function boundaryFromRoots(declaredRoots, fsImpl, pathImpl) {
  const fs = fsImpl || require('fs');
  const path = pathImpl || require('path');
  const roots = [];
  for (const r of declaredRoots || []) {
    if (typeof r !== 'string' || r.trim() === '') continue;
    const declared = path.resolve(r);
    let real = declared;
    try { real = fs.realpathSync(declared); } catch (e) { /* keep declared */ }
    roots.push({ declared, real });
  }
  return createBoundary({ roots, fs, path });
}

module.exports = { createBoundary, boundaryFromRoots };
