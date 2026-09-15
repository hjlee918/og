'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeTest = require('node:test');
const { APPROVED_TEST_ROOT } = require('../src/persistence');
const {
  GRAPH_IDENTITY_SCHEMA,
  PROFILE_ROOT,
  enrollGraph,
  hashGraphNotes,
  initializeOwnedRun,
  openGraph,
  adoptCopy,
  publish,
  writeRecordExpecting,
  putNoteFixture,
  putNoteRelocatedForTest,
  readNote,
  readRecords,
  recover,
  serialize,
  recordAssertionFailure,
  setDiagnosticCase,
  updateIdentity,
  writeRawRecordForTest,
} = require('../src/persistent-identity');

/*
 * Every case names itself in the diagnostics, so a failed assertion or a
 * refused helper invocation is attributable to an exact case and its exact
 * owned directories without re-running the suite.
 */
function test(name, body) {
  return nodeTest(name, (context) => {
    setDiagnosticCase(name);
    try {
      return body(context);
    } catch (error) {
      recordAssertionFailure(name, error);
      throw error;
    } finally {
      setDiagnosticCase(null);
    }
  });
}

const helper = process.env.F28_IDENTITY_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !runName || !ownerToken) {
  throw new Error('F28_IDENTITY_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
}
const suffix = process.env.F28_CASE_SUFFIX || '';

const NOTES = [
  { fileId: 'file-anchor', path: 'pages/Anchor Page.md',
    content: '- Anchor page for the persistence stage\n- second English block\n' },
  { fileId: 'file-korean', path: 'pages/기준 대상 페이지.md',
    content: '- 한국어 동기화 실험 문서\n- 두 번째 블록입니다\n' },
  { fileId: 'file-journal', path: 'journals/2026_09_15.md',
    content: '- journal entry / 일지 항목\n' },
];

function graphPath(context, relative = '') {
  return path.join(APPROVED_TEST_ROOT, context.runName, context.graphDirectory, relative);
}

function profilePath(context, relative = '') {
  return path.join(PROFILE_ROOT, context.runName, context.profileDirectory, relative);
}

function owned(caseName) {
  const context = {
    helper,
    runName,
    ownerToken,
    graphDirectory: `g-${caseName}${suffix}`,
    profileDirectory: `p-${caseName}${suffix}`,
  };
  initializeOwnedRun(context);
  return context;
}

function seeded(caseName, notes = NOTES) {
  const context = owned(caseName);
  for (const note of notes) putNoteFixture(context, note.path, note.content);
  return context;
}

function enrollmentRequest(values = {}) {
  return {
    graphId: 'graph-persist-1',
    replicaId: 'replica-persist-1',
    deviceId: 'device-persist-1',
    metadataRevision: 'metadata-1',
    files: NOTES.map((note, index) => ({
      fileId: note.fileId, path: note.path, content: note.content,
      acceptedRevision: `accepted-revision-${index}`,
    })),
    ...values,
  };
}

test('an opened unenrolled graph is never enrolled as a side effect', () => {
  const context = seeded('noauto');
  const before = hashGraphNotes(context);
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'unenrolled');
  const records = readRecords(context);
  assert.equal(records.sidecar, null);
  assert.equal(records.device, null);
  assert.equal(hashGraphNotes(context).hash, before.hash);
});

test('explicit enrollment publishes a sidecar and device record that read back exactly', () => {
  const context = seeded('enroll');
  const result = enrollGraph(context, enrollmentRequest());
  assert.equal(result.outcome, 'accepted');

  const reopened = openGraph(context);
  assert.equal(reopened.outcome, 'accepted');
  assert.equal(reopened.sidecar.schema, GRAPH_IDENTITY_SCHEMA);
  assert.equal(reopened.sidecar.graphId, 'graph-persist-1');
  assert.equal(reopened.sidecar.metadataRevision, 'metadata-1');
  assert.equal(reopened.sidecar.acceptedTransactionId, result.transactionId);
  assert.deepEqual(
    Object.keys(reopened.sidecar.identity.files).sort(),
    ['file-anchor', 'file-journal', 'file-korean'],
  );
  assert.equal(reopened.sidecar.identity.files['file-korean'].path, 'pages/기준 대상 페이지.md');
  assert.equal(reopened.device.replicaId, 'replica-persist-1');
  assert.equal(reopened.device.graphId, 'graph-persist-1');
  assert.equal(reopened.device.acceptedTransactionId, result.transactionId);
  assert.equal(reopened.device.graphBinding.graphDirectory, context.graphDirectory);
});

test('enrollment changes no existing note byte', () => {
  const context = seeded('bytes');
  const before = hashGraphNotes(context);
  assert.equal(before.count, NOTES.length);
  enrollGraph(context, enrollmentRequest());
  const after = hashGraphNotes(context);
  assert.equal(after.hash, before.hash);
  assert.equal(after.count, before.count);
});

