'use strict';

const crypto = require('node:crypto');
const {
  normalizedPathKey,
  stableStringify,
  validateRelativePath,
} = require('./core');
const { executePlan } = require('./executor');
const { planReconciliation, snapshotFingerprint } = require('./planner');
const { compareSnapshots, TARGET_SCHEMA } = require('./snapshot-comparison');

const IDENTITY_SCHEMA = 'f28-file-identities/1';
const ENROLLMENT_SCHEMA = 'f28-identity-enrollment/1';
const REPLICA_SCHEMA = 'f28-identity-replica/1';
const CAPTURE_BATCH_SCHEMA = 'f28-capture-batch/1';
const CAPTURE_RESULT_SCHEMA = 'f28-capture-result/1';

class IdentityCaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityCaptureError';
    this.code = code;
  }
}

function clone(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined');
    return JSON.parse(encoded);
  } catch (_error) {
    throw new IdentityCaptureError('invalid-input', `${label} must be JSON serializable`);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function contentHash(content) {
  return `sha256:${digest(content)}`;
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new IdentityCaptureError('invalid-identity', `${label} must be a non-empty string without NUL`);
  }
  return value;
}

function byUtf8(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new IdentityCaptureError('unexpected-field', `${label} has unexpected field ${unexpected[0]}`);
  }
}

function liveHeads(state) {
  const result = new Map();
  for (const fileId of Object.keys(state.files || {}).sort(byUtf8)) {
    const file = state.files[fileId];
    if (!file || !Array.isArray(file.heads) || file.heads.length !== 1) {
      throw new IdentityCaptureError('ambiguous-snapshot', `file ${fileId} must have exactly one head`);
    }
    const revision = state.revisions && state.revisions[file.heads[0]];
    if (!revision || revision.fileId !== fileId) {
      throw new IdentityCaptureError('invalid-snapshot', `file ${fileId} has an invalid head`);
    }
    result.set(fileId, revision);
  }
  return result;
}

function validateSelectedSnapshot(inputSelected) {
  const selected = clone(inputSelected, 'accepted snapshot');
  if (!selected || selected.schema !== 'f28-selected-snapshot/1'
      || !/^[0-9a-f]{64}$/.test(selected.generation || '')
      || !selected.state || !Array.isArray(selected.files)) {
    throw new IdentityCaptureError('invalid-snapshot', 'accepted snapshot envelope is invalid');
  }
  const actualFingerprint = snapshotFingerprint(selected.state);
  if (selected.snapshotFingerprint !== actualFingerprint) {
    throw new IdentityCaptureError('snapshot-mismatch', 'accepted snapshot fingerprint mismatch');
  }
  const heads = liveHeads(selected.state);
  const materialized = [];
  for (const revision of heads.values()) {
    if (!revision.deleted) materialized.push({ path: revision.path, content: revision.content });
  }
  materialized.sort((a, b) => byUtf8(a.path, b.path));
  if (stableStringify(materialized) !== stableStringify(selected.files)) {
    throw new IdentityCaptureError('snapshot-mismatch', 'accepted snapshot files do not match state');
  }
  return { selected, heads };
}

