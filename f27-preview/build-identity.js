'use strict';
//
// Which commit is the preview actually running — and can that be ESTABLISHED?
//
// The preview is a LOCAL TEST BUILD. It is not an installer, not a release and
// not a replacement for the application the user runs every day — so the one
// thing it owes the reader is an honest answer to "what code is this?", and a
// REFUSAL when it cannot give one. "Not contradicted" is not an answer; every
// path below either establishes identity or refuses.
//
// The two facts this reads:
//
//   1. THE REVISION COMPILED INTO THE RENDERER. `shadow-cljs.edn` runs
//      `shadow.hooks/git-revision-hook` on the `:app` build, which puts
//      `git describe --long --always --dirty` into the closure define
//      `frontend.config.REVISION`. It is written near the top of
//      `static/js/main.js`, so it can be read without loading 32 MB. This is
//      the renderer's own account of where it came from — not an inference.
//
//   2. WHAT IS ON DISK NOW. The commit the built revision names, diffed
//      against the WORKING TREE over the paths the build actually reads.
//
// THE VERDICT is one of three, and only the first two may launch:
//
//   exact        the renderer's revision is this checkout's revision, the tree
//                is clean, and nothing the build reads differs.
//   equivalent   the renderer was built from a DIFFERENT but CLEAN commit, and
//                nothing the build reads differs between that commit and the
//                working tree. This repository holds the preview tooling beside
//                the application, so a commit that touched only the tooling
//                lands here. It is allowed only because both sides are
//                comparable: a clean commit on one side, the files on disk on
//                the other.
//   unverified   anything else — and the launcher refuses.
//
// WHAT WAS WRONG BEFORE, AND IS NOT NOW. A `-dirty` suffix was stripped and the
// resulting COMMIT was compared. That cannot establish what an originally dirty
// build contains: the working tree it was compiled from is gone and was never
// recorded. A dirty BUILT revision is now refused outright rather than compared.
// A dirty WORKING TREE is no longer refused on sight, because the comparison
// below reads the working tree itself — if the dirt is outside the build's own
// inputs, identity still holds and is proved rather than assumed.
//
// WHAT THIS DOES NOT PROVE, stated rather than implied — see `LIMITS`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The compiled outputs a launch needs, and what each one is.
const ARTIFACTS = [
  ['compiled renderer', 'static/js/main.js'],
  ['compiled main process', 'static/electron.js'],
  ['stylesheet', 'static/css/style.css'],
  ['Electron binary', 'static/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'],
];

// What the app and electron builds and the stylesheet actually read.
//
// `src/test` is deliberately NOT here: no test namespace is reachable from
// `frontend.core/init` or `electron.core/main`, so a test edited after a build
// does not make that build stale, and treating it as if it did would refuse
// every launch for the wrong reason.
const INPUTS = [
  'src/main',
  'src/electron',
  'src/resources',
  'src/dev-cljs',
  'deps',
  'deps.edn',
  'shadow-cljs.edn',
  'externs.js',
  'tailwind.all.css',
  'tailwind.config.js',
  'postcss.config.js',
  'resources',
];

const REBUILD = (repo) =>
  'Rebuild in this order — gulp first, because it cleans static/js and the\n' +
  'other order deletes the compiled output:\n' +
  `  cd ${repo}\n` +
  '  yarn gulp:build\n' +
  '  clojure -M:cljs compile app electron';

const RECOVER = (repo) =>
  'The preview will not open a window whose code it cannot name. To establish\n' +
  'identity, commit (or stash) what is outstanding and rebuild, so the renderer\n' +
  'records a revision that names an exact tree:\n' +
  `  cd ${repo}\n` +
  '  git status --short\n' +
  '  git stash            # or commit\n' +
  '  yarn gulp:build\n' +
  '  clojure -M:cljs compile app electron';

const IDENTITY = { EXACT: 'exact', EQUIVALENT: 'equivalent', UNVERIFIED: 'unverified' };

// What a passing check does and does not establish. Printed with the report, so
// the claim is never larger than the evidence.
const LIMITS = [
  'a revision names the commit the compiler saw, not the bytes it emitted; nothing here recompiles or hashes the output to prove they correspond',
  '`git describe --dirty` does not consider untracked files, so untracked files under the build inputs are checked separately and refuse the run',
  'files IGNORED by git under the build inputs are generated and cannot be compared by content; they are listed, and covered only by the modification-time check below',
  'modification times are a freshness heuristic for `static/electron.js` and `static/css/style.css`, which carry no revision of their own — they are not content provenance',
  'the Electron binary is a downloaded dependency; nothing here signs or verifies it',
];

