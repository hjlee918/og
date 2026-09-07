#!/usr/bin/env node
'use strict';
//
// Focused checks for the preview launcher's lifecycle and for the demonstration
// graph generator's refusal/preservation rules.
//
// These use small doubles — a fake application handle, a fake launch, a fake
// digest — and temporary synthetic directories. Nothing here starts Electron,
// opens a graph or waits on a real timeout, so the whole file runs in seconds.
// The one thing doubles cannot establish is that a real launch works; that is
// what the normal user command and --self-check are for.
//
//   node f27-preview/lifecycle-check.js
//
const path = require('path');
const fs = require('fs');
const os = require('os');

const preview = require('./preview.js');
const gen = require('./make-preview-graph.js');
const integrated = require('./make-integrated-graph.js');
const identity = require('./build-identity.js');

let pass = 0;
let fail = 0;
const check = (id, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
};

// A monotonic counter, so "did the digest happen after the close" is a fact
// rather than a guess about timing.
let seq = 0;
const tick = () => new Promise((r) => setTimeout(r, 1));

function fakeApp(opts = {}) {
  const rec = { closeCalls: 0, closedAt: null, kills: [], events: {} };
  const child = {
    pid: 999999,
    killed: false,
    kill(sig) {
      rec.kills.push(sig);
      this.killed = true;
    },
  };
  return {
    rec,
    on(ev, fn) {
      (rec.events[ev] = rec.events[ev] || []).push(fn);
    },
    async close() {
      rec.closeCalls++;
      await tick();
      if (opts.closeFails) throw new Error('the double refused to close');
      if (opts.closeHangs) await new Promise(() => {});
      rec.closedAt = ++seq;
    },
    process() {
      return child;
    },
  };
}

// Everything the launcher needs, with nothing real behind it.
function baseDeps(over = {}) {
  const logs = [];
  const rec = { digestCalls: [] };
  const app = over.app || fakeApp();
  const deps = Object.assign(
    {
      log: (s) => logs.push(String(s)),
      checkBuild: () => ({ ok: true, revision: {} }),
      ensureGraph: () => '/double/graph',
      demo: { key: 'double', title: 'a stand-in demonstration graph', generator: () => ({}), scenario: () => async () => {} },
      freshProfile: () => 'double-profile',
      launch: async (profile, opts) => {
        if (opts && typeof opts.onApp === 'function') opts.onApp(app);
        await tick();
        return { app, page: {}, profileDir: '/double/profile' };
      },
      openGraph: async () => ({ ok: true, current: { path: '/double/graph' } }),
      markWindow: async () => {},
      walkthrough: async (page, out) => {
        out.checks.push({ id: 'double', result: 'PASS', detail: 'stand-in walkthrough' });
      },
      digest: () => {
        rec.digestCalls.push(++seq);
        return 'digest-value';
      },
      writeResult: false,
      settleMs: 5,
      closeTimeoutMs: 60,
      sessionLimitMs: 60000,
      warnMs: 59000,
    },
    over
  );
  return { deps, logs, rec, app };
}
const said = (logs, re) => logs.some((l) => re.test(l));

