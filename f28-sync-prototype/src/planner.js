'use strict';

const crypto = require('node:crypto');
const {
  SyncPrototypeError,
  applyOperation,
  normalizedPathKey,
  stableStringify,
} = require('./core');

const PLANNER_SCHEMA = 'f28-reconciliation-plan/1';
const EVENT_KINDS = new Set(['create', 'update', 'rename', 'delete']);

class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

function cloneJson(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON serializable');
    return JSON.parse(serialized);
  } catch (error) {
    throw new PlannerError('invalid-input', `${label} must be JSON serializable`);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshotFingerprint(snapshot) {
  return `sha256:${digest(stableStringify(snapshot))}`;
}

function operationIdForEvent(graphId, eventId) {
  if (typeof graphId !== 'string' || graphId.length === 0
      || typeof eventId !== 'string' || eventId.length === 0) {
    throw new PlannerError('invalid-event-id', 'graph ID and event ID must be non-empty strings');
  }
  return `plan-op-${digest(stableStringify({ eventId, graphId })).slice(0, 32)}`;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || typeof snapshot.graphId !== 'string' || snapshot.graphId.length === 0
      || !snapshot.files || typeof snapshot.files !== 'object'
      || !snapshot.revisions || typeof snapshot.revisions !== 'object'
      || !snapshot.operations || typeof snapshot.operations !== 'object'
      || !Array.isArray(snapshot.conflicts)) {
    throw new PlannerError('invalid-snapshot', 'snapshot does not match the prototype state shape');
  }
}

function invalidEvent(event, index, code, reason) {
  return { index, event: cloneJson(event, 'event'), code, reason };
}

function translateEvent(snapshot, event, index) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { invalid: invalidEvent(event, index, 'invalid-event', 'event must be an object') };
  }
  for (const field of ['eventId', 'fileId', 'revisionId']) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      return { invalid: invalidEvent(event, index, 'invalid-event', `${field} must be a non-empty string`) };
    }
  }
  if (!EVENT_KINDS.has(event.kind)) {
    return { invalid: invalidEvent(event, index, 'invalid-kind', 'unsupported event kind') };
  }
  if (event.kind !== 'create'
      && (typeof event.parentRevisionId !== 'string' || event.parentRevisionId.length === 0)) {
    return { invalid: invalidEvent(event, index, 'missing-parent', 'non-create event requires a parent revision') };
  }
  if (event.kind === 'create'
      && event.parentRevisionId !== undefined && event.parentRevisionId !== null) {
    return { invalid: invalidEvent(event, index, 'invalid-parent', 'create event cannot name a parent revision') };
  }

  const operation = {
    operationId: operationIdForEvent(snapshot.graphId, event.eventId),
    kind: event.kind,
    fileId: event.fileId,
    revisionId: event.revisionId,
    parentRevisionId: event.kind === 'create' ? null : event.parentRevisionId,
  };
  if (event.kind === 'create' || event.kind === 'update') operation.content = event.content;
  if (event.kind === 'create' || event.kind === 'rename') operation.path = event.path;
  return { operation };
}

function expectedPrior(state, operation) {
  const file = state.files[operation.fileId];
  const parent = operation.parentRevisionId
    ? state.revisions[operation.parentRevisionId]
    : null;
  return {
    fileExists: Boolean(file),
    currentHeads: file ? [...file.heads] : [],
    parent: parent ? {
      revisionId: parent.id,
      path: parent.path,
      content: parent.content,
      deleted: parent.deleted,
    } : null,
  };
}

function operationTargetPath(state, operation) {
  if (operation.kind === 'create' || operation.kind === 'rename') return operation.path;
  const parent = state.revisions[operation.parentRevisionId];
  return parent ? parent.path : null;
}

function existingBlockers(state, operation) {
  const blockers = [];
  const file = state.files[operation.fileId];
  if (file && file.heads.length > 1) blockers.push('multiple-current-heads');

  const targetPath = operationTargetPath(state, operation);
  let targetKey = null;
  try {
    if (targetPath) targetKey = normalizedPathKey(targetPath);
  } catch (_error) {
    // The operation contract reports the invalid path precisely during simulation.
  }
  const relevantConflictIds = [];
  for (const conflict of state.conflicts) {
    if (conflict.status !== 'open') continue;
    let relevant = Array.isArray(conflict.fileIds) && conflict.fileIds.includes(operation.fileId);
    if (!relevant && targetKey && Array.isArray(conflict.revisionIds)) {
      relevant = conflict.revisionIds.some((revisionId) => {
        const revision = state.revisions[revisionId];
        return revision && !revision.deleted && revision.normalizedPath === targetKey;
      });
    }
    if (relevant) relevantConflictIds.push(conflict.id);
  }
  if (relevantConflictIds.length) blockers.push('unresolved-relevant-conflict');
  return { blockers, relevantConflictIds };
}

