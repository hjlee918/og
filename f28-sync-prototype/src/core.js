'use strict';

const STATE_VERSION = 1;

class SyncPrototypeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SyncPrototypeError';
    this.code = code;
    this.details = details;
  }
}

function createState(graphId) {
  requireId(graphId, 'graphId');
  return {
    schema: `f28-local-sync/${STATE_VERSION}`,
    graphId,
    sequence: 0,
    files: {},
    revisions: {},
    revisionOrder: [],
    operations: {},
    conflicts: [],
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SyncPrototypeError('invalid-operation', `${name} must be a non-empty string`);
  }
}

function validateRelativePath(displayPath) {
  if (typeof displayPath !== 'string' || displayPath.length === 0 || displayPath.includes('\0')) {
    throw new SyncPrototypeError('invalid-path', 'path must be a non-empty string without NUL');
  }
  if (displayPath.startsWith('/') || displayPath.includes('\\')) {
    throw new SyncPrototypeError('invalid-path', 'path must be a portable relative path');
  }
  const parts = displayPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new SyncPrototypeError('invalid-path', 'path contains an empty or traversal segment');
  }
  return displayPath;
}

function normalizedPathKey(displayPath) {
  return validateRelativePath(displayPath).normalize('NFC').toLowerCase();
}

function revisionForOperation(state, operation) {
  const file = state.files[operation.fileId];
  let parent = null;
  let displayPath;
  let content;
  let deleted = false;

  if (operation.kind === 'create') {
    if (file) throw new SyncPrototypeError('file-id-exists', 'create file ID already exists');
    if (operation.parentRevisionId !== null) {
      throw new SyncPrototypeError('invalid-parent', 'create requires a null parent');
    }
    displayPath = validateRelativePath(operation.path);
    if (typeof operation.content !== 'string') {
      throw new SyncPrototypeError('invalid-operation', 'create content must be a string');
    }
    content = operation.content;
  } else {
    if (!file) throw new SyncPrototypeError('unknown-file', 'file ID is unknown');
    requireId(operation.parentRevisionId, 'parentRevisionId');
    parent = state.revisions[operation.parentRevisionId];
    if (!parent || parent.fileId !== operation.fileId) {
      throw new SyncPrototypeError('unknown-parent', 'parent revision is unknown for this file');
    }

    switch (operation.kind) {
      case 'update':
        if (typeof operation.content !== 'string') {
          throw new SyncPrototypeError('invalid-operation', 'update content must be a string');
        }
        displayPath = parent.path;
        content = operation.content;
        break;
      case 'rename':
        displayPath = validateRelativePath(operation.path);
        content = parent.content;
        deleted = parent.deleted;
        break;
      case 'delete':
        displayPath = parent.path;
        content = null;
        deleted = true;
        break;
      case 'restore': {
        requireId(operation.sourceRevisionId, 'sourceRevisionId');
        const source = state.revisions[operation.sourceRevisionId];
        if (!source || source.fileId !== operation.fileId || source.deleted) {
          throw new SyncPrototypeError('invalid-restore-source', 'restore source must be a retained non-tombstone revision');
        }
        displayPath = source.path;
        content = source.content;
        break;
      }
      default:
        throw new SyncPrototypeError('invalid-operation', `unsupported operation kind: ${operation.kind}`);
    }
  }

  return {
    id: operation.revisionId,
    fileId: operation.fileId,
    parentRevisionId: operation.parentRevisionId,
    operationId: operation.operationId,
    kind: operation.kind,
    path: displayPath,
    normalizedPath: normalizedPathKey(displayPath),
    content,
    deleted,
    sequence: state.sequence + 1,
  };
}

function conflictKind(left, right) {
  if (left.deleted !== right.deleted) return 'edit-delete';
  if (left.kind === 'rename' && right.kind === 'rename' && left.path !== right.path) {
    return 'rename-rename';
  }
  return 'edit-edit';
}

function addConflict(next, type, fileIds, revisionIds) {
  const conflict = {
    id: `conflict-${next.conflicts.length + 1}`,
    type,
    fileIds: [...new Set(fileIds)],
    revisionIds: [...new Set(revisionIds)],
    status: 'open',
  };
  next.conflicts.push(conflict);
  return conflict.id;
}

function applyOperation(inputState, inputOperation) {
  const state = clone(inputState);
  const operation = clone(inputOperation);
  requireId(operation.operationId, 'operationId');
  requireId(operation.fileId, 'fileId');
  requireId(operation.revisionId, 'revisionId');
  const fingerprint = stableStringify(operation);
  const priorOperation = state.operations[operation.operationId];
  if (priorOperation) {
    if (priorOperation.fingerprint !== fingerprint) {
      throw new SyncPrototypeError(
        'operation-id-reuse',
        'operation ID was already used with different contents',
        { operationId: operation.operationId },
      );
    }
    return { state: inputState, result: clone(priorOperation.result), changed: false };
  }
  if (state.revisions[operation.revisionId]) {
    throw new SyncPrototypeError('revision-id-reuse', 'revision ID was already used');
  }

  const oldFile = state.files[operation.fileId];
  const oldHeads = oldFile ? [...oldFile.heads] : [];
  const revision = revisionForOperation(state, operation);
  state.sequence = revision.sequence;
  state.revisions[revision.id] = revision;
  state.revisionOrder.push(revision.id);

  const stale = operation.kind !== 'create' && !oldHeads.includes(operation.parentRevisionId);
  const newHeads = operation.kind === 'create'
    ? [revision.id]
    : stale
      ? [...oldHeads, revision.id]
      : [...oldHeads.filter((id) => id !== operation.parentRevisionId), revision.id];
  state.files[operation.fileId] = { id: operation.fileId, heads: newHeads };

  const conflictIds = [];
  if (stale) {
    const currentRevisions = oldHeads.map((id) => state.revisions[id]);
    const types = new Set(currentRevisions.map((head) => conflictKind(revision, head)));
    for (const type of types) {
      const matchingHeads = currentRevisions
        .filter((head) => conflictKind(revision, head) === type)
        .map((head) => head.id);
      conflictIds.push(addConflict(state, type, [operation.fileId], [revision.id, ...matchingHeads]));
    }
  }

  if (!revision.deleted) {
    const collidingFiles = [];
    const collidingRevisions = [];
    for (const [otherFileId, otherFile] of Object.entries(state.files)) {
      if (otherFileId === operation.fileId) continue;
      for (const headId of otherFile.heads) {
        const head = state.revisions[headId];
        if (!head.deleted && head.normalizedPath === revision.normalizedPath) {
          collidingFiles.push(otherFileId);
          collidingRevisions.push(headId);
        }
      }
    }
    if (collidingRevisions.length) {
      conflictIds.push(addConflict(
        state,
        'path-collision',
        [operation.fileId, ...collidingFiles],
        [revision.id, ...collidingRevisions],
      ));
    }
  }

  const result = {
    status: conflictIds.length ? 'conflict' : 'committed',
    operationId: operation.operationId,
    revisionId: revision.id,
    conflictIds,
  };
  state.operations[operation.operationId] = { fingerprint, result: clone(result) };
  return { state, result, changed: true };
}

function getRevision(state, revisionId) {
  const revision = state.revisions[revisionId];
  return revision ? clone(revision) : null;
}

module.exports = {
  SyncPrototypeError,
  applyOperation,
  createState,
  getRevision,
  normalizedPathKey,
  stableStringify,
  validateRelativePath,
};
