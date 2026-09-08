'use strict';
//
// The graph-data boundary, as pure path arithmetic.
//
// This lives in plain JavaScript, next to electron/utils.js, for one reason:
// the ClojureScript main process is compiled with :advanced, so nothing inside
// it can be called from a test. Here the same code that ships in the bundle can
// be driven directly from Node with a MOCKED filesystem.
//
// TWO PROPERTIES THIS MUST HAVE, both of which an earlier version did not:
//
//  1. FAIL CLOSED. A path is refused unless it is positively shown to be
//     inside a permitted root. Earlier, every realpath error was treated as
//     "this component does not exist yet" and the walk climbed to the parent,
//     so a directory that threw EACCES resolved to its permitted ancestor and
//     PASSED. Only ENOENT and ENOTDIR now mean "not created yet"; EACCES,
//     ELOOP, EIO and everything else refuse outright. A dangling symlink is
//     detected with lstat and refused rather than mistaken for a safe missing
//     file, and a root that cannot be resolved is dropped rather than kept at
//     its declared value.
//
//  2. SEPARATE POLICIES. Graph, isolated state and bundled resources are
//     distinct categories, not one merged set. Graph selection and restoration
//     permit ONLY a test-owned subfolder of the permitted graph root -- not the
//     state directory, not bundled resources, and not the shared root itself.
//     If no graph root is configured, every graph operation is denied even
//     though state and resource operations still work.
//
// Two stages, in this order:
//   1. LEXICAL. path.resolve normalises `..`, so traversal is resolved away
//      before comparison. A path not under a permitted root for the operation
//      is refused here, with NO filesystem access at all.
//   2. CANONICAL. The path is resolved with realpath -- climbing only through
//      genuinely absent components -- and re-tested against the real roots, so
//      a symlink escape is refused even though stage 1 accepted it as written.

// Errors that mean "this component genuinely does not exist yet". Everything
// else is a failure to determine the answer, and a failure to determine the
// answer is a refusal.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// Which categories each operation may touch. Bundled resources are readable and
// never writable; graph selection is narrower than graph I/O.
const POLICIES = {
  // Choosing, remembering or restoring a graph. A test-owned subfolder only.
  'graph-select': { categories: ['graph'], strictSubfolder: true },
  // Reading or enumerating inside a graph that is already permitted.
  'graph-io': { categories: ['graph'] },
  // Reads that legitimately span the graph, the pilot's own state and bundled
  // files (configuration, the graph registry, plugin resources).
  read: { categories: ['graph', 'state', 'resources'] },
  // Writes never reach bundled resources.
  write: { categories: ['graph', 'state'] },
  // The pilot's own isolated state only.
  state: { categories: ['state'] },
  // Bundled resources and plugin files, read-only by construction.
  resource: { categories: ['resources', 'state'] },
};

const MAX_CLIMB = 64;

