'use strict';

/*
 * Test-only persistence adapter for portable graph identity and device-local
 * recovery records. See PERSISTENT_IDENTITY_DESIGN.md.
 *
 * It reuses the accepted pure identity logic in identity-capture.js unchanged
 * and adds only the two anchored owned locations, their record bytes, their
 * explicit write ordering and their recovery classification. It starts no
 * synchronization, launches no application and is imported by no OG namespace.
 */

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { applyOperation, createState, stableStringify } = require('./core');
const {
  enrollIdentityMetadata, initializeReplica, validateMetadata,
} = require('./identity-capture');
const { snapshotFingerprint } = require('./planner');
const { APPROVED_TEST_ROOT } = require('./persistence');

const PROFILE_ROOT = '/Users/johnlee/Library/Application Support/Logseq OG F28 IdentityExp';
const GRAPH_IDENTITY_SCHEMA = 'f28-graph-identity/1';
const DEVICE_RECORD_SCHEMA = 'f28-device-record/1';
const INTENT_SCHEMA = 'f28-publication-intent/1';
const NO_TRANSACTION = '0'.repeat(64);
const SIDECAR_KEYS = [
  'acceptedSnapshotFingerprint', 'acceptedTransactionId', 'graphId',
  'identity', 'metadataRevision', 'schema', 'selectedGeneration',
];
const DEVICE_KEYS = [
  'acceptedSnapshotFingerprint', 'acceptedTransactionId', 'deviceId', 'graphBinding',
  'graphId', 'metadataRevision', 'replica', 'replicaId', 'schema', 'selectedGeneration',
  'sidecarHash',
];
/* Key names and substrings that must never reach the portable sidecar. */
const DEVICE_LOCAL_KEYS = [
  'replicaId', 'deviceId', 'graphBinding', 'sidecarHash', 'cursor', 'cursors',
  'lock', 'locks', 'lease', 'token', 'secret', 'credential', 'credentials',
  'hostname', 'profilePath', 'absolutePath', 'pendingObservations',
];

class PersistentIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersistentIdentityError';
    this.code = code;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function serialize(record) {
  return Buffer.from(`${stableStringify(record)}\n`, 'utf8');
}

function bytesHash(buffer) {
  return `sha256:${digest(buffer)}`;
}

function encode(request) {
  return [
    'MAGIC\tF28ID1', `COMMAND\t${request.command}`,
    `GRAPHROOTHEX\t${hex(APPROVED_TEST_ROOT)}`, `PROFILEROOTHEX\t${hex(PROFILE_ROOT)}`,
    `RUN\t${request.runName}`, `OWNER\t${request.ownerToken}`,
    `GRAPHDIR\t${request.graphDirectory}`, `PROFILEDIR\t${request.profileDirectory}`,
    `TX\t${request.transactionId || NO_TRANSACTION}`,
    `ATTEMPT\t${request.attempt || crypto.randomBytes(16).toString('hex')}`,
    `TARGET\t${request.target || 'none'}`,
    `FAILURE\t${request.failurePoint || 'none'}`,
    `NOTEPATHHEX\t${request.notePath ? hex(request.notePath) : ''}`,
    `DATAHEX\t${request.data ? Buffer.from(request.data).toString('hex') : ''}`,
    'END\t1', '',
  ].join('\n');
}

function invoke(context, request) {
  const merged = { ...context, ...request };
  const result = spawnSync(context.helper, [], {
    input: encode(merged), encoding: 'utf8', timeout: 10000, maxBuffer: 24 * 1024 * 1024,
  });
  if (result.error) {
    throw new PersistentIdentityError('helper-execution-failed', result.error.message);
  }
  if (result.status !== 0) {
    const error = new PersistentIdentityError(
      result.status === 25 ? 'injected-failure' : 'helper-refused',
      (result.stderr || 'identity helper refused').trim(),
    );
    error.exitCode = result.status;
    error.failurePoint = merged.failurePoint || 'none';
    throw error;
  }
  const output = {};
  for (const line of result.stdout.trim().split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 1) throw new PersistentIdentityError('malformed-response', 'malformed helper response');
    output[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1);
  }
  if (output.status !== 'ok') throw new PersistentIdentityError('malformed-response', 'helper response lacks status');
  return output;
}

