'use strict';

/*
 * Focused acceptance tests for incoming change application, against the REAL
 * anchored helper and the REAL comparison/executor/identity modules on fresh
 * explicitly owned synthetic data. No application is involved and no shared root
 * is ever listed: every path used is composed from the exact owned run and case
 * names this suite creates.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nodeTest = require('node:test');
const { APPROVED_TEST_ROOT } = require('../src/persistence');
const PI = require('../src/persistent-identity');
const IA = require('../src/incoming-application');
const { stableStringify } = require('../src/core');

function test(name, body) {
  return nodeTest(name, (context) => {
    PI.setDiagnosticCase(name);
    try { return body(context); }
    catch (error) { PI.recordAssertionFailure(name, error); throw error; }
    finally { PI.setDiagnosticCase(null); }
  });
}

const helper = process.env.F28_IDENTITY_HELPER;
const runName = process.env.F28_RUN_NAME;
const ownerToken = process.env.F28_OWNER_TOKEN;
if (!helper || !runName || !ownerToken) {
  throw new Error('F28_IDENTITY_HELPER, F28_RUN_NAME and F28_OWNER_TOKEN are required');
}
const suffix = process.env.F28_CASE_SUFFIX || '';

const sha256 = (value) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).digest('hex');

/* The gate this suite injects. The live coordinator supplies the real one. */
const CLOSED = () => ({ closed: true, evidence: 'synthetic: no application in this suite' });
const RUNNING = () => ({ closed: false, running: ['Logseq OG F28 IdentityCapture'] });
const UNCERTAIN = () => ({ closed: false, uncertain: true, reason: 'ps produced no parseable output' });

const NOTES = [
  { fileId: 'file-english', path: 'pages/Incoming Anchor.md',
    content: '- incoming anchor page\n- second English block\n' },
  { fileId: 'file-korean', path: 'pages/수신 기준 문서.md',
    content: '- 수신 변경 실험 문서\n- 두 번째 블록입니다\n' },
  { fileId: 'file-journal', path: 'journals/2026_09_15.md',
    content: '- journal entry / 일지 항목\n' },
];

function graphPath(context, relative = '') {
  return path.join(APPROVED_TEST_ROOT, context.runName, context.graphDirectory, relative);
}
function profilePath(context, relative = '') {
  return path.join(PI.PROFILE_ROOT, context.runName, context.profileDirectory, relative);
}

function owned(caseName) {
  const context = { helper, runName, ownerToken,
    graphDirectory: `g-in-${caseName}${suffix}`, profileDirectory: `p-in-${caseName}${suffix}` };
  PI.initializeOwnedRun(context);
  return context;
}

/* One enrolled synthetic graph at metadata-1, seeded through the explicit
 * fixture writer (never through the incoming path). */
function enrolled(caseName, notes = NOTES) {
  const context = owned(caseName);
  for (const note of notes) PI.putNoteFixture(context, note.path, note.content);
  const result = PI.enrollGraph(context, {
    graphId: 'graph-incoming-1',
    replicaId: 'replica-incoming-local',
    deviceId: 'device-incoming-local',
    metadataRevision: 'metadata-1',
    files: notes.map((note, index) => ({
      fileId: note.fileId, path: note.path, content: note.content,
      acceptedRevision: `accepted-revision-${index}`,
    })),
  });
  assert.equal(result.outcome, 'accepted');
  const opened = PI.openGraph(context);
  assert.equal(opened.outcome, 'accepted');
  return { context, opened };
}

/* The synthetic second replica: one English update plus one Korean create. */
function standardProposal(opened, changes) {
  return IA.buildProposal({
    accepted: opened.sidecar,
    snapshot: opened.snapshot,
    originReplicaId: 'replica-incoming-synthetic-b',
    targetMetadataRevision: 'metadata-2',
    changes: changes || [
      { fileId: 'file-english', path: 'pages/Incoming Anchor.md',
        content: '- incoming anchor page\n- edited on the synthetic second replica\n' },
      { fileId: 'file-new-korean', path: 'pages/수신 새 문서.md',
        content: '- 두 번째 복제본이 새로 만든 문서입니다\n' },
    ],
  });
}

/*
 * A proposal's identity is a digest over its own body, so a test that changes
 * the body must re-seal it -- otherwise every such case would refuse as
 * `proposal-identity-mismatch` before reaching the behaviour it is about. The
 * identity check itself is exercised separately, by NOT re-sealing.
 */
function reseal(proposal) {
  const body = IA.proposalBody(proposal);
  return { ...body, proposalId: sha256(stableStringify(body)) };
}

function applyApproved(context, proposal, extra = {}) {
  const preview = IA.planIncoming(context, proposal);
  assert.equal(preview.outcome, 'preview', `preview refused: ${preview.code} ${preview.reason || ''}`);
  return IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED, ...extra,
  });
}

function journalValue(context) {
  const journal = PI.readJournal(context);
  return { journal, value: journal.value };
}

/* Re-seal every integrity field, so a case reaches the specific check it is
 * about instead of stopping at the approval-linkage check that now runs first. */
function resealJournal(value) {
  value.approved.proposalId = sha256(stableStringify(IA.proposalBodyFrom(value.approved)));
  value.approved.previewFingerprint =
    `sha256:${sha256(stableStringify(IA.previewBodyFrom(value.approved)))}`;
  value.approvedHash = `sha256:${sha256(stableStringify(value.approved))}`;
}

function rewriteJournal(context, mutate) {
  const journal = PI.readJournal(context);
  const value = JSON.parse(JSON.stringify(journal.value));
  mutate(value);
  const bytes = Buffer.from(`${stableStringify(value)}\n`, 'utf8');
  PI.writeJournal(context, bytes, journal.hash.replace(/^sha256:/, ''));
  return bytes;
}

// ============================================================ happy path

