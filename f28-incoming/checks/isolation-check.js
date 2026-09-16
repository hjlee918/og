#!/usr/bin/env node
'use strict';

/*
 * The coordinator's exact wiring, exercised headless against the REAL anchored
 * helper and the REAL modules on a fresh scratch owned run. No application is
 * launched, no packaged build is touched, and neither shared root is listed.
 *
 * This is the check that runs BEFORE the live batch: it covers the app-closed
 * gate's own logic (which the live batch can only exercise in two states) and
 * one complete proposal -> preview -> approval -> application -> recovery cycle
 * through the same functions the live coordinator calls.
 */

const crypto = require('crypto');
const path = require('path');
const {makeGate, makeIdleGate, ownedProcesses} = require('./app-closed-gate');
const PI = require('../../f28-sync-prototype/src/persistent-identity');
const IA = require('../../f28-sync-prototype/src/incoming-application');

const helper = process.env.F28_IDENTITY_HELPER;
if (!helper) throw new Error('F28_IDENTITY_HELPER must name the built identity_store_helper binary');

let passed = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
  if (!ok) {
    console.error(JSON.stringify(detail, null, 2));
    throw new Error(id);
  }
  passed += 1;
};

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runName = `f28-incoming-iso-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const ownerToken = crypto.randomBytes(32).toString('hex');
  const context = {helper, runName, ownerToken,
    graphDirectory: 'graph', profileDirectory: 'identity-state'};

  // ------------------------------------------------------------- the gate
  const built = {exe: '/nowhere/Logseq-OG-F28-IsolationProbe'};
  const psLine = (name) => `  1234 ${name}\n  5678 someone-else\n`;

  check('gate-closed-when-tree-dead-and-no-named-process',
    makeGate(built, [[999999]], {
      alive: () => false, run: () => psLine('Some-Other-App'),
    })('t').closed === true, {});

  check('gate-refuses-when-a-retained-pid-is-alive',
    makeGate(built, [[999999]], {
      alive: () => true, run: () => psLine('Some-Other-App'),
    })('t').closed === false, {});

  check('gate-refuses-when-the-exact-executable-name-is-running',
    makeGate(built, [[]], {
      alive: () => false, run: () => psLine('Logseq-OG-F28-IsolationProbe'),
    })('t').closed === false, {});

  for (const [label, run] of [
    ['ps-throws', () => { throw new Error('ps unavailable'); }],
    ['ps-empty', () => ''],
    ['ps-not-a-string', () => null],
  ]) {
    const verdict = makeGate(built, [[]], {alive: () => false, run})('t');
    check(`gate-uncertain-never-reads-as-closed-${label}`,
      verdict.closed === false && verdict.uncertain === true, verdict);
  }

  check('owned-processes-returns-null-when-unreadable',
    ownedProcesses(built.exe, {run: () => { throw new Error('nope'); }}) === null, {});

  // ------------------------------------------------- one full coordinator cycle
  PI.initializeOwnedRun(context);
  const englishPath = 'pages/Isolation Anchor.md';
  const koreanPath = 'pages/격리 기준 문서.md';
  const newKoreanPath = 'pages/격리 새 문서.md';
  const englishSeed = '- isolation anchor page\n';
  const koreanSeed = '- 격리 점검 기준 문서\n';
  PI.putNoteFixture(context, englishPath, englishSeed);
  PI.putNoteFixture(context, koreanPath, koreanSeed);

  const enrolled = PI.enrollGraph(context, {
    graphId: `f28-incoming-iso-${crypto.randomBytes(4).toString('hex')}`,
    replicaId: 'replica-iso-local', deviceId: 'device-iso-local',
    metadataRevision: 'metadata-1',
    files: [
      {fileId: 'file-english', path: englishPath, content: englishSeed,
       acceptedRevision: 'ar-english'},
      {fileId: 'file-korean', path: koreanPath, content: koreanSeed,
       acceptedRevision: 'ar-korean'},
    ],
  });
  check('scratch-graph-enrolled', enrolled.outcome === 'accepted', enrolled);

  const accepted = PI.openGraph(context);
  const englishUpdate = `${englishSeed}- updated by the synthetic second replica\n`;
  const newKoreanBody = '- 두 번째 복제본이 만든 새 문서\n';
  const proposal = IA.buildProposal({
    accepted: accepted.sidecar, snapshot: accepted.snapshot,
    originReplicaId: 'replica-iso-synthetic-b', targetMetadataRevision: 'metadata-2',
    changes: [
      {fileId: 'file-english', path: englishPath, content: englishUpdate},
      {fileId: 'file-new-korean', path: newKoreanPath, content: newKoreanBody},
    ],
  });

  const RUNNING = () => ({mode: 'app-closed', closed: false, running: ['probe']});
  const CLOSED = () => ({mode: 'app-closed', closed: true});
  const IDLE = async () => ({mode: 'app-idle', idle: true});
  const RECONCILED = async () => ({reconciled: true});

  const preview = IA.planIncoming(context, proposal);
  check('preview-produced-and-writes-nothing',
    preview.outcome === 'preview' && preview.mutated === false &&
    PI.readJournal(context).value === null &&
    PI.readNote(context, englishPath) === englishSeed,
    {code: preview.code, reason: preview.reason});

  const whileRunning = await IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: RUNNING,
  });
  check('application-refuses-while-the-app-is-running',
    whileRunning.outcome === 'refused' && whileRunning.code === 'app-running' &&
    whileRunning.mutated === false && PI.readJournal(context).value === null &&
    PI.readNote(context, englishPath) === englishSeed, whileRunning);

  const noApproval = await IA.applyIncoming(context, {proposal, gate: CLOSED});
  check('application-refuses-without-an-explicit-approval',
    noApproval.code === 'approval-required' && noApproval.mutated === false, noApproval);

  // interrupt after the first note write, before its progress update
  const interrupted = await IA.applyIncoming(context, {
    proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
    failAt: `after-file:${preview.preview.applyOrder[0]}`,
  });
  check('interruption-after-a-note-write-is-reported-as-mutated',
    interrupted.outcome === 'interrupted' && interrupted.mutated === true &&
    interrupted.applied.length === 1, interrupted);
  check('the-store-refuses-a-disk-ahead-graph',
    PI.openGraph(context).outcome === 'refused', {});

  const recovered = await IA.recoverIncoming(context, {gate: CLOSED});
  check('recovery-rolls-forward-only-the-remaining-file',
    recovered.outcome === 'recovered' && recovered.wrote.length === 1 &&
    recovered.progressDisagreement.length === 1, recovered);

  const finalAccepted = PI.openGraph(context);
  check('recovered-records-are-exact',
    finalAccepted.outcome === 'accepted' &&
    finalAccepted.sidecar.metadataRevision === 'metadata-2' &&
    PI.readNote(context, englishPath) === englishUpdate &&
    PI.readNote(context, newKoreanPath) === newKoreanBody &&
    PI.readNote(context, koreanPath) === koreanSeed,
    {outcome: finalAccepted.outcome, revision: finalAccepted.sidecar?.metadataRevision});

  check('journal-is-closed-and-retained',
    PI.readJournal(context).value.state === 'closed', {});
  const closedVerify = await IA.recoverIncoming(context, {gate: CLOSED});
  check('a-closed-journal-is-verified-not-trusted',
    closedVerify.outcome === 'none' && closedVerify.code === 'journal-closed' &&
    closedVerify.verified === true, closedVerify);

  const firstJournal = PI.readJournal(context);
  const after = PI.openGraph(context);
  const secondProposal = IA.buildProposal({
    accepted: after.sidecar, snapshot: after.snapshot,
    originReplicaId: 'replica-iso-synthetic-b', targetMetadataRevision: 'metadata-3',
    changes: [{fileId: 'file-korean', path: koreanPath, content: `${koreanSeed}- 추가\n`}],
  });
  const refusedSecond = IA.planIncoming(context, secondProposal);
  check('the-retained-journal-slot-is-never-reused',
    refusedSecond.outcome === 'refused' && refusedSecond.code === 'journal-slot-occupied' &&
    refusedSecond.mutated === false &&
    PI.readJournal(context).hash === firstJournal.hash &&
    PI.readNote(context, koreanPath) === koreanSeed, refusedSecond);

  // ------------------- the record store's own transaction must be resolved
  const second = {helper, runName, ownerToken,
    graphDirectory: 'graph-devfail', profileDirectory: 'identity-state-devfail'};
  PI.initializeOwnedRun(second);
  PI.putNoteFixture(second, englishPath, englishSeed);
  PI.putNoteFixture(second, koreanPath, koreanSeed);
  check('second-scratch-graph-enrolled', PI.enrollGraph(second, {
    graphId: `f28-incoming-iso-2-${crypto.randomBytes(4).toString('hex')}`,
    replicaId: 'replica-iso-local-2', deviceId: 'device-iso-local-2',
    metadataRevision: 'metadata-1',
    files: [
      {fileId: 'file-english', path: englishPath, content: englishSeed, acceptedRevision: 'ar-english'},
      {fileId: 'file-korean', path: koreanPath, content: koreanSeed, acceptedRevision: 'ar-korean'},
    ],
  }).outcome === 'accepted', {});

  const opened2 = PI.openGraph(second);
  const proposal2 = IA.buildProposal({
    accepted: opened2.sidecar, snapshot: opened2.snapshot,
    originReplicaId: 'replica-iso-synthetic-b', targetMetadataRevision: 'metadata-2',
    changes: [{fileId: 'file-english', path: englishPath, content: englishUpdate}],
  });
  const preview2 = IA.planIncoming(second, proposal2);
  const bound = preview2.preview.target;
  const devFail = await IA.applyIncoming(second, {
    proposal: proposal2, approve: preview2.preview.previewFingerprint, gate: CLOSED,
    recordFailure: {step: 'device', point: 'after-stage'},
  });
  const mid = PI.readRecords(second);
  check('graph-first-device-step-failure-leaves-the-transaction-outstanding',
    devFail.outcome === 'interrupted' && devFail.code === 'records-uncertain' &&
    mid.sidecar.metadataRevision === 'metadata-2' &&
    mid.device.metadataRevision === 'metadata-1' &&
    mid.outstandingIntents.length === 1 &&
    mid.outstandingIntents[0] === bound.transactionId &&
    PI.readJournal(second).value.state === 'open',
    {outcome: devFail.outcome, code: devFail.code,
     sidecar: mid.sidecar.metadataRevision, device: mid.device.metadataRevision,
     intents: mid.outstandingIntents.length});

  const resolved = await IA.recoverIncoming(second, {gate: CLOSED});
  check('recovery-resolves-it-through-the-record-store-contract',
    resolved.outcome === 'recovered' &&
    resolved.resolution === 'store-recovered:graph-applied' &&
    resolved.transactionId === bound.transactionId &&
    resolved.wrote.length === 0, resolved);

  const settled = PI.openGraph(second);
  check('both-records-are-proven-accepted-before-the-journal-closes',
    PI.readRecords(second).outstandingIntents.length === 0 &&
    settled.outcome === 'accepted' &&
    settled.sidecar.acceptedTransactionId === bound.transactionId &&
    settled.sidecar.acceptedSnapshotFingerprint === bound.snapshotFingerprint &&
    settled.device.acceptedTransactionId === bound.transactionId &&
    PI.readJournal(second).value.state === 'closed' &&
    PI.readJournal(second).value.progress.transactionId === bound.transactionId,
    {transactionId: settled.sidecar?.acceptedTransactionId});

  // ------------------------------------------------- the app-idle gate itself
  const idleSignals = {editing: false, composing: false, inputIdle: true,
    writesFinished: true, pendingCauses: 0};
  const idleGate = makeIdleGate(() => idleSignals);
  const idleVerdict = await idleGate('t');
  check('idle-gate-reports-idle-and-never-closure',
    idleVerdict.idle === true && idleVerdict.closed !== true &&
    idleVerdict.mode === 'app-idle', idleVerdict);
  for (const [field, value, label] of [
    ['editing', true, 'editor-buffer-open'],
    ['composing', true, 'ime-composition'],
    ['inputIdle', false, 'recent-input'],
    ['writesFinished', false, 'write-batch-not-dispatched'],
    ['pendingCauses', 1, 'pending-bridge-cause'],
  ]) {
    const probe = await makeIdleGate(() => ({...idleSignals, [field]: value}))('t');
    check(`idle-gate-refuses-on-${label}`,
      probe.idle === false && probe.failing.includes(label) && probe.closed !== true, probe);
  }
  const unreadable = await makeIdleGate(() => { throw new Error('evaluate failed'); })('t');
  check('idle-gate-unreadable-is-uncertain-never-idle',
    unreadable.idle === false && unreadable.uncertain === true, unreadable);

  // --------------------------------- app-idle refuses without a working hook
  const idleCase = {helper, runName, ownerToken,
    graphDirectory: 'graph-idle', profileDirectory: 'identity-state-idle'};
  PI.initializeOwnedRun(idleCase);
  PI.putNoteFixture(idleCase, englishPath, englishSeed);
  PI.putNoteFixture(idleCase, koreanPath, koreanSeed);
  check('idle-scratch-graph-enrolled', PI.enrollGraph(idleCase, {
    graphId: `f28-incoming-iso-idle-${crypto.randomBytes(4).toString('hex')}`,
    replicaId: 'replica-iso-idle', deviceId: 'device-iso-idle',
    metadataRevision: 'metadata-1',
    files: [
      {fileId: 'file-english', path: englishPath, content: englishSeed, acceptedRevision: 'ar-english'},
      {fileId: 'file-korean', path: koreanPath, content: koreanSeed, acceptedRevision: 'ar-korean'},
    ],
  }).outcome === 'accepted', {});
  const openedIdle = PI.openGraph(idleCase);
  const idleProposal = IA.buildProposal({
    accepted: openedIdle.sidecar, snapshot: openedIdle.snapshot,
    originReplicaId: 'replica-iso-synthetic-b', targetMetadataRevision: 'metadata-2',
    changes: [{fileId: 'file-english', path: englishPath, content: englishUpdate}],
  });
  const idlePreview = IA.planIncoming(idleCase, idleProposal, {mode: 'app-idle'});
  const noHook = await IA.applyIncoming(idleCase, {
    proposal: idleProposal, approve: idlePreview.preview.previewFingerprint,
    gate: IDLE, mode: 'app-idle',
  });
  check('app-idle-refuses-without-a-reconciliation-hook',
    noHook.outcome === 'refused' && noHook.code === 'reconciliation-hook-missing' &&
    noHook.mutated === false && PI.readJournal(idleCase).value === null &&
    PI.readNote(idleCase, englishPath) === englishSeed, noHook);

  const crossMode = await IA.applyIncoming(idleCase, {
    proposal: idleProposal, approve: idlePreview.preview.previewFingerprint,
    gate: CLOSED, mode: 'app-idle', reconcile: RECONCILED,
  });
  check('an-app-closed-gate-cannot-satisfy-an-app-idle-run',
    crossMode.outcome === 'refused' && crossMode.code === 'gate-mode-mismatch' &&
    PI.readNote(idleCase, englishPath) === englishSeed, crossMode);

  // An approval issued for one mode cannot be used to apply in the other.
  const closedApproval = IA.planIncoming(idleCase, idleProposal);
  const wrongApproval = await IA.applyIncoming(idleCase, {
    proposal: idleProposal, approve: closedApproval.preview.previewFingerprint,
    gate: IDLE, mode: 'app-idle', reconcile: RECONCILED,
  });
  check('an-approval-issued-for-another-mode-is-refused',
    wrongApproval.outcome === 'refused' && wrongApproval.code === 'preview-stale' &&
    PI.readNote(idleCase, englishPath) === englishSeed, wrongApproval);

  const idleCalls = [];
  const idleApplied = await IA.applyIncoming(idleCase, {
    proposal: idleProposal, approve: idlePreview.preview.previewFingerprint,
    gate: IDLE, mode: 'app-idle',
    reconcile: async fileId => { idleCalls.push(fileId); return {reconciled: true}; },
  });
  check('app-idle-applies-and-waits-per-file-then-rechecks-at-the-boundary',
    idleApplied.outcome === 'applied' && idleApplied.mode === 'app-idle' &&
    idleCalls.length === 2 && idleCalls[0] === 'file-english' && idleCalls[1] === 'file-english' &&
    PI.openGraph(idleCase).sidecar.metadataRevision === 'metadata-2' &&
    PI.readJournal(idleCase).value.state === 'closed',
    {outcome: idleApplied.outcome, calls: idleCalls});

  console.log(`\nIsolation check passed: ${passed} checks on scratch run ${runName}`);
  console.log(`Retained scratch run: ${path.join(PI.PROFILE_ROOT, runName, 'identity-state')}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
