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
const fs = require('node:fs');
const nodePath = require('node:path');
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
  'graphId', 'metadataRevision', 'profileBinding', 'replica', 'replicaId', 'schema',
  'selectedGeneration', 'sidecarHash',
];
/* Key names and substrings that must never reach the portable sidecar. */
const DEVICE_LOCAL_KEYS = [
  'replicaId', 'deviceId', 'graphBinding', 'sidecarHash', 'cursor', 'cursors',
  'lock', 'locks', 'lease', 'token', 'secret', 'credential', 'credentials',
  'hostname', 'profilePath', 'profileBinding', 'absolutePath', 'pendingObservations',
];

/*
 * Bounded local failure capture. Every refused or injected helper invocation,
 * and every failed assertion the caller reports, is appended as one JSON line
 * naming the case, the command, the exit status and a truncated diagnostic.
 *
 * It records synthetic case and directory component names and helper refusal
 * text only. Note content, record bytes, hex payloads, owner tokens and
 * absolute paths are never written. The file is capped, and the directory is
 * chosen by the caller through F28_DIAG_DIR so nothing is written unasked.
 */
const DIAGNOSTIC_LIMIT = 2000;
const STDERR_LIMIT = 300;
let diagnosticCase = null;
let diagnosticCount = 0;

function diagnosticDirectory() {
  return process.env.F28_DIAG_DIR || null;
}

function setDiagnosticCase(name) {
  diagnosticCase = name;
}

function recordDiagnostic(kind, entry) {
  const directory = diagnosticDirectory();
  if (!directory || diagnosticCount >= DIAGNOSTIC_LIMIT) return;
  diagnosticCount += 1;
  const line = JSON.stringify({
    schema: 'f28-identity-diagnostic/1',
    at: new Date().toISOString(),
    case: diagnosticCase,
    kind,
    ...entry,
  });
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(nodePath.join(directory, 'failures.jsonl'), `${line}\n`);
  } catch (_error) {
    /* Diagnostics must never mask the failure they describe. */
  }
}

function boundedText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > STDERR_LIMIT ? `${text.slice(0, STDERR_LIMIT)}…` : text;
}

function recordAssertionFailure(name, error) {
  recordDiagnostic('assertion', {
    case: name,
    errorName: error && error.name,
    errorCode: error && error.code,
    message: boundedText(error && error.message),
  });
}

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

/*
 * The exact state a record write requires its destination to be in, rechecked
 * by the helper immediately before the rename: `absent`, a bare content hash,
 * or `any` for fixture writes that deliberately install arbitrary bytes.
 */
function expectField(expect) {
  if (expect === undefined || expect === 'any') return 'any';
  if (expect === null || expect === 'absent') return 'absent';
  const bare = String(expect).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new PersistentIdentityError('invalid-expectation', 'destination expectation is malformed');
  }
  return bare;
}

/*
 * Test-only simulated relocation of an owned directory mid-command: `none`
 * for every production caller, or the owned directory the helper renames
 * aside — leaving a replacement at its entry — between acquisition and the
 * entry re-verification.
 */
function relocateField(relocate) {
  if (relocate === undefined || relocate === null) return 'none';
  if (relocate === 'graph' || relocate === 'profile') return relocate;
  throw new PersistentIdentityError('invalid-relocation', 'relocation choice is malformed');
}

