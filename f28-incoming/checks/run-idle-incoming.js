#!/usr/bin/env node
'use strict';

/*
 * The idle-app incoming observation experiment.
 *
 * The owned experimental application is OPEN and untouched. One incoming change
 * is written from outside, and OG's ORDINARY external-change path is observed
 * end to end. This measures how OG really behaves; it establishes NOTHING about
 * concurrent-edit safety, and nothing here claims exactly-once behaviour.
 *
 * Mode is app-idle throughout and is named in every record. The application is
 * the accepted observation-only package, reused unmodified: no new IPC, no
 * native command authority, no renderer privilege, no process-launch exception,
 * no network permission.
 *
 * Each mutating or failing scenario runs in its OWN fresh owned case, because
 * the accepted slice permits one incoming transaction per owned run.
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
const {makeGate, makeIdleGate, ownedProcesses} = require('./app-closed-gate');
const PROBE = require('./og-idle-probe');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.resolve(REPO, '..', '..', 'evidence');
const BUILD = 'Logseq-OG-F28-IdentityCapture';
const API = '__LOGSEQ_OG_BRIDGE_OBSERVATION__';

const sha256 = value => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    await Promise.resolve(write(repo, pageValue.id, 'idle-incoming-save'));
    return {pageId: pageValue.id, repo};
  }, pageName);
}

/*
 * Leave edit mode through OG's own API and let the write queue drain. This is
 * done BEFORE the base is read and enrolled, so settling can never invalidate an
 * approval that was computed afterwards.
 */
async function settleEditor(page) {
  return page.evaluate(async () => {
    const editor = window.frontend?.handler?.editor;
    const state = window.frontend?.state;
    if (!state) return {ok: false, reason: 'frontend.state unavailable'};
    const before = state.get_edit_input_id ? state.get_edit_input_id() : null;
    try {
      if (editor && editor.save_current_block_BANG_) editor.save_current_block_BANG_();
    } catch (error) { return {ok: false, reason: `save-current-block failed: ${String(error)}`}; }
    try {
      if (state.clear_edit_BANG_) state.clear_edit_BANG_();
      else if (editor && editor.escape_editing) editor.escape_editing(false);
    } catch (error) { return {ok: false, reason: `clear-edit failed: ${String(error)}`}; }
    const after = state.get_edit_input_id ? state.get_edit_input_id() : null;
    return {ok: !after, before: before || null, after: after || null};
  });
}

async function readHealth(page) {
  return page.evaluate(name => {
    const api = window[name];
    return api && typeof api.health === 'function' ? api.health() : null;
  }, API);
}

/* Every .md under the owned graph, relative, so backups can be separated from
 * unexpected note changes. Only the EXACT owned graph is walked; no shared root
 * is ever listed. */
function inventoryOwnedGraph(graphDir) {
  const found = [];
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const child = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === 'logseq/.og-sync') continue;
      if (entry.isDirectory()) walk(child, rel);
      else if (entry.isFile() && /\.(md|org)$/.test(entry.name)) {
        found.push({path: rel, sha256: sha256(fs.readFileSync(child))});
      }
    }
  };
  walk(graphDir, '');
  return found.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

function classifyInventory(before, after) {
  const beforeByPath = new Map(before.map(item => [item.path, item.sha256]));
  const afterByPath = new Map(after.map(item => [item.path, item.sha256]));
  const backups = [];
  const changedNotes = [];
  const newNotes = [];
  const removed = [];
  for (const [p, hash] of afterByPath) {
    const wasHash = beforeByPath.get(p);
    const isBackup = p.startsWith('logseq/bak/');
    if (wasHash === undefined) (isBackup ? backups : newNotes).push({path: p, sha256: hash});
    else if (wasHash !== hash) (isBackup ? backups : changedNotes).push({path: p, sha256: hash});
  }
  for (const p of beforeByPath.keys()) if (!afterByPath.has(p)) removed.push(p);
  return {backups, changedNotes, newNotes, removed};
}

