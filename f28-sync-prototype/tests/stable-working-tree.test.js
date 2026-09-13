'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createState } = require('../src/core');
const { applyPreview, createApplyRequest, previewComparison } = require('../src/compare-workflow');
const { applyBatch, initialize, readSelected } = require('../src/filesystem-coordinator');
const { APPROVED_TEST_ROOT } = require('../src/persistence');
const { TARGET_SCHEMA } = require('../src/snapshot-comparison');
const {
  applyStablePreview, causeRecords, classifyWatcherEvents, encodeWorkingProtocol,
  initializeWorkingTree, invokeWorking, prepareWorkingRequest, preflightWorkingTree,
} = require('../src/stable-working-tree');

const helper = process.env.F28_HELPER;
const workingHelper = process.env.F28_WORKING_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !workingHelper || !runName || !ownerToken) {
  throw new Error('F28_HELPER, F28_WORKING_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
}
const suffix = process.env.F28_CASE_SUFFIX || '';
const runRoot = path.join(APPROVED_TEST_ROOT, runName);
const cname = (name) => `${name}${suffix}`;
const base = createState('stable-working-graph');
const event = (eventId, kind, fileId, revisionId, values = {}) =>
  ({ eventId, kind, fileId, revisionId, ...values });
const target = (files, values = {}) => ({
  schema: TARGET_SCHEMA, complete: false, authorizeMissingDeletes: false, files, ...values,
});

function hashTree(root) {
  const entries = [];
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name), child = path.join(relative, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries.push([child, 'link', fs.readlinkSync(absolute)]);
      else if (stat.isDirectory()) { entries.push([child, 'directory']); walk(absolute, child); }
      else entries.push([child, 'file', fs.readFileSync(absolute).toString('hex')]);
    }
  }
  walk(root);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function seed(caseName, files = []) {
  initialize({ helper, runName, caseName, ownerToken, state: base });
  if (files.length) {
    applyBatch({ helper, runName, caseName, ownerToken, sourceSnapshot: base,
      events: files.map((file, index) => event(`seed-${index}`, 'create', file.fileId,
        `seed-revision-${index}`, { path: file.path, content: file.content })) });
  }
  const selected = readSelected({ helper, runName, caseName, ownerToken });
  initializeWorkingTree({ workingHelper, runName, caseName, ownerToken, selected });
  return selected;
}

function preview(caseName, files, values = {}) {
  return previewComparison({ helper, runName, caseName, ownerToken,
    targetSnapshot: target(files, values) });
}

function stableApply(caseName, previewValue, values = {}) {
  return applyStablePreview({ helper, workingHelper, runName, caseName, ownerToken,
    preview: previewValue, applyRequest: createApplyRequest(previewValue), ...values });
}

function workingPath(caseName, relative = '') {
  return path.join(runRoot, caseName, 'working', relative);
}

function metadataPath(caseName, relative = '') {
  return path.join(runRoot, caseName, 'f28-work-meta', relative);
}

test('normal per-file create, update, rename and delete keep one stable working path', () => {
  const caseName = cname('normal');
  seed(caseName, [{ fileId: 'first', path: 'pages/first.md', content: 'before' }]);
  const workingInode = fs.statSync(workingPath(caseName)).ino;
  let result = stableApply(caseName, preview(caseName, [
    { fileId: 'first', path: 'pages/first.md', content: 'after 한국어' },
    { fileId: 'second', path: 'pages/second.org', content: 'created English' },
  ]));
  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/first.md'), 'utf8'), 'after 한국어');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/second.org'), 'utf8'), 'created English');

  result = stableApply(caseName, preview(caseName, [
    { fileId: 'first', path: 'pages/renamed.md', content: 'after 한국어' },
    { fileId: 'second', path: 'pages/second.org', content: 'created English' },
  ]));
  assert.equal(result.status, 'applied');
  assert.equal(fs.existsSync(workingPath(caseName, 'pages/first.md')), false);
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/renamed.md'), 'utf8'), 'after 한국어');

  result = stableApply(caseName, preview(caseName, [
    { fileId: 'first', path: 'pages/renamed.md', content: 'after 한국어' },
  ], { complete: true, authorizeMissingDeletes: true }));
  assert.equal(result.status, 'applied');
  assert.equal(fs.existsSync(workingPath(caseName, 'pages/second.org')), false);
  assert.equal(fs.statSync(workingPath(caseName)).ino, workingInode);
  assert.equal(JSON.parse(fs.readFileSync(metadataPath(caseName, 'accepted.json'), 'utf8')).files.second.heads.length, 1);
});