test('an approved incoming proposal applies both files and accepts one new revision', () => {
  const { context, opened } = enrolled('happy');
  const proposal = standardProposal(opened);
  const before = PI.hashGraphNotes(context);

  const preview = IA.planIncoming(context, proposal);
  assert.equal(preview.outcome, 'preview');
  assert.equal(preview.mutated, false);
  assert.deepEqual(preview.preview.applyOrder, ['file-english', 'file-new-korean']);
  assert.equal(preview.preview.files[0].precondition,
    sha256(NOTES[0].content), 'an update states the exact base hash');
  assert.equal(preview.preview.files[1].precondition, 'absent', 'a create states absent');
  assert.equal(PI.hashGraphNotes(context).hash, before.hash, 'preview writes nothing');

  const result = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
  });
  assert.equal(result.outcome, 'applied', result.reason || '');
  assert.deepEqual(result.applied, ['file-english', 'file-new-korean']);

  const accepted = PI.openGraph(context);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.sidecar.metadataRevision, 'metadata-2');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'),
    '- incoming anchor page\n- edited on the synthetic second replica\n');
  assert.equal(PI.readNote(context, 'pages/수신 새 문서.md'),
    '- 두 번째 복제본이 새로 만든 문서입니다\n');
  assert.equal(PI.readNote(context, 'pages/수신 기준 문서.md'), NOTES[1].content,
    'an untouched Korean note is byte-identical');

  const { value } = journalValue(context);
  assert.equal(value.state, 'closed');
  assert.equal(value.progress.recordsAccepted, true);
  assert.deepEqual(value.progress.applied, ['file-english', 'file-new-korean']);
});

test('the sidecar stays portable and never carries the origin replica', () => {
  const { context, opened } = enrolled('portable');
  assert.equal(applyApproved(context, standardProposal(opened)).outcome, 'applied');
  const bytes = PI.readRecords(context).sidecarBytes.toString('utf8');
  assert.ok(!bytes.includes('replica-incoming-synthetic-b'));
  assert.ok(!bytes.includes('replicaId') && !bytes.includes('deviceId'));
  assert.ok(!bytes.includes('/Users/'));
});

// ====================================================== base and plan

test('a proposal against any other accepted base is refused, never rebased', () => {
  const { context, opened } = enrolled('base');
  for (const mutate of [
    (p) => { p.base.metadataRevision = 'metadata-99'; },
    (p) => { p.base.snapshotFingerprint = `sha256:${'a'.repeat(64)}`; },
    (p) => { p.base.acceptedTransactionId = 'b'.repeat(64); },
    (p) => { p.graphId = 'graph-somewhere-else'; },
  ]) {
    const proposal = standardProposal(opened);
    mutate(proposal);
    const result = IA.planIncoming(context, reseal(proposal));
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'unknown-base');
    assert.equal(result.mutated, false);
  }
  assert.equal(PI.openGraph(context).sidecar.metadataRevision, 'metadata-1');
});

test('a proposal carrying a plan the modules do not reproduce is refused', () => {
  const { context, opened } = enrolled('plan');
  const proposal = standardProposal(opened);
  proposal.planId = 'plan-0123456789abcdef0123456789abcdef';
  const result = IA.planIncoming(context, reseal(proposal));
  assert.equal(result.code, 'plan-mismatch');
  assert.equal(result.mutated, false);
});

// ====================================================== preview and approval

test('application without an approval, or with a stale one, is refused', () => {
  const { context, opened } = enrolled('approval');
  const proposal = standardProposal(opened);
  const noApproval = IA.applyIncoming(context, { proposal, gate: CLOSED });
  assert.equal(noApproval.code, 'approval-required');
  assert.equal(noApproval.mutated, false);

  const wrong = IA.applyIncoming(context, {
    proposal, approve: `sha256:${'0'.repeat(64)}`, gate: CLOSED,
  });
  assert.equal(wrong.code, 'preview-stale');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
});

test('a local edit between preview and apply makes the approved preview stale', () => {
  const { context, opened } = enrolled('stale');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  assert.equal(preview.outcome, 'preview');

  PI.putNoteFixture(context, 'pages/수신 기준 문서.md', '- 사용자가 직접 고친 내용\n');
  const result = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.mutated, false);
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content,
    'the proposal target was never written');
});

// ====================================================== newer local edits

test('an uncaptured local edit to a proposed file refuses the whole proposal', () => {
  const { context, opened } = enrolled('local-ahead');
  const proposal = standardProposal(opened);
  PI.putNoteFixture(context, 'pages/Incoming Anchor.md', '- the user typed this after enrollment\n');

  const result = IA.planIncoming(context, proposal);
  assert.equal(result.code, 'local-ahead-of-accepted');
  assert.equal(result.mutated, false);
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'),
    '- the user typed this after enrollment\n', 'the local edit is untouched');
  assert.equal(PI.readNote(context, 'pages/수신 새 문서.md'), null,
    'no part of the proposal was applied');
});

test('a create whose destination is already occupied is refused', () => {
  const { context, opened } = enrolled('occupied');
  const proposal = standardProposal(opened);
  PI.putNoteFixture(context, 'pages/수신 새 문서.md', '- something else got there first\n');
  const result = IA.planIncoming(context, proposal);
  assert.equal(result.code, 'destination-occupied');
  assert.equal(PI.readNote(context, 'pages/수신 새 문서.md'), '- something else got there first\n');
});

test('an update whose base file was deleted locally is refused', () => {
  const { context, opened } = enrolled('missing-base');
  const proposal = standardProposal(opened);
  fs.unlinkSync(graphPath(context, 'pages/Incoming Anchor.md'));
  const result = IA.planIncoming(context, proposal);
  assert.equal(result.code, 'missing-base', result.reason);
  assert.equal(result.mutated, false);
});

// ====================================================== helper precondition

test('the helper refuses a write whose destination changed after the preview', () => {
  const { context, opened } = enrolled('precondition');
  const file = opened.sidecar.identity.files['file-english'];
  assert.throws(
    () => PI.putNoteExpecting(context, file.path, Buffer.from('- nope\n', 'utf8'), sha256('different')),
    (error) => error.code === 'destination-precondition-failed');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content,
    'the file is preserved exactly');
});

test('incoming writes cannot fall back to an unconditional overwrite', () => {
  const { context } = enrolled('no-any');
  for (const bad of ['any', '', null, undefined, 'ANY', 'sha256:' + '0'.repeat(64)]) {
    assert.throws(
      () => PI.putNoteExpecting(context, 'pages/Incoming Anchor.md', Buffer.from('x'), bad),
      (error) => error.code === 'invalid-precondition', `expect ${String(bad)} must be refused`);
  }
  assert.throws(() => PI.writeJournal(context, Buffer.from('{}'), 'any'),
    (error) => error.code === 'invalid-precondition');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
});

// ====================================================== paths and parents

