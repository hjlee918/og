'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyOperation, createState } = require('../src/core');
const { snapshotFingerprint } = require('../src/planner');
const { COMPARISON_SCHEMA, compareSnapshots, TARGET_SCHEMA } = require('../src/snapshot-comparison');

function apply(state, operation) { return applyOperation(state, operation).state; }
function seed(files = []) {
  let state = createState('comparison-graph');
  files.forEach((file, index) => {
    state = apply(state, {
      operationId: `seed-op-${index}`, kind: 'create', fileId: file.fileId,
      revisionId: `seed-rev-${index}`, parentRevisionId: null,
      path: file.path, content: file.content,
    });
  });
  return state;
}
function envelope(state, generation = 'a'.repeat(64)) {
  const files = [];
  Object.values(state.files).forEach((file) => {
    if (file.heads.length !== 1) return;
    const revision = state.revisions[file.heads[0]];
    if (!revision.deleted) files.push({ path: revision.path, content: revision.content });
  });
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return { schema: 'f28-selected-snapshot/1', generation,
    snapshotFingerprint: snapshotFingerprint(state), state, files };
}
function target(files, values = {}) {
  return { schema: TARGET_SCHEMA, complete: false, authorizeMissingDeletes: false, files, ...values };
}

test('unchanged Korean/English snapshot is deterministic and inputs remain unchanged', () => {
  const selected = envelope(seed([
    { fileId: '한글-id', path: 'pages/회의.md', content: '안녕하세요\nEnglish' },
    { fileId: 'english-id', path: 'pages/Notes.org', content: 'Plain text' },
  ]));
  const desired = target([
    { fileId: 'english-id', path: 'pages/Notes.org', content: 'Plain text' },
    { fileId: '한글-id', path: 'pages/회의.md', content: '안녕하세요\nEnglish' },
  ]);
  const beforeSelected = JSON.stringify(selected), beforeTarget = JSON.stringify(desired);
  const first = compareSnapshots(selected, desired), second = compareSnapshots(selected, desired);
  assert.deepEqual(first, second);
  assert.equal(first.schema, COMPARISON_SCHEMA);
  assert.deepEqual(first.unchanged.map((item) => item.fileId), ['english-id', '한글-id']);
  assert.equal(first.proposedEvents.length, 0);
  assert.deepEqual(first.eligibility, { eligible: true, code: 'comparison-eligible' });
  assert.equal(first.plan.basis.snapshotFingerprint, selected.snapshotFingerprint);
  assert.equal(JSON.stringify(selected), beforeSelected);
  assert.equal(JSON.stringify(desired), beforeTarget);
});

test('explicit identities produce create, update and rename planner actions', () => {
  const selected = envelope(seed([
    { fileId: 'update-id', path: 'pages/update.md', content: 'before' },
    { fileId: 'rename-id', path: 'pages/old.md', content: 'same' },
  ]));
  const compared = compareSnapshots(selected, target([
    { fileId: 'create-id', path: 'pages/새 문서.md', content: '새 내용\nNew' },
    { fileId: 'update-id', path: 'pages/update.md', content: 'after' },
    { fileId: 'rename-id', path: 'pages/renamed.md', content: 'same' },
  ]));
  assert.deepEqual(compared.proposedEvents.map((event) => event.kind), ['create', 'rename', 'update']);
  assert.equal(compared.eligibility.eligible, true);
  assert.equal(compared.plan.actions.length, 3);
  assert.equal(compared.plan.invalid.length, 0);
  assert.equal(compared.plan.conflicts.length, 0);
});