test('simulated local edit before apply refuses before publication', () => {
  const caseName = cname('edit-before');
  const selected = seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const proposal = preview(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'incoming' }]);
  fs.writeFileSync(workingPath(caseName, 'pages/a.md'), 'local edit');
  const result = stableApply(caseName, proposal);
  assert.equal(result.status, 'rejected');
  assert.equal(result.result.code, 'working-preflight-refused');
  assert.equal(readSelected({ helper, runName, caseName, ownerToken }).generation, selected.generation);
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/a.md'), 'utf8'), 'local edit');
});

test('interrupted multi-file application exposes and recovers an explicit mixed state', () => {
  const caseName = cname('partial');
  seed(caseName, [
    { fileId: 'one', path: 'pages/one.md', content: 'one-before' },
    { fileId: 'two', path: 'pages/two.md', content: 'two-before' },
  ]);
  const proposal = preview(caseName, [
    { fileId: 'one', path: 'pages/one.md', content: 'one-after' },
    { fileId: 'two', path: 'pages/two.md', content: 'two-after' },
  ]);
  assert.throws(() => stableApply(caseName, proposal, { failurePoint: 'after-action-1' }), /INJECTED/);
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/one.md'), 'utf8'), 'one-after');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/two.md'), 'utf8'), 'two-before');
  const recovered = stableApply(caseName, proposal);
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/two.md'), 'utf8'), 'two-after');
  assert.equal(stableApply(caseName, proposal).status, 'already-applied');
});

test('a simulated edit between actions is a preserved third state', async () => {
  const caseName = cname('between');
  seed(caseName, [
    { fileId: 'one', path: 'pages/one.md', content: 'one-before' },
    { fileId: 'two', path: 'pages/two.md', content: 'two-before' },
  ]);
  const proposal = preview(caseName, [
    { fileId: 'one', path: 'pages/one.md', content: 'one-after' },
    { fileId: 'two', path: 'pages/two.md', content: 'two-after' },
  ]);
  const request = prepareWorkingRequest({ runName, caseName, ownerToken, preview: proposal,
    failurePoint: 'pause-before-action-2' });
  preflightWorkingTree({ workingHelper, request });
  const published = applyPreview({ helper, runName, caseName, ownerToken, preview: proposal,
    applyRequest: createApplyRequest(proposal) });
  assert.equal(published.status, 'applied');
  const child = spawn(workingHelper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(encodeWorkingProtocol(request));
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('pause hook timeout')), 4000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('HOOK pause-before-action-2')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', reject);
  });
  fs.writeFileSync(workingPath(caseName, 'pages/two.md'), 'user edit during apply');
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 23);
  assert.match(Buffer.concat(stderr).toString(), /changed during action pause/);
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/one.md'), 'utf8'), 'one-after');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/two.md'), 'utf8'), 'user edit during apply');
  assert.throws(() => invokeWorking(workingHelper, { ...request, failurePoint: 'none' }), /third state/);
});