// ---------------------------------------------------------------------------
async function lifecycleChecks() {
  console.log('Lifecycle (doubles)');

  // 1. A failure AFTER the launch must still close the application.
  {
    const { deps, logs, app } = baseDeps({
      openGraph: async () => {
        throw new Error('double: setup blew up after launch');
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'setup-failure-after-launch-still-closes-the-application',
      app.rec.closeCalls === 1 && out.closed_gracefully === true,
      `close called ${app.rec.closeCalls}x, closed=${out.closed_gracefully}`
    );
    check(
      'setup-failure-preserves-the-original-error-and-exits-non-zero',
      out.exit_code === 1 && /double: setup blew up/.test(String(out.error)) && said(logs, /double: setup blew up/),
      `exit=${out.exit_code}, error=${JSON.stringify(out.error)}`
    );
  }

  // 2. A graph that is not the demonstration graph is refused, and the
  //    application is closed rather than left open on the wrong notes.
  {
    const { deps, logs, app } = baseDeps({
      openGraph: async () => ({ ok: false, why: 'double: reports some other path', current: null }),
    });
    const out = await preview.runPreview(deps);
    check(
      'a-graph-mismatch-refuses-closes-and-offers-manual-instructions',
      out.exit_code === 1 && app.rec.closeCalls === 1 && said(logs, /Open the demonstration graph by hand/),
      `exit=${out.exit_code}, close called ${app.rec.closeCalls}x`
    );
  }

  // 3. Cancellation DURING the launch — before READY — is owned, and the
  //    partially launched application is adopted through onApp and closed.
  {
    const app = fakeApp();
    let ctl = null;
    const { deps } = baseDeps({
      app,
      launch: async (profile, opts) => {
        opts.onApp(app); // handed over first, as the guarded launcher does
        await new Promise((r) => setTimeout(r, 120)); // still starting up
        return { app, page: {}, profileDir: '/double/profile' };
      },
      onStarted: (c) => {
        ctl = c;
        setTimeout(() => c.requestStop('double: cancelled during startup'), 10);
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'early-cancellation-closes-a-partly-launched-application',
      app.rec.closeCalls === 1 && out.closed_gracefully === true && out.ready === false,
      `close called ${app.rec.closeCalls}x, ready=${out.ready}, reason=${JSON.stringify(out.stop_reason)}`
    );
    check(
      'a-deliberate-stop-is-not-reported-as-a-failure',
      out.exit_code === 0 && /cancelled during startup/.test(String(out.stop_reason)) && !!ctl,
      `exit=${out.exit_code}`
    );
  }

  // 4. The deadline covers setup, not just the wait after READY.
  {
    const app = fakeApp();
    const { deps } = baseDeps({
      app,
      sessionLimitMs: 40,
      warnMs: 20,
      launch: async (profile, opts) => {
        opts.onApp(app);
        await new Promise((r) => setTimeout(r, 200));
        return { app, page: {}, profileDir: '/double/profile' };
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'the-session-deadline-applies-during-startup-too',
      /session limit was reached/.test(String(out.stop_reason)) && app.rec.closeCalls === 1,
      `reason=${JSON.stringify(out.stop_reason)}, close called ${app.rec.closeCalls}x`
    );
  }

  // 5. The deadline also applies to --self-check, which used to have neither
  //    signal handling nor a deadline.
  {
    const app = fakeApp();
    const { deps } = baseDeps({
      app,
      selfCheck: true,
      sessionLimitMs: 40,
      warnMs: 20,
      walkthrough: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'the-deadline-and-cleanup-cover-self-check-as-well',
      /session limit was reached/.test(String(out.stop_reason)) && app.rec.closeCalls === 1 && out.exit_code === 1,
      `reason=${JSON.stringify(out.stop_reason)}, close called ${app.rec.closeCalls}x, exit=${out.exit_code}`
    );
  }

  // 6. A close that fails is reported as a failure, only this launcher's own
  //    child is signalled, and no preservation claim is made from it.
  {
    const app = fakeApp({ closeFails: true });
    const { deps, logs } = baseDeps({ app, selfCheck: true });
    const out = await preview.runPreview(deps);
    check(
      'a-failed-close-is-reported-honestly-and-fails-the-run',
      out.closed_gracefully === false && out.exit_code === 1 && said(logs, /DID NOT close cleanly/),
      `closed=${out.closed_gracefully}, exit=${out.exit_code}`
    );
    check(
      'a-failed-close-signals-only-the-child-this-launcher-started',
      app.rec.kills.length === 1 && app.rec.kills[0] === 'SIGTERM' && out.signalled === true,
      `signals sent = ${JSON.stringify(app.rec.kills)}`
    );
    check(
      'a-failed-close-makes-no-final-preservation-claim',
      out.graph_unchanged === null && said(logs, /NOT a claim that nothing was written/),
      `graph_unchanged=${JSON.stringify(out.graph_unchanged)}`
    );
  }

  // 7. A close that hangs is bounded by the close timeout rather than waiting
  //    for ever.
  {
    const app = fakeApp({ closeHangs: true });
    const { deps, logs } = baseDeps({
      app,
      closeTimeoutMs: 40,
      openGraph: async () => {
        throw new Error('double: stop here');
      },
    });
    const started = Date.now();
    const out = await preview.runPreview(deps);
    const took = Date.now() - started;
    check(
      'a-hanging-close-is-bounded-and-reported',
      out.closed_gracefully === false && took < 3000 && said(logs, /did not close within/),
      `closed=${out.closed_gracefully} after ${took}ms`
    );
  }

  // 8. Ordering: the final digest is taken AFTER the close, not before it.
  {
    const app = fakeApp();
    const { deps, rec } = baseDeps({ app, selfCheck: true, settleMs: 5 });
    const out = await preview.runPreview(deps);
    const [baselineAt, finalAt] = rec.digestCalls;
    check(
      'the-final-byte-check-happens-after-the-application-closed',
      rec.digestCalls.length === 2 && app.rec.closedAt > baselineAt && finalAt > app.rec.closedAt,
      `baseline@${baselineAt} < close@${app.rec.closedAt} < final@${finalAt}`
    );
    check(
      'a-clean-close-does-support-a-preservation-statement',
      out.graph_unchanged === true && out.exit_code === 0,
      `graph_unchanged=${out.graph_unchanged}, exit=${out.exit_code}`
    );
  }

  // 9. The same ordering on the ordinary interactive path, ended by a stop
  //    request the way Enter or Ctrl-C ends it.
  {
    const app = fakeApp();
    let ctl = null;
    const { deps, rec, logs } = baseDeps({
      app,
      onStarted: (c) => {
        ctl = c;
      },
      markWindow: async () => {
        setTimeout(() => ctl.requestStop('you pressed Enter'), 10);
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'the-interactive-path-closes-then-checks-bytes-then-reports',
      out.ready === true &&
        out.closed_gracefully === true &&
        rec.digestCalls[1] > app.rec.closedAt &&
        out.exit_code === 0,
      `ready=${out.ready}, close@${app.rec.closedAt}, final digest@${rec.digestCalls[1]}, exit=${out.exit_code}`
    );
    check(
      'the-ready-notice-does-not-claim-the-installed-app-is-managed',
      said(logs, /does not start, stop or change it/) &&
        said(logs, /editor is/) &&
        !said(logs, /Logseq OG is a different application and is not involved/),
      'READY text describes the installed app and the editor accurately'
    );
  }

  // 10. Cleanup is idempotent: a second call closes nothing a second time.
  {
    const app = fakeApp();
    const lc = preview.createLifecycle(Object.assign({}, preview.DEFAULTS, { log: () => {} }));
    lc.adopt(app);
    const a = await lc.cleanup();
    const b = await lc.cleanup();
    check(
      'cleanup-is-idempotent',
      app.rec.closeCalls === 1 && a === b && a.closed === true,
      `close called ${app.rec.closeCalls}x across two cleanup() calls`
    );
  }

  // 11. Nothing to close is not an error.
  {
    const { deps, logs } = baseDeps({
      checkBuild: () => {
        throw new preview.PreviewError('double: an artifact is missing', 'rebuild it');
      },
    });
    const out = await preview.runPreview(deps);
    check(
      'a-refusal-before-launch-exits-cleanly-with-nothing-to-close',
      out.exit_code === 1 && out.close_attempted === false && said(logs, /nothing had been launched/),
      `exit=${out.exit_code}, close_attempted=${out.close_attempted}`
    );
  }
}

// ---------------------------------------------------------------------------
function tmpRoot(name) {
  // Under the real temporary directory, so a resolved path equals its literal
  // path and the symlink check below tests what it claims to test.
  const base = fs.realpathSync(os.tmpdir());
  return fs.mkdtempSync(path.join(base, 'f27-preview-check-' + name + '-'));
}

function generatorChecks() {
  console.log('Demonstration graph generator (temporary synthetic directories)');
  const made = [];

  // 1. Creating into an empty preview directory works and leaves ownership proof.
  {
    const root = tmpRoot('create');
    made.push(root);
    const r = gen.build({ root });
    const L = gen.layout(root);
    const marker = fs.existsSync(path.join(L.graph, gen.MARKER));
    const signed = fs.readFileSync(path.join(L.graph, 'logseq/config.edn'), 'utf8').includes(gen.SIGNATURE);
    check(
      'create-writes-nine-pages-with-ownership-proof',
      r.files.length === gen.EXPECTED_PAGES && marker && signed && r.archived === null,
      `${r.files.length} pages, marker=${marker}, signature=${signed}`
    );
  }

  // 2. An existing complete graph is never overwritten without --reset.
  {
    const root = tmpRoot('exists');
    made.push(root);
    gen.build({ root });
    const L = gen.layout(root);
    const edited = path.join(L.graph, 'pages/Deep Work.md');
    fs.writeFileSync(edited, '- I edited this on purpose\n', 'utf8');
    let refused = null;
    try {
      gen.build({ root });
    } catch (e) {
      refused = e;
    }
    check(
      'create-refuses-an-existing-graph-and-leaves-the-edit-alone',
      refused && refused.code === 'EXISTS' && fs.readFileSync(edited, 'utf8').includes('I edited this on purpose'),
      refused ? `refused with ${refused.code}; the edit survived` : 'IT DID NOT REFUSE'
    );
  }

  // 3. An INCOMPLETE owned graph — the case the ordinary launcher used to
  //    silently delete, because config.edn was missing.
  {
    const root = tmpRoot('incomplete');
    made.push(root);
    gen.build({ root });
    const L = gen.layout(root);
    const edited = path.join(L.graph, 'pages/Weekly Review.md');
    fs.writeFileSync(edited, '- my own weekly notes\n', 'utf8');
    fs.rmSync(path.join(L.graph, 'logseq/config.edn')); // exactly the trigger
    const state = gen.inspect(root);
    let refused = null;
    try {
      gen.build({ root });
    } catch (e) {
      refused = e;
    }
    check(
      'an-incomplete-graph-is-recognised-not-rebuilt-over',
      state.status === 'owned-incomplete' && refused && refused.code === 'EXISTS',
      `status=${state.status}, refusal=${refused && refused.code}`
    );
    check(
      'an-incomplete-graphs-notes-are-still-there-afterwards',
      fs.readFileSync(edited, 'utf8').includes('my own weekly notes'),
      'the edited page was not deleted'
    );
  }

  // 4. --reset archives rather than deletes, and the archive keeps the edit.
  {
    const root = tmpRoot('reset');
    made.push(root);
    gen.build({ root });
    const L = gen.layout(root);
    fs.writeFileSync(path.join(L.graph, 'pages/Routine.md'), '- edited before the reset\n', 'utf8');
    const r = gen.build({ root, reset: true });
    const archivedFile = r.archived && path.join(r.archived, 'pages/Routine.md');
    const kept = archivedFile && fs.readFileSync(archivedFile, 'utf8').includes('edited before the reset');
    const fresh = fs.readFileSync(path.join(L.graph, 'pages/Routine.md'), 'utf8').includes('The routine is whatever');
    check(
      'reset-archives-the-old-notes-and-builds-a-fresh-graph',
      !!r.archived && kept && fresh && r.files.length === gen.EXPECTED_PAGES,
      r.archived ? `archived to ${path.basename(r.archived)}; the edit is in the archive` : 'NOTHING WAS ARCHIVED'
    );
  }

  // 5. A directory that is not ours is never moved or deleted, reset or not.
  {
    const root = tmpRoot('foreign');
    made.push(root);
    const L = gen.layout(root);
    fs.mkdirSync(path.join(L.graph, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(L.graph, 'pages/Private.md'), '- someone elses notes\n', 'utf8');
    const state = gen.inspect(root);
    let plain = null;
    let withReset = null;
    try {
      gen.build({ root });
    } catch (e) {
      plain = e;
    }
    try {
      gen.build({ root, reset: true });
    } catch (e) {
      withReset = e;
    }
    check(
      'an-unrecognised-directory-is-refused-even-with-reset',
      state.status === 'foreign' &&
        plain &&
        withReset &&
        withReset.code === 'FOREIGN' &&
        fs.existsSync(path.join(L.graph, 'pages/Private.md')),
      `status=${state.status}, reset refusal=${withReset && withReset.code}; the file is still there`
    );
  }

  // 6. A symlinked graph path is refused before any write or move.
  {
    const root = tmpRoot('symlink');
    made.push(root);
    const L = gen.layout(root);
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep.md'), '- outside the preview root\n', 'utf8');
    fs.mkdirSync(L.graphRoot, { recursive: true });
    fs.symlinkSync(elsewhere, L.graph);
    let refused = null;
    try {
      gen.build({ root, reset: true });
    } catch (e) {
      refused = e;
    }
    check(
      'a-symlinked-graph-path-is-refused-and-its-target-untouched',
      refused && refused.code === 'SYMLINK' && fs.existsSync(path.join(elsewhere, 'keep.md')),
      refused ? `refused with ${refused.code}` : 'IT DID NOT REFUSE'
    );
  }

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
}


// ---------------------------------------------------------------------------
function integratedGeneratorChecks() {
  console.log('Integrated demonstration graph (temporary synthetic directories)');
  const made = [];

  // 1. It writes the whole demonstration: notes AND the files they point at.
  {
    const root = tmpRoot('integrated');
    made.push(root);
    const r = integrated.build({ root });
    const L = integrated.layout(root);
    const marker = fs.existsSync(path.join(L.graph, integrated.MARKER));
    const signed = fs.readFileSync(path.join(L.graph, 'logseq/config.edn'), 'utf8').includes(integrated.SIGNATURE);
    const state = integrated.inspect(root);
    check(
      'the-integrated-graph-writes-its-notes-its-files-and-its-ownership-proof',
      r.files.length === integrated.EXPECTED_PAGES &&
        r.assets.length === integrated.EXPECTED_ASSETS &&
        marker && signed && state.status === 'owned-complete',
      `${r.files.length} pages, ${r.assets.length} files, marker=${marker}, signature=${signed}, status=${state.status}`
    );

    // The file a note points at but which is deliberately not there, and the
    // sentinel that sits where a path climbing out of the graph would land.
    const gone = fs.existsSync(path.join(L.graph, 'assets', integrated.GONE));
    const sentinel = fs.existsSync(path.join(L.graphRoot, integrated.SENTINEL));
    check(
      'the-missing-file-is-really-missing-and-the-containment-sentinel-is-really-there',
      !gone && sentinel,
      `${integrated.GONE} on disk = ${gone} (a note points at it); ` +
        `${integrated.SENTINEL} one level above the graph = ${sentinel}`
    );

    // Nine blocks refer to the one block the panel opens from.
    const refs = fs
      .readdirSync(path.join(L.graph, 'pages'))
      .filter((f) => f.endsWith('.md'))
      .filter((f) => fs.readFileSync(path.join(L.graph, 'pages', f), 'utf8').includes(`((${integrated.TARGET}))`));
    check(
      'nine-notes-refer-to-the-block-the-panel-opens-from',
      refs.length === 9,
      `${refs.length} page(s) reference the target block: ${JSON.stringify(refs.sort())}`
    );
  }

  // 2. The same refusal, archive and foreign rules as the user graph — they
  //    are literally the same code, and this proves the wiring.
  {
    const root = tmpRoot('integrated-reset');
    made.push(root);
    integrated.build({ root });
    const L = integrated.layout(root);
    const edited = path.join(L.graph, 'pages/Study Plan.md');
    fs.writeFileSync(edited, '- edited before the reset\n', 'utf8');
    let refused = null;
    try {
      integrated.build({ root });
    } catch (e) {
      refused = e;
    }
    const r = integrated.build({ root, reset: true });
    const kept = r.archived && fs.readFileSync(path.join(r.archived, 'pages/Study Plan.md'), 'utf8');
    check(
      'the-integrated-graph-refuses-to-be-overwritten-and-archives-on-reset',
      refused && refused.code === 'EXISTS' && !!r.archived && /edited before the reset/.test(kept || ''),
      `refusal = ${refused && refused.code}; archived to ${r.archived && path.basename(r.archived)}; the edit is in the archive`
    );
  }

  // 3. THE POINT OF THIS BATCH: preparing the new demonstration graph does not
  //    touch the old one. Both live under one preview root here, exactly as
  //    they do on disk.
  {
    const root = tmpRoot('both');
    made.push(root);
    gen.build({ root });
    const U = gen.layout(root);
    const mine = path.join(U.graph, 'pages/Deep Work.md');
    fs.writeFileSync(mine, '- notes I typed into the OLD demonstration graph\n', 'utf8');
    const beforeList = fs.readdirSync(path.join(U.graph, 'pages')).sort();

    integrated.build({ root });
    integrated.build({ root, reset: true }); // the most destructive thing it does

    const afterList = fs.readdirSync(path.join(U.graph, 'pages')).sort();
    const survived = fs.readFileSync(mine, 'utf8');
    check(
      'building-and-resetting-the-new-graph-leaves-the-old-one-untouched',
      /notes I typed into the OLD/.test(survived) && JSON.stringify(beforeList) === JSON.stringify(afterList),
      `the old graph still has ${afterList.length} page(s) and the edited note is unchanged`
    );

    // And each generator only ever recognises its OWN directory.
    const crossed = integrated.inspect(root).graph !== gen.inspect(root).graph;
    check(
      'the-two-demonstration-graphs-are-separate-directories',
      crossed,
      `${path.basename(gen.inspect(root).graph)} and ${path.basename(integrated.inspect(root).graph)}`
    );
  }

  // 4. An asset name is a plain file name, never a path.
  {
    const root = tmpRoot('assetname');
    made.push(root);
    let refused = null;
    try {
      const s = require('./graph-store.js').createStore({
        dirName: 'name-check',
        marker: '.name-check',
        signature: ';; name check',
        markerText: 'check\n',
        config: ';; name check\n{}\n',
        expectedPages: 0,
        expectedAssets: 1,
        write: ({ writeAsset }) => writeAsset('../escape.png', Buffer.from('x')),
      });
      s.build({ root });
    } catch (e) {
      refused = e;
    }
    check(
      'an-asset-name-that-is-a-path-is-refused',
      refused && refused.code === 'NAME' && !fs.existsSync(path.join(root, 'graph/escape.png')),
      refused ? `refused with ${refused.code}` : 'IT DID NOT REFUSE'
    );
  }

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A stand-in checkout: four artifacts, one source file, and a git that says
// whatever the case under test needs it to say. Shared by the verdict checks
// and by the "a refused verdict launches nothing" checks below, so both drive
// the REAL module rather than a description of it.
function identityScene(over = {}) {
    const times = Object.assign(
      { renderer: 2000, electron: 2000, css: 2000, electronBin: 1000, source: 1000 },
      over.times
    );
    const files = {
      '/r/static/js/main.js': { size: 100, mtimeMs: times.renderer, dir: false },
      '/r/static/electron.js': { size: 10, mtimeMs: times.electron, dir: false },
      '/r/static/css/style.css': { size: 10, mtimeMs: times.css, dir: false },
      '/r/static/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron': {
        size: 10, mtimeMs: times.electronBin, dir: false },
      '/r/src/main': { dir: true, entries: ['a.cljs'] },
      '/r/src/main/a.cljs': { size: 1, mtimeMs: times.source, dir: false },
    };
    for (const gone of over.missing || []) delete files[gone];
    const head =
      'var CLOSURE_DEFINES = {"frontend.config.REVISION":"' +
      (over.builtRevision === undefined ? 'abc123' : over.builtRevision) +
      '","goog.ENABLE_DEBUG_LOADER":false};';
    const fsDouble = {
      statSync(p) {
        const f = files[p];
        if (!f) throw new Error('ENOENT ' + p);
        return { size: f.size || 0, mtimeMs: f.mtimeMs || 0, isDirectory: () => !!f.dir };
      },
      readdirSync(p) {
        const f = files[p];
        if (!f || !f.dir) throw new Error('ENOTDIR ' + p);
        return f.entries;
      },
      openSync: () => 7,
      closeSync: () => {},
      readSync(fd, buf) {
        return buf.write(head, 0, 'utf8');
      },
    };
    const git = (args) => {
      if (over.gitDead) throw new Error('git: command not found');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc1230000000000000000000000000000000000';
      if (args[0] === 'describe') return over.checkoutRevision === undefined ? 'abc123' : over.checkoutRevision;
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (over.unknownCommit) throw new Error('fatal: needed a single revision');
        return 'a-commit';
      }
      if (args[0] === 'diff') {
        // `git diff --quiet` exits non-zero when there IS a difference.
        if (over.buildInputsDiffer) throw new Error('exit 1');
        return '';
      }
      if (args[0] === 'ls-files') {
        if (over.lsFilesFails) throw new Error('ls-files could not run');
        return (args.includes('--ignored') ? over.ignored || [] : over.untracked || []).join('\n');
      }
      if (args[0] === 'rev-parse') return 'a-branch';
      return 'a subject';
    };
    return identity.inspect('/r', { fs: fsDouble, git, inputs: ['src/main'] });
}

function buildIdentityChecks() {
  console.log('Build identity — what may launch, and what is refused (doubles)');
  const scene = identityScene;

  // --- the three states the supervisor reproduced, which used to LAUNCH -----
  {
    const r = scene({ builtRevision: '' });
    check(
      'a-renderer-that-states-no-revision-is-refused-not-warned-about',
      r.ok === false && r.identity === 'unverified' && /cannot be named/.test(r.reason) && /git stash/.test(r.advice),
      `ok=${r.ok}, identity=${r.identity}; ${JSON.stringify(r.refusals)}`
    );
  }
  {
    const r = scene({ builtRevision: 'abc123-dirty', checkoutRevision: 'abc123-dirty' });
    check(
      'a-renderer-built-from-an-uncommitted-tree-is-refused-even-when-the-strings-match',
      r.ok === false && r.identity === 'unverified' && /UNCOMMITTED/.test(r.reason),
      `ok=${r.ok}, identity=${r.identity}; ${JSON.stringify(r.refusals)}`
    );
  }
  {
    const r = scene({ gitDead: true });
    check(
      'a-checkout-whose-revision-cannot-be-read-is-refused',
      r.ok === false && r.identity === 'unverified' && /nothing to identify the build against/.test(r.reason),
      `ok=${r.ok}, identity=${r.identity}; ${JSON.stringify(r.refusals)}`
    );
  }

  // --- the dirty suffix is never stripped and then treated as proof ---------
  {
    // The build was dirty at a commit whose COMMITTED tree matches perfectly.
    // The old gate stripped `-dirty`, compared the commits, and passed.
    const r = scene({ builtRevision: 'abc123-dirty', checkoutRevision: 'abc123' });
    check(
      'a-dirty-built-revision-is-not-rescued-by-comparing-its-commit',
      r.ok === false && r.identity === 'unverified' && /never recorded/.test(r.reason),
      `ok=${r.ok}; ${JSON.stringify(r.refusals)}`
    );
  }

  // --- what a git comparison cannot see ------------------------------------
  {
    const r = scene({ untracked: ['src/main/frontend/sneaky.cljs'] });
    check(
      'an-untracked-file-under-the-build-inputs-is-refused-because-no-diff-can-see-it',
      r.ok === false && r.identity === 'unverified' && /sneaky\.cljs/.test(r.reason),
      `ok=${r.ok}; ${JSON.stringify(r.refusals)}`
    );
  }
  {
    const r = scene({ lsFilesFails: true });
    check(
      'an-audit-that-could-not-run-is-refused-rather-than-assumed-empty',
      r.ok === false && r.identity === 'unverified' && /untracked files/.test(r.reason),
      `ok=${r.ok}; ${JSON.stringify(r.refusals)}`
    );
  }
  {
    // A GENERATED file that git ignores cannot be compared by content. This
    // repository really has one, so it is named as a limit rather than refused.
    const r = scene({ ignored: ['src/main/frontend/tldraw-logseq.js'] });
    check(
      'a-generated-ignored-build-input-is-named-as-a-limit-rather-than-refused',
      r.ok === true && r.warnings.some((w) => /ignored by git and cannot be compared/.test(w)),
      `ok=${r.ok}; ${JSON.stringify(r.warnings)}`
    );
  }
  {
    const r = scene({ missing: ['/r/src/main'] });
    check(
      'a-declared-build-input-that-cannot-be-read-is-refused-rather-than-skipped',
      r.ok === false && r.identity === 'unverified' && /never compared/.test(r.reason),
      `ok=${r.ok}; ${JSON.stringify(r.refusals)}`
    );
  }

  // --- what may launch ------------------------------------------------------
  {
    const r = scene();
    check(
      'an-exact-identity-launches',
      r.ok === true && r.identity === 'exact' && r.revision.provable === true && r.refusals.length === 0,
      `identity=${r.identity}, built=${r.revision.built}, checkout=${r.revision.checkout}`
    );
  }
  {
    // The tooling in this repository sits beside the application, so a commit
    // that touched only the tooling is comparable and allowed — but only
    // because the BUILT revision is clean and the comparison reads the files
    // on disk.
    const r = scene({ builtRevision: 'old999' });
    check(
      'a-clean-commit-that-changed-nothing-the-build-reads-is-equivalent-and-launches',
      r.ok === true && r.identity === 'equivalent' &&
        r.warnings.some((w) => /nothing the build reads differs/.test(w)),
      `identity=${r.identity}; ${JSON.stringify(r.warnings)}`
    );
  }
  {
    // A dirty WORKING TREE is no longer refused on sight: the comparison reads
    // the working tree, so dirt outside the build's own inputs is answered.
    const r = scene({ builtRevision: 'old999', checkoutRevision: 'abc123-dirty' });
    check(
      'uncommitted-changes-outside-the-build-inputs-are-proved-harmless-rather-than-assumed',
      r.ok === true && r.identity === 'equivalent' && r.git.dirty === true,
      `identity=${r.identity}, tree dirty=${r.git.dirty}`
    );
  }
  {
    const r = scene({ builtRevision: 'old999', checkoutRevision: 'abc123-dirty', buildInputsDiffer: true });
    check(
      'uncommitted-changes-INSIDE-the-build-inputs-are-refused',
      r.ok === false && /differs between/.test(r.reason) && /uncommitted changes/.test(r.stale[0]),
      `ok=${r.ok}; ${JSON.stringify(r.stale)}`
    );
  }
  {
    const r = scene({ builtRevision: 'notinthisrepo', unknownCommit: true });
    check(
      'a-renderer-built-from-a-commit-this-checkout-does-not-have-is-refused',
      r.ok === false && r.identity === 'unverified' && /not a commit in this checkout/.test(r.reason),
      `ok=${r.ok}; ${JSON.stringify(r.refusals)}`
    );
  }
  {
    const r = scene({ times: { source: 9999 } });
    check(
      'a-source-newer-than-every-compiled-output-is-refused',
      r.ok === false && r.stale.length === 3 && /main\.js/.test(r.reason) && /electron\.js/.test(r.reason),
      `${r.stale.length} stale artifact(s): ${JSON.stringify(r.stale)}`
    );
  }
  {
    const r = scene({ missing: ['/r/static/css/style.css'] });
    check(
      'a-missing-artifact-is-named-and-stops-the-run-before-anything-else-is-read',
      r.ok === false && r.missing.length === 1 && /stylesheet/.test(r.reason) && r.git === null,
      `missing = ${JSON.stringify(r.missing)}; the checkout was not consulted = ${r.git === null}`
    );
  }

  // --- the claim is never larger than the evidence -------------------------
  {
    const r = scene();
    check(
      'a-passing-report-states-what-it-does-not-prove',
      Array.isArray(r.limits) && r.limits.length >= 4 &&
        r.limits.some((l) => /not the bytes it emitted/.test(l)) &&
        r.limits.some((l) => /freshness heuristic/.test(l)) &&
        identity.lines(r).some((l) => /what this does not prove/.test(l)),
      `${r.limits.length} stated limit(s), printed with the report`
    );
  }

  {
    const real = identity.revisionOf(path.join(preview.REPO, 'static/js/main.js'));
    check(
      'the-real-renderers-revision-is-readable-from-the-head-of-the-bundle',
      typeof real.revision === 'string' && real.revision.length > 0,
      `frontend.config.REVISION = ${JSON.stringify(real.revision)}${real.why ? ' — ' + real.why : ''}`
    );
  }
}

// ---------------------------------------------------------------------------
// The point of all of the above: a refused verdict must produce ZERO launches.
// These drive the REAL identity module through the REAL launcher, and count
// how many times the guarded launch path was entered.
// ---------------------------------------------------------------------------
async function refusalLaunchesNothingChecks() {
  console.log('A refused build identity launches nothing');

  const run = async (over) => {
    let launches = 0;
    const app = fakeApp();
    const { deps, logs } = baseDeps({
      app,
      // `selfCheck` only so a run that IS allowed to launch finishes by itself
      // instead of waiting out the session; it does not affect the gate, which
      // runs before either path.
      selfCheck: true,
      writeResult: false,
      // The REAL gate, driven by the REAL identity module over doubles. The
      // other lifecycle checks stub `checkBuild` out; these must not.
      checkBuild: preview.DEFAULTS.checkBuild,
      inspectBuild: () => identityScene(over),
      launch: async (profile, opts) => {
        launches++;
        if (opts && typeof opts.onApp === 'function') opts.onApp(app);
        await tick();
        return { app, page: {}, profileDir: '/double/profile' };
      },
    });
    const out = await preview.runPreview(deps);
    return { out, launches, logs, app };
  };

  const refused = [
    ['no revision in the renderer', { builtRevision: '' }],
    ['a renderer built from an uncommitted tree', { builtRevision: 'abc123-dirty', checkoutRevision: 'abc123-dirty' }],
    ['git unavailable', { gitDead: true }],
    ['an untracked file under the build inputs', { untracked: ['src/main/x.cljs'] }],
    ['a commit this checkout does not have', { builtRevision: 'nope', unknownCommit: true }],
    ['a declared build input that cannot be read', { missing: ['/r/src/main'] }],
    ['build inputs that differ from the build', { builtRevision: 'old999', buildInputsDiffer: true }],
  ];
  for (const [name, over] of refused) {
    const { out, launches, logs } = await run(over);
    check(
      'refused-launches-nothing: ' + name,
      launches === 0 && out.exit_code === 1 && out.ready === false && out.close_attempted === false &&
        said(logs, /PREVIEW STOPPED/) && said(logs, /nothing had been launched/),
      `guarded launches = ${launches}, exit = ${out.exit_code}, ready = ${out.ready}, ` +
        `anything to close = ${out.close_attempted}`
    );
  }

  // And the converse, so the gate is not simply refusing everything.
  for (const [name, over] of [['exact', {}], ['equivalent', { builtRevision: 'old999' }]]) {
    const { out, launches } = await run(over);
    check(
      'an-established-identity-does-launch: ' + name,
      launches === 1 && out.ready === true && out.exit_code === 0 && out.build.identity === name &&
        out.closed_gracefully === true,
      `guarded launches = ${launches}, identity = ${out.build && out.build.identity}, exit = ${out.exit_code}, ` +
        `closed = ${out.closed_gracefully}`
    );
  }
}

// ---------------------------------------------------------------------------
function demoSelectionChecks() {
  console.log('Demonstration graph selection');
  check(
    'the-one-command-with-no-arguments-opens-the-integrated-graph',
    preview.parseDemo([]).key === 'integrated' && preview.DEFAULT_DEMO === 'integrated',
    `default = ${preview.parseDemo([]).key}`
  );
  check(
    'the-original-user-graph-is-still-reachable-by-name',
    preview.parseDemo(['--demo', 'user']).key === 'user' && preview.parseDemo(['--demo=user']).key === 'user',
    'both --demo user and --demo=user select it'
  );
  let refused = null;
  try {
    preview.parseDemo(['--demo', 'personal']);
  } catch (e) {
    refused = e;
  }
  check(
    'an-unknown-demonstration-graph-is-refused-rather-than-guessed-at',
    !!refused && /no demonstration graph called "personal"/.test(refused.message),
    refused ? refused.message : 'IT DID NOT REFUSE'
  );
}

// ---------------------------------------------------------------------------
(async () => {
  console.log('-'.repeat(72));
  console.log('F27 preview — lifecycle and generator checks (doubles, no real launch)');
  console.log('-'.repeat(72));
  generatorChecks();
  integratedGeneratorChecks();
  buildIdentityChecks();
  await refusalLaunchesNothingChecks();
  demoSelectionChecks();
  await lifecycleChecks();
  console.log('-'.repeat(72));
  console.log(`RESULT ${JSON.stringify({ pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('CHECKS FAILED TO RUN: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
