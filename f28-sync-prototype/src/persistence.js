'use strict';

const crypto = require('node:crypto');
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
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function directoryIdentity(target, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ContainmentError(`${label} is not an owned directory`);
  }
  return identity(stat);
}

function assertIdentity(target, expected, label, kind) {
  const stat = lstatOrNull(target);
  if (!stat || stat.isSymbolicLink() || !stat[kind]()) {
    throw new ContainmentError(`${label} was removed, replaced, or linked`);
  }
  const actual = identity(stat);
  if (!sameIdentity(actual, expected)) {
    throw new ContainmentError(`${label} identity changed`);
  }
  return stat;
}

function canonicalApprovedRoot(approvedRoot = APPROVED_TEST_ROOT) {
  const canonical = fs.realpathSync.native(approvedRoot);
  directoryIdentity(canonical, 'approved root');
  return canonical;
}

function createFreshTestRun(label = 'f28-sync-prototype', approvedRoot = APPROVED_TEST_ROOT) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new ContainmentError('invalid test-run label');
  const canonicalRoot = canonicalApprovedRoot(approvedRoot);
  const rootIdentity = directoryIdentity(canonicalRoot, 'approved root');
  const created = fs.mkdtempSync(path.join(canonicalRoot, `${label}-`));
  const canonicalRun = fs.realpathSync.native(created);
  assertIdentity(canonicalRoot, rootIdentity, 'approved root', 'isDirectory');
  if (!isDescendant(canonicalRoot, canonicalRun) || path.dirname(canonicalRun) !== canonicalRoot) {
    throw new ContainmentError('fresh run is not a direct child of the approved root');
  }
  directoryIdentity(canonicalRun, 'fresh run');
  return canonicalRun;
}

function assertNoSymlinkPath(canonicalBase, candidate) {
  const relative = path.relative(canonicalBase, candidate);
  if (relative === '' || relative === '.') return;
  let cursor = canonicalBase;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new ContainmentError('symlink path refused');
  }
}

function safeResolve(canonicalBase, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || path.isAbsolute(relativePath)) {
    throw new ContainmentError('path must be relative');
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ContainmentError('path traversal refused');
  }
  const candidate = path.resolve(canonicalBase, ...parts);
  if (!isDescendant(canonicalBase, candidate)) {
    throw new ContainmentError('path escapes store root');
  }
  assertNoSymlinkPath(canonicalBase, candidate);
  return candidate;
}

function regularFileIdentity(target, label, allowMissing = false) {
  const stat = lstatOrNull(target);
  if (!stat && allowMissing) return null;
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new ContainmentError(`${label} is missing, linked, or not a regular file`);
  }
  return identity(stat);
}

class DurableStateStore {
  constructor({ approvedRoot = APPROVED_TEST_ROOT, runRoot, storeName }) {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW === 0) {
      throw new ContainmentError('platform does not provide O_NOFOLLOW');
    }
    this.noFollowFlag = fs.constants.O_NOFOLLOW;
    this.approvedRoot = canonicalApprovedRoot(approvedRoot);
    this.approvedRootIdentity = directoryIdentity(this.approvedRoot, 'approved root');

    this.runRoot = fs.realpathSync.native(runRoot);
    if (!isDescendant(this.approvedRoot, this.runRoot)
        || path.dirname(this.runRoot) !== this.approvedRoot) {
      throw new ContainmentError('run root must be one direct test-owned child');
    }
    this.runRootIdentity = directoryIdentity(this.runRoot, 'run root');

    if (!/^[a-z0-9-]+$/.test(storeName)) {
      throw new ContainmentError('invalid store name');
    }
    const requestedStore = path.join(this.runRoot, storeName);
    try {
      fs.mkdirSync(requestedStore, { recursive: false });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const requestedStat = fs.lstatSync(requestedStore);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
      throw new ContainmentError('store path is not an owned directory');
    }
    this.storeRoot = fs.realpathSync.native(requestedStore);
    if (!isDescendant(this.runRoot, this.storeRoot)) {
      throw new ContainmentError('store escapes test run');
    }
    this.storeRootIdentity = directoryIdentity(this.storeRoot, 'store root');
    this.#verifyOwnedDirectories();