test('files-complete metadata-pending recovery and acknowledgement-loss retry are exact', () => {
  for (const [label, point] of [
    ['metadata-pending', 'before-metadata'],
    ['sync-interrupted', 'during-synchronization'],
    ['ack-loss', 'before-ack'],
  ]) {
    const caseName = cname(label);
    seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
    const proposal = preview(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
    assert.throws(() => stableApply(caseName, proposal, { failurePoint: point }), /INJECTED/);
    assert.equal(fs.readFileSync(workingPath(caseName, 'pages/a.md'), 'utf8'), 'next');
    const recovered = stableApply(caseName, proposal);
    assert.equal(recovered.status, 'applied');
    const second = stableApply(caseName, proposal);
    assert.equal(second.status, 'already-applied');
  }
});

test('parameter traversal and substituted working metadata directory links are refused', () => {
  const traversalCase = cname('parameter-traversal');
  seed(traversalCase);
  const traversalPreview = preview(traversalCase, [
    { fileId: 'file', path: 'pages/a.md', content: 'incoming' },
  ]);
  assert.equal(stableApply(traversalCase, traversalPreview, {
    workingDirectory: '../escape',
  }).status, 'rejected');
  assert.deepEqual(fs.readdirSync(workingPath(traversalCase)), []);

  const linkCase = cname('metadata-directory-link');
  seed(linkCase, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const linkPreview = preview(linkCase, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  const original = metadataPath(linkCase);
  const held = path.join(runRoot, linkCase, 'f28-work-meta-held');
  const acceptedBefore = fs.readFileSync(path.join(original, 'accepted.json'), 'utf8');
  fs.renameSync(original, held);
  fs.symlinkSync('f28-work-meta-held', original);
  assert.equal(stableApply(linkCase, linkPreview).status, 'rejected');
  assert.equal(fs.lstatSync(original).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(held, 'accepted.json'), 'utf8'), acceptedBefore);
});

test('exact watcher echoes are separated from different edits and reconstruct deterministically', () => {
  const caseName = cname('watcher');
  seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const proposal = preview(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  const request = prepareWorkingRequest({ runName, caseName, ownerToken, preview: proposal });
  const records = causeRecords(request);
  assert.deepEqual(causeRecords(structuredClone(request)), records);
  const changed = { ...records[0], newContentHash: crypto.createHash('sha256').update('user edit').digest('hex') };
  const result = classifyWatcherEvents(records, [records[0], changed]);
  assert.deepEqual(result.echoes, [records[0]]);
  assert.deepEqual(result.edits, [changed]);
});

test('occupied create and rename destinations refuse without overwriting', () => {
  const createCase = cname('occupied-create');
  seed(createCase);
  const createPreview = preview(createCase, [{ fileId: 'new', path: 'pages/new.md', content: 'incoming' }]);
  fs.mkdirSync(workingPath(createCase, 'pages'));
  fs.writeFileSync(workingPath(createCase, 'pages/new.md'), 'sentinel');
  assert.equal(stableApply(createCase, createPreview).status, 'rejected');
  assert.equal(fs.readFileSync(workingPath(createCase, 'pages/new.md'), 'utf8'), 'sentinel');

  const renameCase = cname('occupied-rename');
  seed(renameCase, [{ fileId: 'file', path: 'pages/old.md', content: 'source' }]);
  const renamePreview = preview(renameCase, [{ fileId: 'file', path: 'pages/new.md', content: 'source' }]);
  fs.writeFileSync(workingPath(renameCase, 'pages/new.md'), 'destination sentinel');
  assert.equal(stableApply(renameCase, renamePreview).status, 'rejected');
  assert.equal(fs.readFileSync(workingPath(renameCase, 'pages/old.md'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(workingPath(renameCase, 'pages/new.md'), 'utf8'), 'destination sentinel');
});

test('delete recovery rejects contradictory source and retained destination', () => {
  const caseName = cname('delete-third');
  seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'delete me' }]);
  const proposal = preview(caseName, [], { complete: true, authorizeMissingDeletes: true });
  assert.throws(() => stableApply(caseName, proposal, { failurePoint: 'after-action-1' }), /INJECTED/);
  fs.writeFileSync(workingPath(caseName, 'pages/a.md'), 'recreated user file');
  assert.equal(stableApply(caseName, proposal).status, 'rejected');
  assert.equal(fs.readFileSync(workingPath(caseName, 'pages/a.md'), 'utf8'), 'recreated user file');
  const recovery = path.join(metadataPath(caseName, 'recovery'));
  assert.ok(fs.readdirSync(recovery).length > 0);
});

test('Korean NFC/NFD and case collisions are refused before working publication', () => {
  for (const [label, paths] of [
    ['nfc', ['pages/한글.md', 'pages/한글.md'.normalize('NFD')]],
    ['case', ['pages/Alpha.md', 'pages/alpha.md']],
  ]) {
    const caseName = cname(`collision-${label}`);
    seed(caseName);
    const proposal = preview(caseName, paths.map((entry, index) => ({
      fileId: `file-${index}`, path: entry, content: `내용 ${index}`,
    })));
    assert.equal(proposal.status, 'rejected');
    assert.equal(stableApply(caseName, proposal).status, 'rejected');
    assert.deepEqual(fs.readdirSync(workingPath(caseName)), []);
  }
});

test('corrupt journal, interrupted staging and unexpected links are preserved and refused', () => {
  const corruptCase = cname('corrupt-journal');
  seed(corruptCase, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const corruptPreview = preview(corruptCase, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  assert.throws(() => stableApply(corruptCase, corruptPreview, { failurePoint: 'after-action-1' }), /INJECTED/);
  const corruptRequest = prepareWorkingRequest({ runName, caseName: corruptCase, ownerToken, preview: corruptPreview });
  const journal = path.join(metadataPath(corruptCase, 'journals'), `${corruptRequest.transactionId}.journal`);
  fs.writeFileSync(journal, 'corrupt retained journal');
  assert.equal(stableApply(corruptCase, corruptPreview).status, 'rejected');
  assert.equal(fs.readFileSync(journal, 'utf8'), 'corrupt retained journal');

  const corruptStageCase = cname('corrupt-stage');
  seed(corruptStageCase, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const corruptStagePreview = preview(corruptStageCase,
    [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  assert.throws(() => stableApply(corruptStageCase, corruptStagePreview,
    { failurePoint: 'after-action-1' }), /INJECTED/);
  const corruptStageRequest = prepareWorkingRequest({
    runName, caseName: corruptStageCase, ownerToken, preview: corruptStagePreview,
  });
  const beforeImage = path.join(metadataPath(corruptStageCase, 'staging'),
    corruptStageRequest.transactionId, '000.before');
  fs.writeFileSync(beforeImage, 'corrupt retained before-image');
  assert.throws(() => stableApply(corruptStageCase, corruptStagePreview),
    /staged before-image mismatch/);
  assert.equal(fs.readFileSync(beforeImage, 'utf8'), 'corrupt retained before-image');

  const stageCase = cname('stage-interrupt');
  seed(stageCase, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const stagePreview = preview(stageCase, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  assert.throws(() => stableApply(stageCase, stagePreview, { failurePoint: 'during-stage' }), /INJECTED/);
  assert.throws(() => stableApply(stageCase, stagePreview), /transaction directory create refused/);

  const linkCase = cname('unexpected-link');
  seed(linkCase);
  const linkPreview = preview(linkCase, [{ fileId: 'file', path: 'pages/a.md', content: 'incoming' }]);
  fs.mkdirSync(workingPath(linkCase, 'pages'));
  const sentinel = metadataPath(linkCase, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  fs.symlinkSync(sentinel, workingPath(linkCase, 'pages/a.md'));
  assert.equal(stableApply(linkCase, linkPreview).status, 'rejected');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(workingPath(linkCase, 'pages/a.md')).isSymbolicLink(), true);
});

test('retained before-images and prior generations remain unchanged across retry', () => {
  const caseName = cname('retention');
  const initial = seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const priorGeneration = path.join(runRoot, caseName, '.f28-sync', 'generations', initial.generation);
  const generationHash = hashTree(priorGeneration);
  const proposal = preview(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'next' }]);
  const result = stableApply(caseName, proposal);
  const beforeRoot = path.join(metadataPath(caseName, 'staging'), result.request.transactionId);
  const beforeHash = hashTree(beforeRoot);
  assert.equal(stableApply(caseName, proposal).status, 'already-applied');
  assert.equal(hashTree(priorGeneration), generationHash);
  assert.equal(hashTree(beforeRoot), beforeHash);
});
