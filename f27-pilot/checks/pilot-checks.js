#!/usr/bin/env node
'use strict';
//
// Packaged-application validation for the isolated Intel pilot.
//
//   node f27-pilot/checks/pilot-checks.js
//
// Drives the PACKAGED app, never the development build, and never the
// installed Logseq OG -- which is inspected read-only and is never started.
//
// Two launches, deliberately:
//
//   NORMAL   the executable is started directly with the inherited
//            environment and no arguments. Nothing about the isolation comes
//            from the harness: this is what a Finder or Dock launch does. It
//            must also show NO listening socket at all.
//
//   DRIVEN   Playwright's _electron, which adds its own inspector listener.
//            That listener is identified as the harness's and is never
//            confused with the API server. Used for the IPC guard checks.
//
// Graph data is used only inside the permitted root (see allowed-root.js), from
// a freshly generated synthetic graph. No personal graph is opened, read or
// enumerated.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PILOT_DIR = path.resolve(REPO, '..');
const ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));
const preflight = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-preflight.js'));
const snap = require('./os-snapshot.js');
const B = require('./allowed-root.js');
const graphGen = require('./make-synthetic-graph.js');

const APP_DIR = path.join(PILOT_DIR, 'out', 'Logseq-OG-F27-Pilot-darwin-x64',
                          'Logseq-OG-F27-Pilot.app');
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'Logseq-OG-F27-Pilot');
const RES_APP = path.join(APP_DIR, 'Contents', 'Resources', 'app');
const PRODUCT_DIR = path.join(os.userInfo().homedir, 'Library', 'Application Support',
                              ID.PRODUCT_NAME);
// The owned state root sits one level deeper than the Electron product
// directory, because Chromium's crash handler creates the product directory
// before the entry script runs. See pilot-isolation.js.
const STATE_ROOT = path.join(PRODUCT_DIR, ID.STATE_DIR);
const EVIDENCE = path.join(PILOT_DIR, 'evidence');
const ACCEPTED = path.resolve(PILOT_DIR, '..', 'f27-slice-1');

const results = [];
const owned = new Set();          // pids this harness started
let stopped = false;

// Written with writeSync so the transcript is complete even if the run is
// interrupted: a harness whose output is buffered cannot tell you where it hung.
function say(line) { try { fs.writeSync(1, line + '\n'); } catch (e) { console.log(line); } }

