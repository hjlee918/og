#!/usr/bin/env node
'use strict';

// One coherent, owned, observation-only OG runtime batch. Evidence is local
// beside the development checkout; note text, screenshots, graph data,
// profiles and binaries are never Git inputs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const APP = require('../../f28-refpath/checks/packaged-app');
const FP = require('../../f28-refpath/checks/fresh-profile');
const B = require('../../f27-pilot/checks/allowed-root');
const OP = require('../../f27-pilot/checks/owned-process');
const NET = require('../../f28-origin/checks/network-refusal');
const {_electron} = require('../../node_modules/playwright');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.resolve(REPO, '..', '..', 'evidence');
const BUILD = 'Logseq-OG-F28-Observation';
const API = '__LOGSEQ_OG_BRIDGE_OBSERVATION__';
const CONSOLE_PREFIX = '[OG-BRIDGE-OBSERVATION] ';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};

function ownedProcesses(executable) {
  const name = path.basename(executable);
  return require('child_process').execFileSync('ps', ['-axo', 'pid=,comm='], {encoding: 'utf8'})
    .split('\n').filter(line => line.includes(name));
}

function graphPath(stamp) {
  const root = B.allowedRootReal();
  const child = path.join(root, `f28-og-observation-${stamp}-${crypto.randomBytes(4).toString('hex')}`);
  assert(path.dirname(child) === root, 'synthetic graph is not a direct child of the approved root');
  fs.mkdirSync(child, {recursive: false});
  return B.assertInsideAllowedRoot('owned observation graph', child);
}

function causeEvents(events, kind, pathValue) {
  return events.filter(event => event.cause && event.cause.kind === kind &&
    [event.cause.path, event.cause['old-path'], event.cause['new-path']].includes(pathValue));
}

async function readEvents(page) {
  return page.evaluate(name => {
    const api = window[name];
    if (!api || api.schema !== 'frontend.fs.og-sync-bridge.observation/1' ||
        api.mode !== 'observation-only' || typeof api.read !== 'function') return null;
    return api.read();
  }, API);
}

async function waitForEventCount(page, count) {
  await page.waitForFunction(({name, count}) => {
    const api = window[name];
    return api && typeof api.read === 'function' && api.read().length >= count;
  }, {name: API, count}, {timeout: 30000});
}