test('the sidecar carries no device, replica or absolute-path material', () => {
  const context = seeded('portable');
  enrollGraph(context, enrollmentRequest());
  const records = readRecords(context);
  const text = records.sidecarBytes.toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
    'acceptedSnapshotFingerprint', 'acceptedTransactionId', 'graphId',
    'identity', 'metadataRevision', 'schema', 'selectedGeneration',
  ]);
  for (const forbidden of ['replicaId', 'deviceId', 'cursor', 'lock', 'lease',
    'token', 'secret', 'credential', '/Users/', 'Application Support']) {
    assert.equal(text.includes(forbidden), false, `sidecar must not contain ${forbidden}`);
  }
});

// ------------------------------------------- interruption, ordering, restart

const UPDATED_KOREAN = '- 한국어 동기화 실험 문서\n- 수정된 두 번째 블록\n- 세 번째 블록\n';

function updateRequest(values = {}) {
  return {
    expectedMetadataRevision: 'metadata-1',
    metadataRevision: 'metadata-2',
    files: NOTES.map((note, index) => ({
      fileId: note.fileId,
      path: note.path,
      content: note.fileId === 'file-korean' ? UPDATED_KOREAN : note.content,
      acceptedRevision: note.fileId === 'file-korean'
        ? 'accepted-revision-1-b' : `accepted-revision-${index}`,
    })),
    ...values,
  };
}

test('a subsequent identity update is accepted against a matching validated snapshot', () => {
  const context = seeded('update');
  enrollGraph(context, enrollmentRequest());
  putNoteFixture(context, 'pages/기준 대상 페이지.md', UPDATED_KOREAN);

  const stale = openGraph(context);
  assert.equal(stale.outcome, 'refused');
  assert.equal(stale.code, 'snapshot-mismatch');

  const result = updateIdentity(context, updateRequest());
  assert.equal(result.outcome, 'accepted');

  const reopened = openGraph(context);
  assert.equal(reopened.outcome, 'accepted');
  assert.equal(reopened.sidecar.metadataRevision, 'metadata-2');
  assert.equal(reopened.sidecar.identity.files['file-korean'].acceptedRevision, 'accepted-revision-1-b');
  assert.equal(reopened.sidecar.identity.files['file-anchor'].acceptedRevision, 'accepted-revision-0');
  assert.equal(reopened.device.metadataRevision, 'metadata-2');
  assert.notEqual(reopened.sidecar.acceptedTransactionId, result.transactionId === null);
});

test('an update that drops a known identity without a tombstone is refused', () => {
  const context = seeded('partialupdate');
  enrollGraph(context, enrollmentRequest());
  const result = updateIdentity(context, updateRequest({
    files: updateRequest().files.filter((file) => file.fileId !== 'file-journal'),
  }));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'incomplete-update');
  assert.equal(openGraph(context).sidecar.metadataRevision, 'metadata-1');
});

for (const ordering of ['graph-first', 'profile-first']) {
  const first = ordering === 'graph-first' ? 'sidecar' : 'device';
  const second = ordering === 'graph-first' ? 'device' : 'sidecar';

  test(`${ordering}: interruption before the first record leaves both at base`, () => {
    const context = seeded(`i1${first}`);
    const result = enrollGraph(context, enrollmentRequest(),
      { ordering, failure: { step: first, point: 'after-stage' } });
    assert.equal(result.outcome, 'uncertain-write');
    assert.equal(result.step, first);

    const records = readRecords(context, result.transactionId);
    assert.equal(records.sidecar, null);
    assert.equal(records.device, null);
    assert.equal(records.outstandingIntents.length, 1);
    assert.equal(records.evidence, 1);

    const recovered = recover(context);
    assert.equal(recovered.outcome, 'recovered');
    assert.equal(recovered.classification, 'prepared');
    assert.equal(openGraph(context).outcome, 'accepted');
  });

  test(`${ordering}: a second record staged but not installed rolls forward`, () => {
    const context = seeded(`i2${first}`);
    const result = enrollGraph(context, enrollmentRequest(),
      { ordering, failure: { step: second, point: 'after-stage' } });
    assert.equal(result.outcome, 'uncertain-write');

    const records = readRecords(context, result.transactionId);
    assert.notEqual(records[first], null, `${first} must already be installed`);
    assert.equal(records[second], null, `${second} must not be installed`);
    assert.equal(records.outstandingIntents.length, 1);

    const recovered = recover(context);
    assert.equal(recovered.outcome, 'recovered');
    assert.equal(recovered.classification,
      ordering === 'graph-first' ? 'graph-applied' : 'device-applied');

    const reopened = openGraph(context);
    assert.equal(reopened.outcome, 'accepted');
    assert.equal(reopened.sidecar.acceptedTransactionId, result.transactionId);
    assert.equal(reopened.device.acceptedTransactionId, result.transactionId);
  });

  test(`${ordering}: a second record installed but unverified is already applied`, () => {
    const context = seeded(`i3${first}`);
    const result = enrollGraph(context, enrollmentRequest(),
      { ordering, failure: { step: second, point: 'after-rename' } });
    assert.equal(result.outcome, 'uncertain-write');
    assert.equal(result.code, 'write-outcome-unknown');

    const records = readRecords(context, result.transactionId);
    assert.notEqual(records[first], null);
    assert.notEqual(records[second], null);
    assert.equal(records.outstandingIntents.length, 1);

    const recovered = recover(context);
    assert.equal(recovered.outcome, 'recovered');
    assert.equal(recovered.classification, 'applied');
    assert.equal(openGraph(context).outcome, 'accepted');
  });
}