test('every disallowed target path shape is refused before the helper is called', () => {
  const { context, opened } = enrolled('paths');
  const shapes = [
    'pages/nested/deep.md', 'pages/note.org', 'logseq/.og-sync/sneak.md',
    'pages/../escape.md', 'pages\\windows.md', 'pages//double.md', '/absolute.md',
    'top-level.md', 'assets/thing.md', 'pages/.md',
  ];
  for (const shape of shapes) {
    assert.throws(() => IA.checkNotePath(shape, 'target'),
      (error) => error.code === 'invalid-path', `${shape} must be refused`);
    const proposal = standardProposal(opened);
    proposal.files[1].path = shape;
    const result = IA.planIncoming(context, reseal(proposal));
    assert.equal(result.outcome, 'refused', `${shape} reached application`);
    assert.equal(result.mutated, false);
  }
  assert.ok(!fs.existsSync(graphPath(context, 'pages/nested')), 'no directory was created');
  assert.ok(!fs.existsSync(graphPath(context, 'assets')), 'no directory was created');
});

test('a target whose parent no accepted file proves is refused', () => {
  // Only pages/ is enrolled here, so journals/ is never proven even though the
  // path syntax is allowed and put-note would happily create it.
  const { context, opened } = enrolled('unproven', [NOTES[0], NOTES[1]]);
  const proposal = IA.buildProposal({
    accepted: opened.sidecar, snapshot: opened.snapshot,
    originReplicaId: 'replica-b', targetMetadataRevision: 'metadata-2',
    changes: [{ fileId: 'file-new-journal', path: 'journals/2026_09_16.md',
      content: '- 새 일지\n' }],
  });
  const result = IA.planIncoming(context, proposal);
  assert.equal(result.code, 'unproven-parent-directory');
  assert.equal(result.mutated, false);
  assert.ok(!fs.existsSync(graphPath(context, 'journals')),
    'the helper was never invoked, so no directory was created');
});

test('a symlink at the destination is preserved and the write refused', () => {
  const { context, opened } = enrolled('symlink');
  const link = graphPath(context, 'pages/수신 새 문서.md');
  fs.symlinkSync(graphPath(context, 'pages/Incoming Anchor.md'), link);
  const result = IA.planIncoming(context, standardProposal(opened));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.mutated, false);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is intact');
  // And the helper itself refuses, independently of the applier's preflight.
  assert.throws(
    () => PI.putNoteExpecting(context, 'pages/수신 새 문서.md', Buffer.from('x'), 'absent'),
    (error) => /not a regular file|precondition/.test(error.message));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

// ====================================================== bytes and bounds

test('bytes that do not round-trip as UTF-8 are refused, never replaced', () => {
  assert.throws(() => IA.decodeNoteHex('ff fe'.replace(' ', ''), 'target'),
    (error) => ['non-roundtrip-bytes', 'malformed-record'].includes(error.code));
  assert.throws(() => IA.decodeNoteHex('fffe', 'target'),
    (error) => error.code === 'non-roundtrip-bytes');
  assert.throws(() => IA.decodeNoteHex('NOTHEX', 'target'),
    (error) => error.code === 'malformed-record');
  const good = IA.encodeNote('- 한국어 ✅\n', 'target');
  assert.equal(IA.decodeNoteHex(good.hex, 'target').text, '- 한국어 ✅\n');
});

test('an oversized note refuses before any note write', () => {
  const { context, opened } = enrolled('oversize');
  const proposal = standardProposal(opened);
  proposal.files[1].targetContentHex = Buffer.from('x'.repeat(IA.MAX_NOTE_BYTES + 1)).toString('hex');
  const result = IA.planIncoming(context, reseal(proposal));
  assert.equal(result.code, 'note-too-large');
  assert.equal(result.mutated, false);
  assert.equal(PI.readNote(context, 'pages/수신 새 문서.md'), null);
  assert.equal(PI.readJournal(context).value, null, 'no journal was created');
});

// ====================================================== outstanding work

test('an unfinished transaction blocks an unrelated new proposal', () => {
  const { context, opened } = enrolled('outstanding');
  const first = applyApproved(context, standardProposal(opened), { failAt: 'after-file:file-english' });
  assert.equal(first.outcome, 'interrupted');
  assert.equal(first.mutated, true);
  assert.deepEqual(first.applied, ['file-english']);

  const unrelated = IA.buildProposal({
    accepted: opened.sidecar, snapshot: opened.snapshot,
    originReplicaId: 'replica-c', targetMetadataRevision: 'metadata-9',
    changes: [{ fileId: 'file-journal', path: 'journals/2026_09_15.md',
      content: '- a completely different proposal\n' }],
  });
  const blocked = IA.planIncoming(context, unrelated);
  assert.equal(blocked.code, 'transaction-outstanding');
  assert.equal(blocked.mutated, false);
  assert.equal(PI.readNote(context, 'journals/2026_09_15.md'), NOTES[2].content,
    'the unrelated proposal never touched its file');

  const stillOpen = journalValue(context).value;
  assert.equal(stillOpen.state, 'open');
  assert.equal(stillOpen.approved.proposalId, first.proposalId);
});

// ====================================================== recovery authority

test('a malformed, tampered or substituted journal never earns the right to write', () => {
  const { context, opened } = enrolled('authority');
  const interruptedRun = applyApproved(context, standardProposal(opened),
    { failAt: 'before-file:file-english' });
  assert.equal(interruptedRun.outcome, 'interrupted');
  assert.deepEqual(interruptedRun.applied, []);
  const pristine = PI.readJournal(context);

  const restore = () => PI.writeJournal(context, pristine.bytes,
    PI.readJournal(context).hash.replace(/^sha256:/, ''));

  const cases = [
    ['journal-approved-tampered', (v) => { v.approved.target.metadataRevision = 'metadata-77'; }],
    ['journal-approved-tampered', (v) => { v.approved.files['file-english'].targetContentHex =
      Buffer.from('- forged\n').toString('hex'); }],
    ['unsupported-schema', (v) => { v.schema = 'f28-incoming-journal/9'; }],
    ['malformed-record', (v) => { delete v.progress.transactionId; }],
    ['malformed-record', (v) => { v.extraKey = true; }],
    ['malformed-record', (v) => { v.progress.applied = ['file-not-in-this-journal']; }],
    ['malformed-record', (v) => { v.state = 'halfway'; }],
  ];
  for (const [code, mutate] of cases) {
    rewriteJournal(context, mutate);
    const result = IA.recoverIncoming(context, { gate: CLOSED });
    assert.equal(result.outcome, 'refused', `${code}: expected a refusal`);
    assert.equal(result.code, code, `${code}: got ${result.code} (${result.reason})`);
    assert.equal(result.mutated, false);
    assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
    restore();
  }

  // applyOrder must be the complete, unique, byte-ordered key set
  for (const mutate of [
    (v) => { v.approved.applyOrder = ['file-english']; },
    (v) => { v.approved.applyOrder = ['file-new-korean', 'file-english']; },
    (v) => { v.approved.applyOrder = ['file-english', 'file-english']; },
    (v) => { v.approved.applyOrder = ['file-english', 'file-new-korean', 'file-ghost']; },
  ]) {
    // applyOrder validity is structural and is checked by validateJournal, which
    // runs before the approval linkage, so only approvedHash needs re-sealing.
    rewriteJournal(context, (v) => {
      mutate(v);
      v.approvedHash = `sha256:${sha256(stableStringify(v.approved))}`;
    });
    const result = IA.recoverIncoming(context, { gate: CLOSED });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'journal-apply-order-invalid', result.reason);
    restore();
  }

  // a journal that parses but is bound to another owned run
  rewriteJournal(context, (v) => {
    v.approved.graphBinding.graphInode += 1;
    resealJournal(v);
  });
  let result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-binding-mismatch');
  assert.equal(result.mutated, false);
  restore();

  rewriteJournal(context, (v) => {
    v.approved.profileBinding.profileDirectory = 'p-somewhere-else';
    resealJournal(v);
  });
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-binding-mismatch');
  restore();

  // A graph-lineage change is now caught earlier, by the approval linkage,
  // because graphId is part of the proposal body.
  rewriteJournal(context, (v) => {
    v.approved.graphId = 'graph-some-other-lineage';
    v.approvedHash = `sha256:${sha256(stableStringify(v.approved))}`;
  });
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-proposal-mismatch', result.reason);
  restore();

  // Re-sealing the proposal identity and the approval fingerprint makes the
  // journal fully self-consistent for a DIFFERENT lineage, which is what the
  // lineage check itself is for.
  rewriteJournal(context, (v) => {
    v.approved.graphId = 'graph-some-other-lineage';
    resealJournal(v);
  });
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-graph-mismatch', result.reason);
  assert.equal(result.mutated, false);
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
  restore();

  // a journal whose plan the modules do not reproduce
  rewriteJournal(context, (v) => {
    v.approved.planId = 'plan-ffffffffffffffffffffffffffffffff';
    resealJournal(v);
  });
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-plan-mismatch', result.reason);
  assert.equal(result.mutated, false);
  restore();

  // a stale journal whose base no longer matches the accepted records
  rewriteJournal(context, (v) => {
    v.approved.base.metadataRevision = 'metadata-0';
    resealJournal(v);
  });
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-base-mismatch', result.reason);
  assert.equal(result.mutated, false);
  restore();

  // unparseable bytes are retained as evidence, not destroyed
  PI.writeJournal(context, Buffer.from('{ not json at all\n', 'utf8'),
    PI.readJournal(context).hash.replace(/^sha256:/, ''));
  result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.code, 'journal-malformed');
  assert.equal(PI.readJournal(context).bytes.toString('utf8'), '{ not json at all\n');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
});

