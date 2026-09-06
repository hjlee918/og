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
// What it does, in order:
//   1. checks that every build artifact the preview needs is actually present;
//   2. makes sure the demonstration graph exists (and rebuilds it on --reset);
//   3. picks a fresh, uniquely named profile inside the evidence directory;
//   4. launches through the guarded path, which replaces the environment;
//   5. opens the demonstration graph and ASSERTS the graph path the application
//      reports back before it says the preview is ready;
//   6. holds the session in the foreground until you close it, or until the
//      bounded-session limit is reached;
//   7. closes gracefully and reports whether the demonstration notes changed.
//
// It does not modify installed applications, user settings, login items,
// network settings or global shortcuts, and it starts no background watcher and
// no auto-restart. Closing this command closes the preview.
//
// Usage:
//   node f27-preview/preview.js              start the preview
//   node f27-preview/preview.js --reset      rebuild the demonstration graph first
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

// The project's existing per-session bound. Preserved here: an application
// session is not left running indefinitely. Reaching it is not an error, and
// running this command again starts a fresh session.
const SESSION_LIMIT_MIN = 12;
const WARN_AT_MIN = 10;

const ARGS = process.argv.slice(2);
const RESET = ARGS.includes('--reset');
const SELF_CHECK = ARGS.includes('--self-check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => console.log(s);
const rule = () => line('-'.repeat(72));

function stop(why, extra) {
  line('');
  line('PREVIEW NOT STARTED — ' + why);
  if (extra) line(extra);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Build artifacts
// ---------------------------------------------------------------------------
function checkArtifacts() {
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
  line('Build artifacts');
  for (const [label, p] of needed) {
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      /* reported below */
    }
    if (st) {
      const kb = (st.size / 1024).toFixed(0);
      line(`  ok      ${label} — ${p} (${kb} KB, ${st.mtime.toISOString()})`);
    } else {
      line(`  MISSING ${label} — ${p}`);
      missing.push(label);
    }
  }
  if (missing.length) {
    stop(
      `${missing.length} build artifact(s) are missing: ${missing.join(', ')}.`,
      'Rebuild in this order (gulp first, then the ClojureScript compile — the\n' +
        'other order deletes the compiled output):\n' +
        `  cd ${REPO}\n` +
        '  yarn gulp:build\n' +
        '  yarn cljs:release'
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

function ensureGraph() {
  const gen = require(path.join(HERE, 'make-preview-graph.js'));
  const exists = fs.existsSync(path.join(GRAPH, 'logseq/config.edn'));
  if (RESET || !exists) {
    const files = gen.build();
    line(`Demonstration graph ${RESET && exists ? 'rebuilt' : 'created'}: ${GRAPH} (${files.length} pages)`);
  } else {
    line(`Demonstration graph: ${GRAPH} (already present; --reset rebuilds it)`);
  }
  const pages = fs.readdirSync(path.join(GRAPH, 'pages')).filter((f) => f.endsWith('.md'));
  if (pages.length < 9) stop(`the demonstration graph looks incomplete (${pages.length} pages).`);
  return fs.realpathSync(GRAPH);
}

// ---------------------------------------------------------------------------
// 3. A fresh, uniquely named profile inside the evidence directory
// ---------------------------------------------------------------------------
function freshProfile() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
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
// The foreground wait. No background watcher, no auto-restart: when this
// resolves, the preview is closed.
// ---------------------------------------------------------------------------
function waitForExit(app) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(warnT);
      clearTimeout(limitT);
      process.removeListener('SIGINT', onSig);
      try {
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
      } catch (e) {
        /* nothing to clean up */
      }
      resolve(reason);
    };
    const onKey = () => finish('you pressed Enter');
    const onSig = () => finish('you pressed Ctrl-C');
    const warnT = setTimeout(() => {
      line('');
      line(`[preview] ${SESSION_LIMIT_MIN - WARN_AT_MIN} minute(s) left in this session.`);
    }, WARN_AT_MIN * 60 * 1000);
    const limitT = setTimeout(
      () => finish(`the ${SESSION_LIMIT_MIN}-minute session limit was reached`),
      SESSION_LIMIT_MIN * 60 * 1000
    );
    try {
      process.stdin.resume();
      process.stdin.on('data', onKey);
    } catch (e) {
      /* no keyboard available; the limit and Ctrl-C still apply */
    }
    process.on('SIGINT', onSig);
    app.on('close', () => finish('the preview window was closed'));
  });
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
(async () => {
  rule();
  line('F27 user preview — isolated development build, demonstration notes only');
  rule();
  checkArtifacts();
  const graph = ensureGraph();
  const profile = freshProfile();
  line(`Preview profile: ${path.join(EVIDENCE, profile)} (fresh, created by this run)`);
  line('');

  const L = require(GUARDED_LAUNCH);
  line('Launching through the guarded path (isolated-launch.js)…');
  const { app, page, profileDir } = await L.launch(profile);
  line(`  the guarded path accepted the profile and replaced the environment (${profileDir})`);

  const opened = await openGraph(page, graph);
  if (!opened.ok) {
    line('');
    line('The demonstration graph could not be confirmed: ' + opened.why);
    line('Nothing else will be clicked. Closing the preview.');
    line('');
    line(MANUAL(graph));
    await Promise.race([app.close(), sleep(15000)]).catch(() => {});
    process.exit(1);
  }
  const baseline = digest(graph);
  await markWindow(page, graph, profile);

  const out = {
    started: new Date().toISOString(),
    graph,
    graph_reported_by_app: opened.current.path,
    profile: profileDir,
    launch: 'isolated-launch.js (guarded)',
    session_limit_minutes: SESSION_LIMIT_MIN,
    digest_after_housekeeping: baseline,
    checks: [],
  };

  line('');
  rule();
  line('PREVIEW READY');
  rule();
  line(`Graph the application reports:  ${opened.current.path}`);
  line(`Graph this launcher asked for:  ${graph}`);
  line('  the two match, so the preview is showing the demonstration notes');
  line(`Isolated profile:               ${profileDir}`);
  line('');
  line('Finding the right window');
  line('  * the menu bar says "Electron", not "Logseq" — the installed Logseq OG');
  line('    is a different application and is not involved;');
  line(`  * the graph name in the app is "${GRAPH_NAME}";`);
  line('  * a small orange "F27 PREVIEW" marker sits in the bottom-right corner.');
  line('');
  line('Closing it');
  line('  press Enter in this terminal (or Ctrl-C) — the preview closes gracefully.');
  line(`  This session also closes itself after ${SESSION_LIMIT_MIN} minutes; that is the`);
  line('  project\'s standing per-session limit, not a failure. Run the command again');
  line('  for another session.');
  rule();

  let reason;
  if (SELF_CHECK) {
    line('');
    line('Self-check: walking through the five guided actions…');
    await walkthrough(page, out);
    reason = 'the self-check finished';
  } else {
    reason = await waitForExit(app);
  }

  line('');
  line('Closing the preview — ' + reason);
  const after = digest(graph);
  const unchanged = after === baseline;
  out.digest_final = after;
  out.graph_unchanged = unchanged;
  line(
    `  demonstration notes ${unchanged ? 'unchanged' : 'CHANGED'} (${baseline.slice(0, 16)} ${
      unchanged ? '==' : '!='
    } ${after.slice(0, 16)})`
  );
  let closed = false;
  try {
    await Promise.race([
      app.close(),
      sleep(15000).then(() => {
        throw new Error('close timed out');
      }),
    ]);
    closed = true;
  } catch (e) {
    /* reported below */
  }
  out.closed_gracefully = closed;
  line(`  preview ${closed ? 'closed gracefully' : 'DID NOT close within 15s'}`);
  line('  your own notes and the installed Logseq OG were not opened or changed');

  if (SELF_CHECK) {
    out.summary = {
      pass: out.checks.filter((c) => c.result === 'PASS').length,
      fail: out.checks.filter((c) => c.result === 'FAIL').length,
    };
    fs.writeFileSync(path.join(PREVIEW_DIR, `preview-self-check-${profile}.json`), JSON.stringify(out, null, 1));
    line('');
    line('SELF-CHECK ' + JSON.stringify(out.summary));
    process.exit(out.summary.fail || !unchanged || !closed ? 1 : 0);
  }
  process.exit(closed && unchanged ? 0 : 1);
})().catch((e) => {
  line('');
  line('PREVIEW FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
