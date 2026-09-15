#!/usr/bin/env node
'use strict';

/*
 * Isolation check for the live-capture coordinator's exact wiring, run with no
 * application at all. It exercises the same helper functions the live batch
 * uses — cause-group classification, observation construction, captureChanges
 * batching, update-request derivation, duplicate collapse, re-feed refusal,
 * stale-evidence pending and the injected record-persistence failure with its
 * exact-retry recovery — against the real anchored helper and the real pure
 * modules, on a scratch owned synthetic graph seeded with putNoteFixture seeds the
 * way the persistence acceptance tests seed theirs.
 *
 * It never touches a live OG graph, never launches an application and is not
 * the live batch itself: it exists so the one live run is not the first time
 * these code paths execute.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const PI = require('../../f28-sync-prototype/src/persistent-identity');
const B = require('../../f27-pilot/checks/allowed-root');
const C = require('./run-identity-capture');

const helper = process.env.F28_IDENTITY_HELPER;
assert(helper, 'F28_IDENTITY_HELPER must name the built identity_store_helper binary');
const ownerToken = process.env.F28_OWNER_TOKEN || crypto.randomBytes(32).toString('hex');
assert(/^[0-9a-f]{64}$/.test(ownerToken), 'the owner token must be 64 hex characters');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runName = process.env.F28_IDENTITY_RUN_NAME ||
  `f28-iso-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
const digestHex = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

const context = {helper, runName, ownerToken, graphDirectory: 'graph', profileDirectory: 'identity-state'};
const englishPath = 'pages/iso english.md';
const koreanPath = 'pages/기준 iso 페이지.md';
const renamedPath = 'pages/이름바꾼 iso 페이지.md';
const graphAbsolute = path.join(B.allowedRootReal(), runName, 'graph');
const graphId = `f28-iso-graph-${stamp}`;

let passed = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`isolation check failed: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function seed(content) {
  return `- iso seed ${content}\n- 두 번째 블록\n`;
}

PI.initializeOwnedRun(context);
const open0 = PI.openGraph(context);
check('unenrolled-before-explicit-enrollment', open0.outcome === 'unenrolled');

PI.putNoteFixture(context, englishPath, seed('english'));
PI.putNoteFixture(context, koreanPath, seed('korean'));
const before = PI.hashGraphNotes(context);
const enrollment = PI.enrollGraph(context, {
  graphId,
  replicaId: 'replica-iso-1',
  deviceId: 'device-iso-1',
  metadataRevision: 'metadata-1',
  files: [
    {fileId: 'file-english', path: englishPath, content: seed('english'),
     acceptedRevision: 'accepted-revision-enrollment-english'},
    {fileId: 'file-korean', path: koreanPath, content: seed('korean'),
     acceptedRevision: 'accepted-revision-enrollment-korean'},
  ],
});
check('enrollment-accepted', enrollment.outcome === 'accepted', enrollment.code);
const after = PI.hashGraphNotes(context);
check('enrollment-leaves-note-bytes-unchanged', after.hash === before.hash && after.count === before.count);
let accepted = PI.openGraph(context);
check('enrollment-open-accepted', accepted.outcome === 'accepted' && accepted.sidecar.metadataRevision === 'metadata-1');

let revisionCounter = 1;
const nextRevision = () => `metadata-${++revisionCounter}`;

// A completed save, captured through the coordinator's exact observation
// shapes and accepted into a matching record. The duplicate feed must collapse.
function captureSave(acceptedState, fileId, notePath, content, {duplicates = false} = {}) {
  const causeHash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const saveId = `save-${digestHex(`${graphId}\0${notePath}\0${causeHash}`)}`;
  const parentRevisionId = acceptedState.sidecar.identity.files[fileId].acceptedRevision;
  const observations = C.saveObservations({saveId, fileId, notePath, content, parentRevisionId});
  const batch = C.runCapture(acceptedState, duplicates ? observations.concat(observations) : observations,
    nextRevision());
  assert(batch.eligibility.eligible, `capture not eligible: ${JSON.stringify(batch.invalid)}`);
  assert(batch.capturedEvents.length === 1, 'capture did not collapse to one event');
  const request = C.updateRequestFromCapture(context, acceptedState, batch);
  const update = PI.updateIdentity(context, request, {ordering: 'graph-first'});
  assert(update.outcome === 'accepted', `update refused: ${update.code}`);
  const opened = PI.openGraph(context);
  assert(opened.outcome === 'accepted', `reopen after update refused: ${opened.outcome}`);
  assert(opened.sidecar.metadataRevision === request.metadataRevision, 'revision did not advance');
  assert(require('../../f28-sync-prototype/src/core').stableStringify(opened.sidecar.identity) ===
         require('../../f28-sync-prototype/src/core').stableStringify(batch.proposedMetadata),
    'the accepted sidecar identity is not exactly the capture proposal');
  return {batch, request, opened, observations};
}

// English save, fed once.
PI.putNoteFixture(context, englishPath, seed('english-edit-1'));
const save1 = C.stableRead(context, englishPath);
check('stable-read-matches-disk', save1.stable && save1.content === seed('english-edit-1'));
const captured1 = captureSave(accepted, 'file-english', englishPath, save1.content);
accepted = captured1.opened;
check('save-captured-to-accepted-record', accepted.sidecar.metadataRevision === 'metadata-2');

// A duplicate-fed save collapses to exactly one revision.
PI.putNoteFixture(context, englishPath, seed('english-edit-2'));
const save2 = C.stableRead(context, englishPath);
const captured2 = captureSave(accepted, 'file-english', englishPath, save2.content, {duplicates: true});
accepted = captured2.opened;
check('duplicate-observations-single-revision', accepted.sidecar.metadataRevision === 'metadata-3');

// Re-feeding the completed evidence is refused; no second revision. The
// observations are the exact objects the accepted batch used.
const reFed = C.runCapture(accepted, captured2.observations, 'metadata-4');
check('re-fed-completed-evidence-refused',
  !reFed.eligibility.eligible &&
  reFed.reviewItems.some(item => item.code === 'save-evidence-mismatch'));
check('re-fed-created-no-second-revision', PI.openGraph(context).sidecar.metadataRevision === 'metadata-3');

// A completed save whose bytes a later edit advanced stays pending. While the
// disk is ahead of the sidecar the store refuses to read as accepted — that
// ambiguity is itself the pending state — so the retained pre-edit accepted
// state is the only capture baseline.
PI.putNoteFixture(context, englishPath, seed('english-edit-3'));
const staleBytes = C.stableRead(context, englishPath).content;
const diskAhead = PI.openGraph(context);
check('disk-ahead-of-sidecar-refused-as-ambiguous',
  diskAhead.outcome === 'refused' && diskAhead.code === 'snapshot-mismatch');
const staleAccepted = accepted;
PI.putNoteFixture(context, englishPath, seed('english-edit-4'));
const saveId3 = `save-${digestHex(`${graphId}\0${englishPath}\0sha256:${crypto.createHash('sha256').update(staleBytes).digest('hex')}`)}`;
const staleBatch = C.runCapture(staleAccepted, [
  {observationId: `obs-${saveId3}-complete`, type: 'save-complete', saveId: saveId3,
   fileId: 'file-english', path: englishPath, content: staleBytes,
   parentRevisionId: staleAccepted.sidecar.identity.files['file-english'].acceptedRevision,
   revisionId: `rev-${digestHex(`file-english\0${staleAccepted.sidecar.identity.files['file-english'].acceptedRevision}\0${staleBytes}`)}`},
  {observationId: `obs-${saveId3}-unstable`, type: 'unstable-read', path: englishPath,
   reason: 'a later edit advanced the bytes', causeType: 'save', causeId: saveId3},
], 'metadata-4');
check('later-edit-leaves-earlier-save-pending',
  !staleBatch.eligibility.eligible &&
  staleBatch.reviewItems.some(item => item.code === 'save-awaiting-matching-stable-read') &&
  staleBatch.reviewItems.some(item => item.code === 'unstable-read'));
check('pending-did-not-advance-records',
  PI.readRecords(context).sidecar.metadataRevision === 'metadata-3' &&
  PI.readRecords(context).outstandingIntents.length === 0);

// The pending edit itself is then captured from the bytes actually on disk.
const save4 = C.stableRead(context, englishPath);
const captured4 = captureSave(staleAccepted, 'file-english', englishPath, save4.content);
accepted = captured4.opened;
check('current-edit-captured-after-pending', accepted.sidecar.metadataRevision === 'metadata-4');

// A rename: identity retained, exact path updated, unchanged content hash.
const oldAbsolute = B.assertInsideAllowedRoot('iso old note', path.join(graphAbsolute, koreanPath));
const newAbsolute = B.assertInsideAllowedRoot('iso renamed note', path.join(graphAbsolute, renamedPath));
fs.renameSync(oldAbsolute, newAbsolute);
const readRenamed = C.stableRead(context, renamedPath);
const absentOld = C.stableAbsentRead(context, koreanPath);
check('rename-stable-read-and-old-path-absent',
  readRenamed.stable && readRenamed.content !== null && absentOld.absent);
const renameId = `rename-${digestHex(`${graphId}\0${koreanPath}\0${renamedPath}`)}`;
const renameBatch = C.runCapture(accepted, C.renameObservations({
  renameId, fileId: 'file-korean', oldPath: koreanPath, newPath: renamedPath,
  parentRevisionId: accepted.sidecar.identity.files['file-korean'].acceptedRevision,
  content: readRenamed.content,
}), nextRevision());
assert(renameBatch.eligibility.eligible && renameBatch.capturedEvents.length === 1,
  'the rename was not captured');
const renameUpdate = PI.updateIdentity(context,
  C.updateRequestFromCapture(context, accepted, renameBatch), {ordering: 'graph-first'});
assert(renameUpdate.outcome === 'accepted', `the rename update was refused: ${renameUpdate.code}`);
accepted = PI.openGraph(context);
check('rename-retains-file-identity-updates-path',
  accepted.outcome === 'accepted' &&
  accepted.sidecar.identity.files['file-korean'].path === renamedPath &&
  accepted.sidecar.identity.files['file-korean'].acceptedContentHash ===
    renameBatch.proposedMetadata.files['file-korean'].acceptedContentHash &&
  !Object.keys(accepted.sidecar.identity.tombstones).includes('file-korean'));

// A subsequent save at the new path.
PI.putNoteFixture(context, renamedPath, `${readRenamed.content}- renamed edit\n`);
const save5 = C.stableRead(context, renamedPath);
const captured5 = captureSave(accepted, 'file-korean', renamedPath, save5.content);
accepted = captured5.opened;
check('post-rename-edit-captured-at-new-path', accepted.sidecar.metadataRevision === 'metadata-6');

// An injected record-persistence failure preserves the note and leaves the
// exact transaction pending; only the identical re-issue recovers it.
PI.putNoteFixture(context, englishPath, seed('english-edit-5'));
const save6 = C.stableRead(context, englishPath);
const causeHash6 = `sha256:${crypto.createHash('sha256').update(save6.content).digest('hex')}`;
const saveId6 = `save-${digestHex(`${graphId}\0${englishPath}\0${causeHash6}`)}`;
const batch6 = C.runCapture(accepted, C.saveObservations({
  saveId: saveId6, fileId: 'file-english', notePath: englishPath, content: save6.content,
  parentRevisionId: accepted.sidecar.identity.files['file-english'].acceptedRevision,
}), nextRevision());
assert(batch6.eligibility.eligible, 'the pre-failure save was not captured');
const request6 = C.updateRequestFromCapture(context, accepted, batch6);
const failed = PI.updateIdentity(context, request6,
  {ordering: 'graph-first', failure: {step: 'device', point: 'after-stage'}});
check('injected-failure-is-uncertain-write',
  failed.outcome === 'uncertain-write' && failed.code === 'write-outcome-unknown' && failed.step === 'device');
check('og-note-bytes-preserved-through-failure',
  PI.readNote(context, englishPath) === save6.content);
const pendingState = PI.openGraph(context);
check('recovery-pending-after-failure',
  pendingState.outcome === 'recovery-required' && pendingState.code === 'outstanding-intent');
// With the sidecar already at its target, the identical re-issue is refused:
// the store will not re-derive a transaction its own sidecar already names, so
// the only continuation is the validated recovery of the outstanding one.
const refusedRetry = PI.updateIdentity(context, request6, {ordering: 'graph-first'});
check('identical-re-issue-refused-while-sidecar-names-target',
  refusedRetry.outcome === 'refused' && refusedRetry.code === 'stale-metadata-revision');
const recovered = PI.recover(context, {transactionId: failed.transactionId});
check('recovery-reconciles-exact-state',
  recovered.outcome === 'recovered' && recovered.classification === 'graph-applied');
accepted = recovered.opened;
check('recovered-records-are-exact',
  accepted.outcome === 'accepted' && accepted.sidecar.metadataRevision === request6.metadataRevision &&
  PI.readNote(context, englishPath) === save6.content &&
  PI.readRecords(context).outstandingIntents.length === 0);

console.log(`\nIsolation check passed: ${passed} checks on scratch run ${runName}`);
console.log(`Retained scratch run: ${graphAbsolute}`);