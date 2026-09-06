#!/usr/bin/env node
'use strict';
//
// F27 user preview — the single, guarded way to start the development build
// with the demonstration graph.
//
// It launches ONLY through development/f27-evidence/isolated-launch.js. There is
// no direct Electron or app-bundle launch here and no fallback: if the guarded
// path refuses, this script stops. See INCIDENT_2026-09-05_UNISOLATED_LAUNCH.md.
//
// LIFECYCLE. One controller owns the whole run. Signal handling (SIGINT,
// SIGTERM, SIGHUP), terminal end-of-input and the session deadline are
// installed BEFORE the application is launched, not after it is ready, and they
// apply to setup, to the interactive wait and to --self-check alike. Every exit
// path — success, refusal, a throw during setup, a signal, the deadline — runs
// the same idempotent cleanup, which closes whatever was actually launched. A
// partially launched application is adopted through the guarded launcher's
// `onApp` hook, so a failure part-way through a launch still has something to
// close. Nothing else is ever signalled: no process is matched by name and no
// unrelated process is killed.
//
// ORDER AT SHUTDOWN. The application is closed and given time to settle FIRST,
// and only then is the demonstration graph hashed. A close that did not succeed
// is reported as such, and no preservation claim is made from it.
//
// The demonstration notes are ordinary notes. The F27 viewing controls are
// read-only, but this launcher does not disable OG's editor, so the graph can
// legitimately change. The byte comparison is a report, not a guarantee.
//
// This launcher does not start, stop, manage or modify the installed Logseq OG,
// user settings, login items, network settings or global shortcuts, and it
// starts no background watcher and no auto-restart.
//
// Usage:
//   node f27-preview/preview.js              start the preview
//   node f27-preview/preview.js --reset      archive the demonstration graph and
//                                            rebuild it before starting
//   node f27-preview/preview.js --self-check maintenance: run the walkthrough
//                                            automatically and exit
//
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..'); // development/f27-slice-1
const EVIDENCE = path.resolve(REPO, '../f27-evidence');
const PREVIEW_DIR = path.resolve(REPO, '../f27-preview');
const GRAPH = path.join(PREVIEW_DIR, 'graph/f27-preview-demo');
const GRAPH_NAME = path.basename(GRAPH);
const GUARDED_LAUNCH = path.join(EVIDENCE, 'isolated-launch.js');