// The Electron binary is a downloaded dependency, not something this checkout
// compiles, so it is never compared against a source time.
const NOT_COMPILED_HERE = new Set(['Electron binary']);

// ---------------------------------------------------------------------------
// 1. What the renderer says about itself.
// ---------------------------------------------------------------------------
// The define sits in the bootstrap prologue, well inside the first few
// kilobytes. Reading a window rather than the whole file keeps this cheap on a
// 32 MB bundle; a build that somehow wrote it later reads as "not stated",
// which is reported rather than guessed at.
function revisionOf(mainJs, deps) {
  const io = (deps && deps.fs) || fs;
  let head;
  try {
    const fd = io.openSync(mainJs, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = io.readSync(fd, buf, 0, buf.length, 0);
      head = buf.slice(0, n).toString('utf8');
    } finally {
      io.closeSync(fd);
    }
  } catch (e) {
    return { revision: null, why: `the compiled renderer could not be read (${e.message})` };
  }
  const m = head.match(/"frontend\.config\.REVISION"\s*:\s*"([^"]*)"/);
  // A define that is present but empty names nothing, so it is the same answer
  // as one that is absent: not stated, rather than "" compared against a real
  // revision.
  if (!m || !m[1].trim()) return { revision: null, why: 'the compiled renderer states no build revision' };
  return { revision: m[1], why: null };
}

// ---------------------------------------------------------------------------
// 2. What the checkout says now.
// ---------------------------------------------------------------------------
// The commit part of a `git describe` output: `<tag>-<n>-g<sha>` or, with no
// tags in the repository, the abbreviated sha on its own. `-dirty` is stripped
// and remembered separately.
function commitOf(describe) {
  if (!describe) return null;
  const clean = describe.replace(/-dirty$/, '');
  const m = clean.match(/-g([0-9a-f]+)$/i);
  return m ? m[1] : clean;
}