test('absence is unknown unless complete deletion is authorized; tombstones are explicit', () => {
  const selected = envelope(seed([{ fileId: 'file-1', path: 'pages/a.md', content: 'a' }]));
  const absent = compareSnapshots(selected, target([]));
  assert.equal(absent.proposedEvents.length, 0);
  assert.equal(absent.unknown[0].reason, 'absence-does-not-imply-delete');
  assert.equal(absent.eligibility.eligible, true);

  const complete = compareSnapshots(selected, target([], { complete: true, authorizeMissingDeletes: true }));
  assert.equal(complete.proposedEvents[0].kind, 'delete');
  assert.equal(complete.eligibility.eligible, true);
  assert.equal(complete.plan.actions[0].operation.kind, 'delete');

  const explicit = compareSnapshots(selected, target([{ fileId: 'file-1', deleted: true }]));
  assert.equal(explicit.proposedEvents[0].kind, 'delete');
  assert.equal(explicit.proposedEvents[0].parentRevisionId, 'seed-rev-0');
  assert.equal(explicit.eligibility.eligible, true);
  assert.equal(explicit.plan.actions[0].operation.kind, 'delete');
});

test('duplicate identities and unsupported combined changes are invalid', () => {
  const selected = envelope(seed([{ fileId: 'file-1', path: 'pages/a.md', content: 'a' }]));
  const compared = compareSnapshots(selected, target([
    { fileId: 'file-1', path: 'pages/b.md', content: 'changed' },
    { fileId: 'dup', path: 'pages/one.md', content: 'one' },
    { fileId: 'dup', path: 'pages/two.md', content: 'two' },
  ]));
  assert.deepEqual(compared.invalid.map((item) => item.code), [
    'combined-change-not-supported', 'duplicate-file-id', 'duplicate-file-id',
  ]);
  assert.equal(compared.proposedEvents.length, 0);
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('NFC/NFD-equivalent target paths are reported and never planned', () => {
  const composed = 'pages/한글.md';
  const decomposed = composed.normalize('NFD');
  const compared = compareSnapshots(envelope(seed()), target([
    { fileId: 'one', path: composed, content: '하나' },
    { fileId: 'two', path: decomposed, content: '둘' },
  ]));
  assert.equal(compared.conflicts[0].code, 'normalized-path-collision');
  assert.equal(compared.proposedEvents.length, 0);
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('a partial target cannot create over an absent-but-still-live selected path', () => {
  const selected = envelope(seed([{ fileId: 'existing', path: 'pages/same.md', content: 'kept' }]));
  const compared = compareSnapshots(selected, target([
    { fileId: 'new', path: 'pages/SAME.md', content: 'new' },
  ]));
  assert.equal(compared.unknown[0].fileId, 'existing');
  assert.equal(compared.conflicts[0].code, 'planner-conflict');
  assert.equal(compared.proposedEvents.length, 1);
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('an existing multi-head identity is an explicit conflict', () => {
  let state = seed([{ fileId: 'file-1', path: 'pages/a.md', content: 'base' }]);
  state = apply(state, { operationId: 'branch-a', kind: 'update', fileId: 'file-1',
    revisionId: 'branch-rev-a', parentRevisionId: 'seed-rev-0', content: 'A' });
  state = apply(state, { operationId: 'branch-b', kind: 'update', fileId: 'file-1',
    revisionId: 'branch-rev-b', parentRevisionId: 'seed-rev-0', content: 'B' });
  const compared = compareSnapshots(envelope(state), target([
    { fileId: 'file-1', path: 'pages/a.md', content: 'C' },
  ]));
  assert.equal(compared.conflicts[0].code, 'ambiguous-selected-identity');
  assert.equal(compared.proposedEvents.length, 0);
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('malformed selected envelopes and implicit restore are refused', () => {
  const live = seed([{ fileId: 'file-1', path: 'pages/a.md', content: 'a' }]);
  const deleted = apply(live, { operationId: 'delete', kind: 'delete', fileId: 'file-1',
    revisionId: 'delete-rev', parentRevisionId: 'seed-rev-0' });
  const compared = compareSnapshots(envelope(deleted), target([
    { fileId: 'file-1', path: 'pages/a.md', content: 'restored?' },
  ]));
  assert.equal(compared.invalid[0].code, 'restore-not-supported');
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
  const broken = envelope(live); broken.snapshotFingerprint = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => compareSnapshots(broken, target([])), /fingerprint mismatch/);
});

test('invalid existing identity never becomes an absence-derived delete', async (suite) => {
  const selected = envelope(seed([{ fileId: 'f', path: 'pages/test.md', content: 'before' }]));
  for (const [name, invalidFile] of [
    ['invalid content', { fileId: 'f', path: 'pages/test.md', content: 42 }],
    ['invalid path', { fileId: 'f', path: '../test.md', content: 'before' }],
  ]) {
    await suite.test(name, () => {
      const desired = target([invalidFile], {
        complete: true, authorizeMissingDeletes: true,
      });
      const selectedBefore = JSON.stringify(selected), targetBefore = JSON.stringify(desired);
      const compared = compareSnapshots(selected, desired);
      assert.deepEqual(compared, compareSnapshots(selected, desired));
      assert.ok(compared.invalid.some((item) => item.code === (name === 'invalid path' ? 'invalid-path' : 'invalid-file')));
      assert.equal(compared.proposedEvents.some((event) => event.kind === 'delete' && event.fileId === 'f'), false);
      assert.equal(compared.eligibility.eligible, false);
      assert.equal(compared.plan, null);
      assert.equal(JSON.stringify(selected), selectedBefore);
      assert.equal(JSON.stringify(desired), targetBefore);
    });
  }
});

test('duplicate mentions of an existing identity never become an absence-derived delete', () => {
  const selected = envelope(seed([{ fileId: 'f', path: 'pages/test.md', content: 'before' }]));
  const compared = compareSnapshots(selected, target([
    { fileId: 'f', path: 'pages/test.md', content: 'one' },
    { fileId: 'f', path: 'pages/test.md', content: 'two' },
  ], { complete: true, authorizeMissingDeletes: true }));
  assert.equal(compared.invalid.filter((item) => item.code === 'duplicate-file-id').length, 2);
  assert.equal(compared.proposedEvents.some((event) => event.kind === 'delete'), false);
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('an invalid unidentified entry makes claimed completeness untrustworthy', () => {
  const selected = envelope(seed([{ fileId: 'f', path: 'pages/test.md', content: 'before' }]));
  const compared = compareSnapshots(selected, target([
    { path: 'pages/unknown.md', content: 'unknown identity' },
  ], { complete: true, authorizeMissingDeletes: true }));
  assert.equal(compared.invalid[0].code, 'invalid-file-id');
  assert.equal(compared.proposedEvents.some((event) => event.kind === 'delete'), false);
  assert.equal(compared.unknown[0].reason, 'invalid-or-ambiguous-target-does-not-authorize-absence-delete');
  assert.equal(compared.eligibility.eligible, false);
  assert.equal(compared.plan, null);
});

test('mixed valid proposals and invalid or conflicting entries reject the whole comparison', () => {
  const selected = envelope(seed([{ fileId: 'valid', path: 'pages/valid.md', content: 'before' }]));
  const invalidMixed = compareSnapshots(selected, target([
    { fileId: 'valid', path: 'pages/valid.md', content: 'after' },
    { fileId: 'broken', path: 'pages/broken.md', content: 42 },
  ]));
  assert.equal(invalidMixed.proposedEvents[0].kind, 'update');
  assert.equal(invalidMixed.eligibility.eligible, false);
  assert.equal(invalidMixed.plan, null);

  const conflictMixed = compareSnapshots(selected, target([
    { fileId: 'valid', path: 'pages/valid.md', content: 'after' },
    { fileId: 'one', path: 'pages/한글.md', content: '하나' },
    { fileId: 'two', path: 'pages/한글.md'.normalize('NFD'), content: '둘' },
  ]));
  assert.equal(conflictMixed.proposedEvents.some((event) => event.kind === 'update'), true);
  assert.equal(conflictMixed.eligibility.eligible, false);
  assert.equal(conflictMixed.plan, null);
});