function decodeMaybe(value) {
  return !value || value === '-' ? null : Buffer.from(value, 'hex');
}

/*
 * Unparseable bytes are evidence, not an error: they are retained and reported,
 * so a refusal can name them without the reader destroying or hiding them.
 */
function parseRecord(buffer) {
  if (!buffer) return { value: null, malformed: false };
  try {
    return { value: JSON.parse(buffer.toString('utf8')), malformed: false };
  } catch (_error) {
    return { value: null, malformed: true };
  }
}

// ---------------------------------------------------------------- owned run

function initializeOwnedRun(context) {
  invoke(context, { command: 'init' });
  return context;
}

function putNote(context, notePath, content) {
  invoke(context, {
    command: 'put-note', notePath, data: Buffer.from(content, 'utf8'),
    transactionId: digest(`note\0${notePath}\0${content}`),
  });
}

function readNote(context, notePath) {
  const output = invoke(context, { command: 'read-note', notePath });
  const data = decodeMaybe(output.data);
  return data === null ? null : data.toString('utf8');
}

function hashGraphNotes(context) {
  const output = invoke(context, { command: 'hash-graph' });
  return { hash: output.hash, count: Number(output.count) };
}

function readRecords(context, transactionId = NO_TRANSACTION) {
  const output = invoke(context, { command: 'read-records', transactionId });
  const sidecarBytes = decodeMaybe(output.sidecar);
  const deviceBytes = decodeMaybe(output.device);
  const intentBytes = decodeMaybe(output.intent);
  const sidecar = parseRecord(sidecarBytes);
  const device = parseRecord(deviceBytes);
  const intent = parseRecord(intentBytes);
  return {
    sidecarBytes,
    deviceBytes,
    intentBytes,
    sidecar: sidecar.value,
    device: device.value,
    intent: intent.value,
    malformed: [
      sidecar.malformed && 'sidecar', device.malformed && 'device', intent.malformed && 'intent',
    ].filter(Boolean),
    sidecarHash: sidecarBytes ? bytesHash(sidecarBytes) : null,
    deviceHash: deviceBytes ? bytesHash(deviceBytes) : null,
    graphPending: Number(output.graphpending),
    profilePending: Number(output.profilepending),
    outstandingIntents: output.intents === '-' ? [] : output.intents.split(','),
    evidence: Number(output.evidence),
    graphBinding: {
      runName: context.runName,
      graphDirectory: context.graphDirectory,
      graphDevice: Number(output.graphdevice),
      graphInode: Number(output.graphinode),
    },
  };
}

// --------------------------------------------------- snapshots and records

/*
 * Rebuild the in-memory selected snapshot from the bytes actually on disk.
 * The caller names the files; the adapter never discovers them, and the
 * content it validates is what the graph really contains.
 */
function snapshotFromDisk(context, graphId, files) {
  let state = createState(graphId);
  const sorted = [...files].sort((left, right) =>
    Buffer.from(left.fileId).compare(Buffer.from(right.fileId)));
  const materialized = [];
  for (const [index, file] of sorted.entries()) {
    const content = readNote(context, file.path);
    if (content === null) {
      throw new PersistentIdentityError('missing-note', `${file.path} is absent from the graph`);
    }
    state = applyOperation(state, {
      operationId: `disk-op-${index}`, kind: 'create', fileId: file.fileId,
      revisionId: file.acceptedRevision, parentRevisionId: null,
      path: file.path, content,
    }).state;
    materialized.push({ path: file.path, content });
  }
  materialized.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const fingerprint = snapshotFingerprint(state);
  return {
    schema: 'f28-selected-snapshot/1',
    generation: digest(`f28-synthetic-generation\0${graphId}\0${fingerprint}`),
    snapshotFingerprint: fingerprint,
    state,
    files: materialized,
  };
}

function assertPortable(sidecar, bytes) {
  const keys = Object.keys(sidecar).sort();
  if (stableStringify(keys) !== stableStringify(SIDECAR_KEYS)) {
    throw new PersistentIdentityError('malformed-record', 'sidecar key set is not the portable set');
  }
  const text = bytes.toString('utf8');
  for (const forbidden of DEVICE_LOCAL_KEYS) {
    if (text.includes(`"${forbidden}"`)) {
      throw new PersistentIdentityError('device-material-in-sidecar', `sidecar contains ${forbidden}`);
    }
  }
  if (text.includes('/Users/') || text.includes(PROFILE_ROOT) || text.includes(APPROVED_TEST_ROOT)) {
    throw new PersistentIdentityError('device-material-in-sidecar', 'sidecar contains an absolute path');
  }
}