// ====================================================== recovery behaviour

test('recovery rolls forward the remaining files and accepts one revision', () => {
  const { context, opened } = enrolled('roll-forward');
  const first = applyApproved(context, standardProposal(opened),
    { failAt: 'after-file:file-english' });
  assert.equal(first.outcome, 'interrupted');
  assert.deepEqual(first.applied, ['file-english']);
  assert.equal(PI.openGraph(context).outcome, 'refused',
    'the disk is ahead of the sidecar, which the store refuses');

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'recovered', recovered.reason || '');
  assert.deepEqual(recovered.wrote, ['file-new-korean']);
  assert.equal(recovered.progressDisagreement.length, 1,
    'the file written before its progress update disagrees with the journal');
  assert.equal(recovered.progressDisagreement[0].fileId, 'file-english');

  const accepted = PI.openGraph(context);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.sidecar.metadataRevision, 'metadata-2');
  assert.equal(journalValue(context).value.state, 'closed');

  const again = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(again.outcome, 'none');
  assert.equal(again.code, 'journal-closed');
});

test('a third state anywhere in the transaction prevents ALL further note writes', () => {
  const { context, opened } = enrolled('third-state', NOTES);
  // three files, so a third state in the LAST one must block the first two
  const proposal = IA.buildProposal({
    accepted: opened.sidecar, snapshot: opened.snapshot,
    originReplicaId: 'replica-b', targetMetadataRevision: 'metadata-2',
    changes: [
      { fileId: 'file-english', path: 'pages/Incoming Anchor.md',
        content: '- first of three\n' },
      { fileId: 'file-korean', path: 'pages/수신 기준 문서.md',
        content: '- 세 개 중 두 번째\n' },
      { fileId: 'file-journal', path: 'journals/2026_09_15.md',
        content: '- last of three\n' },
    ],
  });
  const run = applyApproved(context, proposal, { failAt: 'before-file:file-english' });
  assert.equal(run.outcome, 'interrupted');
  assert.deepEqual(run.applied, [], 'nothing was applied yet');

  // the LAST file in the apply order goes into a third state
  const order = journalValue(context).value.approved.applyOrder;
  const last = order[order.length - 1];
  const lastPath = journalValue(context).value.approved.files[last].path;
  const beforeImage = journalValue(context).value.approved.files[last].beforeImage.contentHex;
  PI.putNoteFixture(context, lastPath, '- a third value nobody planned\n');

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'third-state');
  assert.equal(recovered.mutated, false);
  assert.equal(recovered.thirdStates.length, 1);
  assert.equal(recovered.thirdStates[0].fileId, last);

  // every earlier, still-pending file was NOT written
  for (const fileId of order.slice(0, -1)) {
    const file = journalValue(context).value.approved.files[fileId];
    assert.equal(sha256(PI.readNote(context, file.path)), file.beforeImage.contentHash,
      `${fileId} must still be at its before-image`);
  }
  // the before-image of the third-state file is the ORIGINAL bytes, which by
  // definition now differ from what is on disk -- that is what a third state is
  assert.equal(journalValue(context).value.approved.files[last].beforeImage.contentHex,
    beforeImage, 'the retained before-image was not modified by the later edit');
  assert.notEqual(sha256(PI.readNote(context, lastPath)),
    journalValue(context).value.approved.files[last].beforeImage.contentHash);
  assert.equal(PI.readNote(context, lastPath), '- a third value nobody planned\n');
  assert.equal(journalValue(context).value.state, 'open', 'the journal is retained open');
});