test('a write that failed before staging is a proven no-write refusal', () => {
  const context = seeded('nowrite');
  const result = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'sidecar', point: 'before-stage' } });
  assert.equal(result.outcome, 'refused-no-write');
  assert.equal(result.code, 'proven-no-write');
  const records = readRecords(context, result.transactionId);
  assert.equal(records.sidecar, null);
  assert.equal(records.graphPending, 0);
});

test('a clear that failed after both records applied resolves as an uncertain clear', () => {
  const context = seeded('uncertainclear');
  const result = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'clear', point: 'after-clear' } });
  assert.equal(result.outcome, 'uncertain-clear');
  assert.equal(result.code, 'clear-outcome-unknown');

  const records = readRecords(context, result.transactionId);
  assert.notEqual(records.sidecar, null);
  assert.notEqual(records.device, null);
  assert.equal(records.outstandingIntents.length, 0);
  assert.equal(records.evidence, 1);

  const recovered = recover(context);
  assert.equal(recovered.outcome, 'none');
  assert.equal(recovered.resolved, 'uncertain-clear');
  assert.equal(openGraph(context).outcome, 'accepted');
});

test('a clear that failed before removing the intent is retried exactly', () => {
  const context = seeded('clearretry');
  const result = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'clear', point: 'before-clear' } });
  assert.equal(result.outcome, 'clear-refused');
  assert.equal(result.code, 'proven-no-clear');
  assert.equal(readRecords(context, result.transactionId).outstandingIntents.length, 1);

  const recovered = recover(context);
  assert.equal(recovered.outcome, 'recovered');
  assert.equal(recovered.classification, 'applied');
  assert.equal(readRecords(context, result.transactionId).outstandingIntents.length, 0);
});

test('the exact retry completes the same transaction without a second identity', () => {
  const context = seeded('retry');
  const first = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'device', point: 'after-stage' } });
  assert.equal(first.outcome, 'uncertain-write');

  const retry = enrollGraph(context, enrollmentRequest());
  assert.equal(retry.outcome, 'accepted');
  assert.equal(retry.retried, true);
  assert.equal(retry.transactionId, first.transactionId);

  const reopened = openGraph(context);
  assert.equal(reopened.sidecar.acceptedTransactionId, first.transactionId);
  assert.deepEqual(Object.keys(reopened.sidecar.identity.files).sort(),
    ['file-anchor', 'file-journal', 'file-korean']);
  assert.equal(readRecords(context).evidence, 1);

  const again = enrollGraph(context, enrollmentRequest());
  assert.equal(again.outcome, 'refused');
  assert.equal(again.code, 'already-enrolled');
});

test('an incompatible transaction is refused while an intent is outstanding', () => {
  const context = seeded('incompatible');
  enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'sidecar', point: 'after-stage' } });
  const other = enrollGraph(context, enrollmentRequest({ metadataRevision: 'metadata-other' }));
  assert.equal(other.outcome, 'refused');
  assert.equal(other.code, 'incompatible-transaction');
  assert.equal(readRecords(context).outstandingIntents.length, 1);
});

// ------------------------------- missing, malformed, stale and mismatched

test('a sidecar without a device record is refused, never re-enrolled', () => {
  const context = seeded('nodevice');
  enrollGraph(context, enrollmentRequest());
  const kept = readRecords(context).sidecarBytes;
  writeRawRecordForTest(context, 'device', Buffer.from('{"schema":"wrong"}\n', 'utf8'));
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'unsupported-schema');
  assert.deepEqual(readRecords(context).sidecarBytes, kept);
});

test('a malformed sidecar is preserved and refused', () => {
  const context = seeded('malformed');
  enrollGraph(context, enrollmentRequest());
  const broken = Buffer.from('{"schema":"f28-graph-identity/1","graphId":"x"}\n', 'utf8');
  writeRawRecordForTest(context, 'sidecar', broken);
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'malformed-record');
  assert.deepEqual(readRecords(context).sidecarBytes, broken);
});

