'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyOperation, createState } = require('../src/core');
const {
  CAPTURE_BATCH_SCHEMA,
  ENROLLMENT_SCHEMA,
  IDENTITY_SCHEMA,
  captureChanges,
  enrollIdentityMetadata,
  initializeReplica,
  validateMetadata,
} = require('../src/identity-capture');
const { executePlan } = require('../src/executor');
const { snapshotFingerprint } = require('../src/planner');

function apply(state, operation) { return applyOperation(state, operation).state; }

function seed(files = []) {
  let state = createState('identity-graph');
  files.forEach((file, index) => {
    state = apply(state, {
      operationId: 'seed-op-' + index, kind: 'create', fileId: file.fileId,
      revisionId: file.revisionId || 'seed-rev-' + index, parentRevisionId: null,
      path: file.path, content: file.content,
    });
  });
  return state;
}

function selected(state, generation = 'a'.repeat(64)) {
  const files = [];
  for (const file of Object.values(state.files)) {
    assert.equal(file.heads.length, 1);
    const revision = state.revisions[file.heads[0]];
    if (!revision.deleted) files.push({ path: revision.path, content: revision.content });
  }
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return {
    schema: 'f28-selected-snapshot/1', generation,
    snapshotFingerprint: snapshotFingerprint(state), state, files,
  };
}

function enrolled(files = [
  { fileId: 'f', path: 'pages/test.md', content: 'before', revisionId: 'seed-rev-0' },
]) {
  const snapshot = selected(seed(files));
  const request = {
    schema: ENROLLMENT_SCHEMA, complete: true, graphId: 'identity-graph',
    replicaId: 'replica-a', metadataRevision: 'metadata-1',
    files: files.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
      acceptedRevision: file.revisionId,
    })),
  };
  return { snapshot, ...enrollIdentityMetadata(request, snapshot) };
}

function capture(context, observations, values = {}) {
  return captureChanges({
    schema: CAPTURE_BATCH_SCHEMA,
    metadata: context.metadata,
    replica: context.replica,
    acceptedSnapshot: context.snapshot,
    expectedMetadataRevision: 'metadata-1',
    proposedMetadataRevision: 'metadata-2',
    observations,
    reviewDecisions: [],
    ...values,
  });
}

function executeExposedComparison(context, result, generationCharacter = 'b') {
  assert.equal(result.eligibility.eligible, true);
  const execution = executePlan({
    sourceSnapshot: context.snapshot.state,
    events: result.comparison.proposedEvents,
    plan: result.comparison.plan,
    destinationSnapshot: context.snapshot.state,
  });
  assert.ok(['applied', 'already-applied'].includes(execution.status));
  return {
    execution,
    snapshot: selected(execution.state, generationCharacter.repeat(64)),
  };
}

function captureWithAcceptedResult(result, snapshot, replicaId = 'replica-next') {
  const replica = initializeReplica(result.proposedMetadata, replicaId, snapshot);
  return captureChanges({
    schema: CAPTURE_BATCH_SCHEMA,
    metadata: result.proposedMetadata,
    replica,
    acceptedSnapshot: snapshot,
    expectedMetadataRevision: result.proposedMetadata.metadataRevision,
    proposedMetadataRevision: 'metadata-3',
    observations: [],
    reviewDecisions: [],
  });
}

function saveComplete(values = {}) {
  return {
    observationId: 'save-complete-1', type: 'save-complete', saveId: 'save-1',
    fileId: 'f', path: 'pages/test.md', content: 'after',
    parentRevisionId: 'seed-rev-0', revisionId: 'update-rev-1', ...values,
  };
}

function stableSave(values = {}) {
  return {
    observationId: 'save-read-1', type: 'stable-read', causeType: 'save',
    causeId: 'save-1', path: 'pages/test.md', content: 'after', stable: true,
    ...values,
  };
}