function buildSidecar({ graphId, metadataRevision, transactionId, snapshot, identity }) {
  return {
    schema: GRAPH_IDENTITY_SCHEMA,
    graphId,
    metadataRevision,
    acceptedTransactionId: transactionId,
    acceptedSnapshotFingerprint: snapshot.snapshotFingerprint,
    selectedGeneration: snapshot.generation,
    identity,
  };
}

function buildDeviceRecord({
  deviceId, replicaId, graphId, graphBinding, transactionId, metadataRevision,
  snapshot, sidecarHash, replica,
}) {
  return {
    schema: DEVICE_RECORD_SCHEMA,
    deviceId,
    replicaId,
    graphId,
    graphBinding,
    acceptedTransactionId: transactionId,
    metadataRevision,
    acceptedSnapshotFingerprint: snapshot.snapshotFingerprint,
    selectedGeneration: snapshot.generation,
    sidecarHash,
    replica,
  };
}

function transactionFor(kind, parts) {
  return digest(`f28-identity-transaction/1\0${kind}\0${stableStringify(parts)}`);
}

// ----------------------------------------------------------- read and open

/*
 * Read-only classification. It never writes, and it never enrolls a graph as a
 * side effect of being opened.
 */
function openGraph(context, options = {}) {
  const records = readRecords(context, options.transactionId || NO_TRANSACTION);
  const base = {
    records,
    outstandingIntents: records.outstandingIntents,
    graphPending: records.graphPending,
    profilePending: records.profilePending,
  };
  if (records.malformed.length) {
    return { ...base, outcome: 'refused', code: 'malformed-record', malformed: records.malformed };
  }
  if (records.outstandingIntents.length) {
    return { ...base, outcome: 'recovery-required', code: 'outstanding-intent' };
  }
  if (!records.sidecar && !records.device) return { ...base, outcome: 'unenrolled' };
  if (records.sidecar && !records.device) {
    return { ...base, outcome: 'refused', code: 'missing-device-record' };
  }
  if (!records.sidecar && records.device) {
    return { ...base, outcome: 'refused', code: 'missing-sidecar' };
  }

  const { sidecar, device } = records;
  if (sidecar.schema !== GRAPH_IDENTITY_SCHEMA || device.schema !== DEVICE_RECORD_SCHEMA) {
    return { ...base, outcome: 'refused', code: 'unsupported-schema' };
  }
  try {
    assertPortable(sidecar, records.sidecarBytes);
    if (stableStringify(Object.keys(device).sort()) !== stableStringify(DEVICE_KEYS)) {
      throw new PersistentIdentityError('malformed-record', 'device record key set is wrong');
    }
    const files = Object.entries(sidecar.identity.files || {})
      .map(([fileId, entry]) => ({ fileId, path: entry.path, acceptedRevision: entry.acceptedRevision }));
    const snapshot = snapshotFromDisk(context, sidecar.graphId, files);
    if (snapshot.snapshotFingerprint !== sidecar.acceptedSnapshotFingerprint) {
      throw new PersistentIdentityError('snapshot-mismatch', 'graph bytes differ from the accepted sidecar');
    }
    validateMetadata(sidecar.identity, snapshot);
    if (device.sidecarHash !== records.sidecarHash) {
      throw new PersistentIdentityError('record-mismatch', 'device record names different sidecar bytes');
    }
    if (device.graphId !== sidecar.graphId) {
      throw new PersistentIdentityError('record-mismatch', 'device record names a different graph');
    }
    if (device.metadataRevision !== sidecar.metadataRevision) {
      throw new PersistentIdentityError('stale-record', 'device record metadata revision is stale');
    }
    if (device.acceptedTransactionId !== sidecar.acceptedTransactionId) {
      throw new PersistentIdentityError('record-mismatch', 'records name different transactions');
    }
    const binding = device.graphBinding;
    const actual = records.graphBinding;
    if (binding.runName !== actual.runName || binding.graphDirectory !== actual.graphDirectory
        || binding.graphDevice !== actual.graphDevice || binding.graphInode !== actual.graphInode) {
      return {
        ...base, outcome: 'refused', code: 'copied-graph-choice-required',
        sidecar, device, recordedBinding: binding, observedBinding: actual,
      };
    }
    return { ...base, outcome: 'accepted', sidecar, device, snapshot };
  } catch (error) {
    if (!(error instanceof PersistentIdentityError) && !error.code) throw error;
    return { ...base, outcome: 'refused', code: error.code, detail: error.message, sidecar, device };
  }
}

