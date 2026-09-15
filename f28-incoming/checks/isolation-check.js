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
const {makeGate, ownedProcesses} = require('./app-closed-gate');
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
    {fileId: 'file-english', path: englishPath, content: englishUpdate,
     acceptedRevision: 'ar-english-incoming'},
    {fileId: 'file-new-korean', path: newKoreanPath, content: newKoreanBody,
     acceptedRevision: 'ar-new-korean-incoming'},
  ],
});

const RUNNING = () => ({closed: false, running: ['probe']});
const CLOSED = () => ({closed: true});

const preview = IA.planIncoming(context, proposal);
check('preview-produced-and-writes-nothing',
  preview.outcome === 'preview' && preview.mutated === false &&
  PI.readJournal(context).value === null &&
  PI.readNote(context, englishPath) === englishSeed,
  {code: preview.code, reason: preview.reason});

const whileRunning = IA.applyIncoming(context, {
  proposal, approve: preview.preview.previewFingerprint, gate: RUNNING,
});
check('application-refuses-while-the-app-is-running',
  whileRunning.outcome === 'refused' && whileRunning.code === 'app-running' &&
  whileRunning.mutated === false && PI.readJournal(context).value === null &&
  PI.readNote(context, englishPath) === englishSeed, whileRunning);

const noApproval = IA.applyIncoming(context, {proposal, gate: CLOSED});
check('application-refuses-without-an-explicit-approval',
  noApproval.code === 'approval-required' && noApproval.mutated === false, noApproval);

// interrupt after the first note write, before its progress update
const interrupted = IA.applyIncoming(context, {
  proposal, approve: preview.preview.previewFingerprint, gate: CLOSED,
  failAt: `after-file:${preview.preview.applyOrder[0]}`,
});
check('interruption-after-a-note-write-is-reported-as-mutated',
  interrupted.outcome === 'interrupted' && interrupted.mutated === true &&
  interrupted.applied.length === 1, interrupted);
check('the-store-refuses-a-disk-ahead-graph',
  PI.openGraph(context).outcome === 'refused', {});

const recovered = IA.recoverIncoming(context, {gate: CLOSED});
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
check('a-second-recovery-has-nothing-to-do',
  IA.recoverIncoming(context, {gate: CLOSED}).outcome === 'none', {});

console.log(`\nIsolation check passed: ${passed} checks on scratch run ${runName}`);
console.log(`Retained scratch run: ${path.join(PI.PROFILE_ROOT, runName, 'identity-state')}`);
