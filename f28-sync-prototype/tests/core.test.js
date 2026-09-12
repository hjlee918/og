'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SyncPrototypeError,
  applyOperation,
  createState,
  getRevision,
  normalizedPathKey,
} = require('../src/core');

function apply(state, operation) {
  return applyOperation(state, operation).state;
}

function create(operationId, fileId, revisionId, filePath, content) {
  return { operationId, kind: 'create', fileId, revisionId, parentRevisionId: null, path: filePath, content };
}

function update(operationId, fileId, revisionId, parentRevisionId, content) {
  return { operationId, kind: 'update', fileId, revisionId, parentRevisionId, content };
}

test('normal create and update retain stable file identity and exact Korean/English content', () => {
  let state = createState('graph-synthetic');
  state = apply(state, create('op-1', 'file-1', 'rev-1', 'pages/회의 Notes.md', '첫 줄\nEnglish line'));
  state = apply(state, update('op-2', 'file-1', 'rev-2', 'rev-1', '수정됨\nEnglish preserved'));

  assert.deepEqual(state.files['file-1'].heads, ['rev-2']);
  assert.equal(getRevision(state, 'rev-2').path, 'pages/회의 Notes.md');
  assert.equal(getRevision(state, 'rev-2').content, '수정됨\nEnglish preserved');
  assert.deepEqual(state.revisionOrder, ['rev-1', 'rev-2']);
});

test('offline divergent edits retain both heads as an edit-edit conflict', () => {
  let state = apply(createState('graph-synthetic'), create('op-1', 'file-1', 'rev-1', 'pages/a.md', 'base'));
  state = apply(state, update('op-a', 'file-1', 'rev-a', 'rev-1', 'device A'));
  const transition = applyOperation(state, update('op-b', 'file-1', 'rev-b', 'rev-1', 'device B'));

  assert.equal(transition.result.status, 'conflict');
  assert.deepEqual(transition.state.files['file-1'].heads, ['rev-a', 'rev-b']);
  assert.equal(transition.state.conflicts.at(-1).type, 'edit-edit');
  assert.equal(getRevision(transition.state, 'rev-a').content, 'device A');
  assert.equal(getRevision(transition.state, 'rev-b').content, 'device B');
});

test('edit/delete divergence retains content branch and tombstone', () => {
  let state = apply(createState('graph-synthetic'), create('op-1', 'file-1', 'rev-1', 'pages/a.md', 'base'));
  state = apply(state, update('op-a', 'file-1', 'rev-a', 'rev-1', 'edited'));
  const transition = applyOperation(state, {
    operationId: 'op-b', kind: 'delete', fileId: 'file-1', revisionId: 'rev-b', parentRevisionId: 'rev-1',
  });

  assert.equal(transition.state.conflicts.at(-1).type, 'edit-delete');
  assert.equal(getRevision(transition.state, 'rev-a').content, 'edited');
  assert.equal(getRevision(transition.state, 'rev-b').deleted, true);
  assert.deepEqual(transition.state.files['file-1'].heads, ['rev-a', 'rev-b']);
});

test('rename/rename divergence retains both exact paths', () => {
  let state = apply(createState('graph-synthetic'), create('op-1', 'file-1', 'rev-1', 'pages/a.md', 'base'));
  state = apply(state, {
    operationId: 'op-a', kind: 'rename', fileId: 'file-1', revisionId: 'rev-a', parentRevisionId: 'rev-1', path: 'pages/alpha.md',
  });
  const transition = applyOperation(state, {
    operationId: 'op-b', kind: 'rename', fileId: 'file-1', revisionId: 'rev-b', parentRevisionId: 'rev-1', path: 'pages/beta.md',
  });

  assert.equal(transition.state.conflicts.at(-1).type, 'rename-rename');
  assert.equal(getRevision(transition.state, 'rev-a').path, 'pages/alpha.md');
  assert.equal(getRevision(transition.state, 'rev-b').path, 'pages/beta.md');
});

test('different file IDs targeting NFC/NFD-equivalent paths report a collision', () => {
  const composed = 'pages/한글.md';
  const decomposed = composed.normalize('NFD');
  let state = apply(createState('graph-synthetic'), create('op-1', 'file-1', 'rev-1', composed, '하나'));
  const transition = applyOperation(state, create('op-2', 'file-2', 'rev-2', decomposed, '둘'));

  assert.equal(normalizedPathKey(composed), normalizedPathKey(decomposed));
  assert.equal(transition.result.status, 'conflict');
  assert.equal(transition.state.conflicts.at(-1).type, 'path-collision');
  assert.equal(getRevision(transition.state, 'rev-1').path, composed);
  assert.equal(getRevision(transition.state, 'rev-2').path, decomposed);
  assert.equal(getRevision(transition.state, 'rev-2').content, '둘');
});

test('exact retry is idempotent and changed operation-ID reuse is rejected', () => {
  const operation = create('same-op', 'file-1', 'rev-1', 'pages/a.md', 'one');
  const first = applyOperation(createState('graph-synthetic'), operation);
  const retry = applyOperation(first.state, operation);

  assert.equal(retry.changed, false);
  assert.deepEqual(retry.result, first.result);
  assert.equal(retry.state.revisionOrder.length, 1);
  assert.throws(
    () => applyOperation(first.state, { ...operation, content: 'different' }),
    (error) => error instanceof SyncPrototypeError && error.code === 'operation-id-reuse',
  );
});

test('restore creates a new revision without erasing later history', () => {
  let state = apply(createState('graph-synthetic'), create('op-1', 'file-1', 'rev-1', 'pages/a.md', 'version one'));
  state = apply(state, update('op-2', 'file-1', 'rev-2', 'rev-1', 'version two'));
  state = apply(state, update('op-3', 'file-1', 'rev-3', 'rev-2', 'version three'));
  state = apply(state, {
    operationId: 'op-4', kind: 'restore', fileId: 'file-1', revisionId: 'rev-4', parentRevisionId: 'rev-3', sourceRevisionId: 'rev-1',
  });

  assert.equal(getRevision(state, 'rev-4').content, 'version one');
  assert.equal(getRevision(state, 'rev-4').parentRevisionId, 'rev-3');
  assert.equal(getRevision(state, 'rev-3').content, 'version three');
  assert.deepEqual(state.revisionOrder, ['rev-1', 'rev-2', 'rev-3', 'rev-4']);
});
