#!/usr/bin/env node
'use strict';
//
// F28 STEP ONE — what OG's linked-references list already shows about WHERE a
// reference comes from, observed in the packaged application.
//
//   node f28-refpath/checks/refpath-baseline-checks.js
//
// This scenario implements NOTHING. Its whole purpose is to establish, on a
// real graph in the real application, what the existing behaviour is — so that
// the decision to build or not build an F28 source-path disclosure rests on an
// observation rather than on a reading of the source.
//
// It is deliberately runnable against ANY of this project's feature builds:
// `frontend.components.reference` has not been touched since the accepted OG
// baseline `5b34566ca`, and neither has `breadcrumb`, `breadcrumb-with-container`
// or the `:ref?`/`:group-by-page?` branch of `->hiccup`. What this run reports
// is therefore OG's own behaviour, and the run prints the build it observed it
// in so that claim is checkable rather than asserted.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted
// BEFORE any feature interaction. This run writes nothing to the graph and
// proves it by comparing every file's hash after the application has closed.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));
const RG = require('./make-refpath-graph.js');
const APP = require('./packaged-app.js');
const NOISE = require('./browser-noise.js');
const REC = require('./recorder.js');

const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
// The packaged build that predates this feature.
const BASELINE_APP = 'Logseq-OG-F27-Inline';