// ------------------------------------------------------------- publication

function writeEvidence(context, transactionId, body) {
  try {
    invoke(context, {
      command: 'write-record', target: 'evidence', transactionId,
      data: serialize({ schema: 'f28-uncertain-publication/1', transactionId, ...body }),
    });
    return true;
  } catch (_error) {
    return false;
  }
}

/*
 * Publish one transaction across the two owned trees. The intent is written
 * first in both orderings because it is the only record naming base and target.
 * There is no cross-directory atomicity and none is claimed.
 */
function publish(context, {
  kind, transactionId, ordering = 'graph-first', graphId, replicaId, deviceId,
  base, sidecarBytes, deviceBytes, failure = {},
}) {
  if (ordering !== 'graph-first' && ordering !== 'profile-first') {
    throw new PersistentIdentityError('invalid-ordering', 'ordering must be graph-first or profile-first');
  }
  const intent = {
    schema: INTENT_SCHEMA,
    transactionId,
    kind,
    ordering,
    graphId,
    replicaId,
    deviceId,
    base: { sidecar: base.sidecarHash, device: base.deviceHash },
    target: { sidecar: bytesHash(sidecarBytes), device: bytesHash(deviceBytes) },
    // Device-local staging. Recovery rehashes these before reusing them, so a
    // roll-forward writes the exact bytes this transaction intended and never
    // reconstructs them from a phase flag or from the graph.
    staged: { sidecar: sidecarBytes.toString('utf8'), device: deviceBytes.toString('utf8') },
  };
  const step = (name, target, data) => {
    try {
      invoke(context, {
        command: 'write-record', target, transactionId, data,
        failurePoint: failure.step === name ? failure.point : 'none',
      });
      return null;
    } catch (error) {
      if (error.code !== 'injected-failure') throw error;
      const proven = error.failurePoint === 'before-stage';
      writeEvidence(context, transactionId, {
        outcome: provenLabel(proven), step: name, failurePoint: error.failurePoint,
      });
      return {
        outcome: proven ? 'refused-no-write' : 'uncertain-write',
        code: proven ? 'proven-no-write' : 'write-outcome-unknown',
        step: name, transactionId, intent,
      };
    }
  };

  const intentResult = step('intent', 'intent', serialize(intent));
  if (intentResult) return intentResult;

  const order = (ordering === 'graph-first'
    ? [['sidecar', 'sidecar', sidecarBytes], ['device', 'device', deviceBytes]]
    : [['device', 'device', deviceBytes], ['sidecar', 'sidecar', sidecarBytes]])
    .filter(([name, , data]) => intent.base[name] !== bytesHash(data));
  for (const [name, target, data] of order) {
    const failed = step(name, target, data);
    if (failed) return failed;
  }

  try {
    invoke(context, {
      command: 'clear-intent', transactionId,
      failurePoint: failure.step === 'clear' ? failure.point : 'none',
    });
  } catch (error) {
    if (error.code !== 'injected-failure') throw error;
    const proven = error.failurePoint === 'before-clear';
    writeEvidence(context, transactionId, {
      outcome: proven ? 'proven-no-clear' : 'clear-outcome-unknown',
      step: 'clear', failurePoint: error.failurePoint,
    });
    return {
      outcome: proven ? 'clear-refused' : 'uncertain-clear',
      code: proven ? 'proven-no-clear' : 'clear-outcome-unknown',
      step: 'clear', transactionId, intent,
    };
  }
  return { outcome: 'accepted', transactionId, intent };
}

function provenLabel(proven) {
  return proven ? 'proven-no-write' : 'write-outcome-unknown';
}