test('a sidecar that is not valid JSON is refused without a reset', () => {
  const context = seeded('notjson');
  enrollGraph(context, enrollmentRequest());
  const broken = Buffer.from('not json at all\n', 'utf8');
  writeRawRecordForTest(context, 'sidecar', broken);
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'malformed-record');
  assert.deepEqual(opened.malformed, ['sidecar']);
  assert.deepEqual(readRecords(context).sidecarBytes, broken);
});

test('a stale device record naming an older metadata revision is refused', () => {
  const context = seeded('stale');
  enrollGraph(context, enrollmentRequest());
  const stale = readRecords(context).device;
  putNoteFixture(context, 'pages/기준 대상 페이지.md', UPDATED_KOREAN);
  updateIdentity(context, updateRequest());
  writeRawRecordForTest(context, 'device', serialize(stale));
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'record-mismatch');
  assert.equal(openGraph(context).sidecar.metadataRevision, 'metadata-2');
});

test('a device record naming different sidecar bytes is refused', () => {
  const context = seeded('hashmismatch');
  enrollGraph(context, enrollmentRequest());
  const device = readRecords(context).device;
  device.sidecarHash = `sha256:${'0'.repeat(64)}`;
  writeRawRecordForTest(context, 'device', serialize(device));
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'record-mismatch');
});

test('a note changed behind the sidecar is a refusal, not a silent rebase', () => {
  const context = seeded('drift');
  enrollGraph(context, enrollmentRequest());
  putNoteFixture(context, 'pages/Anchor Page.md', '- edited outside the adapter\n');
  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'snapshot-mismatch');
  assert.equal(readRecords(context).sidecar.metadataRevision, 'metadata-1');
});

test('an intent whose staged bytes do not match its target is refused', () => {
  const context = seeded('badintent');
  const result = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'sidecar', point: 'after-stage' } });
  const records = readRecords(context, result.transactionId);
  const tampered = records.intent;
  tampered.staged.sidecar = `${tampered.staged.sidecar} `;
  writeRawRecordForTest(context, 'intent', serialize(tampered), result.transactionId);
  const recovered = recover(context);
  assert.equal(recovered.outcome, 'refused');
  assert.equal(recovered.code, 'malformed-intent');
  assert.equal(readRecords(context).outstandingIntents.length, 1);
});

test('a third state under an outstanding intent stops recovery', () => {
  const context = seeded('thirdstate');
  const result = enrollGraph(context, enrollmentRequest(),
    { failure: { step: 'device', point: 'after-stage' } });
  writeRawRecordForTest(context, 'sidecar', Buffer.from('{"schema":"other"}\n', 'utf8'));
  const recovered = recover(context);
  assert.equal(recovered.outcome, 'refused');
  assert.equal(recovered.code, 'recovery-state-mismatch');
  assert.equal(recovered.classification, 'mismatch');
  assert.equal(readRecords(context, result.transactionId).outstandingIntents.length, 1);
});

// ------------------------------------------- traversal and symlink refusal

test('a traversal or non-portable note path is refused', () => {
  const context = seeded('traversal');
  for (const bad of ['../escape.md', 'pages/../../escape.md', '/absolute.md',
    'pages\\windows.md', 'pages//double.md', 'pages/not-a-note.txt']) {
    assert.throws(() => putNoteFixture(context, bad, '- nope\n'),
      (error) => error.code === 'helper-refused', `${bad} must be refused`);
  }
});

test('a symlinked note is refused rather than followed', () => {
  const context = seeded('linknote');
  const target = graphPath(context, 'pages/Anchor Page.md');
  fs.symlinkSync(target, graphPath(context, 'pages/linked.md'));
  assert.throws(() => readNote(context, 'pages/linked.md'),
    (error) => error.code === 'helper-refused');
  assert.throws(() => putNoteFixture(context, 'pages/linked.md', '- through a link\n'),
    (error) => error.code === 'helper-refused');
  assert.equal(fs.readFileSync(target, 'utf8'), NOTES[0].content);
});

test('a symlinked ancestor directory is refused rather than followed', () => {
  const context = seeded('linkdir');
  fs.symlinkSync(graphPath(context, 'pages'), graphPath(context, 'shadow'));
  assert.throws(() => readNote(context, 'shadow/Anchor Page.md'),
    (error) => error.code === 'helper-refused');
  assert.throws(() => putNoteFixture(context, 'shadow/new.md', '- nope\n'),
    (error) => error.code === 'helper-refused');
});

test('a symlinked sidecar container is refused rather than followed', () => {
  const context = seeded('linkmeta');
  fs.mkdirSync(graphPath(context, 'decoy'), { recursive: true });
  fs.symlinkSync(graphPath(context, 'decoy'), graphPath(context, 'logseq'));
  assert.throws(() => enrollGraph(context, enrollmentRequest()),
    (error) => error.code === 'helper-refused');
  assert.equal(fs.existsSync(graphPath(context, 'decoy/.og-sync')), false);
});