test('explicit enrollment and replica copy preserve graph and file identity', () => {
  const context = enrolled([
    { fileId: '한글-id', path: 'pages/회의.md', content: '안녕', revisionId: '한글-rev' },
    { fileId: 'english-id', path: 'pages/Notes.org', content: 'Hello', revisionId: 'english-rev' },
  ]);
  assert.equal(context.metadata.schema, IDENTITY_SCHEMA);
  assert.deepEqual(Object.keys(context.metadata.files), ['english-id', '한글-id']);
  const second = initializeReplica(context.metadata, 'replica-b', context.snapshot);
  assert.equal(second.graphId, context.replica.graphId);
  assert.equal(second.metadataRevision, context.replica.metadataRevision);
  assert.notEqual(second.replicaId, context.replica.replicaId);
  assert.deepEqual(second.pendingObservations, []);
  assert.deepEqual(validateMetadata(context.metadata, context.snapshot).metadata, context.metadata);
});

test('enrollment rejects duplicate IDs, normalized paths and case collisions', async (suite) => {
  const snapshot = selected(seed([
    { fileId: 'one', path: 'pages/one.md', content: '1' },
    { fileId: 'two', path: 'pages/two.md', content: '2' },
  ]));
  const base = {
    schema: ENROLLMENT_SCHEMA, complete: true, graphId: 'identity-graph',
    replicaId: 'replica-a', metadataRevision: 'metadata-1',
  };
  await suite.test('duplicate file ID', () => {
    assert.throws(() => enrollIdentityMetadata({ ...base, files: [
      { fileId: 'one', path: 'pages/one.md', content: '1', acceptedRevision: 'seed-rev-0' },
      { fileId: 'one', path: 'pages/two.md', content: '2', acceptedRevision: 'seed-rev-1' },
    ] }, snapshot), /duplicate file ID/);
  });
  await suite.test('NFC and NFD collision', () => {
    const collisionSnapshot = selected(seed([
      { fileId: 'one', path: 'pages/한글.md', content: '1' },
      { fileId: 'two', path: 'pages/한글.md'.normalize('NFD'), content: '2' },
    ]));
    assert.throws(() => enrollIdentityMetadata({ ...base, files: [
      { fileId: 'one', path: 'pages/한글.md', content: '1', acceptedRevision: 'seed-rev-0' },
      { fileId: 'two', path: 'pages/한글.md'.normalize('NFD'), content: '2', acceptedRevision: 'seed-rev-1' },
    ] }, collisionSnapshot), /paths collide/);
  });
  await suite.test('case collision', () => {
    const collisionSnapshot = selected(seed([
      { fileId: 'one', path: 'pages/Note.md', content: '1' },
      { fileId: 'two', path: 'pages/note.md', content: '2' },
    ]));
    assert.throws(() => enrollIdentityMetadata({ ...base, files: [
      { fileId: 'one', path: 'pages/Note.md', content: '1', acceptedRevision: 'seed-rev-0' },
      { fileId: 'two', path: 'pages/note.md', content: '2', acceptedRevision: 'seed-rev-1' },
    ] }, collisionSnapshot), /paths collide/);
  });
});

test('metadata, revision and accepted snapshot mismatches are rejected', () => {
  const context = enrolled();
  const staleMetadata = structuredClone(context.metadata);
  staleMetadata.files.f.acceptedContentHash = 'sha256:' + '0'.repeat(64);
  assert.throws(() => validateMetadata(staleMetadata, context.snapshot), /does not match/);
  assert.throws(() => capture(context, [], { expectedMetadataRevision: 'metadata-old' }), /stale/);
  const staleReplica = structuredClone(context.replica);
  staleReplica.acceptedSnapshotFingerprint = 'sha256:' + '0'.repeat(64);
  assert.throws(() => capture({ ...context, replica: staleReplica }, []), /stale/);
  const unchangedRevision = capture(context, [saveComplete(), stableSave()], {
    proposedMetadataRevision: 'metadata-1',
  });
  assert.equal(unchangedRevision.target, null);
  assert.ok(unchangedRevision.invalid.some((item) =>
    item.code === 'metadata-revision-not-advanced'));
});