// -------------------------------------------------------------- enrollment

/* Explicit enrollment only. Never reached by merely opening a graph. */
function enrollGraph(context, request, options = {}) {
  const records = readRecords(context);
  if (records.malformed.length) {
    return { outcome: 'refused', code: 'malformed-record', malformed: records.malformed, records };
  }
  if (!records.outstandingIntents.length && (records.sidecar || records.device)) {
    return { outcome: 'refused', code: 'already-enrolled', records };
  }
  const snapshot = snapshotFromDisk(context, request.graphId, request.files);
  const { metadata, replica } = enrollIdentityMetadata({
    schema: 'f28-identity-enrollment/1',
    complete: true,
    graphId: request.graphId,
    replicaId: request.replicaId,
    metadataRevision: request.metadataRevision,
    files: request.files.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
      acceptedRevision: file.acceptedRevision,
    })),
  }, snapshot);

  const transactionId = transactionFor('enroll', {
    graphId: request.graphId, replicaId: request.replicaId, deviceId: request.deviceId,
    metadataRevision: request.metadataRevision, metadata,
    snapshotFingerprint: snapshot.snapshotFingerprint, generation: snapshot.generation,
  });
  const outstanding = outstandingDecision(context, records, transactionId);
  if (outstanding) return outstanding;

  const sidecar = buildSidecar({
    graphId: request.graphId, metadataRevision: request.metadataRevision,
    transactionId, snapshot, identity: metadata,
  });
  const sidecarBytes = serialize(sidecar);
  assertPortable(sidecar, sidecarBytes);
  const deviceBytes = serialize(buildDeviceRecord({
    deviceId: request.deviceId, replicaId: request.replicaId, graphId: request.graphId,
    graphBinding: records.graphBinding, transactionId,
    metadataRevision: request.metadataRevision, snapshot,
    sidecarHash: bytesHash(sidecarBytes), replica,
  }));
  return publish(context, {
    kind: 'enroll', transactionId, ordering: options.ordering,
    graphId: request.graphId, replicaId: request.replicaId, deviceId: request.deviceId,
    base: { sidecarHash: null, deviceHash: null },
    sidecarBytes, deviceBytes, failure: options.failure,
  });
}

// ---------------------------------------------------------------- recovery

function validateIntent(records) {
  const intent = records.intent;
  if (!intent || intent.schema !== INTENT_SCHEMA) {
    throw new PersistentIdentityError('malformed-intent', 'intent record is not a supported intent');
  }
  const staged = intent.staged || {};
  const sidecarBytes = Buffer.from(String(staged.sidecar ?? ''), 'utf8');
  const deviceBytes = Buffer.from(String(staged.device ?? ''), 'utf8');
  if (bytesHash(sidecarBytes) !== intent.target.sidecar
      || bytesHash(deviceBytes) !== intent.target.device) {
    throw new PersistentIdentityError('malformed-intent', 'staged bytes do not match the intent target');
  }
  return { intent, sidecarBytes, deviceBytes };
}

/*
 * Classify from the bytes actually on disk. The intent carries no phase, step
 * or status field, so there is nothing here to trust but evidence.
 */
function classifyRecovery(records, intent) {
  // Target first, so a record whose base already equals its target counts as
  // reached rather than pending.
  const at = (observed, base, target) => {
    if (observed === target) return 'target';
    if (observed === base) return 'base';
    return 'other';
  };
  const sidecar = at(records.sidecarHash, intent.base.sidecar, intent.target.sidecar);
  const device = at(records.deviceHash, intent.base.device, intent.target.device);
  if (sidecar === 'other' || device === 'other') return 'mismatch';
  if (sidecar === 'base' && device === 'base') return 'prepared';
  if (sidecar === 'target' && device === 'base') return 'graph-applied';
  if (sidecar === 'base' && device === 'target') return 'device-applied';
  return 'applied';
}