    this.statePath = safeResolve(this.storeRoot, 'state.json');
    this.stateIdentity = regularFileIdentity(this.statePath, 'state file', true);
  }

  resolve(relativePath) {
    this.#verifyOwnedDirectories();
    return safeResolve(this.storeRoot, relativePath);
  }

  read() {
    return this.#readRecord().state;
  }

  initialize(state) {
    const current = this.#readRecord();
    if (current.state !== null) throw new Error('state store is already initialized');
    this.#persist(state, undefined, null);
  }

  commit(operation, { failAt } = {}) {
    const current = this.#readRecord();
    if (!current.state) throw new Error('state store is not initialized');
    const transition = applyOperation(current.state, operation);
    if (transition.changed) this.#persist(transition.state, failAt, current.identity);
    return { acknowledged: true, replayed: !transition.changed, result: transition.result };
  }

  #verifyOwnedDirectories() {
    assertIdentity(
      this.approvedRoot, this.approvedRootIdentity, 'approved root', 'isDirectory',
    );
    assertIdentity(this.runRoot, this.runRootIdentity, 'run root', 'isDirectory');
    assertIdentity(this.storeRoot, this.storeRootIdentity, 'store root', 'isDirectory');
  }

  #assertExpectedState(expected) {
    const actual = regularFileIdentity(this.statePath, 'state file', true);
    if (!expected && actual) throw new ContainmentError('unexpected state file appeared');
    if (expected && !sameIdentity(actual, expected)) {
      throw new ContainmentError('state file identity changed');
    }
    return actual;
  }

  #readRecord() {
    this.#verifyOwnedDirectories();
    const before = this.#assertExpectedState(this.stateIdentity);
    if (!before) return { state: null, identity: null };

    let descriptor;
    try {
      descriptor = fs.openSync(
        this.statePath,
        fs.constants.O_RDONLY | this.noFollowFlag,
      );
    } catch (error) {
      throw new ContainmentError(`state file open refused: ${error.code || 'unknown'}`);
    }
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameIdentity(identity(opened), before)) {
        throw new ContainmentError('opened state file identity changed');
      }
      this.#verifyOwnedDirectories();
      this.#assertExpectedState(before);
      const payload = fs.readFileSync(descriptor, 'utf8');
      this.#verifyOwnedDirectories();
      this.#assertExpectedState(before);
      return { state: JSON.parse(payload), identity: before };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  #persist(state, failAt, expectedStateIdentity) {
    this.#verifyOwnedDirectories();
    this.#assertExpectedState(expectedStateIdentity);
    const pendingPath = safeResolve(
      this.storeRoot,
      `.state.pending.${crypto.randomUUID()}.json`,
    );
    if (failAt) failAt('before-open', { pendingPath });

    let descriptor;
    try {
      descriptor = fs.openSync(
        pendingPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | this.noFollowFlag,
        0o600,
      );
    } catch (error) {
      throw new ContainmentError(`exclusive pending-file creation refused: ${error.code || 'unknown'}`);
    }

    let pendingIdentity;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) throw new ContainmentError('pending entry is not a regular file');
      pendingIdentity = identity(opened);
      this.#verifyOwnedDirectories();
      assertIdentity(pendingPath, pendingIdentity, 'pending file', 'isFile');
      if (failAt) failAt('before-write', { pendingPath });
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    if (failAt) failAt('after-write-before-rename', { pendingPath });
    this.#verifyOwnedDirectories();
    this.#assertExpectedState(expectedStateIdentity);
    assertIdentity(pendingPath, pendingIdentity, 'pending file', 'isFile');
    fs.renameSync(pendingPath, this.statePath);

    let installedDescriptor;
    try {
      installedDescriptor = fs.openSync(
        this.statePath,
        fs.constants.O_RDONLY | this.noFollowFlag,
      );
      const installed = fs.fstatSync(installedDescriptor);
      if (!installed.isFile() || !sameIdentity(identity(installed), pendingIdentity)) {
        throw new ContainmentError('installed state does not match pending file');
      }
      this.#verifyOwnedDirectories();
      assertIdentity(this.statePath, pendingIdentity, 'installed state', 'isFile');
    } catch (error) {
      if (error instanceof ContainmentError) throw error;
      throw new ContainmentError(`installed state verification refused: ${error.code || 'unknown'}`);
    } finally {
      if (installedDescriptor !== undefined) fs.closeSync(installedDescriptor);
    }

    const directoryDescriptor = fs.openSync(this.storeRoot, fs.constants.O_RDONLY);
    try {
      const openedDirectory = fs.fstatSync(directoryDescriptor);
      if (!openedDirectory.isDirectory()
          || !sameIdentity(identity(openedDirectory), this.storeRootIdentity)) {
        throw new ContainmentError('opened store directory identity changed');
      }
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    this.#verifyOwnedDirectories();
    assertIdentity(this.statePath, pendingIdentity, 'installed state', 'isFile');
    this.stateIdentity = pendingIdentity;
    if (failAt) failAt('after-rename-before-ack', { pendingPath: this.statePath });
  }
}

module.exports = {
  APPROVED_TEST_ROOT,
  ContainmentError,
  DurableStateStore,
  createFreshTestRun,
  safeResolve,
};
