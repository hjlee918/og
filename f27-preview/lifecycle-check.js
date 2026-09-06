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
      checkArtifacts: () => {},
      ensureGraph: () => '/double/graph',
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
      checkArtifacts: () => {
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
(async () => {
  console.log('-'.repeat(72));
  console.log('F27 preview — lifecycle and generator checks (doubles, no real launch)');
  console.log('-'.repeat(72));
  generatorChecks();
  await lifecycleChecks();
  console.log('-'.repeat(72));
  console.log(`RESULT ${JSON.stringify({ pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('CHECKS FAILED TO RUN: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