function validateMetadata(inputMetadata, inputSelected) {
  const metadata = clone(inputMetadata, 'identity metadata');
  const { selected, heads } = validateSelectedSnapshot(inputSelected);
  if (!metadata || metadata.schema !== IDENTITY_SCHEMA
      || typeof metadata.files !== 'object' || metadata.files === null || Array.isArray(metadata.files)
      || typeof metadata.tombstones !== 'object' || metadata.tombstones === null
      || Array.isArray(metadata.tombstones)) {
    throw new IdentityCaptureError('invalid-metadata', 'identity metadata envelope is invalid');
  }
  exactKeys(metadata, ['schema', 'graphId', 'metadataRevision', 'files', 'tombstones'], 'identity metadata');
  requireId(metadata.graphId, 'graphId');
  requireId(metadata.metadataRevision, 'metadataRevision');
  if (metadata.graphId !== selected.state.graphId) {
    throw new IdentityCaptureError('graph-mismatch', 'metadata and accepted snapshot graph IDs differ');
  }
  const represented = new Set();
  const pathOwners = new Map();
  for (const fileId of Object.keys(metadata.files).sort(byUtf8)) {
    requireId(fileId, 'fileId');
    const entry = metadata.files[fileId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IdentityCaptureError('invalid-metadata', `live identity ${fileId} is invalid`);
    }
    exactKeys(entry, ['path', 'normalizedPath', 'acceptedRevision', 'acceptedContentHash', 'status'], `identity ${fileId}`);
    if (entry.status !== 'live') throw new IdentityCaptureError('invalid-metadata', `identity ${fileId} is not live`);
    validateRelativePath(entry.path);
    const normalized = normalizedPathKey(entry.path);
    if (entry.normalizedPath !== normalized) {
      throw new IdentityCaptureError('metadata-path-mismatch', `identity ${fileId} has a stale normalized path`);
    }
    if (pathOwners.has(normalized)) {
      throw new IdentityCaptureError('normalized-path-collision', `identity paths collide: ${pathOwners.get(normalized)} and ${fileId}`);
    }
    pathOwners.set(normalized, fileId);
    requireId(entry.acceptedRevision, 'acceptedRevision');
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.acceptedContentHash || '')) {
      throw new IdentityCaptureError('invalid-metadata', `identity ${fileId} has an invalid content hash`);
    }
    const revision = heads.get(fileId);
    if (!revision || revision.deleted || revision.id !== entry.acceptedRevision
        || revision.path !== entry.path || contentHash(revision.content) !== entry.acceptedContentHash) {
      throw new IdentityCaptureError('metadata-snapshot-mismatch', `identity ${fileId} does not match the accepted snapshot`);
    }
    represented.add(fileId);
  }
  for (const fileId of Object.keys(metadata.tombstones).sort(byUtf8)) {
    requireId(fileId, 'fileId');
    if (represented.has(fileId)) throw new IdentityCaptureError('duplicate-file-id', `identity ${fileId} is both live and deleted`);
    const entry = metadata.tombstones[fileId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IdentityCaptureError('invalid-metadata', `tombstone ${fileId} is invalid`);
    }
    exactKeys(entry, ['lastPath', 'acceptedRevision'], `tombstone ${fileId}`);
    validateRelativePath(entry.lastPath);
    requireId(entry.acceptedRevision, 'acceptedRevision');
    const revision = heads.get(fileId);
    if (!revision || !revision.deleted || revision.id !== entry.acceptedRevision
        || revision.path !== entry.lastPath) {
      throw new IdentityCaptureError('metadata-snapshot-mismatch', `tombstone ${fileId} does not match the accepted snapshot`);
    }
    represented.add(fileId);
  }
  if (represented.size !== heads.size || [...heads.keys()].some((fileId) => !represented.has(fileId))) {
    throw new IdentityCaptureError('metadata-snapshot-mismatch', 'metadata is not a complete identity map for the accepted snapshot');
  }
  return { metadata, selected, heads };
}

function validateEnrollmentFile(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new IdentityCaptureError('invalid-enrollment', `enrollment file ${index} is invalid`);
  }
  exactKeys(item, ['fileId', 'path', 'content', 'acceptedRevision'], `enrollment file ${index}`);
  requireId(item.fileId, 'fileId');
  requireId(item.acceptedRevision, 'acceptedRevision');
  validateRelativePath(item.path);
  if (!/\.(md|markdown|org)$/i.test(item.path)) {
    throw new IdentityCaptureError('unsupported-file', `enrollment file ${index} is not Markdown or Org`);
  }
  if (typeof item.content !== 'string') {
    throw new IdentityCaptureError('invalid-enrollment', `enrollment file ${index} content must be a string`);
  }
}

function enrollIdentityMetadata(inputRequest, inputSelected) {
  const request = clone(inputRequest, 'enrollment request');
  const { selected, heads } = validateSelectedSnapshot(inputSelected);
  if (!request || request.schema !== ENROLLMENT_SCHEMA || request.complete !== true
      || !Array.isArray(request.files)) {
    throw new IdentityCaptureError('invalid-enrollment', 'enrollment must be an explicit complete file list');
  }
  exactKeys(request, ['schema', 'complete', 'graphId', 'replicaId', 'metadataRevision', 'files'], 'enrollment request');
  requireId(request.graphId, 'graphId');
  requireId(request.replicaId, 'replicaId');
  requireId(request.metadataRevision, 'metadataRevision');
  if (request.graphId !== selected.state.graphId) {
    throw new IdentityCaptureError('graph-mismatch', 'enrollment graph ID differs from accepted snapshot');
  }
  const ids = new Set();
  const paths = new Map();
  const files = {};
  for (const [index, item] of request.files.entries()) {
    validateEnrollmentFile(item, index);
    if (ids.has(item.fileId)) throw new IdentityCaptureError('duplicate-file-id', `duplicate file ID ${item.fileId}`);
    ids.add(item.fileId);
    const normalized = normalizedPathKey(item.path);
    if (paths.has(normalized)) {
      throw new IdentityCaptureError('normalized-path-collision', `enrollment paths collide: ${paths.get(normalized)} and ${item.fileId}`);
    }
    paths.set(normalized, item.fileId);
    const revision = heads.get(item.fileId);
    if (!revision || revision.deleted || revision.id !== item.acceptedRevision
        || revision.path !== item.path || revision.content !== item.content) {
      throw new IdentityCaptureError('enrollment-snapshot-mismatch', `enrollment file ${item.fileId} does not match the accepted snapshot`);
    }
    files[item.fileId] = {
      path: item.path,
      normalizedPath: normalized,
      acceptedRevision: item.acceptedRevision,
      acceptedContentHash: contentHash(item.content),
      status: 'live',
    };
  }
  if (ids.size !== heads.size || [...heads.keys()].some((fileId) => !ids.has(fileId))) {
    throw new IdentityCaptureError('incomplete-enrollment', 'enrollment list must identify every accepted file');
  }
  const metadata = {
    schema: IDENTITY_SCHEMA,
    graphId: request.graphId,
    metadataRevision: request.metadataRevision,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => byUtf8(a, b))),
    tombstones: {},
  };
  return {
    metadata,
    replica: initializeReplica(metadata, request.replicaId, selected),
  };
}