async function api(page, method, ...args) {
  return page.evaluate(({method, args}) => {
    const fn = window.logseq && window.logseq.api && window.logseq.api[method];
    if (typeof fn !== 'function') throw new Error(`missing Logseq API ${method}`);
    return fn(...args);
  }, {method, args});
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

async function run() {
  const resumeIndex = process.argv.indexOf('--resume');
  const resumeFile = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
  const prior = resumeFile ? JSON.parse(fs.readFileSync(path.resolve(resumeFile), 'utf8')) : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(EVIDENCE, `f28-observation-${stamp}.json`);
  const out = {schema: 'f28-og-live-observation/1', stamp, status: 'preparing', checks: [],
    simulation: false, synchronizationEnabled: false, contentRecorded: false,
    resumedFrom: resumeFile ? path.resolve(resumeFile) : null};
  const record = (id, ok, detail) => {
    out.checks.push({id, ok, detail});
    save(evidenceFile, out);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
    assert(ok, id);
  };
  let profile;
  let session;
  let reopened;
  let streamedEvents = [];
  try {
    const built = APP.resolve(BUILD);
    assert(built.preflight.ok, 'observation package preflight failed');
    const manifest = built.preflight.manifest;
    assert(manifest.builtFrom && !manifest.builtFrom.dirty, 'observation package is not from clean source');
    assert(manifest.experiment?.bridge?.mode === 'observation-only', 'manifest lacks observation-only bridge mode');
    assert(manifest.experiment?.bridge?.persistence === false &&
           manifest.experiment?.bridge?.synchronizationPorts === false,
           'manifest does not refuse persistence/synchronization ports');
    assert(!ownedProcesses(built.exe).length, 'an observation package process is already running');
    out.build = {id: manifest.pilotBuildId, source: manifest.builtFrom, productName: manifest.productName,
      bundleId: manifest.bundleId, packageName: manifest.packageName, architecture: manifest.host.arch,
      bridge: manifest.experiment.bridge, executable: built.exe};
    record('identity-clean-observation-build', true, out.build);

    if (prior) {
      const state = FP.stateRootFor(built.identity);
      const kept = prior.profileCleanup?.kept;
      assert(kept && fs.existsSync(kept), 'preserved resume profile is missing');
      assert(!fs.existsSync(state.root), 'observation profile root is occupied; refusing resume');
      FP.assertOurs(kept, built.identity);
      fs.renameSync(kept, state.root);
      profile = {identity: built.identity, root: state.root, productDir: state.productDir,
        stamp, preserved: null, marker: null, preExisting: false};
    } else {
      profile = FP.swapAside(built.identity, {stamp});
    }
    out.profile = {root: profile.root, preExisting: profile.preExisting, preserved: profile.preserved};
    const graph = prior
      ? B.assertInsideAllowedRoot('resumed owned observation graph', prior.graph)
      : graphPath(stamp);
    out.graph = graph;
    record('canonical-owned-live-target', fs.realpathSync(graph) === graph && graph !== B.allowedRootReal(), {graph});

    const launch = NET.launchWith(options => _electron.launch(options), BUILD);
    const bad = path.join(path.dirname(B.allowedRootReal()), 'f28-observation-inert-probe');
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
    record('fresh-isolated-profile', Object.values(isolation).every(value => value.startsWith(profile.root + path.sep)), isolation);
    const plugins = FP.pluginsDirIn(profile.root);
    const pluginNames = fs.existsSync(plugins) ? fs.readdirSync(plugins).filter(name => name !== '.DS_Store') : [];
    record('no-plugins-or-credentials', pluginNames.length === 0, {pluginCount: pluginNames.length});
    const network = await NET.read(session.app);
    record('pre-navigation-network-refusal', network?.active && network.sessions >= 1, network);
    const initialEvents = await readEvents(session.page);
    record('observation-runtime-only', Array.isArray(initialEvents), {schema: 'frontend.fs.og-sync-bridge.observation/1', initialCount: initialEvents?.length});

    const nameDate = (prior ? prior.stamp : stamp).slice(0, 10);
    const english = `Observation English ${nameDate}`;
    const korean = `관찰 한국어 ${nameDate}`;
    const baseRenamed = `관찰 이름변경 ${nameDate}`;
    const priorRenamed = prior?.operation?.renamed;
    const sourceCandidates = [priorRenamed, baseRenamed, korean].filter(Boolean);
    const koreanSource = sourceCandidates.find(name =>
      fs.existsSync(path.join(graph, 'pages', `${name}.md`))) || korean;
    const renamed = `관찰 이름변경 ${nameDate} ${stamp.slice(11, 19).replace(/-/g, '')}`;
    const englishCreate = 'Synthetic English note created through OG.';
    const koreanCreate = 'OG를 통해 만든 합성 한국어 노트입니다.';
    const englishEdit = prior
      ? `Synthetic English note edited and saved through OG (${stamp}).`
      : 'Synthetic English note edited and saved through OG.';
    const koreanEdit = prior
      ? `이름을 바꾼 뒤 OG에서 다시 편집하고 저장했습니다 (${stamp}).`
      : '이름을 바꾼 뒤 OG에서 다시 편집하고 저장했습니다.';

    let englishBlock, koreanBlock;
    if (prior) {
      const englishTree = await api(session.page, 'get_page_blocks_tree', english);
      const koreanTree = await api(session.page, 'get_page_blocks_tree', koreanSource);
      englishBlock = englishTree && englishTree[0];
      koreanBlock = koreanTree && koreanTree[0];
    } else {
      await api(session.page, 'create_page', english, {}, {redirect: false, createFirstBlock: false, format: 'markdown'});
      englishBlock = await api(session.page, 'insert_block', english, englishCreate, {focus: false});
      await api(session.page, 'create_page', korean, {}, {redirect: false, createFirstBlock: false, format: 'markdown'});
      koreanBlock = await api(session.page, 'insert_block', korean, koreanCreate, {focus: false});
    }
    record('created-english-and-korean-via-og',
      englishBlock && englishBlock.uuid && koreanBlock && koreanBlock.uuid,
      {englishBlock: englishBlock.uuid, koreanBlock: koreanBlock.uuid,
       resumedAfterVerifiedInitialApiCreation: !!prior});
    const koreanBeforeRename = koreanBlock.content;

    const englishPath = `pages/${english}.md`;
    const oldKoreanPath = `pages/${koreanSource}.md`;
    const renamedPath = `pages/${renamed}.md`;
    const expectedGraphId = `logseq_local_${graph}`;
    out.operation = {english, koreanSource, renamed, englishPath, oldKoreanPath, renamedPath,
      expectedGraphId};
    const englishUi = await editBlockThroughUi(session, english, englishBlock.uuid, englishEdit);
    record('normal-english-display', await pageContains(session, english, englishEdit), {page: english});

    await api(session.page, 'rename_page', koreanSource, renamed);
    const oldAbsolute = B.assertInsideAllowedRoot('old Korean note', path.join(graph, oldKoreanPath));
    const newAbsolute = B.assertInsideAllowedRoot('renamed Korean note', path.join(graph, renamedPath));
    record('normal-korean-renamed-display', await pageContains(session, renamed, koreanBeforeRename),
      {page: renamed});

    const koreanUi = await editBlockThroughUi(session, renamed, koreanBlock.uuid, koreanEdit);
    record('normal-renamed-edit-display', koreanUi.editorValueMatched && koreanUi.displayedAfterEscape,
      {page: renamed, editorValueMatched: koreanUi.editorValueMatched,
       displayedAfterEscape: koreanUi.displayedAfterEscape});

    await OP.sleep(2500);
    let events = await readEvents(session.page);
    out.preQuitEvents = events;
    out.rejectedOperation = {liveExercised: false,
      reason: 'No existing safe OG operation reliably produces a post-intent filesystem rejection without changing permissions or manufacturing a broad path/filesystem failure; failure remains synthetic-suite coverage.'};
    save(evidenceFile, out);

    out.firstClose = await APP.close(session); session = null;
    record('first-owned-quit-clean', out.firstClose.stillAlive.length === 0, out.firstClose);
    assert(!ownedProcesses(built.exe).length, 'owned observation process remained before reopen');

    out.liveEvents = streamedEvents;
    assert(!out.consoleParseFailure, 'sanitized observation console record did not parse');
    const findPair = (kind, eventPath) => {
      const pendingName = kind === 'save' ? 'save-pending' : 'rename-intent';
      const completedName = kind === 'save' ? 'save-completed' : 'rename-completed';
      const pendingEvent = streamedEvents.find(event => event.event === pendingName &&
        event.cause?.kind === kind && (kind === 'save' ? event.cause.path === eventPath :
          event.cause['new-path'] === eventPath));
      const completedEvent = pendingEvent && streamedEvents.find(event => event.event === completedName &&
        event.cause?.['cause-id'] === pendingEvent.cause['cause-id']);
      return {pending: pendingEvent, completed: completedEvent};
    };
    const englishPair = findPair('save', englishPath);
    const renamedPair = findPair('save', renamedPath);
    const renamePair = findPair('rename', renamedPath);
    assert(englishPair.pending && englishPair.completed, 'English quit flush lacked paired save evidence');
    assert(renamedPair.pending && renamedPair.completed, 'renamed Korean quit flush lacked paired save evidence');
    assert(renamePair.pending && renamePair.completed, 'Korean quit flush lacked paired rename evidence');
    const englishAbsolute = B.assertInsideAllowedRoot('English note', path.join(graph, englishPath));
    const englishBytes = fs.readFileSync(englishAbsolute, 'utf8');
    const renamedBytes = fs.readFileSync(newAbsolute, 'utf8');
    record('save-pending-before-completion-and-bytes', englishPair.pending.sequence < englishPair.completed.sequence &&
      englishPair.pending.cause['graph-id'] === expectedGraphId &&
      englishPair.completed.cause['graph-id'] === expectedGraphId &&
      englishBytes.includes(englishEdit),
      {causeId: englishPair.pending.cause['cause-id'], pending: englishPair.pending.sequence,
       completed: englishPair.completed.sequence, graphId: expectedGraphId, path: englishPath,
       bytesSha256: sha256(englishBytes), uiEditorOpened: englishUi.editorOpened,
       persistedDuringOwnedQuit: true});
    record('korean-rename-intent-before-completion', renamePair.pending.sequence < renamePair.completed.sequence &&
      renamePair.pending.cause['graph-id'] === expectedGraphId &&
      renamePair.completed.cause['graph-id'] === expectedGraphId &&
      renamePair.pending.cause['old-path'] === oldKoreanPath &&
      renamePair.pending.cause['new-path'] === renamedPath &&
      !fs.existsSync(oldAbsolute) && fs.existsSync(newAbsolute),
      {causeId: renamePair.pending.cause['cause-id'], intent: renamePair.pending.sequence,
       completed: renamePair.completed.sequence, graphId: expectedGraphId,
       oldPath: oldKoreanPath, newPath: renamedPath, persistedDuringOwnedQuit: true});
    record('edit-after-rename', renamedPair.pending.sequence < renamedPair.completed.sequence &&
      renamedPair.pending.cause['graph-id'] === expectedGraphId &&
      renamedPair.completed.cause['graph-id'] === expectedGraphId &&
      renamedBytes.includes(koreanEdit) && !fs.existsSync(oldAbsolute) && fs.existsSync(newAbsolute),
      {causeId: renamedPair.pending.cause['cause-id'], pending: renamedPair.pending.sequence,
       completed: renamedPair.completed.sequence, graphId: expectedGraphId, path: renamedPath,
       bytesSha256: sha256(renamedBytes), persistedDuringOwnedQuit: true});
    const raw = streamedEvents.filter(event => event.event === 'raw-watcher-observation');
    const graphIds = new Set(raw.map(event => event.observation?.['graph-id']).filter(Boolean));
    record('raw-watcher-observed-without-suppression', raw.length > 0 &&
      [...graphIds].every(id => id === expectedGraphId),
      {count: raw.length, types: [...new Set(raw.map(event => event.observation?.type))], graphIds: [...graphIds],
       paths: [...new Set(raw.map(event => event.observation?.path).filter(Boolean))]});

    reopened = await APP.open({built, graph, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`reopen-${id}`, ok, {title, detail}),
      phase: () => {}, deps: {launch}});
    record('reopen-saved-english', await pageContains(reopened, english, englishEdit), {page: english});
    record('reopen-saved-renamed-korean', await pageContains(reopened, renamed, koreanEdit), {page: renamed});
    out.finalClose = await APP.close(reopened); reopened = null;
    record('final-owned-quit-clean', out.finalClose.stillAlive.length === 0 && !ownedProcesses(built.exe).length, out.finalClose);
    out.status = 'passed';
  } catch (error) {
    out.status = 'failed';
    out.failure = {message: String(error && error.message), stack: String(error && error.stack)};
    if (session) out.eventsAtFailure = await readEvents(session.page).catch(() => null);
    out.streamedEventsAtFailure = streamedEvents;
    throw error;
  } finally {
    if (session) {
      out.emergencyClose = await APP.close(session).catch(error => ({error: String(error)}));
      out.streamedEventsAfterEmergencyClose = streamedEvents;
    }
    if (reopened) out.emergencyReopenClose = await APP.close(reopened).catch(error => ({error: String(error)}));
    if (profile) out.profileCleanup = FP.restore(profile, {label: 'f28-observation'});
    save(evidenceFile, out);
    console.log(`Evidence: ${evidenceFile}`);
  }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