test('save completion and stable observation can arrive in either order across batches', () => {
  const context = enrolled();
  const first = capture(context, [saveComplete()]);
  assert.equal(first.eligibility.eligible, false);
  assert.equal(first.capturedEvents.length, 0);
  assert.equal(first.reviewItems[0].code, 'save-awaiting-matching-stable-read');

  const completed = capture({ ...context, replica: first.nextReplicaState }, [stableSave()]);
  assert.equal(completed.eligibility.eligible, true);
  assert.equal(completed.capturedEvents[0].kind, 'update');
  assert.equal(completed.target.files[0].content, 'after');
  assert.equal(completed.comparison.eligibility.eligible, true);
  assert.equal(completed.acceptedMetadata.files.f.acceptedRevision, 'seed-rev-0');
  assert.equal(completed.capturedEvents[0].revisionId, 'update-rev-1');
  assert.equal(completed.proposedMetadata.files.f.acceptedRevision,
    completed.comparison.plan.actions[0].operation.revisionId);
  assert.notEqual(completed.proposedMetadata.files.f.acceptedRevision, 'update-rev-1');
  assert.equal(completed.nextReplicaState.pendingObservations.length, 2);

  const reverseFirst = capture(context, [stableSave()]);
  const reverse = capture({ ...context, replica: reverseFirst.nextReplicaState }, [saveComplete()]);
  assert.deepEqual(reverse.target, completed.target);
});

test('save completion alone and mismatched evidence never expose a target', () => {
  const context = enrolled();
  assert.equal(capture(context, [saveComplete()]).target, null);
  const mismatched = capture(context, [saveComplete(), stableSave({ content: 'different' })]);
  assert.equal(mismatched.eligibility.eligible, false);
  assert.equal(mismatched.target, null);
  assert.ok(mismatched.invalid.some((item) => item.code === 'save-evidence-mismatch'));
});

test('repeated equivalent observations are idempotent and inputs stay unchanged', () => {
  const context = enrolled();
  const observations = [
    saveComplete(),
    saveComplete({ observationId: 'save-complete-2' }),
    stableSave(),
    stableSave({ observationId: 'save-read-2' }),
  ];
  const before = JSON.stringify({ context, observations });
  const first = capture(context, observations);
  const second = capture(context, observations);
  assert.deepEqual(first, second);
  assert.equal(first.eligibility.eligible, true);
  assert.equal(first.capturedEvents.length, 1);
  assert.equal(JSON.stringify({ context, observations }), before);
});

test('observation ID reuse and contradictory same-file evidence reject the batch', async (suite) => {
  const context = enrolled();
  await suite.test('changed observation ID reuse', () => {
    const result = capture(context, [
      saveComplete(),
      saveComplete({ content: 'other' }),
      stableSave(),
    ]);
    assert.equal(result.target, null);
    assert.ok(result.invalid.some((item) => item.code === 'observation-id-reuse'));
  });
  await suite.test('two completed saves for one accepted parent', () => {
    const result = capture(context, [
      saveComplete(),
      stableSave(),
      saveComplete({
        observationId: 'save-complete-other', saveId: 'save-2',
        content: 'other', revisionId: 'update-rev-2',
      }),
      stableSave({
        observationId: 'save-read-other', causeId: 'save-2', content: 'other',
      }),
    ]);
    assert.equal(result.target, null);
    assert.ok(result.invalid.some((item) => item.code === 'contradictory-file-evidence'));
  });
});

test('mixed captured and invalid evidence exposes no target and retains the valid evidence', () => {
  const context = enrolled();
  const result = capture(context, [
    saveComplete(), stableSave(),
    { observationId: 'bad', type: 'external-change', fileId: 'unknown',
      path: 'pages/unknown.md', content: 'bad', stable: true,
      parentRevisionId: 'unknown-parent', revisionId: 'unknown-revision' },
  ]);
  assert.equal(result.target, null);
  assert.equal(result.capturedEvents.length, 1);
  assert.equal(result.nextReplicaState.pendingObservations.length, 3);
  assert.ok(result.invalid.some((item) => item.code === 'external-identity-mismatch'));
});

function renameSet(overrides = {}) {
  return [
    {
      observationId: 'rename-intent-1', type: 'rename-intent', renameId: 'rename-1',
      fileId: 'f', oldPath: 'pages/test.md', newPath: 'pages/renamed.md',
      parentRevisionId: 'seed-rev-0', revisionId: 'rename-rev-1',
    },
    {
      observationId: 'rename-complete-1', type: 'rename-complete',
      renameId: 'rename-1', succeeded: true,
    },
    {
      observationId: 'rename-read-1', type: 'stable-read', causeType: 'rename',
      causeId: 'rename-1', path: 'pages/renamed.md', content: 'before',
      stable: true, oldPathAbsent: true,
    },
  ].map((item) => ({ ...item, ...(overrides[item.type] || {}) }));
}