// ------------------------------------------------- explicit copied-graph choice

/* Byte-identical copy of an enrolled graph, made only through anchored reads. */
function copyEnrolledGraph(source, caseName) {
  const copy = {
    ...source,
    graphDirectory: `g-${caseName}${suffix}`,
    profileDirectory: source.profileDirectory,
  };
  initializeOwnedRun(copy);
  for (const note of NOTES) putNoteFixture(copy, note.path, readNote(source, note.path));
  writeRawRecordForTest(copy, 'sidecar', readRecords(source).sidecarBytes);
  return copy;
}

test('a copy with identical bytes, paths and sidecar still requires an explicit choice', () => {
  const source = seeded('copysrc');
  enrollGraph(source, enrollmentRequest());
  const copy = copyEnrolledGraph(source, 'copyid');

  assert.deepEqual(readRecords(copy).sidecarBytes, readRecords(source).sidecarBytes);
  assert.equal(hashGraphNotes(copy).hash, hashGraphNotes(source).hash);

  const opened = openGraph(copy);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'copied-graph-choice-required');
  assert.notEqual(opened.recordedBinding.graphDirectory, opened.observedBinding.graphDirectory);
  assert.equal(readRecords(copy).outstandingIntents.length, 0);
});

test('a copy opened with a fresh profile refuses instead of enrolling itself', () => {
  const source = seeded('copysrc2');
  enrollGraph(source, enrollmentRequest());
  const copy = copyEnrolledGraph(source, 'copyfresh');
  const fresh = { ...copy, profileDirectory: `p-copyfresh${suffix}` };
  initializeOwnedRun(fresh);

  const opened = openGraph(fresh);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'missing-device-record');
  assert.equal(readRecords(fresh).device, null);
  assert.equal(openGraph(source).outcome, 'accepted');
});

test('same-lineage/new-replica keeps the graph ID and leaves the sidecar untouched', () => {
  const source = seeded('lineagesrc');
  enrollGraph(source, enrollmentRequest());
  const sourceSidecar = readRecords(source).sidecarBytes;
  const copy = copyEnrolledGraph(source, 'lineagecopy');
  const replica = { ...copy, profileDirectory: `p-lineagecopy${suffix}` };
  initializeOwnedRun(replica);

  const adopted = adoptCopy(replica, {
    choice: 'same-lineage-new-replica',
    replicaId: 'replica-persist-2',
    deviceId: 'device-persist-2',
  });
  assert.equal(adopted.outcome, 'accepted');

  const opened = openGraph(replica);
  assert.equal(opened.outcome, 'accepted');
  assert.equal(opened.sidecar.graphId, 'graph-persist-1');
  assert.equal(opened.device.replicaId, 'replica-persist-2');
  assert.equal(opened.device.graphBinding.graphDirectory, replica.graphDirectory);
  assert.deepEqual(readRecords(replica).sidecarBytes, sourceSidecar);
  assert.deepEqual(readRecords(source).sidecarBytes, sourceSidecar);
  assert.equal(openGraph(source).outcome, 'accepted');
});

test('new-graph-lineage mints a new graph and shares no file identity', () => {
  const source = seeded('newlinsrc');
  enrollGraph(source, enrollmentRequest());
  const sourceSidecar = readRecords(source).sidecarBytes;
  const copy = copyEnrolledGraph(source, 'newlincopy');
  const independent = { ...copy, profileDirectory: `p-newlincopy${suffix}` };
  initializeOwnedRun(independent);

  const adopted = adoptCopy(independent, {
    choice: 'new-graph-lineage',
    graphId: 'graph-persist-independent',
    replicaId: 'replica-independent',
    deviceId: 'device-independent',
    metadataRevision: 'metadata-independent-1',
    files: NOTES.map((note, index) => ({
      fileId: `independent-${note.fileId}`, path: note.path, content: note.content,
      acceptedRevision: `independent-revision-${index}`,
    })),
  });
  assert.equal(adopted.outcome, 'accepted');

  const opened = openGraph(independent);
  assert.equal(opened.outcome, 'accepted');
  assert.equal(opened.sidecar.graphId, 'graph-persist-independent');
  const sourceIds = Object.keys(openGraph(source).sidecar.identity.files);
  const copyIds = Object.keys(opened.sidecar.identity.files);
  assert.equal(copyIds.some((id) => sourceIds.includes(id)), false);
  assert.deepEqual(readRecords(source).sidecarBytes, sourceSidecar);
  assert.equal(openGraph(source).outcome, 'accepted');
});