function initializeReplica(inputMetadata, replicaId, inputSelected) {
  const { metadata, selected } = validateMetadata(inputMetadata, inputSelected);
  requireId(replicaId, 'replicaId');
  return {
    schema: REPLICA_SCHEMA,
    graphId: metadata.graphId,
    replicaId,
    metadataRevision: metadata.metadataRevision,
    acceptedSnapshotFingerprint: selected.snapshotFingerprint,
    pendingObservations: [],
  };
}

function validateReplica(inputReplica, metadata, selected) {
  const replica = clone(inputReplica, 'replica state');
  if (!replica || replica.schema !== REPLICA_SCHEMA || !Array.isArray(replica.pendingObservations)) {
    throw new IdentityCaptureError('invalid-replica', 'replica state is invalid');
  }
  exactKeys(replica, ['schema', 'graphId', 'replicaId', 'metadataRevision', 'acceptedSnapshotFingerprint', 'pendingObservations'], 'replica state');
  requireId(replica.replicaId, 'replicaId');
  if (replica.graphId !== metadata.graphId) throw new IdentityCaptureError('graph-mismatch', 'replica graph ID differs');
  if (replica.metadataRevision !== metadata.metadataRevision) {
    throw new IdentityCaptureError('stale-metadata-revision', 'replica metadata revision is stale');
  }
  if (replica.acceptedSnapshotFingerprint !== selected.snapshotFingerprint) {
    throw new IdentityCaptureError('accepted-snapshot-mismatch', 'replica accepted snapshot is stale');
  }
  return replica;
}

function observationFingerprint(observation) {
  return stableStringify(observation);
}

function validateObservation(input, index) {
  const item = clone(input, `observation ${index}`);
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new IdentityCaptureError('invalid-observation', `observation ${index} must be an object`);
  }
  requireId(item.observationId, 'observationId');
  const common = ['observationId', 'type'];
  switch (item.type) {
    case 'save-complete':
      exactKeys(item, [...common, 'saveId', 'fileId', 'path', 'content', 'parentRevisionId', 'revisionId'], `observation ${index}`);
      ['saveId', 'fileId', 'parentRevisionId', 'revisionId'].forEach((key) => requireId(item[key], key));
      validateRelativePath(item.path);
      if (typeof item.content !== 'string') throw new IdentityCaptureError('invalid-observation', 'save content must be a string');
      break;
    case 'rename-intent':
      exactKeys(item, [...common, 'renameId', 'fileId', 'oldPath', 'newPath', 'parentRevisionId', 'revisionId'], `observation ${index}`);
      ['renameId', 'fileId', 'parentRevisionId', 'revisionId'].forEach((key) => requireId(item[key], key));
      validateRelativePath(item.oldPath); validateRelativePath(item.newPath);
      break;
    case 'rename-complete':
      exactKeys(item, [...common, 'renameId', 'succeeded'], `observation ${index}`);
      requireId(item.renameId, 'renameId');
      if (typeof item.succeeded !== 'boolean') throw new IdentityCaptureError('invalid-observation', 'rename completion must be boolean');
      break;
    case 'stable-read':
      exactKeys(item, [...common, 'causeType', 'causeId', 'path', 'content', 'stable', 'oldPathAbsent'], `observation ${index}`);
      if (!['save', 'rename'].includes(item.causeType)) throw new IdentityCaptureError('invalid-observation', 'stable read cause is invalid');
      requireId(item.causeId, 'causeId'); validateRelativePath(item.path);
      if (typeof item.content !== 'string' || item.stable !== true) {
        throw new IdentityCaptureError('invalid-observation', 'stable read requires synthetic stable=true and string content');
      }
      if (item.causeType === 'rename' && item.oldPathAbsent !== true) {
        throw new IdentityCaptureError('invalid-observation', 'rename stable read must assert oldPathAbsent=true');
      }
      if (item.causeType === 'save' && item.oldPathAbsent !== undefined) {
        throw new IdentityCaptureError('invalid-observation', 'save stable read cannot assert old path absence');
      }
      break;
    case 'external-add':
    case 'external-change':
      exactKeys(item, [...common, 'fileId', 'path', 'content', 'stable', 'parentRevisionId', 'revisionId'], `observation ${index}`);
      validateRelativePath(item.path);
      if (typeof item.content !== 'string' || typeof item.stable !== 'boolean') {
        throw new IdentityCaptureError('invalid-observation', 'external file observation requires content and stable boolean');
      }
      if (item.fileId !== undefined) requireId(item.fileId, 'fileId');
      if (item.parentRevisionId !== undefined) requireId(item.parentRevisionId, 'parentRevisionId');
      if (item.revisionId !== undefined) requireId(item.revisionId, 'revisionId');
      break;
    case 'external-unlink':
      exactKeys(item, [...common, 'fileId', 'path'], `observation ${index}`);
      validateRelativePath(item.path);
      if (item.fileId !== undefined) requireId(item.fileId, 'fileId');
      break;
    case 'read-failed':
    case 'unstable-read':
      exactKeys(item, [...common, 'path', 'reason', 'causeType', 'causeId'], `observation ${index}`);
      validateRelativePath(item.path);
      if (typeof item.reason !== 'string' || item.reason.length === 0) throw new IdentityCaptureError('invalid-observation', 'failed read needs a reason');
      if (item.causeType !== undefined && !['save', 'rename', 'external'].includes(item.causeType)) {
        throw new IdentityCaptureError('invalid-observation', 'failed read cause is invalid');
      }
      if (item.causeId !== undefined) requireId(item.causeId, 'causeId');
      break;
    default:
      throw new IdentityCaptureError('invalid-observation', `unsupported observation type ${item.type}`);
  }
  return item;
}

