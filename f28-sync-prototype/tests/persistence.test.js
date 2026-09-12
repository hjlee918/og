'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createState } = require('../src/core');
const {
  APPROVED_TEST_ROOT,
  ContainmentError,
  DurableStateStore,
  createFreshTestRun,
} = require('../src/persistence');

let runRoot;

test.before(() => {
  runRoot = createFreshTestRun();
});

function store(name) {
  return new DurableStateStore({ approvedRoot: APPROVED_TEST_ROOT, runRoot, storeName: name });
}

function createOp() {
  return {
    operationId: 'op-create', kind: 'create', fileId: 'file-1', revisionId: 'rev-1',
    parentRevisionId: null, path: 'pages/시작 Start.md', content: '안녕하세요\nHello',
  };
}

function assertContainmentRefusal(action) {
  assert.throws(action, (error) => error instanceof ContainmentError);
}

test('persisted replicas propagate operations in both simulated directions', () => {
  const relay = store('relay');
  const deviceA = store('device-a');
  const deviceB = store('device-b');
  for (const target of [relay, deviceA, deviceB]) target.initialize(createState('graph-synthetic'));

  const fromA = createOp();
  deviceA.commit(fromA);
  relay.commit(fromA);
  deviceB.commit(fromA);

  const fromB = {
    operationId: 'op-update', kind: 'update', fileId: 'file-1', revisionId: 'rev-2',
    parentRevisionId: 'rev-1', content: '기기 B\nDevice B',
  };
  deviceB.commit(fromB);
  relay.commit(fromB);
  deviceA.commit(fromB);

  const renameFromA = {
    operationId: 'op-rename', kind: 'rename', fileId: 'file-1', revisionId: 'rev-3',
    parentRevisionId: 'rev-2', path: 'pages/동기화 Sync.md',
  };
  deviceA.commit(renameFromA);
  relay.commit(renameFromA);
  deviceB.commit(renameFromA);

  const deleteFromB = {
    operationId: 'op-delete', kind: 'delete', fileId: 'file-1', revisionId: 'rev-4',
    parentRevisionId: 'rev-3',
  };
  deviceB.commit(deleteFromB);
  relay.commit(deleteFromB);
  deviceA.commit(deleteFromB);

  assert.deepEqual(deviceA.read(), relay.read());
  assert.deepEqual(deviceB.read(), relay.read());
  assert.equal(relay.read().revisions['rev-2'].content, '기기 B\nDevice B');
  assert.equal(relay.read().revisions['rev-3'].path, 'pages/동기화 Sync.md');
  assert.equal(relay.read().revisions['rev-4'].deleted, true);
  assert.deepEqual(relay.read().revisionOrder, ['rev-1', 'rev-2', 'rev-3', 'rev-4']);
});

test('interruption before rename is uncommitted; retry and restart commit once', () => {
  const target = store('interrupted-before-rename');
  target.initialize(createState('graph-interrupted'));
  assert.throws(
    () => target.commit(createOp(), { failAt(stage) { if (stage === 'after-write-before-rename') throw new Error('injected'); } }),
    /injected/,
  );
  assert.equal(target.read().revisionOrder.length, 0);

  const acknowledgement = target.commit(createOp());
  const restarted = store('interrupted-before-rename');
  assert.equal(acknowledgement.acknowledged, true);
  assert.deepEqual(restarted.read().revisionOrder, ['rev-1']);
  assert.equal(restarted.commit(createOp()).replayed, true);
  assert.deepEqual(restarted.read().revisionOrder, ['rev-1']);
});

test('interruption after durable rename is recovered by idempotent retry', () => {
  const target = store('interrupted-before-ack');
  target.initialize(createState('graph-interrupted-ack'));
  assert.throws(
    () => target.commit(createOp(), { failAt(stage) { if (stage === 'after-rename-before-ack') throw new Error('ack withheld'); } }),
    /ack withheld/,
  );

  const restarted = store('interrupted-before-ack');
  assert.deepEqual(restarted.read().revisionOrder, ['rev-1']);
  const retry = restarted.commit(createOp());
  assert.equal(retry.acknowledged, true);
  assert.equal(retry.replayed, true);
  assert.deepEqual(restarted.read().revisionOrder, ['rev-1']);
});