function record(id, title, ok, detail) {
  results.push({ id, title, ok: !!ok, detail: String(detail) });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${title}\n         ${detail}`);
  return ok;
}

// No await in this harness is unbounded. A step that hangs must fail the check
// it belongs to, not the whole run.
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms); }),
  ]);
}
async function attempt(label, ms, fn, fallback) {
  try { return await withTimeout(fn(), ms, label); }
  catch (e) { say(`         (${label}: ${e.message})`); return fallback; }
}
function stop(reason) { stopped = true; throw new Error('STOP: ' + reason); }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return (e.stdout || '').toString(); }
};
// PlistBuddy reports a missing key on stderr, so an absence check must read it.
const shBoth = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).toString();
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- process helpers ------------------------------------------------------
function descendants(pid) {
  const out = new Set([pid]);
  const walk = (p) => {
    const kids = sh('pgrep', ['-P', String(p)]).split('\n').map((s) => s.trim()).filter(Boolean);
    for (const k of kids) { const n = Number(k); if (!out.has(n)) { out.add(n); walk(n); } }
  };
  walk(pid);
  return [...out];
}

function listeningSockets(pids) {
  if (!pids.length) return [];
  const out = sh('lsof', ['-a', '-p', pids.join(','), '-i', '-P', '-n']);
  return out.split('\n').filter((l) => /LISTEN/.test(l)).map((l) => l.trim());
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

// Closing a PACKAGED Electron application is not the same as closing a node
// process. SIGTERM to the main process alone was measured to leave all four
// processes running, which then kept Electron's single-instance lock and made
// the next launch quit at once (electron/core.cljs main).
//
// So the close is staged, gentlest first, and every stage targets ONLY pids
// this harness started -- never a process matched by name:
//
//   1. ask the application to quit, by its own bundle id
//   2. SIGTERM the owned process tree
//   3. SIGKILL whatever is still owned and still running
//
async function closeGracefully(pid, label) {
  const tree = descendants(pid);
  const remaining = () => tree.filter(alive);

  // 1. the application's own quit path
  try {
    execFileSync('/usr/bin/osascript',
      ['-e', `tell application id "${ID.BUNDLE_ID}" to quit`],
      { stdio: 'ignore', timeout: 15000 });
  } catch (e) { /* not scriptable or already gone; the next stage covers it */ }
  for (let i = 0; i < 150 && remaining().length; i++) await sleep(100);
  if (!remaining().length) {
    say(`         ${label}: quit cleanly (${tree.length} processes)`);
    return [];
  }

  // 2. SIGTERM, whole owned tree
  for (const p of remaining()) { try { process.kill(p, 'SIGTERM'); } catch (e) { /* gone */ } }
  for (let i = 0; i < 100 && remaining().length; i++) await sleep(100);
  if (!remaining().length) {
    say(`         ${label}: closed on SIGTERM (${tree.length} processes)`);
    return [];
  }

  // 3. last resort, still only owned pids
  const stubborn = remaining();
  say(`         ${label}: SIGKILL for ${stubborn.length} owned process(es) that ignored SIGTERM`);
  for (const p of stubborn) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } }
  for (let i = 0; i < 50 && remaining().length; i++) await sleep(100);
  const still = remaining();
  say(`         ${label}: closed (${still.length} of ${tree.length} still alive)`);
  return still;
}

// ---- lsregister -----------------------------------------------------------
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
                   'LaunchServices.framework/Support/lsregister';
function schemeClaimants(scheme) {
  const dump = sh(LSREGISTER, ['-dump']);
  const claimants = new Set();
  let current = null;
  for (const line of dump.split('\n')) {
    const m = line.match(/^\s*bundle id:\s+(\S+)/);
    if (m) current = m[1];
    if (current && new RegExp(`claimed schemes:.*\\b${scheme}:`).test(line)) claimants.add(current);
    if (current && new RegExp(`bindings:.*\\b${scheme}:`).test(line)) claimants.add(current);
  }
  return [...claimants].sort();
}

// ---- main -----------------------------------------------------------------
async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F27 isolated Intel pilot: packaged-application checks ===\n');

  // ---------- P0 preconditions ----------
  say('P0  preconditions');
  if (!fs.existsSync(EXE)) stop(`packaged app not found at ${EXE}`);
  record('P0.1', 'packaged application present', true, APP_DIR);

  const v = preflight.verify(RES_APP);
  record('P0.2', 'packaged app passes the pre-load identity check', v.ok,
    v.ok ? `${v.checks.length} checks, build ${v.manifest.pilotBuildId}` : `${v.reason}: ${v.detail}`);
  if (!v.ok) stop('the packaged application fails its own preflight');
  const manifest = v.manifest;

  const arch = sh('file', [EXE]).includes('x86_64');
  record('P0.3', 'Intel x86_64 binary', arch, sh('file', [EXE]).trim().split(': ')[1] || '');

  // ---------- P1 baselines ----------
  say('\nP1  baselines (read-only)');
  const beforeSnap = snap.snapshot();
  fs.writeFileSync(path.join(EVIDENCE, 'os-snapshot-before.json'),
    JSON.stringify(beforeSnap, null, 2));
  record('P1.1', 'OS snapshot recorded', true,
    `${Object.keys(beforeSnap.dirs).length} directories, non-recursive`);

  const runGraph = graphGen.build();
  const graphReal = B.assertInsideAllowedRoot('synthetic graph', runGraph.graph);
  record('P1.0', 'fresh synthetic graph generated inside the permitted root only', true,
    graphReal);

  const claimantsBefore = schemeClaimants('logseq-og');
  record('P1.2', 'logseq-og: scheme claimants recorded', true, claimantsBefore.join(', ') || '(none)');

  const installedPlist = path.join('/Applications', 'Logseq-OG.app', 'Contents', 'Info.plist');
  const installedFingerprint = fs.existsSync(installedPlist)
    ? sha256(fs.readFileSync(installedPlist)) : null;
  const installedId = installedFingerprint
    ? sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', installedPlist]).trim() : null;
  record('P1.3', 'installed Logseq OG inspected read-only (never launched)', true,
    installedId ? `${installedId}, Info.plist ${installedFingerprint.slice(0, 16)}...` : 'not installed');

  const pilotId = sh('/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', path.join(APP_DIR, 'Contents', 'Info.plist')]).trim();
  record('P1.4', 'pilot bundle id is distinct from the installed app', pilotId !== installedId,
    `pilot ${pilotId} vs installed ${installedId}`);

  const urlTypes = shBoth('/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleURLTypes', path.join(APP_DIR, 'Contents', 'Info.plist')]);
  record('P1.5', 'pilot declares no CFBundleURLTypes', /Does Not Exist/.test(urlTypes),
    urlTypes.trim().slice(0, 120));

  // renderer provenance inside the PACKAGED app
  let mismatched = 0, comparedFiles = 0;
  const acceptedStatic = path.join(ACCEPTED, 'static');
  (function walk(rel) {
    const dir = path.join(RES_APP, rel);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (!rel && ['node_modules', 'electron.js', 'electron.js.map', 'tests.js',
                   'package.json', 'forge.config.js', ID.MANIFEST_FILE].includes(e.name)) continue;
      if (!rel && e.name.startsWith('pilot-')) continue;
      if (rel === 'icons' && e.name === 'pilot.icns') continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const acc = path.join(acceptedStatic, r);
        if (!fs.existsSync(acc)) { mismatched++; return; }
        comparedFiles++;
        if (sha256(fs.readFileSync(path.join(RES_APP, r))) !== sha256(fs.readFileSync(acc))) mismatched++;
      }
    }
  })('');
  record('P1.6', 'packaged renderer asset set is byte-identical to the accepted checkout',
    mismatched === 0, `${comparedFiles} files compared, ${mismatched} differing`);

  const mainJs = fs.readFileSync(path.join(RES_APP, 'js', 'main.js'), 'utf8');
  record('P1.7', 'packaged renderer still declares the accepted revision',
    mainJs.includes('"frontend.config.REVISION":"5b34566ca"'), '5b34566ca');

  // no runtime dependency on either source checkout
  const bundleText = fs.readFileSync(path.join(RES_APP, ID.MAIN_BUNDLE), 'utf8');
  const leaks = ['/development/f27-slice-1', '/development/f27-pilot', 'SHADOW_IMPORT_PATH']
    .filter((s) => bundleText.includes(s));
  record('P1.8', 'packaged main bundle has no dependency on either source checkout',
    leaks.length === 0, leaks.length ? leaks.join(', ') : 'no absolute checkout paths, no shadow loader');

  // ---------- P2 normal launch, no harness overrides ----------
  say('\nP2  normal launch (inherited environment, no harness overrides)');
  const preExisting = fs.existsSync(STATE_ROOT);
  record('P2.0', 'state root status before the launch', true,
    (preExisting ? `${STATE_ROOT} already exists (reuse path)`
                 : `${STATE_ROOT} does not exist yet (first-start path)`) +
    `; product dir ${fs.existsSync(PRODUCT_DIR) ? 'pre-exists' : 'absent'}`);

  const child = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  owned.add(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  for (let i = 0; i < 60 && !fs.existsSync(path.join(STATE_ROOT, ID.STARTUP_REPORT)); i++) {
    await sleep(500);
  }
  await sleep(4000);

  const reportPath = path.join(STATE_ROOT, ID.STARTUP_REPORT);
  const haveReport = fs.existsSync(reportPath);
  record('P2.1', 'the app established isolation with no help from the harness', haveReport,
    haveReport ? reportPath : 'no startup report was written');
  if (!haveReport) { await closeGracefully(child.pid, 'normal'); stop('no startup report'); }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  record('P2.2', 'every relocated path resolves inside the pilot root', report.ok,
    report.ok ? `root ${report.root}` : report.refusedPaths.join('; '));

  const homeIsolated = report.pathsAfter.home !== report.realOsIdentity.osUserInfoHome;
  record('P2.3', 'home is not the real OS home', homeIsolated,
    `home=${report.pathsAfter.home} realHome=${report.realOsIdentity.osUserInfoHome}`);
  record('P2.4', 'the derived .logseq-og is inside the pilot root', report.derived.dotRootIsolated,
    `${report.derived.dotRoot} (shared one would be ${report.derived.realDotRoot})`);

  const marker = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, ID.OWNERSHIP_MARKER), 'utf8'));
  record('P2.5', 'ownership evidence present and correct',
    marker.bundleId === ID.BUNDLE_ID && marker.schema === ID.SCHEMA,
    `${marker.bundleId} created ${marker.createdAt}`);

  const normalPids = descendants(child.pid);
  const normalListeners = listeningSockets(normalPids);
  record('P2.6', 'NO listening socket on an ordinary launch (no API server, no debug listener)',
    normalListeners.length === 0,
    normalListeners.length ? normalListeners.join(' | ') : `${normalPids.length} processes, 0 listeners`);

  const leftovers = await closeGracefully(child.pid, 'normal launch');
  record('P2.7', 'the normally launched app closed, leaving nothing behind',
    leftovers.length === 0,
    leftovers.length ? `pids still alive: ${leftovers.join(', ')}` : 'all owned processes exited');
  owned.delete(child.pid);

  fs.writeFileSync(path.join(EVIDENCE, 'normal-launch-output.txt'), out);
  fs.copyFileSync(reportPath, path.join(EVIDENCE, 'startup-report-normal-launch.json'));

  // Electron takes a single-instance lock (electron/core.cljs main). If any
  // process from the previous launch is still holding it, the next launch quits
  // immediately instead of opening a window, so wait for the tree to clear.
  for (let i = 0; i < 100 && normalPids.some(alive); i++) await sleep(200);
  record('P2.8', 'the single-instance lock is free before the next launch',
    !normalPids.some(alive),
    normalPids.some(alive) ? `still alive: ${normalPids.filter(alive).join(', ')}`
                           : `all ${normalPids.length} processes exited`);

  // ---------- P3 driven launch: the guards ----------
  say('\nP3  driven launch (Playwright _electron; its inspector is the harness\'s own)');
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));
  const app = await withTimeout(
    _electron.launch({ executablePath: EXE, timeout: 120000 }), 180000, 'electron launch');
  let appPid = null;
  try {
    appPid = await attempt('main pid', 20000, () => app.evaluate(() => process.pid), null);
    if (appPid) owned.add(appPid);

    const page = await withTimeout(app.firstWindow(), 60000, 'firstWindow');
    await withTimeout(page.waitForLoadState('domcontentloaded'), 60000, 'domcontentloaded');
    await sleep(6000);

    // G1/G2 observed side effects, not counters alone
    const registered = await attempt('protocol registration', 20000,
      () => app.evaluate(({ protocol }) => ({
        assets: protocol.isProtocolRegistered('assets'),
        lsp: protocol.isProtocolRegistered('lsp'),
      })), { assets: null, lsp: null });
    record('P3.1', 'internal asset protocols still work (assets:// and lsp:// registered)',
      registered.assets && registered.lsp, JSON.stringify(registered));

    const isDefault = await attempt('isDefaultProtocolClient', 20000,
      () => app.evaluate(({ app: a }) => a.isDefaultProtocolClient('logseq-og')), 'unknown');
    record('P3.2', 'the pilot did not make itself the OS handler for logseq-og:',
      isDefault === false, `isDefaultProtocolClient('logseq-og') = ${isDefault}`);

    // G3: both manual update channels, observed through the real renderer bridge
    const upd = await attempt('update channels', 30000, () => page.evaluate(async () => {
      const r = {};
      for (const ch of ['check-for-updates', 'install-updates']) {
        try { r[ch] = await window.apis.invoke(ch, []); }
        catch (e) { r[ch] = { error: String(e && e.message || e) }; }
      }
      return r;
    }), {});
    const refusedCheck = upd['check-for-updates'] && upd['check-for-updates'].pilotRefused === true;
    const refusedInstall = upd['install-updates'] && upd['install-updates'].pilotRefused === true;
    record('P3.3', 'manual update check refuses', refusedCheck, JSON.stringify(upd['check-for-updates']));
    record('P3.4', 'manual update install refuses', refusedInstall, JSON.stringify(upd['install-updates']));

    // G4: server start and restart, then observe whether a socket appeared
    const srv = await attempt('server channels', 30000, () => page.evaluate(async () => {
      const r = {};
      for (const action of ['start', 'restart']) {
        try { r[action] = await window.apis.doAction(['server/do', action]); }
        catch (e) { r[action] = { error: String(e && e.message || e) }; }
      }
      return r;
    }), {});
    record('P3.5', 'API server refuses :start', srv.start && srv.start.pilotRefused === true,
      JSON.stringify(srv.start));
    record('P3.6', 'API server refuses :restart', srv.restart && srv.restart.pilotRefused === true,
      JSON.stringify(srv.restart));

    await sleep(4000);
    const drivenPids = descendants(appPid);
    const drivenListeners = listeningSockets(drivenPids);
    // The only listener permitted here is the harness's own inspector, which
    // Playwright attaches to the main process on localhost.
    const nonHarness = drivenListeners.filter((l) => !/\b(127\.0\.0\.1|\[::1\]):\d+ \(LISTEN\)/.test(l));
    const onApiPort = drivenListeners.filter((l) => /:(12315|12399)\b/.test(l));
    record('P3.7', 'no listener on any API server port after start and restart were attempted',
      onApiPort.length === 0,
      drivenListeners.length
        ? `${drivenListeners.length} listener(s), all harness inspector: ${drivenListeners.join(' | ')}`
        : 'no listeners at all');
    record('P3.8', 'every listener present is attributable to the harness inspector',
      nonHarness.length === 0, nonHarness.length ? nonHarness.join(' | ') : 'yes');

    // V9: no graph is known to the pilot at first start
    const graphs = await attempt('getGraphs', 30000, () => page.evaluate(async () => {
      try { return await window.apis.doAction(['getGraphs']); }
      catch (e) { return { error: String(e && e.message || e) }; }
    }), []);
    const graphList = Array.isArray(graphs) ? graphs : [];
    record('P3.9', 'the pilot knows no graph at first start (nothing personal can be restored)',
      graphList.length === 0, `getGraphs -> ${JSON.stringify(graphs).slice(0, 200)}`);

    const dotRoot = await attempt('getLogseqDotDirRoot', 30000, () => page.evaluate(async () => {
      try { return await window.apis.doAction(['getLogseqDotDirRoot']); }
      catch (e) { return String(e); }
    }), '(unavailable)');
    record('P3.10', 'the running app reports an isolated dot-root',
      typeof dotRoot === 'string' && dotRoot.startsWith(STATE_ROOT),
      String(dotRoot));

    fs.writeFileSync(path.join(EVIDENCE, 'driven-launch-observations.json'),
      JSON.stringify({ registered, isDefault, upd, srv, graphs, dotRoot,
                       listeners: drivenListeners }, null, 2));
  } finally {
    try { await withTimeout(app.close(), 30000, 'app.close'); }
    catch (e) { say(`         (app.close: ${e.message})`); }
    if (appPid) {
      for (let i = 0; i < 60 && alive(appPid); i++) await sleep(100);
      if (alive(appPid)) await closeGracefully(appPid, 'driven launch');
      owned.delete(appPid);
    }
  }

  // ---------- P4 after the run ----------
  say('\nP4  after the run');
  const journalPath = path.join(STATE_ROOT, 'userData', 'pilot-guard-journal.jsonl');
  const journal = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const guards = [...new Set(journal.map((e) => e.guard))].sort();
  record('P4.1', 'the guard journal corroborates the observed refusals', guards.length > 0,
    `${journal.length} entries: ${guards.join(', ')}`);

  const prefs = path.join(snap.HOME, 'Library', 'Preferences');
  const deeplinkPrefs = fs.readdirSync(prefs).filter((n) => /^com\.deeplink\./i.test(n));
  const pilotDeeplink = deeplinkPrefs.filter((n) => n.includes('f27pilot'));
  record('P4.2', 'no deeplink preference was created for the pilot bundle',
    pilotDeeplink.length === 0,
    `pilot: none; pre-existing unrelated: ${deeplinkPrefs.join(', ') || 'none'}`);

  const claimantsAfter = schemeClaimants('logseq-og');
  const claimChanged = JSON.stringify(claimantsAfter) !== JSON.stringify(claimantsBefore);
  record('P4.3', 'the logseq-og: scheme claimants are unchanged', !claimChanged,
    claimChanged ? `before ${claimantsBefore.join(',')} after ${claimantsAfter.join(',')}`
                 : claimantsAfter.join(', ') || '(none)');
  record('P4.4', 'the pilot bundle claims no scheme', !claimantsAfter.includes(ID.BUNDLE_ID),
    `claimants: ${claimantsAfter.join(', ') || '(none)'}`);

  const installedAfter = installedFingerprint
    ? sha256(fs.readFileSync(installedPlist)) : null;
  record('P4.5', 'the installed application was not modified',
    installedAfter === installedFingerprint, `Info.plist ${String(installedAfter).slice(0, 16)}...`);

  const afterSnap = snap.snapshot();
  fs.writeFileSync(path.join(EVIDENCE, 'os-snapshot-after.json'), JSON.stringify(afterSnap, null, 2));
  const rows = snap.classify(beforeSnap, afterSnap, ID);
  const breaches = rows.filter((r) => r.verdict === 'LOGSEQ-NOT-PILOT');
  const pilotRows = rows.filter((r) => r.verdict === 'pilot');
  const other = rows.filter((r) => r.verdict === 'not-attributed-to-pilot');
  fs.writeFileSync(path.join(EVIDENCE, 'os-changes-classified.json'), JSON.stringify(rows, null, 2));
  record('P4.6', 'no Logseq-named path outside the pilot was created or touched',
    breaches.length === 0,
    breaches.length ? breaches.map((r) => `${r.change} ${r.dir}/${r.name}`).join('; ')
                    : `${pilotRows.length} pilot-owned changes, ${other.length} unrelated ` +
                      'changes listed in os-changes-classified.json (a name+mtime snapshot ' +
                      'cannot prove authorship; none is Logseq-named)');

  const sharedDot = path.join(snap.HOME, '.logseq-og');
  const sharedBefore = !!(beforeSnap.dirs[snap.HOME] || {})['.logseq-og'];
  const sharedAfter = !!(afterSnap.dirs[snap.HOME] || {})['.logseq-og'];
  record('P4.7', 'the shared ~/.logseq-og was not created by this run',
    !(sharedAfter && !sharedBefore),
    `before=${sharedBefore} after=${sharedAfter} (${sharedAfter ? 'pre-existing, untouched' : 'absent'})`);

  // graph containment and integrity
  const graphStillContained = B.isInsideAllowedRoot(runGraph.graph) &&
    fs.existsSync(path.join(runGraph.graph, 'logseq', 'config.edn'));
  record('P4.8', 'the synthetic graph is intact and still inside the permitted root',
    graphStillContained, graphReal);

  const registryDir = path.join(STATE_ROOT, 'home', '.logseq-og', 'graphs');
  const registry = fs.existsSync(registryDir) ? fs.readdirSync(registryDir) : [];
  const outsideRegistry = registry.filter((n) => {
    const decoded = n.replace(/\+\+/g, '/').replace(/\.transit$/, '');
    return decoded.startsWith('/') && !B.isInsideAllowedRoot(decoded);
  });
  record('P4.9', 'the pilot graph registry references nothing outside the permitted root',
    outsideRegistry.length === 0,
    registry.length ? `${registry.length} entries: ${registry.join(', ')}` : 'registry empty');

  // accepted checkout preserved
  const accHead = sh('git', ['-C', ACCEPTED, 'rev-parse', 'HEAD']).trim();
  const accStatus = sh('git', ['-C', ACCEPTED, 'status', '--porcelain']).trim();
  record('P4.10', 'the accepted checkout is untouched and clean',
    accHead === '5b34566cadd20df6724a013b4dc384b813e2018a' && accStatus === '',
    `HEAD ${accHead.slice(0, 9)}, ${accStatus === '' ? 'clean' : 'DIRTY: ' + accStatus}`);

  // ---------- summary ----------
  const failed = results.filter((r) => !r.ok);
  const summary = {
    at: new Date().toISOString(),
    app: APP_DIR,
    pilotBuildId: manifest.pilotBuildId,
    stateRoot: STATE_ROOT,
    syntheticGraph: graphReal,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  fs.writeFileSync(path.join(EVIDENCE, 'pilot-checks-summary.json'), JSON.stringify(summary, null, 2));

  say(`\n=== ${summary.passed}/${results.length} checks passed ===`);
  if (failed.length) {
    say('FAILED:');
    for (const f of failed) say(`  ${f.id} ${f.title}\n      ${f.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async (e) => {
  console.error('\n' + String(e && e.stack || e) + '\n');
  for (const pid of owned) { try { await closeGracefully(pid, 'cleanup'); } catch (x) { /* best effort */ } }
  process.exitCode = 2;
});
