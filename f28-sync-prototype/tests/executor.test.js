'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyOperation, createState } = require('../src/core');
const { executePlan } = require('../src/executor');
const { planReconciliation } = require('../src/planner');

function apply(state, operation) {
  return applyOperation(state, operation).state;
}

function event(eventId, kind, fileId, revisionId, values = {}) {
  return { eventId, kind, fileId, revisionId, ...values };
}

function normalBatch() {
  const sourceSnapshot = createState('graph-executor');
  const events = [
    event('create', 'create', 'file-1', 'rev-1', {
      path: 'pages/회의 Notes.md', content: '첫 줄\nEnglish line',
    }),
    event('update', 'update', 'file-1', 'rev-2', {
      parentRevisionId: 'rev-1', content: '수정됨\nEnglish preserved',
    }),
    event('rename', 'rename', 'file-1', 'rev-3', {
      parentRevisionId: 'rev-2', path: 'pages/동기화 Sync.md',
    }),
    event('delete', 'delete', 'file-1', 'rev-4', { parentRevisionId: 'rev-3' }),
  ];
  return { sourceSnapshot, events, plan: planReconciliation(sourceSnapshot, events) };
}

function execute(batch, destinationSnapshot = batch.sourceSnapshot, options) {
  return executePlan({ ...batch, destinationSnapshot }, options);
}

test('dependent create/update/rename/delete actions apply to a private state', () => {
  const batch = normalBatch();
  const sourceBefore = JSON.stringify(batch.sourceSnapshot);
  const eventsBefore = JSON.stringify(batch.events);
  const planBefore = JSON.stringify(batch.plan);
  const result = execute(batch);

  assert.equal(result.status, 'applied');
  assert.equal(result.result.appliedActionCount, 4);
  assert.deepEqual(result.state.revisionOrder, ['rev-1', 'rev-2', 'rev-3', 'rev-4']);
  assert.equal(result.state.revisions['rev-2'].content, '수정됨\nEnglish preserved');
  assert.equal(result.state.revisions['rev-3'].path, 'pages/동기화 Sync.md');
  assert.equal(result.state.revisions['rev-4'].deleted, true);
  assert.equal(JSON.stringify(batch.sourceSnapshot), sourceBefore);
  assert.equal(JSON.stringify(batch.events), eventsBefore);
  assert.equal(JSON.stringify(batch.plan), planBefore);
});

test('exact duplicate events apply once and are reported', () => {
  const sourceSnapshot = createState('graph-executor');
  const first = event('same', 'create', 'file-1', 'rev-1', {
    path: 'pages/a.md', content: 'one',
  });
  const events = [first, { ...first }];
  const plan = planReconciliation(sourceSnapshot, events);
  const result = execute({ sourceSnapshot, events, plan });

  assert.equal(result.status, 'applied');
  assert.equal(result.result.appliedActionCount, 1);
  assert.equal(result.result.duplicateEventCount, 1);
  assert.deepEqual(result.state.revisionOrder, ['rev-1']);
});

test('exact batch retry is distinguished from a stale destination', () => {
  const batch = normalBatch();
  const first = execute(batch);
  const retry = execute(batch, first.state);

  assert.equal(retry.status, 'already-applied');
  assert.equal(retry.result.code, 'exact-batch-retry');
  assert.equal(retry.result.appliedActionCount, 0);
  assert.deepEqual(retry.state, first.state);

  const staleDestination = apply(first.state, {
    operationId: 'later-op', kind: 'create', fileId: 'file-2', revisionId: 'later-rev',
    parentRevisionId: null, path: 'pages/later.md', content: 'later',
  });
  const stale = execute(batch, staleDestination);
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.result.code, 'stale-plan');
  assert.equal(stale.state, null);

  const malformed = execute(batch, {});
  assert.equal(malformed.status, 'rejected');
  assert.equal(malformed.result.code, 'invalid-execution-input');
  assert.equal(malformed.state, null);
});