test('new-graph-lineage refuses a reused graph or file identity', () => {
  const source = seeded('reusesrc');
  enrollGraph(source, enrollmentRequest());
  const copy = copyEnrolledGraph(source, 'reusecopy');
  const independent = { ...copy, profileDirectory: `p-reusecopy${suffix}` };
  initializeOwnedRun(independent);
  const request = {
    choice: 'new-graph-lineage',
    graphId: 'graph-persist-independent',
    replicaId: 'replica-independent',
    deviceId: 'device-independent',
    metadataRevision: 'metadata-independent-1',
    files: NOTES.map((note, index) => ({
      fileId: `independent-${note.fileId}`, path: note.path, content: note.content,
      acceptedRevision: `independent-revision-${index}`,
    })),
  };
  const sameGraph = adoptCopy(independent, { ...request, graphId: 'graph-persist-1' });
  assert.equal(sameGraph.outcome, 'refused');
  assert.equal(sameGraph.code, 'reused-graph-identity');

  const sameFile = adoptCopy(independent, {
    ...request,
    files: request.files.map((file, index) => (index ? file : { ...file, fileId: 'file-anchor' })),
  });
  assert.equal(sameFile.outcome, 'refused');
  assert.equal(sameFile.code, 'reused-file-identity');
  assert.equal(readRecords(independent).device, null);
});

test('an unsupported or absent copy choice is refused rather than guessed', () => {
  const source = seeded('choicesrc');
  enrollGraph(source, enrollmentRequest());
  const copy = copyEnrolledGraph(source, 'choicecopy');
  const replica = { ...copy, profileDirectory: `p-choicecopy${suffix}` };
  initializeOwnedRun(replica);

  for (const choice of [undefined, 'merge', 'same-lineage']) {
    const result = adoptCopy(replica, { choice, replicaId: 'r', deviceId: 'd' });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'unsupported-copy-choice');
  }
  assert.equal(readRecords(replica).device, null);
});

test('adopting a graph that is not in a copy state is refused', () => {
  const context = seeded('notcopy');
  enrollGraph(context, enrollmentRequest());
  const result = adoptCopy(context, {
    choice: 'same-lineage-new-replica', replicaId: 'r2', deviceId: 'd2',
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'no-copy-choice-pending');
});

// ------------------------------------------------ restart and ownership

test('a device record whose sidecar disappeared is refused, never recreated', () => {
  const context = seeded('lostsidecar');
  enrollGraph(context, enrollmentRequest());
  const deviceBefore = readRecords(context).deviceBytes;
  fs.unlinkSync(graphPath(context, 'logseq/.og-sync/identity-v1.json'));

  const opened = openGraph(context);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'missing-sidecar');
  assert.equal(readRecords(context).sidecar, null);
  assert.deepEqual(readRecords(context).deviceBytes, deviceBefore);

  const recovered = recover(context);
  assert.equal(recovered.outcome, 'refused');
  assert.equal(recovered.code, 'missing-sidecar');
  assert.equal(fs.existsSync(graphPath(context, 'logseq/.og-sync/identity-v1.json')), false);
});

test('restart revalidates the actual bytes instead of an accepted-looking record', () => {
  const context = seeded('restart');
  const enrolled = enrollGraph(context, enrollmentRequest());
  assert.equal(enrolled.outcome, 'accepted');

  // A record that still claims this exact accepted transaction, over a graph
  // whose bytes no longer match it.
  putNoteFixture(context, 'journals/2026_09_15.md', '- 재시작 뒤 달라진 일지 항목\n');
  const restarted = openGraph(context);
  assert.equal(restarted.outcome, 'refused');
  assert.equal(restarted.code, 'snapshot-mismatch');
  assert.equal(restarted.sidecar.acceptedTransactionId, enrolled.transactionId);

  // Restoring the exact accepted bytes makes the same evidence validate again.
  putNoteFixture(context, 'journals/2026_09_15.md', NOTES[2].content);
  const settled = openGraph(context);
  assert.equal(settled.outcome, 'accepted');
  assert.equal(settled.sidecar.acceptedTransactionId, enrolled.transactionId);
});

test('a wrong owner token is refused in both owned trees', () => {
  const context = seeded('ownership');
  enrollGraph(context, enrollmentRequest());
  const impostor = { ...context, ownerToken: 'f'.repeat(64) };
  assert.throws(() => readRecords(impostor), (error) => error.code === 'helper-refused');
  assert.throws(() => readNote(impostor, NOTES[0].path), (error) => error.code === 'helper-refused');
  assert.equal(openGraph(context).outcome, 'accepted');
});

test('an unknown run or graph directory is refused rather than created by a read', () => {
  const context = seeded('unknowndir');
  assert.throws(() => readRecords({ ...context, graphDirectory: `g-absent${suffix}` }),
    (error) => error.code === 'helper-refused');
  assert.throws(() => readRecords({ ...context, profileDirectory: `p-absent${suffix}` }),
    (error) => error.code === 'helper-refused');
  assert.equal(fs.existsSync(graphPath({ ...context, graphDirectory: `g-absent${suffix}` })), false);
});

