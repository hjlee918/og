#!/usr/bin/env node
'use strict';
//
// INTEL PLUGIN COEXISTENCE — does the current reference bundle still behave
// with the three inventoried plugins present?
//
//   node f28-refpath/checks/plugin-coexistence-checks.js [session ...]
//
// Sessions, in order, each on its OWN fresh synthetic graph:
//
//   none      the control: the same journey with no plugin installed, so any
//             later difference is attributable rather than assumed
//   readwise  the official Readwise plugin alone            (the priority)
//   ollama    ollama-logseq alone
//   chatgpt   the Logseq ChatGPT plugin alone
//   all       all three together
//
// WHAT THIS RUN DOES AND DOES NOT ESTABLISH.
//
// It loads plugin PACKAGES and reads what OG's plugin host does with them. It
// never enters a credential, never authorises anything, never invokes a plugin
// command, menu item, toolbar button or settings pane, and never lets a plugin
// reach a service. Readwise's own bundle gates every network call and every
// resync on `logseq.settings.readwiseAccessToken`; ollama's on a configured
// host; the ChatGPT plugin's on an `OPENAI_API_KEY`. A fresh profile has none
// of those, so the credential-free path is the only one this run can take —
// and that is the point. UNAUTHENTICATED COEXISTENCE IS NOT PLUGIN
// COMPATIBILITY: nothing here says a Readwise import, an Ollama request or a
// ChatGPT request would work, or that it would leave the graph correct.
//
// ENROLMENT IS NOT LOADING. `LSPluginCore.registeredPlugins` says the host
// took the package; `status`, `loaded` and the load error say whether the
// plugin's own code ever ran. V5 recorded `handshake Timeout` for all three on
// the accepted baseline build, and this run reports the host's own words
// rather than inheriting that finding.
//
// CONTAINMENT, ESTABLISHED BEFORE ANYTHING IS LOADED.
//
//   * the packaged build's own isolation puts `home`, `userData`,
//     `sessionData`, `temp` and `crashDumps` under one state root, so OG's
//     dot-root — and therefore its plugins directory — is this build's, never
//     the installed application's;
//   * the state root used here is FRESH: `checks/fresh-profile.js` moves the
//     shared one aside under this build's own ownership marker and puts it
//     back, so no plugin and no plugin setting survives into a later F28 run;
//   * the in-application graph boundary (electron.pilot G5) is active, and the
//     launcher proves it by feeding the folder dialog an outside path and
//     requiring a journalled refusal before the permitted graph is opened;
//   * OG's live current repository is asserted EXACTLY equal to this session's
//     own graph before any interaction;
//   * every package is re-hashed against the project's own V5 inventory before
//     it is placed, and again at the destination.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md): only
// this run's own fresh synthetic graphs inside ~/Library/Mobile Documents/
// com~apple~CloudDocs/Logseq Test, no personal graph touched or enumerated, no
// earlier run's folder reused, the installed application never launched.
//
// THE UNRESOLVED `[frontend.handler]` CONDITION STANDS. No exemption is
// widened for a plugin: an error the rule cannot account for FAILS its check,
// and plugin-attributable errors are reported as what they are rather than
// exempted.
//
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));
const CG = require('./make-combined-graph.js');
const APP = require('./packaged-app.js');
const NOISE = require('./browser-noise.js');
const REC = require('./recorder.js');
const RD = require('./reforder-read.js');
const IC = require('./inside-containers.js');
const PA = require('./plugin-artifacts.js');
const FP = require('./fresh-profile.js');
const RJ = require('./reference-journey.js');
// THE ORIGIN EXPERIMENT reuses this measurement deliberately: the same journey,
// the same readers and the same rules, against a DIFFERENT build. Running a new
// instrument against the candidate would make the two runs incomparable, which
// is the one thing this comparison exists to avoid. Everything below defaults
// to the accepted F28 RefPath build; nothing changes for it.
const EXPERIMENT = process.env.F28_ORIGIN_EXPERIMENT === '1';
const XA = EXPERIMENT ? require('../../f28-origin/checks/experiment-assertions.js') : null;
const NET = EXPERIMENT ? require('../../f28-origin/checks/network-refusal.js') : null;
const ID = require(EXPERIMENT ? '../../f28-origin/src/experiment-identity.js'
                              : '../src/feature-identity.js');

const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
const FEATURE_APP = EXPERIMENT ? 'Logseq-OG-F28-OriginExp' : 'Logseq-OG-F28-RefPath';
const EVIDENCE_PREFIX = EXPERIMENT ? 'f28-origin-experiment' : 'f28-plugin-coexistence';
const sleep = OP.sleep;

/** Every phase in which a reference feature was the thing on screen. */
const FEATURE_PHASES = ['references', 'badge-journey', 'disclosures', 'ordering',
                        'language', 'keyboard', 're-entry'];

/** The sessions, and the packages each one installs. */
const SESSIONS = [
  { key: 'none', label: 'control — no plugin installed', plugins: [] },
  { key: 'readwise', label: 'the official Readwise plugin alone',
    plugins: ['logseq-readwise-official-plugin'] },
  { key: 'ollama', label: 'ollama-logseq alone', plugins: ['ollama-logseq'] },
  { key: 'chatgpt', label: 'the Logseq ChatGPT plugin alone',
    plugins: ['logseq-chatgpt-plugin'] },
  { key: 'all', label: 'all three together',
    plugins: ['logseq-readwise-official-plugin', 'ollama-logseq', 'logseq-chatgpt-plugin'] },
];

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
const J = (v) => JSON.stringify(v);

const results = [];
const sessions = {};
const batch = {};

function makeRecorder(prefix) {
  return function record(id, title, ok, detail) {
    let text;
    try { text = String(typeof detail === 'function' ? detail() : detail); }
    catch (e) { text = `(could not describe this result: ${e.message})`; }
    results.push({ id: `${prefix}${id}`, title, ok: !!ok, detail: text });
    say(`  ${ok ? 'PASS' : 'FAIL'}  ${`${prefix}${id}`.padEnd(9)} ${title}\n          ${text}`);
    return ok;
  };
}

/**
 * Let the APPLICATION create and mark the fresh state root, then close.
 *
 * WHY A LAUNCH RATHER THAN A `mkdir`. `pilot-isolation.js` claims a state root
 * only when it is genuinely new, and adopts a pre-existing one only on its own
 * valid ownership marker. A harness that created the directory — or, worse,
 * wrote the marker itself — would be defeating exactly the guard that keeps
 * this build from claiming state it did not establish. So the directory tree
 * this batch installs plugins into is created by the application, marked by
 * the application, and merely USED here. Nothing is opened: no graph is
 * selected, and the launch is stopped as soon as the marker exists.
 *
 * Only processes descended from the retained pid are stopped.
 */
