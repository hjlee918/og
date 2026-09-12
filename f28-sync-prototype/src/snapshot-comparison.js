'use strict';

const crypto = require('node:crypto');
const { normalizedPathKey, stableStringify } = require('./core');
const { planReconciliation, snapshotFingerprint } = require('./planner');

const COMPARISON_SCHEMA = 'f28-snapshot-comparison/1';
const TARGET_SCHEMA = 'f28-synthetic-target/1';

function clone(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined');
    return JSON.parse(encoded);
  } catch (_error) {
    throw new Error(`${label} must be JSON serializable`);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function byUtf8(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function selectedHeads(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || typeof state.graphId !== 'string' || !state.files || !state.revisions
      || !state.operations || !Array.isArray(state.conflicts)) {
    throw new Error('selected snapshot has an invalid state');
  }
  const result = new Map();
  for (const fileId of Object.keys(state.files).sort(byUtf8)) {
    const file = state.files[fileId];
    if (!file || !Array.isArray(file.heads) || file.heads.length === 0) {
      throw new Error('selected snapshot has invalid file heads');
    }
    const heads = file.heads.map((id) => state.revisions[id]);
    if (heads.some((revision) => !revision || revision.fileId !== fileId)) {
      throw new Error('selected snapshot references an invalid revision');
    }
    result.set(fileId, heads);
  }
  return result;
}

function validateSelected(selected) {
  if (!selected || selected.schema !== 'f28-selected-snapshot/1'
      || !/^[0-9a-f]{64}$/.test(selected.generation || '')
      || !Array.isArray(selected.files)) {
    throw new Error('selected snapshot envelope is invalid');
  }
  const actual = snapshotFingerprint(selected.state);
  if (selected.snapshotFingerprint !== actual) {
    throw new Error('selected snapshot fingerprint mismatch');
  }
  const heads = selectedHeads(selected.state);
  const materialized = [];
  for (const entries of heads.values()) {
    if (entries.length !== 1) continue;
    const revision = entries[0];
    if (!revision.deleted) materialized.push({ path: revision.path, content: revision.content });
  }
  materialized.sort((a, b) => byUtf8(a.path, b.path));
  if (stableStringify(materialized) !== stableStringify(selected.files)) {
    throw new Error('selected snapshot file envelope mismatch');
  }
  return heads;
}

function invalid(index, item, code, reason) {
  return { index, item: clone(item, 'target item'), code, reason };
}

function compareSnapshots(inputSelected, inputTarget) {
  const selected = clone(inputSelected, 'selected snapshot');
  const target = clone(inputTarget, 'target snapshot');
  const heads = validateSelected(selected);
  if (!target || target.schema !== TARGET_SCHEMA || !Array.isArray(target.files)
      || typeof target.complete !== 'boolean'
      || typeof target.authorizeMissingDeletes !== 'boolean') {
    throw new Error('target snapshot envelope is invalid');
  }

  const result = {
    schema: COMPARISON_SCHEMA,
    basis: {
      generation: selected.generation,
      snapshotFingerprint: selected.snapshotFingerprint,
    },
    unchanged: [],
    unknown: [],
    proposedEvents: [],
    conflicts: [],
    invalid: [],
    plan: null,
  };
  const groups = new Map();
  target.files.forEach((item, index) => {
    const key = item && typeof item.fileId === 'string' ? item.fileId : null;
    if (!key) {
      result.invalid.push(invalid(index, item, 'invalid-file-id', 'fileId must be a non-empty string'));
      return;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index });
  });

  const usable = new Map();
  for (const [fileId, entries] of [...groups].sort(([a], [b]) => byUtf8(a, b))) {
    if (entries.length !== 1) {
      for (const entry of entries) {
        result.invalid.push(invalid(entry.index, entry.item, 'duplicate-file-id', 'target file ID is ambiguous'));
      }
      continue;
    }
    const { item, index } = entries[0];
    const keys = Object.keys(item).sort();
    if (item.deleted === true) {
      if (keys.some((key) => !['deleted', 'fileId'].includes(key))) {
        result.invalid.push(invalid(index, item, 'invalid-tombstone', 'tombstone may contain only fileId and deleted'));
        continue;
      }
    } else if (item.deleted !== undefined
        || typeof item.path !== 'string' || typeof item.content !== 'string'
        || keys.some((key) => !['content', 'fileId', 'path'].includes(key))) {
      result.invalid.push(invalid(index, item, 'invalid-file', 'live file requires only fileId, path and content'));
      continue;
    }
    usable.set(fileId, { item, index });
  }

  const pathGroups = new Map();
  for (const [fileId, entry] of usable) {
    if (entry.item.deleted) continue;
    try {
      const key = normalizedPathKey(entry.item.path);
      if (!pathGroups.has(key)) pathGroups.set(key, []);
      pathGroups.get(key).push(fileId);
    } catch (error) {
      result.invalid.push(invalid(entry.index, entry.item, 'invalid-path', error.message));
      usable.delete(fileId);
    }
  }
  const colliding = new Set();
  for (const [normalizedPath, fileIds] of pathGroups) {
    if (fileIds.length < 2) continue;
    fileIds.forEach((id) => colliding.add(id));
    result.conflicts.push({
      code: 'normalized-path-collision', normalizedPath,
      fileIds: [...fileIds].sort(byUtf8), reason: 'multiple target identities name the same normalized path',
    });
  }

  const seed = stableStringify({ basis: result.basis, target });
  const makeEvent = (kind, fileId, values) => {
    const identity = digest(stableStringify({ seed, kind, fileId, values }));
    return {
      eventId: `compare-event-${identity.slice(0, 32)}`,
      kind,
      fileId,
      revisionId: `compare-revision-${identity.slice(0, 32)}`,
      ...values,
    };
  };
  const seenTarget = new Set();
  for (const [fileId, entry] of [...usable].sort(([a], [b]) => byUtf8(a, b))) {
    seenTarget.add(fileId);
    if (colliding.has(fileId)) continue;
    const revisions = heads.get(fileId);
    if (revisions && revisions.length !== 1) {
      result.conflicts.push({
        code: 'ambiguous-selected-identity', fileId,
        revisionIds: revisions.map((revision) => revision.id),
        reason: 'selected file has multiple unresolved heads',
      });
      continue;
    }
    const current = revisions && revisions[0];
    if (entry.item.deleted) {
      if (!current) {
        result.invalid.push(invalid(entry.index, entry.item, 'unknown-tombstone', 'explicit tombstone names an unknown file ID'));
      } else if (current.deleted) {
        result.unchanged.push({ fileId, reason: 'already-deleted' });
      } else {
        result.proposedEvents.push(makeEvent('delete', fileId, { parentRevisionId: current.id }));
      }
      continue;
    }
    if (!current) {
      result.proposedEvents.push(makeEvent('create', fileId, {
        parentRevisionId: null, path: entry.item.path, content: entry.item.content,
      }));
      continue;
    }
    if (current.deleted) {
      result.invalid.push(invalid(entry.index, entry.item, 'restore-not-supported', 'a live target cannot implicitly restore a tombstoned file'));
      continue;
    }
    const pathChanged = current.path !== entry.item.path;
    const contentChanged = current.content !== entry.item.content;
    if (pathChanged && contentChanged) {
      result.invalid.push(invalid(entry.index, entry.item, 'combined-change-not-supported', 'rename and update must be separate explicit events'));
    } else if (pathChanged) {
      result.proposedEvents.push(makeEvent('rename', fileId, {
        parentRevisionId: current.id, path: entry.item.path,
      }));
    } else if (contentChanged) {
      result.proposedEvents.push(makeEvent('update', fileId, {
        parentRevisionId: current.id, content: entry.item.content,
      }));
    } else {
      result.unchanged.push({ fileId, path: current.path, reason: 'path-and-content-match' });
    }
  }

  for (const [fileId, revisions] of [...heads].sort(([a], [b]) => byUtf8(a, b))) {
    if (seenTarget.has(fileId) || revisions.length !== 1 || revisions[0].deleted) continue;
    if (target.complete && target.authorizeMissingDeletes) {
      result.proposedEvents.push(makeEvent('delete', fileId, { parentRevisionId: revisions[0].id }));
    } else {
      result.unknown.push({ fileId, path: revisions[0].path, reason: 'absence-does-not-imply-delete' });
    }
  }
  result.proposedEvents.sort((a, b) => byUtf8(a.fileId, b.fileId));
  result.unchanged.sort((a, b) => byUtf8(a.fileId, b.fileId));
  result.unknown.sort((a, b) => byUtf8(a.fileId, b.fileId));
  result.conflicts.sort((a, b) => byUtf8(a.fileId || a.fileIds.join('\0'), b.fileId || b.fileIds.join('\0')));
  result.invalid.sort((a, b) => a.index - b.index);
  const preliminaryPlan = planReconciliation(selected.state, result.proposedEvents);
  const blockedEventIds = new Set();
  for (const conflict of preliminaryPlan.conflicts) {
    blockedEventIds.add(conflict.event.eventId);
    result.conflicts.push({
      code: 'planner-conflict', fileId: conflict.event.fileId,
      eventId: conflict.event.eventId, reasons: conflict.reasons,
      reason: 'existing planner preconditions refuse this proposed event',
    });
  }
  for (const item of preliminaryPlan.invalid) {
    blockedEventIds.add(item.event.eventId);
    result.invalid.push({
      index: item.index, item: item.event, code: item.code,
      reason: `existing planner refused proposed event: ${item.reason}`,
    });
  }
  if (blockedEventIds.size) {
    result.proposedEvents = result.proposedEvents.filter((event) => !blockedEventIds.has(event.eventId));
    result.conflicts.sort((a, b) => byUtf8(a.fileId || a.fileIds.join('\0'), b.fileId || b.fileIds.join('\0')));
    result.invalid.sort((a, b) => a.index - b.index);
  }
  result.plan = planReconciliation(selected.state, result.proposedEvents);
  return result;
}

module.exports = { COMPARISON_SCHEMA, TARGET_SCHEMA, compareSnapshots };