test('unexpected schema, projected fingerprint, altered action and order are rejected', async (t) => {
  const batch = normalBatch();
  const cases = [
    ['schema', { ...batch.plan, schema: 'unexpected/1' }, 'unexpected-plan-schema'],
    ['projected fingerprint', {
      ...batch.plan, projectedSnapshotFingerprint: 'sha256:tampered',
    }, 'projected-fingerprint-mismatch'],
    ['action', {
      ...batch.plan,
      actions: batch.plan.actions.map((action, index) => index === 1
        ? { ...action, operation: { ...action.operation, content: 'tampered' } }
        : action),
    }, 'plan-integrity-failed'],
    ['ordering', {
      ...batch.plan, actions: [...batch.plan.actions].reverse(),
    }, 'plan-integrity-failed'],
  ];

  for (const [name, plan, code] of cases) {
    await t.test(name, () => {
      const result = execute({ ...batch, plan });
      assert.equal(result.status, 'rejected');
      assert.equal(result.result.code, code);
      assert.equal(result.state, null);
    });
  }
});

test('later path collision rejects the complete batch without applying its first action', () => {
  const sourceSnapshot = createState('graph-executor');
  const composed = 'pages/한글.md';
  const events = [
    event('first', 'create', 'file-1', 'rev-1', { path: composed, content: '하나' }),
    event('collision', 'create', 'file-2', 'rev-2', {
      path: composed.normalize('NFD'), content: '둘',
    }),
  ];
  const plan = planReconciliation(sourceSnapshot, events);
  const result = execute({ sourceSnapshot, events, plan });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.conflicts[0].introducedConflicts[0].type, 'path-collision');
  assert.equal(result.status, 'rejected');
  assert.equal(result.result.code, 'batch-not-eligible');
  assert.equal(result.state, null);
  assert.deepEqual(sourceSnapshot.revisionOrder, []);
});

test('later invalid event rejects the complete batch', () => {
  const sourceSnapshot = createState('graph-executor');
  const events = [
    event('first', 'create', 'file-1', 'rev-1', { path: 'pages/a.md', content: 'one' }),
    event('invalid', 'update', 'file-1', 'rev-2', { content: 'missing parent' }),
  ];
  const plan = planReconciliation(sourceSnapshot, events);
  const result = execute({ sourceSnapshot, events, plan });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.invalid.length, 1);
  assert.equal(result.status, 'rejected');
  assert.equal(result.result.code, 'batch-not-eligible');
  assert.equal(result.result.invalidCount, 1);
  assert.equal(result.state, null);
});

test('controlled failure after an early private operation exposes no partial state', () => {
  const batch = normalBatch();
  const sourceBefore = JSON.stringify(batch.sourceSnapshot);
  const planBefore = JSON.stringify(batch.plan);
  const result = execute(batch, batch.sourceSnapshot, { failAfterActionCount: 1 });

  assert.equal(result.status, 'rejected');
  assert.equal(result.result.code, 'simulated-execution-failure');
  assert.equal(result.result.simulatedAfterActionCount, 1);
  assert.equal(result.state, null);
  assert.equal(JSON.stringify(batch.sourceSnapshot), sourceBefore);
  assert.equal(JSON.stringify(batch.plan), planBefore);
});

test('eligible unrelated action retains existing conflict history and branches', () => {
  let sourceSnapshot = apply(createState('graph-executor'), {
    operationId: 'seed', kind: 'create', fileId: 'file-1', revisionId: 'seed-rev',
    parentRevisionId: null, path: 'pages/conflicted.md', content: 'base',
  });
  sourceSnapshot = apply(sourceSnapshot, {
    operationId: 'branch-a-op', kind: 'update', fileId: 'file-1', revisionId: 'branch-a',
    parentRevisionId: 'seed-rev', content: 'branch A',
  });
  sourceSnapshot = apply(sourceSnapshot, {
    operationId: 'branch-b-op', kind: 'update', fileId: 'file-1', revisionId: 'branch-b',
    parentRevisionId: 'seed-rev', content: 'branch B',
  });
  const events = [
    event('independent', 'create', 'file-2', 'independent-rev', {
      path: 'pages/independent.md', content: 'independent',
    }),
  ];
  const plan = planReconciliation(sourceSnapshot, events);
  const result = execute({ sourceSnapshot, events, plan });

  assert.equal(result.status, 'applied');
  assert.deepEqual(result.state.files['file-1'].heads, ['branch-a', 'branch-b']);
  assert.equal(result.state.conflicts.length, sourceSnapshot.conflicts.length);
  assert.equal(result.state.revisions['branch-a'].content, 'branch A');
  assert.equal(result.state.revisions['branch-b'].content, 'branch B');
});