async function seedProfile(built, root) {
  const { _electron } = require(path.join(REPO, 'node_modules', 'playwright'));
  const marker = path.join(root, ID.OWNERSHIP_MARKER);
  let app = null;
  let pid = null;
  let tree = [];
  try {
    app = await APP.withTimeout(
      _electron.launch({ executablePath: built.exe, timeout: 120000 }),
      180000, 'seed launch');
    pid = await app.evaluate(() => process.pid).catch(() => null);
    tree = pid ? OP.descendants(pid) : [];
    if (!pid) throw new Error('the seed launch did not report a pid; refusing to continue');
    for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await sleep(1000);
  } finally {
    if (app) { try { await APP.withTimeout(app.close(), 30000, 'seed close'); } catch (e) { /* stopped below */ } }
    if (pid) await OP.stop(pid, (m) => say('          ' + m));
  }
  return { pid, owned: tree.length, stillAlive: tree.filter(OP.alive),
           marked: fs.existsSync(marker) };
}

// ---------------------------------------------------------------------------
// One session: a fresh graph, a fresh profile, an optional plugin set, and the
// same short reference journey every time.
// ---------------------------------------------------------------------------

/**
 * The ORIGIN EXPERIMENT's own claims, asked of the running application.
 * Never called for the accepted build.
 */
async function experimentChecks({ session, page, record, obs, ps, wantIds, GRAPH }) {
  const origins = await XA.readOrigins(page);
  obs.origins = origins;
  record('X.1', 'the renderer is actually served from the privileged application origin — the ' +
    'URL the window ended up at, not the define the build compiled in',
    origins.origin === 'lsp://logseq.com' && /\/electron\.html$/.test(origins.href || ''),
    `href ${J(origins.href)}, origin ${J(origins.origin)}`);

  const load = XA.summariseLoad(ps, wantIds);
  obs.experimentLoad = load;
  record('X.2', 'every plugin entry resolves through the privileged PLUGIN origin, so no sandbox ' +
    'is a file:// document any more',
    load.entriesOnPluginOrigin && !load.anyFileEntry,
    () => load.rows.map((r) => `${r.key}: ${J(r.entry)}`).join('\n          ') || 'no plugin placed');

  record('X.3', 'the application origin and the plugin origin are DIFFERENT, so the separation ' +
    'between the app and its plugins is preserved rather than collapsed',
    origins.origin === 'lsp://logseq.com' &&
    load.rows.every((r) => (r.entry || '').startsWith('lsp://logseq.io/')),
    `application ${J(origins.origin)} vs plugin origin "lsp://logseq.io" — same scheme, ` +
    'different host, therefore cross-origin');

  // THE POINT OF THE WHOLE EXPERIMENT.
  record('X.4', 'the plugins COMPLETE their handshake and report loaded — not registered, not ' +
    'enabled, loaded',
    load.loadedCount === wantIds.length && !load.anyHandshakeTimeout,
    () => load.rows.map((r) => `${r.key}: status ${J(r.status)}, loaded ${J(r.loaded)}` +
      `${r.loadError ? `, loadError ${J(r.loadError)}` : ''}`).join('\n          ') +
      `\n          → ${load.loadedCount} of ${wantIds.length} loaded; ` +
      `handshake timeout seen: ${load.anyHandshakeTimeout}`);

  const probes = await XA.probeHandler(page);
  obs.handlerProbes = probes;
  const served = probes.filter((p) => p.expect === 'serve');
  const refused = probes.filter((p) => p.expect === 'refuse');
  record('X.5', 'the hardened lsp:// handler serves the application\'s own resources',
    served.length > 0 && served.every((p) => p.ok === true && p.bytes > 0),
    () => served.map((p) => `${p.name}: status ${J(p.status)}, ${p.bytes} bytes`).join('; '));
  record('X.6', 'and refuses an unknown host, a traversal, a PERCENT-ENCODED traversal and an ' +
    'encoded absolute path — on both hosts',
    refused.length === 6 && refused.every((p) => p.ok !== true),
    () => refused.map((p) => `${p.name}: ${p.threw ? `threw ${J(p.threw)}` : `status ${J(p.status)}`}` +
      `${p.body ? ` LEAKED ${J(p.body)}` : ''}`).join('\n          '));

  const assetProbe = path.join(GRAPH, 'assets', 'f28-origin-probe.png');
  const asset = fs.existsSync(assetProbe) ? await XA.probeAsset(page, assetProbe) : null;
  obs.assetProbe = asset;
  record('X.7', 'a local graph asset still loads over assets:// from the new origin, so the F27 ' +
    'asset contract survives the move',
    !!(asset && asset.loaded && asset.w === 1),
    asset ? `${J(asset.url)} → loaded ${J(asset.loaded)} ${J(asset.w)}x${J(asset.h)}` : 'no probe placed');

  const net = await NET.read(session.app);
  obs.network = net ? { allowed: net.allowed, refusedCount: net.refused.length,
                        refused: net.refused.slice(0, 40) } : null;
  record('X.8', 'no request left the application: every non-local scheme was refused by the ' +
    "experimental bootstrap control; bounded redacted refusals are recorded",
    !!net && net.active === true && net.version === 'f28-origin-network/1',
    () => net
      ? `${net.allowed} local request(s) allowed; ${net.refused.length} refused` +
        (net.refused.length ? `\n          ${net.refused.map((r) => `${r.kind}`).join('\n          ')}` : '')
      : 'the network control did not report');
}