function pendingItem(code, observations, details = {}) {
  const canonical = observations.map((item) => clone(item, 'pending observation'))
    .sort((a, b) => byUtf8(a.observationId, b.observationId));
  return {
    pendingId: `pending-${digest(stableStringify({ code, observations: canonical })).slice(0, 32)}`,
    code,
    observationIds: canonical.map((item) => item.observationId),
    observations: canonical,
    ...details,
  };
}

function eventFrom(kind, graphId, source, values) {
  const token = digest(stableStringify({ graphId, kind, source, values })).slice(0, 32);
  return { eventId: `capture-event-${token}`, kind, ...values };
}

function uniquePayloads(items, selector) {
  const groups = new Map();
  for (const item of items) {
    const key = stableStringify(selector(item));
    if (!groups.has(key)) groups.set(key, item);
  }
  return [...groups.values()];
}

function classifyCausalGroups(observations, metadata) {
  const consumed = new Set();
  const captured = [];
  const pending = [];
  const invalid = [];
  const saveIds = new Set(observations.filter((o) => o.type === 'save-complete').map((o) => o.saveId));
  observations.filter((o) => o.type === 'stable-read' && o.causeType === 'save').forEach((o) => saveIds.add(o.causeId));
  for (const saveId of [...saveIds].sort(byUtf8)) {
    const completes = observations.filter((o) => o.type === 'save-complete' && o.saveId === saveId);
    const reads = observations.filter((o) => o.type === 'stable-read' && o.causeType === 'save' && o.causeId === saveId);
    [...completes, ...reads].forEach((o) => consumed.add(o.observationId));
    const uniqueCompletes = uniquePayloads(completes, (o) => ({ fileId: o.fileId, path: o.path, content: o.content, parentRevisionId: o.parentRevisionId, revisionId: o.revisionId }));
    const uniqueReads = uniquePayloads(reads, (o) => ({ path: o.path, content: o.content }));
    if (uniqueCompletes.length > 1 || uniqueReads.length > 1) {
      const item = pendingItem('contradictory-save-evidence', [...completes, ...reads], { saveId });
      pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'save evidence disagrees' });
      continue;
    }
    if (!uniqueCompletes.length || !uniqueReads.length) {
      pending.push(pendingItem('save-awaiting-matching-stable-read', [...completes, ...reads], { saveId }));
      continue;
    }
    const complete = uniqueCompletes[0], read = uniqueReads[0];
    const identity = metadata.files[complete.fileId];
    if (!identity || identity.path !== complete.path || identity.acceptedRevision !== complete.parentRevisionId
        || read.path !== complete.path || read.content !== complete.content) {
      const item = pendingItem('save-evidence-mismatch', [...completes, ...reads], { saveId, fileId: complete.fileId });
      pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'save completion and stable observation do not match accepted identity' });
      continue;
    }
    captured.push(eventFrom('update', metadata.graphId, { type: 'save', saveId }, {
      fileId: complete.fileId, revisionId: complete.revisionId,
      parentRevisionId: complete.parentRevisionId, content: complete.content,
    }));
  }

  const renameIds = new Set(observations.filter((o) => ['rename-intent', 'rename-complete'].includes(o.type)).map((o) => o.renameId));
  observations.filter((o) => o.type === 'stable-read' && o.causeType === 'rename').forEach((o) => renameIds.add(o.causeId));
  for (const renameId of [...renameIds].sort(byUtf8)) {
    const intents = observations.filter((o) => o.type === 'rename-intent' && o.renameId === renameId);
    const completions = observations.filter((o) => o.type === 'rename-complete' && o.renameId === renameId);
    const reads = observations.filter((o) => o.type === 'stable-read' && o.causeType === 'rename' && o.causeId === renameId);
    [...intents, ...completions, ...reads].forEach((o) => consumed.add(o.observationId));
    const uniqueIntents = uniquePayloads(intents, (o) => ({ fileId: o.fileId, oldPath: o.oldPath, newPath: o.newPath, parentRevisionId: o.parentRevisionId, revisionId: o.revisionId }));
    const uniqueCompletions = uniquePayloads(completions, (o) => ({ succeeded: o.succeeded }));
    const uniqueReads = uniquePayloads(reads, (o) => ({ path: o.path, content: o.content, oldPathAbsent: o.oldPathAbsent }));
    if (uniqueIntents.length > 1 || uniqueCompletions.length > 1 || uniqueReads.length > 1) {
      const item = pendingItem('contradictory-rename-evidence', [...intents, ...completions, ...reads], { renameId });
      pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'rename evidence disagrees' });
      continue;
    }
    if (!uniqueIntents.length || !uniqueCompletions.length || !uniqueReads.length) {
      pending.push(pendingItem('rename-awaiting-completion-and-stable-read', [...intents, ...completions, ...reads], { renameId }));
      continue;
    }
    const intent = uniqueIntents[0], completion = uniqueCompletions[0], read = uniqueReads[0];
    const identity = metadata.files[intent.fileId];
    if (!completion.succeeded) {
      pending.push(pendingItem('rename-failed-requires-review', [...intents, ...completions, ...reads], { renameId, fileId: intent.fileId }));
      continue;
    }
    if (!identity || identity.path !== intent.oldPath || identity.acceptedRevision !== intent.parentRevisionId
        || read.path !== intent.newPath || read.content === undefined || read.oldPathAbsent !== true
        || contentHash(read.content) !== identity.acceptedContentHash) {
      const item = pendingItem('rename-evidence-mismatch', [...intents, ...completions, ...reads], { renameId, fileId: intent.fileId });
      pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'rename completion does not match accepted identity and stable observation' });
      continue;
    }
    captured.push(eventFrom('rename', metadata.graphId, { type: 'rename', renameId }, {
      fileId: intent.fileId, revisionId: intent.revisionId,
      parentRevisionId: intent.parentRevisionId, path: intent.newPath,
    }));
  }
  return { consumed, captured, pending, invalid };
}

