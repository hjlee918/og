#!/usr/bin/env node
'use strict';
//
// Does the pilot's source change alter an ORDINARY build at all?
//
// Byte-identity is the goal, but it is NOT the priority: a guard belongs at the
// filesystem operation it protects, even when placing it there changes what the
// compiler emits for an ordinary build. Where that happens the divergence is
// named and bounded here rather than the guard being moved somewhere less
// effective to keep a hash.
//
// Builds the :electron target twice with `electron.pilot/PILOT` left at its
// default:
//
//   A. from this branch's sources (pilot guards present but compiled out)
//   B. from the accepted commit's electron sources, restored temporarily
//
// and compares the two bundles byte for byte. Identical output is the strongest
// statement available here that ordinary Logseq OG behaviour is unchanged: not
// "the guards are dormant", but "the compiler produced the same program".
//
// The working tree is restored in a finally block and re-verified afterwards.
// It refuses to start on a dirty tree so a failure can never lose work.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ACCEPTED = '5b34566cadd20df6724a013b4dc384b813e2018a';
const ELECTRON_SRC = 'src/electron';
const PILOT_NS = path.join(REPO, ELECTRON_SRC, 'electron', 'pilot.cljs');

const A_OUT = path.join(REPO, 'tmp', 'ordinary-from-pilot-branch.js');
const B_OUT = path.join(REPO, 'tmp', 'ordinary-from-accepted.js');

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

// The two builds must be written to different files, so their trailing
// `//# sourceMappingURL=` comment necessarily names a different file. That one
// line -- and nothing else -- is normalised away before comparing. The raw
// hashes are printed too, so the normalisation is visible rather than implied.
const SOURCE_MAP_COMMENT = /^\/\/# sourceMappingURL=.*$/m;
function normalised(p) {
  const text = fs.readFileSync(p, 'utf8');
  const stripped = text.replace(SOURCE_MAP_COMMENT, '//# sourceMappingURL=<normalised>');
  return { raw: text, stripped, lines: text.split('\n').length };
}
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function buildTo(outAbs) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  if (fs.existsSync(outAbs)) fs.rmSync(outAbs);
  execFileSync('clojure',
    ['-M:cljs', 'release', 'electron', '--config-merge',
     `{:output-to "${path.relative(REPO, outAbs)}"}`],
    { cwd: REPO, stdio: 'inherit' });
  if (!fs.existsSync(outAbs)) throw new Error(`no output at ${outAbs}`);
  return outAbs;
}