async function runSession(cfg, built, stamp) {
  const prefix = `${cfg.key.toUpperCase()}.`;
  const record = makeRecorder(prefix);
  const errors = REC.createRecorder();
  const obs = { key: cfg.key, label: cfg.label, plugins: cfg.plugins };
  let ownedTree = [];
  let errorEvidence = null;

  function phase(name, operation) {
    errors.phase(name, operation);
    say(`  ┈ phase: ${name}${operation ? ` (${operation})` : ''}`);
  }

  say(`\n\n########## session ${cfg.key} — ${cfg.label} ##########`);

  // ---- a fresh graph, hashed, with nothing declared --------------------
  const g = CG.build({ kind: `coexist-${cfg.key}` });
  const GRAPH = B.assertInsideAllowedRoot('plugin-coexistence graph', g.graph);
  obs.graph = GRAPH;
  // Placed BEFORE the snapshot, so the `assets://` probe is part of the fixture
  // rather than a graph change this run would then have to explain away.
  if (EXPERIMENT) XA.placeAssetProbe(GRAPH);
  record('1.1', 'a fresh synthetic graph inside the permitted root; no earlier run reused',
    true, `${GRAPH} (${g.pages} pages + ${g.journal})`);
  const before = GH.snapshot(GRAPH);
  record('1.2', 'every file hashed before the application is launched; this session declares ' +
    'NO write at all', Object.keys(before).length >= g.pages + 2,
    `${Object.keys(before).length} files, and no update_block, filter or edit is performed`);

  // ---- the plugins directory, verified and placed ----------------------
  const stateRoot = FP.stateRootFor(ID).root;
  const pluginsDir = FP.pluginsDirIn(stateRoot);
  let install = null;
  if (cfg.plugins.length) {
    install = PA.installInto(pluginsDir, cfg.plugins);
    obs.install = install.installed.map((p) => ({
      id: p.id, version: p.version, title: p.title, publisher: p.publisher,
      manifestId: p.manifestId, treeSha256: p.treeSha256, manifestSha256: p.manifestSha256,
      fileCount: p.fileCount, totalBytes: p.totalBytes,
    }));
    record('2.1', 'every package hashes to the identity the project already recorded, and the ' +
      'placed copy hashes to it again',
      install.installed.length === cfg.plugins.length,
      () => install.installed.map((p) => `${p.id} ${p.version} tree ${p.treeSha256.slice(0, 12)}… ` +
        `manifest ${p.manifestSha256.slice(0, 12)}… (${p.fileCount} files / ${p.totalBytes} bytes)`)
        .join('\n          '));
    record('2.2', 'the packages are placed in the FRESH profile\'s own plugins directory — the ' +
      'one OG enumerates — with no Marketplace call, no download and no in-app Install',
      pluginsDir.startsWith(stateRoot + path.sep),
      `${pluginsDir}\n          provenance: ${PA.PROVENANCE}`);
  } else {
    // Deliberately NOT created here. `pilot-isolation` refuses to adopt a state
    // root it did not create, so the harness must never bring one into being —
    // the seeded launch in G2 is what makes this directory exist, and the
    // application is what marks it.
    const present = fs.existsSync(pluginsDir)
      ? fs.readdirSync(pluginsDir).filter((n) => n !== '.DS_Store') : [];
    record('2.1', 'the control session installs nothing; the plugins directory is empty',
      present.length === 0, `${pluginsDir}: ${J(present)}`);
  }
  const pluginsBefore = PA.snapshot(pluginsDir);

  const BAD = path.join(path.dirname(B.allowedRootReal()), `f28-coexist-inert-probe-${cfg.key}`);
  record('2.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD), BAD);

  // ---- launch, refuse an outside path, open the graph ------------------
  // The experiment's launch adapter refuses before launching. No post-launch
  // session hook is claimed as containment; main() also refuses before seeding.
  const deps = EXPERIMENT ? {
    launch: NET.launchWith((opts) => require(path.join(REPO, 'node_modules', 'playwright'))
      ._electron.launch(opts)),
  } : undefined;
  const session = await APP.open({
    // `record` already stamps this session's prefix, so the launcher is given
    // only the letter its own sequence uses.
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'L', deps,
  });
  const { page } = session;
  ownedTree = session.ownedTree;
  const JN = RJ.create({ page, session, CG, say });

  try {
    // =====================================================================
    // The plugin host, given time to finish whatever it is going to do
    // =====================================================================
    phase('plugin-host', 'let-the-host-settle-then-read-its-own-report');
    // The host's iframe handshake times out at 8s (lsplugin.core). Waiting
    // well past that in a phase of its own is what keeps a plugin's startup
    // errors from being mistaken for a reference-feature error later.
    await sleep(22000);
    const ps = await JN.pluginState();
    obs.pluginState = ps;
    // THE KEY THE HOST USES IS THE DIRECTORY ID, MEASURED RATHER THAN PREDICTED.
    // The first run of this batch expected the manifest's own `logseq.id` and
    // failed on the ChatGPT plugin, whose manifest declares `_rw1zys420`. It is
    // OG that supplies the key: `electron.utils/get-ls-default-plugins` hands
    // `LSPluginCore.register` the plugin DIRECTORY, so the registered key is the
    // directory (Marketplace) id. That first reading is kept; the manifest id is
    // still carried below, now as the cross-check it actually is — a plugin
    // whose manifest id differs from its host key is REPORTED, not assumed away.
    const wantIds = cfg.plugins.slice();
    const manifestIdNotes = cfg.plugins
      .filter((id) => PA.BY_ID.get(id).manifestId !== id)
      .map((id) => `${id}: manifest logseq.id ${J(PA.BY_ID.get(id).manifestId)} is NOT the key ` +
        'the host registered it under');
    obs.manifestIdNotes = manifestIdNotes;
    const registered = ps.registered || [];
    const enabled = ps.enabled || [];
    const enrolled = wantIds.filter((k) => registered.includes(k));
    // Enrolment ONLY. `hostMounted` is reported beside it rather than folded
    // into it: with no package placed there is nothing for the host to mount,
    // so its value would decide a claim it has no bearing on.
    record('3.1', 'the plugin host reports exactly the packages this session placed, and ' +
      'nothing else — enrolment, which is not loading',
      enrolled.length === wantIds.length && registered.length === wantIds.length &&
      enabled.length === wantIds.length,
      () => `registered ${J(registered)}; enabled ${J(enabled)}; expected ${J(wantIds)}; ` +
        `host mounted ${J(ps.hostMounted)} (read from LSPluginCore's own actor, never by ` +
        `calling hostMounted(), which is a command that would settle it)` +
        (manifestIdNotes.length ? `\n          ${manifestIdNotes.join('\n          ')}` : ''));

    const loadRows = (ps.plugins || []).map((p) =>
      `${p.key}: status ${J(p.status)}, loaded ${J(p.loaded)}, disabled ${J(p.disabled)}` +
      `${p.loadError ? `, loadError ${J(p.loadError)}` : ''}` +
      `${p.options ? `, version ${J(p.options.version)}` : ''}`);
    const loadedCount = (ps.plugins || []).filter((p) => p.loaded === true).length;
    obs.loaded = { count: loadedCount, of: wantIds.length, rows: loadRows };
    // NOT a pass/fail on "did it load": this run reports what the host says.
    // The assertion is that the host gave a definite answer for every package.
    record('3.2', 'the host gives a definite loaded/errored answer for every placed package — ' +
      'reported, not assumed, and not inherited from V5',
      (ps.plugins || []).length === wantIds.length &&
      (ps.plugins || []).every((p) => p.status !== null || p.loaded !== null),
      () => (loadRows.length ? loadRows.join('\n          ') : 'no package registered') +
        `\n          → ${loadedCount} of ${wantIds.length} completed runtime initialisation`);
    if (EXPERIMENT) await experimentChecks({ session, page, record, obs, ps, wantIds, GRAPH });

    record('3.3', 'the surfaces a LOADED plugin would have created are counted, so "no ' +
      'interference" is measured rather than inferred',
      true,
      () => `sandbox iframes ${ps.sandboxIframes}, sandbox containers ${ps.sandboxContainers}, ` +
        `injected UI nodes ${ps.injectedUiNodes}, toolbar items ${ps.toolbarItems.length} ` +
        `(${J(ps.toolbarItems.map((t) => t.injected).filter(Boolean))}), ` +
        `plugin sidebar items ${ps.pluginSidebarItems}`);

    // =====================================================================
    // The reference list itself
    // =====================================================================
    phase('references', 'open-the-anchor-page');
    await session.goTo(CG.ANCHOR);
    await JN.settle('on the anchor page');
    const original = await RD.read(page);
    obs.original = original.present ? RD.lean(original) : original;
    record('4.1', 'the linked-references section rendered, with the list the ordering runs ' +
      'measured: 10 mentions, 8 groups',
      original.present === true && original.groups.length === 8 &&
      original.heading.includes(String(CG.REFERENCING.length)),
      () => original.present
        ? `"${original.heading}"; ${original.groups.length} group(s), ${original.rows.length} row(s)`
        : `not present: ${original.error}`);
    if (!original.present) throw new Error('no linked-references section; not proceeding');

    record('4.2', "every reference control is present and OG's own list opens at rest — the " +
      'ordering select, both disclosures, the role labels, the filter and unlinked references',
      original.selects === 1 && original.controlInHeading === true &&
      original.wrapOrder === 'original' && original.controlOrder === 'original' &&
      original.ctxControls > 0 && original.pathControls > 0 &&
      original.labels === original.rows.length &&
      original.filterControl === true && original.unlinked === true && original.editors === 0,
      () => `${original.selects} order select in the heading ${original.controlInHeading} ` +
        `(list ${J(original.wrapOrder)}, control ${J(original.controlOrder)}); ` +
        `${original.ctxControls} child-context control(s), ${original.pathControls} ` +
        `source-path control(s), ${original.labels} role label(s) on ${original.rows.length} ` +
        `row(s); filter ${original.filterControl}, unlinked ${original.unlinked}, ` +
        `${original.editors} editor(s)`);

    const originalOrder = RD.orderOf(original);
    const originalInside = IC.insideSetOf(original);
    const live = original.groups.map((x) => ({ ref: x.ref, title: x.title }));
    const expectAsc = CG.orderTitles(live, 'title-asc').map((x) => x.ref);

    const mainBefore = await JN.mainState();
    obs.mainContent = mainBefore;
    record('4.3', "the anchor page's main content still carries the F27 inline panel beside " +
      'the list, and the badge row still renders its target inline',
      !!mainBefore.hostMain && mainBefore.hostMain.present && mainBefore.hostMain.wrapped &&
      mainBefore.hostMain.toggle && !!mainBefore.badgeHost && mainBefore.badgeHost.present &&
      mainBefore.badgeHost.embedShowsTarget && mainBefore.overview === false,
      () => `inline host present ${mainBefore.hostMain && mainBefore.hostMain.present}, ` +
        `wrapped ${mainBefore.hostMain && mainBefore.hostMain.wrapped}, toggle ` +
        `${mainBefore.hostMain && mainBefore.hostMain.toggle}; badge row renders the target ` +
        `${mainBefore.badgeHost && mainBefore.badgeHost.embedShowsTarget}; overview before ` +
        `any click ${mainBefore.overview}`);

    // =====================================================================
    // The F27 journey: badge → compact overview → Crystal → one row's context
    // =====================================================================
    phase('badge-journey', 'open-the-overview-from-the-badge-and-choose-a-crystal-marker');
    const site = await JN.badgeSite();
    obs.badgeSite = site;
    record('5.1', 'the badge sits on the referenced block, on its own page, counting its ' +
      'incoming references',
      !!site && site.present && site.badge && site.count === String(CG.BADGE_INBOUND),
      () => `block rendered ${site && site.present}, badge ${site && site.badge}, counting ` +
        `${J(site && site.count)} source(s)`);
    await JN.toggleBadge();
    const ov = await JN.ovState();
    obs.overview = ov;
    record('5.2', 'the badge opens the compact overview with a row per source, each carrying ' +
      'its own source page, and no raw identifier leaks into the reading view',
      ov.present === true && ov.rows.length === CG.BADGE_INBOUND &&
      ov.rows.some((r) => (r.crumb || '').includes(CG.ANCHOR)) &&
      ov.rows.some((r) => (r.crumb || '').includes(CG.CYCLE_PAGE)) &&
      ov.rows.some((r) => (r.crumb || '').includes(CG.THIRD_PAGE)) &&
      !ov.leak.id && !ov.leak.uuid,
      () => ov.present
        ? `title ${J(ov.title)}, ${ov.rows.length} row(s) ` +
          `${J(ov.rows.map((r) => (r.crumb || '').slice(0, 32)))}, leak ${J(ov.leak)}`
        : `no overview${ov.error ? `: ${ov.error}` : ''}`);

    let crystal = null;
    if (ov.present && ov.crystal && ov.crystal.toggle) {
      await session.parkPointer();
      await page.locator('.f27-ref-overview .f27-crystal-config-toggle').first()
        .click({ timeout: 15000 }).catch(() => {});
      await sleep(1200);
      const opened = await JN.ovState();
      const coreIdx = (opened.crystal.options || []).findIndex((o) => o.includes('핵심'));
      if (coreIdx >= 0) {
        await session.parkPointer();
        await page.locator('.f27-ref-overview .f27-crystal-option').nth(coreIdx)
          .click({ timeout: 15000 }).catch(() => {});
        await sleep(1700);
      }
      crystal = (await JN.ovState()).crystal;
    }
    obs.crystal = crystal;
    record('5.3', "the Crystal marker offers the graph's own tags and previews beside the rows " +
      'that carry the chosen one, stating its scope',
      !!crystal && crystal.options.length >= 2 &&
      crystal.options.some((o) => o.includes('핵심')) &&
      crystal.chips.length >= 2 && crystal.scope === true,
      () => crystal ? `options ${J(crystal.options)}, chips ${J(crystal.chips)}, scope ` +
        `${crystal.scope}, toggle ${J(crystal.toggle)}` : 'the overview offered no Crystal control');

    const row0 = await JN.ensureRowCtx(0);
    obs.overviewRowContext = row0;
    record('5.4', "one overview row's own ancestors and children disclose in place",
      !!row0 && row0.ctxOpen === true &&
      Array.isArray(row0.ancestors) && Array.isArray(row0.children),
      () => row0 ? `${(row0.ancestors || []).length} ancestor line(s), ` +
        `${(row0.children || []).length} child line(s); first ancestor ` +
        `${J((row0.ancestors || [])[0])}` : 'no row context');
    if ((await JN.ovState()).present) await JN.toggleBadge(1500);

    // =====================================================================
    // The F28 disclosures: a source path and a child context
    // =====================================================================
    phase('disclosures', 'open-a-source-path-panel-and-a-child-context-panel');
    await session.goTo(CG.ANCHOR);
    await JN.settle('back on the anchor page');
    const d0 = await JN.disclosureState();
    const pathHolder = (d0.paths || []).find((p) => p.crumbId && p.toggleId);
    let pathAfter = null;
    if (pathHolder) {
      await session.parkPointer();
      await page.locator(`[id="${pathHolder.toggleId}"]`).first()
        .click({ timeout: 15000 }).catch(() => {});
      await sleep(1800);
      pathAfter = ((await JN.disclosureState()).paths || [])
        .find((p) => p.toggleId === pathHolder.toggleId) || null;
    }
    obs.sourcePath = { before: pathHolder, after: pathAfter };
    record('6.1', 'a group\'s SOURCE PATH discloses its steps under its own control, and the ' +
      'control says so',
      !!pathAfter && pathAfter.open === true && pathAfter.expanded === 'true' &&
      Array.isArray(pathAfter.steps) && pathAfter.steps.length > 0,
      () => pathAfter ? `aria-expanded ${J(pathAfter.expanded)}, ${(pathAfter.steps || []).length} ` +
        `step(s) ${J((pathAfter.steps || []).slice(0, 4))}` : 'no source-path control was found');

    const ctxRowId = Object.keys(d0.byId || {})
      .find((id) => d0.byId[id].control && d0.byId[id].controlId);
    let ctxAfter = null;
    if (ctxRowId) {
      await session.parkPointer();
      await page.locator(`[id="${d0.byId[ctxRowId].controlId}"]`).first()
        .click({ timeout: 15000 }).catch(() => {});
      await sleep(1800);
      ctxAfter = ((await JN.disclosureState()).byId || {})[ctxRowId] || null;
    }
    obs.childContext = { rowId: ctxRowId, before: ctxRowId ? d0.byId[ctxRowId] : null,
                         after: ctxAfter };
    record('6.2', "a row's CHILD CONTEXT discloses under its own control, and the panel it " +
      'names is the panel that appears',
      !!ctxAfter && ctxAfter.open === true && ctxAfter.expanded === 'true' &&
      !!ctxAfter.panelText,
      () => ctxAfter ? `aria-expanded ${J(ctxAfter.expanded)}, control ${J(ctxAfter.controlId)}, ` +
        `panel ${J(ctxAfter.panelId)}, text ${J((ctxAfter.panelText || '').slice(0, 90))}`
        : 'no child-context control was found');

    // =====================================================================
    // Ordering, with both panels still open
    // =====================================================================
    phase('ordering', 'choose-title-ascending-then-return-to-original');
    const asc = await JN.chooseOrder('title-asc');
    await JN.settle('in title-ascending order');
    const ascRead = await RD.read(page);
    obs.ordering = { chosen: asc, order: RD.orderOf(ascRead), expected: expectAsc };
    record('7.1', 'the ordering control really reorders the groups, into the order the ' +
      "fixture's own titles say",
      asc.changed === true && ascRead.present === true &&
      J(RD.orderOf(ascRead)) === J(expectAsc) && ascRead.wrapOrder === 'title-asc',
      () => `chosen ${asc.changed}${asc.error ? ` (${asc.error})` : ''}; list ` +
        `${J(ascRead.wrapOrder)}\n          got      ${J(RD.orderOf(ascRead))}\n          ` +
        `expected ${J(expectAsc)}`);
    const stillOpen = await JN.disclosureState();
    const ctxStill = ctxRowId ? (stillOpen.byId || {})[ctxRowId] : null;
    record('7.2', 'and the two panels this session opened are still open, on their own controls, ' +
      'after the groups moved under them',
      !!ctxStill && ctxStill.open === true &&
      ctxStill.controlId === (ctxAfter && ctxAfter.controlId),
      () => ctxStill ? `child-context open ${ctxStill.open}, same control ` +
        `${ctxStill.controlId === (ctxAfter && ctxAfter.controlId)}; ` +
        `${(stillOpen.paths || []).filter((p) => p.open).length} source-path panel(s) open`
        : 'the row could not be found after the reorder');
    await JN.chooseOrder('original');
    await JN.settle('back in OG\'s own order');

    // =====================================================================
    // Korean, and one keyboard interaction
    // =====================================================================
    phase('language', 'switch-the-interface-to-korean-and-back');
    const labelsEn = await JN.readLabels();
    const switched = await JN.setLanguage('ko');
    await sleep(3500);
    await JN.settle('in Korean');
    const labelsKo = await JN.readLabels();
    const koRead = await RD.read(page);
    obs.language = { english: labelsEn, korean: labelsKo, switched };
    record('8.1', "the interface language really changed, and every reference control's own " +
      'words follow it',
      switched.ok === true && !!labelsKo &&
      /[가-힣]/.test(labelsKo.orderLabel || '') &&
      labelsKo.orderOptions.length === 3 &&
      labelsKo.orderOptions.every((o) => /[가-힣]/.test(o)) &&
      /[가-힣]/.test(labelsKo.ctxOpen || '') && /[가-힣]/.test(labelsKo.pathToggle || ''),
      () => `switched ${switched.ok}${switched.ok ? '' : `: ${switched.reason}`}; order ` +
        `${J(labelsKo && labelsKo.orderLabel)} ${J(labelsKo && labelsKo.orderOptions)}; ` +
        `child context ${J(labelsKo && labelsKo.ctxOpen)}; source path ` +
        `${J(labelsKo && labelsKo.pathToggle)}`);
    record('8.2', "the graph's OWN Korean and its emoji still read correctly, and the language " +
      'did not reorder anything',
      koRead.present === true &&
      koRead.groups.some((x) => /[가-힣]/.test(x.title)) &&
      koRead.groups.every((x) => !/�/.test(x.title)) &&
      J([...RD.orderOf(koRead)].sort()) === J([...originalOrder].sort()),
      () => `${koRead.groups.filter((x) => /[가-힣]/.test(x.title)).length} Korean group title(s), ` +
        `0 replacement characters ${koRead.groups.every((x) => !/�/.test(x.title))}; ` +
        `group set unchanged ` +
        `${J([...RD.orderOf(koRead)].sort()) === J([...originalOrder].sort())}`);
    await JN.setLanguage('en');
    await sleep(3000);
    await JN.settle('back in English');

    phase('keyboard', 'operate-a-disclosure-from-the-keyboard-alone');
    const kbState = await JN.disclosureState();
    const kbRow = ctxRowId && (kbState.byId || {})[ctxRowId] ? ctxRowId
      : Object.keys(kbState.byId || {}).find((id) => kbState.byId[id].control);
    const kbControlId = kbRow ? kbState.byId[kbRow].controlId : null;
    const kbStartOpen = kbRow ? !!kbState.byId[kbRow].open : null;
    const focused = kbControlId ? await JN.focusControl(kbControlId) : { ok: false };
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(2400);
    const kbFirst = kbRow ? ((await JN.disclosureState()).byId || {})[kbRow] : null;
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(2400);
    const kbSecond = kbRow ? ((await JN.disclosureState()).byId || {})[kbRow] : null;
    obs.keyboard = { controlId: kbControlId, focused, startOpen: kbStartOpen,
                     first: kbFirst, second: kbSecond };
    record('9.1', 'Enter from the keyboard alone toggles the disclosure out of the state it was ' +
      'found in, and back again, on that row\'s own control',
      focused.ok === true && !!kbFirst && !!kbSecond &&
      kbFirst.open === !kbStartOpen && kbSecond.open === kbStartOpen &&
      kbFirst.controlId === kbControlId && kbSecond.controlId === kbControlId,
      () => `focused ${focused.ok}; ${kbStartOpen ? 'OPEN' : 'closed'} → ` +
        `${kbFirst && kbFirst.open ? 'OPEN' : 'closed'} → ` +
        `${kbSecond && kbSecond.open ? 'OPEN' : 'closed'}; aria-expanded ` +
        `${J(kbFirst && kbFirst.expanded)} then ${J(kbSecond && kbSecond.expanded)}; ` +
        `same control ${!!kbSecond && kbSecond.controlId === kbControlId}`);

    // =====================================================================
    // Source navigation, and the return
    // =====================================================================
    phase('re-entry', 'navigate-to-a-source-page-and-return');
    await session.goTo(CG.ALIAS);
    await JN.settle('on the alias page');
    const aliasRead = await RD.read(page);
    await session.goTo(CG.ANCHOR);
    await JN.settle('back on the anchor page');
    const afterReturn = await RD.read(page);
    const returnDiffs = IC.insideCompare(originalInside, IC.insideSetOf(afterReturn));
    const sameSet = J([...RD.orderOf(afterReturn)].sort()) === J([...originalOrder].sort());
    obs.reentry = { aliasPresent: aliasRead.present, sameSet, diffs: returnDiffs,
                    order: RD.orderOf(afterReturn) };
    record('10.1', 'navigating to a source page and back finds the list exactly as the session ' +
      'left it — group set identical, every container identical, within-container order exact',
      aliasRead.present === true && afterReturn.present === true &&
      sameSet && returnDiffs.length === 0,
      () => `alias page rendered ${aliasRead.present}; group set identical ${sameSet}; ` +
        `${returnDiffs.length} difference(s)` +
        `${returnDiffs.length ? ` — ${returnDiffs.join('; ')}` : ''}`);

    // =====================================================================
    // Read-only accounting, with the application still open
    // =====================================================================
    phase('read-only-accounting', 'hash-the-graph-with-the-application-still-open');
    const midway = GH.compare(before, GH.snapshot(GRAPH));
    record('11.1', 'the whole journey wrote nothing to the graph, with the plugins present and ' +
      'the application still open',
      midway.content.length === 0,
      midway.content.length ? J(midway.content.map((c) => `${c.change} ${c.file}`))
                            : `0 content changes across ${midway.afterCount} files`);

    // A second reading of the host, at the END of the journey: a plugin that
    // initialised late, or gave up late, is visible here and not before.
    const psEnd = await JN.pluginState();
    obs.pluginStateAtEnd = psEnd;
    record('11.2', "the plugin host's report at the END of the journey, after every reference " +
      'interaction — recorded so a late change cannot pass unnoticed',
      true,
      () => `registered ${J(psEnd.registered)}; ` +
        `${(psEnd.plugins || []).map((p) => `${p.key}=${J(p.status)}/loaded ${J(p.loaded)}`).join(', ')
          || 'none'}; injected UI nodes ${psEnd.injectedUiNodes}, sandbox iframes ` +
        `${psEnd.sandboxIframes}`);
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    const closed = await APP.close(session, { say });
    obs.close = { stage: closed.stage, stillAlive: closed.stillAlive };
  }

  // ---- after close -----------------------------------------------------
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  obs.graphChanges = { content: cmp.content, housekeeping: cmp.housekeeping.map((c) => `${c.change} ${c.file}`) };
  record('12.1', 'and nothing changed once the application had closed either',
    cmp.content.length === 0,
    cmp.content.length ? J(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files ` +
                         `(${cmp.housekeeping.length} housekeeping)`);

  const pluginsAfter = PA.snapshot(pluginsDir);
  const pluginChanges = PA.compareSnapshots(pluginsBefore, pluginsAfter);
  obs.pluginPackageChanges = pluginChanges;
  record('12.2', 'no plugin package rewrote itself, and nothing was downloaded into the ' +
    'plugins directory',
    pluginChanges.length === 0,
    pluginChanges.length ? J(pluginChanges) :
      `${Object.keys(pluginsAfter).length} plugin file(s), all byte-identical to the placed copies`);

  // What the profile gained: settings a plugin wrote for itself. Read so the
  // report can say a credential was never stored, rather than assume it.
  const settingsDir = path.join(stateRoot, 'home', '.logseq-og', 'settings');
  const settingsFiles = fs.existsSync(settingsDir)
    ? fs.readdirSync(settingsDir).filter((n) => n !== '.DS_Store') : [];
  const secretish = /(token|apikey|api_key|secret|password|accesstoken|bearer)"\s*:\s*"[^"]+"/i;
  const withSecrets = settingsFiles.filter((n) => {
    try { return secretish.test(fs.readFileSync(path.join(settingsDir, n), 'utf8')); }
    catch (e) { return false; }
  });
  obs.pluginSettings = { dir: settingsDir, files: settingsFiles, withNonEmptySecretField: withSecrets };
  record('12.3', 'the profile holds no plugin credential — every settings file a plugin wrote ' +
    'for itself carries an empty or absent secret',
    withSecrets.length === 0,
    settingsFiles.length ? `${J(settingsFiles)}; none carries a non-empty token/key field`
                         : 'no plugin settings file was written at all');

  // ---- error accounting -------------------------------------------------
  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  const split = NOISE.partition(cls.unexpected, errors.entries(), errorEvidence);
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(split.noise, 3)) say(`          pre-existing: ${line}`);
  for (const r of split.refused.slice(0, 5)) {
    say(`          REFUSED BY THE RULE: ${r.refusedBecause}\n            ${String(r.text).slice(0, 160)}`);
  }
  for (const line of EC.describe(split.remaining, 6)) say(`          UNEXPECTED: ${line}`);

  // Attribution, NOT exemption: a plugin-shaped error still counts as
  // unexplained. Naming it is how the report distinguishes "the plugin host
  // complained" from "a reference feature broke".
  const pluginShaped = (t) => /lsplugin|LSPlugin|\[Loader:|handshake|postMessage|plugin-sandbox|lsp:\/\//i.test(String(t));
  const remaining = split.remaining;
  const inFeature = remaining.filter((e) => FEATURE_PHASES.includes(e.phase));
  obs.errors = {
    captured: errors.entries().length,
    byPhase: cls.byPhase,
    expected: cls.expected.map((e) => ({ seq: e.seq, phase: e.phase, reason: e.reason, text: e.text })),
    browserNoise: split.noise.map((e) => ({ seq: e.seq, text: e.text })),
    refusedByRule: split.refused.map((e) => ({ seq: e.seq, text: e.text, refusedBecause: e.refusedBecause })),
    unexpected: remaining.map((e) => ({ seq: e.seq, phase: e.phase, text: e.text,
                                        pluginShaped: pluginShaped(e.text) })),
    unexpectedInFeaturePhases: inFeature.length,
    pluginShapedUnexpected: remaining.filter((e) => pluginShaped(e.text)).length,
    ruleAccounting: split.evidence,
  };
  record('13.1', 'no window error arrived in any phase that operated a reference feature',
    inFeature.length === 0,
    () => `${inFeature.length} in ${J(FEATURE_PHASES)}; ${remaining.length} unexplained in ` +
      `total, of which ${remaining.filter((e) => pluginShaped(e.text)).length} carry a plugin ` +
      `host signature` +
      (inFeature.length ? `: ${EC.describe(inFeature, 2).join(' | ')}` : ''));
  record('13.2', 'every window error is accounted for; ONLY the exact browser notice is ever ' +
    'exempted — a plugin error is attributed, never exempted, and a refused ' +
    '`[frontend.handler]` line FAILS this check',
    remaining.length === 0,
    () => `${errors.entries().length} captured across ${J(cls.byPhase)}; ${cls.expected.length} ` +
      `expected, ${split.noise.length} exempted browser notices, ${split.refused.length} handler ` +
      `line(s) refused by the rule, ${remaining.length} unexplained` +
      (remaining.length
        ? ` — ${remaining.filter((e) => pluginShaped(e.text)).length} plugin-shaped, ` +
          `${remaining.filter((e) => !pluginShaped(e.text)).length} not: ` +
          EC.describe(remaining, 2).join(' | ')
        : ''));

  const leftovers = ownedTree.filter(OP.alive);
  obs.ownedProcesses = { atLaunch: ownedTree.length, stillAlive: leftovers };
  record('13.3', 'every process this session owned has exited', leftovers.length === 0,
    leftovers.length ? J(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  sessions[cfg.key] = obs;
  return obs;
}

// ---------------------------------------------------------------------------

async function main() {
  // Before package resolution, profile swaps, seeding, graph access or launch.
  if (EXPERIMENT) NET.assertReady();
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const plan = only.length ? SESSIONS.filter((s) => only.includes(s.key)) : SESSIONS;
  if (!plan.length) throw new Error(`no such session: ${J(only)}`);

  say('\n=== Intel plugin coexistence — the reference bundle with the inventoried plugins ===\n');
  const record = makeRecorder('G');

  // ---------- G0 : the package ----------
  say('G0  the current package, identified before anything else');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('0.1', 'this build is present and passes its own identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}, ` +
           `dirty ${v.manifest.builtFrom.dirty ? 'true' : 'false'}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  batch.build = { app: built.appName, branch: v.manifest.builtFrom.branch,
                  commit: v.manifest.builtFrom.commit, dirty: v.manifest.builtFrom.dirty,
                  renderer: v.manifest.builtFrom.rendererRevision,
                  buildId: v.manifest.pilotBuildId };

  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  const carries = (p) => names.some((n) => n.startsWith(p));
  record('0.2', 'the packaged renderer carries every reference slice this batch exercises',
    carries('frontend.util.f28_refpath') && carries('frontend.util.f28_refctx') &&
    carries('frontend.util.f28_reforder'),
    `path ${carries('frontend.util.f28_refpath')}, ctx ${carries('frontend.util.f28_refctx')}, ` +
    `order ${carries('frontend.util.f28_reforder')}`);
  record('0.3', "and the plugin runtime the host needs is in the package, so a plugin's failure " +
    'to load could not be blamed on a missing asset',
    fs.existsSync(path.join(built.resApp, 'js', 'lsplugin.core.js')) &&
    fs.existsSync(path.join(built.resApp, 'js', 'lsplugin.user.js')),
    'js/lsplugin.core.js and js/lsplugin.user.js');

  // ---------- G1 : the artifacts ----------
  say('\nG1  the three inventoried packages, identified from the project\'s own record');
  const verdicts = PA.verifyAll();
  batch.artifacts = verdicts.map((x) => ({
    id: x.id, title: x.recorded.title, publisher: x.recorded.publisher,
    version: x.recorded.version, importance: x.recorded.importance,
    manifestId: x.recorded.manifestId, ok: x.ok, mismatches: x.mismatches,
    treeSha256: x.measured.treeSha256 || null, manifestSha256: x.measured.manifestSha256 || null,
    fileCount: x.measured.fileCount || null, totalBytes: x.measured.totalBytes || null,
  }));
  record('1.1', 'each identity comes from V5\'s inventory, not from a display name, and each ' +
    'retained package still hashes to what was recorded at install',
    verdicts.every((x) => x.ok),
    () => verdicts.map((x) => `${x.id} (${x.recorded.title}, ${x.recorded.publisher}) ` +
      `${x.recorded.version} ${x.ok ? 'MATCHES' : `MISMATCH [${x.mismatches.join('; ')}]`}`)
      .join('\n          '));
  record('1.2', 'the Readwise choice stays checkable: the two Marketplace cards V5 rejected are ' +
    'named, and the ChatGPT plugin\'s manifest id is kept apart from its Marketplace id',
    PA.BY_ID.get('logseq-readwise-official-plugin').rejectedCandidates.length === 2 &&
    PA.BY_ID.get('logseq-chatgpt-plugin').manifestId === '_rw1zys420',
    `rejected ${J(PA.BY_ID.get('logseq-readwise-official-plugin').rejectedCandidates)}; ` +
    `chatgpt marketplace id logseq-chatgpt-plugin, manifest logseq.id _rw1zys420`);
  record('1.3', 'the source is the project\'s own retained public artifacts; nothing is ' +
    'downloaded and no Marketplace call is made in this batch',
    PA.SOURCE_ROOT.includes(path.join('generated', 'og-baseline')),
    PA.SOURCE_ROOT);

  // ---------- G2 : a fresh profile ----------
  say('\nG2  a fresh isolated profile, and the shared one preserved');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  batch.stamp = stamp;
  const handle = FP.swapAside(ID, { stamp });
  // Nothing may run between the swap and the `try` that restores it: from this
  // line on, the shared profile is in this batch's hands.
  let restoreReport = null;
  try {
    batch.profile = { root: handle.root, preserved: handle.preserved,
                      preExisting: handle.preExisting,
                      preservedMarkerCreatedAt: handle.marker ? handle.marker.createdAt : null };
    record('2.1', 'the shared state root was moved aside under this build\'s OWN ownership ' +
      'marker — never deleted, never merged — so no plugin survives into a later F28 run',
      !handle.preExisting || (!!handle.preserved && !fs.existsSync(handle.root)),
      handle.preExisting
        ? `${handle.root}\n          preserved at ${handle.preserved} ` +
          `(marker created ${handle.marker.createdAt})`
        : 'no shared state root existed; the first launch creates a fresh one');

    // The application creates and marks its own fresh root; the harness never
    // does, because `pilot-isolation`'s ownership rule is one of the guards
    // this batch is not allowed to weaken.
    const seed = await seedProfile(built, handle.root);
    batch.seed = seed;
    record('2.2', 'the fresh state root is created and MARKED by the application itself in a ' +
      'short seeding launch — the harness never writes an ownership marker',
      seed.marked === true && seed.stillAlive.length === 0,
      `marker written ${seed.marked} at ${path.join(handle.root, ID.OWNERSHIP_MARKER)}; ` +
      `${seed.owned} process(es) owned, ${seed.stillAlive.length} still alive`);
    if (!seed.marked) throw new Error('the seeding launch did not establish an owned state root');

    for (const cfg of plan) {
      try {
        await runSession(cfg, built, stamp);
      } catch (e) {
        say(`\n  !! session ${cfg.key} did not complete: ${String(e && e.message)}`);
        results.push({ id: `${cfg.key.toUpperCase()}.X`, ok: false,
                       title: 'the session ran to completion',
                       detail: String((e && e.stack) || e).slice(0, 600) });
        sessions[cfg.key] = Object.assign(sessions[cfg.key] || { key: cfg.key },
          { failed: String(e && e.message) });
      }
      // Between sessions: take the plugins, any plugin-written settings and the
      // host's own user preferences out again, so the next session starts from
      // the same place. All three are READ INTO THE EVIDENCE first — nothing is
      // discarded unrecorded — and all three live inside this batch's own fresh
      // profile, which is put back at the end.
      const dot = path.join(handle.root, 'home', '.logseq-og');
      const pluginsDir = FP.pluginsDirIn(handle.root);
      const settingsDir = path.join(dot, 'settings');
      const prefsFile = path.join(dot, 'preferences.json');
      const carried = { settings: {}, preferences: null };
      if (fs.existsSync(settingsDir)) {
        for (const n of fs.readdirSync(settingsDir).filter((x) => x !== '.DS_Store')) {
          try { carried.settings[n] = fs.readFileSync(path.join(settingsDir, n), 'utf8').slice(0, 4000); }
          catch (e) { carried.settings[n] = `(unreadable: ${e.code || e.message})`; }
        }
      }
      if (fs.existsSync(prefsFile)) {
        try { carried.preferences = fs.readFileSync(prefsFile, 'utf8').slice(0, 4000); }
        catch (e) { carried.preferences = `(unreadable: ${e.code || e.message})`; }
      }
      if (sessions[cfg.key]) sessions[cfg.key].profileStateLeftBehind = carried;
      for (const dir of [pluginsDir, settingsDir]) {
        if (!fs.existsSync(dir)) continue;
        fs.renameSync(dir, dir + '.preserved-' + stamp + '-' + cfg.key);
      }
      if (fs.existsSync(prefsFile)) fs.renameSync(prefsFile, prefsFile + '.preserved-' + stamp + '-' + cfg.key);
    }
  } finally {
    restoreReport = FP.restore(handle, { label: 'plugin-coexistence' });
    batch.profileRestore = restoreReport;
  }

  say('\nG3  the profile, put back');
  const rec3 = makeRecorder('G');
  rec3('3.1', 'this run\'s fresh profile is kept under its own name, and the shared profile is ' +
    'back at its own path carrying the very marker that was taken',
    restoreReport.ok,
    `kept ${J(restoreReport.kept)}; restored ${restoreReport.restored}; marker ` +
    `${J(restoreReport.markerCreatedAt)}` +
    (restoreReport.notes.length ? `\n          notes: ${restoreReport.notes.join(' | ')}` : ''));

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `${EVIDENCE_PREFIX}-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, batch, sessions }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    say(`\nFATAL: ${String((e && e.stack) || e)}`);
    process.exitCode = 1;
  });
}

module.exports = { SESSIONS, FEATURE_PHASES };