const results = [];
let ownedTree = [];
const errors = REC.createRecorder();
const observations = {};
let errorEvidence = null;
const sleep = OP.sleep;

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  let text;
  try { text = String(typeof detail === 'function' ? detail() : detail); }
  catch (e) { text = `(could not describe this result: ${e.message})`; }
  results.push({ id, title, ok: !!ok, detail: text });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${title}\n          ${text}`);
  return ok;
}
function phase(name, operation) {
  errors.phase(name, operation);
  say(`  ┈ phase: ${name}${operation ? ` (${operation})` : ''}`);
}

const T = RG.TEXT;
const D = RG.DEPTH;

// A breadcrumb step is matched by a distinctive PREFIX of the block it names,
// because OG renders the block's inline markup and a page link inside an
// ancestor becomes an anchor whose text is the page's name, not its source.
const head = (s) => s.split('—')[0].trim().slice(0, 24);

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 step one: what OG already shows about a reference\'s source path ===\n');

  // ---------- O0 : preconditions ----------
  say('O0  preconditions');
  // Explicitly the build WITHOUT this feature. Once F28 is packaged it becomes
  // the newest build in `out/`, and observing OG's behaviour in a build that
  // changes it would be measuring the wrong thing entirely.
  const built = APP.resolve(BASELINE_APP);
  const v = built.preflight;
  record('O0.1', 'a packaged build of this project is present and passes its identity check',
    v.ok, v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
                 `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}`
               : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  observations.observedIn = {
    app: built.appName,
    schema: v.manifest.schema,
    branch: v.manifest.builtFrom.branch,
    commit: v.manifest.builtFrom.commit,
    renderer: v.manifest.builtFrom.rendererRevision,
  };
  // Measured, not asserted: the packaged renderer must not contain this
  // feature's namespace at all. An earlier version of this check simply
  // declared that the code was unmodified OG.
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const carriesF28 = fs.existsSync(runtime) &&
    fs.readdirSync(runtime).includes('frontend.util.f28_refpath.js');
  record('O0.2', 'the build this run observes does not contain the F28 feature at all',
    !carriesF28 && fs.existsSync(runtime),
    carriesF28 ? 'this packaged renderer carries frontend.util.f28_refpath; it is NOT a baseline'
               : `${built.appName} carries no f28 namespace, so what it renders is OG's own ` +
                 'breadcrumb (unchanged since 5b34566ca, verified in the checkout)');
  if (carriesF28) throw new Error('refusing to call an F28 build a baseline');

  // ---------- O1 : a fresh graph ----------
  say('\nO1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'baseline' });
  const GRAPH = B.assertInsideAllowedRoot('refpath graph', g.graph);
  record('O1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal})`);
  const before = GH.snapshot(GRAPH);
  record('O1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-refpath-inert-probe');
  record('O1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- O2/O3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'O',
  });
  const { app, page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    // ---------- O4 : the linked-references list ----------
    say('\nO4  the page everything points at, and its linked references');
    phase('read-linked-references', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
    // Every page group is wrapped in `ui/lazy-visible`, so a group that has
    // never entered the viewport renders a placeholder. Scroll DOWN THE PAGE in
    // steps and settle on the count of rendered referencing BLOCKS, not on the
    // count of page groups: the first reading of this fixture found three
    // groups immediately and two of them still empty, which a group-count
    // settle reported as finished.
    const refBlockCount = () => page.evaluate(() =>
      document.querySelectorAll('.references.page-linked .blocks-container [blockid]').length)
      .catch(() => 0);
    let seen = -1;
    let stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      await page.evaluate((step) => {
        const m = document.querySelector('#main-content-container') || document.body;
        const max = m.scrollHeight - m.clientHeight;
        m.scrollTop = max > 0 ? Math.min(max, (step % 6) * (max / 5)) : 0;
        window.scrollTo(0, (step % 6) * (document.body.scrollHeight / 5));
      }, i).catch(() => null);
      await sleep(1500);
      const n = await refBlockCount();
      if (n === seen) stable += 1; else { seen = n; stable = 0; }
    }
    say(`          (settled at ${seen} referencing blocks rendered)`);
    await parkPointer();

    // One reading of the whole linked-references section. Nothing here clicks.
    const readRefs = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const heading = clean((sec.querySelector('h2') || {}).innerText);
      const items = [...sec.querySelectorAll('.references-blocks-item')].map((item) => {
        // The group header is `ui/foldable`'s own title row, which carries the
        // page link OG renders above the groups.
        const header = item.querySelector('.foldable-title');
        // Each parent group is `breadcrumb-with-container`: an optional
        // breadcrumb followed by the blocks container, inside one wrapper div.
        const groups = [...item.querySelectorAll('.blocks-container')].map((bc) => {
          const wrap = bc.parentElement;
          const crumb = wrap ? wrap.querySelector(':scope > .breadcrumb') : null;
          const steps = crumb
            ? [...crumb.children]
                .filter((c) => !c.classList.contains('ui__icon'))
                .map((c) => ({
                  tag: c.tagName,
                  cls: c.getAttribute('class') || '',
                  role: c.getAttribute('role') || '',
                  tabindex: c.getAttribute('tabindex'),
                  title: c.getAttribute('title') || '',
                  aria: c.getAttribute('aria-label') || '',
                  text: clean(c.innerText),
                }))
            : [];
          return {
            crumb: crumb ? clean(crumb.innerText) : null,
            steps,
            more: steps.filter((s) => s.text === '⋯').length,
            blocks: [...bc.querySelectorAll('[blockid]')]
              .map((b) => ({ id: b.getAttribute('blockid'),
                             text: clean(b.innerText).slice(0, 80) }))
              .filter((b) => b.id),
            // Kept so an empty group can be diagnosed rather than guessed at.
            placeholder: !!bc.querySelector('.lazy-loading-placeholder'),
            nodes: bc.querySelectorAll('*').length,
          };
        });
        return { page: clean(header && header.innerText), groups };
      });
      return {
        present: true,
        heading,
        items,
        filterControl: !!sec.querySelector('a.filter'),
        unlinked: !!document.querySelector('.references.page-unlinked'),
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    const refs = await readRefs();
    observations.baseline = refs;
    record('O4.1', 'the linked-references section rendered', refs.present === true,
      refs.present ? refs.heading : `not present: ${refs.error || 'no .references.page-linked'}`);
    if (!refs.present) throw new Error('no linked-references section; not proceeding');

    // `[blockid]` matches every nested element OG stamps with the identity, so
    // the referencing blocks are the DISTINCT ids, not the element count.
    const allBlocks = refs.items.flatMap((i) => i.groups.flatMap((gp) => gp.blocks));
    const distinct = [...new Set(allBlocks.map((b) => b.id))];
    record('O4.2', 'every referencing block in the fixture is listed', distinct.length === 11,
      `${distinct.length} distinct referencing blocks (${allBlocks.length} stamped elements) ` +
      `across ${refs.items.length} source pages`);

    const pageNames = refs.items.map((i) => i.page);
    const hasDeep = pageNames.some((n) => n.includes('Deep Source'));
    const hasOther = pageNames.some((n) => n.includes('Other Source'));
    const hasJournal = pageNames.some((n) => /\d{4}/.test(n));
    record('O4.3', 'results are grouped by source page, and a journal is one of them',
      hasDeep && hasOther && hasJournal && refs.items.length === 4, JSON.stringify(pageNames));
    record('O4.4', "OG's filter control and unlinked-references section are both present",
      refs.filterControl === true && refs.unlinked === true,
      `filter ${refs.filterControl}, unlinked ${refs.unlinked}`);

    // ---------- O5 : what the breadcrumb shows, per depth ----------
    say('\nO5  how much of each source path OG shows');
    const byId = {};
    for (const item of refs.items) {
      for (const gp of item.groups) {
        for (const blk of gp.blocks) byId[blk.id] = { page: item.page, group: gp };
      }
    }
    const found = (key) => byId[RG.UUID[key]];

    const depthRow = (key, label) => {
      const f = found(key);
      if (!f) return record(`O5.${label}`, `${key}: located in the list`, false, 'not found');
      const declared = D[key];
      const shown = f.group.steps.filter((s) => s.text !== '⋯').length;
      const ok = shown === declared.visible && f.group.more === (declared.hidden > 0 ? 1 : 0);
      return record(`O5.${label}`,
        `${key} — ${declared.depth} ancestors: OG shows ${declared.visible}, ` +
        `elides ${declared.hidden}`,
        ok,
        `crumb "${f.group.crumb === null ? '(none)' : f.group.crumb}" — ` +
        `${shown} step(s) shown, ${f.group.more} "⋯" marker(s)`);
    };
    depthRow('flat', '1');
    depthRow('two', '2');
    depthRow('three', '3');
    depthRow('four', '4');
    depthRow('deepA', '5');
    depthRow('branch', '6');
    depthRow('other', '7');
    depthRow('same', '8');
    depthRow('journal', '9');
    depthRow('deepest', '11');

    // The two references under ONE parent must share ONE breadcrumb group.
    const a = found('deepA'); const b = found('deepB');
    const deepIds = a ? [...new Set(a.group.blocks.map((x) => x.id))] : [];
    record('O5.10', 'two references under one parent are one group with one breadcrumb',
      !!a && !!b && a.group === b.group && deepIds.length === 2,
      a && b ? `same group: ${a.group === b.group}, ${deepIds.length} distinct block(s)` : 'missing');

    // ---------- O6 : what the elision offers ----------
    say('\nO6  what the reader can do about the part that is not shown');
    const moreSteps = refs.items.flatMap((i) => i.groups.flatMap((gp) => gp.steps))
      .filter((s) => s.text === '⋯');
    // Seven groups have an elided path: four, deepA+deepB (one group), branch,
    // other, same, journal and deepest. Derived from the fixture rather than
    // written as a literal, so a fixture change fails here rather than passing
    // against a stale number.
    const wantMarkers = new Set(Object.keys(D).filter((k) => D[k].hidden > 0)
      .map((k) => { const f = found(k); return f && f.group; })).size;
    record('O6.1', 'an elided path is marked, and the marker appears where a path was cut',
      moreSteps.length === wantMarkers && wantMarkers === 7,
      `${moreSteps.length} "⋯" marker(s) for ${wantMarkers} group(s) with an elided path`);
    const inert = moreSteps.every((s) => s.tag === 'SPAN' && !s.role && s.tabindex === null &&
                                          !s.title && !s.aria);
    record('O6.2', 'the marker is inert: a span with no role, no tabindex, no title, no label',
      inert, JSON.stringify(moreSteps[0] || null));
    const namesCount = moreSteps.every((s) => !/\d/.test(s.text));
    record('O6.3', 'the marker does not say HOW MANY ancestors it stands for', namesCount,
      moreSteps.map((s) => s.text).join(' '));

    // Pressing it must be observed, not assumed: a span with a click handler
    // would still be a disclosure, badly labelled.
    phase('probe-the-marker', 'click-the-elision-marker');
    const beforeClick = JSON.stringify(await readRefs());
    const clicked = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.references.page-linked .breadcrumb span')]
        .filter((s) => (s.innerText || '').trim() === '⋯');
      if (!spans.length) return { found: 0 };
      spans[0].click();
      return { found: spans.length, hash: location.hash };
    }).catch((e) => ({ error: String(e.message) }));
    await sleep(2500);
    const afterClick = JSON.stringify(await readRefs());
    const hashAfter = await page.evaluate(() => location.hash).catch(() => '');
    record('O6.4', 'pressing the marker does nothing at all — no expansion, no navigation',
      beforeClick === afterClick && hashAfter === `#/page/${encodeURIComponent(RG.ANCHOR)}`,
      `list identical: ${beforeClick === afterClick}; hash ${hashAfter}; ` +
      `clicked ${JSON.stringify(clicked)}`);

    // Keyboard reachability, measured rather than read off a property.
    // `HTMLElement.tabIndex` is not the answer: OG's breadcrumb steps are
    // anchors with a mouse handler and NO href, and the first reading of this
    // fixture reported 23 of them as `tabIndex >= 0` while none of them can
    // actually take focus. So each element is FOCUSED and the result observed.
    const tabbables = await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return null;
      const all = [...sec.querySelectorAll('.breadcrumb *')];
      const was = document.activeElement;
      let reallyFocusable = 0;
      let markerFocusable = 0;
      for (const e of all) {
        try { e.focus(); } catch (x) { /* not focusable */ }
        if (document.activeElement === e) {
          reallyFocusable += 1;
          if ((e.innerText || '').trim() === '⋯') markerFocusable += 1;
        }
        try { e.blur(); } catch (x) { /* nothing to blur */ }
      }
      try { if (was && was.focus) was.focus(); } catch (x) { /* nothing to restore */ }
      return {
        total: all.length,
        claimTabIndex: all.filter((e) => e.tabIndex >= 0).length,
        reallyFocusable,
        markerFocusable,
        anchors: all.filter((e) => e.tagName === 'A').length,
        anchorsWithHref: all.filter((e) => e.tagName === 'A' && e.hasAttribute('href')).length,
      };
    }).catch(() => null);
    observations.breadcrumbFocus = tabbables;
    record('O6.5', 'no part of a source-path breadcrumb can actually take focus',
      !!tabbables && tabbables.reallyFocusable === 0,
      JSON.stringify(tabbables));

    // The decisive question for this feature: is the hidden part of the path
    // anywhere on the page at all, in any form a reader could reach?
    const hiddenText = await page.evaluate((needles) => {
      const sec = document.querySelector('.references.page-linked');
      const text = sec ? (sec.innerText || '') : '';
      const html = sec ? sec.innerHTML : '';
      const out = {};
      for (const n of needles) out[n] = { inText: text.includes(n), inHtml: html.includes(n) };
      return out;
    }, [head(T.d1), head(T.d2), head(T.d3), head(T.t4a), head(T.o1), head(T.j1),
        head(RG.DEEPEST_LEVELS[0]), head(RG.DEEPEST_LEVELS[6])])
      .catch(() => null);
    observations.hiddenAncestors = hiddenText;
    record('O6.6', 'the elided ancestors are not present anywhere in the section — not hidden, absent',
      !!hiddenText && Object.values(hiddenText).every((v) => !v.inText && !v.inHtml),
      JSON.stringify(hiddenText));

    // ---------- O7 : the deep path is not merely long, it is ambiguous ----------
    say('\nO7  whether what IS shown identifies the path');
    const deepCrumb = a ? a.group.crumb : '';
    const branchCrumb = found('branch') ? found('branch').group.crumb : '';
    record('O7.1', 'two branches that share their upper levels show DIFFERENT nearest three',
      deepCrumb !== branchCrumb && deepCrumb.includes(head(T.d7)) &&
      branchCrumb.includes(head(T.b6)),
      `deep "${deepCrumb}" vs branch "${branchCrumb}"`);
    // The two paths share L1–L5. Neither result shows L1–L3 at all, and L4 is
    // shown by the shallower one and elided by the deeper one — so the same
    // ancestor is visible in one result and invisible in the other, and a
    // reader comparing the two cannot tell that they share it.
    const bothHide = [head(T.d1), head(T.d2), head(T.d3)];
    const asymmetric = !deepCrumb.includes(head(T.d4)) && branchCrumb.includes(head(T.d4));
    record('O7.2', 'the levels the two paths share are invisible in both, or in one of them',
      bothHide.every((x) => !deepCrumb.includes(x) && !branchCrumb.includes(x)) && asymmetric,
      `neither shows ${JSON.stringify(bothHide)}; L4 is shown by the 6-deep result and ` +
      `elided by the 7-deep one (asymmetric: ${asymmetric})`);
    const sameCrumb = found('same') ? found('same').group.crumb : '';
    const sameSteps = found('same')
      ? found('same').group.steps.filter((s) => s.text !== '⋯').map((s) => s.text) : [];
    record('O7.3', 'a path whose ancestors share one text reads as repetition with no position',
      sameSteps.length === 3 && new Set(sameSteps).size === 1,
      `"${sameCrumb}" — ${JSON.stringify(sameSteps)}`);

    // ---------- O8 : the filter, which must keep working ----------
    say('\nO8  the filter OG already provides over the source path');
    phase('read-filter', 'open-the-filter-dialog');
    await attemptClick(page, 'a.filter');
    await sleep(2500);
    const filterNames = await page.evaluate(() => {
      const m = document.querySelector('.ls-filters, .filters');
      if (!m) return null;
      return [...m.querySelectorAll('button')].map((b) => (b.innerText || '').trim())
        .filter(Boolean);
    }).catch(() => null);
    observations.filterOptions = filterNames;
    record('O8.1', 'the filter offers pages referenced from inside the source paths',
      !!filterNames && filterNames.some((n) => n.includes('필터 태그')),
      JSON.stringify(filterNames));
    await page.keyboard.press('Escape').catch(() => null);
    await sleep(1500);

    // ---------- O9 : the run changed nothing ----------
    say('\nO9  the run wrote nothing');
    const stillOpen = await readRefs();
    record('O9.1', 'the list is unchanged after every probe above',
      JSON.stringify(stillOpen.items.map((i) => i.page)) ===
        JSON.stringify(refs.items.map((i) => i.page)),
      JSON.stringify(stillOpen.items.map((i) => i.page)));
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- after the application has closed ----------
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('O9.2', 'no content file changed: this run only read the graph',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  record('O9.3', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ` +
        cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')
      : 'none');

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  const split = NOISE.partition(cls.unexpected, errors.entries(), errorEvidence);
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(split.noise, 3)) say(`          pre-existing: ${line}`);
  for (const r of split.refused.slice(0, 5)) {
    say(`          REFUSED BY THE RULE: ${r.refusedBecause}\n            ` +
        `${String(r.text).slice(0, 160)}`);
  }
  for (const line of EC.describe(split.remaining, 5)) say(`          UNEXPECTED: ${line}`);
  // RAW evidence, unconditionally, beside the classification rather than
  // instead of it.
  observations.errors = {
    entries: errors.entries(),
    phases: errors.phases(),
    windowErrorEvents: errorEvidence,
    expected: cls.expected.map((e) => ({ seq: e.seq, phase: e.phase, reason: e.reason,
                                         text: e.text })),
    browserNoise: split.noise.map((e) => ({ seq: e.seq, text: e.text,
                                            pairedWithSeq: e.pairedWithSeq === undefined
                                              ? null : e.pairedWithSeq })),
    refusedByRule: split.refused.map((e) => ({ seq: e.seq, text: e.text,
                                               refusedBecause: e.refusedBecause })),
    unexpected: split.remaining.map((e) => ({ seq: e.seq, phase: e.phase, text: e.text })),
    ruleAccounting: split.evidence,
  };
  record('O9.4', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));
  record('O9.6', "the browser's own ErrorEvent log was collected, as CONTEXT for a reader",
    split.evidence.collected === true,
    split.evidence.collected
      ? `${split.evidence.windowErrorEvents} window ErrorEvent(s), ` +
        `${split.evidence.nullPayloadNotices} of them null-payload ResizeObserver notice(s). ` +
        'It funds no exemption: only the exact notice is exempted, and OG\'s companion ' +
        '[frontend.handler] line is always unexpected'
      : "the page's ErrorEvent log could not be collected; nothing depends on it, but a " +
        'reader loses the corroboration that the browser really did signal');

  const leftovers = ownedTree.filter(OP.alive);
  record('O9.5', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-refpath-baseline-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

async function attemptClick(page, selector) {
  try { await page.locator(selector).first().click({ timeout: 15000 }); } catch (e) { /* reported by the check */ }
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
