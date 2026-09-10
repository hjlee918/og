"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const NET = require('../checks/network-refusal');
test('unsafe activation refuses before taking process ownership', async () => {
  let calls = 0;
  await assert.rejects(NET.launchWith(async () => { calls++; throw new Error('must not launch'); })({}), /activation blocked/);
  assert.equal(calls, 0);
  await assert.rejects(NET.install({ evaluate() { calls++; } }), /activation blocked/);
  assert.equal(calls, 0);
});
test('experiment entry refuses before any profile or graph work', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../f28-refpath/checks/plugin-coexistence-checks.js'), 'utf8');
  assert.match(source, /async function main\(\) \{\s*\/\/[^\n]*\n\s*if \(EXPERIMENT\) NET.assertReady\(\);/);
});
test('default packaged build selection cannot implicitly select the experiment', () => {
  const APP = require('../../f28-refpath/checks/packaged-app');
  assert.notEqual(APP.resolve().appName, 'Logseq-OG-F28-OriginExp');
});
