'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyOperation, createState } = require('../src/core');
const {
  checkPlanPrecondition,
  operationIdForEvent,
  planReconciliation,
} = require('../src/planner');

function apply(state, operation) {
  return applyOperation(state, operation).state;
}

function createStateWithFile(filePath = 'pages/start.md', content = 'base') {
  return apply(createState('graph-planner'), {
    operationId: 'seed-op', kind: 'create', fileId: 'file-1', revisionId: 'seed-rev',
    parentRevisionId: null, path: filePath, content,
  });
}

function event(eventId, kind, fileId, revisionId, values = {}) {
  return { eventId, kind, fileId, revisionId, ...values };
}

test('normal events produce deterministic reviewable actions and preserve inputs', () => {
  const snapshot = createState('graph-planner');
  const events = [
    event('event-1', 'create', 'file-1', 'rev-1', {
      path: 'pages/회의 Notes.md', content: '첫 줄\nEnglish line',
    }),
    event('event-2', 'update', 'file-1', 'rev-2', {
      parentRevisionId: 'rev-1', content: '수정됨\nEnglish preserved',
    }),
    event('event-3', 'rename', 'file-1', 'rev-3', {
      parentRevisionId: 'rev-2', path: 'pages/동기화 Sync.md',
    }),
    event('event-4', 'delete', 'file-1', 'rev-4', { parentRevisionId: 'rev-3' }),
  ];
  const snapshotBefore = JSON.stringify(snapshot);
  const eventsBefore = JSON.stringify(events);

  const first = planReconciliation(snapshot, events);
  const second = planReconciliation(snapshot, events);

  assert.deepEqual(first, second);
  assert.equal(first.actions.length, 4);
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.invalid.length, 0);
  assert.deepEqual(first.actions[0].expected, {
    fileExists: false, currentHeads: [], parent: null,
  });
  assert.equal(first.actions[1].expected.parent.revisionId, 'rev-1');
  assert.equal(first.actions[1].expected.parent.path, 'pages/회의 Notes.md');
  assert.equal(first.actions[1].expected.parent.content, '첫 줄\nEnglish line');
  assert.equal(first.actions[1].operation.content, '수정됨\nEnglish preserved');
  assert.equal(first.actions[2].operation.path, 'pages/동기화 Sync.md');
  assert.equal(first.actions[3].expected.parent.path, 'pages/동기화 Sync.md');
  assert.equal(first.actions[3].expected.parent.content, '수정됨\nEnglish preserved');
  assert.ok(first.actions[3].reasons.includes('parent-is-current-head'));
  assert.match(first.actions[0].operation.operationId, /^plan-op-[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(snapshot), snapshotBefore);
  assert.equal(JSON.stringify(events), eventsBefore);
});

test('exact duplicate event is separate and changed event-ID reuse is invalid', () => {
  const snapshot = createState('graph-planner');
  const original = event('event-1', 'create', 'file-1', 'rev-1', {
    path: 'pages/a.md', content: 'one',
  });
  const changed = { ...original, content: 'different' };
  const plan = planReconciliation(snapshot, [original, { ...original }, changed]);

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].duplicateOfIndex, 0);
  assert.equal(plan.invalid.length, 1);
  assert.equal(plan.invalid[0].code, 'operation-id-reuse');
});

test('snapshot operation retry is duplicate and changed operation-ID reuse is rejected', () => {
  const snapshot = createState('graph-planner');
  const original = event('event-1', 'create', 'file-1', 'rev-1', {
    path: 'pages/a.md', content: 'one',
  });
  const firstPlan = planReconciliation(snapshot, [original]);
  const applied = apply(snapshot, firstPlan.actions[0].operation);

  const retryPlan = planReconciliation(applied, [original]);
  assert.equal(retryPlan.actions.length, 0);
  assert.equal(retryPlan.duplicates[0].reason, 'operation-already-present-in-snapshot');

  const reusePlan = planReconciliation(applied, [{ ...original, content: 'changed' }]);
  assert.equal(reusePlan.actions.length, 0);
  assert.equal(reusePlan.invalid[0].code, 'operation-id-reuse');
});

test('precondition check rejects a plan when the destination snapshot changed', () => {
  const snapshot = createStateWithFile();
  const plan = planReconciliation(snapshot, [event('event-1', 'update', 'file-1', 'rev-2', {
    parentRevisionId: 'seed-rev', content: 'planned',
  })]);
  const changed = apply(snapshot, {
    operationId: 'outside-op', kind: 'update', fileId: 'file-1', revisionId: 'outside-rev',
    parentRevisionId: 'seed-rev', content: 'changed elsewhere',
  });

  assert.equal(checkPlanPrecondition(plan, snapshot).applicable, true);
  const refusal = checkPlanPrecondition(plan, changed);
  assert.equal(refusal.applicable, false);
  assert.equal(refusal.code, 'stale-plan');
});

