#!/usr/bin/env node
'use strict';
//
// The focused test run for this branch.
//
//   node f28-refpath/scripts/run-feature-tests.js
//
// Three suites, and one deliberate exclusion recorded in ONE visible place.
//
// The accepted pilot's five test files are run UNMODIFIED, because the pilot's
// guards are unchanged by this feature and their tests are the regression that
// proves it. Two of those tests are about "the real built application directory
// in this checkout", and in this checkout that directory holds the F28 build:
//
//   * 'the compiled pilot bundle is the one the manifest describes' also pins
//     the accepted renderer revision 5b34566ca, which this build must NOT carry;
//   * 'the real built application directory passes its own preflight' reads the
//     pilot's manifest filename and the pilot's identity.
//
// Neither is weakened or edited. They are skipped BY NAME here, and both
// properties are re-asserted against the F28 build — including the requirement
// that it does not carry the accepted revision — in
// `f28-refpath/tests/feature-build.test.js`.
//
// The INHERITED F27 feature tests are also run, unmodified. They are not this
// branch's, but they are in this checkout and they assert that the two earlier
// builds still refuse to run here — which is the property that keeps three
// build identities apart in one clone. Their own `feature-build` suite is
// skipped: it verifies static/ against the F27 INLINE identity, and static/ now
// holds the F28 build, so running it would be asking the wrong question rather
// than finding an answer.
//
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

const PILOT_FILES = ['preflight.test.js', 'isolation.test.js', 'guards.test.js',
                     'boundary.test.js', 'recursive-access.test.js']
  .map((f) => path.join('f27-pilot', 'tests', f));

const F28_FILES = ['feature-build.test.js', 'graph-fixture.test.js',
                   'browser-noise.test.js', 'packaged-app.test.js']
  .map((f) => path.join('f28-refpath', 'tests', f));

// The inherited F27 suites that are still true in this checkout: the fixture
// rules and the error classifier are about their own tooling, which this branch
// does not change and does use.
const INHERITED_FILES = ['graph-fixture.test.js', 'mutable-fixture.test.js',
                         'error-classifier.test.js']
  .map((f) => path.join('f27-inline', 'tests', f));

// Exactly the two pilot tests above, by name.
const SKIP = '(the compiled pilot bundle is the one the manifest describes' +
             '|the real built application directory passes its own preflight)';

function run(label, args) {
  console.log(`\n=== ${label} ===\n`);
  try {
    execFileSync(process.execPath, args, { cwd: REPO, stdio: 'inherit' });
    return 0;
  } catch (e) {
    return e.status === undefined ? 1 : e.status;
  }
}

let status = 0;

status |= run(
  'pilot guard regression (unmodified; 2 build-specific tests skipped by name, ' +
  'replaced in f28-refpath/tests/feature-build.test.js)',
  ['--test', `--test-skip-pattern=${SKIP}`].concat(PILOT_FILES));

status |= run('F28 build identity, fixture rules, the named browser notice, ' +
              'the exact-path gate and the launcher\'s cleanup ownership',
              ['--test'].concat(F28_FILES));

status |= run('inherited F27 tooling regression (fixtures and error classification)',
              ['--test'].concat(INHERITED_FILES));

process.exit(status ? 1 : 0);