function createBoundary(opts) {
  const fs = opts.fs;
  const path = opts.path;
  // { graph: {declared, real} | null, state: ..., resources: ... }
  const roots = opts.roots || {};

  function under(root, p) {
    if (typeof root !== 'string' || typeof p !== 'string' || !root || !p) return false;
    return p === root || p.startsWith(root + path.sep);
  }
  function strictlyUnder(root, p) {
    if (typeof root !== 'string' || typeof p !== 'string' || !root || !p) return false;
    return p !== root && p.startsWith(root + path.sep);
  }

  // Resolve `p`, climbing ONLY through components that are genuinely absent.
  // Returns { ok: true, real } or { ok: false, reason, code }.
  function resolveReal(p) {
    let cur = p;
    const tail = [];
    for (let i = 0; i <= MAX_CLIMB; i++) {
      let real;
      try {
        real = fs.realpathSync(cur);
      } catch (e) {
        const code = e && e.code;
        if (!ABSENT_CODES.has(code)) {
          // EACCES, ELOOP, EIO, EPERM, ENAMETOOLONG, anything unexpected.
          return { ok: false, reason: `cannot resolve ${cur} (${code || e.message})`, code };
        }
        // realpath says absent. Distinguish "not there" from "there but broken":
        // a dangling symlink, or a link whose target escapes, also gives ENOENT.
        try {
          fs.lstatSync(cur);
          return { ok: false, code: 'EDANGLING',
                   reason: `${cur} exists but does not resolve (dangling or broken link)` };
        } catch (le) {
          const lcode = le && le.code;
          if (!ABSENT_CODES.has(lcode)) {
            return { ok: false, reason: `cannot stat ${cur} (${lcode || le.message})`, code: lcode };
          }
        }
        const parent = path.dirname(cur);
        if (parent === cur) {
          return { ok: false, code: 'ENOROOT', reason: 'no resolvable ancestor' };
        }
        tail.push(path.basename(cur));
        cur = parent;
        continue;
      }
      return {
        ok: true,
        real: tail.length ? path.join(real, ...tail.slice().reverse()) : real,
        existed: tail.length === 0,
      };
    }
    return { ok: false, code: 'ETOODEEP', reason: `gave up after ${MAX_CLIMB} levels` };
  }

  function policyFor(op) {
    return Object.prototype.hasOwnProperty.call(POLICIES, op) ? POLICIES[op] : null;
  }

  function check(p, op) {
    const policy = policyFor(op);
    if (!policy) {
      return { ok: false, stage: 'policy', reason: `unknown operation policy ${JSON.stringify(op)}` };
    }
    if (typeof p !== 'string' || p.length === 0) {
      return { ok: false, stage: 'input', reason: 'not a non-empty path string', op };
    }

    const available = policy.categories.filter((c) => roots[c] && roots[c].declared);
    if (available.length === 0) {
      return { ok: false, stage: 'config', op,
               reason: `no permitted root is configured for ${op} ` +
                       `(needs one of: ${policy.categories.join(', ')})` };
    }

    const resolved = path.resolve(p);

    // Stage 1 -- lexical, no filesystem access yet.
    const lexical = available.filter((c) => (policy.strictSubfolder
      ? strictlyUnder(roots[c].declared, resolved)
      : under(roots[c].declared, resolved)));
    if (lexical.length === 0) {
      const why = policy.strictSubfolder && available.some((c) => resolved === roots[c].declared)
        ? 'the permitted root itself is not a graph; use a test-owned subfolder'
        : `outside every permitted root for ${op}`;
      return { ok: false, stage: 'lexical', reason: why, resolved, op };
    }

    // Stage 2 -- canonical. Any failure here is a refusal, never a climb.
    const r = resolveReal(resolved);
    if (!r.ok) {
      return { ok: false, stage: 'canonical', reason: r.reason, code: r.code, resolved, op };
    }
    const canonical = lexical.filter((c) => (policy.strictSubfolder
      ? strictlyUnder(roots[c].real, r.real)
      : under(roots[c].real, r.real)));
    if (canonical.length === 0) {
      return { ok: false, stage: 'canonical', op, resolved, real: r.real,
               reason: 'escapes the permitted roots once links are resolved' };
    }
    return { ok: true, op, category: canonical[0], resolved, real: r.real };
  }

  return {
    check,
    permitted: (p, op) => check(p, op).ok,
    categories: () => Object.keys(roots).filter((k) => roots[k]),
    rootFor: (c) => (roots[c] ? Object.assign({}, roots[c]) : null),
    policies: () => Object.keys(POLICIES),
  };
}

/**
 * Build a boundary from declared roots, one per category.
 * A root that cannot be resolved is DROPPED, not kept at its declared value:
 * an unresolvable root is not a root we can enforce against.
 */
function boundaryFromCategories(declared, fsImpl, pathImpl) {
  const fs = fsImpl || require('fs');
  const path = pathImpl || require('path');
  const roots = {};
  const dropped = [];
  for (const category of ['graph', 'state', 'resources']) {
    const r = declared && declared[category];
    if (typeof r !== 'string' || r.trim() === '') { roots[category] = null; continue; }
    const abs = path.resolve(r);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (e) {
      dropped.push({ category, declared: abs, code: (e && e.code) || 'EUNKNOWN' });
      roots[category] = null;
      continue;
    }
    roots[category] = { declared: abs, real };
  }
  const b = createBoundary({ roots, fs, path });
  b.dropped = () => dropped.slice();
  return b;
}

module.exports = { createBoundary, boundaryFromCategories, POLICIES, ABSENT_CODES };
