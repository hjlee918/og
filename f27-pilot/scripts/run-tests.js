#!/usr/bin/env node
'use strict';
// Runs the focused pilot tests. Named explicitly rather than by directory,
// because node's test runner would otherwise treat tests/helpers.js as a suite.
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const FILES = ['preflight.test.js', 'isolation.test.js', 'guards.test.js',
               'boundary.test.js', 'recursive-access.test.js']
  .map((f) => path.join('f27-pilot', 'tests', f));
try {
  execFileSync(process.execPath, ['--test'].concat(FILES), { cwd: REPO, stdio: 'inherit' });
} catch (e) {
  process.exit(e.status === undefined ? 1 : e.status);
}