// ------------------------------- review regressions (2026-09-15, batch two)

/*
 * Reproduces the historical sanitizer failure. A Finder-written .DS_Store
 * appeared inside two freshly created graph directories during the slow
 * sanitized run; the tree hash covered every regular file, so two graphs with
 * byte-identical notes hashed differently. The hash must cover note files only,
 * and must report any other regular file rather than silently absorbing it.
 */
test('an operating-system file beside the notes does not change the note hash', () => {
  const context = seeded('osfile');
  const before = hashGraphNotes(context);
  assert.equal(before.extra, 0);

  fs.writeFileSync(graphPath(context, '.DS_Store'), Buffer.alloc(6148, 7));
  fs.writeFileSync(graphPath(context, 'pages/.DS_Store'), Buffer.alloc(6148, 9));

  const after = hashGraphNotes(context);
  assert.equal(after.hash, before.hash, 'note hash must ignore non-note files');
  assert.equal(after.count, before.count);
  assert.equal(after.extra, 2, 'non-note files must be reported, not ignored');
});

test('two graphs with identical notes but different OS files hash identically', () => {
  const left = seeded('osleft');
  const right = seeded('osright');
  fs.writeFileSync(graphPath(left, '.DS_Store'), Buffer.alloc(6148, 1));
  fs.writeFileSync(graphPath(right, '.DS_Store'), Buffer.alloc(6148, 2));
  assert.equal(hashGraphNotes(left).hash, hashGraphNotes(right).hash);
});

test('enrollment leaves the note hash unchanged even beside an OS file', () => {
  const context = seeded('osenroll');
  fs.writeFileSync(graphPath(context, '.DS_Store'), Buffer.alloc(6148, 3));
  const before = hashGraphNotes(context);
  enrollGraph(context, enrollmentRequest());
  const after = hashGraphNotes(context);
  assert.equal(after.hash, before.hash);
  assert.equal(after.count, NOTES.length);
  assert.equal(after.extra, 1);
});

/*
 * A record write must state what it expects the destination to be, and that
 * expectation must be rechecked immediately before the rename. Without it a
 * publication derived from a stale read silently overwrites a record that
 * changed after the read.
 */
test('a record write whose destination changed since the read is refused', () => {
  const context = seeded('precondition');
  enrollGraph(context, enrollmentRequest());
  const accepted = readRecords(context);

  // Something else installs different device bytes after the read.
  const intruder = { ...accepted.device, deviceId: 'device-someone-else' };
  writeRawRecordForTest(context, 'device', serialize(intruder));
  const intruderBytes = readRecords(context).deviceBytes;

  assert.throws(
    () => writeRecordExpecting(context, 'device', accepted.deviceBytes, accepted.deviceHash),
    (error) => error.code === 'destination-precondition-failed'
      && /content differs/.test(error.message),
  );
  assert.deepEqual(readRecords(context).deviceBytes, intruderBytes,
    'the intervening record must be preserved');
});

test('a create whose destination already exists is refused by its precondition', () => {
  const context = seeded('preconditionnew');
  enrollGraph(context, enrollmentRequest());
  const accepted = readRecords(context);
  assert.throws(
    () => writeRecordExpecting(context, 'sidecar', accepted.sidecarBytes, null),
    (error) => error.code === 'destination-precondition-failed'
      && /entry present/.test(error.message),
  );
  assert.deepEqual(readRecords(context).sidecarBytes, accepted.sidecarBytes);
});

test('a publication derived from a stale read refuses instead of overwriting', () => {
  const context = seeded('stalepublish');
  enrollGraph(context, enrollmentRequest());
  const stale = readRecords(context);

  putNoteFixture(context, 'pages/기준 대상 페이지.md', UPDATED_KOREAN);
  const pending = updateIdentity(context, updateRequest());
  assert.equal(pending.outcome, 'accepted');
  const current = readRecords(context);

  // Replay the original enrollment publication, which believed both records
  // were absent, against the newer state that now holds metadata-2.
  const replay = publish(context, {
    kind: 'enroll',
    transactionId: 'c'.repeat(64),
    graphId: 'graph-persist-1',
    replicaId: 'replica-persist-1',
    deviceId: 'device-persist-1',
    base: { sidecarHash: null, deviceHash: null },
    sidecarBytes: stale.sidecarBytes,
    deviceBytes: stale.deviceBytes,
  });
  assert.equal(replay.outcome, 'refused');
  assert.equal(replay.code, 'destination-precondition-failed');
  assert.equal(replay.step, 'sidecar');

  assert.deepEqual(readRecords(context).sidecarBytes, current.sidecarBytes);
  assert.deepEqual(readRecords(context).deviceBytes, current.deviceBytes);
  assert.equal(readRecords(context, 'c'.repeat(64)).outstandingIntents.length, 1,
    'the refused publication leaves its intent as evidence');
});