// The project's existing per-session bound. It now covers the WHOLE run —
// startup, the session itself and the self-check — not just the wait after the
// preview is ready. Reaching it is not an error.
const SESSION_LIMIT_MIN = 12;
const WARN_AT_MIN = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A refusal or a failure this launcher understands and reports plainly.
class PreviewError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'PreviewError';
    this.extra = extra || null;
  }
}
// The run was stopped on purpose: a signal, end of input, or the deadline.
class CancelledError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CancelledError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle controller — installed first, owns every exit path.
// ---------------------------------------------------------------------------
function createLifecycle(deps) {
  const log = deps.log;
  const state = {
    app: null,
    stopReason: null,
    enterArmed: false,
    enterQueued: false,
    cleanup: null, // cached result: cleanup is idempotent
    handlers: [],
    timers: [],
    waiters: [],
    cancelWaiters: [],
    stdin: null,
  };

  function requestStop(reason) {
    if (state.stopReason) return;
    state.stopReason = reason;
    for (const resolve of state.waiters.splice(0)) resolve(reason);
    for (const reject of state.cancelWaiters.splice(0)) reject(new CancelledError(reason));
  }

  // Adopt an application handle the moment one exists — including one handed
  // over by the guarded launcher part-way through a launch that then failed.
  function adopt(app) {
    if (app && !state.app) state.app = app;
    return app;
  }

  // Run `p`, but give up waiting on it the moment the run is cancelled. The
  // underlying work is not aborted — it cannot be — but the app handle is
  // already adopted, so cleanup can still close it.
  function guard(p) {
    if (state.stopReason) return Promise.reject(new CancelledError(state.stopReason));
    if (!p || typeof p.then !== 'function') return Promise.resolve(p);
    p.catch(() => {}); // a late rejection must not surface as unhandled
    let mine;
    const cancelled = new Promise((_, reject) => {
      mine = reject;
      state.cancelWaiters.push(reject);
    });
    const drop = () => {
      const i = state.cancelWaiters.indexOf(mine);
      if (i >= 0) state.cancelWaiters.splice(i, 1);
    };
    return Promise.race([p, cancelled]).then(
      (v) => {
        drop();
        return v;
      },
      (e) => {
        drop();
        throw e;
      }
    );
  }

  function install() {
    const signal = (name, describe) => {
      const h = () => requestStop(describe);
      process.on(name, h);
      state.handlers.push([name, h]);
    };
    signal('SIGINT', 'you pressed Ctrl-C');
    signal('SIGTERM', 'the system asked this command to stop (SIGTERM)');
    signal('SIGHUP', 'the terminal went away (SIGHUP)');

    try {
      const stdin = process.stdin;
      const onData = () => {
        if (state.enterArmed) requestStop('you pressed Enter');
        else state.enterQueued = true; // typed during startup; honoured at READY
      };
      // End of input means the terminal is gone only when there IS a terminal.
      // A closed pipe (`< /dev/null`, or output piped from another command) is
      // not a cancellation, so the deadline and signals govern instead.
      const onEnd = () => {
        if (stdin.isTTY) requestStop('the terminal closed (end of input)');
      };
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.resume();
      state.stdin = { stdin, onData, onEnd };
    } catch (e) {
      /* no usable stdin; signals and the deadline still apply */
    }

    state.timers.push(
      setTimeout(() => {
        log('');
        log(`[preview] ${Math.round((deps.sessionLimitMs - deps.warnMs) / 60000)} minute(s) left in this session.`);
      }, deps.warnMs)
    );
    const limitLabel =
      deps.sessionLimitMs >= 60000 ? `${Math.round(deps.sessionLimitMs / 60000)}-minute session limit` : 'session limit';
    state.timers.push(setTimeout(() => requestStop(`the ${limitLabel} was reached`), deps.sessionLimitMs));
  }

  // Enter closes the preview only once there is something to close. Input typed
  // during startup is remembered rather than swallowed.
  function armEnter() {
    state.enterArmed = true;
    if (state.enterQueued) requestStop('you pressed Enter');
  }

  function waitForExit(app) {
    return new Promise((resolve) => {
      if (state.stopReason) return resolve(state.stopReason);
      state.waiters.push(resolve);
      if (app && typeof app.on === 'function') {
        app.on('close', () => requestStop('the preview window was closed'));
      }
    });
  }

  // Idempotent. Detaches everything this process owns, then closes the
  // application it launched — and only that application.
  async function cleanup() {
    if (state.cleanup) return state.cleanup;
    const result = { attempted: false, closed: false, error: null, signalled: false, signalError: null };
    state.cleanup = result; // claim it before any await, so a second call waits on nothing

    for (const [name, h] of state.handlers.splice(0)) process.removeListener(name, h);
    for (const t of state.timers.splice(0)) clearTimeout(t);
    if (state.stdin) {
      try {
        state.stdin.stdin.removeListener('data', state.stdin.onData);
        state.stdin.stdin.removeListener('end', state.stdin.onEnd);
        state.stdin.stdin.pause();
      } catch (e) {
        /* nothing to detach */
      }
      state.stdin = null;
    }

    if (!state.app) return result;
    result.attempted = true;
    try {
      await Promise.race([
        state.app.close(),
        deps.sleep(deps.closeTimeoutMs).then(() => {
          throw new Error(`the application did not close within ${Math.round(deps.closeTimeoutMs / 1000)}s`);
        }),
      ]);
      result.closed = true;
    } catch (e) {
      result.error = e;
      // Last resort, and strictly the child this launcher started itself —
      // never a process matched by name, never anything unrelated.
      try {
        const child = typeof state.app.process === 'function' ? state.app.process() : null;
        if (child && child.pid && child.killed !== true) {
          child.kill('SIGTERM');
          result.signalled = true;
        }
      } catch (e2) {
        result.signalError = e2;
      }
    }
    return result;
  }

  return {
    install,
    adopt,
    guard,
    armEnter,
    waitForExit,
    cleanup,
    requestStop,
    get stopReason() {
      return state.stopReason;
    },
    get app() {
      return state.app;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Build artifacts
// ---------------------------------------------------------------------------
function checkArtifacts(deps) {
  const log = deps.log;
  const needed = [
    ['compiled renderer', path.join(REPO, 'static/js/main.js')],
    ['compiled main process', path.join(REPO, 'static/electron.js')],
    ['stylesheet', path.join(REPO, 'static/css/style.css')],
    [
      'Electron binary',
      path.join(REPO, 'static/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    ],
    ['guarded launch path', GUARDED_LAUNCH],
  ];
  const missing = [];
  log('Build artifacts');
  for (const [label, p] of needed) {
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      /* reported below */
    }
    if (st) {
      log(`  ok      ${label} — ${p} (${(st.size / 1024).toFixed(0)} KB, ${st.mtime.toISOString()})`);
    } else {
      log(`  MISSING ${label} — ${p}`);
      missing.push(label);
    }
  }
  if (missing.length) {
    throw new PreviewError(
      `${missing.length} build artifact(s) are missing: ${missing.join(', ')}.`,
      'Rebuild in this order (gulp first, then the ClojureScript compile — the\n' +
        'other order deletes the compiled output):\n' +
        `  cd ${REPO}\n` +
        '  yarn gulp:build\n' +
        '  clojure -M:cljs compile app electron'
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Demonstration graph
// ---------------------------------------------------------------------------
function manifest(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.DS_Store') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
    }
  })(dir);
  return out;
}
const digest = (d) =>
  crypto
    .createHash('sha256')
    .update(
      manifest(d)
        .map((r) => r[1] + '  ' + ('./' + r[0]).normalize('NFC'))
        .sort()
        .join('\n')
    )
    .digest('hex');

// Never deletes. An existing graph is used as it is, or — only with --reset —
// moved into a dated archive first. Anything incomplete or unrecognised is
// refused rather than overwritten, because the demonstration notes are editable
// and the reader may have changed them.
function ensureGraph(deps) {
  const log = deps.log;
  const gen = require(path.join(HERE, 'make-preview-graph.js'));
  let state;
  try {
    state = gen.inspect();
  } catch (e) {
    throw new PreviewError(`the demonstration graph could not be checked: ${e.message}`);
  }

  const create = (reason) => {
    const r = gen.build({ reset: deps.reset });
    if (r.archived) log(`Previous demonstration graph archived to: ${r.archived}`);
    log(`Demonstration graph ${reason}: ${r.graph} (${r.files.length} pages)`);
  };

  if (deps.reset) {
    if (state.status === 'foreign') {
      throw new PreviewError(
        `${state.graph} exists but ${state.detail}.`,
        'Nothing there will be moved or deleted. Move it aside yourself if you want\n' +
          'a fresh demonstration graph, then run the command again.'
      );
    }
    try {
      create(state.status === 'absent' || state.status === 'empty' ? 'created' : 'rebuilt');
    } catch (e) {
      throw new PreviewError(`the demonstration graph could not be rebuilt: ${e.message}`);
    }
  } else if (state.status === 'absent' || state.status === 'empty') {
    try {
      create('created');
    } catch (e) {
      throw new PreviewError(`the demonstration graph could not be created: ${e.message}`);
    }
  } else if (state.status === 'owned-complete') {
    log(`Demonstration graph: ${state.graph} (${state.detail}; --reset archives it and starts fresh)`);
  } else if (state.status === 'owned-incomplete') {
    throw new PreviewError(
      `the demonstration graph at ${state.graph} is incomplete (${state.detail}).`,
      'It will NOT be overwritten or deleted — it may contain notes you changed.\n' +
        'Run the command again with --reset to move it into a dated archive beside\n' +
        'it and build a fresh one:\n' +
        '  node f27-preview/preview.js --reset'
    );
  } else {
    throw new PreviewError(
      `${state.graph} exists but ${state.detail}.`,
      'Nothing there will be touched. Move it aside yourself if you want a fresh\n' +
        'demonstration graph, then run the command again.'
    );
  }

  const after = gen.inspect();
  if (after.status !== 'owned-complete') {
    throw new PreviewError(`the demonstration graph is not usable (${after.status}: ${after.detail}).`);
  }
  return fs.realpathSync(after.graph);
}

// ---------------------------------------------------------------------------
// 3. A fresh, uniquely named profile inside the evidence directory
// ---------------------------------------------------------------------------
function freshProfile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
  let name = `preview-${stamp}`;
  let n = 2;
  while (fs.existsSync(path.join(EVIDENCE, name))) name = `preview-${stamp}-${n++}`;
  return name;
}

// ---------------------------------------------------------------------------
// 4/5. Launch, open the graph, and assert what actually opened
// ---------------------------------------------------------------------------
const MANUAL = (g) =>
  'Open the demonstration graph by hand instead:\n' +
  '  1. In the preview window, use the graph switcher and choose "Add new graph".\n' +
  '  2. In the folder chooser, go to exactly this folder and select it:\n' +
  `       ${g}\n` +
  '  3. Do NOT select any other folder, and do not select a personal graph.\n' +
  '  If the chooser opens somewhere unexpected, cancel it and close the preview;\n' +
  '  the folder chooser remembers a location from outside this isolated profile\n' +
  '  (a known containment limitation), so nothing should be picked on a guess.';

async function openGraph(page, graph) {
  const set = await page.evaluate((p) => {
    window.__MOCKED_OPEN_DIR_PATH__ = p;
    return window.__MOCKED_OPEN_DIR_PATH__ === p;
  }, graph);
  if (!set) {
    return { ok: false, why: 'the application did not accept the graph folder programmatically', current: null };
  }
  // With the folder already supplied above, this button never opens a native
  // chooser: the application takes the path it was handed. No dialog is acted on.
  const choose = page.locator('strong:has-text("Choose a folder")');
  if (await choose.isVisible().catch(() => false)) await choose.click();

  await page.waitForSelector(':has-text("Parsing files")', { state: 'hidden', timeout: 300000 }).catch(() => {});
  await sleep(3000);
  const title = await page.title();
  if (title === 'Import data into Logseq' || title === 'Add another repo') {
    await page.click('a.button >> text=Skip').catch(() => {});
  }

  let current = null;
  for (let i = 0; i < 200; i++) {
    current = await page.evaluate(() => {
      try {
        return window.logseq && window.logseq.api && window.logseq.api.get_current_graph
          ? window.logseq.api.get_current_graph()
          : null;
      } catch (e) {
        return null;
      }
    });
    if (current && current.path === graph) break;
    await sleep(500);
  }
  if (!current || current.path !== graph) {
    return {
      ok: false,
      why: `the application reports graph path ${JSON.stringify(current && current.path)}, not ${JSON.stringify(graph)}`,
      current,
    };
  }
  await sleep(8000); // let first-open housekeeping settle before the byte baseline
  return { ok: true, current };
}

// A small, non-interactive marker so the preview window is never mistaken for
// the installed Logseq OG. It is added by this launcher, not by the application,
// and it cannot be clicked.
async function markWindow(page, graph, profile) {
  await page
    .evaluate(
      (info) => {
        const old = document.getElementById('f27-preview-badge');
        if (old) old.remove();
        const el = document.createElement('div');
        el.id = 'f27-preview-badge';
        el.textContent = info;
        el.setAttribute(
          'style',
          [
            'position:fixed',
            'right:8px',
            'bottom:46px',
            'z-index:2147483647',
            'pointer-events:none',
            'user-select:none',
            'font:11px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
            'padding:5px 9px',
            'border-radius:7px',
            'background:rgba(140,60,0,.88)',
            'color:#fff',
            'white-space:pre',
            'max-width:46vw',
          ].join(';')
        );
        document.body.appendChild(el);
      },
      `F27 PREVIEW — demonstration notes only\ngraph: ${path.basename(graph)}   profile: ${profile}`
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Maintenance walkthrough — the five actions the guide asks the reader to do,
// performed against this same launch path so the guide can be trusted.
// ---------------------------------------------------------------------------
async function walkthrough(page, out) {
  const checks = out.checks;
  const check = (id, ok, detail) => {
    checks.push({ id, result: ok ? 'PASS' : 'FAIL', detail });
    line(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
  };
  const away = async () => {
    await page.mouse.move(4, 4);
    await sleep(350);
  };
  const rows = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.f27-ref-row')).map((r) =>
        ((r.querySelector('.f27-ref-crumb') || {}).innerText || '').replace(/\n/g, ' > ').trim()
      )
    );
  const rowIdx = async (needle) => (await rows()).findIndex((c) => c.includes(needle));
  const row = (i) => page.locator('.f27-ref-row').nth(i);
  const inItems = (i) =>
    page.evaluate((n) => {
      const r = document.querySelectorAll('.f27-ref-row')[n];
      const body = r && r.querySelector('.f27-in-body');
      const txt = (e) => ((e && e.innerText) || '').trim();
      if (!body) return null;
      return {
        head: txt(body.querySelector('.f27-in-head')),
        direction: txt(body.querySelector('.f27-in-direction')),
        count: txt(body.querySelector('.f27-in-count')),
        notes: Array.from(body.querySelectorAll('.f27-ctx-note')).map(txt),
        path: Array.from(body.querySelectorAll('.f27-in-path-step')).map(txt),
        back: !!body.querySelector('.f27-in-back'),
        items: Array.from(body.querySelectorAll('.f27-in-item')).map((e) => ({
          crumb: txt(e.querySelector('.f27-in-crumb')),
          text: txt(e.querySelector('.f27-in-text')),
          stop: !!e.querySelector('.f27-in-mark.is-stop'),
          mark: txt(e.querySelector('.f27-in-mark')),
          explore: !!e.querySelector('.f27-in-explore'),
        })),
      };
    }, i);
  const openCtx = async (i) => {
    await away();
    await row(i).locator('.f27-ctx-toggle').click();
    await sleep(1200);
  };
  const openInbound = async (i) => {
    await away();
    await row(i).locator('.f27-in-toggle').click();
    await sleep(1600);
  };

  // --- Action 1: the compact overview --------------------------------------
  await page.evaluate(() => {
    location.hash = '#/page/' + encodeURIComponent('Deep Work');
  });
  await sleep(3500);
  if ((await page.locator('.f27-ref-overview').count()) === 0) {
    await page.locator('a.open-block-ref-link').first().click();
    await sleep(2200);
  }
  const crumbs = await rows();
  out.overview_rows = crumbs;
  const want = ['Weekly Review', '연구 노트', 'Habit Loop', 'Quick Capture'];
  check(
    'action-1-overview-shows-every-source-with-its-breadcrumb',
    crumbs.length === 4 && want.every((w) => crumbs.some((c) => c.includes(w))),
    `${crumbs.length} row(s): ${JSON.stringify(crumbs)}`
  );

  // --- Action 2: choosing a Crystal marker ---------------------------------
  await away();
  await page.locator('.f27-crystal-config-toggle').click();
  await sleep(900);
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.f27-crystal-option')).map((o) => (o.innerText || '').trim())
  );
  out.crystal_options = options;
  const coreIdx = options.findIndex((o) => o.includes('핵심'));
  check(
    'action-2a-the-marker-list-offers-the-graphs-real-tags',
    coreIdx >= 0 && options.some((o) => o.includes('question')),
    `options = ${JSON.stringify(options)}`
  );
  if (coreIdx >= 0) {
    await page.locator('.f27-crystal-option').nth(coreIdx).click();
    await sleep(1600);
  }
  const withMarker = await page.evaluate(() => ({
    toggle: ((document.querySelector('.f27-crystal-config-toggle') || {}).innerText || '').trim(),
    chips: Array.from(document.querySelectorAll('.f27-crystal-chip')).map((c) => (c.innerText || '').trim()),
    scope: !!document.querySelector('.f27-crystal-scope'),
  }));
  out.crystal_selected = withMarker;
  check(
    'action-2b-the-chosen-marker-previews-beside-the-references',
    withMarker.chips.length >= 2 && withMarker.scope && /Crystal marker:/.test(withMarker.toggle),
    `${withMarker.chips.length} preview(s) ${JSON.stringify(withMarker.chips)}; toggle = ${JSON.stringify(
      withMarker.toggle
    )}`
  );
  await away();
  await page.locator('.f27-crystal-clear').click().catch(() => {});
  await sleep(1400);
  const cleared = await page.evaluate(() => document.querySelectorAll('.f27-crystal-chip').length);
  check('action-2c-the-marker-can-be-cleared-again', cleared === 0, `preview chips after clearing = ${cleared}`);

  // --- Action 3: ancestors and children ------------------------------------
  const iRev = await rowIdx('Weekly Review');
  await openCtx(iRev);
  const ancestors = await page.evaluate((n) => {
    const r = document.querySelectorAll('.f27-ref-row')[n];
    return Array.from(r.querySelectorAll('.f27-ctx-lines .f27-ctx-line')).map((e) => (e.innerText || '').trim());
  }, iRev);
  out.ancestors = ancestors;
  check(
    'action-3a-the-ancestor-path-above-the-reference-is-shown',
    ancestors.some((a) => a.includes('Weekly review')) &&
      ancestors.some((a) => a.includes('Week 36')) &&
      ancestors.some((a) => a.includes('What worked')),
    `${ancestors.length} line(s): ${JSON.stringify(ancestors)}`
  );
  await away();
  await row(iRev).locator('.f27-desc-toggle-all').click();
  await sleep(1500);
  const children = await page.evaluate((n) => {
    const r = document.querySelectorAll('.f27-ref-row')[n];
    return Array.from(r.querySelectorAll('.f27-desc-line')).map((e) => (e.innerText || '').trim());
  }, iRev);
  out.children = children;
  check(
    'action-3b-the-children-of-that-reference-are-shown-on-request',
    children.length >= 4 && children.some((c) => c.includes('Keep the same two hours')),
    `${children.length} child line(s): ${JSON.stringify(children)}`
  );
  const idLeak = await page.evaluate((n) => {
    const r = document.querySelectorAll('.f27-ref-row')[n];
    return /id::/.test(r.innerText || '');
  }, iRev);
  check('action-3c-block-identifiers-stay-out-of-the-reading-view', !idLeak, `"id::" visible in the row = ${idLeak}`);
  await openCtx(iRev); // close it again

  // --- Action 4: following the chain, and Back -----------------------------
  const iKo = await rowIdx('연구 노트');
  await openCtx(iKo);
  await openInbound(iKo);
  const lvl1 = await inItems(iKo);
  out.chain_level_1 = lvl1;
  check(
    'action-4a-the-first-step-shows-what-references-the-korean-note',
    !!lvl1 && lvl1.items.length === 1 && lvl1.items[0].crumb.includes('프로젝트 계획'),
    `head = ${JSON.stringify(lvl1 && lvl1.head)}; items = ${JSON.stringify(lvl1 && lvl1.items.map((i) => i.crumb))}`
  );
  check(
    'action-4b-the-direction-is-stated-in-words-on-the-panel',
    !!lvl1 && /refer TO the selected block/.test(lvl1.direction),
    JSON.stringify(lvl1 && lvl1.direction)
  );
  await away();
  await row(iKo).locator('.f27-in-item').nth(0).locator('.f27-in-explore').click();
  await sleep(1800);
  const lvl2 = await inItems(iKo);
  out.chain_level_2 = lvl2;
  check(
    'action-4c-a-second-step-shows-what-references-the-plan',
    !!lvl2 && lvl2.items.length === 1 && lvl2.items[0].crumb.includes('회의 기록') && lvl2.path.length >= 1,
    `path = ${JSON.stringify(lvl2 && lvl2.path)}; items = ${JSON.stringify(lvl2 && lvl2.items.map((i) => i.crumb))}`
  );
  await away();
  await row(iKo).locator('.f27-in-back').click();
  await sleep(1500);
  const backTo = await inItems(iKo);
  out.chain_back = backTo;
  check(
    'action-4d-back-returns-to-the-previous-step-exactly',
    !!backTo && backTo.items.length === 1 && backTo.items[0].crumb.includes('프로젝트 계획'),
    `after Back: ${JSON.stringify(backTo && backTo.items.map((i) => i.crumb))}`
  );
  await openCtx(iKo);

  // --- Action 5: the cycle boundary ----------------------------------------
  const iCue = await rowIdx('Habit Loop');
  await openCtx(iCue);
  await openInbound(iCue);
  const cyc1 = await inItems(iCue);
  out.cycle_level_1 = cyc1;
  check(
    'action-5a-routine-is-listed-as-referencing-habit-loop',
    !!cyc1 && cyc1.items.length === 1 && cyc1.items[0].crumb.includes('Routine'),
    JSON.stringify(cyc1 && cyc1.items.map((i) => i.crumb))
  );
  await away();
  await row(iCue).locator('.f27-in-item').nth(0).locator('.f27-in-explore').click();
  await sleep(1800);
  const cyc2 = await inItems(iCue);
  out.cycle_level_2 = cyc2;
  const boundary = cyc2 && cyc2.items.find((i) => i.crumb.includes('Habit Loop'));
  check(
    'action-5b-the-return-to-habit-loop-is-marked-as-a-boundary-and-not-reopened',
    !!boundary && boundary.stop === true && boundary.explore === false,
    boundary
      ? `marker = ${JSON.stringify(boundary.mark)}, next-step control offered = ${boundary.explore}`
      : `rows = ${JSON.stringify(cyc2 && cyc2.items.map((i) => i.crumb))}`
  );
  await openCtx(iCue);

  // --- The honest empty answer ---------------------------------------------
  const iQuick = await rowIdx('Quick Capture');
  await openCtx(iQuick);
  await openInbound(iQuick);
  const empty = await inItems(iQuick);
  out.empty_answer = empty;
  check(
    'extra-a-block-nothing-references-says-so-plainly',
    !!empty && empty.items.length === 0 && empty.notes.some((n) => /No block in this graph references this one/.test(n)),
    JSON.stringify(empty && empty.notes)
  );
  await openCtx(iQuick);

  // --- Nothing was edited ---------------------------------------------------
  const editing = await page.evaluate(() => document.querySelectorAll('textarea.editor-input').length);
  check('extra-the-walkthrough-never-opened-an-editor', editing === 0, `editor textareas open = ${editing}`);

  await page.screenshot({ path: path.join(PREVIEW_DIR, 'preview-walkthrough.png') }).catch(() => {});
}

// ---------------------------------------------------------------------------
// The run. One try/finally: every path below leaves through `finish`, which
// closes the application, lets it settle, and only then hashes the graph.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  launch: (profile, opts) => require(GUARDED_LAUNCH).launch(profile, opts),
  openGraph,
  markWindow,
  walkthrough,
  digest,
  checkArtifacts,
  ensureGraph,
  freshProfile,
  sleep,
  log: (s) => console.log(s),
  reset: false,
  selfCheck: false,
  // Time for the application's own save/flush to land after a graceful close,
  // before the final byte check is taken.
  settleMs: 2500,
  closeTimeoutMs: 15000,
  sessionLimitMs: SESSION_LIMIT_MIN * 60 * 1000,
  warnMs: WARN_AT_MIN * 60 * 1000,
  writeResult: true,
  onStarted: null,
};

async function runPreview(overrides) {
  const deps = Object.assign({}, DEFAULTS, overrides || {});
  const log = deps.log;
  const rule = () => log('-'.repeat(72));

  const lc = createLifecycle(deps);
  lc.install(); // signals, end-of-input and the deadline, before anything runs

  const out = {
    started: new Date().toISOString(),
    launch: 'isolated-launch.js (guarded)',
    session_limit_minutes: Math.round(deps.sessionLimitMs / 60000),
    checks: [],
  };
  let error = null;
  let graph = null;
  let baseline = null;
  let profile = null;
  let readyAt = false;
  let reason = null;
  let selfCheckCompleted = false;

  try {
    if (deps.onStarted) deps.onStarted({ requestStop: lc.requestStop, lifecycle: lc });

    rule();
    log('F27 user preview — isolated development build, demonstration notes only');
    rule();
    deps.checkArtifacts(deps);
    graph = deps.ensureGraph(deps);
    out.graph = graph;
    profile = deps.freshProfile();
    out.profile = path.join(EVIDENCE, profile);
    log(`Preview profile: ${out.profile} (fresh, created by this run)`);
    log('');

    log('Launching through the guarded path (isolated-launch.js)…');
    // `onApp` hands over the application as soon as it exists, so a failure
    // later in the launch still leaves something for cleanup to close.
    const launched = await lc.guard(deps.launch(profile, { onApp: (a) => lc.adopt(a) }));
    lc.adopt(launched.app);
    out.profile = launched.profileDir || out.profile;
    log(`  the guarded path accepted the profile and replaced the environment (${out.profile})`);

    const opened = await lc.guard(deps.openGraph(launched.page, graph));
    if (!opened.ok) {
      throw new PreviewError(
        'the demonstration graph could not be confirmed: ' + opened.why,
        'Nothing else was clicked.\n\n' + MANUAL(graph)
      );
    }
    out.graph_reported_by_app = opened.current.path;

    baseline = deps.digest(graph);
    out.digest_after_housekeeping = baseline;
    await lc.guard(deps.markWindow(launched.page, graph, profile));

    log('');
    rule();
    log('PREVIEW READY');
    rule();
    log(`Graph the application reports:  ${opened.current.path}`);
    log(`Graph this launcher asked for:  ${graph}`);
    log('  the two match, so the preview is showing the demonstration notes');
    log(`Isolated profile:               ${out.profile}`);
    log('');
    log('Finding the right window');
    log('  * the menu bar says "Electron", not "Logseq" — this is a development');
    log('    build. Your installed Logseq OG is a separate application: this');
    log('    command does not start, stop or change it.');
    log(`  * the graph name in the app is "${GRAPH_NAME}";`);
    log('  * a small orange "F27 PREVIEW" marker sits in the bottom-right corner.');
    log('');
    log('While you are in it');
    log('  * stay in this demonstration graph — do not open any other graph;');
    log('  * the F27 reference panels are read-only, but the ordinary editor is');
    log('    NOT disabled: clicking into a block still edits and saves it. That');
    log('    only ever affects these demonstration notes.');
    log('');
    log('Closing it');
    log('  press Enter in this terminal (or Ctrl-C) — a graceful close is attempted,');
    log('  and whether it succeeded is reported below.');
    log(`  This session also closes itself ${Math.round(deps.sessionLimitMs / 60000)} minutes after it started; that is`);
    log('  the project\'s standing per-session limit, not a failure. Run the command');
    log('  again for another session.');
    rule();
    readyAt = true;
    lc.armEnter();

    if (deps.selfCheck) {
      log('');
      log('Self-check: walking through the five guided actions…');
      await lc.guard(deps.walkthrough(launched.page, out));
      selfCheckCompleted = true;
      reason = 'the self-check finished';
    } else {
      reason = await lc.waitForExit(launched.app);
    }
  } catch (e) {
    error = e;
    if (e instanceof CancelledError) reason = e.reason;
  }

  // ---- one exit path -------------------------------------------------------
  log('');
  log('Closing the preview' + (reason ? ' — ' + reason : ''));

  const close = await lc.cleanup();
  out.close_attempted = close.attempted;
  out.closed_gracefully = close.closed;
  if (close.attempted) {
    if (close.closed) {
      log('  the application closed gracefully');
    } else {
      log(`  the application DID NOT close cleanly: ${close.error && close.error.message}`);
      if (close.signalled) log('  a stop signal was sent to the application this command started, and to nothing else');
      else log('  no further action was taken; if a preview window is still open, close it from its own menu');
      out.close_error = close.error ? String(close.error.message) : null;
      out.signalled = close.signalled;
    }
  } else {
    log('  nothing had been launched, so there was nothing to close');
  }

  // Only now — after the close, and after the application has had time to
  // flush — is the graph hashed. A close that failed cannot support a
  // preservation claim, and none is made.
  if (graph && baseline) {
    if (close.closed) await deps.sleep(deps.settleMs);
    let after = null;
    try {
      after = deps.digest(graph);
    } catch (e) {
      log('  the demonstration notes could not be re-checked: ' + e.message);
    }
    if (after) {
      out.digest_final = after;
      out.graph_unchanged = after === baseline;
      const same = after === baseline;
      if (!close.attempted || close.closed) {
        log(
          `  demonstration notes ${same ? 'unchanged' : 'CHANGED'} after close (${baseline.slice(0, 16)} ${
            same ? '==' : '!='
          } ${after.slice(0, 16)})`
        );
        if (!same) {
          log('    that is expected if you edited a note — the editor is not disabled.');
          log('    --reset archives the current notes and builds a fresh copy.');
        }
      } else {
        out.graph_unchanged = null; // measured, but not a preservation claim
        log(
          `  demonstration notes read as ${same ? 'unchanged' : 'CHANGED'} (${after.slice(0, 16)}), but the` +
            ' application did not'
        );
        log('    close cleanly, so this is NOT a claim that nothing was written afterwards.');
      }
    }
  }
  log('  your own notes were never opened; the installed Logseq OG was not started, stopped or changed');

  if (error && !(error instanceof CancelledError)) {
    log('');
    if (error instanceof PreviewError) {
      log('PREVIEW STOPPED — ' + error.message);
      if (error.extra) log(error.extra);
    } else {
      log('PREVIEW FAILED: ' + (error && error.stack ? error.stack : error));
    }
    out.error = String((error && error.message) || error);
  }

  let exitCode = 0;
  if (error && !(error instanceof CancelledError)) exitCode = 1;
  if (close.attempted && !close.closed) exitCode = 1;
  if (deps.selfCheck) {
    out.summary = {
      pass: out.checks.filter((c) => c.result === 'PASS').length,
      fail: out.checks.filter((c) => c.result === 'FAIL').length,
    };
    // A walkthrough that was cut short — by a signal, the deadline or a throw —
    // verified nothing, whatever the counters say.
    out.self_check_completed = selfCheckCompleted;
    if (out.summary.fail || out.graph_unchanged !== true || !readyAt || !selfCheckCompleted) exitCode = 1;
    if (deps.writeResult && profile) {
      try {
        fs.writeFileSync(path.join(PREVIEW_DIR, `preview-self-check-${profile}.json`), JSON.stringify(out, null, 1));
      } catch (e) {
        log('  the self-check result file could not be written: ' + e.message);
      }
    }
    log('');
    log('SELF-CHECK ' + JSON.stringify(out.summary));
  }

  out.exit_code = exitCode;
  out.ready = readyAt;
  out.stop_reason = reason;
  out.original_error = error || null;
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  runPreview({ reset: args.includes('--reset'), selfCheck: args.includes('--self-check') })
    .then((r) => process.exit(r.exit_code))
    .catch((e) => {
      // Should not be reachable: runPreview owns its own failures.
      console.log('PREVIEW FAILED (outside the lifecycle): ' + (e && e.stack ? e.stack : e));
      process.exit(1);
    });
}

module.exports = {
  runPreview,
  createLifecycle,
  DEFAULTS,
  PreviewError,
  CancelledError,
  digest,
  ensureGraph,
  checkArtifacts,
  GRAPH,
  PREVIEW_DIR,
  EVIDENCE,
};