test('rename intent alone is pending; completed matching rename is captured', () => {
  const context = enrolled();
  const intentOnly = capture(context, [renameSet()[0]]);
  assert.equal(intentOnly.target, null);
  assert.equal(intentOnly.acceptedMetadata.files.f.path, 'pages/test.md');
  assert.equal(intentOnly.reviewItems[0].code, 'rename-awaiting-completion-and-stable-read');
  const completed = capture(context, renameSet());
  assert.equal(completed.eligibility.eligible, true);
  assert.equal(completed.target.files[0].path, 'pages/renamed.md');
  assert.equal(completed.acceptedMetadata.files.f.path, 'pages/test.md');
  assert.equal(completed.proposedMetadata.files.f.path, 'pages/renamed.md');
});

test('failed rename and incomplete reads remain pending', () => {
  const context = enrolled();
  const failed = capture(context, renameSet({
    'rename-complete': { succeeded: false },
  }));
  assert.equal(failed.target, null);
  assert.ok(failed.reviewItems.some((item) => item.code === 'rename-failed-requires-review'));
  const incomplete = capture(context, [{
    observationId: 'unstable-1', type: 'unstable-read',
    path: 'pages/test.md', reason: 'bytes changed during read',
  }]);
  assert.equal(incomplete.target, null);
  assert.equal(incomplete.reviewItems[0].code, 'unstable-read');
});

test('external delete plus create stays ambiguous until an exact review decision', () => {
  const context = enrolled();
  const observations = [
    { observationId: 'unlink-1', type: 'external-unlink', fileId: 'f', path: 'pages/test.md' },
    { observationId: 'add-1', type: 'external-add', path: 'pages/elsewhere.md',
      content: 'before', stable: true },
  ];
  const ambiguous = capture(context, observations);
  assert.equal(ambiguous.target, null);
  assert.equal(ambiguous.capturedEvents.length, 0);
  assert.deepEqual(ambiguous.reviewItems.map((item) => item.code).sort(), [
    'external-add-requires-review', 'external-unlink-requires-review',
  ]);
  const reviewed = capture({ ...context, replica: ambiguous.nextReplicaState }, [], {
    reviewDecisions: [{
      decisionId: 'review-rename-1',
      pendingIds: ambiguous.reviewItems.map((item) => item.pendingId),
      metadataRevision: 'metadata-1', action: 'rename',
      fileId: 'f', revisionId: 'rename-rev-reviewed',
    }],
  });
  assert.equal(reviewed.eligibility.eligible, true);
  assert.equal(reviewed.capturedEvents[0].kind, 'rename');
  assert.equal(reviewed.target.files[0].path, 'pages/elsewhere.md');
});

test('review decisions require exact pending items and metadata revision', () => {
  const context = enrolled();
  const first = capture(context, [
    { observationId: 'unlink-1', type: 'external-unlink', fileId: 'f', path: 'pages/test.md' },
  ]);
  const pendingId = first.reviewItems[0].pendingId;
  const stale = capture({ ...context, replica: first.nextReplicaState }, [], {
    reviewDecisions: [{
      decisionId: 'delete-1', pendingIds: [pendingId], metadataRevision: 'metadata-old',
      action: 'delete', fileId: 'f', revisionId: 'delete-rev',
    }],
  });
  assert.equal(stale.target, null);
  assert.ok(stale.invalid.some((item) => item.code === 'stale-review-decision'));
  const wrong = capture({ ...context, replica: first.nextReplicaState }, [], {
    reviewDecisions: [{
      decisionId: 'delete-1', pendingIds: ['pending-unknown'], metadataRevision: 'metadata-1',
      action: 'delete', fileId: 'f', revisionId: 'delete-rev',
    }],
  });
  assert.equal(wrong.target, null);
  assert.ok(wrong.invalid.some((item) => item.code === 'review-binding-mismatch'));
});

