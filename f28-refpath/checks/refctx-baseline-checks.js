#!/usr/bin/env node
'use strict';
//
// F28 CHILD CONTEXT, STEP ONE — what OG's linked-references list already shows
// about what is written UNDER a reference, observed in the packaged application.
//
//   node f28-refpath/checks/refctx-baseline-checks.js
//
// This scenario implements NOTHING. Its whole purpose is to establish, on a
// real graph in the real application, what the existing behaviour is — so that
// the decision to build or not build an F28 child-context disclosure rests on
// an observation rather than on a reading of the source.
//
// It runs against the build that PREDATES this feature and refuses to proceed
// if that build's renderer carries `frontend.util.f28_refctx`. The three
// functions it observes —
//
//   frontend.components.block/block-children
//   frontend.components.block/block-container-inner
//   frontend.components.reference/get-filtered-children
//
// — are byte-identical to the accepted OG baseline `5b34566ca`, verified in the
// checkout before this run, so what it reports is OG's own behaviour.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own fresh synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted
// BEFORE any feature interaction. This run writes nothing to the graph and
// proves it by comparing every file's hash after the application has closed.
//
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(REPO, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const GH = require(path.join(REPO, 'f27-pilot', 'checks', 'graph-hash.js'));
const OP = require(path.join(REPO, 'f27-pilot', 'checks', 'owned-process.js'));
const EC = require(path.join(REPO, 'f27-inline', 'checks', 'error-classifier.js'));
const RG = require('./make-refctx-graph.js');
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
const K = RG.CHILDREN;

// A child is matched by a distinctive PREFIX of the block it names, because OG
// renders inline markup and a page link inside a child becomes an anchor whose
// text is the page's name rather than its source.
const head = (s) => s.split('—')[0].split('·')[0].trim().slice(0, 18);

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 child context, step one: what OG already shows under a reference ===\n');

  // ---------- C0 : preconditions ----------
  say('C0  preconditions');
  const built = APP.resolve(BASELINE_APP);
  const v = built.preflight;
  record('C0.1', 'a packaged build of this project is present and passes its identity check',
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
  // feature's namespace at all.
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  const carriesF28ctx = names.includes('frontend.util.f28_refctx.js');
  record('C0.2', 'the build this run observes does not contain the child-context feature at all',
    !carriesF28ctx && names.length > 0,
    carriesF28ctx ? 'this packaged renderer carries frontend.util.f28_refctx; it is NOT a baseline'
                  : `${built.appName} carries no f28-refctx namespace, so what it renders under a ` +
                    'reference is OG\'s own block-children (unchanged since 5b34566ca, verified ' +
                    'in the checkout)');
  if (carriesF28ctx) throw new Error('refusing to call a child-context build a baseline');

  // ---------- C1 : a fresh graph ----------
  say('\nC1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'baseline' });
  const GRAPH = B.assertInsideAllowedRoot('refctx graph', g.graph);
  record('C1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal})`);
  const before = GH.snapshot(GRAPH);
  record('C1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-refctx-inert-probe');
  record('C1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- C2/C3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'C',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    // ---------- C4 : the linked-references list ----------
    say('\nC4  the page everything points at, and its linked references');
    phase('read-linked-references', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
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
    say(`          (settled at ${seen} stamped elements rendered)`);
    await parkPointer();

    // ONE reading of the whole linked-references section. Nothing here clicks.
    //
    // The unit is the ROW: a `.ls-block` OG stamped with a block identity.
    // Nesting is read from DOM ANCESTRY rather than from a scoped selector,
    // because OG wraps a group's rows in `lazy-blocks`' own div when the
    // container has a `:db/id` and does not when it has not — a selector that
    // assumed either shape reported zero rows for a list that was fully
    // rendered, which is how the first reading of this fixture managed to call
    // nine visible references "missing".
    const readRefs = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const rows = [...sec.querySelectorAll('.ls-block[blockid]')];
      const index = new Map(rows.map((el, i) => [el, i]));
      const read = (el, i) => {
        const id = el.getAttribute('blockid');
        const main = el.querySelector(':scope > .block-main-container');
        const control = document.getElementById(`control-${id}`);
        // The nearest enclosing row, if any: that is this row's parent in what
        // OG actually drew.
        let p = el.parentElement;
        let parent = null;
        while (p && p !== sec) {
          if (p.classList && p.classList.contains('ls-block') && p.hasAttribute('blockid')) {
            parent = index.has(p) ? index.get(p) : null; break;
          }
          p = p.parentElement;
        }
        return {
          i, id, parent,
          text: clean(main ? main.innerText : '').slice(0, 90),
          level: el.getAttribute('level'),
          hasChildAttr: el.getAttribute('haschild'),
          collapsedAttr: el.getAttribute('data-collapsed'),
          control: !!control,
          // What OG's own renderer put inside this row's content — the
          // question "is a child rendered as a block, or as text?".
          imgs: main ? main.querySelectorAll('img').length : 0,
          macros: main ? main.querySelectorAll('.macro, .custom-query, .dsl-query').length : 0,
          refs: main ? main.querySelectorAll('.page-ref, .block-ref').length : 0,
          anchors: main ? main.querySelectorAll('a').length : 0,
        };
      };
      const all = rows.map(read);
      const items = [...sec.querySelectorAll('.references-blocks-item')].map((item) => {
        const header = item.querySelector('.foldable-title');
        const groups = [...item.querySelectorAll('.blocks-container')].map((bc) => {
          const wrap = bc.parentElement;
          const crumb = wrap ? wrap.querySelector(':scope > .breadcrumb') : null;
          const steps = crumb
            ? [...crumb.children].filter((c) => !c.classList.contains('ui__icon'))
                .map((c) => clean(c.innerText))
            : [];
          return {
            crumb: crumb ? clean(crumb.innerText) : null,
            steps,
            more: steps.filter((s) => s === '⋯').length,
            ids: [...bc.querySelectorAll('.ls-block[blockid]')]
              .map((e) => e.getAttribute('blockid')),
          };
        });
        return { page: clean(header && header.innerText), groups };
      });
      return {
        present: true,
        heading: clean((sec.querySelector('h2') || {}).innerText),
        items, rows: all,
        filterControl: !!sec.querySelector('a.filter'),
        unlinked: !!document.querySelector('.references.page-unlinked'),
        sectionText: (sec.innerText || ''),
        sectionHtml: sec.innerHTML,
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    const refs = await readRefs();
    const lean = (r) => JSON.parse(JSON.stringify({ ...r, sectionText: undefined,
                                                   sectionHtml: undefined }));
    observations.baseline = refs.present ? lean(refs) : refs;
    record('C4.1', 'the linked-references section rendered', refs.present === true,
      refs.present ? refs.heading : `not present: ${refs.error || 'no .references.page-linked'}`);
    if (!refs.present) throw new Error('no linked-references section; not proceeding');

    // A row by identity. A block may legitimately be drawn more than once (a
    // child that also names the page is both a result and context), so this
    // keeps every appearance and the checks say which they mean.
    const appearances = (key) => refs.rows.filter((r) => r.id === RG.UUID[key]);
    const found = (key) => appearances(key)[0];
    // Every row drawn beneath one row, at any depth, in the order OG drew them.
    const subtreeOf = (row, rows) => {
      const kids = rows.filter((r) => r.parent === row.i);
      return kids.flatMap((k) => [k, ...subtreeOf(k, rows)]);
    };
    const childrenOf = (row, rows) => rows.filter((r) => r.parent === row.i);

    record('C4.2', 'every referencing block in the fixture is listed',
      RG.REFERENCING.every((k) => !!found(k)),
      `${RG.REFERENCING.filter((k) => !!found(k)).length}/${RG.REFERENCING.length} located; ` +
      `${refs.rows.length} row(s) drawn across ${refs.items.length} source page(s)`);

    const pageNames = refs.items.map((i) => i.page);
    record('C4.3', 'results are grouped by source page, and a journal is one of them',
      pageNames.some((n) => n.includes('Child Source')) &&
      pageNames.some((n) => n.includes('Wide Source')) &&
      pageNames.some((n) => /\d{4}/.test(n)),
      JSON.stringify(pageNames));
    record('C4.4', "OG's filter control and unlinked-references section are both present",
      refs.filterControl === true && refs.unlinked === true,
      `filter ${refs.filterControl}, unlinked ${refs.unlinked}`);
    record('C4.5', 'the count is the blocks that NAME the page, not the rows drawn',
      refs.heading.includes(String(RG.REFERENCING.length)) &&
      refs.rows.length > RG.REFERENCING.length,
      `"${refs.heading}" for ${RG.REFERENCING.length} referencing block(s), ` +
      `${refs.rows.length} row(s) drawn`);

    // ---------- C5 : the parent context, which this batch must not disturb ----------
    say('\nC5  the parent context OG already draws');
    const groupOf = (key) => {
      for (const item of refs.items) {
        for (const gp of item.groups) if (gp.ids.includes(RG.UUID[key])) return gp;
      }
      return null;
    };
    const crumbOk = Object.entries(RG.DEPTH).filter(([key, want]) => {
      const gp = groupOf(key);
      if (!gp) return false;
      // A group's breadcrumb is drawn for the block the group is grouped BY, so
      // a nested row's own depth is not what the crumb shows. Only the rows OG
      // groups on are checked here.
      return gp.more === 0 && gp.steps.filter((s) => s !== '⋯').length <= want.depth;
    }).length;
    record('C5.1', 'no group in this fixture has any of its ancestor path elided',
      refs.items.every((i) => i.groups.every((gp) => gp.more === 0)) &&
      crumbOk === Object.keys(RG.DEPTH).length,
      `${crumbOk}/${Object.keys(RG.DEPTH).length} cases sit in a group whose breadcrumb is ` +
      'complete, and no group carries a "⋯"');
    const sibGroup = groupOf('sibA');
    record('C5.2', 'two references under one parent are one group with one breadcrumb',
      !!sibGroup && sibGroup === groupOf('sibB'),
      sibGroup ? `crumb "${sibGroup.crumb}" holding ${sibGroup.ids.length} row(s)` : 'missing');

    // ---------- C6 : what OG shows UNDER each reference ----------
    say('\nC6  what OG shows under each reference');
    const report = {};
    for (const key of Object.keys(K)) {
      const r = found(key);
      report[key] = r ? {
        declared: K[key],
        appearances: appearances(key).length,
        renderedChildren: childrenOf(r, refs.rows).length,
        renderedDescendants: subtreeOf(r, refs.rows).length,
        level: r.level, hasChildAttr: r.hasChildAttr,
        collapsedAttr: r.collapsedAttr, control: r.control,
        childText: childrenOf(r, refs.rows).map((c) => c.text.slice(0, 40)),
      } : null;
    }
    observations.childContext = report;

    const fullSubtree = Object.entries(K).filter(([key, want]) => {
      const r = found(key);
      return r && subtreeOf(r, refs.rows).length === want.ogShows;
    }).map(([k]) => k);
    record('C6.1', "a reference's OWN children are already in the list — OG selects on path-refs",
      fullSubtree.length === Object.keys(K).length,
      Object.entries(report).map(([k, c]) =>
        `${k}: ${c ? `${c.renderedDescendants} drawn of ${c.declared.descend} written ` +
                     `(OG draws ${c.declared.ogShows})` : 'missing'}`).join('; '));

    const untouched = Object.entries(K).filter(([, w]) => w.behind === 0);
    record('C6.1b', 'where a subtree fits inside the two levels OG draws, it is drawn WHOLE',
      untouched.every(([key, want]) => {
        const r = found(key);
        return r && subtreeOf(r, refs.rows).length === want.descend;
      }),
      untouched.map(([k, w]) => `${k}: ${w.descend}`).join('; ') +
      ' — these cases are already adequate and must gain nothing');

    const orderOk = Object.entries(RG.KIDS).every(([key, want]) => {
      const r = found(key);
      if (!r) return false;
      const drawn = childrenOf(r, refs.rows).map((c) => c.text);
      return drawn.length === want.length &&
             want.every((w, i) => drawn[i].startsWith(w.split('·')[0].trim().slice(0, 10)));
    });
    record('C6.2', 'the children are drawn under the right row, in the order the outline writes them',
      orderOk,
      Object.entries(RG.KIDS).map(([k]) => {
        const r = found(k);
        return `${k}: ${r ? childrenOf(r, refs.rows).length : 'missing'}`;
      }).join('; '));

    const leaf = found('leaf');
    record('C6.3', 'a reference with nothing written under it says so, and draws nothing',
      !!leaf && leaf.hasChildAttr === 'false' && childrenOf(leaf, refs.rows).length === 0,
      leaf ? `haschild=${leaf.hasChildAttr}, ${childrenOf(leaf, refs.rows).length} row(s) under it`
           : 'missing');

    // A child that names the page is a RESULT in its own right and CONTEXT
    // under its parent. Whether OG draws it once or twice is the thing a reader
    // has to be able to tell apart, so it is measured rather than assumed.
    const mixedRefRows = appearances('mixedRef');
    record('C6.4', 'a child that itself names the page is drawn TWICE, in two different roles',
      mixedRefRows.length === 2,
      `${mixedRefRows.length} appearance(s): ` +
      JSON.stringify(mixedRefRows.map((r) => ({
        parent: r.parent === null ? '(top of its own group)'
                                  : refs.rows[r.parent].text.slice(0, 30),
        children: childrenOf(r, refs.rows).length,
      }))));

    // ---------- C7 : where OG stops ----------
    say('\nC7  where OG stops, and what it says about it');
    // `data-collapsed` is `(and collapsed? has-child?)`, and `has-child?` is a
    // datascript ENTITY — so a collapsed row carries `{:db/id 40}` there rather
    // than `true`. Read as a truthy-but-not-"false" value, which is what it is.
    const isCollapsed = (r) => !!r.collapsedAttr && r.collapsedAttr !== 'false';
    const collapsedRows = refs.rows.filter(isCollapsed);
    observations.collapsed = collapsedRows.map((r) => ({ id: r.id, level: r.level,
                                                         attr: r.collapsedAttr,
                                                         text: r.text.slice(0, 44) }));
    const wallIds = Object.keys(RG.WALL).map((k) => RG.UUID[k]);
    record('C7.1', 'OG collapses exactly the rows at the SECOND level of a subtree that have children',
      collapsedRows.length === wallIds.length &&
      wallIds.every((id) => collapsedRows.some((r) => r.id === id)) &&
      collapsedRows.every((r) => r.level === '2'),
      `${collapsedRows.length} collapsed row(s), all at :block/level 2 ` +
      `(ref/default-open-blocks-level is 2): ` +
      JSON.stringify(collapsedRows.map((r) => r.text.slice(0, 26))));

    const levels = [...new Set(refs.rows.map((r) => r.level))];
    record('C7.2', 'no row below the second level of any subtree is drawn at all',
      levels.every((l) => l === null || l === '1' || l === '2'),
      `:block/level values drawn: ${JSON.stringify(levels)}`);

    const behindTotal = Object.values(RG.WALL).reduce((n, w) => n + w.hidden, 0);
    record('C7.3', 'a collapsed row renders none of what is behind it',
      collapsedRows.every((r) => childrenOf(r, refs.rows).length === 0),
      `${behindTotal} block(s) sit behind ${collapsedRows.length} collapsed row(s), and ` +
      `${collapsedRows.reduce((n, r) => n + childrenOf(r, refs.rows).length, 0)} of them are drawn`);

    // ---------- C8 : how OG presents what it DOES show, and what it says ----------
    say('\nC8  how OG presents a reference\'s children, and what it does not say');
    const markupRow = refs.rows.find((r) => r.id === RG.UUID.markup);
    observations.markupRow = markupRow || null;
    record('C8.1', 'a child OG draws is a BLOCK: markup written in it is expanded',
      !!markupRow && (markupRow.imgs > 0 || markupRow.macros > 0 || markupRow.anchors > 0),
      markupRow ? `img ${markupRow.imgs}, macro ${markupRow.macros}, ref ${markupRow.refs}, ` +
                  `anchor ${markupRow.anchors}` : 'the markup child was not drawn');
    record('C8.2', 'its twin behind the wall is not drawn in any form',
      !refs.rows.some((r) => r.id === RG.UUID.deepD3),
      `the identical block behind a collapsed row: ` +
      `${refs.rows.some((r) => r.id === RG.UUID.deepD3) ? 'drawn' : 'not drawn at all'}`);

    // Everything OG draws must be present; everything behind the wall must be
    // absent. Both halves, so "absent" is a measurement and not an assumption.
    const shownNeedles = [head(T.twoC1), head(T.mixedC1), head(T.mixedC3), head(T.sibAC1),
                          head(T.sibBC1), head(T.jC1), head(RG.WIDE_CHILDREN[0]),
                          head(RG.WIDE_CHILDREN[13]), head(RG.DEEP_LEVELS[0]),
                          head(T.batchC1)];
    const hiddenNeedles = [head(T.sibAGG1), head(T.sibAGG2), head(T.jC1a1), head(T.jC1a2),
                           head(RG.DEEP_LEVELS[3]), head(RG.DEEP_LEVELS[5]),
                           head(RG.BATCH_CHILDREN[0]), head(RG.BATCH_CHILDREN[11])];
    const inSection = (n) => ({ inText: refs.sectionText.includes(n),
                                inHtml: refs.sectionHtml.includes(n) });
    const shownP = Object.fromEntries(shownNeedles.map((n) => [n, inSection(n)]));
    const hiddenP = Object.fromEntries(hiddenNeedles.map((n) => [n, inSection(n)]));
    observations.childPresence = { shown: shownP, behindTheWall: hiddenP };
    record('C8.3', 'everything within the two levels OG draws is present in the section',
      Object.values(shownP).every((p) => p.inText || p.inHtml),
      JSON.stringify(Object.fromEntries(Object.entries(shownP)
        .map(([k, v]) => [k, v.inText ? 'text' : (v.inHtml ? 'html only' : 'ABSENT')]))));
    record('C8.4', 'everything behind the wall is ABSENT from the section — not hidden, absent',
      Object.values(hiddenP).every((p) => !p.inText && !p.inHtml),
      JSON.stringify(Object.fromEntries(Object.entries(hiddenP)
        .map(([k, v]) => [k, (v.inText || v.inHtml) ? 'PRESENT' : 'absent']))));

    // Nothing tells the reader that anything is behind a collapsed row.
    const saysHowMany = /\d+\s*(개|children|more|자식|blocks?)/i.test(refs.sectionText);
    record('C8.5', 'nothing in the section says how much is written behind a collapsed row',
      !saysHowMany,
      saysHowMany ? 'the section carries a count' : 'no count of hidden context appears anywhere');

    // The one thing the reader is NOT told: which of these rows is the
    // reference the list counted, and which are only what happens to be written
    // under it.
    const marks = await page.evaluate((ids) => {
      const sec = document.querySelector('.references.page-linked');
      const out = {};
      for (const [key, id] of Object.entries(ids)) {
        const el = sec.querySelector(`.ls-block[blockid="${id}"]`);
        if (!el) { out[key] = null; continue; }
        out[key] = {
          cls: (el.getAttribute('class') || '').replace(id, '<uuid>'),
          dataRefsSelf: el.getAttribute('data-refs-self'),
          bullet: (el.querySelector('.bullet') || {}).className || null,
        };
      }
      return out;
    }, { counted: RG.UUID.two, context: RG.UUID.twoC1 }).catch(() => null);
    observations.rowMarks = marks;
    record('C8.6', 'a counted reference and a child under it are drawn identically',
      !!marks && !!marks.counted && !!marks.context &&
      marks.counted.cls === marks.context.cls && marks.counted.bullet === marks.context.bullet,
      JSON.stringify(marks));

    // ---------- C9 : what the keyboard can reach in the row area ----------
    say('\nC9  what a keyboard can reach around a reference row');
    const reach = await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return null;
      const controls = [...sec.querySelectorAll('a.block-control')];
      const was = document.activeElement;
      let focusable = 0;
      for (const e of controls) {
        try { e.focus(); } catch (x) { /* not focusable */ }
        if (document.activeElement === e) focusable += 1;
        try { e.blur(); } catch (x) { /* nothing to blur */ }
      }
      try { if (was && was.focus) was.focus(); } catch (x) { /* nothing to restore */ }
      return {
        controls: controls.length,
        focusable,
        withHref: controls.filter((e) => e.hasAttribute('href')).length,
        buttons: sec.querySelectorAll('button').length,
      };
    }).catch(() => null);
    observations.foldControlFocus = reach;
    record('C9.1', "OG's fold control cannot take focus, so no keyboard reaches it",
      !!reach && reach.focusable === 0 && reach.withHref === 0,
      JSON.stringify(reach));

    // ---------- C10 : the filter, which must keep working ----------
    say('\nC10 the filter OG already provides');
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
    record('C10.1', 'the filter offers the pages referenced from inside the results',
      !!filterNames && filterNames.length > 0, JSON.stringify(filterNames));
    await page.keyboard.press('Escape').catch(() => null);
    await sleep(1500);

    // ---------- C11 : the run changed nothing on screen ----------
    say('\nC11 the run left the list as it found it');
    const stillOpen = await readRefs();
    record('C11.1', 'the list is unchanged after every probe above',
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
  record('C11.2', 'no content file changed: this run only read the graph',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  record('C11.3', 'OG housekeeping is recorded separately rather than counted as content', true,
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
  record('C11.4', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('C11.5', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-refctx-baseline-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

async function attemptClick(page, selector) {
  try { await page.locator(selector).first().click({ timeout: 15000 }); }
  catch (e) { /* reported by the check */ }
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