function findIdentityAtPath(metadata, path) {
  return Object.entries(metadata.files).find(([, entry]) => entry.path === path);
}

function classifyExternal(observations, metadata, consumed) {
  const captured = [], pending = [], invalid = [];
  for (const observation of observations) {
    if (consumed.has(observation.observationId)) continue;
    if (['read-failed', 'unstable-read'].includes(observation.type)) {
      pending.push(pendingItem(observation.type, [observation], { path: observation.path }));
      continue;
    }
    if (observation.type === 'stable-read') {
      pending.push(pendingItem('stable-read-without-matching-completion', [observation], { path: observation.path }));
      continue;
    }
    if (observation.type === 'external-unlink') {
      const found = findIdentityAtPath(metadata, observation.path);
      if (observation.fileId && (!found || found[0] !== observation.fileId)) {
        const item = pendingItem('external-identity-mismatch', [observation], { path: observation.path });
        pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'external unlink identity does not match metadata path' });
      } else {
        pending.push(pendingItem('external-unlink-requires-review', [observation], {
          path: observation.path, fileId: found && found[0],
        }));
      }
      continue;
    }
    if (['external-add', 'external-change'].includes(observation.type)) {
      if (!observation.stable) {
        pending.push(pendingItem('external-read-not-stable', [observation], { path: observation.path }));
        continue;
      }
      const found = findIdentityAtPath(metadata, observation.path);
      if (observation.type === 'external-add' && !found) {
        pending.push(pendingItem('external-add-requires-review', [observation], { path: observation.path }));
        continue;
      }
      if (!found || !observation.fileId || found[0] !== observation.fileId) {
        const item = pendingItem('external-identity-mismatch', [observation], { path: observation.path });
        pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'external change identity does not match metadata path' });
        continue;
      }
      const identity = found[1];
      if (observation.parentRevisionId !== identity.acceptedRevision || !observation.revisionId) {
        const item = pendingItem('external-parent-mismatch', [observation], { path: observation.path, fileId: found[0] });
        pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'external change lacks the accepted parent and explicit revision' });
        continue;
      }
      if (contentHash(observation.content) === identity.acceptedContentHash) continue;
      captured.push(eventFrom('update', metadata.graphId, { type: observation.type, observationId: observation.observationId }, {
        fileId: found[0], revisionId: observation.revisionId,
        parentRevisionId: observation.parentRevisionId, content: observation.content,
      }));
      continue;
    }
    const item = pendingItem('unclassified-observation', [observation]);
    pending.push(item); invalid.push({ code: item.code, pendingId: item.pendingId, reason: 'observation could not be classified' });
  }
  return { captured, pending, invalid };
}

