#!/usr/bin/env node
'use strict';

/*
 * One coherent, owned, single-machine batch applying an INCOMING change to a
 * fresh synthetic graph that OG itself created and this device enrolled.
 * See ../../f28-sync-prototype/INCOMING_CHANGE_DESIGN.md.
 *
 * What is different from every earlier stage: the external coordinator writes
 * note bytes. It does so only through the anchored helper, only with an exact
 * precondition, only after an explicitly approved preview, and only while the
 * owned application is proven to have exited. OG is still the only writer of
 * notes while it is running; the application itself gains nothing -- the package
 * under test is the accepted observation-only IdentityCapture build, unmodified
 * and not rebuilt.
 *
 * The "second replica" is a synthetic state this same process constructs in
 * memory. There is no network, no peer and no transport, and nothing here shows
 * anything about a real second device.
 *
 * Evidence is local beside the development checkout and is never a Git input.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const APP = require('../../f28-refpath/checks/packaged-app');
const FP = require('../../f28-refpath/checks/fresh-profile');
const B = require('../../f27-pilot/checks/allowed-root');
const NET = require('../../f28-origin/checks/network-refusal');
const {_electron} = require('../../node_modules/playwright');
const PI = require('../../f28-sync-prototype/src/persistent-identity');
const IA = require('../../f28-sync-prototype/src/incoming-application');
const {makeGate, ownedProcesses} = require('./app-closed-gate');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.resolve(REPO, '..', '..', 'evidence');
const BUILD = 'Logseq-OG-F28-IdentityCapture';
const API = '__LOGSEQ_OG_BRIDGE_OBSERVATION__';
const GRAPH_DIRECTORY = 'graph';
const PROFILE_DIRECTORY = 'identity-state';

const sha256 = value => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};

function git(args) {
  try { return execFileSync('git', args, {cwd: REPO, encoding: 'utf8'}).trim(); }
  catch (_error) { return null; }
}

async function readHealth(page) {
  return page.evaluate(name => {
    const api = window[name];
    if (!api || typeof api.health !== 'function') return null;
    return api.health();
  }, API);
}

function healthVerdict(health) {
  if (!health) return {ok: false, verdict: 'observation-health-unavailable'};
  if (!health.enabled) return {ok: false, verdict: 'observation-runtime-not-installed'};
  if (health.blocked) return {ok: false, verdict: 'recording-failed-observer-blocked'};
  if (!health['instance-matches-reader']) {
    return {ok: false, verdict: 'reader-and-seams-on-different-runtime-instances'};
  }
  return {ok: true, verdict: 'observer-healthy',
    hookEntries: health['hook-entries'], recordedEvents: health['recorded-events']};
}

async function api(page, method, ...args) {
  return page.evaluate(({method, args}) => {
    const fn = window.logseq && window.logseq.api && window.logseq.api[method];
    if (typeof fn !== 'function') throw new Error(`missing Logseq API ${method}`);
    return fn(...args);
  }, {method, args});
}

async function flushPageThroughOg(page, pageName) {
  return page.evaluate(async name => {
    const pageValue = window.logseq?.api?.get_page?.(name);
    const repo = window.frontend?.state?.get_current_repo?.();
    const write = window.frontend?.modules?.outliner?.file?.do_write_file_BANG_;
    if (!pageValue?.id || !repo || typeof write !== 'function') {
      throw new Error('OG immediate outliner writer is unavailable');
    }
    await Promise.resolve(write(repo, pageValue.id, 'incoming-application-save'));
    return {pageId: pageValue.id, repo};
  }, pageName);
}

async function pageContains(session, pageName, expected) {
  await session.goTo(pageName);
  return session.page.evaluate(value => document.body.innerText.includes(value), expected);
}

async function run() {
  const helper = process.env.F28_IDENTITY_HELPER;
  const ownerToken = process.env.F28_OWNER_TOKEN || crypto.randomBytes(32).toString('hex');
  assert(helper, 'F28_IDENTITY_HELPER must name the built identity_store_helper binary');
  assert(/^[0-9a-f]{64}$/.test(ownerToken), 'the owner token must be 64 hex characters');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(EVIDENCE, `f28-incoming-application-${stamp}.json`);
  process.env.F28_DIAG_DIR = path.join(EVIDENCE, `f28-incoming-application-${stamp}-diagnostics`);
  const runName = process.env.F28_INCOMING_RUN_NAME ||
    `f28-incoming-application-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(runName), 'run name is not a safe helper component');

  const out = {
    schema: 'f28-incoming-application-live/1', stamp, status: 'preparing', checks: [],
    simulation: false, synchronizationEnabled: false,
    transport: 'none — the second replica is a synthetic in-memory state on this same host',
    appWritesNotes: false,
    coordinatorWritesNotes: 'yes, and only this: anchored helper, exact precondition, approved preview, app proven closed',
  };
  const record = (id, ok, detail) => {
    out.checks.push({id, ok, detail});
    save(evidenceFile, out);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
    assert(ok, id);
  };
  const phase = name => { PI.setDiagnosticCase(name); out.phase = name; };

  let session = null;
  let reopened = null;
  const trees = [];

  try {
    // ------------------------------------------------ build and owned roots
    phase('preflight');
    const built = APP.resolve(BUILD);
    assert(built.preflight.ok, 'identity-capture package preflight failed');
    const manifest = built.preflight.manifest;
    assert(manifest.builtFrom && !manifest.builtFrom.dirty,
      'the packaged application was not built from clean source');
    assert(manifest.experiment?.bridge?.mode === 'observation-only',
      'manifest lacks observation-only bridge mode');
    assert(manifest.experiment?.bridge?.persistence === false &&
           manifest.experiment?.bridge?.synchronizationPorts === false,
      'manifest does not refuse persistence/synchronization ports');
    const preexisting = ownedProcesses(built.exe);
    assert(preexisting !== null, 'process state could not be read; refusing to start');
    assert(!preexisting.length,
      'an identity-capture package process is already running; refusing to touch it');

    out.build = {id: manifest.pilotBuildId, source: manifest.builtFrom,
      productName: manifest.productName, bundleId: manifest.bundleId,
      architecture: manifest.host.arch, bridge: manifest.experiment.bridge,
      executable: built.exe,
      reused: 'the accepted IdentityCapture package, unmodified and not rebuilt for this experiment'};
    out.source = {commit: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      uncommitted: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length};
    out.helper = {path: helper, sha256: `sha256:${sha256(fs.readFileSync(helper))}`};
    record('reused-clean-observation-only-package', true, out.build);

    const context = {helper, runName, ownerToken,
      graphDirectory: GRAPH_DIRECTORY, profileDirectory: PROFILE_DIRECTORY};
    const graph = path.join(B.allowedRootReal(), runName, GRAPH_DIRECTORY);
    const profileRecords = path.join(PI.PROFILE_ROOT, runName, PROFILE_DIRECTORY);
    PI.initializeOwnedRun(context);
    out.owned = {runName, graph, profileRecords, ownerToken,
      note: 'the owner token is retained only so this local evidence file can resume; it is never a Git input'};
    record('owned-run-initialized-under-both-anchored-roots',
      fs.realpathSync(graph) === graph && fs.realpathSync(profileRecords) === profileRecords &&
      graph !== B.allowedRootReal() &&
      B.assertInsideAllowedRoot('owned live graph', graph) === graph,
      {graph, profileRecords, helperSha256: out.helper.sha256});

    const profile = FP.swapAside(built.identity, {stamp});
    out.appProfile = {root: profile.root, preExisting: profile.preExisting,
      preserved: profile.preserved};
    record('fresh-app-profile-outside-record-roots',
      !profile.root.includes('IdentityExp'), out.appProfile);

    const gate = makeGate(built, trees);
    record('gate-reports-closed-before-any-launch', gate('preflight').closed === true,
      gate('preflight'));

    // ------------------------------------------------------------ session 1
    phase('session-1');
    const launch = NET.launchWith(options => _electron.launch(options), BUILD);
    const bad = path.join(path.dirname(B.allowedRootReal()), 'f28-incoming-inert-probe');
    const errors = {record() {}, phase() {}, endPhase() {}, entries() { return []; }, phases() { return []; }};
    session = await APP.open({built, graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`launch-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    trees.push(session.ownedTree || []);
    const isolation = await session.app.evaluate(({app}) => ({userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'), home: app.getPath('home')}));
    record('fresh-isolated-profile',
      Object.values(isolation).every(value => value.startsWith(profile.root + path.sep)), isolation);
    record('observer-healthy-at-startup', healthVerdict(await readHealth(session.page)).ok,
      healthVerdict(await readHealth(session.page)));

    // ------------------------------------------------ OG creates the notes
    phase('og-creates-notes');
    const nameStamp = stamp.slice(0, 19);
    const english = `Incoming Anchor ${nameStamp}`;
    const korean = `수신 기준 문서 ${nameStamp}`;
    const newKorean = `수신 새 문서 ${nameStamp}`;
    const englishCreate = `Synthetic English note created through OG (${stamp}).`;
    const koreanCreate = `OG에서 만든 한국어 노트입니다 (${stamp}).`;

    for (const [page, body] of [[english, englishCreate], [korean, koreanCreate]]) {
      await api(session.page, 'create_page', page, {},
        {redirect: false, createFirstBlock: false, format: 'markdown'});
      const block = await api(session.page, 'insert_block', page, body, {focus: false});
      assert(block?.uuid, `block creation returned no identity for ${page}`);
      await flushPageThroughOg(session.page, page);
    }
    const englishPath = `pages/${english}.md`;
    const koreanPath = `pages/${korean}.md`;
    const newKoreanPath = `pages/${newKorean}.md`;
    const englishSeed = IA.stableRead(context, englishPath);
    const koreanSeed = IA.stableRead(context, koreanPath);
    assert(englishSeed.stable && englishSeed.present && koreanSeed.stable && koreanSeed.present,
      'the freshly created pages are not stably readable through the helper');
    out.operation = {english, korean, newKorean, englishPath, koreanPath, newKoreanPath};
    record('og-created-english-and-korean-notes',
      englishSeed.bytes.toString('utf8').includes(englishCreate) &&
      koreanSeed.bytes.toString('utf8').includes(koreanCreate),
      {englishSha256: englishSeed.hash, koreanSha256: koreanSeed.hash});

    // ------------------------------------------------------- enrollment
    phase('enrollment');
    record('unenrolled-before-explicit-enrollment',
      PI.openGraph(context).outcome === 'unenrolled', {});
    const beforeEnrollment = PI.hashGraphNotes(context);
    const graphId = `f28-incoming-graph-${nameStamp}-${crypto.randomBytes(4).toString('hex')}`;
    const enrollment = PI.enrollGraph(context, {
      graphId,
      replicaId: 'replica-incoming-local-1',
      deviceId: 'device-incoming-local-1',
      metadataRevision: 'metadata-1',
      files: [
        {fileId: 'file-english', path: englishPath,
         content: englishSeed.bytes.toString('utf8'),
         acceptedRevision: 'accepted-revision-enrollment-english'},
        {fileId: 'file-korean', path: koreanPath,
         content: koreanSeed.bytes.toString('utf8'),
         acceptedRevision: 'accepted-revision-enrollment-korean'},
      ],
    });
    assert(enrollment.outcome === 'accepted', `enrollment was refused: ${enrollment.code}`);
    const afterEnrollment = PI.hashGraphNotes(context);
    record('enrollment-leaves-note-bytes-unchanged',
      afterEnrollment.hash === beforeEnrollment.hash &&
      afterEnrollment.count === beforeEnrollment.count,
      {before: beforeEnrollment, after: afterEnrollment});
    const accepted1 = PI.openGraph(context);
    record('accepted-local-identity-established',
      accepted1.outcome === 'accepted' && accepted1.sidecar.metadataRevision === 'metadata-1',
      {metadataRevision: accepted1.sidecar?.metadataRevision, graphId});

    // ------------------------------- the synthetic second replica's proposal
    phase('proposal');
    const englishUpdate =
      `${englishSeed.bytes.toString('utf8')}- edited on the synthetic second replica (${stamp}).\n`;
    const newKoreanBody = `- 두 번째 복제본이 새로 만든 한국어 문서입니다 (${stamp}).\n`;
    const proposal = IA.buildProposal({
      accepted: accepted1.sidecar,
      snapshot: accepted1.snapshot,
      originReplicaId: 'replica-incoming-synthetic-b',
      targetMetadataRevision: 'metadata-2',
      changes: [
        {fileId: 'file-english', path: englishPath, content: englishUpdate},
        {fileId: 'file-new-korean', path: newKoreanPath, content: newKoreanBody},
      ],
    });
    out.proposal = {proposalId: proposal.proposalId, planId: proposal.planId,
      base: proposal.base, target: proposal.target,
      files: proposal.files.map(f => ({fileId: f.fileId, kind: f.kind, path: f.path})),
      origin: 'constructed in memory by this same process; no network, no peer, no transport'};
    record('synthetic-incoming-proposal-built',
      proposal.files.length === 2 &&
      proposal.files.some(f => f.kind === 'update') &&
      proposal.files.some(f => f.kind === 'create'), out.proposal);

    // ------------------------------------------- preview with the app running
    phase('preview');
    const notesBeforePreview = PI.hashGraphNotes(context);
    const previewed = IA.planIncoming(context, proposal);
    assert(previewed.outcome === 'preview',
      `preview refused: ${previewed.code} ${previewed.reason || ''}`);
    const notesAfterPreview = PI.hashGraphNotes(context);
    out.preview = previewed.preview;
    record('preview-produced-and-writes-nothing',
      previewed.mutated === false &&
      notesAfterPreview.hash === notesBeforePreview.hash &&
      PI.readJournal(context).value === null &&
      PI.openGraph(context).sidecar.metadataRevision === 'metadata-1',
      {previewFingerprint: previewed.preview.previewFingerprint,
       applyOrder: previewed.preview.applyOrder,
       files: previewed.preview.files});

    // -------------------------- application must refuse while the app is open
    phase('refuse-while-running');
    const runningVerdict = gate('live-check');
    const refusedWhileRunning = await IA.applyIncoming(context, {
      proposal, approve: previewed.preview.previewFingerprint, gate,
      mode: IA.MODE_APP_CLOSED,
    });
    const englishWhileRunning = IA.stableRead(context, englishPath);
    record('application-refuses-while-the-owned-app-is-running',
      refusedWhileRunning.outcome === 'refused' &&
      refusedWhileRunning.code === 'app-running' &&
      refusedWhileRunning.mutated === false &&
      runningVerdict.closed === false &&
      englishWhileRunning.hash === englishSeed.hash &&
      PI.readJournal(context).value === null &&
      PI.readNoteBytes(context, newKoreanPath) === null,
      {code: refusedWhileRunning.code, gate: runningVerdict,
       englishUnchanged: englishWhileRunning.hash === englishSeed.hash});

    // ------------------------------------------------------- clean quit
    phase('quit');
    record('observer-healthy-before-quit', healthVerdict(await readHealth(session.page)).ok,
      healthVerdict(await readHealth(session.page)));
    out.firstClose = await APP.close(session);
    session = null;
    const closedVerdict = gate('after-quit');
    out.closedVerdict = closedVerdict;
    record('owned-processes-have-exited',
      out.firstClose.stillAlive.length === 0 && closedVerdict.closed === true &&
      closedVerdict.byExactExecutableName === 0,
      {close: out.firstClose, gate: closedVerdict});

    // ------------------------------------------------------- application
    phase('apply');
    const notesBeforeApply = PI.hashGraphNotes(context);
    const applied = await IA.applyIncoming(context, {
      proposal, approve: previewed.preview.previewFingerprint, gate,
      mode: IA.MODE_APP_CLOSED,
    });
    assert(applied.outcome === 'applied',
      `application did not complete: ${applied.code} ${applied.reason || ''}`);
    out.mode = IA.MODE_APP_CLOSED;
    out.applied = {mode: applied.mode, applied: applied.applied, transactionId: applied.transactionId,
      metadataRevision: applied.metadataRevision,
      snapshotFingerprint: applied.snapshotFingerprint, journalHash: applied.journalHash};

    const englishAfter = IA.stableRead(context, englishPath);
    const newKoreanAfter = IA.stableRead(context, newKoreanPath);
    const koreanAfter = IA.stableRead(context, koreanPath);
    const notesAfterApply = PI.hashGraphNotes(context);
    record('both-files-applied-with-exact-bytes',
      englishAfter.stable && englishAfter.bytes.toString('utf8') === englishUpdate &&
      newKoreanAfter.stable && newKoreanAfter.bytes.toString('utf8') === newKoreanBody &&
      koreanAfter.stable && koreanAfter.hash === koreanSeed.hash,
      {englishSha256: englishAfter.hash, newKoreanSha256: newKoreanAfter.hash,
       untouchedKoreanUnchanged: koreanAfter.hash === koreanSeed.hash,
       notesBefore: notesBeforeApply, notesAfter: notesAfterApply});

    const accepted2 = PI.openGraph(context);
    out.acceptedAfterApply = {metadataRevision: accepted2.sidecar?.metadataRevision,
      snapshotFingerprint: accepted2.sidecar?.acceptedSnapshotFingerprint,
      acceptedTransactionId: accepted2.sidecar?.acceptedTransactionId};
    record('identity-accepted-at-the-new-revision',
      accepted2.outcome === 'accepted' &&
      accepted2.sidecar.metadataRevision === 'metadata-2' &&
      Object.keys(accepted2.sidecar.identity.files).sort().join(',') ===
        'file-english,file-korean,file-new-korean',
      out.acceptedAfterApply);

    // The approval bound an exact transaction, snapshot and record pair before
    // anything was written. The store must have published precisely those.
    const bound = previewed.preview.target;
    out.boundTarget = bound;
    record('published-records-are-exactly-the-ones-the-approval-bound',
      accepted2.sidecar.acceptedTransactionId === bound.transactionId &&
      accepted2.sidecar.acceptedSnapshotFingerprint === bound.snapshotFingerprint &&
      PI.readRecords(context).sidecarHash === bound.sidecarHash &&
      PI.readRecords(context).deviceHash === bound.deviceHash &&
      accepted2.device.acceptedTransactionId === bound.transactionId &&
      PI.readRecords(context).outstandingIntents.length === 0,
      {bound, observedTransaction: accepted2.sidecar.acceptedTransactionId,
       observedSnapshot: accepted2.sidecar.acceptedSnapshotFingerprint});

    // Every stored revision comes from the executed comparison plan.
    const storedRevisions = Object.fromEntries(
      Object.entries(accepted2.sidecar.identity.files)
        .map(([id, entry]) => [id, entry.acceptedRevision]));
    out.storedRevisions = storedRevisions;
    record('stored-revisions-come-from-the-plan-not-the-proposal',
      previewed.preview.files.every(file =>
        storedRevisions[file.fileId] === file.acceptedRevision &&
        /^compare-revision-[0-9a-f]{32}$/.test(file.acceptedRevision)),
      {previewRevisions: previewed.preview.files.map(f => ({fileId: f.fileId,
        acceptedRevision: f.acceptedRevision})), storedRevisions});

    const sidecarText = PI.readRecords(context).sidecarBytes.toString('utf8');
    record('sidecar-remains-portable',
      !sidecarText.includes('replica-incoming-synthetic-b') &&
      !sidecarText.includes('replicaId') && !sidecarText.includes('deviceId') &&
      !sidecarText.includes('/Users/'), {bytes: sidecarText.length});

    const journal = PI.readJournal(context);
    record('journal-closed-and-retained',
      journal.value?.state === 'closed' &&
      journal.value.progress.recordsAccepted === true &&
      journal.value.progress.applied.length === 2,
      {state: journal.value?.state, applied: journal.value?.progress?.applied,
       transactionId: journal.value?.progress?.transactionId});

    const nothingToRecover = await IA.recoverIncoming(context, {gate, mode: IA.MODE_APP_CLOSED});
    record('recovery-verifies-the-closed-journal-rather-than-trusting-its-label',
      nothingToRecover.outcome === 'none' && nothingToRecover.code === 'journal-closed' &&
      nothingToRecover.verified === true &&
      nothingToRecover.transactionId === previewed.preview.target.transactionId,
      nothingToRecover);

    // The slot holds one transaction per owned run and is never reused.
    const secondProposal = IA.buildProposal({
      accepted: accepted2.sidecar, snapshot: accepted2.snapshot,
      originReplicaId: 'replica-incoming-synthetic-b',
      targetMetadataRevision: 'metadata-3',
      changes: [{fileId: 'file-korean', path: koreanPath,
        content: `${koreanAfter.bytes.toString('utf8')}- 두 번째 제안입니다.\n`}],
    });
    const refusedSecond = IA.planIncoming(context, secondProposal);
    const journalStillFirst = PI.readJournal(context);
    record('a-retained-journal-is-not-reused-or-overwritten',
      refusedSecond.outcome === 'refused' &&
      refusedSecond.code === 'journal-slot-occupied' &&
      refusedSecond.mutated === false &&
      journalStillFirst.hash === applied.journalHash &&
      IA.stableRead(context, koreanPath).hash === koreanSeed.hash,
      {code: refusedSecond.code, retainedJournalHash: journalStillFirst.hash,
       note: 'another experiment uses a fresh owned run'});

    // ------------------------------------------------------------ reopen
    phase('reopen');
    reopened = await APP.open({built, graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`reopen-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    trees.push(reopened.ownedTree || []);
    record('reopen-observer-healthy', healthVerdict(await readHealth(reopened.page)).ok,
      healthVerdict(await readHealth(reopened.page)));
    record('reopen-renders-the-incoming-english-update',
      await pageContains(reopened, english, 'edited on the synthetic second replica'), {page: english});
    record('reopen-renders-the-incoming-korean-create',
      await pageContains(reopened, newKorean, '두 번째 복제본이 새로 만든 한국어 문서입니다'),
      {page: newKorean});
    record('reopen-renders-the-untouched-korean-note',
      await pageContains(reopened, korean, koreanCreate), {page: korean});

    const afterReopen = PI.hashGraphNotes(context);
    const englishReopen = IA.stableRead(context, englishPath);
    const newKoreanReopen = IA.stableRead(context, newKoreanPath);
    const accepted3 = PI.openGraph(context);
    record('identity-and-note-hashes-unchanged-across-the-reopen',
      accepted3.outcome === 'accepted' &&
      accepted3.sidecar.metadataRevision === 'metadata-2' &&
      accepted3.sidecar.acceptedSnapshotFingerprint ===
        out.acceptedAfterApply.snapshotFingerprint &&
      englishReopen.hash === englishAfter.hash &&
      newKoreanReopen.hash === newKoreanAfter.hash &&
      afterReopen.hash === notesAfterApply.hash && afterReopen.count === notesAfterApply.count,
      {notesAfterApply, afterReopen, metadataRevision: accepted3.sidecar?.metadataRevision});

    // ------------------------------------------------------- final quit
    phase('final-quit');
    out.finalClose = await APP.close(reopened);
    reopened = null;
    const finalVerdict = gate('final');
    record('final-owned-quit-clean',
      out.finalClose.stillAlive.length === 0 && finalVerdict.closed === true,
      {close: out.finalClose, gate: finalVerdict});

    out.profileCleanup = FP.restore(profile);
    out.status = 'passed';
    out.limits = [
      'one host, one fresh synthetic graph, one coherent batch',
      'the second replica is a synthetic in-memory state; no transport, no peer, no network',
      'creates and updates only; incoming rename and delete are not implemented or approved',
      'application is per file: an interruption leaves a mixed state, not whole-graph atomicity',
      'the cooperative lock covers participating helper invocations only',
      'the helper rechecks the destination before its rename, but recheck and rename are two operations',
      'the app-closed gate proves only that the owned experimental build exited',
      'no power-loss or simultaneous-host test was run',
    ];
    save(evidenceFile, out);
    console.log(`\nIncoming application batch passed: ${out.checks.length} checks`);
    console.log(`Evidence: ${evidenceFile}`);
    console.log(`Owned run retained: ${graph}`);
  } catch (error) {
    out.status = 'failed';
    out.failure = {message: String(error && error.message || error), stack: error?.stack || null};
    if (session) out.emergencyClose = await APP.close(session).catch(e => ({error: String(e)}));
    if (reopened) out.emergencyReopenClose = await APP.close(reopened).catch(e => ({error: String(e)}));
    save(evidenceFile, out);
    console.error(`\nFAILED: ${out.failure.message}`);
    console.error(`Evidence: ${evidenceFile}`);
    process.exitCode = 1;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