function encode(request) {
  return [
    'MAGIC\tF28ID1', `COMMAND\t${request.command}`,
    `GRAPHROOTHEX\t${hex(APPROVED_TEST_ROOT)}`, `PROFILEROOTHEX\t${hex(PROFILE_ROOT)}`,
    `RUN\t${request.runName}`, `OWNER\t${request.ownerToken}`,
    `GRAPHDIR\t${request.graphDirectory}`, `PROFILEDIR\t${request.profileDirectory}`,
    `TX\t${request.transactionId || NO_TRANSACTION}`,
    `ATTEMPT\t${request.attempt || crypto.randomBytes(16).toString('hex')}`,
    `EXPECT\t${expectField(request.expect)}`,
    `TARGET\t${request.target || 'none'}`,
    `FAILURE\t${request.failurePoint || 'none'}`,
    `RELOCATE\t${relocateField(request.relocate)}`,
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
    recordDiagnostic('invocation', {
      command: merged.command, target: merged.target || 'none',
      graphDirectory: merged.graphDirectory, profileDirectory: merged.profileDirectory,
      failurePoint: merged.failurePoint || 'none', relocate: relocateField(merged.relocate),
      exitCode: null,
      signal: result.signal || null, execError: boundedText(result.error.message),
    });
    throw new PersistentIdentityError('helper-execution-failed', result.error.message);
  }
  if (result.status !== 0) {
    const message = (result.stderr || 'identity helper refused').trim();
    const error = new PersistentIdentityError(
      result.status === 25 ? 'injected-failure'
        : /destination precondition failed/.test(message) ? 'destination-precondition-failed'
          : 'helper-refused',
      message,
    );
    error.exitCode = result.status;
    error.failurePoint = merged.failurePoint || 'none';
    recordDiagnostic('invocation', {
      command: merged.command, target: merged.target || 'none',
      graphDirectory: merged.graphDirectory, profileDirectory: merged.profileDirectory,
      expect: expectField(merged.expect), failurePoint: error.failurePoint,
      relocate: relocateField(merged.relocate),
      exitCode: result.status, signal: result.signal || null,
      stderr: boundedText(result.stderr), code: error.code,
    });
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

/*
 * FIXTURE ONLY. `expect: 'any'` installs arbitrary bytes over whatever is at the
 * destination, which is exactly what a test seed wants and exactly what an
 * incoming application must never do. Every caller of this function is a test or
 * harness seed; the incoming applier reaches the graph only through
 * `putNoteExpecting` below, which has no `any` and no default.
 */
function putNoteFixture(context, notePath, content) {
  invoke(context, {
    command: 'put-note', notePath, data: Buffer.from(content, 'utf8'),
    transactionId: digest(`note\0${notePath}\0${content}`), expect: 'any',
  });
}

/*
 * The only note write reachable from incoming application. The caller must state
 * the exact state it requires the destination to be in -- `absent` or a 64-hex
 * content hash -- and the helper rechecks that immediately before its rename.
 * `any`, an empty value and a missing value are all refused here, so no incoming
 * path can fall back to an unconditional overwrite.
 *
 * This is a recheck-then-rename under the cooperative lock, not an atomic
 * compare-and-swap: a writer that does not honour the lock can still change the
 * destination between the recheck and the rename.
 */
function putNoteExpecting(context, notePath, bytes, expect) {
  if (expect !== 'absent' && !/^[0-9a-f]{64}$/.test(String(expect || ''))) {
    throw new PersistentIdentityError('invalid-precondition',
      'an incoming note write requires expect to be "absent" or a 64-hex content hash');
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  invoke(context, {
    command: 'put-note', notePath, data, expect,
    transactionId: digest(`note\0${notePath}\0${data.toString('hex')}`),
  });
}

function readNoteBytes(context, notePath) {
  const output = invoke(context, { command: 'read-note', notePath });
  return decodeMaybe(output.data);
}

function readNote(context, notePath) {
  const data = readNoteBytes(context, notePath);
  return data === null ? null : data.toString('utf8');
}

// ------------------------------------------- incoming-application journal

/*
 * One bounded device-local record at one compile-time name in the owned profile
 * directory. The caller expresses no path, name or component: the helper's
 * JOURNAL_NAME is the only location either command can reach. `expect` is
 * mandatory in the same shape as every other record write, so the journal slot
 * itself serializes transactions -- a new transaction can only claim a slot that
 * is absent or holds the exact closed journal it names.
 */
function writeJournal(context, bytes, expect, transactionId = NO_TRANSACTION) {
  if (expect !== 'absent' && !/^[0-9a-f]{64}$/.test(String(expect || ''))) {
    throw new PersistentIdentityError('invalid-precondition',
      'a journal write requires expect to be "absent" or a 64-hex content hash');
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  invoke(context, { command: 'write-journal', data, expect, transactionId });
}

/*
 * Bytes that do not parse are evidence, not a read error: they are returned
 * intact and named, so a refusal can report the state without destroying it.
 */
function readJournal(context) {
  const output = invoke(context, { command: 'read-journal' });
  const bytes = decodeMaybe(output.journal);
  if (bytes === null) return { bytes: null, hash: null, value: null, malformed: false };
  const parsed = parseRecord(bytes);
  return { bytes, hash: bytesHash(bytes), value: parsed.value, malformed: parsed.malformed };
}

/*
 * Hash of the graph's Markdown/Org notes only. `extra` counts other regular
 * files (a Finder .DS_Store, an editor swap file) so they are visible rather
 * than silently mixed into a claim about note bytes.
 */
function hashGraphNotes(context) {
  const output = invoke(context, { command: 'hash-graph' });
  return { hash: output.hash, count: Number(output.count), extra: Number(output.extra) };
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
    profileBinding: {
      runName: context.runName,
      profileDirectory: context.profileDirectory,
      profileDevice: Number(output.profiledevice),
      profileInode: Number(output.profileinode),
    },
  };
}

// --------------------------------------------------- snapshots and records

/*
 * Rebuild the in-memory selected snapshot from the bytes actually on disk.
 * The caller names the files; the adapter never discovers them, and the
 * content it validates is what the graph really contains.
 */
/*
 * The pure half of snapshotFromDisk: the caller supplies the exact content. The
 * incoming applier uses this to compute, BEFORE any write, the exact snapshot
 * that snapshotFromDisk will produce afterwards, so the intended transaction can
 * be bound to the approval instead of discovered after the fact.
 */
function snapshotFromFiles(graphId, files) {
  let state = createState(graphId);
  const sorted = [...files].sort((left, right) =>
    Buffer.from(left.fileId).compare(Buffer.from(right.fileId)));
  const materialized = [];
  for (const [index, file] of sorted.entries()) {
    const content = file.content;
    if (typeof content !== 'string') {
      throw new PersistentIdentityError('missing-note', `${file.path} has no content`);
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

function snapshotFromDisk(context, graphId, files) {
  return snapshotFromFiles(graphId, files.map((file) => {
    const content = readNote(context, file.path);
    if (content === null) {
      throw new PersistentIdentityError('missing-note', `${file.path} is absent from the graph`);
    }
    return { ...file, content };
  }));
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
  deviceId, replicaId, graphId, graphBinding, profileBinding, transactionId,
  metadataRevision, snapshot, sidecarHash, replica,
}) {
  return {
    schema: DEVICE_RECORD_SCHEMA,
    deviceId,
    replicaId,
    graphId,
    graphBinding,
    profileBinding,
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
    const profileBinding = device.profileBinding || {};
    const actualProfile = records.profileBinding;
    if (profileBinding.runName !== actualProfile.runName
        || profileBinding.profileDirectory !== actualProfile.profileDirectory
        || profileBinding.profileDevice !== actualProfile.profileDevice
        || profileBinding.profileInode !== actualProfile.profileInode) {
      return {
        ...base, outcome: 'refused', code: 'profile-binding-mismatch',
        sidecar, device, recordedBinding: profileBinding, observedBinding: actualProfile,
      };
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
  const step = (name, target, data, expect) => {
    try {
      invoke(context, {
        command: 'write-record', target, transactionId, data, expect,
        failurePoint: failure.step === name ? failure.point : 'none',
      });
      return null;
    } catch (error) {
      if (error.code === 'destination-precondition-failed') {
        return {
          outcome: 'refused', code: 'destination-precondition-failed',
          step: name, transactionId, intent, detail: error.message,
        };
      }
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

  const intentResult = step('intent', 'intent', serialize(intent), 'absent');
  if (intentResult) return intentResult;

  const order = (ordering === 'graph-first'
    ? [['sidecar', 'sidecar', sidecarBytes], ['device', 'device', deviceBytes]]
    : [['device', 'device', deviceBytes], ['sidecar', 'sidecar', sidecarBytes]])
    .filter(([name, , data]) => intent.base[name] !== bytesHash(data));
  for (const [name, target, data] of order) {
    const failed = step(name, target, data, intent.base[name] || 'absent');
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
    graphBinding: records.graphBinding, profileBinding: records.profileBinding, transactionId,
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
    invoke(context, {
      command: 'write-record', target, transactionId, data,
      expect: intent.base[target] || 'absent',
    });
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
/*
 * The deterministic derivation an update publishes: the transaction ID, the
 * sidecar bytes and the device bytes, for one accepted base, one device record
 * and one complete post-update snapshot.
 *
 * It is pure with respect to the store. `updateIdentity` calls it with the
 * snapshot read from disk; the incoming applier calls it with the snapshot it
 * PROJECTS before writing, so the exact transaction, snapshot fingerprint and
 * record bytes can be bound to the operator's approval and proven afterwards
 * rather than discovered from whatever the store happened to publish.
 */
function deriveUpdate({ accepted, probe, request, snapshot }) {
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

  const sidecar = buildSidecar({
    graphId: accepted.graphId, metadataRevision: request.metadataRevision,
    transactionId, snapshot, identity: metadata,
  });
  const sidecarBytes = serialize(sidecar);
  assertPortable(sidecar, sidecarBytes);
  const deviceBytes = serialize(buildDeviceRecord({
    deviceId: probe.device.deviceId, replicaId: probe.device.replicaId,
    graphId: accepted.graphId, graphBinding: probe.graphBinding,
    profileBinding: probe.profileBinding, transactionId,
    metadataRevision: request.metadataRevision, snapshot,
    sidecarHash: bytesHash(sidecarBytes), replica,
  }));
  return { transactionId, sidecarBytes, deviceBytes, snapshot, metadata };
}

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
  const { transactionId, sidecarBytes, deviceBytes } =
    deriveUpdate({ accepted, probe, request, snapshot });
  const outstanding = outstandingDecision(context, probe, transactionId);
  if (outstanding) return outstanding;

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
      graphBinding: probe.graphBinding, profileBinding: probe.profileBinding,
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
    graphBinding: probe.graphBinding, profileBinding: probe.profileBinding, transactionId,
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
function writeRawRecordForTest(context, target, data, transactionId = NO_TRANSACTION, relocate) {
  invoke(context, { command: 'write-record', target, transactionId, data, expect: 'any', relocate });
}

/* Write one record only if its destination is exactly in the expected state. */
function writeRecordExpecting(context, target, data, expect, transactionId = NO_TRANSACTION) {
  invoke(context, { command: 'write-record', target, transactionId, data, expect });
}

/*
 * Write one note while asking the helper to simulate, deterministically and
 * inside the owned run, that the graph or profile directory was renamed aside
 * and replaced between acquisition and the entry re-verification. Test-only.
 */
function putNoteRelocatedForTest(context, notePath, content, relocate) {
  invoke(context, {
    command: 'put-note', notePath, data: Buffer.from(content, 'utf8'),
    transactionId: digest(`note\0${notePath}\0${content}`), expect: 'any', relocate,
  });
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
  deriveUpdate,
  enrollGraph,
  hashGraphNotes,
  initializeOwnedRun,
  openGraph,
  publish,
  putNoteExpecting,
  putNoteFixture,
  putNoteRelocatedForTest,
  readJournal,
  readNote,
  readNoteBytes,
  readRecords,
  recordAssertionFailure,
  recordDiagnostic,
  recover,
  serialize,
  setDiagnosticCase,
  snapshotFromDisk,
  snapshotFromFiles,
  transactionFor,
  updateIdentity,
  writeJournal,
  writeRawRecordForTest,
  writeRecordExpecting,
};
