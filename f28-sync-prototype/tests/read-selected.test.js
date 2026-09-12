'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { applyOperation, createState, stableStringify } = require('../src/core');
const {
  applyBatch, encodeProtocol, initialize, readSelected,
} = require('../src/filesystem-coordinator');
const { snapshotFingerprint } = require('../src/planner');
const { APPROVED_TEST_ROOT } = require('../src/persistence');

const helper = process.env.F28_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !runName || !ownerToken) throw new Error('F28_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
const caseSuffix = process.env.F28_CASE_SUFFIX || '';
const caseNameFor = (name) => `${name}${caseSuffix}`;
const runRoot = path.join(APPROVED_TEST_ROOT, runName);
const base = createState('read-selected-graph');
const event = (eventId, kind, fileId, revisionId, values = {}) =>
  ({ eventId, kind, fileId, revisionId, ...values });

function treeEvidence(root) {
  const entries = [];
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name), child = path.join(relative, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries.push([child, 'link', fs.readlinkSync(absolute)]);
      else if (stat.isDirectory()) { entries.push([child, 'directory']); walk(absolute, child); }
      else entries.push([child, 'file', stat.mode, fs.readFileSync(absolute).toString('hex')]);
    }
  }
  walk(root);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function readRequest(caseName, failurePoint = 'none') {
  const placeholder = createState('read-selected-protocol');
  return {
    command: 'read-selected', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    state: stableStringify(placeholder), projectedFingerprint: snapshotFingerprint(placeholder), failurePoint,
  };
}

function waitForHook(child, text, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('helper hook timed out')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(text)) { clearTimeout(timer); resolve(); }
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('helper exit timed out')); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('read-selected returns verified Korean/English state and leaves entries and bytes unchanged', () => {
  const caseName = caseNameFor('read-normal');
  initialize({ helper, runName, caseName, ownerToken, state: base });
  const applied = applyBatch({ helper, runName, caseName, ownerToken, sourceSnapshot: base, events: [
    event('create-ko', 'create', 'file-ko', 'revision-ko', {
      path: 'pages/회의 Notes.md', content: '안녕하세요\nEnglish line',
    }),
    event('create-en', 'create', 'file-en', 'revision-en', {
      path: 'journals/2026_09_12.org', content: 'English\n한국어',
    }),
  ] });
  const caseRoot = path.join(runRoot, caseName), before = treeEvidence(caseRoot);
  const selected = readSelected({ helper, runName, caseName, ownerToken });
  assert.equal(selected.generation, applied.request.transactionId);
  assert.deepEqual(selected.state, applied.state);
  assert.deepEqual(selected.files, [
    { path: 'journals/2026_09_12.org', content: 'English\n한국어' },
    { path: 'pages/회의 Notes.md', content: '안녕하세요\nEnglish line' },
  ]);
  assert.equal(treeEvidence(caseRoot), before);
});

test('missing metadata is refused without auto-initialization', () => {
  const caseName = caseNameFor('read-missing-metadata'), caseRoot = path.join(runRoot, caseName);
  fs.mkdirSync(caseRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(caseRoot, 'OWNER'), `${ownerToken}\n`, { mode: 0o600, flag: 'wx' });
  const before = treeEvidence(caseRoot);
  assert.throws(() => readSelected({ helper, runName, caseName, ownerToken }), /directory open refused/);
  assert.equal(treeEvidence(caseRoot), before);
  assert.equal(fs.existsSync(path.join(caseRoot, '.f28-sync')), false);
});

test('invalid ownership is refused without mutation', () => {
  const caseName = caseNameFor('read-owner');
  initialize({ helper, runName, caseName, ownerToken, state: base });
  const caseRoot = path.join(runRoot, caseName), before = treeEvidence(caseRoot);
  assert.throws(() => readSelected({ helper, runName, caseName, ownerToken: 'f'.repeat(64) }), /ownership refused/);
  assert.equal(treeEvidence(caseRoot), before);
});

test('missing existing lock is refused without creating a replacement', () => {
  const caseName = caseNameFor('read-missing-lock');
  initialize({ helper, runName, caseName, ownerToken, state: base });
  const meta = path.join(runRoot, caseName, '.f28-sync');
  fs.renameSync(path.join(meta, 'LOCK'), path.join(meta, 'LOCK.missing'));
  const before = treeEvidence(path.join(runRoot, caseName));
  assert.throws(() => readSelected({ helper, runName, caseName, ownerToken }), /existing read lock refused/);
  assert.equal(treeEvidence(path.join(runRoot, caseName)), before);
  assert.equal(fs.existsSync(path.join(meta, 'LOCK')), false);
});

test('selector changed during read is refused and the helper does not rewrite it', async () => {
  const caseName = caseNameFor('read-selector-change');
  initialize({ helper, runName, caseName, ownerToken, state: base });
  applyBatch({ helper, runName, caseName, ownerToken, sourceSnapshot: base, events: [
    event('create', 'create', 'file', 'revision', { path: 'pages/a.md', content: 'a' }),
  ] });
  const meta = path.join(runRoot, caseName, '.f28-sync');
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(encodeProtocol(readRequest(caseName, 'pause-read-before-recheck')));
  await waitForHook(child, 'HOOK pause-read-before-recheck');
  fs.writeFileSync(path.join(meta, 'CURRENT'), `${'0'.repeat(64)}\n`);
  const afterInjection = treeEvidence(path.join(runRoot, caseName));
  const code = await waitForExit(child);
  assert.equal(code, 23);
  assert.match(Buffer.concat(stderr).toString(), /CURRENT changed during read/);
  assert.equal(fs.readFileSync(path.join(meta, 'CURRENT'), 'utf8'), `${'0'.repeat(64)}\n`);
  assert.equal(treeEvidence(path.join(runRoot, caseName)), afterInjection);
});