function rollForward(context, transactionId, classification, staged, intent) {
  const writes = [];
  if (classification === 'prepared') {
    writes.push(...(intent.ordering === 'graph-first'
      ? [['sidecar', staged.sidecarBytes], ['device', staged.deviceBytes]]
      : [['device', staged.deviceBytes], ['sidecar', staged.sidecarBytes]]));
  } else if (classification === 'graph-applied') {
    writes.push(['device', staged.deviceBytes]);
  } else if (classification === 'device-applied') {
    writes.push(['sidecar', staged.sidecarBytes]);
  }
  for (const [target, data] of writes.filter(([name, data]) =>
    intent.base[name] !== bytesHash(data))) {
    invoke(context, { command: 'write-record', target, transactionId, data });
  }
  invoke(context, { command: 'clear-intent', transactionId });
}

/*
 * Restart entry point. It revalidates evidence; an absent file is never by
 * itself proof that work completed.
 */
function recover(context, options = {}) {
  const probe = readRecords(context);
  if (probe.outstandingIntents.length > 1) {
    return { outcome: 'refused', code: 'multiple-outstanding-intents', records: probe };
  }
  if (!probe.outstandingIntents.length) {
    const opened = openGraph(context);
    if (opened.outcome === 'accepted') {
      return {
        outcome: 'none',
        // A verified-empty intent store confirms an outstanding uncertain clear
        // only where retained evidence supports it.
        resolved: probe.evidence ? 'uncertain-clear' : null,
        opened,
        records: probe,
      };
    }
    return { outcome: opened.outcome, code: opened.code, opened, records: probe };
  }

  const transactionId = probe.outstandingIntents[0];
  if (options.transactionId && options.transactionId !== transactionId) {
    return { outcome: 'refused', code: 'incompatible-transaction', transactionId, records: probe };
  }
  const records = readRecords(context, transactionId);
  if (records.malformed.length) {
    return { outcome: 'refused', code: 'malformed-record', malformed: records.malformed, records };
  }
  let staged;
  try {
    staged = validateIntent(records);
  } catch (error) {
    return { outcome: 'refused', code: error.code, detail: error.message, transactionId, records };
  }
  if (staged.intent.transactionId !== transactionId) {
    return { outcome: 'refused', code: 'intent-transaction-mismatch', transactionId, records };
  }
  const classification = classifyRecovery(records, staged.intent);
  if (classification === 'mismatch') {
    return {
      outcome: 'refused', code: 'recovery-state-mismatch', classification,
      transactionId, records,
    };
  }
  rollForward(context, transactionId, classification, staged, staged.intent);
  const opened = openGraph(context);
  if (opened.outcome !== 'accepted') {
    return { outcome: 'refused', code: 'post-recovery-refusal', classification, transactionId, opened };
  }
  return { outcome: 'recovered', classification, transactionId, opened };
}

// ------------------------------------------------------------------ update

/*
 * A subsequent identity record for an already accepted graph. It requires the
 * current accepted state to validate against the graph's actual bytes, an
 * explicit expected metadata revision, and an explicit complete file list.
 */
function updateIdentity(context, request, options = {}) {
  const probe = readRecords(context);
  if (probe.malformed.length) {
    return { outcome: 'refused', code: 'malformed-record', malformed: probe.malformed, records: probe };
  }
  if (!probe.sidecar || !probe.device) {
    return { outcome: 'refused', code: 'not-enrolled', records: probe };
  }
  const accepted = probe.sidecar;
  if (request.expectedMetadataRevision !== accepted.metadataRevision) {
    return { outcome: 'refused', code: 'stale-metadata-revision', records: probe };
  }
  const known = new Set(Object.keys(accepted.identity.files));
  const proposed = new Set(request.files.map((file) => file.fileId));
  const tombstoned = new Set(request.tombstones || []);
  for (const fileId of known) {
    if (!proposed.has(fileId) && !tombstoned.has(fileId)) {
      return { outcome: 'refused', code: 'incomplete-update', fileId, records: probe };
    }
  }
  const snapshot = snapshotFromDisk(context, accepted.graphId, request.files);
  const { metadata, replica } = enrollIdentityMetadata({
    schema: 'f28-identity-enrollment/1',
    complete: true,
    graphId: accepted.graphId,
    replicaId: probe.device.replicaId,
    metadataRevision: request.metadataRevision,
    files: request.files.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
      acceptedRevision: file.acceptedRevision,
    })),
  }, snapshot);

  const transactionId = transactionFor('update', {
    graphId: accepted.graphId, replicaId: probe.device.replicaId,
    deviceId: probe.device.deviceId, expected: accepted.metadataRevision,
    metadataRevision: request.metadataRevision, metadata,
    snapshotFingerprint: snapshot.snapshotFingerprint, generation: snapshot.generation,
  });
  const outstanding = outstandingDecision(context, probe, transactionId);
  if (outstanding) return outstanding;

  const sidecar = buildSidecar({
    graphId: accepted.graphId, metadataRevision: request.metadataRevision,
    transactionId, snapshot, identity: metadata,
  });
  const sidecarBytes = serialize(sidecar);
  assertPortable(sidecar, sidecarBytes);
  const deviceBytes = serialize(buildDeviceRecord({
    deviceId: probe.device.deviceId, replicaId: probe.device.replicaId,
    graphId: accepted.graphId, graphBinding: probe.graphBinding, transactionId,
    metadataRevision: request.metadataRevision, snapshot,
    sidecarHash: bytesHash(sidecarBytes), replica,
  }));
  return publish(context, {
    kind: 'update', transactionId, ordering: options.ordering,
    graphId: accepted.graphId, replicaId: probe.device.replicaId,
    deviceId: probe.device.deviceId,
    base: { sidecarHash: probe.sidecarHash, deviceHash: probe.deviceHash },
    sidecarBytes, deviceBytes, failure: options.failure,
  });
}