function main() {
  if (git('status', '--porcelain', '--', ELECTRON_SRC)) {
    console.error('[ordinary-build] REFUSED: uncommitted changes under ' + ELECTRON_SRC +
      '. Commit first: this script rewrites those files temporarily.');
    process.exit(1);
  }

  console.log('[ordinary-build] A: building from ' + git('rev-parse', '--short', 'HEAD'));
  buildTo(A_OUT);

  let restored = false;
  try {
    console.log(`[ordinary-build] B: restoring ${ELECTRON_SRC} from ${ACCEPTED.slice(0, 9)}`);
    git('checkout', ACCEPTED, '--', ELECTRON_SRC);
    fs.rmSync(PILOT_NS, { force: true });   // not present in the accepted commit
    buildTo(B_OUT);
  } finally {
    git('checkout', 'HEAD', '--', ELECTRON_SRC);
    const dirty = git('status', '--porcelain', '--', ELECTRON_SRC);
    restored = dirty === '';
    console.log('[ordinary-build] working tree restored: ' + (restored ? 'yes' : 'NO -- ' + dirty));
  }
  if (!restored) {
    console.error('[ordinary-build] FAILED to restore the working tree; stopping.');
    process.exit(2);
  }

  const A = normalised(A_OUT);
  const B = normalised(B_OUT);

  console.log('  from pilot branch : raw ' + hash(A.raw));
  console.log('  from accepted     : raw ' + hash(B.raw));
  console.log('  normalised        : ' + hash(A.stripped) + ' / ' + hash(B.stripped));

  // Text that must NEVER appear in an ordinary build. This is the hard check:
  // whatever the compiler does with layout, no pilot guard may ship.
  const PILOT_ONLY = [
    'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1', 'pilotRefused', 'graph-select',
    'followSymlinks', 'dropped watcher event', 'recursive copy is not available',
    'pilot-guard-journal', 'skipped setAsDefaultProtocolClient',
  ];
  const leaked = PILOT_ONLY.filter((t) => A.raw.includes(t));
  if (leaked.length) {
    console.error(`\n[ordinary-build] FAILED: pilot-only text in an ordinary build: ${leaked.join(', ')}\n`);
    process.exit(1);
  }

  // Behaviour that must still be there.
  const MUST_KEEP = ['setAsDefaultProtocolClient', 'check-for-updates', 'install-updates',
                     'chokidar', 'registerFileProtocol', 'ensureDirSync'];
  const lost = MUST_KEEP.filter((t) => !A.raw.includes(t));
  if (lost.length) {
    console.error(`\n[ordinary-build] FAILED: an ordinary build lost ${lost.join(', ')}\n`);
    process.exit(1);
  }

  if (A.stripped === B.stripped) {
    console.log('\n[ordinary-build] IDENTICAL: apart from the sourceMappingURL comment naming ' +
                'each output file, an ordinary build of the pilot branch is byte-for-byte the ' +
                'same program as one built from the accepted sources.\n');
  } else {
    // Bounded divergence. The one accepted cause is documented below; anything
    // larger than this is a failure, not a note.
    // Counting by index is wrong the moment a line is inserted: everything
    // after it reads as different. This aligns the two first.
    const al = A.stripped.split('\n'), bl = B.stripped.split('\n');
    const n = al.length, m = bl.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = al[i] === bl[j] ? lcs[i + 1][j + 1] + 1
                                    : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0, j = 0, changedLines = 0, blocks = 0, inBlock = false;
    while (i < n && j < m) {
      if (al[i] === bl[j]) { i++; j++; inBlock = false; continue; }
      if (!inBlock) { blocks++; inBlock = true; }
      changedLines++;
      if (lcs[i + 1][j] >= lcs[i][j + 1]) i++; else j++;
    }
    changedLines += (n - i) + (m - j);
    if (i < n || j < m) blocks++;
    const deltaBytes = Math.abs(A.stripped.length - B.stripped.length);

    // Bounds set to the measured divergence plus a little headroom, so a NEW
    // divergence fails here rather than being absorbed silently. Measured:
    // 124 bytes, 9 changed lines, 2 blocks.
    const MAX_BYTES = 256;
    const MAX_LINES = 12;
    console.log('\n[ordinary-build] EQUIVALENT WITH ONE DOCUMENTED DIVERGENCE');
    console.log('  cause: electron.fs-watcher/publish-file-event! is split so the pilot check');
    console.log('         runs BEFORE the child path is read or stated. In an ordinary build the');
    console.log('         original body is unchanged but is now reached through a one-line');
    console.log('         wrapper, which also shifts a few generated symbol names.');
    console.log(`  size:  ${deltaBytes} byte(s), ${changedLines} changed line(s) in ` +
                `${blocks} block(s)`);
    console.log('  hard checks: no pilot-only text present; every listed behaviour retained.');
    if (deltaBytes > MAX_BYTES || changedLines > MAX_LINES) {
      console.error(`\n[ordinary-build] FAILED: divergence exceeds the documented bound ` +
                    `(${deltaBytes} bytes / ${changedLines} changed lines, allowed ` +
                    `${MAX_BYTES} / ${MAX_LINES}).\n`);
      process.exit(1);
    }
    console.log('');
  }

  fs.writeFileSync(path.join(REPO, 'tmp', 'ordinary-build-equivalence.json'),
    JSON.stringify({ acceptedCommit: ACCEPTED, pilotCommit: git('rev-parse', 'HEAD'),
                     identical: A.stripped === B.stripped,
                     normalisedSha256: hash(A.stripped),
                     rawSha256: { pilotBranch: hash(A.raw), accepted: hash(B.raw) },
                     normalisation: 'the trailing //# sourceMappingURL= comment only',
                     at: new Date().toISOString() }, null, 2) + '\n');
}

main();