test('interruption after the records are accepted closes without a second write', () => {
  const { context, opened } = enrolled('records-then-crash');
  const run = applyApproved(context, standardProposal(opened), { failAt: 'after-records' });
  assert.equal(run.outcome, 'interrupted');
  assert.equal(run.recordsAccepted, false, 'the journal never recorded acceptance');

  const accepted = PI.openGraph(context);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.sidecar.metadataRevision, 'metadata-2',
    'the store did accept before the journal could be closed');
  const sidecarBefore = PI.readRecords(context).sidecarHash;

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'recovered', recovered.reason || '');
  assert.deepEqual(recovered.wrote, [], 'no note was rewritten');
  assert.equal(recovered.recordsAlreadyAccepted, true);
  assert.equal(PI.readRecords(context).sidecarHash, sidecarBefore,
    'no second identity update happened');
  assert.equal(journalValue(context).value.state, 'closed');
});

test('a retained journal is never overwritten and a second proposal is refused', () => {
  const { context, opened } = enrolled('slot');
  assert.equal(applyApproved(context, standardProposal(opened)).outcome, 'applied');
  const first = PI.readJournal(context);
  assert.equal(first.value.state, 'closed');

  const next = PI.openGraph(context);
  const second = IA.buildProposal({
    accepted: next.sidecar, snapshot: next.snapshot,
    originReplicaId: 'replica-b', targetMetadataRevision: 'metadata-3',
    changes: [{ fileId: 'file-korean', path: 'pages/수신 기준 문서.md',
      content: '- 두 번째 수신 적용\n' }],
  });
  // Refused at BOTH phases, so no approvable preview is ever produced for work
  // that application will refuse.
  const preview = IA.planIncoming(context, second);
  assert.equal(preview.outcome, 'refused');
  assert.equal(preview.code, 'journal-slot-occupied');
  const applied = IA.applyIncoming(context, {
    proposal: second, approve: 'sha256:' + '0'.repeat(64), gate: CLOSED,
  });
  assert.equal(applied.outcome, 'refused');
  assert.equal(applied.code, 'journal-slot-occupied');
  assert.equal(applied.mutated, false);

  assert.equal(PI.readJournal(context).hash, first.hash,
    'the retained journal is preserved byte-for-byte, before-images included');
  assert.equal(PI.readNote(context, 'pages/수신 기준 문서.md'), NOTES[1].content,
    'the refused proposal never touched its file');
  assert.equal(PI.openGraph(context).sidecar.metadataRevision, 'metadata-2');
});

test('a retained journal that does not parse also refuses a new proposal', () => {
  const { context, opened } = enrolled('slot-malformed');
  assert.equal(applyApproved(context, standardProposal(opened)).outcome, 'applied');
  const before = PI.readJournal(context);
  PI.writeJournal(context, Buffer.from('{ not json\n', 'utf8'),
    before.hash.replace(/^sha256:/, ''));
  const next = PI.openGraph(context);
  const second = IA.buildProposal({
    accepted: next.sidecar, snapshot: next.snapshot,
    originReplicaId: 'replica-b', targetMetadataRevision: 'metadata-3',
    changes: [{ fileId: 'file-korean', path: 'pages/수신 기준 문서.md', content: '- 또 다른 변경\n' }],
  });
  const result = IA.planIncoming(context, second);
  assert.equal(result.code, 'journal-malformed');
  assert.equal(result.mutated, false);
  assert.equal(PI.readJournal(context).bytes.toString('utf8'), '{ not json\n',
    'the unparseable journal is retained exactly');
});

// ====================================================== app-closed gate

test('a running or uncertain app refuses every write, and the gate is rechecked', () => {
  const { context, opened } = enrolled('gate');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);

  for (const [gate, code] of [[RUNNING, 'app-running'], [UNCERTAIN, 'app-state-uncertain'],
    [undefined, 'app-state-uncertain'], [() => { throw new Error('ps failed'); }, 'app-state-uncertain']]) {
    const result = IA.applyIncoming(context, {
      proposal, approve: preview.preview.previewFingerprint, gate,
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, code);
    assert.equal(result.mutated, false);
    assert.equal(PI.readJournal(context).value, null, 'no journal was created');
  }
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);

  // the gate is re-evaluated per write, not once: allow the journal, then refuse
  let calls = 0;
  const flips = () => { calls += 1; return calls <= 1 ? { closed: true } : { closed: false }; };
  const midway = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: flips,
  });
  assert.equal(midway.outcome, 'interrupted');
  assert.equal(midway.code, 'app-running');
  assert.deepEqual(midway.applied, [], 'the app reopened before the first note write');
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
  assert.equal(journalValue(context).value.state, 'open', 'the journal is retained for recovery');
});

// ====================================================== containment

test('the incoming path writes only inside the owned run', () => {
  const { context, opened } = enrolled('containment');
  assert.equal(applyApproved(context, standardProposal(opened)).outcome, 'applied');
  const graph = graphPath(context);
  const profile = profilePath(context);
  assert.equal(fs.realpathSync(graph), graph);
  assert.equal(fs.realpathSync(profile), profile);
  assert.ok(graph.startsWith(path.join(APPROVED_TEST_ROOT, runName) + path.sep));
  assert.ok(profile.startsWith(path.join(PI.PROFILE_ROOT, runName) + path.sep));
  assert.ok(fs.existsSync(profilePath(context, 'incoming-journal.json')),
    'the journal is at its fixed name in the owned profile directory');
  assert.ok(fs.existsSync(graphPath(context, 'logseq/.og-sync/identity-v1.json')));
});

// ============================================ supervisor findings, corrected

/*
 * Finding 1. Recovery used to treat a target metadata revision as acceptance.
 * It ignored an outstanding identity transaction, skipped record recovery
 * entirely, and closed the incoming journal as recovered with a null
 * transaction ID. These are the boundaries that must now hold.
 */
test('a device-step failure after the sidecar advances is resolved, not declared complete', () => {
  const { context, opened } = enrolled('device-step');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  assert.equal(preview.outcome, 'preview');
  const bound = preview.preview.target;
  assert.match(bound.transactionId, /^[0-9a-f]{64}$/);
  assert.match(bound.snapshotFingerprint, /^sha256:[0-9a-f]{64}$/);

  // graph-first publication fails after the sidecar lands, before the device record
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    recordFailure: { step: 'device', point: 'after-stage' },
  });
  assert.equal(run.outcome, 'interrupted');
  assert.equal(run.code, 'records-uncertain');

  const mid = PI.readRecords(context);
  assert.equal(mid.sidecar.metadataRevision, 'metadata-2', 'the sidecar advanced');
  assert.equal(mid.device.metadataRevision, 'metadata-1', 'the device record did not');
  assert.equal(mid.outstandingIntents.length, 1);
  assert.equal(mid.outstandingIntents[0], bound.transactionId,
    'the outstanding transaction is the one the approval bound');
  assert.equal(PI.openGraph(context).outcome, 'recovery-required');
  assert.equal(journalValue(context).value.state, 'open',
    'the incoming journal is NOT closed while the record transaction is unresolved');

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'recovered', recovered.reason || '');
  assert.equal(recovered.resolution, 'store-recovered:graph-applied',
    'the record store resolved it through its own recovery contract');
  assert.deepEqual(recovered.wrote, [], 'no note was rewritten');
  assert.equal(recovered.transactionId, bound.transactionId);

  assert.equal(PI.readRecords(context).outstandingIntents.length, 0);
  const accepted = PI.openGraph(context);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.sidecar.acceptedTransactionId, bound.transactionId);
  assert.equal(accepted.sidecar.acceptedSnapshotFingerprint, bound.snapshotFingerprint);
  assert.equal(journalValue(context).value.state, 'closed');
  assert.equal(journalValue(context).value.progress.transactionId, bound.transactionId,
    'the closed journal names the real transaction, not null');
});