function validateReviewDecision(input, index, metadataRevision) {
  const decision = clone(input, `review decision ${index}`);
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new IdentityCaptureError('invalid-review-decision', `review decision ${index} is invalid`);
  }
  exactKeys(decision, ['decisionId', 'pendingIds', 'metadataRevision', 'action', 'fileId', 'revisionId'], `review decision ${index}`);
  requireId(decision.decisionId, 'decisionId');
  if (!Array.isArray(decision.pendingIds) || decision.pendingIds.length === 0
      || decision.pendingIds.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(decision.pendingIds).size !== decision.pendingIds.length) {
    throw new IdentityCaptureError('invalid-review-decision', 'review decision must bind unique pending IDs');
  }
  if (decision.metadataRevision !== metadataRevision) {
    throw new IdentityCaptureError('stale-review-decision', 'review decision is bound to a different metadata revision');
  }
  if (!['ignore', 'create', 'delete', 'rename'].includes(decision.action)) {
    throw new IdentityCaptureError('invalid-review-decision', 'unsupported review action');
  }
  if (decision.action !== 'ignore') {
    requireId(decision.fileId, 'fileId'); requireId(decision.revisionId, 'revisionId');
  }
  return decision;
}

function applyReviewDecisions(inputDecisions, pending, metadata) {
  const decisions = inputDecisions.map((item, index) => validateReviewDecision(item, index, metadata.metadataRevision));
  const byId = new Map(pending.map((item) => [item.pendingId, item]));
  const consumed = new Set(), captured = [], invalid = [];
  const decisionIds = new Map();
  for (const decision of decisions.sort((a, b) => byUtf8(a.decisionId, b.decisionId))) {
    const fingerprint = stableStringify(decision);
    if (decisionIds.has(decision.decisionId)) {
      if (decisionIds.get(decision.decisionId) !== fingerprint) invalid.push({ code: 'review-decision-id-reuse', decisionId: decision.decisionId, reason: 'decision ID was reused with different content' });
      continue;
    }
    decisionIds.set(decision.decisionId, fingerprint);
    const items = decision.pendingIds.map((id) => byId.get(id));
    if (items.some((item) => !item) || decision.pendingIds.some((id) => consumed.has(id))) {
      invalid.push({ code: 'review-binding-mismatch', decisionId: decision.decisionId, reason: 'decision does not bind exactly current unconsumed pending items' });
      continue;
    }
    if (decision.action === 'ignore') {
      decision.pendingIds.forEach((id) => consumed.add(id));
      continue;
    }
    if (decision.action === 'delete') {
      if (items.length !== 1 || items[0].code !== 'external-unlink-requires-review'
          || items[0].fileId !== decision.fileId || !metadata.files[decision.fileId]) {
        invalid.push({ code: 'review-action-mismatch', decisionId: decision.decisionId, reason: 'delete decision does not match one known external unlink' });
        continue;
      }
      const identity = metadata.files[decision.fileId];
      captured.push(eventFrom('delete', metadata.graphId, { type: 'review', decision }, {
        fileId: decision.fileId, revisionId: decision.revisionId,
        parentRevisionId: identity.acceptedRevision,
      }));
    } else if (decision.action === 'create') {
      if (items.length !== 1 || items[0].code !== 'external-add-requires-review'
          || metadata.files[decision.fileId] || metadata.tombstones[decision.fileId]) {
        invalid.push({ code: 'review-action-mismatch', decisionId: decision.decisionId, reason: 'create decision does not match one external add and unused identity' });
        continue;
      }
      const observation = items[0].observations[0];
      captured.push(eventFrom('create', metadata.graphId, { type: 'review', decision }, {
        fileId: decision.fileId, revisionId: decision.revisionId,
        parentRevisionId: null, path: observation.path, content: observation.content,
      }));
    } else {
      const unlink = items.find((item) => item.code === 'external-unlink-requires-review');
      const add = items.find((item) => item.code === 'external-add-requires-review');
      if (items.length !== 2 || !unlink || !add || unlink.fileId !== decision.fileId
          || !metadata.files[decision.fileId]) {
        invalid.push({ code: 'review-action-mismatch', decisionId: decision.decisionId, reason: 'rename decision must bind one known unlink and one external add' });
        continue;
      }
      const identity = metadata.files[decision.fileId];
      const addObservation = add.observations[0];
      if (contentHash(addObservation.content) !== identity.acceptedContentHash) {
        invalid.push({ code: 'review-action-mismatch', decisionId: decision.decisionId, reason: 'reviewed rename cannot also change content' });
        continue;
      }
      captured.push(eventFrom('rename', metadata.graphId, { type: 'review', decision }, {
        fileId: decision.fileId, revisionId: decision.revisionId,
        parentRevisionId: identity.acceptedRevision, path: addObservation.path,
      }));
    }
    decision.pendingIds.forEach((id) => consumed.add(id));
  }
  return { captured, invalid, pending: pending.filter((item) => !consumed.has(item.pendingId)) };
}

