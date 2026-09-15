#!/usr/bin/env node
'use strict';

/*
 * One coherent, owned, single-machine batch connecting REAL completed OG saves
 * and renames on one fresh synthetic graph to the persistent file-identity and
 * recovery records. See ../LIVE_CAPTURE_DESIGN.md.
 *
 * The packaged application stays exactly the observation-only runtime: this
 * external coordinator (a plain Node process started by the operator, outside
 * the application) reads that runtime's sanitized in-memory event stream through
 * the existing read-only page API and drives the anchored identity helper. The
 * application never executes the helper, gains no new IPC, no process-launch
 * exception and no renderer filesystem access beyond OG's own existing behavior.
 *
 * OG remains the sole writer of the test notes: this coordinator never issues a
 * note write against the live graph. Its only graph-tree writes are the
 * helper-owned logseq/.og-sync records; its only profile-tree writes are device
 * records, intents and retained evidence.
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
const OP = require('../../f27-pilot/checks/owned-process');
const NET = require('../../f28-origin/checks/network-refusal');
const {_electron} = require('../../node_modules/playwright');
const PI = require('../../f28-sync-prototype/src/persistent-identity');
const {captureChanges, CAPTURE_BATCH_SCHEMA} =
  require('../../f28-sync-prototype/src/identity-capture');
const {stableStringify} = require('../../f28-sync-prototype/src/core');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.resolve(REPO, '..', '..', 'evidence');
const BUILD = 'Logseq-OG-F28-IdentityCapture';
const API = '__LOGSEQ_OG_BRIDGE_OBSERVATION__';
const CONSOLE_PREFIX = '[OG-BRIDGE-OBSERVATION] ';
const GRAPH_DIRECTORY = 'graph';
const PROFILE_DIRECTORY = 'identity-state';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const contentHash = value => `sha256:${sha256(value)}`;
const digestHex = value => sha256(value).slice(0, 32);
const assert = (value, message) => { if (!value) throw new Error(message); };
const deepEqualCanonical = (left, right) =>
  stableStringify(left) === stableStringify(right);
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};

function ownedProcesses(executable) {
  const name = path.basename(executable);
  return execFileSync('ps', ['-axo', 'pid=,comm='], {encoding: 'utf8'})
    .split('\n').filter(line => line.includes(name));
}

function git(args) {
  try { return execFileSync('git', args, {cwd: REPO, encoding: 'utf8'}).trim(); }
  catch (_error) { return null; }
}

// ------------------------------------------------------- observation runtime

async function readEvents(page) {
  return page.evaluate(name => {
    const api = window[name];
    if (!api || api.schema !== 'frontend.fs.og-sync-bridge.observation/1' ||
        api.mode !== 'observation-only' || typeof api.read !== 'function') return null;
    return api.read();
  }, API);
}

async function readHealth(page) {
  return page.evaluate(name => {
    const api = window[name];
    if (!api || typeof api.health !== 'function') return null;
    return api.health();
  }, API);
}

function healthSummary(health) {
  if (!health) return {available: false};
  return {
    available: true,
    enabled: health.enabled,
    blocked: health.blocked,
    blockedStage: health['blocked-stage'] ?? null,
    blockedCode: health['blocked-code'] ?? null,
    instanceMatchesReader: health['instance-matches-reader'],
    hookEntries: health['hook-entries'],
    recordedEvents: health['recorded-events'],
  };
}

// Observer health, not just its event list. A latched `blocked` observer records
// nothing while still answering `read()` with a plausible short list.
function healthVerdict(health) {
  const s = healthSummary(health);
  if (!s.available) return {ok: false, verdict: 'observation-health-unavailable', ...s};
  if (!s.enabled) return {ok: false, verdict: 'observation-runtime-not-installed', ...s};
  if (s.blocked) return {ok: false, verdict: 'recording-failed-observer-blocked', ...s};
  if (!s.instanceMatchesReader) return {ok: false, verdict: 'reader-and-seams-on-different-runtime-instances', ...s};
  const entries = s.hookEntries || {};
  const total = (entries.save || 0) + (entries.rename || 0) + (entries.watcher || 0);
  if (total === 0) return {ok: false, verdict: 'hooks-never-entered', ...s};
  return {ok: true, verdict: 'observer-healthy', ...s};
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
    await Promise.resolve(write(repo, pageValue.id, 'identity-capture-save'));
    return {pageId: pageValue.id, repo};
  }, pageName);
}

async function editBlockThroughUi(session, pageName, blockUuid, content) {
  await session.goTo(pageName);
  const block = session.page.locator(`#main-content-container [blockid="${blockUuid}"] .block-content`).first();
  await block.click({timeout: 20000});
  const editor = session.page.locator('textarea[aria-label="editing block"]').first();
  await editor.waitFor({state: 'visible', timeout: 10000});
  await editor.fill(content);
  const editorValueMatched = await editor.inputValue() === content;
  await session.page.keyboard.press('Escape');
  const displayedAfterEscape = await session.page.waitForFunction(({blockUuid, content}) => {
    const element = document.querySelector(`#main-content-container [blockid="${blockUuid}"] .block-content`);
    return element && element.innerText.includes(content);
  }, {blockUuid, content}, {timeout: 10000}).then(() => true).catch(() => false);
  return {editorOpened: true, editorValueMatched, displayedAfterEscape, page: pageName, blockUuid};
}

async function pageContains(session, pageName, expected) {
  await session.goTo(pageName);
  return session.page.evaluate(value => document.body.innerText.includes(value), expected);
}

// --------------------------------------------------------- cause grouping
//
// One logical desktop save passes through more than one observation seam, so
// several cause pairs share the exact graph-id + path + content-hash. A group is
// completion evidence only when EVERY cause in it has a completed event; a
// pending or failed cause is never completion. Operation identity is never
// inferred from elapsed time.

function saveGroupsFor(events, graphId, notePath) {
  const byHash = new Map();
  for (const event of events || []) {
    if (!event || !event.cause || event.cause.kind !== 'save') continue;
    if (event.cause['graph-id'] !== graphId || event.cause.path !== notePath) continue;
    const hash = event.cause['content-hash'];
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, new Map());
    const group = byHash.get(hash);
    const causeId = event.cause['cause-id'];
    if (!group.has(causeId)) group.set(causeId, {causeId, hash, events: []});
    group.get(causeId).events.push(event.event);
  }
  const describe = group => {
    const causes = [...group.values()];
    return {
      causeCount: causes.length,
      complete: causes.length > 0 && causes.every(cause =>
        cause.events.includes('save-completed') && !cause.events.includes('save-failed')),
      statuses: causes.map(cause => ({
        events: cause.events,
        complete: cause.events.includes('save-completed'),
        failed: cause.events.includes('save-failed'),
      })),
    };
  };
  return {byHash, describe};
}

function completedSaveGroup(events, graphId, notePath, hash) {
  const {byHash, describe} = saveGroupsFor(events, graphId, notePath);
  const group = byHash.get(hash);
  if (!group) return {exists: false, complete: false, causeCount: 0, statuses: []};
  const summary = describe(group);
  return {exists: true, ...summary};
}

function renameCausesFor(events, graphId, oldPath, newPath) {
  const causes = new Map();
  for (const event of events || []) {
    if (!event || !event.cause || event.cause.kind !== 'rename') continue;
    const cause = event.cause;
    if (cause['graph-id'] !== graphId ||
        cause['old-path'] !== oldPath || cause['new-path'] !== newPath) continue;
    const causeId = cause['cause-id'];
    if (!causes.has(causeId)) causes.set(causeId, {causeId, events: []});
    causes.get(causeId).events.push(event.event);
  }
  const list = [...causes.values()];
  return {
    causeCount: list.length,
    complete: list.length > 0 && list.every(cause =>
      cause.events.includes('rename-completed') && !cause.events.includes('rename-failed')),
    statuses: list.map(cause => ({events: cause.events})),
  };
}

// ------------------------------------------------------------- capture path

function stableRead(context, notePath) {
  const first = PI.readNote(context, notePath);
  const second = PI.readNote(context, notePath);
  return {
    content: first,
    stable: first !== null && first === second,
    hash: first === null ? null : contentHash(first),
  };
}

function stableAbsentRead(context, notePath) {
  const first = PI.readNote(context, notePath);
  const second = PI.readNote(context, notePath);
  return {content: first, absent: first === null && second === null};
}

function saveObservations({saveId, fileId, notePath, content, parentRevisionId}) {
  const revisionId = `rev-${digestHex(`${fileId}\0${parentRevisionId}\0${content}`)}`;
  return [
    {observationId: `obs-${saveId}-complete`, type: 'save-complete', saveId, fileId,
     path: notePath, content, parentRevisionId, revisionId},
    {observationId: `obs-${saveId}-read`, type: 'stable-read', causeType: 'save',
     causeId: saveId, path: notePath, content, stable: true},
  ];
}

function renameObservations({renameId, fileId, oldPath, newPath, parentRevisionId, content}) {
  const revisionId = `rev-${digestHex(`${fileId}\0${parentRevisionId}\0rename\0${newPath}`)}`;
  return [
    {observationId: `obs-${renameId}-intent`, type: 'rename-intent', renameId, fileId,
     oldPath, newPath, parentRevisionId, revisionId},
    {observationId: `obs-${renameId}-complete`, type: 'rename-complete', renameId,
     succeeded: true},
    {observationId: `obs-${renameId}-read`, type: 'stable-read', causeType: 'rename',
     causeId: renameId, path: newPath, content, stable: true, oldPathAbsent: true},
  ];
}

function runCapture(accepted, observations, proposedMetadataRevision) {
  return captureChanges({
    schema: CAPTURE_BATCH_SCHEMA,
    metadata: accepted.sidecar.identity,
    replica: accepted.device.replica,
    acceptedSnapshot: accepted.snapshot,
    expectedMetadataRevision: accepted.sidecar.metadataRevision,
    proposedMetadataRevision,
    observations,
    reviewDecisions: [],
  });
}

// The exact update the captured proposal implies, with every content re-read
// through the helper so the record is derived from the bytes actually on disk.
function updateRequestFromCapture(context, accepted, result) {
  const files = Object.entries(result.proposedMetadata.files).map(([fileId, entry]) => {
    const content = PI.readNote(context, entry.path);
    assert(content !== null, `proposed file ${entry.path} is absent from the graph`);
    assert(contentHash(content) === entry.acceptedContentHash,
      `graph bytes for ${entry.path} differ from the captured proposal`);
    return {fileId, path: entry.path, content, acceptedRevision: entry.acceptedRevision};
  });
  return {
    expectedMetadataRevision: accepted.sidecar.metadataRevision,
    metadataRevision: result.proposedMetadata.metadataRevision,
    files,
    tombstones: [],
  };
}

async function waitFor(predicate, label, {timeoutMs = 30000, intervalMs = 400} = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try { value = await predicate(); } catch (_error) { value = null; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await OP.sleep(intervalMs);
  }
}

// ------------------------------------------------------------------- batch

async function run() {
  const verifyIndex = process.argv.indexOf('--verify-reopen');
  const resumeFile = verifyIndex >= 0 ? process.argv[verifyIndex + 1] : null;
  const verifyReopenOnly = verifyIndex >= 0;
  const prior = resumeFile ? JSON.parse(fs.readFileSync(path.resolve(resumeFile), 'utf8')) : null;

  const helper = process.env.F28_IDENTITY_HELPER;
  const ownerToken = process.env.F28_OWNER_TOKEN ||
    (prior ? prior.owned.ownerToken : null) || crypto.randomBytes(32).toString('hex');
  assert(helper, 'F28_IDENTITY_HELPER must name the built identity_store_helper binary');
  assert(/^[0-9a-f]{64}$/.test(ownerToken), 'the owner token must be 64 hex characters');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(EVIDENCE, `f28-identity-capture-${stamp}.json`);
  const diagnostics = path.join(EVIDENCE, `f28-identity-capture-${stamp}-diagnostics`);
  process.env.F28_DIAG_DIR = diagnostics;
  const runName = process.env.F28_IDENTITY_RUN_NAME ||
    (prior ? prior.owned.runName : `f28-identity-capture-${stamp}-${crypto.randomBytes(3).toString('hex')}`);
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(runName), 'run name is not a safe helper component');

  const out = {schema: 'f28-identity-live-capture/1', stamp, status: 'preparing', checks: [],
    simulation: false, synchronizationEnabled: false, contentRecorded: false,
    transport: 'none — local capture only; no incoming application',
    resumedFrom: resumeFile ? path.resolve(resumeFile) : null};
  const record = (id, ok, detail) => {
    out.checks.push({id, ok, detail});
    save(evidenceFile, out);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
    assert(ok, id);
  };
  const phase = name => { PI.setDiagnosticCase(name); out.phase = name; };

  let profile;
  let session;
  let reopened;
  let graph = null;
  let profileRecords = null;
  let streamedEvents = [];
  const currentEvents = async page => {
    const events = await readEvents(page).catch(() => null);
    const bySequence = new Map(((events || []) || []).map(event => [event.sequence, event]));
    for (const event of streamedEvents) bySequence.set(event.sequence, event);
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  };

  try {
    // ------------------------------------------------ build and owned roots
    phase('preflight');
    const built = APP.resolve(BUILD);
    assert(built.preflight.ok, 'identity-capture package preflight failed');
    const manifest = built.preflight.manifest;
    assert(manifest.builtFrom && !manifest.builtFrom.dirty,
      'identity-capture package is not from clean source');
    assert(manifest.experiment?.bridge?.mode === 'observation-only',
      'manifest lacks observation-only bridge mode');
    assert(manifest.experiment?.bridge?.persistence === false &&
           manifest.experiment?.bridge?.synchronizationPorts === false,
      'manifest does not refuse persistence/synchronization ports');
    assert(!ownedProcesses(built.exe).length,
      'an identity-capture package process is already running; refusing to touch it');
    out.build = {id: manifest.pilotBuildId, source: manifest.builtFrom,
      productName: manifest.productName, bundleId: manifest.bundleId,
      packageName: manifest.packageName, architecture: manifest.host.arch,
      bridge: manifest.experiment.bridge, executable: built.exe};
    out.source = {commit: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      uncommitted: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length};
    out.helper = {path: helper, sha256: contentHash(fs.readFileSync(helper))};
    out.adapter = {graphTreeWrites: 'helper-owned logseq/.og-sync records only',
      noteWrites: 'none — the coordinator never writes a note; OG is the sole note writer',
      helperExecutionOrigin: 'this external coordinator process only',
      appAuthorityAdded: 'none — no new IPC, no process-launch exception, no renderer filesystem access'};
    record('identity-clean-identity-capture-build', true, out.build);

    const context = {helper, runName, ownerToken,
      graphDirectory: GRAPH_DIRECTORY, profileDirectory: PROFILE_DIRECTORY};
    graph = path.join(B.allowedRootReal(), runName, GRAPH_DIRECTORY);
    profileRecords = path.join(PI.PROFILE_ROOT, runName, PROFILE_DIRECTORY);
    PI.initializeOwnedRun(context);
    out.owned = {runName, graphDirectory: GRAPH_DIRECTORY, profileDirectory: PROFILE_DIRECTORY,
      graph, profileRecords, ownerToken,
      note: 'owner token is retained here only so this local evidence file can resume the run; it is never a Git input'};
    record('owned-run-initialized-under-both-anchored-roots',
      fs.realpathSync(graph) === graph && fs.realpathSync(profileRecords) === profileRecords &&
      graph !== B.allowedRootReal() && B.assertInsideAllowedRoot('owned live graph', graph) === graph,
      {graph, profileRecords, helperSha256: out.helper.sha256});

    if (prior) {
      const state = FP.stateRootFor(built.identity);
      const kept = prior.profileCleanup?.kept;
      assert(kept && fs.existsSync(kept), 'preserved resume profile is missing');
      assert(!fs.existsSync(state.root), 'identity-capture profile root is occupied; refusing resume');
      FP.assertOurs(kept, built.identity);
      fs.renameSync(kept, state.root);
      profile = {identity: built.identity, root: state.root, productDir: state.productDir,
        stamp, preserved: null, marker: null, preExisting: false};
    } else {
      profile = FP.swapAside(built.identity, {stamp});
    }
    out.appProfile = {root: profile.root, preExisting: profile.preExisting,
      preserved: profile.preserved,
      note: 'separate from the anchored IdentityExp record root; no app file can appear in an owned identity run'};
    record('fresh-app-profile-outside-record-roots',
      !profile.root.includes('IdentityExp'), out.appProfile);

    // ------------------------------------------------------------ session 1
    phase('session-1');
    const launch = NET.launchWith(options => _electron.launch(options), BUILD);
    const bad = path.join(path.dirname(B.allowedRootReal()), 'f28-identity-capture-inert-probe');
    const errors = {record() {}, phase() {}, endPhase() {}, entries() { return []; }, phases() { return []; }};
    session = await APP.open({built, graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`launch-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    session.page.on('console', message => {
      const value = message.text();
      if (!value.startsWith(CONSOLE_PREFIX)) return;
      try { streamedEvents.push(JSON.parse(value.slice(CONSOLE_PREFIX.length))); }
      catch (error) { out.consoleParseFailure = String(error); }
    });
    const isolation = await session.app.evaluate(({app}) => ({userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'), home: app.getPath('home')}));
    record('fresh-isolated-profile',
      Object.values(isolation).every(value => value.startsWith(profile.root + path.sep)), isolation);
    const plugins = FP.pluginsDirIn(profile.root);
    const pluginNames = fs.existsSync(plugins) ? fs.readdirSync(plugins).filter(name => name !== '.DS_Store') : [];
    record('no-plugins-or-credentials', pluginNames.length === 0, {pluginCount: pluginNames.length});
    const network = await NET.read(session.app);
    record('pre-navigation-network-refusal', network?.active && network.sessions >= 1, network);
    const initialEvents = await readEvents(session.page);
    record('observation-runtime-only', Array.isArray(initialEvents),
      {schema: 'frontend.fs.og-sync-bridge.observation/1', initialCount: initialEvents?.length});
    const initialHealth = await readHealth(session.page);
    out.initialHealth = healthSummary(initialHealth);
    record('observer-healthy-at-startup', healthVerdict(initialHealth).ok, healthVerdict(initialHealth));

    const expectedGraphId = `logseq_local_${graph}`;

    if (verifyReopenOnly) {
      assert(prior?.operation && prior?.crossQuit, 'reopen evidence lacks the operated identities');
      await verifyReopen({record, session, context, out, prior});
      out.finalClose = await APP.close(session); session = null;
      record('final-owned-quit-clean', out.finalClose.stillAlive.length === 0 &&
        !ownedProcesses(built.exe).length, out.finalClose);
      out.status = 'reopen-verified';
      return;
    }

    // ----------------------------------------------- synthetic pages via OG
    phase('create-pages');
    const nameDate = stamp.slice(0, 10);
    const english = `IdentityCapture English ${nameDate}`;
    const koreanSource = `신원캡처 한국어 ${nameDate}`;
    const renamed = `신원캡처 이름변경 ${nameDate} ${stamp.slice(11, 19).replace(/-/g, '')}`;
    const englishCreate = 'Synthetic English note created through OG.';
    const koreanCreate = 'OG를 통해 만든 합성 한국어 노트입니다.';
    const englishEditA = `Synthetic English note edited and saved through OG, first edit (${stamp}).`;
    const englishEditB = `Synthetic English note edited and saved through OG, second edit (${stamp}).`;
    const englishEditC = `Synthetic English note edited and saved through OG, third edit (${stamp}).`;
    const koreanEdit = `이름을 바꾸기 전에 OG에서 편집하고 저장했습니다 (${stamp}).`;
    const koreanEditAfterRename = `이름을 바꾼 뒤 OG에서 다시 편집하고 저장했습니다 (${stamp}).`;

    await api(session.page, 'create_page', english, {}, {redirect: false, createFirstBlock: false, format: 'markdown'});
    const englishBlock = await api(session.page, 'insert_block', english, englishCreate, {focus: false});
    await api(session.page, 'create_page', koreanSource, {}, {redirect: false, createFirstBlock: false, format: 'markdown'});
    const koreanBlock = await api(session.page, 'insert_block', koreanSource, koreanCreate, {focus: false});
    assert(englishBlock?.uuid && koreanBlock?.uuid, 'block creation returned no identity');
    await flushPageThroughOg(session.page, english);
    await flushPageThroughOg(session.page, koreanSource);
    const englishPath = `pages/${english}.md`;
    const oldKoreanPath = `pages/${koreanSource}.md`;
    const renamedPath = `pages/${renamed}.md`;
    out.operation = {english, koreanSource, renamed, englishPath, oldKoreanPath, renamedPath,
      englishBlock: englishBlock.uuid, koreanBlock: koreanBlock.uuid, expectedGraphId};
    const englishSeed = stableRead(context, englishPath);
    const koreanSeed = stableRead(context, oldKoreanPath);
    assert(englishSeed.stable && englishSeed.content !== null && koreanSeed.stable,
      'the freshly created pages are not stably readable through the helper');
    record('created-english-and-korean-via-og',
      englishSeed.content.includes(englishCreate) && koreanSeed.content.includes(koreanCreate),
      {englishBlock: englishBlock.uuid, koreanBlock: koreanBlock.uuid,
       englishBytesSha256: sha256(englishSeed.content), koreanBytesSha256: sha256(koreanSeed.content)});

    // -------------------------------------------------------- enrollment
    phase('enrollment');
    const opened0 = PI.openGraph(context);
    record('unenrolled-before-explicit-enrollment', opened0.outcome === 'unenrolled',
      {outcome: opened0.outcome});
    const beforeEnrollment = PI.hashGraphNotes(context);
    const graphId = `f28-identity-graph-${nameDate}-${crypto.randomBytes(4).toString('hex')}`;
    let revisionCounter = 0;
    const nextRevision = () => `metadata-${++revisionCounter}`;
    const enrollment = PI.enrollGraph(context, {
      graphId,
      replicaId: 'replica-identity-capture-local-1',
      deviceId: 'device-identity-capture-local-1',
      metadataRevision: nextRevision(),
      files: [
        {fileId: 'file-english', path: englishPath, content: englishSeed.content,
         acceptedRevision: 'accepted-revision-enrollment-english'},
        {fileId: 'file-korean', path: oldKoreanPath, content: koreanSeed.content,
         acceptedRevision: 'accepted-revision-enrollment-korean'},
      ],
    });
    assert(enrollment.outcome === 'accepted', `enrollment was refused: ${enrollment.code}`);
    const afterEnrollment = PI.hashGraphNotes(context);
    record('explicit-enrollment-leaves-note-bytes-unchanged',
      afterEnrollment.hash === beforeEnrollment.hash && afterEnrollment.count === beforeEnrollment.count,
      {before: beforeEnrollment, after: afterEnrollment});
    const accepted1 = PI.openGraph(context);
    record('enrollment-accepted-reads-back-exactly',
      accepted1.outcome === 'accepted' && accepted1.sidecar.graphId === graphId &&
      accepted1.sidecar.metadataRevision === 'metadata-1' &&
      deepEqualCanonical(Object.keys(accepted1.sidecar.identity.files), ['file-english', 'file-korean']) &&
      accepted1.sidecar.acceptedSnapshotFingerprint === accepted1.snapshot.snapshotFingerprint,
      {outcome: accepted1.outcome, graphId, metadataRevision: accepted1.sidecar?.metadataRevision,
       snapshotFingerprint: accepted1.snapshot?.snapshotFingerprint});
    const records1 = PI.readRecords(context);
    const sidecarText = records1.sidecarBytes.toString('utf8');
    record('sidecar-portable-no-device-material',
      !sidecarText.includes('/Users/') && !sidecarText.includes('Application Support') &&
      !sidecarText.includes('replicaId') && !sidecarText.includes('deviceId') &&
      !sidecarText.includes('profileBinding'),
      {graphId, metadataRevision: records1.sidecar?.metadataRevision});

    // ------------------------------------ English edits A then B, pending demo
    phase('english-edits');
    const englishUiA = await editBlockThroughUi(session, english, englishBlock.uuid, englishEditA);
    assert(englishUiA.editorValueMatched, 'English first edit did not reach the editor');
    const preFlushGroups = saveGroupsFor(await currentEvents(session.page), expectedGraphId, englishPath);
    const preFlushDisk = stableRead(context, englishPath);
    const preFlushIncomplete = [...preFlushGroups.byHash.entries()]
      .map(([hash, group]) => ({hash, ...preFlushGroups.describe(group)}))
      .filter(group => !group.complete);
    record('pending-intent-is-not-completion',
      preFlushIncomplete.every(group => group.hash !== preFlushDisk.hash),
      {saveCauseGroups: [...preFlushGroups.byHash.keys()].length,
       incompleteGroups: preFlushIncomplete.map(group => ({causeCount: group.causeCount, statuses: group.statuses})),
       diskHash: preFlushDisk.hash,
       note: 'an intent or queued flush that has not completed is never capture evidence; a group is one logical save only when every cause in it completed'});
    await flushPageThroughOg(session.page, english);
    const readA = stableRead(context, englishPath);
    assert(readA.stable && readA.content !== null && readA.content.includes(englishEditA),
      'the first English save did not reach the graph bytes');
    const groupA = completedSaveGroup(await currentEvents(session.page),
      expectedGraphId, englishPath, readA.hash);
    assert(groupA.exists && groupA.complete,
      'the first English save has no completed cause group matching the disk bytes');
    const newHashA = readA.hash;
    const bytesA = readA.content;
    const saveIdA = `save-${digestHex(`${expectedGraphId}\0${englishPath}\0${newHashA}`)}`;

    const englishUiB = await editBlockThroughUi(session, english, englishBlock.uuid, englishEditB);
    assert(englishUiB.editorValueMatched, 'English second edit did not reach the editor');
    await flushPageThroughOg(session.page, english);
    const readB = stableRead(context, englishPath);
    assert(readB.stable && readB.hash !== newHashA && readB.content.includes(englishEditB),
      'the second English save did not advance the graph bytes');

    // The earlier completed save, re-read now that a later edit advanced the
    // bytes, must stay pending: the disk no longer carries its content, so no
    // stable read can confirm it and nothing is falsely accepted.
    const staleRead = stableRead(context, englishPath);
    const staleBatch = runCapture(accepted1, [
      {observationId: `obs-${saveIdA}-complete`, type: 'save-complete', saveId: saveIdA,
       fileId: 'file-english', path: englishPath, content: bytesA,
       parentRevisionId: accepted1.sidecar.identity.files['file-english'].acceptedRevision,
       revisionId: `rev-${digestHex(`file-english\0${accepted1.sidecar.identity.files['file-english'].acceptedRevision}\0${bytesA}`)}`},
      {observationId: `obs-${saveIdA}-unstable`, type: 'unstable-read', path: englishPath,
       reason: 'a later edit advanced the bytes; the stable re-read no longer matches the completed save',
       causeType: 'save', causeId: saveIdA},
    ], 'metadata-2');
    assert(!staleBatch.eligibility.eligible,
      'a later edit was falsely accepted as the earlier completed save');
    assert(staleBatch.reviewItems.some(item => item.code === 'save-awaiting-matching-stable-read') &&
           staleBatch.reviewItems.some(item => item.code === 'unstable-read'),
      'the stale operation did not remain pending with its evidence');
    out.staleSave = {saveId: saveIdA, causeHash: newHashA,
      pendingCodes: staleBatch.reviewItems.map(item => item.code),
      diskBytesSha256: sha256(staleRead.content), evidenceKept: true};
    record('later-edit-leaves-earlier-completed-save-pending', true, out.staleSave);
    // While the disk is ahead of the sidecar the store refuses to read as
    // accepted — that ambiguity is itself the pending state, so the retained
    // pre-edit accepted state is the only capture baseline. The records
    // themselves must not have moved.
    const ambiguousOpen = PI.openGraph(context);
    const recordsStill1 = PI.readRecords(context);
    record('earlier-save-pending-did-not-advance-records',
      ambiguousOpen.outcome === 'refused' && ambiguousOpen.code === 'snapshot-mismatch' &&
      recordsStill1.sidecar.metadataRevision === 'metadata-1' &&
      recordsStill1.outstandingIntents.length === 0 &&
      recordsStill1.sidecarHash === records1.sidecarHash,
      {ambiguousOutcome: ambiguousOpen.outcome, ambiguousCode: ambiguousOpen.code,
       metadataRevision: recordsStill1.sidecar?.metadataRevision,
       note: 'openGraph refuses the disk-ahead state instead of accepting it; the sidecar is unchanged at metadata-1'});

    // The current logical save, identified by the exact disk bytes, captured.
    const captureB = await waitFor(async () => {
      const events = await currentEvents(session.page);
      const group = completedSaveGroup(events, expectedGraphId, englishPath, readB.hash);
      return group.complete ? group : null;
    }, 'the second English save to complete its cause group');
    const saveIdB = `save-${digestHex(`${expectedGraphId}\0${englishPath}\0${readB.hash}`)}`;
    const batchB = runCapture(accepted1, saveObservations({
      saveId: saveIdB, fileId: 'file-english', notePath: englishPath, content: readB.content,
      parentRevisionId: accepted1.sidecar.identity.files['file-english'].acceptedRevision,
    }), 'metadata-2');
    assert(batchB.eligibility.eligible && batchB.capturedEvents.length === 1,
      `the second English save was not captured: ${JSON.stringify(batchB.eligibility)} ` +
      `${JSON.stringify(batchB.invalid)}`);
    const requestB = updateRequestFromCapture(context, accepted1, batchB);
    const updateB = PI.updateIdentity(context, requestB, {ordering: 'graph-first'});
    assert(updateB.outcome === 'accepted', `the English update was refused: ${updateB.code}`);
    const acceptedB = PI.openGraph(context);
    record('english-save-captured-to-accepted-record',
      acceptedB.outcome === 'accepted' &&
      acceptedB.sidecar.metadataRevision === 'metadata-2' &&
      acceptedB.sidecar.acceptedSnapshotFingerprint === acceptedB.snapshot.snapshotFingerprint &&
      deepEqualCanonical(acceptedB.sidecar.identity, batchB.proposedMetadata) &&
      contentHash(PI.readNote(context, englishPath)) ===
        acceptedB.sidecar.identity.files['file-english'].acceptedContentHash,
      {causeHash: readB.hash, causeCount: captureB.causeCount,
       metadataRevision: acceptedB.sidecar.metadataRevision,
       acceptedRevision: acceptedB.sidecar.identity.files['file-english'].acceptedRevision,
       transactionId: updateB.transactionId,
       note: 'the nested filesystem/node seam causes collapse into one logical save'});

    // --------------------------------------------------------- Korean save
    phase('korean-save');
    const koreanUi = await editBlockThroughUi(session, koreanSource, koreanBlock.uuid, koreanEdit);
    assert(koreanUi.editorValueMatched, 'Korean edit did not reach the editor');
    await flushPageThroughOg(session.page, koreanSource);
    const readK = stableRead(context, oldKoreanPath);
    assert(readK.stable && readK.content.includes(koreanEdit),
      'the Korean save did not reach the graph bytes');
    const captureK = await waitFor(async () => {
      const events = await currentEvents(session.page);
      const group = completedSaveGroup(events, expectedGraphId, oldKoreanPath, readK.hash);
      return group.complete ? group : null;
    }, 'the Korean save to complete its cause group');
    const saveIdK = `save-${digestHex(`${expectedGraphId}\0${oldKoreanPath}\0${readK.hash}`)}`;
    const batchK = runCapture(acceptedB, saveObservations({
      saveId: saveIdK, fileId: 'file-korean', notePath: oldKoreanPath, content: readK.content,
      parentRevisionId: acceptedB.sidecar.identity.files['file-korean'].acceptedRevision,
    }), 'metadata-3');
    assert(batchK.eligibility.eligible && batchK.capturedEvents.length === 1,
      'the Korean save was not captured');
    const updateK = PI.updateIdentity(context, updateRequestFromCapture(context, acceptedB, batchK),
      {ordering: 'graph-first'});
    assert(updateK.outcome === 'accepted', `the Korean update was refused: ${updateK.code}`);
    const acceptedK = PI.openGraph(context);
    record('korean-save-captured-to-accepted-record',
      acceptedK.outcome === 'accepted' && acceptedK.sidecar.metadataRevision === 'metadata-3' &&
      deepEqualCanonical(acceptedK.sidecar.identity, batchK.proposedMetadata),
      {causeHash: readK.hash, causeCount: captureK.causeCount,
       metadataRevision: acceptedK.sidecar.metadataRevision, transactionId: updateK.transactionId});

    // ---------------------------------------------------------- Korean rename
    phase('korean-rename');
    await api(session.page, 'rename_page', koreanSource, renamed);
    const renameComplete = await waitFor(async () => {
      const events = await currentEvents(session.page);
      const causes = renameCausesFor(events, expectedGraphId, oldKoreanPath, renamedPath);
      return causes.complete ? causes : null;
    }, 'the Korean rename to complete its cause group');
    const readRenamed = stableRead(context, renamedPath);
    const absentOld = stableAbsentRead(context, oldKoreanPath);
    assert(readRenamed.stable && readRenamed.content !== null && absentOld.absent,
      'the renamed note is not stably readable at its new path with the old path absent');
    assert(contentHash(readRenamed.content) ===
      acceptedK.sidecar.identity.files['file-korean'].acceptedContentHash,
      'the rename changed the note bytes, which the rename capture does not model');
    const renameId = `rename-${digestHex(`${expectedGraphId}\0${oldKoreanPath}\0${renamedPath}`)}`;
    const batchR = runCapture(acceptedK, renameObservations({
      renameId, fileId: 'file-korean', oldPath: oldKoreanPath, newPath: renamedPath,
      parentRevisionId: acceptedK.sidecar.identity.files['file-korean'].acceptedRevision,
      content: readRenamed.content,
    }), 'metadata-4');
    assert(batchR.eligibility.eligible && batchR.capturedEvents.length === 1,
      'the Korean rename was not captured');
    const updateR = PI.updateIdentity(context, updateRequestFromCapture(context, acceptedK, batchR),
      {ordering: 'graph-first'});
    assert(updateR.outcome === 'accepted', `the rename update was refused: ${updateR.code}`);
    const acceptedR = PI.openGraph(context);
    record('korean-rename-retains-file-identity-updates-path',
      acceptedR.outcome === 'accepted' &&
      acceptedR.sidecar.identity.files['file-korean'].path === renamedPath &&
      acceptedR.sidecar.identity.files['file-korean'].acceptedContentHash ===
        acceptedK.sidecar.identity.files['file-korean'].acceptedContentHash &&
      !Object.keys(acceptedR.sidecar.identity.tombstones).includes('file-korean'),
      {renameId, oldPath: oldKoreanPath, newPath: renamedPath,
       causeCount: renameComplete.causeCount, metadataRevision: acceptedR.sidecar.metadataRevision,
       transactionId: updateR.transactionId,
       note: 'same fileId, new canonical path, unchanged content hash'});

    // ------------------------------------- edit at the new path + duplicates
    phase('edit-after-rename');
    const koreanUi2 = await editBlockThroughUi(session, renamed, koreanBlock.uuid, koreanEditAfterRename);
    assert(koreanUi2.editorValueMatched, 'the post-rename Korean edit did not reach the editor');
    await flushPageThroughOg(session.page, renamed);
    const readR2 = stableRead(context, renamedPath);
    assert(readR2.stable && readR2.content.includes(koreanEditAfterRename),
      'the post-rename edit did not reach the graph bytes');
    const captureR2 = await waitFor(async () => {
      const events = await currentEvents(session.page);
      const group = completedSaveGroup(events, expectedGraphId, renamedPath, readR2.hash);
      return group.complete ? group : null;
    }, 'the post-rename save to complete its cause group');
    const saveIdR2 = `save-${digestHex(`${expectedGraphId}\0${renamedPath}\0${readR2.hash}`)}`;
    const observationsR2 = saveObservations({
      saveId: saveIdR2, fileId: 'file-korean', notePath: renamedPath, content: readR2.content,
      parentRevisionId: acceptedR.sidecar.identity.files['file-korean'].acceptedRevision,
    });
    // Every observation is fed twice in one batch: content-bound observation IDs
    // must collapse the duplicates into exactly one revision.
    const batchR2 = runCapture(acceptedR, observationsR2.concat(observationsR2), 'metadata-5');
    assert(batchR2.eligibility.eligible && batchR2.capturedEvents.length === 1,
      'duplicate observations in one batch did not collapse to one logical save');
    const updateR2 = PI.updateIdentity(context, updateRequestFromCapture(context, acceptedR, batchR2),
      {ordering: 'graph-first'});
    assert(updateR2.outcome === 'accepted', `the post-rename update was refused: ${updateR2.code}`);
    const acceptedR2 = PI.openGraph(context);
    record('post-rename-edit-captured-at-new-path',
      acceptedR2.outcome === 'accepted' && acceptedR2.sidecar.metadataRevision === 'metadata-5' &&
      deepEqualCanonical(acceptedR2.sidecar.identity, batchR2.proposedMetadata),
      {path: renamedPath, causeHash: readR2.hash, transactionId: updateR2.transactionId,
       metadataRevision: acceptedR2.sidecar.metadataRevision});
    record('duplicate-observations-single-revision',
      batchR2.capturedEvents.length === 1 &&
      acceptedR2.sidecar.identity.files['file-korean'].acceptedRevision !==
        acceptedR.sidecar.identity.files['file-korean'].acceptedRevision,
      {fedObservations: observationsR2.length * 2, capturedEvents: batchR2.capturedEvents.length,
       acceptedRevision: acceptedR2.sidecar.identity.files['file-korean'].acceptedRevision,
       note: 'the same evidence fed twice collapses by content-bound observation ID'});

    // Re-feeding completed evidence after acceptance is refused: the accepted
    // parent revision has moved on, so the module leaves it pending and no
    // second revision is created.
    const reFed = runCapture(acceptedR2, observationsR2, 'metadata-6');
    assert(!reFed.eligibility.eligible &&
           reFed.reviewItems.some(item => item.code === 'save-evidence-mismatch'),
      're-fed completed evidence was not refused as a save-evidence mismatch');
    const acceptedR2After = PI.openGraph(context);
    record('re-fed-completed-evidence-refused-no-second-revision',
      acceptedR2After.outcome === 'accepted' &&
      acceptedR2After.sidecar.metadataRevision === 'metadata-5' &&
      acceptedR2After.sidecar.acceptedSnapshotFingerprint === acceptedR2.sidecar.acceptedSnapshotFingerprint,
      {refusedCode: 'save-evidence-mismatch', metadataRevision: acceptedR2After.sidecar.metadataRevision,
       note: 'no updateIdentity was issued for the refused batch'});

    // ------------------------------------- injected record-persistence failure
    phase('injected-failure');
    const englishUiC = await editBlockThroughUi(session, english, englishBlock.uuid, englishEditC);
    assert(englishUiC.editorValueMatched, 'the third English edit did not reach the editor');
    await flushPageThroughOg(session.page, english);
    const readC = stableRead(context, englishPath);
    assert(readC.stable && readC.content.includes(englishEditC),
      'the third English save did not reach the graph bytes');
    const captureC = await waitFor(async () => {
      const events = await currentEvents(session.page);
      const group = completedSaveGroup(events, expectedGraphId, englishPath, readC.hash);
      return group.complete ? group : null;
    }, 'the third English save to complete its cause group');
    const saveIdC = `save-${digestHex(`${expectedGraphId}\0${englishPath}\0${readC.hash}`)}`;
    const batchC = runCapture(acceptedR2After, saveObservations({
      saveId: saveIdC, fileId: 'file-english', notePath: englishPath, content: readC.content,
      parentRevisionId: acceptedR2After.sidecar.identity.files['file-english'].acceptedRevision,
    }), 'metadata-6');
    assert(batchC.eligibility.eligible && batchC.capturedEvents.length === 1,
      'the third English save was not captured');
    const requestC = updateRequestFromCapture(context, acceptedR2After, batchC);
    const failed = PI.updateIdentity(context, requestC,
      {ordering: 'graph-first', failure: {step: 'device', point: 'after-stage'}});
    assert(failed.outcome === 'uncertain-write' && failed.code === 'write-outcome-unknown' &&
           failed.step === 'device',
      `the injected device-step failure did not leave an uncertain write: ${failed.outcome}/${failed.code}`);
    const bytesAfterFailure = stableRead(context, englishPath);
    const causesAfterFailure = completedSaveGroup(await currentEvents(session.page),
      expectedGraphId, englishPath, readC.hash);
    const recoveryPending = PI.openGraph(context);
    const failureRecords = PI.readRecords(context, failed.transactionId);
    out.injectedFailure = {transactionId: failed.transactionId, step: failed.step,
      point: 'after-stage (device record, graph-first ordering)',
      classification: 'sidecar at target, device record at base',
      intentRetained: failureRecords.intent !== null,
      evidenceRetained: failureRecords.evidence > 0,
      outstandingIntents: failureRecords.outstandingIntents};
    record('injected-persistence-failure-preserves-og-note-and-leaves-recovery-pending',
      bytesAfterFailure.stable && bytesAfterFailure.content === readC.content &&
      causesAfterFailure.complete && recoveryPending.outcome === 'recovery-required' &&
      recoveryPending.code === 'outstanding-intent' && failureRecords.intent !== null,
      {ogNoteBytesSha256: sha256(bytesAfterFailure.content), unchanged: true,
       outcome: recoveryPending.outcome, code: recoveryPending.code,
       saveCausesComplete: causesAfterFailure.complete, ...out.injectedFailure,
       note: 'the experimental failure stopped capture only; OG save-completed evidence and the saved note are untouched'});
    record('og-save-result-unchanged-by-capture-failure',
      causesAfterFailure.complete && bytesAfterFailure.content === readC.content,
      {causeHash: readC.hash, causeCount: causesAfterFailure.causeCount,
       bytesSha256: sha256(bytesAfterFailure.content),
       note: 'no experimental path reported the OG save as failed or altered an OG error'});

    // With the sidecar already at its target, the identical re-issue is refused:
    // the store will not re-derive a transaction its own sidecar already names,
    // so the only continuation is the validated recovery of the outstanding one.
    const refusedRetry = PI.updateIdentity(context, requestC, {ordering: 'graph-first'});
    assert(refusedRetry.outcome === 'refused' && refusedRetry.code === 'stale-metadata-revision',
      `the identical re-issue was not refused as a moved sidecar: ${refusedRetry.outcome}/${refusedRetry.code}`);
    const recovered = PI.recover(context, {transactionId: failed.transactionId});
    assert(recovered.outcome === 'recovered' && recovered.classification === 'graph-applied',
      `recovery did not reconcile the outstanding transaction: ${recovered.outcome}/${recovered.code}`);
    const acceptedC = recovered.opened;
    const bytesAfterRecovery = stableRead(context, englishPath);
    record('exact-outstanding-transaction-recovers-exact-state',
      acceptedC.outcome === 'accepted' &&
      acceptedC.sidecar.metadataRevision === 'metadata-6' &&
      deepEqualCanonical(acceptedC.sidecar.identity, batchC.proposedMetadata) &&
      bytesAfterRecovery.content === readC.content &&
      PI.readRecords(context).outstandingIntents.length === 0,
      {transactionId: failed.transactionId, classification: recovered.classification,
       refusedReIssue: refusedRetry.code,
       metadataRevision: acceptedC.sidecar.metadataRevision,
       bytesSha256: sha256(bytesAfterRecovery.content), evidenceRetained: out.injectedFailure.evidenceRetained});

    // -------------------------------------------------------- quit and restart
    phase('pre-quit');
    const preQuitHealth = await readHealth(session.page);
    out.preQuitHealth = healthSummary(preQuitHealth);
    const preQuitVerdict = healthVerdict(preQuitHealth);
    record('observer-healthy-before-quit', preQuitVerdict.ok, preQuitVerdict);
    out.preQuitEvents = await currentEvents(session.page);
    const preQuitNotes = PI.hashGraphNotes(context);
    out.preQuitIdentity = {metadataRevision: acceptedC.sidecar.metadataRevision,
      snapshotFingerprint: acceptedC.sidecar.acceptedSnapshotFingerprint,
      notes: preQuitNotes};
    save(evidenceFile, out);

    out.firstClose = await APP.close(session); session = null;
    record('first-owned-quit-clean', out.firstClose.stillAlive.length === 0 &&
      !ownedProcesses(built.exe).length, out.firstClose);

    phase('across-quit');
    const acrossQuit = PI.openGraph(context);
    const afterQuitNotes = PI.hashGraphNotes(context);
    const bytesEnglishQuit = stableRead(context, englishPath);
    const bytesRenamedQuit = stableRead(context, renamedPath);
    out.crossQuit = {metadataRevision: acrossQuit.sidecar?.metadataRevision,
      snapshotFingerprint: acrossQuit.sidecar?.acceptedSnapshotFingerprint,
      englishBytesSha256: sha256(bytesEnglishQuit.content),
      renamedBytesSha256: sha256(bytesRenamedQuit.content),
      notes: afterQuitNotes};
    record('identity-consistent-across-quit',
      acrossQuit.outcome === 'accepted' &&
      acrossQuit.sidecar.metadataRevision === out.preQuitIdentity.metadataRevision &&
      acrossQuit.sidecar.acceptedSnapshotFingerprint === out.preQuitIdentity.snapshotFingerprint &&
      afterQuitNotes.hash === preQuitNotes.hash && afterQuitNotes.count === preQuitNotes.count &&
      bytesEnglishQuit.content === readC.content &&
      bytesRenamedQuit.content === readR2.content,
      {outcome: acrossQuit.outcome, metadataRevision: acrossQuit.sidecar?.metadataRevision,
       notesBefore: preQuitNotes, notesAfter: afterQuitNotes,
       note: 'validated with no application running'});

    phase('reopen');
    reopened = await APP.open({built, graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`reopen-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    const reopenHealth = await readHealth(reopened.page);
    out.reopenHealth = healthSummary(reopenHealth);
    record('reopen-observer-healthy', healthVerdict(reopenHealth).ok, healthVerdict(reopenHealth));
    record('reopen-saved-english', await pageContains(reopened, english, englishEditC), {page: english});
    record('reopen-saved-renamed-korean',
      await pageContains(reopened, renamed, koreanEditAfterRename), {page: renamed});
    const reopenedIdentity = PI.openGraph(context);
    const bytesEnglishReopened = stableRead(context, englishPath);
    const bytesRenamedReopened = stableRead(context, renamedPath);
    record('reopened-identity-still-accepted',
      reopenedIdentity.outcome === 'accepted' &&
      reopenedIdentity.sidecar.metadataRevision === out.crossQuit.metadataRevision &&
      reopenedIdentity.sidecar.acceptedSnapshotFingerprint === out.crossQuit.snapshotFingerprint &&
      bytesEnglishReopened.content === readC.content &&
      bytesRenamedReopened.content === readR2.content,
      {outcome: reopenedIdentity.outcome,
       metadataRevision: reopenedIdentity.sidecar?.metadataRevision,
       englishBytesSha256: sha256(bytesEnglishReopened.content),
       renamedBytesSha256: sha256(bytesRenamedReopened.content)});

    out.finalClose = await APP.close(reopened); reopened = null;
    record('final-owned-quit-clean', out.finalClose.stillAlive.length === 0 &&
      !ownedProcesses(built.exe).length, out.finalClose);
    out.status = 'passed';
  } catch (error) {
    out.status = 'failed';
    out.failure = {message: String(error && error.message), stack: String(error && error.stack)};
    if (session) out.eventsAtFailure = await readEvents(session.page).catch(() => null);
    if (session) out.healthAtFailure = healthSummary(await readHealth(session.page).catch(() => null));
    if (session) out.streamedEventsAtFailure = streamedEvents;
    throw error;
  } finally {
    PI.setDiagnosticCase(null);
    if (session) {
      out.emergencyClose = await APP.close(session).catch(error => ({error: String(error)}));
      out.streamedEventsAfterEmergencyClose = streamedEvents;
    }
    if (reopened) out.emergencyReopenClose = await APP.close(reopened).catch(error => ({error: String(error)}));
    if (profile) out.profileCleanup = FP.restore(profile, {label: 'f28-identity-capture'});
    out.ownedRunRetained = {runName, graph, profileRecords,
      note: 'the owned run is retained with its records for inspection; prior runs and both shared roots were never enumerated'};
    out.diagnostics = {directory: diagnostics, sanitized: true,
      note: 'helper refusals and assertion failures only; no note content, record bytes or owner tokens'};
    out.tests = ['explicit enrollment of only the fresh synthetic graph leaves note bytes unchanged',
      'English and Korean saves through OG produce matching accepted records',
      'Korean rename retains file identity and updates the exact path',
      'a subsequent edit at the new path is captured correctly',
      'duplicate observations do not create duplicate revisions',
      'a controlled record-persistence failure preserves the OG note and leaves recovery pending',
      'the exact re-issue recovers the exact state',
      'safe quit and reopen verify note content and persistent identity consistency'];
    save(evidenceFile, out);
    console.log(`Evidence: ${evidenceFile}`);
  }
}

async function verifyReopen({record, session, context, out, prior}) {
  const {english, renamed, englishPath, renamedPath} = prior.operation;
  const expectedEnglish = prior.crossQuit.englishBytesSha256;
  const expectedRenamed = prior.crossQuit.renamedBytesSha256;
  const reopenedIdentity = PI.openGraph(context);
  const bytesEnglish = stableRead(context, englishPath);
  const bytesRenamed = stableRead(context, renamedPath);
  record('reopen-identity-unchanged',
    reopenedIdentity.outcome === 'accepted' &&
    reopenedIdentity.sidecar.metadataRevision === prior.crossQuit.metadataRevision &&
    reopenedIdentity.sidecar.acceptedSnapshotFingerprint === prior.crossQuit.snapshotFingerprint &&
    sha256(bytesEnglish.content) === expectedEnglish &&
    sha256(bytesRenamed.content) === expectedRenamed,
    {outcome: reopenedIdentity.outcome,
     metadataRevision: reopenedIdentity.sidecar?.metadataRevision});
  record('reopen-saved-english',
    await pageContains(session, english,
      `Synthetic English note edited and saved through OG, third edit (${prior.stamp}).`),
    {page: english});
  record('reopen-saved-renamed-korean',
    await pageContains(session, renamed,
      `이름을 바꾼 뒤 OG에서 다시 편집하고 저장했습니다 (${prior.stamp}).`),
    {page: renamed});
  out.status = 'reopen-verified';
}

module.exports = {
  saveGroupsFor, completedSaveGroup, renameCausesFor,
  stableRead, stableAbsentRead,
  saveObservations, renameObservations,
  runCapture, updateRequestFromCapture,
};

if (require.main === module) {
  run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}