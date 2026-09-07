'use strict';
//
// Which commit is the preview actually running?
//
// The preview is a LOCAL TEST BUILD. It is not an installer, not a release and
// not a replacement for the application the user runs every day — so the one
// thing it owes the reader is an honest answer to "what code is this?", and a
// refusal when it cannot give one.
//
// There are two independent facts to read, and this module reads both:
//
//   1. THE REVISION COMPILED INTO THE RENDERER. `shadow-cljs.edn` runs
//      `shadow.hooks/git-revision-hook` on the `:app` build, which puts
//      `git describe --long --always --dirty` into the closure define
//      `frontend.config.REVISION`. It is written near the top of
//      `static/js/main.js`, so it can be read without loading 32 MB. This is
//      the renderer's own account of where it came from — not an inference.
//
//   2. WHAT THE CHECKOUT SAYS NOW. The same `git describe`, plus the full
//      `HEAD` and whether the working tree is clean.
//
// If those two disagree, the window would show code other than the commit this
// preview claims to demonstrate, so the launch is refused with the rebuild
// command. `static/electron.js` and `static/css/style.css` carry no revision of
// their own; for those the check is a modification-time comparison against the
// sources the build actually reads.
//
// A dirty working tree is reported, never silently accepted: `<sha>-dirty`
// names a commit but not a state, so two different dirty trees produce the same
// string. Identity is then *unprovable* rather than *established*, and the
// report says so.
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
  const visit = (p) => {
    let st;
    try {
      st = io.statSync(p);
    } catch (e) {
      return; // an input that is not there cannot make a build stale
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = io.readdirSync(p);
      } catch (e) {
        return;
      }
      for (const e of entries) {
        if (e === '.DS_Store' || e === 'node_modules' || e === '.git') continue;
        visit(path.join(p, e));
      }
      return;
    }
    const at = st.mtimeMs;
    if (at > newest.at) newest = { at, file: p };
  };
  for (const rel of (deps && deps.inputs) || INPUTS) visit(path.join(repo, rel));
  return newest;
}

// ---------------------------------------------------------------------------
// The whole answer, in the order a reader needs it.
// ---------------------------------------------------------------------------
function inspect(repo, deps) {
  const io = (deps && deps.fs) || fs;
  const report = {
    repo,
    artifacts: [],
    missing: [],
    stale: [],
    warnings: [],
    revision: { built: null, checkout: null, matches: null, provable: false },
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
    report.reason =
      `${report.missing.length} build artifact(s) are missing: ${report.missing.join(', ')}.`;
    report.advice = REBUILD(repo);
    return report;
  }

  const git = gitState(repo, deps);
  report.git = git;
  const built = revisionOf(path.join(repo, 'static/js/main.js'), deps);
  report.revision.built = built.revision;
  report.revision.built_why = built.why;
  report.revision.checkout = git.describe || null;

  if (git.error) {
    report.warnings.push(`the checkout's own revision could not be read (${git.error}), so the build cannot be compared to it`);
  } else if (!built.revision) {
    report.warnings.push(`${built.why}, so the renderer cannot be compared to the checkout`);
  } else {
    report.revision.matches = built.revision === git.describe;
    // `-dirty` names a commit but not a state: two different uncommitted trees
    // describe identically, so a match here is not proof.
    report.revision.provable = report.revision.matches && !git.dirty;
    if (!report.revision.matches) {
      // A DIFFERENT commit is not automatically a different application. This
      // repository holds the preview tooling beside the application, so a
      // commit that changed only the tooling leaves the built code correct.
      // The question asked is therefore the precise one: does anything the
      // build actually READS differ between the two commits?
      const inputs = (deps && deps.inputs) || INPUTS;
      const from = commitOf(built.revision);
      let same = null;
      try {
        git.run(['rev-parse', '--verify', '--quiet', from + '^{commit}']);
        git.run(['diff', '--quiet', from, 'HEAD', '--'].concat(inputs));
        same = true;
      } catch (e) {
        // `git diff --quiet` exits 1 when there IS a difference, and
        // `rev-parse --verify` fails when the commit is not in this checkout.
        // Both land here; they are told apart below.
        same = false;
      }
      report.revision.same_build_inputs = same;
      if (same) {
        report.warnings.push(
          `the compiled renderer was built from "${built.revision}", not from HEAD, but nothing the build reads ` +
            `differs between them — the window runs this checkout's application code`
        );
      } else {
        report.stale.push(
          `the compiled renderer was built from "${built.revision}", but this checkout is "${git.describe}"`
        );
      }
    } else if (git.dirty) {
      report.warnings.push(
        'the working tree has uncommitted changes, so "' +
          git.describe +
          '" names a commit but not a state — the build cannot be proved to be this checkout'
      );
    }
  }

  // Times, for the two artifacts that carry no revision of their own.
  const newest = newestInput(repo, deps);
  report.newest_input = newest.file ? { file: path.relative(repo, newest.file), mtimeMs: newest.at } : null;
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

  report.ok = report.stale.length === 0;
  if (!report.ok) {
    report.reason = `the build does not match this checkout: ${report.stale.join('; ')}.`;
    report.advice = REBUILD(repo);
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
    out.push(`  commit  ${report.git.head}`);
    out.push(`          ${report.git.branch} · ${report.git.committed} · ${report.git.subject}`);
  }
  if (report.revision.built) out.push(`  renderer built from   ${report.revision.built}`);
  else if (report.revision.built_why) out.push(`  renderer built from   unknown (${report.revision.built_why})`);
  if (report.revision.checkout) out.push(`  this checkout is      ${report.revision.checkout}`);
  if (report.revision.provable) {
    out.push('  the renderer states the same revision this checkout reports, and the tree is clean');
  } else if (report.revision.same_build_inputs) {
    out.push('  a different commit, but identical in everything the build reads');
  }
  if (report.newest_input) {
    out.push(
      `  newest build input    ${report.newest_input.file} (${new Date(report.newest_input.mtimeMs).toISOString()})`
    );
  }
  for (const w of report.warnings) out.push(`  NOTE    ${w}`);
  for (const s of report.stale) out.push(`  STALE   ${s}`);
  return out;
}

module.exports = { inspect, lines, revisionOf, gitState, newestInput, commitOf, ARTIFACTS, INPUTS, REBUILD };