/*
 * An outstanding intent reserves the store. Only the exact same transaction may
 * continue, and it continues through recovery rather than by writing again.
 */
function outstandingDecision(context, probe, transactionId) {
  if (!probe.outstandingIntents.length) return null;
  if (probe.outstandingIntents.length > 1 || probe.outstandingIntents[0] !== transactionId) {
    return { outcome: 'refused', code: 'incompatible-transaction', records: probe };
  }
  const recovered = recover(context, { transactionId });
  if (recovered.outcome !== 'recovered') {
    return { outcome: 'refused', code: recovered.code || 'recovery-required', recovered };
  }
  return { outcome: 'accepted', retried: true, transactionId, recovered };
}

// ------------------------------------------- explicit copied-graph choice

/*
 * A copy is resolved only by an explicit user choice. Matching bytes, paths,
 * inodes and sidecars never decide it, and nothing here merges two lineages.
 */
function adoptCopy(context, request, options = {}) {
  const probe = readRecords(context);
  if (probe.malformed.length) {
    return { outcome: 'refused', code: 'malformed-record', malformed: probe.malformed, records: probe };
  }
  if (probe.outstandingIntents.length) {
    return { outcome: 'refused', code: 'outstanding-intent', records: probe };
  }
  if (!probe.sidecar) return { outcome: 'refused', code: 'missing-sidecar', records: probe };

  const choice = request.choice;
  if (choice !== 'same-lineage-new-replica' && choice !== 'new-graph-lineage') {
    return { outcome: 'refused', code: 'unsupported-copy-choice', records: probe };
  }
  const state = openGraph(context);
  const pending = state.outcome === 'refused'
    && (state.code === 'copied-graph-choice-required' || state.code === 'missing-device-record');
  if (!pending) {
    return { outcome: 'refused', code: 'no-copy-choice-pending', state };
  }
  const accepted = probe.sidecar;
  if (!request.replicaId || !request.deviceId) {
    return { outcome: 'refused', code: 'explicit-replica-required', records: probe };
  }

  if (choice === 'same-lineage-new-replica') {
    /* The copy is another replica of the same graph: the sidecar does not change. */
    const files = Object.entries(accepted.identity.files)
      .map(([fileId, entry]) => ({ fileId, path: entry.path, acceptedRevision: entry.acceptedRevision }));
    const snapshot = snapshotFromDisk(context, accepted.graphId, files);
    if (snapshot.snapshotFingerprint !== accepted.acceptedSnapshotFingerprint) {
      return { outcome: 'refused', code: 'snapshot-mismatch', records: probe };
    }
    validateMetadata(accepted.identity, snapshot);
    const replica = initializeReplica(accepted.identity, request.replicaId, snapshot);
    const transactionId = transactionFor('adopt-copy', {
      choice, graphId: accepted.graphId, replicaId: request.replicaId,
      deviceId: request.deviceId, sidecarHash: probe.sidecarHash,
      binding: probe.graphBinding,
    });
    const deviceBytes = serialize(buildDeviceRecord({
      deviceId: request.deviceId, replicaId: request.replicaId, graphId: accepted.graphId,
      graphBinding: probe.graphBinding,
      transactionId: accepted.acceptedTransactionId,
      metadataRevision: accepted.metadataRevision, snapshot,
      sidecarHash: probe.sidecarHash, replica,
    }));
    return publish(context, {
      kind: 'adopt-copy', transactionId, ordering: options.ordering,
      graphId: accepted.graphId, replicaId: request.replicaId, deviceId: request.deviceId,
      base: { sidecarHash: probe.sidecarHash, deviceHash: probe.deviceHash },
      sidecarBytes: probe.sidecarBytes, deviceBytes, failure: options.failure,
    });
  }

  /* The copy is an independent graph: a new lineage and entirely new file IDs. */
  if (!request.graphId || request.graphId === accepted.graphId) {
    return { outcome: 'refused', code: 'reused-graph-identity', records: probe };
  }
  if (!Array.isArray(request.files) || !request.files.length) {
    return { outcome: 'refused', code: 'explicit-enrollment-required', records: probe };
  }
  const known = new Set(Object.keys(accepted.identity.files)
    .concat(Object.keys(accepted.identity.tombstones || {})));
  for (const file of request.files) {
    if (known.has(file.fileId)) {
      return { outcome: 'refused', code: 'reused-file-identity', fileId: file.fileId, records: probe };
    }
  }
  const snapshot = snapshotFromDisk(context, request.graphId, request.files);
  const { metadata, replica } = enrollIdentityMetadata({
    schema: 'f28-identity-enrollment/1',
    complete: true,
    graphId: request.graphId,
    replicaId: request.replicaId,
    metadataRevision: request.metadataRevision,
    files: request.files.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
      acceptedRevision: file.acceptedRevision,
    })),
  }, snapshot);
  const transactionId = transactionFor('new-lineage', {
    graphId: request.graphId, replicaId: request.replicaId, deviceId: request.deviceId,
    metadataRevision: request.metadataRevision, metadata,
    snapshotFingerprint: snapshot.snapshotFingerprint, generation: snapshot.generation,
  });
  const sidecar = buildSidecar({
    graphId: request.graphId, metadataRevision: request.metadataRevision,
    transactionId, snapshot, identity: metadata,
  });
  const sidecarBytes = serialize(sidecar);
  assertPortable(sidecar, sidecarBytes);
  const deviceBytes = serialize(buildDeviceRecord({
    deviceId: request.deviceId, replicaId: request.replicaId, graphId: request.graphId,
    graphBinding: probe.graphBinding, transactionId,
    metadataRevision: request.metadataRevision, snapshot,
    sidecarHash: bytesHash(sidecarBytes), replica,
  }));
  return publish(context, {
    kind: 'adopt-copy', transactionId, ordering: options.ordering,
    graphId: request.graphId, replicaId: request.replicaId, deviceId: request.deviceId,
    base: { sidecarHash: probe.sidecarHash, deviceHash: probe.deviceHash },
    sidecarBytes, deviceBytes, failure: options.failure,
  });
}

/*
 * Test-only: install exact record bytes without the adapter's own derivation,
 * so malformed, stale, mismatched and copied fixtures can be built. Production
 * callers never reach this; it is exported for the acceptance tests.
 */
function writeRawRecordForTest(context, target, data, transactionId = NO_TRANSACTION) {
  invoke(context, { command: 'write-record', target, transactionId, data });
}

module.exports = {
  DEVICE_RECORD_SCHEMA,
  GRAPH_IDENTITY_SCHEMA,
  INTENT_SCHEMA,
  NO_TRANSACTION,
  PROFILE_ROOT,
  PersistentIdentityError,
  adoptCopy,
  buildDeviceRecord,
  buildSidecar,
  bytesHash,
  enrollGraph,
  hashGraphNotes,
  initializeOwnedRun,
  openGraph,
  publish,
  putNote,
  readNote,
  readRecords,
  recover,
  serialize,
  snapshotFromDisk,
  transactionFor,
  updateIdentity,
  writeRawRecordForTest,
};