function planReconciliation(inputSnapshot, inputEvents) {
  const snapshot = cloneJson(inputSnapshot, 'snapshot');
  const events = cloneJson(inputEvents, 'events');
  validateSnapshot(snapshot);
  if (!Array.isArray(events)) throw new PlannerError('invalid-events', 'events must be an array');

  const basisFingerprint = snapshotFingerprint(snapshot);
  const plan = {
    schema: PLANNER_SCHEMA,
    planId: `plan-${digest(stableStringify({ basisFingerprint, events })).slice(0, 32)}`,
    basis: { graphId: snapshot.graphId, snapshotFingerprint: basisFingerprint },
    actions: [],
    conflicts: [],
    duplicates: [],
    invalid: [],
  };
  const seenOperations = new Map();
  let projected = snapshot;

  events.forEach((event, index) => {
    const translated = translateEvent(snapshot, event, index);
    if (translated.invalid) {
      plan.invalid.push(translated.invalid);
      return;
    }
    const { operation } = translated;
    const operationFingerprint = stableStringify(operation);
    const firstSeen = seenOperations.get(operation.operationId);
    if (firstSeen) {
      if (firstSeen.fingerprint === operationFingerprint) {
        plan.duplicates.push({
          index,
          event: cloneJson(event, 'event'),
          operationId: operation.operationId,
          duplicateOfIndex: firstSeen.index,
          reason: 'exact-event-retry',
        });
      } else {
        plan.invalid.push(invalidEvent(
          event,
          index,
          'operation-id-reuse',
          'event ID maps to an operation ID already used with different contents',
        ));
      }
      return;
    }
    seenOperations.set(operation.operationId, { fingerprint: operationFingerprint, index });

    const expected = expectedPrior(projected, operation);
    const existing = existingBlockers(projected, operation);
    let transition;
    try {
      transition = applyOperation(projected, operation);
    } catch (error) {
      const code = error instanceof SyncPrototypeError ? error.code : 'planning-failed';
      plan.invalid.push(invalidEvent(event, index, code, error.message));
      return;
    }

    if (!transition.changed) {
      plan.duplicates.push({
        index,
        event: cloneJson(event, 'event'),
        operationId: operation.operationId,
        duplicateOfIndex: null,
        reason: 'operation-already-present-in-snapshot',
      });
      return;
    }

    const introducedConflictIds = transition.result.conflictIds;
    if (existing.blockers.length || introducedConflictIds.length) {
      plan.conflicts.push({
        index,
        event: cloneJson(event, 'event'),
        operation,
        expected,
        reasons: [...existing.blockers,
          ...(introducedConflictIds.length ? ['operation-introduces-conflict'] : [])],
        existingConflictIds: existing.relevantConflictIds,
        introducedConflicts: introducedConflictIds.map((conflictId) =>
          cloneJson(transition.state.conflicts.find((item) => item.id === conflictId), 'conflict')),
      });
      return;
    }

    plan.actions.push({
      index,
      event: cloneJson(event, 'event'),
      operation,
      expected,
      reasons: [
        operation.kind === 'create' ? 'file-id-is-unused' : 'parent-is-current-head',
        'no-unresolved-relevant-conflict',
        'operation-contract-accepts',
      ],
    });
    projected = transition.state;
  });

  plan.projectedSnapshotFingerprint = snapshotFingerprint(projected);
  return plan;
}

function checkPlanPrecondition(plan, destinationSnapshot) {
  const destination = cloneJson(destinationSnapshot, 'destination snapshot');
  validateSnapshot(destination);
  if (!plan || !plan.basis || typeof plan.basis.snapshotFingerprint !== 'string') {
    throw new PlannerError('invalid-plan', 'plan does not contain a snapshot precondition');
  }
  const actualFingerprint = snapshotFingerprint(destination);
  if (actualFingerprint !== plan.basis.snapshotFingerprint) {
    return {
      applicable: false,
      code: 'stale-plan',
      expectedSnapshotFingerprint: plan.basis.snapshotFingerprint,
      actualSnapshotFingerprint: actualFingerprint,
    };
  }
  return {
    applicable: true,
    code: 'snapshot-unchanged',
    expectedSnapshotFingerprint: plan.basis.snapshotFingerprint,
    actualSnapshotFingerprint: actualFingerprint,
  };
}

module.exports = {
  PLANNER_SCHEMA,
  PlannerError,
  checkPlanPrecondition,
  operationIdForEvent,
  planReconciliation,
  snapshotFingerprint,
};