/*
 * The device record must bind the profile it lives in, not only the graph.
 * Otherwise a record moved between owned profiles is accepted unchanged.
 */
test('a device record moved to another owned profile is refused', () => {
  const context = seeded('profilebind');
  enrollGraph(context, enrollmentRequest());
  const moved = { ...context, profileDirectory: `p-profilebind2${suffix}` };
  initializeOwnedRun(moved);
  writeRawRecordForTest(moved, 'device', readRecords(context).deviceBytes);

  const opened = openGraph(moved);
  assert.equal(opened.outcome, 'refused');
  assert.equal(opened.code, 'profile-binding-mismatch');
  assert.equal(openGraph(context).outcome, 'accepted');
});

test('the device record names the profile it was accepted in', () => {
  const context = seeded('profilenamed');
  enrollGraph(context, enrollmentRequest());
  const device = openGraph(context).device;
  assert.equal(device.profileBinding.profileDirectory, context.profileDirectory);
  assert.equal(device.profileBinding.runName, context.runName);
  assert.equal(typeof device.profileBinding.profileInode, 'number');
});

/*
 * The cooperative lock the contract describes must actually exist, be anchored
 * in the owned profile, and never be followed through a link.
 */
test('the cooperative lock is created in the owned profile and is not followed', () => {
  const context = seeded('lockanchor');
  enrollGraph(context, enrollmentRequest());
  const lockPath = profilePath(context, 'LOCK');
  assert.equal(fs.statSync(lockPath).isFile(), true);
  const before = fs.statSync(lockPath).ino;
  readRecords(context);
  assert.equal(fs.statSync(lockPath).ino, before, 'the lock inode must be stable');

  fs.unlinkSync(lockPath);
  fs.symlinkSync(graphPath(context, 'pages/Anchor Page.md'), lockPath);
  assert.throws(() => readRecords(context), (error) => error.code === 'helper-refused');
  assert.equal(fs.readFileSync(graphPath(context, 'pages/Anchor Page.md'), 'utf8'),
    NOTES[0].content, 'the link target must be untouched');
});

// ------------------------- review regressions (2026-09-15, batch three)

/*
 * A retained descriptor keeps referencing its directory after the pathname is
 * renamed or replaced, so a same-descriptor re-verification was vacuous: it
 * could never detect a substituted entry. The helper now re-opens the
 * parent-relative entry without following and compares device/inode against
 * the retained handle. The relocation is simulated deterministically by the
 * helper itself, inside the owned run, between acquisition and verification —
 * the previous same-descriptor check passed exactly this scenario.
 */
test('a graph directory replaced between acquisition and verification refuses', () => {
  const context = seeded('relocgraph');
  const relocated = `${graphPath(context)}.relocated`;
  assert.equal(fs.existsSync(relocated), false);

  assert.throws(
    () => putNoteRelocatedForTest(context, 'pages/Relocated Page.md', '- relocated note\n', 'graph'),
    (error) => error.code === 'helper-refused'
      && /graph directory entry no longer names/.test(error.message),
  );

  // The renamed-aside original is preserved with its evidence, and refusal
  // after a write does not mean the write did not happen: the note landed in
  // the renamed directory through the retained descriptor.
  for (const note of NOTES) {
    assert.equal(fs.readFileSync(path.join(relocated, note.path), 'utf8'), note.content);
  }
  assert.equal(fs.readFileSync(path.join(relocated, 'pages/Relocated Page.md'), 'utf8'),
    '- relocated note\n');

  // The replacement left at the original entry is preserved too, empty.
  assert.deepEqual(fs.readdirSync(graphPath(context)), []);
});

test('a profile directory replaced between acquisition and verification refuses', () => {
  const context = owned('relocprofile');
  const relocated = `${profilePath(context)}.relocated`;
  assert.equal(fs.existsSync(relocated), false);

  const record = serialize({ schema: 'f28-device-record/1', note: 'relocation fixture' });
  assert.throws(
    () => writeRawRecordForTest(context, 'device', record, undefined, 'profile'),
    (error) => error.code === 'helper-refused'
      && /profile directory entry no longer names/.test(error.message),
  );

  // Refusal after a write does not mean no write happened: the record landed
  // in the renamed-aside profile through the retained descriptor, and the
  // original evidence (owner, lock, evidence directory) is preserved beside it.
  assert.deepEqual(fs.readFileSync(path.join(relocated, 'device.json')), record);
  assert.equal(fs.existsSync(path.join(relocated, 'OWNER')), true);
  assert.equal(fs.existsSync(path.join(relocated, 'LOCK')), true);
  assert.equal(fs.statSync(path.join(relocated, 'evidence')).isDirectory(), true);

  // The replacement left at the original entry is preserved too, empty.
  assert.deepEqual(fs.readdirSync(profilePath(context)), []);
});
