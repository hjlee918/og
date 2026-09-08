#!/usr/bin/env node
'use strict';
//
// The focused test run for this checkout.
//
//   node f27-outgoing/scripts/run-feature-tests.js
//
// Two suites, and one deliberate exclusion recorded in ONE visible place.
//
// The accepted pilot's five test files are run UNMODIFIED, because the pilot's
// guards are unchanged by this feature and their tests are the regression that
// proves it. Two of those tests are about "the real built application directory
// in this checkout", and in this checkout that directory holds the FEATURE
// build:
//
//   * 'the compiled pilot bundle is the one the manifest describes' also pins
//     the accepted renderer revision 5b34566ca, which this build must NOT carry;
//   * 'the real built application directory passes its own preflight' reads the
//     pilot's manifest filename and the pilot's identity.
//
// Neither is weakened or edited. They are skipped BY NAME here, and both
// properties are re-asserted against the feature build — including the
// requirement that it does not carry the accepted revision — in
// `f27-outgoing/tests/feature-build.test.js`.
//
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

const PILOT_FILES = ['preflight.test.js', 'isolation.test.js', 'guards.test.js',
                     'boundary.test.js', 'recursive-access.test.js']
  .map((f) => path.join('f27-pilot', 'tests', f));

const FEATURE_FILES = ['feature-build.test.js', 'graph-fixture.test.js']
  .map((f) => path.join('f27-outgoing', 'tests', f));

// Exactly the two tests above, by name.
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
  'replaced in f27-outgoing/tests/feature-build.test.js)',
  ['--test', `--test-skip-pattern=${SKIP}`].concat(PILOT_FILES));

status |= run('feature build identity, integrity and fixture rules',
              ['--test'].concat(FEATURE_FILES));

process.exit(status ? 1 : 0);
