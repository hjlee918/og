'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyOperation } = require('./core');

const APPROVED_TEST_ROOT = '/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test';

class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainmentError';
    this.code = 'containment-refused';
  }
}

function isDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function canonicalApprovedRoot(approvedRoot = APPROVED_TEST_ROOT) {
  const canonical = fs.realpathSync.native(approvedRoot);
  if (!fs.statSync(canonical).isDirectory()) throw new ContainmentError('approved root is not a directory');
  return canonical;
}

function createFreshTestRun(label = 'f28-sync-prototype', approvedRoot = APPROVED_TEST_ROOT) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new ContainmentError('invalid test-run label');
  const canonicalRoot = canonicalApprovedRoot(approvedRoot);
  const created = fs.mkdtempSync(path.join(canonicalRoot, `${label}-`));
  const canonicalRun = fs.realpathSync.native(created);
  if (!isDescendant(canonicalRoot, canonicalRun) || path.dirname(canonicalRun) !== canonicalRoot) {
    throw new ContainmentError('fresh run is not a direct child of the approved root');
  }
  return canonicalRun;
}

function assertNoSymlinkPath(canonicalBase, candidate) {
  const relative = path.relative(canonicalBase, candidate);
  if (relative === '' || relative === '.') return;
  let cursor = canonicalBase;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw new ContainmentError('symlink path refused');
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function safeResolve(canonicalBase, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new ContainmentError('path must be relative');
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ContainmentError('path traversal refused');
  }
  const candidate = path.resolve(canonicalBase, ...parts);
  if (!isDescendant(canonicalBase, candidate)) throw new ContainmentError('path escapes store root');
  assertNoSymlinkPath(canonicalBase, candidate);
  return candidate;
}

class DurableStateStore {
  constructor({ approvedRoot = APPROVED_TEST_ROOT, runRoot, storeName }) {
    const canonicalRoot = canonicalApprovedRoot(approvedRoot);
    const canonicalRun = fs.realpathSync.native(runRoot);
    if (!isDescendant(canonicalRoot, canonicalRun)) throw new ContainmentError('run root is outside approved root');
    if (path.dirname(canonicalRun) !== canonicalRoot) {
      throw new ContainmentError('run root must be one direct test-owned child');
    }
    assertNoSymlinkPath(canonicalRoot, canonicalRun);
    if (!/^[a-z0-9-]+$/.test(storeName)) throw new ContainmentError('invalid store name');
    const requestedStore = path.join(canonicalRun, storeName);
    if (!fs.existsSync(requestedStore)) fs.mkdirSync(requestedStore, { recursive: false });
    const canonicalStore = fs.realpathSync.native(requestedStore);
    if (!isDescendant(canonicalRun, canonicalStore)) throw new ContainmentError('store escapes test run');
    assertNoSymlinkPath(canonicalRun, canonicalStore);
    this.runRoot = canonicalRun;
    this.storeRoot = canonicalStore;
    this.statePath = safeResolve(canonicalStore, 'state.json');
    this.pendingPath = safeResolve(canonicalStore, '.state.pending.json');
  }

  resolve(relativePath) {
    return safeResolve(this.storeRoot, relativePath);
  }

  read() {
    assertNoSymlinkPath(this.storeRoot, this.statePath);
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  initialize(state) {
    if (this.read() !== null) throw new Error('state store is already initialized');
    this.#persist(state);
  }

  commit(operation, { failAt } = {}) {
    const current = this.read();
    if (!current) throw new Error('state store is not initialized');
    const transition = applyOperation(current, operation);
    if (transition.changed) this.#persist(transition.state, failAt);
    if (failAt) failAt('after-rename-before-ack');
    return { acknowledged: true, replayed: !transition.changed, result: transition.result };
  }

  #persist(state, failAt) {
    if (failAt) failAt('before-write');
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const descriptor = fs.openSync(this.pendingPath, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, payload, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (failAt) failAt('after-write-before-rename');
    fs.renameSync(this.pendingPath, this.statePath);
    const directoryDescriptor = fs.openSync(this.storeRoot, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  }
}

module.exports = {
  APPROVED_TEST_ROOT,
  ContainmentError,
  DurableStateStore,
  createFreshTestRun,
  safeResolve,
};