function rejectContradictoryEvents(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.fileId)) groups.set(event.fileId, []);
    groups.get(event.fileId).push(event);
  }
  const accepted = [], invalid = [];
  for (const [fileId, entries] of [...groups].sort(([a], [b]) => byUtf8(a, b))) {
    const unique = uniquePayloads(entries, (event) => ({
      kind: event.kind, fileId: event.fileId, revisionId: event.revisionId,
      parentRevisionId: event.parentRevisionId, path: event.path, content: event.content,
    }));
    if (unique.length > 1) {
      invalid.push({ code: 'contradictory-file-evidence', fileId, eventIds: entries.map((e) => e.eventId).sort(byUtf8), reason: 'one capture batch proposes incompatible changes for the same file' });
    } else {
      accepted.push(entries.sort((a, b) => byUtf8(a.eventId, b.eventId))[0]);
    }
  }
  return { events: accepted.sort((a, b) => byUtf8(a.fileId, b.fileId)), invalid };
}

function targetFromState(state) {
  const files = [];
  const heads = liveHeads(state);
  for (const [fileId, revision] of heads) {
    if (revision.deleted) files.push({ fileId, deleted: true });
    else files.push({ fileId, path: revision.path, content: revision.content });
  }
  files.sort((a, b) => byUtf8(a.fileId, b.fileId));
  return { schema: TARGET_SCHEMA, complete: true, authorizeMissingDeletes: true, files };
}

function metadataFromState(state, metadataRevision) {
  const files = {}, tombstones = {};
  for (const [fileId, revision] of liveHeads(state)) {
    if (revision.deleted) {
      tombstones[fileId] = { lastPath: revision.path, acceptedRevision: revision.id };
    } else {
      files[fileId] = {
        path: revision.path, normalizedPath: normalizedPathKey(revision.path),
        acceptedRevision: revision.id, acceptedContentHash: contentHash(revision.content), status: 'live',
      };
    }
  }
  return {
    schema: IDENTITY_SCHEMA, graphId: state.graphId, metadataRevision,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => byUtf8(a, b))),
    tombstones: Object.fromEntries(Object.entries(tombstones).sort(([a], [b]) => byUtf8(a, b))),
  };
}