test('an outstanding transaction that is not ours is never resolved or ignored', () => {
  const { context, opened } = enrolled('foreign-tx');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: 'after-file:file-english',
  });
  assert.equal(run.outcome, 'interrupted');

  // an unrelated identity transaction becomes outstanding
  const files = Object.entries(PI.readRecords(context).sidecar.identity.files)
    .map(([fileId, entry]) => ({ fileId, path: entry.path,
      content: PI.readNote(context, entry.path), acceptedRevision: entry.acceptedRevision }));
  const foreign = PI.updateIdentity(context, {
    expectedMetadataRevision: 'metadata-1', metadataRevision: 'metadata-77',
    files, tombstones: [],
  }, { ordering: 'graph-first', failure: { step: 'device', point: 'after-stage' } });
  assert.equal(foreign.outcome, 'uncertain-write');

  const result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'unrelated-outstanding-transaction');
  assert.equal(result.mutated, false);
  assert.equal(PI.readRecords(context).outstandingIntents.length, 1,
    'the foreign transaction is left exactly as it was');
  assert.equal(journalValue(context).value.state, 'open');
});

test('a journal labelled closed whose records moved on is not trusted', () => {
  const { context, opened } = enrolled('false-closed');
  assert.equal(applyApproved(context, standardProposal(opened)).outcome, 'applied');
  assert.equal(journalValue(context).value.state, 'closed');
  assert.equal(IA.recoverIncoming(context, { gate: CLOSED }).code, 'journal-closed',
    'a genuinely complete transaction verifies');

  const now = PI.openGraph(context);
  const files = Object.entries(now.sidecar.identity.files)
    .map(([fileId, entry]) => ({ fileId, path: entry.path,
      content: PI.readNote(context, entry.path), acceptedRevision: entry.acceptedRevision }));
  assert.equal(PI.updateIdentity(context, {
    expectedMetadataRevision: 'metadata-2', metadataRevision: 'metadata-9', files, tombstones: [],
  }).outcome, 'accepted');

  const result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'closed-journal-not-verified');
  assert.equal(result.mutated, false);
});

/*
 * Finding 2. The approval used to carry whatever revision the proposal named,
 * and the proposal's own identity was never recomputed, so a changed body kept
 * a valid-looking ID and produced an identical approval fingerprint.
 */
test('the stored revision is derived from the plan, not chosen by the proposal', () => {
  const { context, opened } = enrolled('derived-revision');
  const proposal = standardProposal(opened);
  assert.ok(!('acceptedRevision' in proposal.files[0]),
    'a proposal cannot express a revision at all');

  const preview = IA.planIncoming(context, proposal);
  for (const file of preview.preview.files) {
    assert.match(file.acceptedRevision, /^compare-revision-[0-9a-f]{32}$/,
      'the revision is the deterministic compare-revision');
  }
  assert.equal(applyApproved(context, proposal).outcome, 'applied');
  const stored = PI.openGraph(context).sidecar.identity.files;
  for (const file of preview.preview.files) {
    assert.equal(stored[file.fileId].acceptedRevision, file.acceptedRevision,
      'exactly the revision the approval bound was stored');
  }
});

test('a changed proposal body keeping its identity is refused', () => {
  const { context, opened } = enrolled('proposal-identity');
  const proposal = standardProposal(opened);
  for (const mutate of [
    (p) => { p.files[0].targetContentHex = Buffer.from('- forged\n').toString('hex'); },
    (p) => { p.target.metadataRevision = 'metadata-88'; },
    (p) => { p.originReplicaId = 'replica-somewhere-else'; },
    (p) => { p.files[0].path = 'pages/수신 기준 문서.md'; },
  ]) {
    const forged = JSON.parse(JSON.stringify(proposal));
    mutate(forged);
    const result = IA.planIncoming(context, forged);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'proposal-identity-mismatch', result.reason);
    assert.equal(result.mutated, false);
  }
  assert.equal(PI.readNote(context, 'pages/Incoming Anchor.md'), NOTES[0].content);
});

test('proposal field types and the plan identity are validated strictly', () => {
  const { context, opened } = enrolled('strict-types');
  const base = standardProposal(opened);
  const reid = (p) => { delete p.proposalId; return p; };
  for (const [label, mutate] of [
    ['bad planId', (p) => { p.planId = 'not-a-plan-id'; }],
    ['planId wrong length', (p) => { p.planId = 'plan-abc'; }],
    ['empty graphId', (p) => { p.graphId = ''; }],
    ['empty fileId', (p) => { p.files[0].fileId = ''; }],
    ['non-string target revision', (p) => { p.target.metadataRevision = 7; }],
    ['bad base fingerprint', (p) => { p.base.snapshotFingerprint = 'nope'; }],
    ['bad base transaction', (p) => { p.base.acceptedTransactionId = 'nope'; }],
    ['extra file key', (p) => { p.files[0].acceptedRevision = 'chosen-by-caller'; }],
  ]) {
    const forged = reid(JSON.parse(JSON.stringify(base)));
    mutate(forged);
    forged.proposalId = base.proposalId;
    const result = IA.planIncoming(context, forged);
    assert.equal(result.outcome, 'refused', label);
    assert.ok(['malformed-record', 'proposal-identity-mismatch'].includes(result.code),
      `${label}: ${result.code}`);
  }
});

/*
 * The related consistency check: acceptRecords used to reread current bytes and
 * stamp the intended revision on them, whichever bytes those happened to be.
 */