function gitState(repo, deps) {
  const run = (deps && deps.git) || ((args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim());
  const out = { run };
  try {
    out.head = run(['rev-parse', 'HEAD']);
    out.describe = run(['describe', '--long', '--always', '--dirty']);
    out.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    out.subject = run(['log', '-1', '--format=%s']);
    out.committed = run(['log', '-1', '--format=%cI']);
    out.dirty = /-dirty$/.test(out.describe);
    out.error = null;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Times: the newest source the build reads, against the oldest thing built.
// ---------------------------------------------------------------------------
function newestInput(repo, deps) {
  const io = (deps && deps.fs) || fs;
  let newest = { at: 0, file: null };
  const unreadable = [];
  const visit = (p, required) => {
    let st;
    try {
      st = io.statSync(p);
    } catch (e) {
      // A DECLARED input that is not there, or cannot be read, is not a
      // freshness question — it means this check does not cover what it claims
      // to cover, and the run is refused rather than quietly passed.
      if (required) unreadable.push({ file: path.relative(repo, p), why: e.message });
      return;
    }
    if (st.isDirectory()) {
      let entries;
      try {
        entries = io.readdirSync(p);
      } catch (e) {
        unreadable.push({ file: path.relative(repo, p), why: e.message });
        return;
      }
      for (const e of entries) {
        if (e === '.DS_Store' || e === 'node_modules' || e === '.git') continue;
        visit(path.join(p, e), false);
      }
      return;
    }
    const at = st.mtimeMs;
    if (at > newest.at) newest = { at, file: p };
  };
  for (const rel of (deps && deps.inputs) || INPUTS) visit(path.join(repo, rel), true);
  return { at: newest.at, file: newest.file, unreadable };
}

// Files under the build inputs that a git comparison cannot speak for.
//
//   untracked  would be compiled and is invisible to every diff — refused
//   ignored    generated, so it cannot be compared by content. This repository
//              really has one (`src/main/frontend/tldraw-logseq.js`, produced by
//              `yarn tldraw:build` and required by `frontend.extensions.tldraw`),
//              so this is listed as a stated limit rather than refused, and it
//              is still covered by the modification-time check.
function auditTree(git, inputs) {
  const out = { untracked: null, ignored: null, error: null };
  if (!git || git.error) {
    out.error = 'the checkout could not be queried';
    return out;
  }
  const list = (args) => {
    const raw = git.run(['ls-files', '--others'].concat(args, ['--'], inputs));
    return String(raw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  };
  try {
    out.untracked = list(['--exclude-standard']);
    out.ignored = list(['--ignored', '--exclude-standard']);
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole answer, in the order a reader needs it.
// ---------------------------------------------------------------------------
function inspect(repo, deps) {
  const io = (deps && deps.fs) || fs;
  const inputs = (deps && deps.inputs) || INPUTS;
  const report = {
    repo,
    artifacts: [],
    missing: [],
    stale: [],
    // Reasons identity could not be ESTABLISHED. Any entry refuses the run.
    refusals: [],
    warnings: [],
    limits: LIMITS,
    identity: IDENTITY.UNVERIFIED,
    revision: { built: null, checkout: null, matches: null, provable: false },
    tree: null,
    git: null,
  };

  for (const [label, rel] of (deps && deps.artifacts) || ARTIFACTS) {
    const p = path.join(repo, rel);
    let st = null;
    try {
      st = io.statSync(p);
    } catch (e) {
      /* recorded as missing below */
    }
    report.artifacts.push({ label, path: p, exists: !!st, size: st ? st.size : null, mtimeMs: st ? st.mtimeMs : null });
    if (!st) report.missing.push(label);
  }
  if (report.missing.length) {
    report.ok = false;
    report.reason = `${report.missing.length} build artifact(s) are missing: ${report.missing.join(', ')}.`;
    report.advice = REBUILD(repo);
    return report;
  }

  const git = gitState(repo, deps);
  report.git = git;
  const built = revisionOf(path.join(repo, 'static/js/main.js'), deps);
  report.revision.built = built.revision;
  report.revision.built_why = built.why;
  report.revision.checkout = git.describe || null;

  // -------------------------------------------------------------------------
  // Identity. Each branch either establishes it or refuses; none of them warns
  // and continues.
  // -------------------------------------------------------------------------
  if (git.error) {
    report.refusals.push(
      `this checkout's own revision could not be read (${git.error}), so there is nothing to identify the build against`
    );
  } else if (!built.revision) {
    report.refusals.push(`${built.why}, so the window's code cannot be named`);
  } else if (/-dirty$/.test(built.revision)) {
    // THE CORRECTION. The tree this was compiled from was never recorded and
    // cannot be recovered, so no comparison can speak for its contents. Its
    // commit prefix names a neighbour of that tree, not the tree.
    report.refusals.push(
      `the compiled renderer was built from an UNCOMMITTED tree ("${built.revision}"). The files it was ` +
        `compiled from were never recorded, so no comparison can establish what it contains`
    );
  } else {
    const from = commitOf(built.revision);
    let known = false;
    try {
      git.run(['rev-parse', '--verify', '--quiet', from + '^{commit}']);
      known = true;
    } catch (e) {
      report.refusals.push(
        `the compiled renderer was built from "${built.revision}", which is not a commit in this checkout`
      );
    }
    if (known) {
      // The comparison that matters: that commit against the FILES ON DISK,
      // over the paths the build reads. `git diff <commit> -- <paths>` reads the
      // working tree, so a dirty tree is answered rather than assumed about.
      let differs = null;
      try {
        git.run(['diff', '--quiet', from, '--'].concat(inputs));
        differs = false;
      } catch (e) {
        // `git diff --quiet` exits non-zero when there IS a difference, and
        // also on a genuine failure. Both fail closed here.
        differs = true;
      }
      if (differs) {
        report.stale.push(
          `what the build reads differs between "${built.revision}" and the files on disk` +
            (git.dirty ? ' (this working tree has uncommitted changes)' : '')
        );
      } else {
        report.identity =
          built.revision === git.describe && !git.dirty ? IDENTITY.EXACT : IDENTITY.EQUIVALENT;
        report.revision.matches = built.revision === git.describe;
        report.revision.provable = true;
        if (report.identity === IDENTITY.EQUIVALENT) {
          report.warnings.push(
            `the renderer was built from "${built.revision}" rather than from HEAD, but nothing the build reads ` +
              `differs between that commit and the files on disk` +
              (git.dirty ? ', and this tree\'s uncommitted changes are all outside those files' : '')
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // What a git comparison cannot speak for.
  // -------------------------------------------------------------------------
  const tree = auditTree(git, inputs);
  report.tree = tree;
  if (tree.error) {
    report.refusals.push(
      `the build inputs could not be audited for untracked files (${tree.error}), so the comparison above cannot be trusted to cover them`
    );
  } else {
    if (tree.untracked && tree.untracked.length) {
      report.refusals.push(
        `${tree.untracked.length} untracked file(s) sit under the build inputs and would be compiled while being ` +
          `invisible to every comparison: ${tree.untracked.slice(0, 5).join(', ')}` +
          (tree.untracked.length > 5 ? ', …' : '')
      );
    }
    if (tree.ignored && tree.ignored.length) {
      report.warnings.push(
        `${tree.ignored.length} generated file(s) under the build inputs are ignored by git and cannot be compared ` +
          `by content — covered only by the modification-time check: ${tree.ignored.join(', ')}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Times, for the two artifacts that carry no revision of their own.
  // -------------------------------------------------------------------------
  const newest = newestInput(repo, deps);
  report.newest_input = newest.file ? { file: path.relative(repo, newest.file), mtimeMs: newest.at } : null;
  for (const u of newest.unreadable) {
    report.refusals.push(`a declared build input could not be read (${u.file}: ${u.why}), so it was never compared`);
  }
  if (newest.file) {
    for (const a of report.artifacts) {
      if (NOT_COMPILED_HERE.has(a.label)) continue;
      if (a.mtimeMs < newest.at) {
        report.stale.push(
          `${a.label} (${path.relative(repo, a.path)}) is older than ${path.relative(repo, newest.file)}`
        );
      }
    }
  }

  // The label and the decision must never disagree: anything that refuses is
  // unverified, whatever the revision comparison alone concluded.
  if (report.refusals.length) {
    report.identity = IDENTITY.UNVERIFIED;
    report.revision.provable = false;
  }
  report.ok = report.refusals.length === 0 && report.stale.length === 0;
  if (!report.ok) {
    if (report.refusals.length) {
      report.reason = `the build's identity could not be established: ${report.refusals.join('; ')}.`;
      report.advice = RECOVER(repo);
    } else {
      report.reason = `the build does not match this checkout: ${report.stale.join('; ')}.`;
      report.advice = REBUILD(repo);
    }
  }
  return report;
}

// How this reads on a terminal, as lines. Kept separate from `inspect` so the
// facts can be checked without parsing prose.
function lines(report) {
  const out = ['Build identity'];
  for (const a of report.artifacts) {
    out.push(
      a.exists
        ? `  ok      ${a.label} — ${a.path} (${(a.size / 1024).toFixed(0)} KB, ${new Date(a.mtimeMs).toISOString()})`
        : `  MISSING ${a.label} — ${a.path}`
    );
  }
  if (report.git && !report.git.error) {
    out.push(`  commit  ${report.git.head}${report.git.dirty ? ' (working tree has uncommitted changes)' : ''}`);
    out.push(`          ${report.git.branch} · ${report.git.committed} · ${report.git.subject}`);
  }
  if (report.revision.built) out.push(`  renderer built from   ${report.revision.built}`);
  else if (report.revision.built_why) out.push(`  renderer built from   unknown (${report.revision.built_why})`);
  if (report.revision.checkout) out.push(`  this checkout is      ${report.revision.checkout}`);
  out.push(`  identity              ${report.identity.toUpperCase()}`);
  if (report.identity === 'exact') {
    out.push('    the renderer states this checkout\'s revision, the tree is clean, and nothing the build reads differs');
  } else if (report.identity === 'equivalent') {
    out.push('    a different but CLEAN commit, and nothing the build reads differs from the files on disk');
  }
  if (report.newest_input) {
    out.push(
      `  newest build input    ${report.newest_input.file} (${new Date(report.newest_input.mtimeMs).toISOString()})`
    );
  }
  for (const w of report.warnings) out.push(`  NOTE    ${w}`);
  for (const r of report.refusals) out.push(`  REFUSED ${r}`);
  for (const s2 of report.stale) out.push(`  STALE   ${s2}`);
  out.push('  what this does not prove:');
  for (const l of report.limits || []) out.push(`    · ${l}`);
  return out;
}

module.exports = { inspect, lines, revisionOf, gitState, newestInput, auditTree, commitOf, IDENTITY, LIMITS, ARTIFACTS, INPUTS, REBUILD, RECOVER };