function captureChanges(input) {
  const request = clone(input, 'capture request');
  if (!request || request.schema !== CAPTURE_BATCH_SCHEMA || !Array.isArray(request.observations)
      || !Array.isArray(request.reviewDecisions)) {
    throw new IdentityCaptureError('invalid-capture-batch', 'capture request is invalid');
  }
  exactKeys(request, ['schema', 'metadata', 'replica', 'acceptedSnapshot', 'expectedMetadataRevision', 'proposedMetadataRevision', 'observations', 'reviewDecisions'], 'capture request');
  requireId(request.expectedMetadataRevision, 'expectedMetadataRevision');
  requireId(request.proposedMetadataRevision, 'proposedMetadataRevision');
  const { metadata, selected } = validateMetadata(request.metadata, request.acceptedSnapshot);
  const replica = validateReplica(request.replica, metadata, selected);
  if (request.expectedMetadataRevision !== metadata.metadataRevision) {
    throw new IdentityCaptureError('stale-metadata-revision', 'capture expected metadata revision is stale');
  }

  const invalid = [];
  const merged = new Map();
  const raw = [...replica.pendingObservations, ...request.observations];
  raw.forEach((inputObservation, index) => {
    try {
      const observation = validateObservation(inputObservation, index);
      const fingerprint = observationFingerprint(observation);
      const prior = merged.get(observation.observationId);
      if (prior && prior.fingerprint !== fingerprint) {
        invalid.push({
          code: 'observation-id-reuse', observationId: observation.observationId,
          observations: [clone(prior.observation, 'prior observation'), clone(observation, 'changed observation')],
          reason: 'observation ID was reused with different content',
        });
      } else if (!prior) {
        merged.set(observation.observationId, { observation, fingerprint });
      }
    } catch (error) {
      invalid.push({ code: error.code || 'invalid-observation', index, reason: error.message });
    }
  });
  const observations = [...merged.values()].map((entry) => entry.observation)
    .sort((a, b) => byUtf8(a.observationId, b.observationId));
  const causal = classifyCausalGroups(observations, metadata);
  const external = classifyExternal(observations, metadata, causal.consumed);
  let pending = [...causal.pending, ...external.pending]
    .sort((a, b) => byUtf8(a.pendingId, b.pendingId));
  invalid.push(...causal.invalid, ...external.invalid);
  let reviewed = { captured: [], invalid: [], pending };
  try {
    reviewed = applyReviewDecisions(request.reviewDecisions, pending, metadata);
  } catch (error) {
    invalid.push({ code: error.code || 'invalid-review-decision', reason: error.message });
  }
  pending = reviewed.pending;
  invalid.push(...reviewed.invalid);
  const deduped = rejectContradictoryEvents([...causal.captured, ...external.captured, ...reviewed.captured]);
  invalid.push(...deduped.invalid);
  const baseResult = {
    schema: CAPTURE_RESULT_SCHEMA,
    acceptedMetadata: metadata,
    proposedMetadata: null,
    capturedEvents: deduped.events,
    pendingObservations: pending.flatMap((item) => item.observations)
      .sort((a, b) => byUtf8(a.observationId, b.observationId)),
    reviewItems: pending,
    invalid: invalid.sort((a, b) => byUtf8(stableStringify(a), stableStringify(b))),
    eligibility: null,
    target: null,
    comparison: null,
    nextReplicaState: null,
  };
  let requiresAcknowledgement = false;
  const blocked = baseResult.pendingObservations.length > 0 || baseResult.invalid.length > 0;
  if (!blocked) {
    const plan = planReconciliation(selected.state, deduped.events);
    const execution = executePlan({
      sourceSnapshot: selected.state, events: deduped.events, plan,
      destinationSnapshot: selected.state,
    });
    if (plan.conflicts.length || plan.invalid.length
        || !['applied', 'already-applied'].includes(execution.status)) {
      baseResult.invalid.push({
        code: 'captured-events-not-applicable',
        reason: 'captured events do not form one applicable all-or-nothing batch',
      });
    } else {
      const candidateTarget = targetFromState(execution.state);
      const comparison = compareSnapshots(selected, candidateTarget);
      if (!comparison.eligibility.eligible || comparison.plan === null) {
        baseResult.invalid.push({ code: 'comparison-not-eligible', reason: 'captured target was refused by snapshot comparison' });
        baseResult.comparison = comparison;
      } else {
        // compareSnapshots owns the executable event and revision identities.
        // Re-execute that exact exposed plan and derive metadata from its state;
        // the earlier capture execution exists only to construct the target.
        const comparisonExecution = executePlan({
          sourceSnapshot: selected.state,
          events: comparison.proposedEvents,
          plan: comparison.plan,
          destinationSnapshot: selected.state,
        });
        if (!['applied', 'already-applied'].includes(comparisonExecution.status)) {
          baseResult.invalid.push({
            code: 'comparison-execution-mismatch',
            reason: 'the exact exposed comparison plan did not produce a projected state',
          });
        } else {
          requiresAcknowledgement = comparison.plan.actions.length > 0;
          if (requiresAcknowledgement
              && request.proposedMetadataRevision === metadata.metadataRevision) {
            baseResult.invalid.push({
              code: 'metadata-revision-not-advanced',
              reason: 'an executable identity change requires a new metadata revision',
            });
          } else {
            baseResult.target = candidateTarget;
            baseResult.comparison = comparison;
            baseResult.proposedMetadata = metadataFromState(
              comparisonExecution.state,
              requiresAcknowledgement
                ? request.proposedMetadataRevision
                : metadata.metadataRevision,
            );
          }
        }
      }
    }
  }
  const eligible = baseResult.invalid.length === 0 && baseResult.pendingObservations.length === 0
    && baseResult.target !== null && baseResult.comparison && baseResult.comparison.eligibility.eligible;
  baseResult.eligibility = eligible
    ? { eligible: true, code: 'capture-eligible' }
    : { eligible: false, code: 'capture-not-eligible', invalidCount: baseResult.invalid.length, pendingCount: baseResult.reviewItems.length };
  baseResult.nextReplicaState = {
    ...replica,
    // Capture eligibility is not application acknowledgement. Keep the source
    // evidence for every proposed graph change until a caller later
    // reinitializes from an actually accepted metadata/snapshot pair. A pure
    // no-op or ignore-only decision has nothing to acknowledge.
    pendingObservations: eligible && !requiresAcknowledgement ? [] : observations,
  };
  return baseResult;
}

module.exports = {
  CAPTURE_BATCH_SCHEMA,
  CAPTURE_RESULT_SCHEMA,
  ENROLLMENT_SCHEMA,
  IDENTITY_SCHEMA,
  REPLICA_SCHEMA,
  IdentityCaptureError,
  captureChanges,
  enrollIdentityMetadata,
  initializeReplica,
  validateMetadata,
};