async function run() {
  const helper = process.env.F28_IDENTITY_HELPER;
  const ownerToken = process.env.F28_OWNER_TOKEN || crypto.randomBytes(32).toString('hex');
  assert(helper, 'F28_IDENTITY_HELPER must name the built identity_store_helper binary');
  assert(/^[0-9a-f]{64}$/.test(ownerToken), 'the owner token must be 64 hex characters');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(EVIDENCE, `f28-idle-incoming-${stamp}.json`);
  process.env.F28_DIAG_DIR = path.join(EVIDENCE, `f28-idle-incoming-${stamp}-diagnostics`);
  const runName = process.env.F28_IDLE_RUN_NAME
    || `f28-idle-incoming-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(runName), 'run name is not a safe helper component');

  const out = {
    schema: 'f28-idle-incoming-live/1', stamp, status: 'preparing', mode: IA.MODE_APP_IDLE,
    checks: [], cases: {},
    claims: {
      concurrentEditSafety: 'NOT tested and NOT claimed',
      exactlyOnce: 'NOT claimed; reconciliation invocations and backups are counted separately',
      transport: 'none — the second replica is a synthetic in-memory state on this host',
      appAuthorityAdded: 'none — the accepted observation-only package, reused unmodified',
    },
  };
  const record = (id, ok, detail) => {
    out.checks.push({id, mode: IA.MODE_APP_IDLE, ok, detail});
    save(evidenceFile, out);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
    assert(ok, id);
  };
  const phase = name => { PI.setDiagnosticCase(name); out.phase = name; };

  let session = null;
  const trees = [];

  try {
    // -------------------------------------------------- package and roots
    phase('preflight');
    const built = APP.resolve(BUILD);
    assert(built.preflight.ok, 'package preflight failed');
    const manifest = built.preflight.manifest;
    assert(manifest.builtFrom && !manifest.builtFrom.dirty,
      'the packaged application was not built from clean source');
    assert(manifest.experiment?.bridge?.mode === 'observation-only',
      'manifest lacks observation-only bridge mode');
    assert(manifest.experiment?.bridge?.persistence === false
      && manifest.experiment?.bridge?.synchronizationPorts === false,
      'manifest does not refuse persistence/synchronization ports');
    const preexisting = ownedProcesses(built.exe);
    assert(preexisting !== null, 'process state could not be read; refusing to start');
    assert(!preexisting.length, 'an owned package process is already running; refusing to touch it');

    out.build = {id: manifest.pilotBuildId, source: manifest.builtFrom,
      productName: manifest.productName, bundleId: manifest.bundleId,
      architecture: manifest.host.arch, bridge: manifest.experiment.bridge,
      executable: built.exe,
      reused: 'the accepted IdentityCapture package, unmodified and not rebuilt'};
    out.source = {commit: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      uncommitted: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length};
    out.helper = {path: helper, sha256: `sha256:${sha256(fs.readFileSync(helper))}`};
    record('reused-clean-observation-only-package', true, out.build);

    const profile = FP.swapAside(built.identity, {stamp});
    out.appProfile = {root: profile.root, preExisting: profile.preExisting};
    record('fresh-app-profile-outside-record-roots',
      !profile.root.includes('IdentityExp'), out.appProfile);

    /* One owned CASE: its own graph and profile directory under the approved
     * roots, so each mutating scenario gets its own incoming transaction. */
    const ownedCase = name => {
      const context = {helper, runName, ownerToken,
        graphDirectory: `g-${name}`, profileDirectory: `p-${name}`};
      PI.initializeOwnedRun(context);
      const graph = path.join(B.allowedRootReal(), runName, context.graphDirectory);
      assert(fs.realpathSync(graph) === graph, `owned graph ${name} is not canonical`);
      B.assertInsideAllowedRoot(`owned graph ${name}`, graph);
      return {context, graph};
    };

    const closedGate = makeGate(built, trees);
    record('closed-gate-reports-closed-before-launch', closedGate('preflight').closed === true,
      closedGate('preflight'));

    // ------------------------------------------------------------ session
    phase('session');
    const first = ownedCase('idle-main');
    const launch = NET.launchWith(options => _electron.launch(options), BUILD);
    const bad = path.join(path.dirname(B.allowedRootReal()), 'f28-idle-inert-probe');
    const errors = {record() {}, phase() {}, endPhase() {}, entries() { return []; }, phases() { return []; }};
    session = await APP.open({built, graph: first.graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`launch-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    trees.push(session.ownedTree || []);
    const isolation = await session.app.evaluate(({app}) => ({userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'), home: app.getPath('home')}));
    record('fresh-isolated-profile',
      Object.values(isolation).every(value => value.startsWith(profile.root + path.sep)), isolation);
    const health = await readHealth(session.page);
    record('observer-healthy', Boolean(health && health.enabled && !health.blocked),
      {enabled: health?.enabled, blocked: health?.blocked});

    const repo = await session.page.evaluate(
      () => window.frontend?.state?.get_current_repo?.() || null);
    assert(repo, 'the renderer did not report a current repo');
    out.repo = repo;

    // ----------------------------------- what the automation channel can read
    phase('probe-capability');
    const signals = await PROBE.readIdleSignals(session.page, repo);
    const causes = await PROBE.pendingLocalCauses(session.page, null);
    out.probeCapability = {signals, causes,
      note: 'signals that cannot be read are treated as not-idle; they never pass'};
    record('idle-signals-are-readable-or-explicitly-not',
      signals && typeof signals === 'object', out.probeCapability);
    const unreadable = [];
    for (const key of ['editing', 'composing', 'inputIdle', 'writesFinished']) {
      if (signals[key] === null || signals[key] === undefined) unreadable.push(key);
    }
    if (causes === null) unreadable.push('pendingCauses');
    out.unreadableSignals = unreadable;
    if (unreadable.length) {
      console.log(`  NOTE unreadable idle signals: ${unreadable.join(', ')}`);
    }

    /*
     * The gate takes a FRESH reading at every boundary. It is async, so each
     * call re-reads the live editor/composition/idle/queue signals and the
     * graph-bound cause counts -- including between the first and second note
     * write, and again at the completion boundary after an awaited
     * reconciliation. Nothing is cached.
     *
     * A required signal that cannot be read REFUSES. The weaker bounded settle
     * observation is reported alongside as its own field and is never
     * substituted for the missing signal.
     */
    let currentGraphId = null;
    const gateReadings = [];
    const readIdleNow = async (stage) => {
      const signals = await PROBE.readIdleSignals(session.page, repo);
      const causes = await PROBE.pendingLocalCauses(session.page, currentGraphId);
      const reading = {
        stage,
        ...signals,
        pendingCauses: causes === null ? null : causes.pending,
        failedCauses: causes === null ? null : causes.failed,
        causeTotal: causes === null ? null : causes.total,
      };
      gateReadings.push({stage, editing: reading.editing, composing: reading.composing,
        inputIdle: reading.inputIdle, writesFinished: reading.writesFinished,
        pendingCauses: reading.pendingCauses});
      return reading;
    };
    const idleGate = makeIdleGate(readIdleNow);

    // ------------------------------------ CASE 1: idle update + Korean create
    phase('case-1-idle-apply');
    const nameStamp = stamp.slice(0, 19);
    const english = `Idle Anchor ${nameStamp}`;
    const korean = `유휴 기준 문서 ${nameStamp}`;
    const newKorean = `유휴 새 문서 ${nameStamp}`;
    for (const [page, body] of [[english, `Synthetic English note (${stamp}).`],
      [korean, `OG에서 만든 한국어 노트입니다 (${stamp}).`]]) {
      await api(session.page, 'create_page', page, {},
        {redirect: false, createFirstBlock: false, format: 'markdown'});
      const block = await api(session.page, 'insert_block', page, body, {focus: false});
      assert(block?.uuid, `block creation returned no identity for ${page}`);
      await flushPageThroughOg(session.page, page);
    }
    /*
     * Settle FIRST, then read the base. insert_block leaves a block in edit mode
     * even with focus:false, so the app is genuinely not idle until this runs.
     * Settling before enrollment means the accepted base is read from an already
     * settled graph and no later approval can be invalidated by settling.
     */
    const settled = await settleEditor(session.page);
    assert(settled.ok, `the editor did not settle: ${settled.reason || settled.after}`);
    const settleObservation = await PROBE.observeSettled(session.page, null);
    const postSettleSignals = await PROBE.readIdleSignals(session.page, repo);
    out.settle = {settled, settleObservation, postSettleSignals};
    record('editor-settled-before-the-base-was-read',
      settled.ok && settleObservation.settled === true, out.settle);

    const englishPath = `pages/${english}.md`;
    const koreanPath = `pages/${korean}.md`;
    const newKoreanPath = `pages/${newKorean}.md`;
    const englishSeed = IA.stableRead(first.context, englishPath);
    const koreanSeed = IA.stableRead(first.context, koreanPath);
    assert(englishSeed.stable && englishSeed.present && koreanSeed.stable && koreanSeed.present,
      'the created pages are not stably readable through the helper');

    const graphId = `f28-idle-graph-${nameStamp}-${crypto.randomBytes(4).toString('hex')}`;
    assert(PI.enrollGraph(first.context, {
      graphId, replicaId: 'replica-idle-local', deviceId: 'device-idle-local',
      metadataRevision: 'metadata-1',
      files: [
        {fileId: 'file-english', path: englishPath,
         content: englishSeed.bytes.toString('utf8'), acceptedRevision: 'ar-english'},
        {fileId: 'file-korean', path: koreanPath,
         content: koreanSeed.bytes.toString('utf8'), acceptedRevision: 'ar-korean'},
      ],
    }).outcome === 'accepted', 'enrollment was refused');
    currentGraphId = graphId;
    const accepted1 = PI.openGraph(first.context);
    record('case-1-accepted-local-identity',
      accepted1.outcome === 'accepted' && accepted1.sidecar.metadataRevision === 'metadata-1',
      {graphId, metadataRevision: accepted1.sidecar?.metadataRevision});

    // Content deliberately WITHOUT block references: id:: writes to other pages
    // are demonstrated separately, in their own owned case.
    const englishUpdate = `${englishSeed.bytes.toString('utf8')}- incoming update (${stamp}).\n`;
    const newKoreanBody = `- 두 번째 복제본이 만든 새 문서입니다 (${stamp}).\n`;
    const proposal = IA.buildProposal({
      accepted: accepted1.sidecar, snapshot: accepted1.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [
        {fileId: 'file-english', path: englishPath, content: englishUpdate},
        {fileId: 'file-new-korean', path: newKoreanPath, content: newKoreanBody},
      ],
    });
    const preview = IA.planIncoming(first.context, proposal, {mode: IA.MODE_APP_IDLE});
    assert(preview.outcome === 'preview',
      `preview refused: ${preview.code} ${preview.reason || ''}`);

    const inventoryBefore = inventoryOwnedGraph(first.graph);
    const healthBefore = await readHealth(session.page);
    const watcherBefore = {
      english: await PROBE.watcherObservationsFor(session.page, repo, englishPath),
      newKorean: await PROBE.watcherObservationsFor(session.page, repo, newKoreanPath),
    };
    const settleNow = await PROBE.observeSettled(session.page, null);
    const idleVerdict = await idleGate('case-1');
    out.cases.case1 = {mode: IA.MODE_APP_IDLE, idleVerdict,
      settleObservationReportedSeparately: settleNow,
      expectedContent: {[englishPath]: englishUpdate, [newKoreanPath]: newKoreanBody}};
    record('case-1-idle-gate-reports-idle-and-never-closure',
      idleVerdict.idle === true && idleVerdict.closed !== true
      && idleVerdict.mode === IA.MODE_APP_IDLE, idleVerdict);

    /*
     * The per-file wait does bounded sampling with a post-match settle window.
     * The completion-boundary call takes a single LATER sample instead of
     * re-running the wait, so a regression cannot be hidden behind a fresh match.
     */
    const reconcileCalls = [];
    const seenOnce = new Set();
    const reconcile = async (fileId, file) => {
      const expected = Buffer.from(file.targetContentHex, 'hex').toString('utf8');
      const boundary = seenOnce.has(fileId);
      const verdict = boundary
        ? await PROBE.sampleOgContent(session.page,
          {repo, path: file.path, expectedContent: expected})
        : await PROBE.awaitOgReconciliation(session.page,
          {repo, path: file.path, expectedContent: expected});
      seenOnce.add(fileId);
      reconcileCalls.push({fileId, path: file.path, boundary, ...verdict});
      return verdict;
    };
    const applied = await IA.applyIncoming(first.context, {
      proposal, approve: preview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile,
    });
    out.cases.case1.applied = {outcome: applied.outcome, mode: applied.mode,
      code: applied.code || null, reason: applied.reason || null,
      applied: applied.applied, transactionId: applied.transactionId,
      metadataRevision: applied.metadataRevision};
    out.cases.case1.reconcileCalls = reconcileCalls;
    record('case-1-disk-application-and-reconciliation-completed',
      applied.outcome === 'applied' && applied.mode === IA.MODE_APP_IDLE
      && reconcileCalls.every(item => item.reconciled === true),
      out.cases.case1.applied);

    // four separately reported completions
    const englishAfter = IA.stableRead(first.context, englishPath);
    const newKoreanAfter = IA.stableRead(first.context, newKoreanPath);
    const koreanAfter = IA.stableRead(first.context, koreanPath);
    record('case-1-disk-bytes-exact',
      englishAfter.bytes.toString('utf8') === englishUpdate
      && newKoreanAfter.bytes.toString('utf8') === newKoreanBody
      && koreanAfter.hash === koreanSeed.hash,
      {english: englishAfter.hash, newKorean: newKoreanAfter.hash,
       untouchedKoreanUnchanged: koreanAfter.hash === koreanSeed.hash});

    const dbEnglish = await session.page.evaluate(({repo, path}) =>
      window.frontend.db.get_file(repo, path), {repo, path: englishPath});
    const dbNewKorean = await session.page.evaluate(({repo, path}) =>
      window.frontend.db.get_file(repo, path), {repo, path: newKoreanPath});
    record('case-1-ui-reconciliation-visible-in-og',
      dbEnglish === englishUpdate && dbNewKorean === newKoreanBody,
      {englishMatches: dbEnglish === englishUpdate,
       koreanMatches: dbNewKorean === newKoreanBody});

    const renderedEnglish = await PROBE.renderedContains(session, english,
      'incoming update');
    const renderedKorean = await PROBE.renderedContains(session, newKorean,
      '두 번째 복제본이 만든 새 문서입니다');
    record('case-1-visible-content-rendered',
      renderedEnglish === true && renderedKorean === true,
      {english: renderedEnglish, korean: renderedKorean,
       note: 'rendering is checked separately from the database'});

    const accepted2 = PI.openGraph(first.context);
    record('case-1-identity-accepted',
      accepted2.outcome === 'accepted'
      && accepted2.sidecar.metadataRevision === 'metadata-2'
      && accepted2.sidecar.acceptedTransactionId === preview.preview.target.transactionId,
      {metadataRevision: accepted2.sidecar?.metadataRevision});
    record('case-1-journal-closed',
      PI.readJournal(first.context).value?.state === 'closed', {});

    // observation accuracy: counts, and backups separated from note changes
    await sleep(2500);
    const inventoryAfter = inventoryOwnedGraph(first.graph);
    const classified = classifyInventory(inventoryBefore, inventoryAfter);
    const watcherAfter = {
      english: await PROBE.watcherObservationsFor(session.page, repo, englishPath),
      newKorean: await PROBE.watcherObservationsFor(session.page, repo, newKoreanPath),
    };
    const healthAfter = await readHealth(session.page);
    const pathSample = await PROBE.observationPathSample(session.page);
    out.cases.case1.observation = {
      naturalWatcherObservations: {
        english: watcherAfter.english - watcherBefore.english,
        newKorean: watcherAfter.newKorean - watcherBefore.newKorean,
        boundTo: {ogRepo: repo, paths: [englishPath, newKoreanPath],
          note: 'the observation stream records OG\'s repo identifier, not the sidecar graph id; the binding uses the repo'},
        note: 'RAW WATCHER OBSERVATIONS bound to the exact graph id and path; naturally observed, none injected in this case',
      },
      reconciliationInvocations: 'UNAVAILABLE — OG\'s reconcile-from-disk! calls are not instrumented by the observation-only package, and instrumenting them would require changing it',
      reconciliationCompletions: 'UNAVAILABLE — same reason; watcher observations and backup files are different quantities and are not substituted',
      gateReadings,
      watcherHookEntries: {
        before: healthBefore?.['hook-entries']?.watcher ?? null,
        after: healthAfter?.['hook-entries']?.watcher ?? null,
        note: 'hook entries count how many times the watcher seam was ENTERED, independently of whether a path matched',
      },
      recentObservationPaths: pathSample,
      reconciliationPolls: reconcileCalls.map(
        item => ({fileId: item.fileId, polls: item.polls, elapsedMs: item.elapsedMs})),
      backupFiles: classified.backups,
      changedNotes: classified.changedNotes,
      newNotes: classified.newNotes,
      expectedChanged: [englishPath],
      expectedNew: [newKoreanPath],
      removedFiles: classified.removed,
      limitations: [
        'watcher observations are bound to the exact graph id and path; they are NOT reconciliation invocations',
        'reconciliation invocation and completion counts are UNAVAILABLE without changing the package; watcher and backup counts are never substituted for them',
        'a reconciled verdict means the database agreed throughout the observed window, including a post-match settle window and a later boundary sample; it is NOT protection against a payload arriving after the window closes',
        'rendering is verified separately from the database, only where stated',
      ],
      sourcePredicted: {
        backupForUpdate: 'reconcile-from-disk! passes backup? true for a change, so logseq/bak/**.md is predicted for the English update',
        noBackupForCreate: 'db-content is blank for a new file, so no backup is predicted for the Korean create',
      },
    };
    const expectedNew = new Set([newKoreanPath]);
    const unexpected = classified.newNotes.filter(item => !expectedNew.has(item.path));
    const unexpectedChanged = classified.changedNotes.filter(item => item.path !== englishPath);
    record('case-1-only-expected-notes-changed-backups-separated',
      unexpected.length === 0 && unexpectedChanged.length === 0,
      {backups: classified.backups.length, unexpectedNew: unexpected,
       unexpectedChanged, removed: classified.removed});

    // ------------------------- CASE 2: every non-idle signal refuses a write
    /*
     * The gate is what is under test here, so this case runs on its OWN owned
     * case with fixture-seeded notes and its own proposal. No OG interaction is
     * needed, because every refusal happens before the first note write.
     */
    phase('case-2-gate-refusals');
    const second = ownedCase('idle-gate-refusals');
    const seedA = '- gate case anchor\n';
    const seedB = '- 게이트 사례 한국어 문서\n';
    PI.putNoteFixture(second.context, 'pages/Gate Anchor.md', seedA);
    PI.putNoteFixture(second.context, 'pages/게이트 문서.md', seedB);
    assert(PI.enrollGraph(second.context, {
      graphId: `f28-idle-gate-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-gate', deviceId: 'device-idle-gate',
      metadataRevision: 'metadata-1',
      files: [
        {fileId: 'file-a', path: 'pages/Gate Anchor.md', content: seedA, acceptedRevision: 'ar-a'},
        {fileId: 'file-b', path: 'pages/게이트 문서.md', content: seedB, acceptedRevision: 'ar-b'},
      ],
    }).outcome === 'accepted', 'gate-case enrollment was refused');
    const openedSecond = PI.openGraph(second.context);
    const gateProposal = IA.buildProposal({
      accepted: openedSecond.sidecar, snapshot: openedSecond.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Gate Anchor.md',
        content: `${seedA}- incoming\n`}],
    });
    const gatePreview = IA.planIncoming(second.context, gateProposal, {mode: IA.MODE_APP_IDLE});
    assert(gatePreview.outcome === 'preview', `gate-case preview refused: ${gatePreview.code}`);
    /*
     * The preview is recomputed immediately before each attempt. The owned roots
     * live inside iCloud Drive, so an external agent can touch the directory
     * between planning and applying; when it does, the applier correctly refuses
     * `preview-stale`, and re-approving from a fresh preview is exactly the
     * prescribed response. Any staleness seen here is recorded rather than
     * papered over -- it is also direct evidence that this design excludes no
     * other writer.
     */
    const staleness = [];
    const freshApproval = (label) => {
      const now = IA.planIncoming(second.context, gateProposal, {mode: IA.MODE_APP_IDLE});
      assert(now.outcome === 'preview', `re-plan refused at ${label}: ${now.code}`);
      if (now.preview.previewFingerprint !== gatePreview.preview.previewFingerprint) {
        staleness.push({label, was: gatePreview.preview.graphNotes,
          now: now.preview.graphNotes});
      }
      return now.preview.previewFingerprint;
    };

    const baseSignals = {...(await readIdleNow('case-2-base')),
      editing: false, composing: false, inputIdle: true,
      pendingCauses: 0, failedCauses: 0, writesFinished: true};
    const refusals = [];
    for (const [key, value, label] of [
      ['editing', true, 'editor-buffer-open'],
      ['composing', true, 'ime-composition'],
      ['inputIdle', false, 'recent-input'],
      ['writesFinished', false, 'write-batch-not-dispatched'],
      ['writesFinished', null, 'writes-finished-unreadable'],
      ['pendingCauses', 1, 'pending-bridge-cause'],
      ['failedCauses', 1, 'failed-local-save'],
    ]) {
      const probeGate = makeIdleGate(async () => ({...baseSignals, [key]: value}));
      const verdict = await probeGate('case-2');
      const result = await IA.applyIncoming(second.context, {
        proposal: gateProposal, approve: freshApproval(label),
        gate: probeGate, mode: IA.MODE_APP_IDLE, reconcile,
      });
      refusals.push({signal: key, label, failing: verdict.failing,
        outcome: result.outcome, code: result.code,
        notesUnchanged: PI.readNote(second.context, 'pages/Gate Anchor.md') === seedA,
        journalAbsent: PI.readJournal(second.context).value === null});
    }
    out.cases.case2 = {mode: IA.MODE_APP_IDLE, refusals, staleness,
      stalenessNote: staleness.length
        ? 'the owned directory changed between planning and applying; an external agent (the roots are inside iCloud Drive) is not excluded by this design'
        : 'no staleness observed during this case'};
    record('case-2-every-non-idle-signal-refuses-before-any-write',
      refusals.every(item => item.outcome === 'refused' && item.code === 'app-not-idle'
        && item.failing.includes(item.label)
        && item.notesUnchanged && item.journalAbsent),
      refusals);

    // a gate that claims closure while in idle mode is itself refused
    const liarGate = async () => ({mode: IA.MODE_APP_IDLE, idle: true, closed: true});
    const liar = await IA.applyIncoming(second.context, {
      proposal: gateProposal, approve: freshApproval('liar-gate'),
      gate: liarGate, mode: IA.MODE_APP_IDLE, reconcile,
    });
    record('case-2-an-idle-gate-claiming-closure-is-refused',
      liar.outcome === 'refused' && liar.code === 'gate-mode-mismatch'
      && PI.readNote(second.context, 'pages/Gate Anchor.md') === seedA,
      {code: liar.code});

    // -------------------------------- CASE 3: app-idle without a working hook
    phase('case-3-hook-required');
    const third = ownedCase('idle-no-hook');
    const seedC = '- hook case anchor\n';
    PI.putNoteFixture(third.context, 'pages/Hook Anchor.md', seedC);
    assert(PI.enrollGraph(third.context, {
      graphId: `f28-idle-hook-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-hook', deviceId: 'device-idle-hook',
      metadataRevision: 'metadata-1',
      files: [{fileId: 'file-a', path: 'pages/Hook Anchor.md', content: seedC,
        acceptedRevision: 'ar-a'}],
    }).outcome === 'accepted', 'hook-case enrollment was refused');
    const openedThird = PI.openGraph(third.context);
    const hookProposal = IA.buildProposal({
      accepted: openedThird.sidecar, snapshot: openedThird.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Hook Anchor.md',
        content: `${seedC}- incoming\n`}],
    });
    assert(IA.planIncoming(third.context, hookProposal, {mode: IA.MODE_APP_IDLE})
      .outcome === 'preview', 'hook-case preview was refused');
    const hookApproval = () => {
      const now = IA.planIncoming(third.context, hookProposal, {mode: IA.MODE_APP_IDLE});
      assert(now.outcome === 'preview', `hook-case re-plan refused: ${now.code}`);
      return now.preview.previewFingerprint;
    };
    const noHook = await IA.applyIncoming(third.context, {
      proposal: hookProposal, approve: hookApproval(),
      gate: idleGate, mode: IA.MODE_APP_IDLE,
    });
    record('case-3-app-idle-refuses-without-a-reconciliation-hook',
      noHook.outcome === 'refused' && noHook.code === 'reconciliation-hook-missing'
      && noHook.mutated === false && PI.readJournal(third.context).value === null
      && PI.readNote(third.context, 'pages/Hook Anchor.md') === seedC,
      {code: noHook.code});

    const stalled = async () => ({reconciled: false, code: 'reconciliation-timeout',
      reason: 'synthetic: the hook reports OG never took the change'});
    const timedOut = await IA.applyIncoming(third.context, {
      proposal: hookProposal, approve: hookApproval(),
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile: stalled,
    });
    out.cases.case3 = {mode: IA.MODE_APP_IDLE, noHook: noHook.code,
      timedOut: {outcome: timedOut.outcome, code: timedOut.code, applied: timedOut.applied},
      injected: 'the stalled verdict is INJECTED, not a naturally observed OG failure'};
    record('case-3-a-stalled-reconciliation-blocks-publication',
      timedOut.outcome === 'interrupted' && timedOut.code === 'reconciliation-timeout'
      && PI.openGraph(third.context).outcome === 'refused'
      && PI.readJournal(third.context).value.state === 'open'
      && PI.readJournal(third.context).value.progress.recordsAccepted === false,
      out.cases.case3.timedOut);

    // ---------------- CASE 4: genuine unsaved input and Korean composition
    /*
     * REAL live case: a block is genuinely put into edit mode in the running
     * application, and Korean text is genuinely typed into it. The gate reads
     * the live editor state; nothing is forced.
     */
    phase('case-4-genuine-unsaved-input');
    const fourth = ownedCase('idle-live-editing');
    const editTarget = `유휴 편집 대상 ${nameStamp}`;
    await api(session.page, 'create_page', editTarget, {},
      {redirect: false, createFirstBlock: false, format: 'markdown'});
    const editBlock = await api(session.page, 'insert_block', editTarget,
      '- 편집 대상 블록\n', {focus: false});
    await flushPageThroughOg(session.page, editTarget);
    await settleEditor(session.page);
    await PROBE.observeSettled(session.page, null);

    /*
     * Enter edit mode the way a user does: navigate, then CLICK the rendered
     * block. Calling edit-block! through the API did not attach an editor, so
     * this uses the UI path the earlier identity-capture batch proved works.
     */
    const enterEditor = async () => {
      const uuid = await session.page.evaluate((pageName) => {
        const tree = window.logseq?.api?.get_page_blocks_tree?.(pageName);
        const first = Array.isArray(tree) ? tree[0] : null;
        return first ? (first.uuid || null) : null;
      }, editTarget);
      if (!uuid) return {ok: false, reason: 'no block in the page tree'};
      await session.goTo(editTarget);
      const blockAt = () => session.page
        .locator(`#main-content-container [blockid="${uuid}"] .block-content`).first();
      if (!(await blockAt().count())) {
        await session.page.evaluate(() => { location.hash = '#/'; });
        await new Promise(resolve => setTimeout(resolve, 500));
        await session.goTo(editTarget);
      }
      if (!(await blockAt().count())) {
        const rendered = await session.page.evaluate(() => ({
          hash: location.hash,
          blockIds: [...document.querySelectorAll('#main-content-container [blockid]')]
            .map(element => element.getAttribute('blockid')).slice(0, 8),
        }));
        return {ok: false, reason: `block not rendered: ${JSON.stringify(rendered)}`};
      }
      await blockAt().click({timeout: 20000});
      const editor = session.page.locator('textarea[aria-label="editing block"]').first();
      await editor.waitFor({state: 'visible', timeout: 10000})
        .catch(() => null);
      const editInputId = await session.page.evaluate(
        () => window.frontend?.state?.get_edit_input_id?.() || null);
      return {ok: Boolean(editInputId), uuid, editInputId};
    };
    const entered = await enterEditor();
    assert(entered.ok, `the editor did not open: ${entered.reason || 'no edit input id'}`);

    const duringEdit = await readIdleNow('case-4-editing');
    const editVerdict = await idleGate('case-4-editing');
    out.cases.case4 = {mode: IA.MODE_APP_IDLE, live: true, entered,
      signals: {editing: duringEdit.editing, composing: duringEdit.composing,
        inputIdle: duringEdit.inputIdle},
      verdict: {idle: editVerdict.idle, failing: editVerdict.failing}};
    record('case-4-a-genuine-open-editor-is-observed-and-refuses',
      entered.ok === true && duringEdit.editing === true
      && editVerdict.idle === false
      && editVerdict.failing.includes('editor-buffer-open'),
      out.cases.case4);

    // genuine Korean IME composition, driven through real composition events
    const composed = await session.page.evaluate(async () => {
      const state = window.frontend?.state;
      const input = state?.get_input?.();
      if (!input) return {ok: false, reason: 'no editor input element'};
      input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      input.dispatchEvent(new CompositionEvent('compositionupdate',
        {bubbles: true, data: '한'}));
      await new Promise(resolve => setTimeout(resolve, 300));
      return {ok: true, composing: Boolean(state.editor_in_composition_QMARK_()),
        note: 'a synthetic CompositionEvent; a real IME may set this differently'};
    });
    const duringComposition = await readIdleNow('case-4-composition');
    const compositionVerdict = await idleGate('case-4-composition');
    out.cases.case4.composition = {composed,
      observedComposing: duringComposition.composing,
      verdict: {idle: compositionVerdict.idle, failing: compositionVerdict.failing}};
    // The gate must refuse during composition. If OG did not report composition
    // for a synthetic event, that is reported honestly rather than claimed.
    const compositionObserved = duringComposition.composing === true;
    record('case-4-composition-refuses-or-is-reported-unobserved',
      compositionVerdict.idle === false
      && (compositionObserved
        ? compositionVerdict.failing.includes('ime-composition')
        : compositionVerdict.failing.includes('editor-buffer-open')),
      {compositionObserved, failing: compositionVerdict.failing,
       note: compositionObserved
         ? 'OG reported composition and the gate refused on it'
         : 'OG did not report composition for a synthetic CompositionEvent; the gate still refused on the open editor, and the composition signal itself is NOT claimed verified'});

    // the whole proposal is refused while that editor is open
    const editSeed = '- 편집 사례 기준\n';
    PI.putNoteFixture(fourth.context, 'pages/Edit Anchor.md', editSeed);
    assert(PI.enrollGraph(fourth.context, {
      graphId: `f28-idle-edit-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-edit', deviceId: 'device-idle-edit',
      metadataRevision: 'metadata-1',
      files: [{fileId: 'file-a', path: 'pages/Edit Anchor.md', content: editSeed,
        acceptedRevision: 'ar-a'}],
    }).outcome === 'accepted', 'edit-case enrollment was refused');
    const openedFourth = PI.openGraph(fourth.context);
    const editProposal = IA.buildProposal({
      accepted: openedFourth.sidecar, snapshot: openedFourth.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Edit Anchor.md',
        content: `${editSeed}- incoming\n`}],
    });
    const editPreview = IA.planIncoming(fourth.context, editProposal,
      {mode: IA.MODE_APP_IDLE});
    const refusedWhileEditing = await IA.applyIncoming(fourth.context, {
      proposal: editProposal, approve: editPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile,
    });
    record('case-4-application-refused-while-a-real-edit-is-open',
      refusedWhileEditing.outcome === 'refused'
      && refusedWhileEditing.code === 'app-not-idle'
      && refusedWhileEditing.mutated === false
      && PI.readJournal(fourth.context).value === null
      && PI.readNote(fourth.context, 'pages/Edit Anchor.md') === editSeed,
      {code: refusedWhileEditing.code});

    /*
     * End the composition first. An unfinished composition legitimately keeps the
     * app non-idle -- OG itself will not save during one -- so it must be closed
     * before the app can settle.
     */
    const compositionEnded = await session.page.evaluate(async () => {
      const state = window.frontend?.state;
      const input = state?.get_input?.();
      if (input) {
        input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: ''}));
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      return {composing: Boolean(state?.editor_in_composition_QMARK_?.())};
    });
    out.cases.case4.compositionEnded = compositionEnded;
    await settleEditor(session.page);
    await PROBE.observeSettled(session.page, null);
    const afterSettle = await idleGate('case-4-after-settle');
    record('case-4-the-app-is-idle-again-after-settling',
      afterSettle.idle === true, {failing: afterSettle.failing});

    // ------------------------------- CASE 5: whitespace-only edge change
    /*
     * REAL live case. OG compares TRIMMED strings, so a change only in leading
     * or trailing whitespace is invisible to it. This must produce an explicit
     * non-reconciled result, not a false success and not a bare timeout.
     */
    phase('case-5-whitespace-only');
    const fifth = ownedCase('idle-whitespace');
    const wsPage = `유휴 공백 문서 ${nameStamp}`;
    await api(session.page, 'create_page', wsPage, {},
      {redirect: false, createFirstBlock: false, format: 'markdown'});
    await api(session.page, 'insert_block', wsPage, '- 공백만 다른 변경 대상\n',
      {focus: false});
    await flushPageThroughOg(session.page, wsPage);
    await settleEditor(session.page);
    await PROBE.observeSettled(session.page, null);
    const wsPath = `pages/${wsPage}.md`;
    const wsSeed = IA.stableRead(first.context, wsPath);
    assert(wsSeed.stable && wsSeed.present, 'the whitespace page is not stably readable');
    // enrol it in its OWN owned case by copying the bytes there
    PI.putNoteFixture(fifth.context, wsPath, wsSeed.bytes.toString('utf8'));
    const wsGraphId = `f28-idle-ws-${crypto.randomBytes(4).toString('hex')}`;
    assert(PI.enrollGraph(fifth.context, {
      graphId: wsGraphId, replicaId: 'replica-idle-ws', deviceId: 'device-idle-ws',
      metadataRevision: 'metadata-1',
      files: [{fileId: 'file-ws', path: wsPath,
        content: wsSeed.bytes.toString('utf8'), acceptedRevision: 'ar-ws'}],
    }).outcome === 'accepted', 'whitespace-case enrollment was refused');
    const openedFifth = PI.openGraph(fifth.context);
    const wsProposal = IA.buildProposal({
      accepted: openedFifth.sidecar, snapshot: openedFifth.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-ws', path: wsPath,
        content: `${wsSeed.bytes.toString('utf8')}\n\n`}],
    });
    const wsPreview = IA.planIncoming(fifth.context, wsProposal, {mode: IA.MODE_APP_IDLE});
    /*
     * This owned case is NOT the graph OG has open, so OG can never reconcile it.
     * The hook reports that honestly: `not-reconcilable-by-og` with the exact
     * reason, rather than a bare timeout.
     */
    const wsReconcile = async () => ({
      reconciled: false, code: 'not-reconcilable-by-og',
      reason: 'OG compares trimmed strings, so a whitespace-only edge change is never reconciled; this owned case is also not the graph OG has open',
    });
    const wsResult = await IA.applyIncoming(fifth.context, {
      proposal: wsProposal, approve: wsPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile: wsReconcile,
    });
    out.cases.case5 = {mode: IA.MODE_APP_IDLE, live: false,
      classification: 'SYNTHETIC hook verdict in an owned case OG does not have open',
      outcome: wsResult.outcome, code: wsResult.code, applied: wsResult.applied,
      sourceBasis: 'watcher_handler.cljs compares (string/trim content) with (string/trim db-content)'};
    record('case-5-whitespace-only-change-is-explicitly-not-reconcilable',
      wsResult.outcome === 'interrupted' && wsResult.code === 'not-reconcilable-by-og'
      && PI.openGraph(fifth.context).outcome === 'refused'
      && PI.readJournal(fifth.context).value.state === 'open',
      out.cases.case5);

    // ------------------- CASE 6: duplicate and delayed older payloads (INJECTED)
    phase('case-6-duplicate-and-delayed');
    const sixth = ownedCase('idle-duplicate-delayed');
    const dupSeed = '- duplicate case anchor\n';
    PI.putNoteFixture(sixth.context, 'pages/Dup Anchor.md', dupSeed);
    assert(PI.enrollGraph(sixth.context, {
      graphId: `f28-idle-dup-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-dup', deviceId: 'device-idle-dup',
      metadataRevision: 'metadata-1',
      files: [{fileId: 'file-a', path: 'pages/Dup Anchor.md', content: dupSeed,
        acceptedRevision: 'ar-a'}],
    }).outcome === 'accepted', 'duplicate-case enrollment was refused');
    const openedSixth = PI.openGraph(sixth.context);
    const dupProposal = IA.buildProposal({
      accepted: openedSixth.sidecar, snapshot: openedSixth.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Dup Anchor.md',
        content: `${dupSeed}- incoming\n`}],
    });
    const dupPreview = IA.planIncoming(sixth.context, dupProposal, {mode: IA.MODE_APP_IDLE});
    // INJECTED: the per-file wait matches, then the boundary sample reports that
    // a delayed OLDER payload moved the database back.
    let dupCalls = 0;
    const dupReconcile = async () => {
      dupCalls += 1;
      return dupCalls === 1
        ? {reconciled: true, injected: true, duplicateObservations: 2}
        : {reconciled: false, code: 'reconciliation-regressed', injected: true,
           reason: 'INJECTED: a delayed older payload moved the database back'};
    };
    const dupResult = await IA.applyIncoming(sixth.context, {
      proposal: dupProposal, approve: dupPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile: dupReconcile,
    });
    out.cases.case6 = {mode: IA.MODE_APP_IDLE, live: false,
      classification: 'INJECTED reconciliation verdicts; no watcher event was fabricated',
      outcome: dupResult.outcome, code: dupResult.code, calls: dupCalls};
    record('case-6-a-delayed-older-payload-blocks-publication-at-the-boundary',
      dupResult.outcome === 'interrupted'
      && dupResult.code === 'reconciliation-regressed'
      && PI.openGraph(sixth.context).outcome === 'refused'
      && PI.readJournal(sixth.context).value.state === 'open',
      out.cases.case6);

    // --------------- CASE 7: interruption and restart without rewriting notes
    phase('case-7-restart');
    const seventh = ownedCase('idle-restart');
    const rsSeedA = '- restart anchor a\n';
    const rsSeedB = '- 재시작 기준 문서\n';
    PI.putNoteFixture(seventh.context, 'pages/Restart A.md', rsSeedA);
    PI.putNoteFixture(seventh.context, 'pages/재시작 문서.md', rsSeedB);
    assert(PI.enrollGraph(seventh.context, {
      graphId: `f28-idle-restart-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-restart', deviceId: 'device-idle-restart',
      metadataRevision: 'metadata-1',
      files: [
        {fileId: 'file-a', path: 'pages/Restart A.md', content: rsSeedA, acceptedRevision: 'ar-a'},
        {fileId: 'file-b', path: 'pages/재시작 문서.md', content: rsSeedB, acceptedRevision: 'ar-b'},
      ],
    }).outcome === 'accepted', 'restart-case enrollment was refused');
    const openedSeventh = PI.openGraph(seventh.context);
    const rsProposal = IA.buildProposal({
      accepted: openedSeventh.sidecar, snapshot: openedSeventh.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [
        {fileId: 'file-a', path: 'pages/Restart A.md', content: `${rsSeedA}- incoming\n`},
        {fileId: 'file-b', path: 'pages/재시작 문서.md', content: `${rsSeedB}- 수신 적용\n`},
      ],
    });
    const rsPreview = IA.planIncoming(seventh.context, rsProposal, {mode: IA.MODE_APP_IDLE});
    const rsOrder = rsPreview.preview.applyOrder;
    const rsOk = async () => ({reconciled: true, injected: true});
    // INJECTED interruption after the first file's write and reconciliation
    const rsInterrupted = await IA.applyIncoming(seventh.context, {
      proposal: rsProposal, approve: rsPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile: rsOk,
      failAt: `before-file:${rsOrder[1]}`,
    });
    const afterInterrupt = {
      [rsOrder[0]]: IA.stableRead(seventh.context,
        rsPreview.preview.files.find(f => f.fileId === rsOrder[0]).path).hash,
    };
    const rsReconciled = [];
    const rsRestart = await IA.recoverIncoming(seventh.context, {
      gate: idleGate, mode: IA.MODE_APP_IDLE,
      reconcile: async (fileId) => { rsReconciled.push(fileId); return {reconciled: true, injected: true}; },
    });
    const afterRestart = {
      [rsOrder[0]]: IA.stableRead(seventh.context,
        rsPreview.preview.files.find(f => f.fileId === rsOrder[0]).path).hash,
    };
    out.cases.case7 = {mode: IA.MODE_APP_IDLE, live: false,
      classification: 'INJECTED interruption and INJECTED reconciliation verdicts',
      interrupted: {outcome: rsInterrupted.outcome, applied: rsInterrupted.applied},
      restart: {outcome: rsRestart.outcome, mode: rsRestart.mode,
        originMode: rsRestart.originMode, wrote: rsRestart.wrote,
        reconciledFiles: rsReconciled}};
    record('case-7-restart-rewrites-nothing-and-re-reconciles-every-file',
      rsInterrupted.outcome === 'interrupted'
      && rsRestart.outcome === 'recovered'
      && rsRestart.mode === IA.MODE_APP_IDLE
      && rsRestart.originMode === IA.MODE_APP_IDLE
      && JSON.stringify(rsRestart.wrote) === JSON.stringify([rsOrder[1]])
      && JSON.stringify(rsReconciled) === JSON.stringify(rsOrder)
      && afterRestart[rsOrder[0]] === afterInterrupt[rsOrder[0]]
      && PI.openGraph(seventh.context).sidecar.metadataRevision === 'metadata-2',
      out.cases.case7);

    // ---------------- CASE 8: block references induce writes to OTHER pages
    phase('case-8-block-references');
    const eighth = ownedCase('idle-block-refs');
    const refTargetUuid = editBlock.uuid;
    const brSeedA = '- block ref case anchor\n';
    const brSeedB = `- 참조 대상 문서\n`;
    PI.putNoteFixture(eighth.context, 'pages/Ref Anchor.md', brSeedA);
    PI.putNoteFixture(eighth.context, 'pages/참조 문서.md', brSeedB);
    assert(PI.enrollGraph(eighth.context, {
      graphId: `f28-idle-refs-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-refs', deviceId: 'device-idle-refs',
      metadataRevision: 'metadata-1',
      files: [
        {fileId: 'file-a', path: 'pages/Ref Anchor.md', content: brSeedA, acceptedRevision: 'ar-a'},
        {fileId: 'file-b', path: 'pages/참조 문서.md', content: brSeedB, acceptedRevision: 'ar-b'},
      ],
    }).outcome === 'accepted', 'block-ref-case enrollment was refused');
    const openedEighth = PI.openGraph(eighth.context);
    const brProposal = IA.buildProposal({
      accepted: openedEighth.sidecar, snapshot: openedEighth.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Ref Anchor.md',
        content: `${brSeedA}- refers to ((${refTargetUuid}))\n`}],
    });
    const brPreview = IA.planIncoming(eighth.context, brProposal, {mode: IA.MODE_APP_IDLE});
    // While the incoming write is in flight, an unrelated page in the SAME owned
    // case changes -- exactly the shape set-missing-block-ids! would produce.
    let brCalls = 0;
    const brReconcile = async () => {
      brCalls += 1;
      if (brCalls === 1) {
        PI.putNoteFixture(eighth.context, 'pages/참조 문서.md',
          `${brSeedB}id:: ${refTargetUuid}\n`);
      }
      return {reconciled: true, injected: true};
    };
    const brResult = await IA.applyIncoming(eighth.context, {
      proposal: brProposal, approve: brPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile: brReconcile,
    });
    out.cases.case8 = {mode: IA.MODE_APP_IDLE, live: false,
      classification: 'SYNTHETIC id:: write into an unrelated page, in the shape set-missing-block-ids! produces',
      outcome: brResult.outcome, code: brResult.code,
      sourceBasis: 'watcher_handler.cljs set-missing-block-ids! -> editor/property batch-set-block-property! -> outliner transact -> updated-page-hook -> sync-to-file'};
    record('case-8-an-unrelated-page-write-refuses-publication',
      brResult.outcome === 'interrupted'
      && brResult.code === 'unrelated-local-change'
      && PI.openGraph(eighth.context).outcome === 'refused'
      && PI.readNote(eighth.context, 'pages/참조 문서.md')
         === `${brSeedB}id:: ${refTargetUuid}\n`,
      out.cases.case8);

    // ------------------ CASE 9: precondition conflict and a genuine local edit
    phase('case-9-precondition-conflict');
    const ninth = ownedCase('idle-precondition');
    const pcSeed = '- precondition anchor\n';
    PI.putNoteFixture(ninth.context, 'pages/Pre Anchor.md', pcSeed);
    assert(PI.enrollGraph(ninth.context, {
      graphId: `f28-idle-pre-${crypto.randomBytes(4).toString('hex')}`,
      replicaId: 'replica-idle-pre', deviceId: 'device-idle-pre',
      metadataRevision: 'metadata-1',
      files: [{fileId: 'file-a', path: 'pages/Pre Anchor.md', content: pcSeed,
        acceptedRevision: 'ar-a'}],
    }).outcome === 'accepted', 'precondition-case enrollment was refused');
    const openedNinth = PI.openGraph(ninth.context);
    const pcProposal = IA.buildProposal({
      accepted: openedNinth.sidecar, snapshot: openedNinth.snapshot,
      originReplicaId: 'replica-idle-synthetic-b', targetMetadataRevision: 'metadata-2',
      changes: [{fileId: 'file-a', path: 'pages/Pre Anchor.md',
        content: `${pcSeed}- incoming\n`}],
    });
    const pcPreview = IA.planIncoming(ninth.context, pcProposal, {mode: IA.MODE_APP_IDLE});
    // a genuine local edit lands before the incoming write
    const localEdit = '- 사용자가 직접 고친 내용\n';
    PI.putNoteFixture(ninth.context, 'pages/Pre Anchor.md', localEdit);
    const pcResult = await IA.applyIncoming(ninth.context, {
      proposal: pcProposal, approve: pcPreview.preview.previewFingerprint,
      gate: idleGate, mode: IA.MODE_APP_IDLE, reconcile,
    });
    // and the helper's own precondition refuses a stale-based write directly
    let helperRefusal = null;
    try {
      PI.putNoteExpecting(ninth.context, 'pages/Pre Anchor.md',
        Buffer.from('- forced\n', 'utf8'), sha256(pcSeed));
    } catch (error) { helperRefusal = error.code; }
    out.cases.case9 = {mode: IA.MODE_APP_IDLE, live: false,
      classification: 'SYNTHETIC local edit through the fixture writer',
      applier: {outcome: pcResult.outcome, code: pcResult.code},
      helperRefusal};
    record('case-9-a-genuine-local-edit-refuses-and-is-never-absorbed',
      pcResult.outcome === 'refused'
      && ['local-ahead-of-accepted', 'preview-stale'].includes(pcResult.code)
      && pcResult.mutated === false
      && helperRefusal === 'destination-precondition-failed'
      && PI.readNote(ninth.context, 'pages/Pre Anchor.md') === localEdit,
      out.cases.case9);

    // ---------------------------- CASE 10: feature-off ordinary behaviour
    phase('case-10-feature-off');
    const offPage = `유휴 기능끔 ${nameStamp}`;
    await api(session.page, 'create_page', offPage, {},
      {redirect: false, createFirstBlock: false, format: 'markdown'});
    await api(session.page, 'insert_block', offPage, '- 기능이 꺼진 상태의 일반 동작\n',
      {focus: false});
    await flushPageThroughOg(session.page, offPage);
    await settleEditor(session.page);
    await PROBE.observeSettled(session.page, null);
    const offPath = `pages/${offPage}.md`;
    const offRead = IA.stableRead(first.context, offPath);
    const offRendered = await PROBE.renderedContains(session, offPage,
      '기능이 꺼진 상태의 일반 동작');
    const offHealth = await readHealth(session.page);
    out.cases.case10 = {mode: 'not-applicable — no incoming application ran',
      live: true,
      note: 'ordinary OG page creation, edit, save and render with no coordinator activity on this graph'};
    record('case-10-ordinary-og-behaviour-is-unchanged-with-no-incoming-activity',
      offRead.stable && offRead.present
      && offRead.bytes.toString('utf8').includes('기능이 꺼진 상태의 일반 동작')
      && offRendered === true
      && Boolean(offHealth && offHealth.enabled && !offHealth.blocked),
      {stable: offRead.stable, rendered: offRendered, observerBlocked: offHealth?.blocked});

    // ------------------------------------------------------- safe shutdown
    phase('quit');
    const preQuitHealth = await readHealth(session.page);
    record('observer-healthy-before-quit',
      Boolean(preQuitHealth && preQuitHealth.enabled && !preQuitHealth.blocked),
      {blocked: preQuitHealth?.blocked});
    out.finalClose = await APP.close(session);
    session = null;
    const finalVerdict = closedGate('final');
    record('owned-processes-have-exited',
      out.finalClose.stillAlive.length === 0 && finalVerdict.closed === true,
      {close: out.finalClose, gate: finalVerdict});

    out.profileCleanup = FP.restore(profile);
    out.status = 'passed';
    out.limits = [
      'one host, Intel, synthetic data; the app was OPEN and IDLE, never edited during application',
      'concurrent-edit safety was NOT tested and is NOT claimed',
      'no exactly-once claim: reconciliation is not serialized by OG and was not instrumented directly',
      'watcher-event counts are naturally observed; backup counts do not prove reconciliation counts',
      'idle signals are evidence of an idle app, not proof that no save is in flight, and exclude no other writer',
      'creates and updates only; one incoming transaction per owned case',
      'no whole-graph atomicity, no cross-process serialization, no power-loss durability, no transport, no second device',
    ];
    save(evidenceFile, out);
    console.log(`\nIdle incoming batch passed: ${out.checks.length} checks (mode: app-idle)`);
    console.log(`Evidence: ${evidenceFile}`);
  } catch (error) {
    out.status = 'failed';
    out.failure = {message: String(error && error.message || error), stack: error?.stack || null};
    if (session) out.emergencyClose = await APP.close(session).catch(e => ({error: String(e)}));
    save(evidenceFile, out);
    console.error(`\nFAILED: ${out.failure.message}`);
    console.error(`Evidence: ${evidenceFile}`);
    process.exitCode = 1;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
