'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createState } = require('../src/core');
const {
  applyPreview, createApplyRequest, previewComparison,
} = require('../src/compare-workflow');
const {
  applyBatch, initialize, invoke, prepareBatch,
} = require('../src/filesystem-coordinator');
const { APPROVED_TEST_ROOT } = require('../src/persistence');
const { TARGET_SCHEMA } = require('../src/snapshot-comparison');

const helper = process.env.F28_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !runName || !ownerToken) throw new Error('F28_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
const suffix = process.env.F28_CASE_SUFFIX || '';
const cname = (name) => `${name}${suffix}`;
const runRoot = path.join(APPROVED_TEST_ROOT, runName);
const base = createState('compare-workflow-graph');
const event = (eventId, kind, fileId, revisionId, values = {}) =>
  ({ eventId, kind, fileId, revisionId, ...values });
const target = (files, values = {}) => ({
  schema: TARGET_SCHEMA, complete: false, authorizeMissingDeletes: false, files, ...values,
});

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

function generations(caseName) {
  return fs.readdirSync(path.join(runRoot, caseName, '.f28-sync', 'generations')).sort();
}

function init(caseName) {
  initialize({ helper, runName, caseName, ownerToken, state: base });
}

function applyExact(caseName, preview, values = {}) {
  return applyPreview({
    helper, runName, caseName, ownerToken, preview,
    applyRequest: createApplyRequest(preview), ...values,
  });
}

function seed(caseName, files) {
  init(caseName);
  return applyBatch({ helper, runName, caseName, ownerToken, sourceSnapshot: base,
    events: files.map((file, index) => event(`seed-event-${index}`, 'create', file.fileId,
      `seed-revision-${index}`, { path: file.path, content: file.content })) });
}

test('preview is read-only; explicit apply and exact retry match the preview', () => {
  const caseName = cname('normal'); init(caseName);
  const caseRoot = path.join(runRoot, caseName), beforePreview = treeEvidence(caseRoot);
  const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: target([
    { fileId: 'english', path: 'pages/Notes.md', content: 'English line\n한국어' },
    { fileId: 'korean', path: 'pages/회의.org', content: '안녕하세요\nEnglish' },
  ]) });
  assert.equal(preview.status, 'ready');
  assert.equal(treeEvidence(caseRoot), beforePreview);
  const applied = applyExact(caseName, preview);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.selected.files, [
    { path: 'pages/Notes.md', content: 'English line\n한국어' },
    { path: 'pages/회의.org', content: '안녕하세요\nEnglish' },
  ]);
  assert.equal(applied.selected.snapshotFingerprint, preview.comparison.plan.projectedSnapshotFingerprint);
  const afterApplyGenerations = generations(caseName);
  const retry = applyExact(caseName, preview);
  assert.equal(retry.status, 'already-applied');
  assert.equal(retry.selected.generation, applied.selected.generation);
  assert.deepEqual(generations(caseName), afterApplyGenerations);
});

test('unchanged target is a successful no-op and publishes no generation', () => {
  const caseName = cname('no-op'); init(caseName);
  const before = treeEvidence(path.join(runRoot, caseName));
  const beforeGenerations = generations(caseName);
  const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: target([]) });
  assert.equal(preview.status, 'no-op');
  assert.equal(treeEvidence(path.join(runRoot, caseName)), before);
  const result = applyExact(caseName, preview);
  assert.equal(result.status, 'no-op');
  assert.equal(result.result.code, 'unchanged-target');
  assert.deepEqual(generations(caseName), beforeGenerations);
  assert.equal(treeEvidence(path.join(runRoot, caseName)), before);
});

test('invalid, ambiguous and normalized-collision previews cannot reach the writer', () => {
  const caseName = cname('invalid');
  seed(caseName, [{ fileId: 'existing', path: 'pages/existing.md', content: 'kept' }]);
  for (const invalidTarget of [
    target([{ fileId: 'existing', path: 'pages/existing.md', content: 42 }], {
      complete: true, authorizeMissingDeletes: true,
    }),
    target([
      { fileId: 'existing', path: 'pages/existing.md', content: 'one' },
      { fileId: 'existing', path: 'pages/existing.md', content: 'two' },
    ]),
    target([
      { fileId: 'one', path: 'pages/한글.md', content: '하나' },
      { fileId: 'two', path: 'pages/한글.md'.normalize('NFD'), content: '둘' },
    ]),
  ]) {
    const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: invalidTarget });
    assert.equal(preview.status, 'rejected');
    assert.equal(preview.comparison.plan, null);
    const before = treeEvidence(path.join(runRoot, caseName));
    const result = applyExact(caseName, preview);
    assert.equal(result.status, 'rejected');
    assert.equal(result.result.code, 'comparison-not-eligible');
    assert.equal(treeEvidence(path.join(runRoot, caseName)), before);
  }
});

