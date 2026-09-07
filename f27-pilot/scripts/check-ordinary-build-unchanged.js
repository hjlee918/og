#!/usr/bin/env node
'use strict';
//
// Does the pilot's source change alter an ORDINARY build at all?
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
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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
  const a = sha256(A_OUT);

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

  const b = sha256(B_OUT);
  console.log('  from pilot branch : ' + a);
  console.log('  from accepted     : ' + b);

  if (a !== b) {
    console.error('\n[ordinary-build] DIFFERENT: the pilot source change alters ordinary builds.\n');
    process.exit(1);
  }
  console.log('\n[ordinary-build] IDENTICAL: an ordinary build is byte-for-byte unchanged ' +
              'by the pilot source edits.\n');
  fs.writeFileSync(path.join(REPO, 'tmp', 'ordinary-build-equivalence.json'),
    JSON.stringify({ acceptedCommit: ACCEPTED, pilotCommit: git('rev-parse', 'HEAD'),
                     sha256: a, identical: true, at: new Date().toISOString() }, null, 2) + '\n');
}

main();
