#!/usr/bin/env node
'use strict';
//
// Builds the :electron target with `electron.pilot/PILOT` left at its default
// (false) and writes it to tmp/, NEVER to static/. This is the reference used
// by tests/guards.test.js to show that the pilot source changes are absent --
// not merely dormant -- in an ordinary build.
//
// The result is a build artifact and is not committed.
//
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'tmp', 'nonpilot-electron.js');

const SOURCES = ['src/electron', 'shadow-cljs.edn', 'deps.edn'];

function newestSourceMtime() {
  let newest = 0;
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else newest = Math.max(newest, st.mtimeMs);
  };
  for (const s of SOURCES) walk(path.join(REPO, s));
  return newest;
}

function build({ force = false } = {}) {
  if (!force && fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs > newestSourceMtime()) {
    return OUT;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('clojure',
    ['-M:cljs', 'release', 'electron', '--config-merge',
     `{:output-to "${path.relative(REPO, OUT)}"}`],
    { cwd: REPO, stdio: 'inherit' });
  if (!fs.existsSync(OUT)) throw new Error(`build produced no ${OUT}`);
  return OUT;
}

module.exports = { build, OUT };

if (require.main === module) {
  const p = build({ force: process.argv.includes('--force') });
  console.log(`[nonpilot-reference] ${p} (${fs.statSync(p).size} bytes)`);
}
