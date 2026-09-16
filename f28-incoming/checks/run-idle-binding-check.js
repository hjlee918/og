#!/usr/bin/env node
'use strict';

/*
 * ONE FOCUSED OWNED-APP CHECK for the identity-binding correction.
 *
 * It is deliberately small: it does NOT repeat the observation matrix. It opens
 * the accepted package on one fresh owned synthetic graph and establishes, from
 * the running application:
 *
 *   - what a bridge cause's `graph-id` actually holds (OG's repo, not our
 *     sidecar graph id);
 *   - that pending-cause checks bound to the OG repo see this graph's causes,
 *     while the sidecar id sees none;
 *   - that watcher observations bind to the exact repo AND path;
 *   - that the corrected gate refuses when the app is on another graph, and
 *     reports idle only for the graph it is actually on.
 *
 * Whether a save can be caught while still PENDING is sampled honestly: if it
 * cannot be observed without new hooks, that is recorded as a limitation, not
 * claimed as a pass.
 *
 * The package is reused unmodified. Evidence is local and never a Git input.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const APP = require('../../f28-refpath/checks/packaged-app');
const FP = require('../../f28-refpath/checks/fresh-profile');
const B = require('../../f27-pilot/checks/allowed-root');
const NET = require('../../f28-origin/checks/network-refusal');
const { _electron } = require('../../node_modules/playwright');
const PI = require('../../f28-sync-prototype/src/persistent-identity');
const IA = require('../../f28-sync-prototype/src/incoming-application');
const { makeGate, makeIdleGate, ownedProcesses } = require('./app-closed-gate');
const PROBE = require('./og-idle-probe');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.resolve(REPO, '..', '..', 'evidence');
const BUILD = 'Logseq-OG-F28-IdentityCapture';

const sha256 = (v) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')).digest('hex');
const assert = (v, m) => { if (!v) throw new Error(m); };
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};
const git = (args) => {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim(); }
  catch (_e) { return null; }
};
const api = (page, method, ...args) => page.evaluate(({ method, args }) => {
  const fn = window.logseq && window.logseq.api && window.logseq.api[method];
  if (typeof fn !== 'function') throw new Error(`missing Logseq API ${method}`);
  return fn(...args);
}, { method, args });

async function run() {
  const helper = process.env.F28_IDENTITY_HELPER;
  const ownerToken = process.env.F28_OWNER_TOKEN || crypto.randomBytes(32).toString('hex');
  assert(helper, 'F28_IDENTITY_HELPER must name the built identity_store_helper binary');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceFile = path.join(EVIDENCE, `f28-idle-binding-${stamp}.json`);
  process.env.F28_DIAG_DIR = path.join(EVIDENCE, `f28-idle-binding-${stamp}-diagnostics`);
  const runName = `f28-idle-binding-${stamp}-${crypto.randomBytes(3).toString('hex')}`;

  const out = {
    schema: 'f28-idle-binding-check/1', stamp, status: 'preparing',
    mode: IA.MODE_APP_IDLE, checks: [],
    scope: 'ONE focused owned-app check of identity binding; the observation matrix is NOT repeated here',
  };
  const record = (id, ok, detail) => {
    out.checks.push({ id, ok, detail });
    save(evidenceFile, out);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
    assert(ok, id);
  };

  let session = null;
  const trees = [];
  try {
    const built = APP.resolve(BUILD);
    assert(built.preflight.ok, 'package preflight failed');
    const manifest = built.preflight.manifest;
    assert(manifest.experiment?.bridge?.mode === 'observation-only',
      'manifest is not observation-only');
    assert(!manifest.builtFrom.dirty, 'package not built from clean source');
    const pre = ownedProcesses(built.exe);
    assert(pre !== null && !pre.length, 'an owned process is already running');
    out.build = { id: manifest.pilotBuildId, source: manifest.builtFrom,
      bundleId: manifest.bundleId, bridge: manifest.experiment.bridge,
      reused: 'accepted package, unmodified' };
    out.source = { commit: git(['rev-parse', 'HEAD']),
      uncommitted: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length };
    record('reused-clean-observation-only-package', true, out.build);

    const profile = FP.swapAside(built.identity, { stamp });
    const context = { helper, runName, ownerToken,
      graphDirectory: 'g-binding', profileDirectory: 'p-binding' };
    PI.initializeOwnedRun(context);
    const canonicalGraphPath = path.join(B.allowedRootReal(), runName, context.graphDirectory);
    assert(fs.realpathSync(canonicalGraphPath) === canonicalGraphPath, 'graph path not canonical');
    B.assertInsideAllowedRoot('owned graph', canonicalGraphPath);

    const launch = NET.launchWith((o) => _electron.launch(o), BUILD);
    const bad = path.join(path.dirname(B.allowedRootReal()), 'f28-idle-binding-inert');
    const errors = { record() {}, phase() {}, endPhase() {}, entries() { return []; }, phases() { return []; } };
    session = await APP.open({ built, graph: canonicalGraphPath, bad, errors, say: console.log,
      record: (id, title, ok, detail) => record(`launch-${id}`, ok, { title, detail }),
      phase: () => {}, deps: { launch } });
    trees.push(session.ownedTree || []);

    const ogRepo = await session.page.evaluate(
      () => window.frontend?.state?.get_current_repo?.() || null);
    assert(ogRepo, 'the renderer reported no current repo');
    const sidecarGraphId = `f28-idle-binding-graph-${crypto.randomBytes(4).toString('hex')}`;
    out.identities = { sidecarGraphId, ogRepo, canonicalGraphPath,
      note: 'three distinct identities; only ogRepo appears in bridge causes' };
    record('three-identities-are-distinct',
      ogRepo !== sidecarGraphId && ogRepo.includes(canonicalGraphPath),
      out.identities);

    // --------- make OG genuinely save, then read what the cause actually holds
    const pageName = `유휴 바인딩 문서 ${stamp.slice(0, 19)}`;
    await api(session.page, 'create_page', pageName, {},
      { redirect: false, createFirstBlock: false, format: 'markdown' });
    await api(session.page, 'insert_block', pageName, '- 바인딩 확인용 블록\n', { focus: false });
    // sample the stream rapidly while the save is dispatched, to try to catch a
    // cause while it is still `pending`
    const notePath = `pages/${pageName}.md`;
    const sampler = (async () => {
      const seen = [];
      for (let i = 0; i < 60; i += 1) {
        const snapshot = await PROBE.pendingLocalCauses(session.page, ogRepo).catch(() => null);
        if (snapshot && !snapshot.error && snapshot.pending > 0) seen.push({ i, ...snapshot });
        await new Promise((r) => setTimeout(r, 50));
      }
      return seen;
    })();
    await session.page.evaluate(async (name) => {
      const p = window.logseq?.api?.get_page?.(name);
      const repo = window.frontend?.state?.get_current_repo?.();
      const write = window.frontend?.modules?.outliner?.file?.do_write_file_BANG_;
      await Promise.resolve(write(repo, p.id, 'binding-check-save'));
    }, pageName);
    const pendingSightings = await sampler;

    const causesByRepo = await PROBE.pendingLocalCauses(session.page, ogRepo);
    const causesBySidecar = await PROBE.pendingLocalCauses(session.page, sidecarGraphId);
    out.causeBinding = { causesByRepo, causesBySidecar,
      pendingSightings: pendingSightings.length };
    record('bridge-causes-carry-the-og-repo-not-the-sidecar-graph-id',
      causesByRepo.total > 0 && causesBySidecar.total === 0
      && causesBySidecar.otherRepoCauses >= causesByRepo.total,
      { byRepo: causesByRepo, bySidecar: causesBySidecar,
        note: 'this is the confirmed defect, observed against the running application' });

    // honest disposition of the pending-save question
    out.pendingSaveObservation = pendingSightings.length
      ? { observed: true, sightings: pendingSightings.length }
      : { observed: false,
          limitation: 'no cause was caught while still `pending`: the window between save-pending! and save-completed! is shorter than the sampling interval reachable through the automation channel, and narrowing it further would need new in-app hooks. The pending-cause GATE path is proven separately with injected records; genuine pending-save capture remains unestablished.' };
    record('pending-save-capture-is-reported-honestly', true, out.pendingSaveObservation);

    // ------------------------------------- watcher observations bind to both
    const byRepoAndPath = await PROBE.watcherObservationsFor(session.page, ogRepo, notePath);
    const byWrongRepo = await PROBE.watcherObservationsFor(session.page,
      `${ogRepo}-not-this-graph`, notePath);
    const byWrongPath = await PROBE.watcherObservationsFor(session.page, ogRepo,
      'pages/no-such-note.md');
    out.watcherBinding = { byRepoAndPath, byWrongRepo, byWrongPath };
    record('watcher-observations-bind-to-the-exact-repo-and-path',
      byWrongRepo === 0 && byWrongPath === 0, out.watcherBinding);

    /*
     * Settle the editor first: insert_block leaves a block in edit mode even
     * with focus:false, so the app is genuinely not idle until this runs. That
     * is the gate working, not a gate defect.
     */
    const settled = await session.page.evaluate(async () => {
      const editor = window.frontend?.handler?.editor;
      const state = window.frontend?.state;
      try { editor?.save_current_block_BANG_?.(); } catch (_e) { /* nothing open */ }
      try { state?.clear_edit_BANG_?.(); } catch (_e) { /* nothing open */ }
      await new Promise((r) => setTimeout(r, 1500));
      return { editInputId: state?.get_edit_input_id?.() || null };
    });
    out.settled = settled;
    record('editor-settled-before-the-gate-reading', !settled.editInputId, settled);

    // --------------------------------------------- the corrected gate itself
    const readIdle = async (stage, overrides = {}) => {
      const signals = await PROBE.readIdleSignals(session.page, ogRepo);
      const liveRepo = await session.page.evaluate(
        () => window.frontend?.state?.get_current_repo?.() || null);
      const causes = await PROBE.pendingLocalCauses(session.page, ogRepo);
      return { stage, ...signals,
        pendingCauses: causes.error ? null : causes.pending,
        failedCauses: causes.error ? null : causes.failed,
        unboundOpenCauses: causes.error ? null : causes.unboundOpen,
        repoMatchesOwnedGraph: liveRepo === ogRepo, ...overrides };
    };
    const onOwnGraph = await makeIdleGate((s) => readIdle(s))('own-graph');
    const onOtherGraph = await makeIdleGate(
      (s) => readIdle(s, { repoMatchesOwnedGraph: false }))('other-graph');
    out.gate = {
      onOwnGraph: { idle: onOwnGraph.idle, failing: onOwnGraph.failing,
        claimsClosed: onOwnGraph.closed === true },
      onOtherGraph: { idle: onOtherGraph.idle, failing: onOtherGraph.failing },
    };
    record('the-corrected-gate-refuses-when-the-app-is-on-another-graph',
      onOtherGraph.idle === false
      && onOtherGraph.failing.includes('app-on-another-graph')
      && onOtherGraph.closed !== true, out.gate.onOtherGraph);
    record('the-corrected-gate-reports-idle-only-for-the-graph-it-is-on',
      onOwnGraph.idle === true && onOwnGraph.closed !== true
      && onOwnGraph.failing.length === 0, out.gate.onOwnGraph);

    out.finalClose = await APP.close(session);
    session = null;
    const closedVerdict = makeGate(built, trees)('final');
    record('owned-processes-have-exited',
      out.finalClose.stillAlive.length === 0 && closedVerdict.closed === true,
      { close: out.finalClose });

    out.profileCleanup = FP.restore(profile);
    out.status = 'passed';
    out.limits = [
      'ONE focused binding check; the observation matrix was not repeated',
      'a genuinely pending (unflushed) save was not captured — see pendingSaveObservation',
      'concurrent-edit safety is not tested and not claimed',
    ];
    save(evidenceFile, out);
    console.log(`\nBinding check passed: ${out.checks.length} checks (mode: app-idle)`);
    console.log(`Evidence: ${evidenceFile}`);
  } catch (error) {
    out.status = 'failed';
    out.failure = { message: String(error && error.message || error) };
    if (session) out.emergencyClose = await APP.close(session).catch((e) => ({ error: String(e) }));
    save(evidenceFile, out);
    console.error(`\nFAILED: ${out.failure.message}`);
    console.error(`Evidence: ${evidenceFile}`);
    process.exitCode = 1;
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