test('explicit reviewed deletion produces a tombstone target and proposed metadata', () => {
  const context = enrolled();
  const first = capture(context, [
    { observationId: 'unlink-1', type: 'external-unlink', fileId: 'f', path: 'pages/test.md' },
  ]);
  const result = capture({ ...context, replica: first.nextReplicaState }, [], {
    reviewDecisions: [{
      decisionId: 'delete-1', pendingIds: [first.reviewItems[0].pendingId],
      metadataRevision: 'metadata-1', action: 'delete',
      fileId: 'f', revisionId: 'delete-rev',
    }],
  });
  assert.equal(result.eligibility.eligible, true);
  assert.deepEqual(result.target.files, [{ fileId: 'f', deleted: true }]);
  assert.equal(result.comparison.plan.actions[0].operation.kind, 'delete');
  assert.equal(result.acceptedMetadata.files.f.status, 'live');
  assert.equal(result.proposedMetadata.tombstones.f.acceptedRevision,
    result.comparison.plan.actions[0].operation.revisionId);
});

test('explicit reviewed add assigns a caller-supplied identity without guessing', () => {
  const context = enrolled();
  const first = capture(context, [{
    observationId: 'add-1', type: 'external-add',
    path: 'pages/new.md', content: 'new', stable: true,
  }]);
  const result = capture({ ...context, replica: first.nextReplicaState }, [], {
    reviewDecisions: [{
      decisionId: 'create-1', pendingIds: [first.reviewItems[0].pendingId],
      metadataRevision: 'metadata-1', action: 'create',
      fileId: 'new-file', revisionId: 'new-rev',
    }],
  });
  assert.equal(result.eligibility.eligible, true);
  assert.deepEqual(result.target.files.map((item) => item.fileId), ['f', 'new-file']);
  assert.equal(result.proposedMetadata.files['new-file'].acceptedRevision,
    result.comparison.plan.actions[0].operation.revisionId);
});

test('external changes require stable explicit identity and absence preserves files', () => {
  const context = enrolled();
  const unstable = capture(context, [{
    observationId: 'external-1', type: 'external-change', fileId: 'f',
    path: 'pages/test.md', content: 'outside', stable: false,
    parentRevisionId: 'seed-rev-0', revisionId: 'external-rev',
  }]);
  assert.equal(unstable.target, null);
  assert.equal(unstable.reviewItems[0].code, 'external-read-not-stable');
  const stable = capture(context, [{
    observationId: 'external-1', type: 'external-change', fileId: 'f',
    path: 'pages/test.md', content: 'outside', stable: true,
    parentRevisionId: 'seed-rev-0', revisionId: 'external-rev',
  }]);
  assert.equal(stable.eligibility.eligible, true);
  assert.equal(stable.target.files[0].content, 'outside');
  const noObservation = capture(context, []);
  assert.equal(noObservation.eligibility.eligible, true);
  assert.equal(noObservation.capturedEvents.length, 0);
  assert.deepEqual(noObservation.target.files, [
    { fileId: 'f', path: 'pages/test.md', content: 'before' },
  ]);
  assert.equal(noObservation.proposedMetadata.metadataRevision, 'metadata-1');
});

test('Korean NFC/NFD and case collisions prevent target exposure', async (suite) => {
  const context = enrolled([
    { fileId: 'one', path: 'pages/한글.md', content: 'one', revisionId: 'one-rev' },
    { fileId: 'two', path: 'pages/two.md', content: 'two', revisionId: 'two-rev' },
  ]);
  function renameTo(newPath) {
    return capture(context, [
      {
        observationId: 'intent', type: 'rename-intent', renameId: 'rename',
        fileId: 'two', oldPath: 'pages/two.md', newPath,
        parentRevisionId: 'two-rev', revisionId: 'rename-rev',
      },
      { observationId: 'complete', type: 'rename-complete', renameId: 'rename', succeeded: true },
      {
        observationId: 'read', type: 'stable-read', causeType: 'rename',
        causeId: 'rename', path: newPath, content: 'two',
        stable: true, oldPathAbsent: true,
      },
    ]);
  }
  await suite.test('NFC/NFD', () => {
    const result = renameTo('pages/한글.md'.normalize('NFD'));
    assert.equal(result.target, null);
    assert.ok(result.invalid.some((item) => item.code === 'captured-events-not-applicable'));
  });
  await suite.test('case', () => {
    const result = renameTo('pages/한글.MD');
    assert.equal(result.target, null);
    assert.ok(result.invalid.some((item) => item.code === 'captured-events-not-applicable'));
  });
});