test('drift is classified honestly and never silently adopted', () => {
  const { context, opened } = enrolled('drift');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: 'after-file:file-new-korean',
  });
  assert.equal(run.outcome, 'interrupted');

  // a file OUTSIDE the transaction changes before the record step is retried
  PI.putNoteFixture(context, 'pages/수신 기준 문서.md', '- 사용자가 직접 고친 내용\n');
  const verdict = IA.revalidateIntendedState(context, journalValue(context).value.approved);
  assert.equal(verdict.code, 'unrelated-local-change');
  assert.equal(verdict.detail.drift[0].fileId, 'file-korean');

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.notEqual(recovered.outcome, 'recovered',
    'an unrelated local change is never adopted into the accepted metadata');
  assert.equal(PI.readNote(context, 'pages/수신 기준 문서.md'), '- 사용자가 직접 고친 내용\n',
    'the local edit is preserved exactly');
  assert.equal(journalValue(context).value.state, 'open');
});

test('a transaction file that no longer holds its approved target is target-divergence', () => {
  const { context, opened } = enrolled('divergence');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: 'after-file:file-new-korean',
  });
  assert.equal(run.outcome, 'interrupted');
  const approved = journalValue(context).value.approved;
  const applied = approved.applyOrder.find((id) => run.applied.includes(id));
  PI.putNoteFixture(context, approved.files[applied].path, '- a third value\n');
  const verdict = IA.revalidateIntendedState(context, approved);
  assert.equal(verdict.code, 'target-divergence');
  assert.equal(verdict.detail.drift[0].fileId, applied);
});

/*
 * Invalid recovery authority must be rejected BEFORE any recovery note
 * mutation. The earlier version of this test asserted only that metadata did
 * not advance, which the implementation satisfied while still writing every
 * pending note first and refusing afterwards at the record step. Each case here
 * therefore gets its own fresh owned case, is stopped before the FIRST note
 * write, and asserts the notes themselves.
 */

/* Rewrite the journal, recomputing whichever integrity fields the case keeps
 * consistent. `hashes: 'approved'` keeps only approvedHash valid; 'approval'
 * additionally re-seals the approval fingerprint, so the case reaches the
 * deeper binding check instead of stopping at the linkage check. */
function forgeJournal(context, mutate, hashes = 'approved') {
  const journal = PI.readJournal(context);
  const value = JSON.parse(JSON.stringify(journal.value));
  mutate(value);
  if (hashes === 'approval') {
    value.approved.previewFingerprint =
      `sha256:${sha256(stableStringify(IA.previewBodyFrom(value.approved)))}`;
  }
  value.approvedHash = `sha256:${sha256(stableStringify(value.approved))}`;
  PI.writeJournal(context, Buffer.from(`${stableStringify(value)}\n`, 'utf8'),
    journal.hash.replace(/^sha256:/, ''));
  return PI.readJournal(context).hash;
}

const WATCHED = ['pages/Incoming Anchor.md', 'pages/수신 기준 문서.md',
  'pages/수신 새 문서.md', 'journals/2026_09_15.md'];

function noteState(context) {
  return Object.fromEntries(WATCHED.map((path) => [path, PI.readNote(context, path)]));
}

/* One fresh case, stopped before the first note write, with nothing applied. */
function stoppedBeforeFirstWrite(caseName) {
  const { context, opened } = enrolled(caseName);
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  assert.equal(preview.outcome, 'preview');
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: `before-file:${preview.preview.applyOrder[0]}`,
  });
  assert.equal(run.outcome, 'interrupted');
  assert.deepEqual(run.applied, [], 'nothing was applied');
  return { context, opened, preview, notes: noteState(context),
    records: PI.readRecords(context) };
}

function assertNothingMutated(state, journalHash, label) {
  const { context, notes, records } = state;
  const after = noteState(context);
  for (const path of WATCHED) {
    assert.equal(after[path], notes[path], `${label}: ${path} must be byte-identical`);
  }
  assert.equal(after['pages/수신 새 문서.md'], null,
    `${label}: the create target must remain absent`);
  assert.equal(PI.readJournal(context).hash, journalHash,
    `${label}: the journal bytes must be unchanged`);
  const now = PI.readRecords(context);
  assert.equal(now.sidecar.metadataRevision, records.sidecar.metadataRevision,
    `${label}: metadata must not advance`);
  assert.equal(now.sidecarHash, records.sidecarHash, `${label}: sidecar bytes unchanged`);
  assert.equal(now.deviceHash, records.deviceHash, `${label}: device bytes unchanged`);
  assert.equal(now.outstandingIntents.length, 0, `${label}: no intent may be created`);
  assert.equal(journalValue(context).value.state, 'open', `${label}: the journal stays open`);
}

test('a substituted target transaction is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-transaction');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.transactionId = 'f'.repeat(64); }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-target-mismatch', result.reason);
  assert.deepEqual(result.bindingMismatch, ['transactionId']);
  assertNothingMutated(state, hash, 'substituted transactionId');
});

test('a substituted target snapshot is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-snapshot');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.snapshotFingerprint = `sha256:${'e'.repeat(64)}`; }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-target-mismatch', result.reason);
  assert.ok(result.bindingMismatch.includes('snapshotFingerprint'));
  assertNothingMutated(state, hash, 'substituted snapshotFingerprint');
});

test('a substituted sidecar record hash is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-sidecar');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.sidecarHash = `sha256:${'d'.repeat(64)}`; }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.code, 'journal-target-mismatch', result.reason);
  assert.deepEqual(result.bindingMismatch, ['sidecarHash']);
  assertNothingMutated(state, hash, 'substituted sidecarHash');
});

test('a substituted device record hash is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-device');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.deviceHash = `sha256:${'c'.repeat(64)}`; }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.code, 'journal-target-mismatch', result.reason);
  assert.deepEqual(result.bindingMismatch, ['deviceHash']);
  assertNothingMutated(state, hash, 'substituted deviceHash');
});

test('a substituted stored revision is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-revision');
  const target = state.preview.preview.applyOrder[0];
  const hash = forgeJournal(state.context, (v) => {
    v.approved.files[target].acceptedRevision = 'compare-revision-00000000000000000000000000000000';
  }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-revision-mismatch', result.reason);
  assert.equal(result.fileId, target);
  assertNothingMutated(state, hash, 'substituted stored revision');
});

test('a substituted revision for a file outside the transaction is refused', () => {
  const state = stoppedBeforeFirstWrite('sub-unchanged-revision');
  const outside = Object.keys(journalValue(state.context).value.approved.unchanged)[0];
  const hash = forgeJournal(state.context, (v) => {
    v.approved.unchanged[outside].acceptedRevision = 'accepted-revision-somewhere-else';
  }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.code, 'journal-revision-mismatch', result.reason);
  assertNothingMutated(state, hash, 'substituted unchanged revision');
});