test('missing and unknown parents are invalid while an independent action remains applicable', () => {
  const snapshot = createStateWithFile();
  const plan = planReconciliation(snapshot, [
    event('missing', 'update', 'file-1', 'rev-missing', { content: 'missing parent' }),
    event('unknown', 'delete', 'file-1', 'rev-unknown', { parentRevisionId: 'not-known' }),
    event('valid', 'create', 'file-2', 'rev-valid', { path: 'pages/valid.md', content: 'valid' }),
  ]);

  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.invalid.map((item) => item.code), ['missing-parent', 'unknown-parent']);
  assert.equal(plan.conflicts.length, 0);
});

test('an existing multi-head conflict blocks update, rename and delete on either head', () => {
  let snapshot = createStateWithFile();
  snapshot = apply(snapshot, {
    operationId: 'branch-a-op', kind: 'update', fileId: 'file-1', revisionId: 'branch-a',
    parentRevisionId: 'seed-rev', content: 'branch A',
  });
  snapshot = apply(snapshot, {
    operationId: 'branch-b-op', kind: 'update', fileId: 'file-1', revisionId: 'branch-b',
    parentRevisionId: 'seed-rev', content: 'branch B',
  });
  const snapshotBefore = JSON.stringify(snapshot);
  const plan = planReconciliation(snapshot, [
    event('update', 'update', 'file-1', 'next-update', {
      parentRevisionId: 'branch-a', content: 'must not hide branch B',
    }),
    event('rename', 'rename', 'file-1', 'next-rename', {
      parentRevisionId: 'branch-a', path: 'pages/renamed.md',
    }),
    event('delete', 'delete', 'file-1', 'next-delete', { parentRevisionId: 'branch-a' }),
  ]);

  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 3);
  for (const conflict of plan.conflicts) {
    assert.ok(conflict.reasons.includes('multiple-current-heads'));
    assert.ok(conflict.reasons.includes('unresolved-relevant-conflict'));
    assert.deepEqual(conflict.expected.currentHeads, ['branch-a', 'branch-b']);
  }
  assert.equal(JSON.stringify(snapshot), snapshotBefore);
});

test('offline edit/delete and rename/rename events are conflicts, not later actions', () => {
  const editSnapshot = createStateWithFile();
  const editDelete = planReconciliation(editSnapshot, [
    event('edit', 'update', 'file-1', 'edit-rev', {
      parentRevisionId: 'seed-rev', content: 'edited',
    }),
    event('delete', 'delete', 'file-1', 'delete-rev', { parentRevisionId: 'seed-rev' }),
  ]);
  assert.equal(editDelete.actions.length, 1);
  assert.equal(editDelete.conflicts.length, 1);
  assert.equal(editDelete.conflicts[0].introducedConflicts[0].type, 'edit-delete');

  const renameSnapshot = createStateWithFile();
  const renameRename = planReconciliation(renameSnapshot, [
    event('rename-a', 'rename', 'file-1', 'rename-a-rev', {
      parentRevisionId: 'seed-rev', path: 'pages/alpha.md',
    }),
    event('rename-b', 'rename', 'file-1', 'rename-b-rev', {
      parentRevisionId: 'seed-rev', path: 'pages/beta.md',
    }),
  ]);
  assert.equal(renameRename.actions.length, 1);
  assert.equal(renameRename.conflicts.length, 1);
  assert.equal(renameRename.conflicts[0].introducedConflicts[0].type, 'rename-rename');
});

test('NFC/NFD-equivalent target paths produce a retained normalized-path conflict', () => {
  const composed = 'pages/한글.md';
  const decomposed = composed.normalize('NFD');
  const snapshot = createStateWithFile(composed, '하나\nOne');
  const plan = planReconciliation(snapshot, [
    event('collision', 'create', 'file-2', 'collision-rev', {
      path: decomposed, content: '둘\nTwo',
    }),
  ]);

  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].introducedConflicts[0].type, 'path-collision');
  assert.equal(plan.conflicts[0].operation.path, decomposed);
  assert.equal(plan.conflicts[0].operation.content, '둘\nTwo');
});

test('an existing normalized-path conflict blocks a rename that would otherwise commit', () => {
  const composed = 'pages/한글.md';
  const decomposed = composed.normalize('NFD');
  let snapshot = createStateWithFile(composed, 'first');
  snapshot = apply(snapshot, {
    operationId: 'collision-op', kind: 'create', fileId: 'file-2', revisionId: 'collision-rev',
    parentRevisionId: null, path: decomposed, content: 'second',
  });
  const existingConflictId = snapshot.conflicts[0].id;
  const plan = planReconciliation(snapshot, [
    event('rename-away', 'rename', 'file-1', 'renamed-rev', {
      parentRevisionId: 'seed-rev', path: 'pages/unique.md',
    }),
  ]);

  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0].existingConflictIds, [existingConflictId]);
  assert.deepEqual(plan.conflicts[0].introducedConflicts, []);
  assert.ok(plan.conflicts[0].reasons.includes('unresolved-relevant-conflict'));
});

test('operation identity is stable for graph and event ID and differs across either input', () => {
  const first = operationIdForEvent('graph-a', 'event-a');
  assert.equal(first, operationIdForEvent('graph-a', 'event-a'));
  assert.notEqual(first, operationIdForEvent('graph-a', 'event-b'));
  assert.notEqual(first, operationIdForEvent('graph-b', 'event-a'));
});