test('filesystem adapter refuses traversal and symlink escape before target access', () => {
  const target = store('containment');
  target.initialize(createState('graph-containment'));
  const outsideStore = path.join(runRoot, 'contained-but-outside-store');
  fs.mkdirSync(outsideStore, { recursive: false });
  fs.symlinkSync('../contained-but-outside-store', path.join(target.storeRoot, 'escape'));

  assert.throws(() => target.resolve('../contained-but-outside-store/state.json'),
    (error) => error instanceof ContainmentError);
  assert.throws(() => target.resolve('escape/state.json'),
    (error) => error instanceof ContainmentError);
  assert.equal(fs.readdirSync(outsideStore).length, 0);
});

test('pending-file symlink substitution after construction cannot alter its sentinel', () => {
  const target = store('pending-symlink-substitution');
  target.initialize(createState('graph-pending-symlink'));
  const sentinelPath = path.join(runRoot, 'pending-symlink-sentinel.txt');
  const sentinel = 'pending sentinel must remain unchanged';
  fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });

  assertContainmentRefusal(() => target.commit(createOp(), {
    failAt(stage, { pendingPath } = {}) {
      if (stage === 'before-open') {
        fs.symlinkSync(path.relative(path.dirname(pendingPath), sentinelPath), pendingPath);
      }
    },
  }));
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel);
  assert.deepEqual(target.read().revisionOrder, []);
});

test('state-file symlink substitution makes read and commit fail closed', () => {
  const target = store('state-symlink-substitution');
  target.initialize(createState('graph-state-symlink'));
  const sentinelPath = path.join(runRoot, 'state-symlink-sentinel.txt');
  const sentinel = 'state sentinel must remain unchanged';
  fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
  fs.unlinkSync(target.statePath);
  fs.symlinkSync(path.relative(target.storeRoot, sentinelPath), target.statePath);

  assertContainmentRefusal(() => target.read());
  assertContainmentRefusal(() => target.commit(createOp()));
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel);
});

test('store-directory substitution after construction is rejected by real entry points', () => {
  const target = store('store-directory-substitution');
  target.initialize(createState('graph-store-substitution'));
  const originalStorePath = path.join(runRoot, 'store-directory-original');
  fs.renameSync(target.storeRoot, originalStorePath);
  fs.mkdirSync(target.storeRoot, { recursive: false });
  const sentinelPath = path.join(target.storeRoot, 'sentinel.txt');
  const sentinel = 'replacement directory sentinel must remain unchanged';
  fs.writeFileSync(sentinelPath, sentinel, { mode: 0o600 });

  assertContainmentRefusal(() => target.read());
  assertContainmentRefusal(() => target.initialize(createState('replacement')));
  assertContainmentRefusal(() => target.commit(createOp()));
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel);
});

test('existing and interrupted pending evidence is preserved across recovery and restart', () => {
  const target = store('pending-evidence-recovery');
  const existingPendingPath = path.join(target.storeRoot, '.state.pending.existing.json');
  const existingPending = 'pre-existing pending evidence';
  fs.writeFileSync(existingPendingPath, existingPending, { mode: 0o600 });
  target.initialize(createState('graph-pending-evidence'));

  let interruptedPendingPath;
  assert.throws(
    () => target.commit(createOp(), {
      failAt(stage, details) {
        if (stage === 'after-write-before-rename') {
          interruptedPendingPath = details.pendingPath;
          throw new Error('controlled interruption');
        }
      },
    }),
    /controlled interruption/,
  );
  const interruptedPending = fs.readFileSync(interruptedPendingPath, 'utf8');
  assert.deepEqual(target.read().revisionOrder, []);

  assert.equal(target.commit(createOp()).acknowledged, true);
  const restarted = store('pending-evidence-recovery');
  assert.equal(restarted.commit(createOp()).replayed, true);
  assert.deepEqual(restarted.read().revisionOrder, ['rev-1']);
  assert.equal(fs.readFileSync(existingPendingPath, 'utf8'), existingPending);
  assert.equal(fs.readFileSync(interruptedPendingPath, 'utf8'), interruptedPending);
});