test('a plausible approval fingerprint is not proof of the approved proposal', () => {
  // originReplicaId is part of the PROPOSAL body but not the preview body, so
  // re-sealing the approval fingerprint leaves it looking entirely consistent.
  const state = stoppedBeforeFirstWrite('linkage-proposal');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.originReplicaId = 'replica-somewhere-else'; }, 'approval');
  const journal = journalValue(state.context).value;
  assert.equal(journal.approvedHash,
    `sha256:${sha256(stableStringify(journal.approved))}`, 'approvedHash is self-consistent');
  assert.equal(journal.approved.previewFingerprint,
    `sha256:${sha256(stableStringify(IA.previewBodyFrom(journal.approved)))}`,
    'the approval fingerprint reconstructs');

  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-proposal-mismatch', result.reason);
  assertNothingMutated(state, hash, 'substituted originReplicaId');
});

test('a self-consistent approvedHash is not proof of the approved values', () => {
  const state = stoppedBeforeFirstWrite('linkage-approval');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.transactionId = 'a'.repeat(64); }, 'approved');
  const journal = journalValue(state.context).value;
  assert.equal(journal.approvedHash, `sha256:${sha256(stableStringify(journal.approved))}`);

  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-approval-mismatch', result.reason);
  assertNothingMutated(state, hash, 'approvedHash alone');
});

test('a substituted plan projection is refused before any note is written', () => {
  const state = stoppedBeforeFirstWrite('sub-plan-projection');
  const hash = forgeJournal(state.context,
    (v) => { v.approved.planProjectedSnapshotFingerprint = `sha256:${'b'.repeat(64)}`; }, 'approval');
  const result = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(result.code, 'journal-plan-mismatch', result.reason);
  assertNothingMutated(state, hash, 'substituted plan projection');
});

test('an untampered journal still rolls the remaining files forward', () => {
  // The valid partial-recovery case: the first file landed, the second did not.
  const { context, opened } = enrolled('valid-partial');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const order = preview.preview.applyOrder;
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: `after-file:${order[0]}`,
  });
  assert.equal(run.outcome, 'interrupted');
  assert.deepEqual(run.applied, [order[0]]);

  const recovered = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'recovered', recovered.reason || '');
  assert.deepEqual(recovered.wrote, [order[1]], 'only the remaining file was written');
  assert.equal(recovered.transactionId, preview.preview.target.transactionId);

  const accepted = PI.openGraph(context);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.sidecar.metadataRevision, 'metadata-2');
  assert.equal(accepted.sidecar.acceptedTransactionId, preview.preview.target.transactionId);
  assert.equal(accepted.sidecar.acceptedSnapshotFingerprint,
    preview.preview.target.snapshotFingerprint);
  assert.equal(journalValue(context).value.state, 'closed');
});

test('a forged journal that is later restored recovers normally', () => {
  const state = stoppedBeforeFirstWrite('forge-then-restore');
  const pristine = PI.readJournal(state.context);
  const hash = forgeJournal(state.context,
    (v) => { v.approved.target.transactionId = 'f'.repeat(64); }, 'approval');
  assert.equal(IA.recoverIncoming(state.context, { gate: CLOSED }).code,
    'journal-target-mismatch');
  assertNothingMutated(state, hash, 'before restore');

  PI.writeJournal(state.context, pristine.bytes,
    PI.readJournal(state.context).hash.replace(/^sha256:/, ''));
  const recovered = IA.recoverIncoming(state.context, { gate: CLOSED });
  assert.equal(recovered.outcome, 'recovered', recovered.reason || '');
  assert.deepEqual(recovered.wrote, state.preview.preview.applyOrder,
    'both files rolled forward once the journal was honest again');
  assert.equal(PI.openGraph(state.context).sidecar.acceptedTransactionId,
    state.preview.preview.target.transactionId);
});

test('an outstanding transaction with unapplied files refuses before any write', () => {
  const { context, opened } = enrolled('outstanding-pending');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const run = IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: `before-file:${preview.preview.applyOrder[0]}`,
  });
  assert.equal(run.outcome, 'interrupted');
  assert.deepEqual(run.applied, []);
  const notes = noteState(context);
  const journalHash = PI.readJournal(context).hash;

  // an unrelated identity transaction becomes outstanding while files are pending
  const files = Object.entries(PI.readRecords(context).sidecar.identity.files)
    .map(([fileId, entry]) => ({ fileId, path: entry.path,
      content: PI.readNote(context, entry.path), acceptedRevision: entry.acceptedRevision }));
  assert.equal(PI.updateIdentity(context, {
    expectedMetadataRevision: 'metadata-1', metadataRevision: 'metadata-55', files, tombstones: [],
  }, { ordering: 'graph-first', failure: { step: 'device', point: 'after-stage' } }).outcome,
  'uncertain-write');

  const result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  // the unrelated intent is caught first and named for what it is
  assert.equal(result.code, 'unrelated-outstanding-transaction', result.reason);
  assert.equal(result.mutated, false);
  const after = noteState(context);
  for (const path of WATCHED) assert.equal(after[path], notes[path], `${path} unchanged`);
  assert.equal(PI.readJournal(context).hash, journalHash);
  assert.equal(PI.readRecords(context).outstandingIntents.length, 1,
    'the unrelated transaction is left exactly as it was');
});

test('records accepted at the target with files still pending refuses before any write', () => {
  const { context, opened } = enrolled('accepted-pending');
  const proposal = standardProposal(opened);
  const preview = IA.planIncoming(context, proposal);
  const order = preview.preview.applyOrder;
  // apply everything and accept the records, then put one file back to its
  // before-image so recovery sees an accepted target with a pending file
  assert.equal(IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: 'after-records',
  }).outcome, 'interrupted');
  assert.equal(PI.openGraph(context).sidecar.metadataRevision, 'metadata-2');

  const approved = journalValue(context).value.approved;
  const revert = approved.files[order[0]];
  PI.putNoteFixture(context, revert.path,
    Buffer.from(revert.beforeImage.contentHex, 'hex').toString('utf8'));
  const notes = noteState(context);
  const journalHash = PI.readJournal(context).hash;
  const records = PI.readRecords(context);

  const result = IA.recoverIncoming(context, { gate: CLOSED });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'journal-base-mismatch', result.reason);
  assert.equal(result.mutated, false);
  const after = noteState(context);
  for (const path of WATCHED) assert.equal(after[path], notes[path], `${path} unchanged`);
  assert.equal(PI.readJournal(context).hash, journalHash);
  assert.equal(PI.readRecords(context).sidecarHash, records.sidecarHash);
});