test('tampered preview or explicit request is refused without publication', () => {
  const caseName = cname('tamper'); init(caseName);
  const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: target([
    { fileId: 'file', path: 'pages/a.md', content: 'a' },
  ]) });
  const before = treeEvidence(path.join(runRoot, caseName));
  const alteredPreview = structuredClone(preview);
  alteredPreview.comparison.plan.actions[0].operation.content = 'altered';
  const altered = applyPreview({ helper, runName, caseName, ownerToken, preview: alteredPreview,
    applyRequest: createApplyRequest(alteredPreview) });
  assert.equal(altered.result.code, 'preview-integrity-failed');
  const request = createApplyRequest(preview); request.targetFingerprint = `sha256:${'0'.repeat(64)}`;
  const mismatched = applyPreview({ helper, runName, caseName, ownerToken, preview, applyRequest: request });
  assert.equal(mismatched.result.code, 'apply-request-mismatch');
  assert.equal(treeEvidence(path.join(runRoot, caseName)), before);
});

test('destination change after preview is stale and native publisher checks exact generation', () => {
  const caseName = cname('stale');
  const seeded = seed(caseName, [{ fileId: 'file', path: 'pages/a.md', content: 'base' }]);
  const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: target([
    { fileId: 'file', path: 'pages/a.md', content: 'previewed' },
  ]) });
  const prepared = prepareBatch({ runName, caseName, ownerToken, sourceSnapshot: seeded.state,
    events: [event('direct', 'update', 'file', 'direct-revision', {
      parentRevisionId: 'seed-revision-0', content: 'destination changed',
    })] });
  prepared.request.selectedGeneration = preview.selected.generation;
  const changed = invoke(helper, prepared.request);
  assert.equal(changed.status, 'acknowledged');
  const selectedGeneration = changed.generation;
  const stale = applyExact(caseName, preview);
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.result.code, 'stale-preview');
  assert.equal(fs.readFileSync(path.join(runRoot, caseName, '.f28-sync', 'CURRENT'), 'utf8').trim(), selectedGeneration);

  const oldPrepared = prepareBatch({ runName, caseName, ownerToken, sourceSnapshot: seeded.state,
    events: [event('old', 'update', 'file', 'old-revision', {
      parentRevisionId: 'seed-revision-0', content: 'old preview',
    })] });
  oldPrepared.request.selectedGeneration = preview.selected.generation;
  assert.throws(() => invoke(helper, oldPrepared.request), /preview generation changed/);
});

test('partial absence preserves files while authorized deletion retains history', () => {
  const partialCase = cname('partial');
  seed(partialCase, [
    { fileId: 'keep', path: 'pages/keep.md', content: 'keep me' },
    { fileId: 'update', path: 'pages/update.md', content: 'before' },
  ]);
  const partial = previewComparison({ helper, runName, caseName: partialCase, ownerToken,
    targetSnapshot: target([{ fileId: 'update', path: 'pages/update.md', content: 'after' }]) });
  assert.equal(partial.comparison.unknown[0].fileId, 'keep');
  const partialApplied = applyExact(partialCase, partial);
  assert.deepEqual(partialApplied.selected.files, [
    { path: 'pages/keep.md', content: 'keep me' },
    { path: 'pages/update.md', content: 'after' },
  ]);

  const deleteCase = cname('delete');
  seed(deleteCase, [{ fileId: 'delete', path: 'pages/delete.md', content: 'retained history' }]);
  const deletion = previewComparison({ helper, runName, caseName: deleteCase, ownerToken,
    targetSnapshot: target([], { complete: true, authorizeMissingDeletes: true }) });
  assert.equal(deletion.comparison.proposedEvents[0].kind, 'delete');
  const deleted = applyExact(deleteCase, deletion);
  assert.deepEqual(deleted.selected.files, []);
  assert.deepEqual(deleted.state.files.delete.heads, [deletion.comparison.proposedEvents[0].revisionId]);
  assert.equal(deleted.state.revisions['seed-revision-0'].content, 'retained history');
  assert.equal(deleted.state.revisions[deletion.comparison.proposedEvents[0].revisionId].deleted, true);
});

test('interrupted preparation recovers and exact retry creates no duplicate generation', () => {
  const caseName = cname('recovery'); init(caseName);
  const preview = previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot: target([
    { fileId: 'file', path: 'pages/recover.md', content: 'recover' },
  ]) });
  assert.throws(() => applyExact(caseName, preview, { failurePoint: 'after-prepared' }), /INJECTED/);
  const recovered = applyExact(caseName, preview);
  assert.equal(recovered.status, 'applied');
  const afterRecovery = generations(caseName);
  const retry = applyExact(caseName, preview);
  assert.equal(retry.status, 'already-applied');
  assert.deepEqual(generations(caseName), afterRecovery);
});