test('proposed metadata follows the exact exposed plan for update rename create and delete', async (suite) => {
  const operations = [
    ['update', (context) => capture(context, [saveComplete(), stableSave()])],
    ['rename', (context) => capture(context, renameSet())],
    ['create', (context) => {
      const pending = capture(context, [{
        observationId: 'create-add', type: 'external-add',
        path: 'pages/new.md', content: 'new', stable: true,
      }]);
      return capture({ ...context, replica: pending.nextReplicaState }, [], {
        reviewDecisions: [{
          decisionId: 'create-review', pendingIds: [pending.reviewItems[0].pendingId],
          metadataRevision: 'metadata-1', action: 'create',
          fileId: 'created-file', revisionId: 'causal-create-revision',
        }],
      });
    }],
    ['delete', (context) => {
      const pending = capture(context, [{
        observationId: 'delete-unlink', type: 'external-unlink',
        fileId: 'f', path: 'pages/test.md',
      }]);
      return capture({ ...context, replica: pending.nextReplicaState }, [], {
        reviewDecisions: [{
          decisionId: 'delete-review', pendingIds: [pending.reviewItems[0].pendingId],
          metadataRevision: 'metadata-1', action: 'delete',
          fileId: 'f', revisionId: 'causal-delete-revision',
        }],
      });
    }],
  ];

  for (const [index, [name, makeResult]] of operations.entries()) {
    await suite.test(name, () => {
      const context = enrolled();
      const before = JSON.stringify(context);
      const result = makeResult(context);
      const applied = executeExposedComparison(context, result,
        String.fromCharCode('b'.charCodeAt(0) + index));
      assert.equal(applied.execution.status, 'applied');
      assert.doesNotThrow(() => validateMetadata(result.proposedMetadata, applied.snapshot));
      const nextReplica = initializeReplica(result.proposedMetadata,
        'replica-after-' + name, applied.snapshot);
      assert.equal(nextReplica.metadataRevision, 'metadata-2');
      const second = captureWithAcceptedResult(result, applied.snapshot,
        'replica-second-' + name);
      assert.equal(second.eligibility.eligible, true);
      assert.equal(second.comparison.plan.actions.length, 0);
      assert.equal(second.proposedMetadata.metadataRevision, 'metadata-2');
      assert.equal(JSON.stringify(context), before);
    });
  }
});

test('unchanged-content save creates no executable revision or metadata advance', () => {
  const context = enrolled();
  const observations = [
    saveComplete({ content: 'before', revisionId: 'causal-noop-revision' }),
    stableSave({ content: 'before' }),
  ];
  const before = JSON.stringify({ context, observations });
  const first = capture(context, observations, {
    proposedMetadataRevision: 'metadata-1',
  });
  const retry = capture(context, observations, {
    proposedMetadataRevision: 'metadata-1',
  });
  assert.deepEqual(retry, first);
  assert.equal(first.eligibility.eligible, true);
  assert.equal(first.capturedEvents.length, 1);
  assert.equal(first.comparison.plan.actions.length, 0);
  assert.equal(first.proposedMetadata.metadataRevision, 'metadata-1');
  assert.equal(first.proposedMetadata.files.f.acceptedRevision, 'seed-rev-0');
  assert.equal(first.nextReplicaState.pendingObservations.length, 0);
  const applied = executeExposedComparison(context, first, 'f');
  assert.equal(applied.execution.status, 'already-applied');
  assert.doesNotThrow(() => validateMetadata(first.proposedMetadata, applied.snapshot));
  const second = captureWithAcceptedResult(first, applied.snapshot, 'replica-after-noop');
  assert.equal(second.eligibility.eligible, true);
  assert.equal(second.comparison.plan.actions.length, 0);
  assert.equal(JSON.stringify({ context, observations }), before);
});
